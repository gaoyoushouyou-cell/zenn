// アプリの司令塔。セッションの状態遷移・音・保存・画面切り替えをまとめる。
// 画面の描画は ui/views.js、時間の計算は core/session.js に任せる。

import * as S from './core/session.js';
import { correctedClock, systemClock } from './core/clock.js';
import { createStorage } from './core/storage.js';
import * as Settings from './core/settings.js';
import * as History from './core/history.js';
import { remainingView, approxMinutes } from './core/format.js';
import { DICTS, resolveLang } from './i18n/strings.js';
import { createAudioEngine } from './audio/engine.js';
import { createScene, resolveScene } from './visual/scene.js';
import { createWakeLock, vibrate, notifications, createSpeech, guessLowPower } from './platform.js';
import { renderView, openDialog, closeDialog, sessionKeydown } from './ui/views.js';

export const VERSION = '1.0.0';
const TICK_MS = 250;
const PERSIST_EVERY_MS = 5000;
const AUDIO_SYNC_EVERY_MS = 10_000;
const EXTEND_MS = 5 * 60_000;

// 案内付きセッションの字幕（座り始めからの秒数）
const GUIDED_CUES = [
  { at: 14, key: 'eyes' },
  { at: 45, key: 'breath' },
  { at: 95, key: 'thoughts' },
  { at: 180, key: 'pain' },
];

