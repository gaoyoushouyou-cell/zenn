// 座った記録。連続日数（ストリーク）は意図的に計算しない。
// 代わりに「累積」と「最近のリズム」だけを、評価を伴わない形で返す。

export const TAGS = ['calm', 'scattered', 'sleepy', 'pain', 'nothing'];
export const MAX_ENTRIES = 3000;
export const MAX_NOTE = 2000;
const DAY = 86_400_000;

export function makeEntry(summary, { tags = [], note = '' } = {}) {
  return {
    id: String(summary.id),
    kind: ['zazen', 'guided', 'kinhin'].includes(summary.kind) ? summary.kind : 'zazen',
    startedAt: Number(summary.startedAt) || 0,
    plannedMs: summary.plannedMs == null ? null : Number(summary.plannedMs),
    sitMs: Math.max(0, Number(summary.sitMs) || 0),
    completed: !!summary.completed,
    extendedMs: Math.max(0, Number(summary.extendedMs) || 0),
    tags: tags.filter((t) => TAGS.includes(t)),
    note: String(note || '').slice(0, MAX_NOTE),
  };
}

export function validateList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object' && e.id != null && Number.isFinite(Number(e.startedAt)))
    .map((e) => makeEntry(e, { tags: Array.isArray(e.tags) ? e.tags : [], note: e.note }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_ENTRIES);
}

export function add(list, entry) {
  const without = list.filter((e) => e.id !== entry.id);
  return [entry, ...without].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_ENTRIES);
}

export function remove(list, id) {
  return list.filter((e) => e.id !== id);
}

/** 一定期間より古い記録を手放す（無常）。days=0 なら何もしない。 */
export function forget(list, days, now) {
  if (!days) return list;
  const limit = now - days * DAY;
  return list.filter((e) => e.startedAt >= limit);
}

/** 記録の「薄れ」0..1（新しいほど 1）。表示で透明度に使う。 */
export function freshness(entry, now, horizonDays = 120) {
  const age = Math.max(0, now - entry.startedAt) / DAY;
  return Math.max(0.25, 1 - age / horizonDays);
}

function dayKey(ts, tzOffsetMin) {
  return Math.floor((ts - tzOffsetMin * 60_000) / DAY);
}

/**
 * 最近 n 日のリズム。各日の座った分数を返す（休んだ日は 0。失敗ではない）。
 * tzOffsetMin は Date#getTimezoneOffset() の値（日本なら -540）。
 */
export function rhythm(list, now, n = 28, tzOffsetMin = new Date(now).getTimezoneOffset()) {
  const today = dayKey(now, tzOffsetMin);
  const days = Array.from({ length: n }, (_, i) => ({ offset: n - 1 - i, minutes: 0 }));
  for (const e of list) {
    const d = today - dayKey(e.startedAt, tzOffsetMin);
    if (d >= 0 && d < n) days[n - 1 - d].minutes += e.sitMs / 60_000;
  }
  return days;
}

export function totals(list) {
  let ms = 0;
  for (const e of list) ms += e.sitMs;
  return { count: list.length, minutes: Math.round(ms / 60_000) };
}

/** 久しぶりに戻ってきたか（3日以上空いた）。責める文脈では使わない。 */
export function isReturning(list, now, gapDays = 3) {
  if (!list.length) return false;
  return now - list[0].startedAt >= gapDays * DAY;
}

export function exportJSON(list, settings, now) {
  return JSON.stringify({ app: 'shizuka-zazen', format: 1, exportedAt: new Date(now).toISOString(), settings, history: list }, null, 2);
}
