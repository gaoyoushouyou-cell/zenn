// 設定のスキーマ・既定値・検証。保存データが壊れていても必ず安全な値に戻す。

export const SCHEMA = {
  durationMin: { type: 'number', def: 10, min: 1, max: 240 },
  openEnded: { type: 'bool', def: false },
  prepSec: { type: 'enum', def: 10, values: [0, 5, 10, 20, 30, 60] },
  intervalMin: { type: 'enum', def: 0, values: [0, 5, 10, 15, 20, 30] },
  afterglowSec: { type: 'enum', def: 20, values: [5, 10, 20, 40, 60] },
  bells: { type: 'bool', def: true }, // false = 無音（鐘も鳴らさない。振動・画面・通知で終わりを知らせる）
  bellStyle: { type: 'enum', def: 'traditional', values: ['traditional', 'simple'] },
  bellTone: { type: 'enum', def: 'kei', values: ['kei', 'rin'] },
  bellVolume: { type: 'number', def: 0.6, min: 0, max: 1 },
  ambience: { type: 'enum', def: 'none', values: ['none', 'rain', 'wind', 'waves', 'stream'] },
  ambienceVolume: { type: 'number', def: 0.5, min: 0, max: 1 },
  scene: { type: 'enum', def: 'auto', values: ['auto', 'night', 'dawn', 'rain', 'snow', 'dark'] },
  quiet: { type: 'bool', def: false }, // 静寂モード: 景色・環境音・残り時間・案内をすべて消す
  remaining: { type: 'enum', def: 'hidden', values: ['hidden', 'approx', 'exact'] },
  captions: { type: 'bool', def: true }, // 案内付きセッションの字幕
  speech: { type: 'bool', def: false }, // 案内の読み上げ（端末内の音声合成）
  theme: { type: 'enum', def: 'auto', values: ['auto', 'dark', 'light'] },
  textScale: { type: 'enum', def: 1, values: [1, 1.25, 1.5, 2] },
  contrast: { type: 'enum', def: 'auto', values: ['auto', 'more', 'normal'] },
  motion: { type: 'enum', def: 'auto', values: ['auto', 'reduce', 'full'] },
  power: { type: 'enum', def: 'auto', values: ['auto', 'low', 'high'] },
  wakeLock: { type: 'bool', def: true },
  vibrate: { type: 'enum', def: 'end', values: ['off', 'end', 'both'] },
  notifyEnd: { type: 'bool', def: false },
  lang: { type: 'enum', def: 'auto', values: ['auto', 'ja', 'en'] },
  forgetDays: { type: 'enum', def: 0, values: [0, 30, 90, 365] }, // 0 = 手放さない
  kinhinMin: { type: 'enum', def: 10, values: [5, 10, 15, 20] },
};

export function defaults() {
  const out = {};
  for (const [k, spec] of Object.entries(SCHEMA)) out[k] = spec.def;
  return out;
}

function coerce(spec, value) {
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean' ? value : spec.def;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return spec.def;
      return Math.min(spec.max, Math.max(spec.min, n));
    }
    case 'enum':
      return spec.values.includes(value) ? value : spec.def;
    default:
      return spec.def;
  }
}

/** 未知のキーは捨て、型が合わない値は既定値に戻す */
export function validate(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, spec] of Object.entries(SCHEMA)) {
    if (k in raw) out[k] = coerce(spec, raw[k]);
  }
  out.durationMin = Math.round(out.durationMin);
  return out;
}

export function update(settings, patch) {
  return validate({ ...settings, ...patch });
}

/** 静寂モードを考慮した「実際に使う」値 */
export function effective(settings) {
  if (!settings.quiet) return settings;
  return { ...settings, ambience: 'none', scene: 'dark', remaining: 'hidden', captions: false, speech: false };
}