export function createApp({
  root,
  canvas,
  srRegion,
  toastRegion,
  dialogEl,
  clockBase = systemClock(),
  storageBackend,
  storagePrefix,
  AudioCtor,
  testMode = false,
  matchMedia = (q) => globalThis.matchMedia ? globalThis.matchMedia(q) : { matches: false, addEventListener() {} },
} = {}) {
  const clock = correctedClock(clockBase);
  let storageNotified = false;
  const storage = createStorage(storageBackend === undefined ? undefined : storageBackend, {
    prefix: storagePrefix,
    onError: (kind) => {
      if (storageNotified) return;
      storageNotified = true;
      toast(kind === 'corrupt' ? t().storageCorrupt : t().storageQuota);
    },
  });

  const state = {
    view: 'home',
    settings: Settings.validate(storage.read('settings')),
    history: History.validateList(storage.read('history', [])),
    seenGuide: !!storage.read('seenGuide', false),
    sessions: storage.read('sessionsCount', 0) || 0,
    session: null,
    meta: null,
    after: null,
    notice: null,
    lowPowerGuess: false,
    offlineReady: false,
    online: globalThis.navigator ? navigator.onLine !== false : true,
  };
  // 記録を手放す設定があれば、起動時に適用
  state.history = History.forget(state.history, state.settings.forgetDays, clock.wall());

  const audio = createAudioEngine({
    AudioCtor,
    onState: (st) => {
      if (st === 'running') { setNotice(null); syncAudio(true); }
      else if (state.session && state.view === 'session' && st !== 'closed') setNotice('suspended');
    },
    onRouteChange: () => {
      if (!state.session || audio.ambienceType === 'none') return;
      audio.muteAmbienceNow();
      setNotice('route');
    },
  });
  const scene = canvas ? createScene(canvas) : null;
  const wake = createWakeLock();
  const speech = createSpeech();

  let tickTimer = 0;
  let lastPersist = 0;
  let lastAudioSync = 0;
  let lastRemainingKey = '';

  // ── 文言 ───────────────────────────────────
  function lang() { return resolveLang(state.settings.lang); }
  function t() { return DICTS[lang()]; }

  // ── 通知 UI ──────────────────────────────
  function announce(text) {
    if (!srRegion) return;
    srRegion.textContent = '';
    // 同じ文言でも読み上げられるよう、少し遅らせて入れ直す
    setTimeout(() => { srRegion.textContent = text; }, 60);
  }
  let toastTimer = 0;
  function toast(text) {
    if (!toastRegion) return;
    toastRegion.textContent = text;
    toastRegion.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastRegion.dataset.show = 'false'; }, 5000);
  }
  function setNotice(kind) {
    state.notice = kind;
    if (state.view === 'session') render();
  }

  // ── 設定 ─────────────────────────────────
  function reducedMotion() {
    const m = state.settings.motion;
    if (m === 'reduce') return true;
    if (m === 'full') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function power() {
    const p = state.settings.power;
    if (p !== 'auto') return p;
    return state.lowPowerGuess ? 'low' : 'auto';
  }
  function applySettings() {
    const s = state.settings;
    const de = document.documentElement;
    de.lang = lang();
    de.dataset.theme = s.theme;
    de.dataset.contrast = s.contrast;
    de.dataset.motion = reducedMotion() ? 'reduce' : 'full';
    de.style.setProperty('--text-scale', String(s.textScale));
    document.title = `${t().appName} — ${t().appTagline}`;
    audio.setBellVolume(s.bellVolume);
    audio.setAmbienceVolume(s.ambienceVolume);
    applyScene();
  }
  function applyScene() {
    if (!scene) return;
    // 静寂モードは「座っている間」だけ闇にする。ホームでは選んだ景色を見せる。
    const inSitting = state.view === 'session' || state.view === 'afterglow';
    const sceneSetting = inSitting ? Settings.effective(state.settings).scene : state.settings.scene;
    const name = resolveScene(sceneSetting, new Date(clock.wall()));
    // 文章を読む画面（設定・記録・案内）では景色を静止させ、電池と注意を節約する
    const still = !['home', 'session', 'afterglow'].includes(state.view);
    scene.configure({ scene: name, reducedMotion: reducedMotion() || still, power: power() });
    document.documentElement.dataset.screen = state.view;
  }
  function updateSettings(patch, { rerender = true } = {}) {
    state.settings = Settings.update(state.settings, patch);
    storage.write('settings', state.settings);
    if ('forgetDays' in patch) {
      state.history = History.forget(state.history, state.settings.forgetDays, clock.wall());
      storage.write('history', state.history);
    }
    applySettings();
    if (rerender) render({ keepFocus: true });
  }

  // ── 画面 ─────────────────────────────────
  function render(opts = {}) {
    renderView(root, state.view, ctx, opts);
    if (state.view === 'session' && state.session) { lastRemainingKey = null; updateSessionView(clock.read()); }
  }
  function nav(view, opts = {}) {
    state.view = view;
    applyScene();
    render({ focus: true, ...opts });
  }

  // ── セッション ───────────────────────────
  function bellOpts(kind) {
    return { kind, style: state.settings.bellStyle, tone: state.settings.bellTone, sessionKind: state.session?.kind || 'zazen' };
  }
  function keyOf(ev) { return ev.type === 'interval' ? `interval-${ev.index}` : ev.type; }

  function syncAudio(force = false) {
    const s = state.session;
    if (!s || !state.settings.bells || !audio.context || audio.state !== 'running') return;
    if (s.status !== S.STATUS.RUNNING) return;
    const mono = clock.read();
    lastAudioSync = mono;
    for (const ev of S.upcomingEvents(s, mono)) {
      if (ev.inMs > 6 * 3600_000) continue;
      const key = keyOf(ev);
      const desired = ev.inMs / 1000;
      const cur = audio.scheduledIn(key);
      if (force || cur == null || Math.abs(cur - desired) > 0.3) audio.schedule(key, desired, bellOpts(ev.type));
    }
  }

  function persist(force = false) {
    const s = state.session;
    if (!s) return;
    const mono = clock.read();
    if (!force && mono - lastPersist < PERSIST_EVERY_MS) return;
    lastPersist = mono;
    storage.write('active', S.serialize(s, mono, clock.wall()));
  }

  function startTicking() {
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_MS);
  }
  function stopTicking() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  /**
   * 座禅を始める。必ず利用者の操作（クリック・キー）から呼ぶこと（音の自動再生制限のため）。
   */
  function start({ kind = 'zazen', minutes, openEnded = false } = {}) {
    closeDialog(dialogEl);
    const st = state.settings;
    const mins = minutes ?? (kind === 'kinhin' ? st.kinhinMin : kind === 'guided' ? 5 : st.durationMin);
    const isOpen = kind === 'zazen' && (openEnded || (minutes == null && st.openEnded));
    const mono = clock.read();
    const wall = clock.wall();
    state.session = S.createSession({
      kind,
      durationMs: isOpen ? null : mins * 60_000,
      prepMs: st.prepSec * 1000,
      intervalMs: kind === 'kinhin' ? 0 : st.intervalMin * 60_000,
      mono,
      wall,
    });
    state.meta = { firstEver: state.sessions === 0, cuesShown: [], cue: null, cueUntil: 0, lastSecond: -1, nearShown: false };
    state.notice = audio.available || !st.bells ? null : 'unavailable';
    state.after = null;
    lastRemainingKey = '';
    state.sessions += 1;
    storage.write('sessionsCount', state.sessions);
    persist(true);

    // 音: この呼び出しは操作の中なので、ここで AudioContext を起こす
    const eff = Settings.effective(st);
    const unlocking = audio.unlock();
    unlocking.then((ok) => {
      if (!state.session) return;
      if (!ok && st.bells) setNotice(audio.available ? 'suspended' : 'unavailable');
      if (ok) {
        syncAudio(true);
        if (eff.ambience !== 'none' && kind !== 'kinhin') audio.startAmbience(eff.ambience, Math.max(3, st.prepSec * 0.8));
      }
    });
    if (st.wakeLock) wake.request();
    if (st.prepSec > 0) announce(t().srPrep(st.prepSec));
    nav('session');
    startTicking();
    tick();
  }

  function tick() {
    const s0 = state.session;
    if (!s0) return;
    const mono = clock.read();
    let s = s0;
    for (const ev of S.dueEvents(s, mono)) {
      s = handleEvent(s, ev, mono);
      if (!state.session) return; // 終了処理で画面が変わった
    }
    state.session = s;
    if (state.view === 'session') updateSessionView(mono);
    persist();
    if (mono - lastAudioSync > AUDIO_SYNC_EVERY_MS) syncAudio();
  }

  function handleEvent(s, ev, mono) {
    const st = state.settings;
    const key = keyOf(ev);
    let sounded = 'unavailable';
    if (!ev.silent && st.bells) sounded = audio.ensure(key, bellOpts(ev.type));
    else audio.cancelIfPending(key);
    const next = S.markFired(s, ev, mono, clock.wall());

    if (ev.type === 'start') {
      if (st.vibrate === 'both') vibrate(40);
      announce(t().srStarted);
    } else if (ev.type === 'interval') {
      if (!ev.silent) announce(t().srInterval);
    } else if (ev.type === 'end') {
      // 音が鳴らなかった・鳴らさない設定のときの代替
      const noSound = !st.bells || sounded === 'unavailable';
      if (st.vibrate !== 'off' || noSound) vibrate([60, 140, 60]);
      if (st.notifyEnd && (document.hidden || noSound)) notifications.show(t().notifyTitle, t().notifyBody);
      announce(t().srEnded);
      state.session = next;
      finish({ early: false, away: ev.silent });
      return next;
    }
    return next;
  }

  function updateSessionView(mono) {
    const s = state.session;
    const view = root.querySelector('[data-view="session"]');
    if (!view) return;
    const ph = S.phase(s, mono);
    view.dataset.phase = s.status === S.STATUS.PAUSED ? 'paused' : ph;
    const eff = Settings.effective(state.settings);

    // 準備の残り（秒）は準備中のみ。数字は 5 秒刻みでしか変えない（せかさない）
    const prep = view.querySelector('[data-prep-count]');
    if (prep) {
      const sec = Math.ceil(S.prepRemaining(s, mono) / 1000);
      const shown = sec <= 3 ? t().prepNow : t().prepCount(Math.ceil(sec / 5) * 5);
      if (prep.textContent !== shown) prep.textContent = shown;
      const bar = view.querySelector('[data-prep-bar]');
      if (bar && s.prepMs) bar.style.transform = `scaleX(${Math.max(0, S.prepRemaining(s, mono) / s.prepMs)})`;
    }

    // 残り時間
    const rem = view.querySelector('[data-remaining]');
    if (rem) {
      let text = '';
      if (ph === S.PHASE.SITTING || s.status === S.STATUS.PAUSED) {
        if (s.durationMs === null) {
          if (eff.remaining !== 'hidden') text = t().elapsedOpen(Math.floor(S.sittingElapsed(s, mono) / 60_000));
        } else {
          const rv = remainingView(S.remaining(s, mono), eff.remaining);
          if (rv?.kind === 'approx') text = t().remainingApprox(rv.minutes);
          else if (rv?.kind === 'soon') text = t().remainingSoon;
          else if (rv?.kind === 'exact') text = t().remainingExact(rv.text);
        }
      }
      // 「残り時間を聞く」を押した直後は、表示設定に関わらず数秒だけ見せる（準備中も）
      const flash = state.meta?.flash && mono < state.meta.flash.until ? state.meta.flash.text : null;
      if (flash) text = flash;
      rem.dataset.flash = flash ? 'true' : 'false';
      if (text !== lastRemainingKey) { rem.textContent = text; lastRemainingKey = text; }
    }

    // 案内付きの字幕
    if (s.kind === 'guided' && ph === S.PHASE.SITTING && s.status === S.STATUS.RUNNING) {
      const sat = S.sittingElapsed(s, mono) / 1000;
      for (const c of GUIDED_CUES) {
        if (sat >= c.at && sat < c.at + 20 && !state.meta.cuesShown.includes(c.key)) {
          state.meta.cuesShown.push(c.key);
          showCue(c.key, mono);
        }
      }
      const r = S.remaining(s, mono);
      if (r != null && r < 25_000 && !state.meta.nearShown) { state.meta.nearShown = true; showCue('near', mono); }
    }
    const cueEl = view.querySelector('[data-cue]');
    if (cueEl) {
      const visible = state.meta.cue && mono < state.meta.cueUntil;
      cueEl.dataset.show = visible ? 'true' : 'false';
    }
  }

  function showCue(key, mono) {
    const eff = Settings.effective(state.settings);
    const text = t().cues[key];
    state.meta.cue = key;
    state.meta.cueUntil = mono + 9000;
    const cueEl = root.querySelector('[data-cue]');
    if (cueEl && eff.captions) cueEl.textContent = text;
    if (eff.speech) speech.speak(text, lang());
    else if (eff.captions) announce(text);
  }

  function pause() {
    const s = state.session;
    if (!s || s.status !== S.STATUS.RUNNING) return;
    state.session = S.pause(s, clock.read());
    audio.cancelPending();
    audio.lowerAmbience(0.25);
    speech.cancel();
    persist(true);
    announce(t().srPaused);
    render({ keepFocus: true });
  }

  function resume() {
    const s = state.session;
    if (!s || s.status !== S.STATUS.PAUSED) return;
    state.session = S.resume(s, clock.read());
    audio.resume().then(() => { syncAudio(true); audio.setAmbienceVolume(state.settings.ambienceVolume); });
    persist(true);
    announce(t().srResumed);
    render({ keepFocus: true });
  }

  function extend() {
    const s = state.session;
    if (!s) return;
    const mono = clock.read();
    const wasFinished = s.status === S.STATUS.FINISHED;
    state.session = S.extend(s, EXTEND_MS, mono);
    if (state.session === s) return;
    persist(true);
    if (wasFinished) {
      // 余韻から「もう少し座る」
      state.after = null;
      if (state.settings.wakeLock) wake.request();
      const eff = Settings.effective(state.settings);
      audio.unlock().then((ok) => {
        if (ok) { syncAudio(true); if (eff.ambience !== 'none' && state.session.kind !== 'kinhin') audio.startAmbience(eff.ambience, 4); }
      });
      nav('session');
      startTicking();
    } else {
      syncAudio(true);
      render({ keepFocus: true });
    }
    announce(t().srExtended(approxMinutes(S.sittingRemaining(state.session, mono))));
  }

  function endEarly() {
    const s = state.session;
    if (!s) return;
    state.session = S.endEarly(s, clock.read(), clock.wall());
    audio.cancelPending();
    finish({ early: true, away: false });
  }

  function finish({ early, away }) {
    const s = state.session;
    stopTicking();
    speech.cancel();
    const mono = clock.read();
    state.after = { summary: S.summarize(s, mono), early, away, canExtend: s.status === S.STATUS.FINISHED && s.durationMs !== null, startedAt: mono };
    storage.remove('active');
    audio.stopAmbience(Math.max(4, state.settings.afterglowSec * 0.8));
    setTimeout(() => { if (state.view !== 'session') wake.release(); }, state.settings.afterglowSec * 1000);
    nav('afterglow');
  }

  /** 余韻のあと: 記録する／しない は同じ重みで扱う */
  function closeAfterglow({ save, tags = [], note = '' }) {
    const a = state.after;
    if (a && save) {
      const entry = History.makeEntry(a.summary, { tags, note });
      state.history = History.add(state.history, entry);
      state.history = History.forget(state.history, state.settings.forgetDays, clock.wall());
      storage.write('history', state.history);
    }
    state.after = null;
    state.session = null;
    wake.release();
    nav('home');
    if (a && save) toast(t().saved);
  }

  // ── 復元（再読み込み・タブ復帰） ─────────────
  function restoreActive() {
    const raw = storage.read('active');
    if (!raw) return;
    const mono = clock.read();
    const wall = clock.wall();
    const s = S.restore(raw, mono, wall);
    if (!s) { storage.remove('active'); return; }
    const awayMs = Math.max(0, wall - (raw.checkpointWall || wall));
    state.session = s;
    state.meta = { firstEver: false, cuesShown: ['eyes', 'breath', 'thoughts', 'pain'], cue: null, cueUntil: 0, nearShown: true };
    if (s.durationMs !== null && S.elapsed(s, mono) >= S.totalMs(s)) {
      // 閉じている間に終わっていた
      if (awayMs > 6 * 3600_000) { storage.remove('active'); state.session = null; return; }
      state.session = S.markFired(s, { type: 'end' }, mono, wall);
      finish({ early: false, away: true });
      return;
    }
    // 途中だった: 続けるかどうかを尋ねる（音を鳴らすには操作が必要なため）
    const sat = Math.max(1, Math.round(S.sittingElapsed(s, mono) / 60_000));
    openDialog(dialogEl, {
      title: t().resumeTitle,
      body: [t().resumeBody(sat)],
      actions: [
        { label: t().resumeContinue, primary: true, onClick: () => continueRestored() },
        { label: t().resumeEnd, onClick: () => { endEarly(); } },
      ],
      onCancel: () => continueRestored(),
    });
  }

  function continueRestored() {
    if (!state.session) return;
    closeDialog(dialogEl);
    // 閉じていた間の途中の鐘は鳴らさない
    const mono = clock.read();
    let s = state.session;
    for (const ev of S.dueEvents(s, mono)) if (ev.type !== 'end') s = S.markFired(s, ev, mono, clock.wall());
    state.session = s;
    const eff = Settings.effective(state.settings);
    audio.unlock().then((ok) => {
      if (ok) { syncAudio(true); if (eff.ambience !== 'none' && s.kind !== 'kinhin') audio.startAmbience(eff.ambience, 4); }
    });
    if (state.settings.wakeLock) wake.request();
    nav('session');
    startTicking();
    tick();
  }

  // ── データ ───────────────────────────────
  function deleteEntry(entryId) {
    state.history = History.remove(state.history, entryId);
    storage.write('history', state.history);
    render({ keepFocus: true });
    announce(t().deleted);
  }
  function deleteAll() {
    storage.clearAll();
    state.history = [];
    state.settings = Settings.defaults();
    state.seenGuide = false;
    state.sessions = 0;
    applySettings();
    nav('home');
    toast(t().deleted);
  }
  function exportData() {
    const json = History.exportJSON(state.history, state.settings, clock.wall());
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shizuka-zazen-${new Date(clock.wall()).toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return json;
  }
  function markGuideSeen() {
    state.seenGuide = true;
    storage.write('seenGuide', true);
  }

  async function enableNotify(on, input) {
    if (!on) { updateSettings({ notifyEnd: false }); return; }
    const perm = notifications.permission === 'granted' ? 'granted' : await notifications.request();
    if (perm === 'granted') updateSettings({ notifyEnd: true });
    else {
      if (input) input.checked = false;
      updateSettings({ notifyEnd: false }, { rerender: false });
      toast(t().sNotifyDenied);
    }
  }

  async function testBell() {
    const ok = await audio.unlock();
    if (!ok) { toast(t().audioUnavailable); return; }
    audio.test({ style: state.settings.bellStyle, tone: state.settings.bellTone });
  }

  async function restoreAudio() {
    const ok = await audio.resume();
    if (ok) {
      setNotice(null);
      syncAudio(true);
      if (state.session?.status === S.STATUS.RUNNING) audio.setAmbienceVolume(state.settings.ambienceVolume);
    }
  }

  /**
   * 「残り時間を聞く」。以前はスクリーンリーダー用の見えない領域に書くだけで、
   * 読み上げソフトを使っていない人には何も起きなかった。
   * いまは (1) 端末の音声合成で読み上げ、(2) 画面にも数秒表示し、
   * (3) 音声合成がない環境ではライブ領域でスクリーンリーダーに伝える。
   */
  function sayRemaining() {
    const s = state.session;
    if (!s) return null;
    const mono = clock.read();
    let text;
    if (s.durationMs === null) text = t().srRemainingOpen(Math.floor(S.sittingElapsed(s, mono) / 60_000));
    else {
      const r = S.sittingRemaining(s, mono);
      text = r <= 60_000 ? t().srRemainingSoon : t().srRemaining(approxMinutes(r));
    }
    if (state.meta) state.meta.flash = { text, until: mono + 6000 };
    if (speech.supported) speech.speak(text, lang());
    else announce(text);
    updateSessionView(mono);
    return text;
  }

  // ── ライフサイクル ───────────────────────
  function onVisibility() {
    if (document.visibilityState === 'hidden') { persist(true); return; }
    if (state.session && state.view === 'session') {
      tick();
      if (audio.context && audio.state !== 'running') audio.resume().then((ok) => { if (!ok) setNotice('suspended'); });
    }
    applyScene();
  }

  // ビューへ渡す文脈
  const ctx = {
    get t() { return t(); },
    get lang() { return lang(); },
    get state() { return state; },
    get now() { return clock.wall(); },
    get mono() { return clock.read(); },
    get audioAvailable() { return audio.available; },
    get version() { return VERSION; },
    get notificationsSupported() { return notifications.supported; },
    get speechSupported() { return speech.supported; },
    get wakeLockSupported() { return wake.supported; },
    dialogEl,
    start, pause, resume, extend, endEarly, closeAfterglow, nav, updateSettings,
    deleteEntry, deleteAll, exportData, markGuideSeen, enableNotify, testBell, restoreAudio,
    sayRemaining, announce, toast, render,
  };

  function init() {
    applySettings();
    // 鐘の波形を空き時間に事前計算（最初の鐘の遅延を防ぐ）
    const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    idle(() => { try { audio.prerender(state.settings.bellTone); } catch { /* 失敗しても鳴らす時に再計算 */ } });
    guessLowPower().then((low) => { state.lowPowerGuess = low; applyScene(); });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', (e) => sessionKeydown(ctx, e));
    globalThis.addEventListener?.('pagehide', () => persist(true));
    globalThis.addEventListener?.('online', () => { state.online = true; });
    globalThis.addEventListener?.('offline', () => { state.online = false; if (state.view !== 'session') toast(t().offline); });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', applySettings);
    // 時刻に合わせた景色は 5 分ごとに見直す
    setInterval(() => { if (state.settings.scene === 'auto') applyScene(); }, 5 * 60_000);
    nav('home', { focus: false });
    restoreActive();
  }

  return { init, ctx, state, audio, scene, clock, tick, storage, persist };
}
