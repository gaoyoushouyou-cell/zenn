// 実際のアプリを iframe で起動し、仮想時計と偽の音声で通しの導線を確かめる。
// 5分・20分・60分のセッションを、実時間を待たずに開始 → バックグラウンド → 復帰 → 終了まで再現する。

import { test, assert, setFile, sleep } from '../harness.js';
import { fakeClock } from '../../src/core/clock.js';
import { memoryBackend } from '../../src/core/storage.js';
import { makeFakeAudio, bellStarts } from '../fakes.js';

setFile('e2e/app');
const MIN = 60_000;

let frameCount = 0;
async function launch({ clock = fakeClock(Date.UTC(2026, 10, 7, 21, 0)), audio, backend = memoryBackend(), prefix, width = 420, height = 800, beforeBoot } = {}) {
  const fa = audio === null ? { AudioCtor: null, log: { starts: [] } } : audio || makeFakeAudio(clock);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `width:${width}px;height:${height}px;border:0;position:absolute;left:-9999px;top:0`;
  iframe.src = `../index.html?test=${++frameCount}`;
  document.body.append(iframe);
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  const w = iframe.contentWindow;
  for (let i = 0; i < 100 && !w.__zazenBoot; i++) await sleep(20);
  if (!w.__zazenBoot) throw new Error('app did not load');
  const vibrations = [];
  w.navigator.vibrate = (p) => { vibrations.push(p); return true; };
  beforeBoot && beforeBoot(w);
  const app = w.__zazenBoot({ clockBase: clock, AudioCtor: fa.AudioCtor, storageBackend: backend, storagePrefix: prefix || `zazen.e2e${frameCount}.` });
  const doc = iframe.contentDocument;
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const advance = async (ms, { tickEvery = 1000 } = {}) => {
    // tickEvery=0 はタブが裏にあって tick が来ない状態を模す
    if (!tickEvery) { clock.advance(ms); app.tick(); await sleep(0); return; }
    for (let t = 0; t < ms; t += tickEvery) { clock.advance(Math.min(tickEvery, ms - t)); app.tick(); }
    await sleep(0);
  };
  const close = () => iframe.remove();
  return { iframe, w, doc, app, clock, audio: fa, $, $$, advance, close, backend, vibrations };
}

function screen(env) { return env.doc.documentElement.dataset.screen; }
function textOf(env, sel) { return (env.$(sel)?.textContent || '').trim(); }
async function flush() { await sleep(30); }

test('ホーム: 1 操作で座禅が始まり、準備 → 開始の鐘（三つ）', async () => {
  const env = await launch();
  try {
    assert.equal(screen(env), 'home');
    env.$('#sit').click();
    await flush();
    assert.equal(screen(env), 'session');
    assert.equal(env.$('main [data-view="session"]').dataset.phase, 'prep');
    await env.advance(10_000);
    assert.equal(env.$('main [data-view="session"]').dataset.phase, 'sitting');
    assert.equal(bellStarts(env.audio.log).filter((s) => s.when < 30).length, 3, 'three start strikes');
  } finally { env.close(); }
});

for (const minutes of [5, 20, 60]) {
  test(`${minutes}分: 開始 → 裏に回る（tick なし）→ 復帰 → 終わりの鐘一つ → 余韻 → 記録`, async () => {
    const env = await launch();
    try {
      env.app.ctx.updateSettings({ durationMin: minutes });
      env.$('#sit').click();
      await flush();
      await env.advance(10_000 + 60_000);
      // 裏に回り、残りのほとんどの間 tick が来ない
      await env.advance((minutes - 2) * MIN, { tickEvery: 0 });
      assert.equal(screen(env), 'session');
      await env.advance(2 * MIN);
      assert.equal(screen(env), 'afterglow');
      const endBells = bellStarts(env.audio.log).filter((s) => s.when > 60);
      assert.equal(endBells.length, 1, 'one end bell');
      assert.approx(endBells[0].when, 10 + minutes * 60, 0.5, 'end bell at exact audio time');
      // 余韻の後、記録する
      env.$('[data-key="tag:calm"]').click();
      env.$('[data-key="save"]').click();
      await flush();
      assert.equal(screen(env), 'home');
      const h = env.app.state.history;
      assert.equal(h.length, 1);
      assert.equal(h[0].completed, true);
      assert.approx(h[0].sitMs, minutes * MIN, 1500);
      assert.deepEqual(h[0].tags, ['calm']);
    } finally { env.close(); }
  }, { timeout: 30_000 });
}

