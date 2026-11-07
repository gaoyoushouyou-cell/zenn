// 座禅セッションの純粋なエンジン。DOM・音・保存には一切依存しない。
// 経過は「区間の積み上げ」で表す: elapsed = elapsedBefore + (running ? now - anchor : 0)
// setInterval の回数を数えないため、tick が間引かれてもドリフトしない。
//
// タイムライン（ミリ秒、セッション開始からの経過）:
//   0 ........ prepMs ............................ prepMs + durationMs
//   [ 準備 ]   ^開始の鐘   ^途中の鐘 ...            ^終わりの鐘
// durationMs が null のときは「終わりを決めない」座禅（終わりの鐘なし）。

export const PHASE = Object.freeze({ PREP: 'prep', SITTING: 'sitting', DONE: 'done' });
export const STATUS = Object.freeze({ RUNNING: 'running', PAUSED: 'paused', FINISHED: 'finished', ENDED: 'ended' });

/** 途中の鐘を鳴らさない「終わり際」の余白 */
export const INTERVAL_END_GUARD_MS = 30_000;
/** これ以上遅れた途中の鐘は鳴らさずに既読扱いにする（復帰直後に鐘が連打されないように） */
export const LATE_INTERVAL_TOLERANCE_MS = 5_000;
export const MAX_DURATION_MS = 4 * 60 * 60 * 1000; // 4時間
export const MAX_EXTEND_TOTAL_MS = 2 * 60 * 60 * 1000;

let idCounter = 0;
function makeId(wall) {
  idCounter = (idCounter + 1) % 1e6;
  return `s${wall.toString(36)}${idCounter.toString(36)}`;
}

export function createSession({ kind = 'zazen', durationMs, prepMs = 10_000, intervalMs = 0, mono, wall, id }) {
  if (durationMs !== null) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new RangeError('durationMs');
    durationMs = Math.min(durationMs, MAX_DURATION_MS);
  }
  prepMs = Math.max(0, Math.min(Number(prepMs) || 0, 120_000));
  intervalMs = Math.max(0, Number(intervalMs) || 0);
  if (intervalMs > 0 && intervalMs < 60_000) intervalMs = 60_000;
  return {
    v: 1,
    id: id || makeId(wall),
    kind,
    durationMs,
    baseDurationMs: durationMs,
    prepMs,
    intervalMs,
    status: STATUS.RUNNING,
    elapsedBefore: 0,
    anchor: mono,
    startedWall: wall,
    endedWall: null,
    pauseCount: 0,
    extendedMs: 0,
    fired: { start: false, end: false, intervals: [] },
  };
}

export function elapsed(s, mono) {
  if (s.status === STATUS.RUNNING) return s.elapsedBefore + Math.max(0, mono - s.anchor);
  return s.elapsedBefore;
}

export function totalMs(s) {
  return s.durationMs === null ? Infinity : s.prepMs + s.durationMs;
}

export function phase(s, mono) {
  if (s.status === STATUS.FINISHED || s.status === STATUS.ENDED) return PHASE.DONE;
  const e = elapsed(s, mono);
  if (e < s.prepMs) return PHASE.PREP;
  if (e >= totalMs(s)) return PHASE.DONE;
  return PHASE.SITTING;
}

/** 座っている時間（準備時間を除く） */
export function sittingElapsed(s, mono) {
  const e = Math.min(elapsed(s, mono), totalMs(s));
  return Math.max(0, e - s.prepMs);
}

/** 残り時間（終わりを決めない場合は null） */
export function remaining(s, mono) {
  if (s.durationMs === null) return null;
  return Math.max(0, totalMs(s) - elapsed(s, mono));
}

/** 座る時間の残り（準備時間を含めない）。準備中に聞かれても「10分の座禅で約11分」と言わないため */
export function sittingRemaining(s, mono) {
  const r = remaining(s, mono);
  if (r == null) return null;
  return Math.max(0, r - prepRemaining(s, mono));
}

export function prepRemaining(s, mono) {
  return Math.max(0, s.prepMs - elapsed(s, mono));
}

export function pause(s, mono) {
  if (s.status !== STATUS.RUNNING) return s;
  return { ...s, status: STATUS.PAUSED, elapsedBefore: elapsed(s, mono), anchor: mono, pauseCount: s.pauseCount + 1 };
}

export function resume(s, mono) {
  if (s.status !== STATUS.PAUSED) return s;
  return { ...s, status: STATUS.RUNNING, anchor: mono };
}

/** 延長。終了後でも余韻の間なら呼べるように、FINISHED からも再開できる。 */
export function extend(s, ms, mono) {
  if (s.durationMs === null || !(ms > 0)) return s;
  const allowed = Math.max(0, Math.min(ms, MAX_EXTEND_TOTAL_MS - s.extendedMs));
  if (allowed === 0) return s;
  let next = { ...s, durationMs: s.durationMs + allowed, extendedMs: s.extendedMs + allowed };
  if (s.status === STATUS.FINISHED) {
    // 終わった直後の延長: 終了時点から続ける
    next = { ...next, status: STATUS.RUNNING, anchor: mono, elapsedBefore: totalMs(s), endedWall: null,
      fired: { ...s.fired, end: false } };
  } else {
    next.fired = { ...s.fired, end: false };
  }
  return next;
}

