// 鐘（鏧・鈴）の合成。録音素材を使わず、加算合成で波形を直接計算する。
// - 非整数倍音（鉢形の金属体に特有）
// - 各倍音を左右でわずかにずらし、ゆっくりした「うなり」を作る
// - 倍音ごとに異なる減衰（高い音ほど早く消える）
// - 撞木が当たる瞬間の柔らかいノイズ
// - 頭と尻に短いフェードを入れてクリックを消す
// 純粋関数なので、AudioContext がなくてもテストできる。

export const TONES = {
  // 低く長い鏧（けい）。おおよそ E3 付近。
  kei: {
    f0: 164.8,
    partials: [
      { r: 1.0, a: 1.0, t60: 15, beat: 0.62, pan: -0.1 },
      { r: 2.71, a: 0.55, t60: 9, beat: 1.21, pan: 0.15 },
      { r: 5.18, a: 0.3, t60: 5, beat: 2.05, pan: -0.2 },
      { r: 8.42, a: 0.14, t60: 2.8, beat: 2.9, pan: 0.25 },
      { r: 12.3, a: 0.06, t60: 1.5, beat: 3.6, pan: -0.15 },
    ],
    strike: { level: 0.12, decay: 0.006, tone: 0.55 },
    seconds: 16,
  },
  // 高く澄んだ鈴（りん）
  rin: {
    f0: 659.3,
    partials: [
      { r: 1.0, a: 1.0, t60: 8, beat: 1.05, pan: 0.05 },
      { r: 2.74, a: 0.42, t60: 3.8, beat: 2.1, pan: -0.2 },
      { r: 5.4, a: 0.18, t60: 1.9, beat: 3.0, pan: 0.2 },
      { r: 8.93, a: 0.07, t60: 1.0, beat: 4.1, pan: -0.1 },
    ],
    strike: { level: 0.08, decay: 0.004, tone: 0.75 },
    seconds: 10,
  },
};

/** 決定的な疑似乱数（同じ鐘は毎回同じ音になる） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @returns {{ left: Float32Array, right: Float32Array, sampleRate: number }}
 * velocity: 0..1 撞く強さ。弱いほど高い倍音が少ない（柔らかい）。
 */
export function renderBell({ tone = 'kei', sampleRate = 32000, velocity = 1, seed = 7 } = {}) {
  const spec = TONES[tone] || TONES.kei;
  const n = Math.floor(spec.seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rand = mulberry32(seed);
  const v = Math.max(0.05, Math.min(1, velocity));
  const nyquist = sampleRate / 2;

  for (let p = 0; p < spec.partials.length; p++) {
    const pt = spec.partials[p];
    const freq = spec.f0 * pt.r;
    if (freq > nyquist * 0.9) continue;
    // 弱く撞くと高次倍音が小さくなる
    const amp = pt.a * Math.pow(v, 1 + p * 0.35);
    const k = 6.907755 / pt.t60; // ln(1000) / T60
    const decayPerSample = Math.exp(-k / sampleRate);
    const gl = amp * Math.sqrt(0.5 * (1 - pt.pan));
    const gr = amp * Math.sqrt(0.5 * (1 + pt.pan));
    // 左右で ±beat/2 ずらした 2 本ずつ。位相は回転フェーザで計算（sin を毎サンプル呼ばない）
    const oscs = [
      { f: freq + pt.beat * 0.5, g: gl * 0.6, ch: left },
      { f: freq - pt.beat * 0.5, g: gl * 0.4, ch: left },
      { f: freq - pt.beat * 0.45, g: gr * 0.6, ch: right },
      { f: freq + pt.beat * 0.55, g: gr * 0.4, ch: right },
    ];
    for (const o of oscs) {
      const w = (2 * Math.PI * o.f) / sampleRate;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const ph = rand() * 2 * Math.PI;
      let re = Math.cos(ph);
      let im = Math.sin(ph);
      let env = o.g;
      const ch = o.ch;
      for (let i = 0; i < n; i++) {
        ch[i] += im * env;
        const nre = re * cw - im * sw;
        im = re * sw + im * cw;
        re = nre;
        env *= decayPerSample;
        if ((i & 4095) === 0) {
          // 数値誤差で振幅がずれないよう正規化
          const mag = Math.hypot(re, im);
          re /= mag; im /= mag;
        }
        if (env < 1e-6) break;
      }
    }
  }

  // 撞木の当たり: 短い減衰ノイズを 1 次フィルタで丸める
  const st = spec.strike;
  const sLen = Math.min(n, Math.floor(sampleRate * st.decay * 8));
  let lpL = 0, lpR = 0;
  const alpha = st.tone;
  for (let i = 0; i < sLen; i++) {
    const e = Math.exp(-i / (sampleRate * st.decay)) * st.level * v;
    lpL += alpha * ((rand() * 2 - 1) - lpL);
    lpR += alpha * ((rand() * 2 - 1) - lpR);
    left[i] += lpL * e;
    right[i] += lpR * e;
  }

  // アタック（柔らかい撞木）と終端フェード
  const atk = Math.floor(sampleRate * (0.002 + (1 - v) * 0.004));
  for (let i = 0; i < atk; i++) {
    const g = i / atk;
    left[i] *= g; right[i] *= g;
  }
  const tail = Math.floor(sampleRate * 0.4);
  for (let i = 0; i < tail; i++) {
    const g = i / tail;
    left[n - 1 - i] *= g; right[n - 1 - i] *= g;
  }

  // ピーク正規化（-1 dBFS 付近）。velocity による大小は残す。
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(left[i]); const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const ref = referencePeak(spec);
  const norm = peak > 0 ? 0.89 / ref : 1;
  for (let i = 0; i < n; i++) { left[i] *= norm; right[i] *= norm; }
  return { left, right, sampleRate };
}

// 強さ 1 のときのおおよそのピーク（倍音振幅の和）。velocity の差を正規化で消さないため。
function referencePeak(spec) {
  return spec.partials.reduce((s, p) => s + p.a, 0) * 0.75 + spec.strike.level;
}

/**
 * 鐘の打ち方。offset 秒と強さ。
 * traditional: 始め三つ（止静鐘）・途中一つ・終わり一つ（放禅鐘）。経行の始めは二つ。
 */
export function bellPattern(kind, style, sessionKind = 'zazen') {
  if (style === 'simple') {
    if (kind === 'interval') return [{ at: 0, v: 0.55 }];
    return [{ at: 0, v: kind === 'start' ? 0.75 : 0.85 }];
  }
  switch (kind) {
    case 'start':
      if (sessionKind === 'kinhin') return [{ at: 0, v: 0.8 }, { at: 4.2, v: 0.7 }];
      return [{ at: 0, v: 0.8 }, { at: 4.6, v: 0.72 }, { at: 8.6, v: 0.66 }];
    case 'interval':
      return [{ at: 0, v: 0.5 }];
    case 'end':
      return [{ at: 0, v: 0.85 }];
    case 'test':
    default:
      return [{ at: 0, v: 0.75 }];
  }
}