test('途中の鐘: 5 分ごと、裏に回っていた間の遅れた鐘はまとめて鳴らさない', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ durationMin: 30, intervalMin: 5 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 2 * MIN);
    const before = bellStarts(env.audio.log).length;
    await env.advance(13 * MIN, { tickEvery: 0 });
    // 予約済みの鐘（音声クロック）は鳴っている扱い。JS 側からの追加の鐘はない
    const after = bellStarts(env.audio.log).length;
    assert.equal(after, before, 'no extra bells from JS after resume');
  } finally { env.close(); }
});

test('一時停止 → 再開: 一時停止中は時間が進まず、P キーでも切り替わる', async () => {
  const env = await launch();
  try {
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + MIN);
    env.$('[data-key="pause"]').click();
    await flush();
    assert.equal(env.app.state.session.status, 'paused');
    const rem = env.app.ctx.state.session.durationMs;
    await env.advance(30 * MIN);
    assert.equal(screen(env), 'session', 'not ended while paused');
    env.doc.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    await flush();
    assert.equal(env.app.state.session.status, 'running');
    assert.ok(rem > 0);
    // 予約が取り消され、再開で作り直されている
    const pendingEnd = bellStarts(env.audio.log).filter((s) => s.when > 100);
    assert.equal(pendingEnd.length, 1);
  } finally { env.close(); }
});

test('延長: 5 分延びる。終了後の「もう少し座る」でも続けられる', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ durationMin: 5 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + MIN);
    env.$('[data-key="extend"]').click();
    await flush();
    assert.equal(env.app.state.session.durationMs, 10 * MIN);
    await env.advance(9 * MIN + 1000);
    assert.equal(screen(env), 'afterglow');
    env.$('[data-key="more"]').click();
    await flush();
    assert.equal(screen(env), 'session');
    await env.advance(5 * MIN + 1000);
    assert.equal(screen(env), 'afterglow');
    env.$('[data-key="nosave"]').click();
    await flush();
    assert.equal(env.app.state.history.length, 0, 'not saving is a first-class option');
  } finally { env.close(); }
});

test('途中で終える: 責めない文言で余韻へ。記録は「途中で終えた」', async () => {
  const env = await launch();
  try {
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 3 * MIN);
    env.$('[data-key="end"]').click();
    await flush();
    assert.equal(screen(env), 'afterglow');
    assert.ok(env.doc.body.textContent.includes(env.app.ctx.t.afterEarly));
    env.$('[data-key="save"]').click();
    await flush();
    assert.equal(env.app.state.history[0].completed, false);
  } finally { env.close(); }
});

test('再読み込み: 途中のセッションを「続ける」で再開し、閉じていた時間も数える', async () => {
  const backend = memoryBackend();
  const clock = fakeClock();
  const prefix = 'zazen.reload.';
  const a = await launch({ backend, clock, prefix });
  a.app.ctx.updateSettings({ durationMin: 20 });
  a.$('#sit').click();
  await flush();
  await a.advance(10_000 + 3 * MIN);
  a.app.persist(true);
  a.close();
  clock.advance(MIN); // 閉じていた 1 分
  const b = await launch({ backend, clock, prefix });
  try {
    const dlg = b.$('#dialog');
    assert.ok(dlg.open, 'resume dialog shown');
    dlg.querySelector('.btn-primary').click();
    await flush();
    assert.equal(screen(b), 'session');
    const s = b.app.state.session;
    assert.approx(s.elapsedBefore + (b.clock.mono() - s.anchor), 10_000 + 4 * MIN, 1500);
    await b.advance(16 * MIN + 1000);
    assert.equal(screen(b), 'afterglow');
  } finally { b.close(); }
});