/** 途中で終える（恥ではない。記録上は ended として区別するだけ） */
export function endEarly(s, mono, wall) {
  if (s.status === STATUS.FINISHED || s.status === STATUS.ENDED) return s;
  return { ...s, status: STATUS.ENDED, elapsedBefore: elapsed(s, mono), anchor: mono, endedWall: wall };
}

function intervalTimes(s) {
  if (!s.intervalMs) return [];
  const out = [];
  const end = s.durationMs === null ? Infinity : s.durationMs - INTERVAL_END_GUARD_MS;
  // 終わりを決めない場合は、表示上の上限として 4 時間まで
  const hardEnd = Math.min(end, MAX_DURATION_MS);
  for (let t = s.intervalMs, i = 0; t < hardEnd && i < 500; t += s.intervalMs, i++) out.push(t);
  return out;
}

/**
 * まだ処理していないイベントを返す。
 * 戻り値: [{ type: 'start'|'interval'|'end', index?, at, lateMs, silent }]
 *   silent=true は「遅すぎるので鳴らさず既読にする」もの。
 */
export function dueEvents(s, mono) {
  if (s.status === STATUS.ENDED) return [];
  const e = elapsed(s, mono);
  const out = [];
  if (!s.fired.start && e >= s.prepMs) {
    out.push({ type: 'start', at: s.prepMs, lateMs: e - s.prepMs, silent: e - s.prepMs > 60_000 });
  }
  const times = intervalTimes(s);
  for (let i = 0; i < times.length; i++) {
    const at = s.prepMs + times[i];
    if (e >= at && !s.fired.intervals.includes(i)) {
      out.push({ type: 'interval', index: i, at, lateMs: e - at, silent: e - at > LATE_INTERVAL_TOLERANCE_MS });
    }
  }
  if (!s.fired.end && s.durationMs !== null && e >= totalMs(s)) {
    out.push({ type: 'end', at: totalMs(s), lateMs: e - totalMs(s), silent: e - totalMs(s) > 5 * 60_000 });
  }
  return out;
}

/** 将来のイベント（音の先行予約用）。経過からの相対ミリ秒で返す。 */
export function upcomingEvents(s, mono) {
  if (s.status !== STATUS.RUNNING) return [];
  const e = elapsed(s, mono);
  const out = [];
  if (!s.fired.start && e < s.prepMs) out.push({ type: 'start', inMs: s.prepMs - e });
  intervalTimes(s).forEach((t, i) => {
    const at = s.prepMs + t;
    if (at > e && !s.fired.intervals.includes(i)) out.push({ type: 'interval', index: i, inMs: at - e });
  });
  if (s.durationMs !== null && !s.fired.end && totalMs(s) > e) out.push({ type: 'end', inMs: totalMs(s) - e });
  return out;
}

export function markFired(s, ev, mono, wall) {
  const fired = { ...s.fired, intervals: [...s.fired.intervals] };
  let next = { ...s, fired };
  if (ev.type === 'start') fired.start = true;
  else if (ev.type === 'interval') { if (!fired.intervals.includes(ev.index)) fired.intervals.push(ev.index); }
  else if (ev.type === 'end') {
    fired.end = true;
    // 終了: 経過を総時間にそろえて止める
    next = { ...next, status: STATUS.FINISHED, elapsedBefore: totalMs(s), anchor: mono, endedWall: wall };
  }
  return next;
}

/** 保存用。単調時計は再読み込みで失われるため、壁時計でチェックポイントを残す。 */
export function serialize(s, mono, wall) {
  return {
    ...s,
    elapsedBefore: elapsed(s, mono),
    checkpointWall: wall,
    anchor: 0,
  };
}

/**
 * 再読み込み後の復元。
 * running だった場合、閉じていた間の時間（壁時計の差分）を経過に加える。
 * 端末時刻が過去へ戻されていた場合は 0 とみなす（負の経過を作らない）。
 */
export function restore(obj, mono, wall) {
  if (!obj || obj.v !== 1 || typeof obj.elapsedBefore !== 'number') return null;
  const s = { ...obj, fired: { start: !!obj.fired?.start, end: !!obj.fired?.end, intervals: Array.isArray(obj.fired?.intervals) ? obj.fired.intervals.filter(Number.isInteger) : [] } };
  let away = 0;
  if (s.status === STATUS.RUNNING && typeof obj.checkpointWall === 'number') {
    away = Math.max(0, Math.min(wall - obj.checkpointWall, 7 * 24 * 3600_000));
  }
  delete s.checkpointWall;
  s.elapsedBefore = obj.elapsedBefore + away;
  s.anchor = mono;
  return s;
}

/** 記録に残す要約 */
export function summarize(s, mono) {
  return {
    id: s.id,
    kind: s.kind,
    startedAt: s.startedWall,
    plannedMs: s.baseDurationMs,
    sitMs: Math.round(sittingElapsed(s, mono)),
    completed: s.status === STATUS.FINISHED,
    extendedMs: s.extendedMs,
  };
}
