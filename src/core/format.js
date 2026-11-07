// 時間表示。秒単位のカウントダウンは不安を生みやすいので、既定は「約◯分」。

export function approxMinutes(ms) {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** 'hidden' | 'approx' | 'exact' に応じた残り時間の表示用データ */
export function remainingView(ms, mode) {
  if (ms == null || mode === 'hidden') return null;
  if (mode === 'exact') {
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return { kind: 'exact', text: (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}` };
  }
  if (ms <= 60_000) return { kind: 'soon' };
  return { kind: 'approx', minutes: approxMinutes(ms) };
}

export function minutesOf(ms) {
  return Math.round(ms / 60_000);
}

/** 記録表示用。1分未満は「1分未満」 */
export function sitLabelMinutes(ms) {
  return ms < 60_000 ? 0 : Math.round(ms / 60_000);
}