test('閉じている間に終わっていた: 鐘を鳴らさず余韻へ（離れていたことを伝える）', async () => {
  const backend = memoryBackend();
  const clock = fakeClock();
  const prefix = 'zazen.away.';
  const a = await launch({ backend, clock, prefix });
  a.app.ctx.updateSettings({ durationMin: 5 });
  a.$('#sit').click();
  await flush();
  await a.advance(10_000 + MIN);
  a.app.persist(true);
  a.close();
  clock.advance(30 * MIN);
  const b = await launch({ backend, clock, prefix });
  try {
    assert.equal(screen(b), 'afterglow');
    assert.ok(b.doc.body.textContent.includes(b.app.ctx.t.afterAway));
    assert.equal(bellStarts(b.audio.log).length, 0);
  } finally { b.close(); }
});

test('端末時刻の変更: 過去へ戻しても残り時間は変わらない', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ durationMin: 10 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 2 * MIN);
    env.clock.setWall(env.clock.wall() - 5 * 3600_000);
    await env.advance(7 * MIN);
    assert.equal(screen(env), 'session');
    await env.advance(MIN + 1000);
    assert.equal(screen(env), 'afterglow');
  } finally { env.close(); }
});

test('スリープ（単調時計が凍る端末）: 復帰後に正しく終わる', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ durationMin: 10 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + MIN);
    env.clock.sleepFrozen(20 * MIN);
    await env.advance(1000);
    assert.equal(screen(env), 'afterglow');
  } finally { env.close(); }
});

test('音が使えない端末: 座禅は成立し、終わりは振動と画面で知らせる', async () => {
  const env = await launch({ audio: null });
  try {
    env.app.ctx.updateSettings({ durationMin: 5, vibrate: 'off' });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000);
    assert.ok(env.doc.body.textContent.includes(env.app.ctx.t.audioUnavailable), 'notice shown');
    await env.advance(5 * MIN);
    assert.equal(screen(env), 'afterglow');
    assert.ok(env.vibrations.length >= 1, 'vibration fallback even when vibrate is off');
  } finally { env.close(); }
});

test('AudioContext の生成に失敗: 例外なく続く', async () => {
  const clock = fakeClock();
  const env = await launch({ clock, audio: makeFakeAudio(clock, { failConstruct: true }) });
  try {
    env.app.ctx.updateSettings({ durationMin: 5 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 5 * MIN);
    assert.equal(screen(env), 'afterglow');
  } finally { env.close(); }
});

test('音声の自動再生ブロック・中断: suspended のままなら案内を出し、触れると戻る', async () => {
  const clock = fakeClock();
  const fa = makeFakeAudio(clock, { startState: 'suspended' });
  // resume しても running にならない（ブロック）
  const Orig = fa.AudioCtor;
  fa.AudioCtor = class extends Orig { resume() { return Promise.resolve(); } };
  const env = await launch({ clock, audio: fa });
  try {
    env.$('#sit').click();
    await sleep(900);
    assert.ok(env.doc.body.textContent.includes(env.app.ctx.t.audioSuspended), 'suspended notice');
  } finally { env.close(); }
});

test('容量不足: 保存できなくても座禅は続き、穏やかに一度だけ知らせる', async () => {
  const env = await launch({ backend: memoryBackend({ failWrites: true }) });
  try {
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 10 * MIN);
    assert.equal(screen(env), 'afterglow');
    assert.equal(textOf(env, '#toast'), env.app.ctx.t.storageQuota);
  } finally { env.close(); }
});

test('静寂モード: 景色を消し、環境音・残り時間を出さない', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ quiet: true, ambience: 'rain', remaining: 'exact' });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + MIN);
    assert.equal(env.$('#scene').dataset.dark, 'true');
    assert.equal(textOf(env, '[data-remaining]'), '');
    assert.equal(env.app.audio.ambienceType, 'none');
  } finally { env.close(); }
});

