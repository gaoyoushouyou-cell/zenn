// 時計の抽象化。
// セッションは「単調増加時計（performance.now）」で経過を数え、
// 「壁時計（Date.now）」は記録の日時とページ再読み込み時の復元にだけ使う。
//
// 端末スリープ中に performance.now() が止まる環境がある（一部の macOS / Safari）。
// そのため tick ごとに壁時計の進みと比較し、壁時計だけが 2 秒以上先へ進んでいたら
// その差を補う。壁時計が後ろへ戻った（時刻変更）場合は無視する。
// これにより「端末時刻を過去へ変更してもセッションが伸び縮みしない」「スリープ後も正しく終わる」。

export const SUSPEND_GAP_MS = 2000; // これ以上 tick が空いたら停止していたとみなす
export const MAX_SLEEP_CORRECTION_MS = 24 * 60 * 60 * 1000;

/** 実ブラウザ用の時計 */
export function systemClock() {
  return {
    mono: () => performance.now(),
    wall: () => Date.now(),
  };
}

/** テスト用の仮想時計。advance(ms) で進める。 */
export function fakeClock(startWall = Date.UTC(2026, 10, 7, 6, 0, 0)) {
  let mono = 1000;
  let wall = startWall;
  return {
    mono: () => mono,
    wall: () => wall,
    advance(ms) { mono += ms; wall += ms; },
    /** スリープを模倣: 壁時計だけが進み、単調時計は止まる環境 */
    sleepFrozen(ms) { wall += ms; },
    /** スリープを模倣: 両方進む環境 */
    sleepRunning(ms) { mono += ms; wall += ms; },
    /** ユーザーが端末時刻を変更 */
    setWall(w) { wall = w; },
  };
}

/**
 * 補正済み単調時刻を返す時計を作る。
 * read() を tick ごとに呼ぶこと（呼ばれた間隔で停止を検知する）。
 */
export function correctedClock(base) {
  let offset = 0;
  let lastMono = base.mono();
  let lastWall = base.wall();
  return {
    read() {
      const m = base.mono();
      const w = base.wall();
      const dm = m - lastMono;
      const dw = w - lastWall;
      // 壁時計が単調時計より大きく前へ進んだ = 単調時計がスリープ中に凍っていた。
      // （前進の時刻変更とは区別できないが、epoch は夏時間やタイムゾーンでは動かないため、
      //   実用上は「スリープ補正」を優先する。後退方向の変更は常に無視する。）
      if (dw - dm >= SUSPEND_GAP_MS && dw <= MAX_SLEEP_CORRECTION_MS) {
        offset += dw - dm;
      }
      lastMono = m;
      lastWall = w;
      return m + offset;
    },
    wall: () => base.wall(),
    get offset() { return offset; },
  };
}
