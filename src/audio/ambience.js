// 生成的な環境音。短いループを感じさせないように、
// - 長さの違う（互いに素に近い）ノイズバッファを重ねる
// - フィルタや音量を不規則にゆっくり動かす（周期の決まった LFO を使わない）
// - 雨粒などの粒は毎回ランダムに配置する
// どの環境音も同じ AudioContext / OfflineAudioContext 上に組めるため、
// テストで実際にレンダリングして音量（RMS）を測れる。

import { mulberry32 } from './bell.js';

// 種類ごとの音量補正（tests/unit/audio.test.js で RMS を実測し、-30dBFS 付近にそろえている）
export const LEVEL = { rain: 0.44, wind: 0.71, waves: 0.39, stream: 0.68 };

const bufferCache = new WeakMap();

function noiseBuffers(ctx) {
  let c = bufferCache.get(ctx);
  if (c) return c;
  const sr = ctx.sampleRate;
  const rand = mulberry32(1234);
  const make = (seconds, color) => {
    const n = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      // Paul Kellet の pink フィルタ / brown は積分
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (let i = 0; i < n; i++) {
        const w = rand() * 2 - 1;
        if (color === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      }
      // ループ継ぎ目のクリックを防ぐため、端を短くクロスフェード
      const xf = Math.floor(sr * 0.05);
      for (let i = 0; i < xf; i++) {
        const g = i / xf;
        d[i] = d[i] * g + d[n - xf + i] * (1 - g);
      }
    }
    return buf;
  };
  c = {
    pinkA: make(9.7, 'pink'),
    pinkB: make(13.3, 'pink'),
    brownA: make(11.1, 'brown'),
    brownB: make(17.9, 'brown'),
  };
  bufferCache.set(ctx, c);
  return c;
}

function loopSource(ctx, buffer, offset = 0) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  // 最後の 0.05 秒（クロスフェード済み区間）を飛ばしてループさせる
  s.loopStart = 0;
  s.loopEnd = buffer.duration - 0.05;
  s.__offset = offset % s.loopEnd;
  return s;
}

/**
 * 環境音を組み立てる。
 * @returns {{ output: GainNode, start(t:number), stop(t:number), modulate(now:number, horizon:number) }}
 */