test('残り時間: 「約◯分」表示を選ぶと秒を出さない', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ remaining: 'approx', durationMin: 10 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 2 * MIN + 500);
    assert.equal(textOf(env, '[data-remaining]'), env.app.ctx.t.remainingApprox(8));
  } finally { env.close(); }
});

test('案内付き（はじめての座禅）: 字幕が順に出る', async () => {
  const env = await launch();
  try {
    env.$('[data-key="guide"]').click();
    await flush();
    assert.equal(screen(env), 'guide');
    for (let i = 0; i < 8 && !env.$('[data-key="guided"]'); i++) { env.$('[data-key="g-next"]').click(); await flush(); }
    env.$('[data-key="guided"]').click();
    await flush();
    assert.equal(env.app.state.session.kind, 'guided');
    await env.advance(10_000 + 15_000);
    assert.equal(textOf(env, '[data-cue]'), env.app.ctx.t.cues.eyes);
    await env.advance(5 * MIN);
    assert.equal(screen(env), 'afterglow');
  } finally { env.close(); }
});

test('椅子の案内: 座る場所に「椅子」があり、説明が出る', async () => {
  const env = await launch();
  try {
    env.$('[data-key="guide"]').click();
    await flush();
    env.$('[data-key="g-next"]').click();
    await flush();
    env.$('[data-key="posture:chair"]').click();
    await flush();
    assert.ok(env.$('.posture-desc').textContent.includes(env.app.ctx.t.posture.chair.body.slice(0, 10)));
  } finally { env.close(); }
});

test('経行: 始め二つ・終わり一つの鐘、環境音なし', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ ambience: 'rain' });
    env.$('[data-key="kinhin"]').click();
    await flush();
    env.$('[data-key="kinhin-min:5"]').click();
    env.$('[data-key="kinhin-start"]').click();
    await flush();
    assert.equal(env.app.state.session.kind, 'kinhin');
    await env.advance(10_000 + 5 * MIN + 500);
    assert.equal(screen(env), 'afterglow');
    const bells = bellStarts(env.audio.log);
    assert.equal(bells.length, 3, '2 + 1');
    assert.equal(env.app.audio.ambienceType, 'none');
  } finally { env.close(); }
});

test('データ削除: すべて消すと記録と設定が初期化される', async () => {
  const backend = memoryBackend();
  const env = await launch({ backend, prefix: 'zazen.del.' });
  try {
    env.app.ctx.updateSettings({ durationMin: 30 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 30 * MIN);
    env.$('[data-key="save"]').click();
    await flush();
    assert.equal(env.app.state.history.length, 1);
    env.app.ctx.nav('settings');
    env.$('[data-key="s-delete-all"]').click();
    env.$('#dialog .btn-danger').click();
    await flush();
    assert.equal(env.app.state.history.length, 0);
    assert.equal(env.app.state.settings.durationMin, 10);
    const keys = [...backend._map.keys()].filter((k) => k.startsWith('zazen.del.') && !k.endsWith('sessionsCount'));
    assert.deepEqual(keys.filter((k) => !k.endsWith('settings')), []);
  } finally { env.close(); }
});

test('書き出し: JSON に記録が入る（端末内でファイル化のみ）', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ durationMin: 5 });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 5 * MIN);
    env.$('[data-key="save"]').click();
    await flush();
    const json = JSON.parse(env.app.ctx.exportData());
    assert.equal(json.history.length, 1);
  } finally { env.close(); }
});

test('Reduce Motion: 設定で動きを減らすと data-motion=reduce', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ motion: 'reduce' });
    assert.equal(env.doc.documentElement.dataset.motion, 'reduce');
    const dur = env.w.getComputedStyle(env.doc.documentElement).getPropertyValue('--dur-slow').trim();
    assert.equal(dur, '1ms');
  } finally { env.close(); }
});

