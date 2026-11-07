// 音の司令塔。
// - AudioContext は利用者の操作（座るボタン）の中で作り、resume する（自動再生ブロック対策）
// - 鐘は「先に予約」する。JS のタイマーが間引かれても、音声クロックで正確に鳴る
// - 予約時刻と JS 側の判断がずれても二重に鳴らない（ensure）
// - 割り込み（通話・他アプリ）や出力先の変更を検知し、驚かせない側に倒す
// - すべての音はリミッターを通し、音量の急な差を抑える

import { renderBell, bellPattern } from './bell.js';
import { buildAmbience } from './ambience.js';

const BELL_SR = 32000;

// AudioCtor: 省略（undefined）なら端末の AudioContext、null なら「音声なし」として扱う
export function createAudioEngine({ AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext, onState, onRouteChange } = {}) {
  let ctx = null;
  let master, limiter, bellBus, ambBus, duckGain;
  const bellCache = new Map(); // `${tone}:${velocity}` -> AudioBuffer
  const rawCache = new Map(); // 同じ鍵で PCM（AudioContext 不要）
  const scheduled = new Map(); // key -> { when, sources: [] }
  let ambience = null;
  let ambType = 'none';
  let modTimer = null;
  let failed = false;
  let bellVolume = 0.6;
  let ambVolume = 0.4;

  const available = () => !!AudioCtor && !failed;

  function prerender(tone) {
    // 頻出の強さだけを事前に計算しておく（アイドル時に呼ぶ）
    for (const v of [0.5, 0.55, 0.66, 0.7, 0.72, 0.75, 0.8, 0.85]) raw(tone, v);
  }

  function raw(tone, v) {
    const k = `${tone}:${v}`;
    let r = rawCache.get(k);
    if (!r) {
      r = renderBell({ tone, sampleRate: BELL_SR, velocity: v, seed: 7 + Math.round(v * 100) });
      rawCache.set(k, r);
    }
    return r;
  }

  function bellBuffer(tone, v) {
    const k = `${tone}:${v}`;
    let b = bellCache.get(k);
    if (b) return b;
    const r = raw(tone, v);
    b = ctx.createBuffer(2, r.left.length, r.sampleRate);
    b.getChannelData(0).set(r.left);
    b.getChannelData(1).set(r.right);
    bellCache.set(k, b);
    return b;
  }

  function build() {
    ctx = new AudioCtor({ latencyHint: 'playback' });
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master = ctx.createGain();
    master.gain.value = 1;
    bellBus = ctx.createGain();
    bellBus.gain.value = bellVolume;
    ambBus = ctx.createGain();
    ambBus.gain.value = 0;
    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    bellBus.connect(master);
    ambBus.connect(duckGain);
    duckGain.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);
    ctx.onstatechange = () => onState && onState(ctx.state);
    // Bluetooth イヤホンの切断など。権限なしで発火する（ブラウザによる）。
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', () => onRouteChange && onRouteChange());
    } catch { /* noop */ }
  }

  return {
    get available() { return available(); },
    get state() { return ctx ? ctx.state : 'none'; },
    get context() { return ctx; },
    prerender,

    /** 利用者の操作の中で呼ぶ。失敗しても例外は投げない。 */
    async unlock() {
      if (!available()) return false;
      try {
        if (!ctx) build();
        if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 800))]);
        // iOS で無音のまま鳴らない問題への対策: ごく短い無音を一度鳴らす
        const b = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start();
        return ctx.state === 'running';
      } catch (err) {
        failed = true;
        return false;
      }
    },

    async resume() {
      if (!ctx) return false;
      try { await ctx.resume(); } catch { /* noop */ }
      return ctx.state === 'running';
    },

    setBellVolume(v) {
      bellVolume = v;
      if (bellBus) bellBus.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    },

    setAmbienceVolume(v) {
      ambVolume = v;
      if (ambBus && ambience) ambBus.gain.setTargetAtTime(v, ctx.currentTime, 0.4);
    },

    /** 鐘を予約する。inSec 秒後に pattern を鳴らす。既存の同じ鍵は置き換える。 */
    schedule(key, inSec, { kind, style, tone, sessionKind }) {
      if (!ctx || failed) return false;
      this.cancel(key);
      try {
        const when = ctx.currentTime + Math.max(0.02, inSec);
        const pattern = bellPattern(kind, style, sessionKind);
        const sources = pattern.map(({ at, v }) => {
          const s = ctx.createBufferSource();
          s.buffer = bellBuffer(tone, v);
          s.connect(bellBus);
          s.start(when + at);
          return s;
        });
        scheduled.set(key, { when, sources, length: pattern[pattern.length - 1].at + 1 });
        // 鐘の間は環境音を少し下げる
        if (duckGain) {
          duckGain.gain.setTargetAtTime(0.55, when, 0.15);
          duckGain.gain.setTargetAtTime(1, when + pattern[pattern.length - 1].at + 3, 1.2);
        }
        return true;
      } catch (err) {
        return false;
      }
    },

    /** 予約済みの時刻（音声クロック基準の「あと何秒」）。予約がなければ null */
    scheduledIn(key) {
      const s = scheduled.get(key);
      if (!s || !ctx) return null;
      return s.when - ctx.currentTime;
    },

    cancel(key) {
      const s = scheduled.get(key);
      if (!s) return;
      for (const src of s.sources) { try { src.stop(); } catch { /* noop */ } }
      scheduled.delete(key);
    },

    /** その鍵の予約がまだ鳴り始めていなければ取り消す（鳴っている鐘は途中で切らない＝クリック防止） */
    cancelIfPending(key) {
      const s = scheduled.get(key);
      if (s && ctx && s.when > ctx.currentTime + 0.01) this.cancel(key);
    },

    /** まだ鳴り始めていない予約だけを取り消す（鳴っている鐘は自然に消えるまで残す） */
    cancelPending() {
      if (!ctx) return;
      for (const [key, s] of [...scheduled]) {
        if (s.when > ctx.currentTime + 0.01) this.cancel(key);
      }
    },

    /**
     * JS 側でイベントを処理するときに呼ぶ。
     * 予約がすでに鳴った（鳴っている）なら何もしない。予約がない／ずれているなら今鳴らす。
     * @returns 'scheduled' | 'played' | 'unavailable'
     */
    ensure(key, opts) {
      if (!ctx || failed || ctx.state !== 'running') {
        return 'unavailable';
      }
      const s = scheduled.get(key);
      if (s && s.when <= ctx.currentTime + 0.25 && s.when > ctx.currentTime - 30) return 'scheduled';
      this.schedule(key, 0.02, opts);
      return 'played';
    },

    /** 今すぐ一度鳴らす（設定画面の試聴など） */
    test(opts) {
      return this.schedule('test', 0.05, { ...opts, kind: 'test' });
    },

    startAmbience(type, fadeSec = 4) {
      if (!ctx || failed) return;
      if (ambience && ambType === type) {
        ambBus.gain.setTargetAtTime(ambVolume, ctx.currentTime, fadeSec / 3);
        return;
      }
      this.stopAmbience(1);
      ambType = type;
      if (type === 'none') return;
      try {
        ambience = buildAmbience(ctx, type);
        ambience.output.connect(ambBus);
        const t = ctx.currentTime + 0.05;
        ambience.start(t);
        ambience.modulate(t, 3);
        ambBus.gain.cancelScheduledValues(t);
        ambBus.gain.setValueAtTime(ambBus.gain.value, t);
        ambBus.gain.setTargetAtTime(ambVolume, t, fadeSec / 3);
        clearInterval(modTimer);
        // 揺らぎの先行予約。バックグラウンドで間引かれても 3 秒先まで予約済み。
        modTimer = setInterval(() => { if (ambience && ctx.state === 'running') ambience.modulate(ctx.currentTime, 3); }, 500);
      } catch {
        ambience = null;
        ambType = 'none';
      }
    },

    /** 環境音を一時的に下げる（一時停止中など） */
    lowerAmbience(level = 0.15, fadeSec = 1.5) {
      if (ambBus && ambience) ambBus.gain.setTargetAtTime(ambVolume * level, ctx.currentTime, fadeSec / 3);
    },

    /** 出力先が変わったとき: すばやく環境音だけ消す */
    muteAmbienceNow() {
      if (ambBus) { ambBus.gain.cancelScheduledValues(ctx.currentTime); ambBus.gain.setTargetAtTime(0, ctx.currentTime, 0.05); }
    },

    stopAmbience(fadeSec = 6) {
      if (!ambience || !ctx) { ambType = 'none'; return; }
      const a = ambience;
      ambience = null;
      ambType = 'none';
      clearInterval(modTimer);
      const t = ctx.currentTime;
      ambBus.gain.cancelScheduledValues(t);
      ambBus.gain.setValueAtTime(ambBus.gain.value, t);
      ambBus.gain.setTargetAtTime(0, t, fadeSec / 4);
      a.stop(t + fadeSec + 0.5);
      setTimeout(() => { try { a.output.disconnect(); } catch { /* noop */ } }, (fadeSec + 1) * 1000);
    },

    get ambienceType() { return ambType; },
  };
}