export function buildAmbience(ctx, type, seed = Date.now() & 0xffff) {
  const rand = mulberry32(seed);
  const nb = noiseBuffers(ctx);
  const out = ctx.createGain();
  out.gain.value = LEVEL[type] ?? 1;
  const sources = [];
  const mods = []; // (t, horizon) => void
  const r = (a, b) => a + (b - a) * rand();

  function chain(buffer, nodes, gainValue) {
    const src = loopSource(ctx, buffer, r(0, buffer.duration));
    const g = ctx.createGain();
    g.gain.value = gainValue;
    let prev = src;
    for (const n of nodes) { prev.connect(n); prev = n; }
    prev.connect(g);
    g.connect(out);
    sources.push(src);
    return g;
  }
  const filter = (kind, freq, q = 0.7) => {
    const f = ctx.createBiquadFilter();
    f.type = kind; f.frequency.value = freq; f.Q.value = q;
    return f;
  };

  // 不規則な揺らぎ: 次の目標値まで、ランダムな時間をかけて近づく
  function wander(param, min, max, minDur, maxDur) {
    let nextAt = 0;
    mods.push((t, horizon) => {
      while (nextAt < t + horizon) {
        const start = Math.max(nextAt, t);
        const dur = r(minDur, maxDur);
        param.setTargetAtTime(r(min, max), start, dur / 3);
        nextAt = start + dur;
      }
    });
  }

  switch (type) {
    case 'rain': {
      const hp = filter('highpass', 450);
      const lp = filter('lowpass', 6500);
      const bed = chain(nb.pinkA, [hp, lp], 0.5);
      const bp = filter('bandpass', 2600, 0.6);
      const patter = chain(nb.pinkB, [bp], 0.35);
      wander(bed.gain, 0.38, 0.6, 3, 9);
      wander(patter.gain, 0.2, 0.42, 2, 6);
      wander(lp.frequency, 4500, 7500, 4, 12);
      // 雨粒: ごく短いノイズの粒をランダムに
      const dropBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
      const dd = dropBuf.getChannelData(0);
      for (let i = 0; i < dd.length; i++) dd[i] = (rand() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.004));
      let nextDrop = 0;
      mods.push((t, horizon) => {
        if (nextDrop < t) nextDrop = t;
        while (nextDrop < t + horizon) {
          const s = ctx.createBufferSource();
          s.buffer = dropBuf;
          s.playbackRate.value = r(0.5, 1.6);
          const g = ctx.createGain();
          g.gain.value = r(0.02, 0.09);
          const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
          if (p) { p.pan.value = r(-0.9, 0.9); s.connect(g); g.connect(p); p.connect(out); }
          else { s.connect(g); g.connect(out); }
          s.start(nextDrop);
          nextDrop += r(0.03, 0.22);
        }
      });
      break;
    }
    case 'wind': {
      const bp1 = filter('bandpass', 400, 0.8);
      const g1 = chain(nb.brownA, [bp1], 0.7);
      const bp2 = filter('bandpass', 900, 1.4);
      const g2 = chain(nb.pinkA, [bp2], 0.12);
      wander(bp1.frequency, 220, 700, 5, 14);
      wander(bp1.Q, 0.5, 1.4, 6, 15);
      wander(g1.gain, 0.25, 0.95, 6, 16);
      wander(bp2.frequency, 600, 1400, 4, 11);
      wander(g2.gain, 0.0, 0.14, 5, 13);
      break;
    }
    case 'waves': {
      const lp = filter('lowpass', 500, 0.5);
      const body = chain(nb.brownB, [lp], 0.0);
      const hp = filter('highpass', 1400);
      const foam = chain(nb.pinkB, [hp], 0.0);
      // 一つひとつの波: 寄せる → 引く。周期は毎回変わる。
      let nextWave = 0;
      mods.push((t, horizon) => {
        if (nextWave < t) nextWave = t;
        while (nextWave < t + horizon) {
          const rise = r(2.5, 4.5);
          const fall = r(4, 7.5);
          const peak = r(0.55, 1.0);
          const w0 = nextWave;
          body.gain.setTargetAtTime(peak, w0, rise / 3);
          lp.frequency.setTargetAtTime(r(900, 1600), w0, rise / 3);
          foam.gain.setTargetAtTime(peak * r(0.12, 0.28), w0 + rise * 0.7, 0.6);
          body.gain.setTargetAtTime(r(0.08, 0.2), w0 + rise, fall / 3);
          lp.frequency.setTargetAtTime(r(300, 500), w0 + rise, fall / 3);
          foam.gain.setTargetAtTime(0.0, w0 + rise + 0.6, fall / 4);
          nextWave = w0 + rise + fall + r(-0.8, 1.5);
        }
      });
      break;
    }
    case 'stream': {
      const bp1 = filter('bandpass', 1700, 0.9);
      const g1 = chain(nb.pinkA, [bp1], 0.5);
      const bp2 = filter('bandpass', 650, 0.8);
      const g2 = chain(nb.pinkB, [bp2], 0.45);
      const bp3 = filter('bandpass', 3800, 2.5);
      const g3 = chain(nb.pinkB, [bp3], 0.1);
      wander(g1.gain, 0.32, 0.6, 0.15, 0.6);
      wander(bp1.frequency, 1400, 2200, 0.2, 0.9);
      wander(g2.gain, 0.35, 0.55, 1.5, 5);
      wander(g3.gain, 0.03, 0.14, 0.1, 0.4);
      break;
    }
    default:
      break;
  }

  return {
    output: out,
    start(t) { for (const s of sources) s.start(t, s.__offset || 0); },
    stop(t) { for (const s of sources) { try { s.stop(t); } catch { /* 既に停止 */ } } },
    modulate(t, horizon = 2) { for (const m of mods) m(t, horizon); },
  };
}