test('文字サイズ 200%・狭い画面でも横にはみ出さない', async () => {
  const env = await launch({ width: 320, height: 640 });
  try {
    env.app.ctx.updateSettings({ textScale: 2 });
    for (const v of ['home', 'settings', 'history', 'guide', 'kinhin']) {
      env.app.ctx.nav(v);
      await flush();
      const over = env.doc.documentElement.scrollWidth - env.doc.documentElement.clientWidth;
      assert.ok(over <= 1, `${v} overflows by ${over}px`);
    }
  } finally { env.close(); }
});

test('言語: 英語に切り替えられる', async () => {
  const env = await launch();
  try {
    env.app.ctx.updateSettings({ lang: 'en' });
    assert.equal(env.doc.documentElement.lang, 'en');
    assert.equal(textOf(env, '.sit-label'), 'Sit');
  } finally { env.close(); }
});

// 「残り時間を聞く」: 以前は見えないライブ領域に書くだけで、読み上げソフトなしでは何も起きなかった（回帰テスト）
function fakeSpeech(w) {
  const spoken = [];
  Object.defineProperty(w, 'speechSynthesis', {
    configurable: true,
    value: { speak: (u) => spoken.push({ text: u.text, lang: u.lang }), cancel() {}, getVoices: () => [] },
  });
  return spoken;
}

test('残り時間を聞く: 音声合成で読み上げ、画面にも表示する（準備中は準備時間を含めない）', async () => {
  let spoken;
  const env = await launch({ beforeBoot: (w) => { spoken = fakeSpeech(w); } });
  try {
    env.app.ctx.updateSettings({ durationMin: 10, remaining: 'hidden' });
    env.$('#sit').click();
    await flush();
    await env.advance(5_000); // 準備中
    env.$('[data-key="say"]').click();
    await flush();
    const t = env.app.ctx.t;
    assert.deepEqual(spoken.map((x) => x.text), [t.srRemaining(10)], 'spoken during prep');
    assert.equal(spoken[0].lang, 'ja-JP');
    const rem = env.$('[data-remaining]');
    assert.equal(rem.dataset.flash, 'true');
    assert.equal(rem.textContent, t.srRemaining(10));
    assert.equal(env.w.getComputedStyle(rem).visibility, 'visible', 'visible even in prep');
    // 座っている途中
    await env.advance(5_000 + 3 * 60_000 + 500);
    env.$('[data-key="say"]').click();
    await flush();
    assert.equal(spoken.at(-1).text, t.srRemaining(7));
    // 数秒で表示は消える（既定の「表示しない」に戻る）
    await env.advance(7_000);
    assert.equal(rem.dataset.flash, 'false');
    assert.equal(rem.textContent, '');
    // 最後の 1 分は「まもなく」
    await env.advance(6 * 60_000 + 10_000);
    env.$('[data-key="say"]').click();
    await flush();
    assert.equal(spoken.at(-1).text, t.srRemainingSoon);
  } finally { env.close(); }
});

test('残り時間を聞く: 音声合成がない環境ではライブ領域で伝える', async () => {
  const env = await launch({ beforeBoot: (w) => Object.defineProperty(w, 'speechSynthesis', { configurable: true, value: undefined }) });
  try {
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 2 * 60_000);
    env.$('[data-key="say"]').click();
    await sleep(120);
    assert.equal(env.$('#sr').textContent, env.app.ctx.t.srRemaining(8));
    assert.equal(env.$('[data-remaining]').dataset.flash, 'true');
  } finally { env.close(); }
});

test('残り時間を聞く: 終わりを決めない座禅では座った時間を伝える', async () => {
  let spoken;
  const env = await launch({ beforeBoot: (w) => { spoken = fakeSpeech(w); } });
  try {
    env.app.ctx.updateSettings({ openEnded: true });
    env.$('#sit').click();
    await flush();
    await env.advance(10_000 + 4 * 60_000);
    env.$('[data-key="say"]').click();
    await flush();
    assert.equal(spoken.at(-1).text, env.app.ctx.t.srRemainingOpen(4));
  } finally { env.close(); }
});
