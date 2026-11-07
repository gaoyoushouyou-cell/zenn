import { test, assert, setFile } from '../harness.js';
import * as S from '../../src/core/session.js';
import { fakeClock, correctedClock } from '../../src/core/clock.js';
import * as Settings from '../../src/core/settings.js';
import { createStorage, memoryBackend } from '../../src/core/storage.js';
import * as History from '../../src/core/history.js';
import { remainingView } from '../../src/core/format.js';
import { ja, en } from '../../src/i18n/strings.js';
import { moonPhase, timeOfDay } from '../../src/visual/scene.js';

const MIN = 60_000;
setFile('unit/core');

// ── 時計 ───────────────────────────────────
test('補正時計: 通常の進み', () => {
  const fc = fakeClock();
  const c = correctedClock(fc);
  const a = c.read();
  fc.advance(250);
  assert.equal(c.read() - a, 250);
});

test('補正時計: 単調時計が凍るスリープでも壁時計の分だけ進む', () => {
  const fc = fakeClock();
  const c = correctedClock(fc);
  const a = c.read();
  fc.sleepFrozen(10 * MIN);
  fc.advance(250);
  assert.approx(c.read() - a, 10 * MIN + 250, 1);
});

test('補正時計: 両方進むスリープでは二重に足さない', () => {
  const fc = fakeClock();
  const c = correctedClock(fc);
  const a = c.read();
  fc.sleepRunning(10 * MIN);
  assert.equal(c.read() - a, 10 * MIN);
});

test('補正時計: 端末時刻を過去に戻しても経過は戻らない', () => {
  const fc = fakeClock();
  const c = correctedClock(fc);
  const a = c.read();
  fc.setWall(fc.wall() - 3600_000);
  fc.advance(250);
  assert.equal(c.read() - a, 250);
});

// ── セッション ─────────────────────────────
function mk(opts = {}) {
  return S.createSession({ durationMs: 10 * MIN, prepMs: 10_000, mono: 0, wall: 0, ...opts });
}

test('セッション: 準備 → 座る → 終わり の相', () => {
  const s = mk();
  assert.equal(S.phase(s, 0), 'prep');
  assert.equal(S.phase(s, 9_999), 'prep');
  assert.equal(S.phase(s, 10_000), 'sitting');
  assert.equal(S.phase(s, 10_000 + 10 * MIN), 'done');
});

test('セッション: 残り時間は基準時刻からの差分（tick 数に依存しない）', () => {
  const s = mk();
  assert.equal(S.remaining(s, 0), 10 * MIN + 10_000);
  assert.equal(S.remaining(s, 5 * MIN), 5 * MIN + 10_000);
  // tick を一度も呼ばずに 1 時間後を見ても破綻しない
  assert.equal(S.remaining(s, 60 * MIN), 0);
});

test('セッション: 座る時間の残りは準備時間を含めない', () => {
  const s = mk();
  assert.equal(S.sittingRemaining(s, 0), 10 * MIN);
  assert.equal(S.sittingRemaining(s, 5_000), 10 * MIN);
  assert.equal(S.sittingRemaining(s, 10_000 + 3 * MIN), 7 * MIN);
  assert.equal(S.sittingRemaining(mk({ durationMs: null }), 0), null);
});

test('セッション: 一時停止中は進まない', () => {
  let s = mk();
  s = S.pause(s, 2 * MIN);
  assert.equal(S.elapsed(s, 30 * MIN), 2 * MIN);
  s = S.resume(s, 30 * MIN);
  assert.equal(S.elapsed(s, 31 * MIN), 3 * MIN);
  assert.equal(s.pauseCount, 1);
});

test('セッション: 延長で終わりが伸び、終わった直後からも延長できる', () => {
  let s = mk();
  s = S.extend(s, 5 * MIN, 1 * MIN);
  assert.equal(S.totalMs(s), 10_000 + 15 * MIN);
  // 終了させてから延長
  let f = mk();
  const end = S.dueEvents(f, 10_000 + 10 * MIN).find((e) => e.type === 'end');
  f = S.markFired(f, end, 10_000 + 10 * MIN, 0);
  assert.equal(f.status, 'finished');
  f = S.extend(f, 5 * MIN, 10_000 + 10 * MIN + 2000);
  assert.equal(f.status, 'running');
  assert.equal(S.remaining(f, 10_000 + 10 * MIN + 2000), 5 * MIN);
  assert.equal(f.fired.end, false);
});

test('セッション: 延長は合計 2 時間まで', () => {
  let s = mk();
  for (let i = 0; i < 40; i++) s = S.extend(s, 5 * MIN, 0);
  assert.equal(s.extendedMs, S.MAX_EXTEND_TOTAL_MS);
});

test('セッション: 開始・途中・終わりのイベントが一度ずつ', () => {
  let s = mk({ durationMs: 20 * MIN, intervalMs: 5 * MIN });
  const fired = [];
  for (let t = 0; t <= 10_000 + 21 * MIN; t += 1000) {
    for (const ev of S.dueEvents(s, t)) { fired.push(ev.type); s = S.markFired(s, ev, t, t); }
  }
  assert.deepEqual(fired, ['start', 'interval', 'interval', 'interval', 'end']);
});

test('セッション: 途中の鐘は終わり 30 秒前以内には鳴らさない', () => {
  const s = mk({ durationMs: 10 * MIN, intervalMs: 5 * MIN });
  const ups = S.upcomingEvents(s, 0).map((e) => e.type);
  assert.deepEqual(ups, ['start', 'interval', 'end']);
});

test('セッション: 長く止まったあとは、遅れた途中の鐘を鳴らさない', () => {
  let s = mk({ durationMs: 30 * MIN, intervalMs: 5 * MIN });
  s = S.markFired(s, { type: 'start' }, 10_000, 0);
  const evs = S.dueEvents(s, 10_000 + 17 * MIN);
  const intervals = evs.filter((e) => e.type === 'interval');
  assert.equal(intervals.length, 3);
  assert.ok(intervals.every((e) => e.silent), 'all late intervals are silent');
});

test('セッション: 終わりを決めない座禅には終わりがない', () => {
  const s = mk({ durationMs: null });
  assert.equal(S.remaining(s, 5 * 3600_000), null);
  assert.equal(S.phase(s, 5 * 3600_000), 'sitting');
  assert.ok(!S.dueEvents(s, 5 * 3600_000).some((e) => e.type === 'end'));
});

test('セッション: 途中で終える', () => {
  let s = mk();
  s = S.endEarly(s, 3 * MIN, 123);
  assert.equal(s.status, 'ended');
  assert.equal(S.phase(s, 4 * MIN), 'done');
  const sum = S.summarize(s, 4 * MIN);
  assert.equal(sum.completed, false);
  assert.equal(sum.sitMs, 3 * MIN - 10_000);
});

test('セッション: 保存と復元（閉じていた時間を加算）', () => {
  const s = mk();
  const saved = S.serialize(s, 2 * MIN, 1_000_000);
  const r = S.restore(JSON.parse(JSON.stringify(saved)), 500, 1_000_000 + 3 * MIN);
  assert.equal(S.elapsed(r, 500), 5 * MIN);
});

test('セッション: 復元時に端末時刻が過去なら負の経過を作らない', () => {
  const s = mk();
  const saved = S.serialize(s, 2 * MIN, 1_000_000);
  const r = S.restore(saved, 0, 1_000_000 - 3600_000);
  assert.equal(S.elapsed(r, 0), 2 * MIN);
});

test('セッション: 一時停止中に保存したものは時間が進まない', () => {
  let s = mk();
  s = S.pause(s, 2 * MIN);
  const r = S.restore(S.serialize(s, 9 * MIN, 0), 0, 3600_000);
  assert.equal(S.elapsed(r, 99), 2 * MIN);
});

test('セッション: 壊れた保存データは null', () => {
  assert.equal(S.restore(null, 0, 0), null);
  assert.equal(S.restore({ v: 99 }, 0, 0), null);
  assert.equal(S.restore({ v: 1, elapsedBefore: 'x' }, 0, 0), null);
});

test('セッション: 不正な時間は拒否・上限で丸める', () => {
  assert.throws(() => S.createSession({ durationMs: -1, mono: 0, wall: 0 }));
  const s = S.createSession({ durationMs: 99 * 3600_000, mono: 0, wall: 0, intervalMs: 10 });
  assert.equal(s.durationMs, S.MAX_DURATION_MS);
  assert.equal(s.intervalMs, 60_000);
});

// ── 設定 ───────────────────────────────────
test('設定: 壊れた値は既定値に戻す', () => {
  const s = Settings.validate({ durationMin: 'abc', prepSec: 7, bellVolume: 9, scene: 'mars', unknown: 1, quiet: 'yes' });
  assert.equal(s.durationMin, 10);
  assert.equal(s.prepSec, 10);
  assert.equal(s.bellVolume, 1);
  assert.equal(s.scene, 'auto');
  assert.equal(s.quiet, false);
  assert.ok(!('unknown' in s));
});

test('設定: 静寂モードは景色・環境音・残り時間・案内を消す', () => {
  const e = Settings.effective(Settings.update(Settings.defaults(), { quiet: true, ambience: 'rain', remaining: 'exact' }));
  assert.equal(e.ambience, 'none');
  assert.equal(e.scene, 'dark');
  assert.equal(e.remaining, 'hidden');
  assert.equal(e.captions, false);
});

test('設定: 通知は既定で無効、残り時間は既定で非表示', () => {
  const d = Settings.defaults();
  assert.equal(d.notifyEnd, false);
  assert.equal(d.remaining, 'hidden');
});

// ── 保存 ───────────────────────────────────
test('保存: 書いて読める', () => {
  const st = createStorage(memoryBackend(), { prefix: 't.' });
  st.write('a', { x: 1 });
  assert.deepEqual(st.read('a'), { x: 1 });
});

test('保存: 容量不足でも例外を出さず、メモリで続ける', () => {
  const errors = [];
  const be = memoryBackend({ failWrites: true });
  const st = createStorage(be, { prefix: 't.', onError: (k) => errors.push(k) });
  assert.equal(st.write('a', { x: 2 }), false);
  assert.deepEqual(st.read('a'), { x: 2 });
  assert.deepEqual(errors, ['quota']);
});

test('保存: 壊れた JSON は既定値で読み、退避する', () => {
  const be = memoryBackend();
  be.setItem('t.a', '{broken');
  const errors = [];
  const st = createStorage(be, { prefix: 't.', onError: (k) => errors.push(k) });
  assert.equal(st.read('a', 'fallback'), 'fallback');
  assert.equal(be.getItem('t.a.corrupt'), '{broken');
  assert.deepEqual(errors, ['corrupt']);
});

test('保存: clearAll はこのアプリの鍵だけを消す', () => {
  const be = memoryBackend();
  be.setItem('other', '1');
  const st = createStorage(be, { prefix: 't.' });
  st.write('a', 1); st.write('b', 2);
  st.clearAll();
  assert.equal(be.getItem('t.a'), null);
  assert.equal(be.getItem('other'), '1');
});

test('保存: localStorage がない環境でも動く', () => {
  const st = createStorage(null, { prefix: 't.' });
  st.write('a', 5);
  assert.equal(st.read('a'), 5);
  assert.ok(st.degraded);
});

// ── 記録 ───────────────────────────────────
const DAY = 86_400_000;
function entry(id, startedAt, sitMs = 10 * MIN) {
  return History.makeEntry({ id, kind: 'zazen', startedAt, plannedMs: 10 * MIN, sitMs, completed: true }, { tags: ['calm', 'bogus'], note: 'x' });
}

test('記録: 不正なタグは捨て、メモは上限で切る', () => {
  const e = History.makeEntry({ id: 1, startedAt: 1, sitMs: 1 }, { tags: ['calm', 'bad'], note: 'a'.repeat(5000) });
  assert.deepEqual(e.tags, ['calm']);
  assert.equal(e.note.length, History.MAX_NOTE);
});

test('記録: 新しい順・同じ id は置き換え', () => {
  let l = [];
  l = History.add(l, entry('a', 100));
  l = History.add(l, entry('b', 200));
  l = History.add(l, entry('a', 300));
  assert.deepEqual(l.map((e) => e.id), ['a', 'b']);
});

test('記録: 一定期間より古いものを手放す', () => {
  const now = 400 * DAY;
  const l = [entry('new', now - 10 * DAY), entry('old', now - 100 * DAY)];
  assert.deepEqual(History.forget(l, 30, now).map((e) => e.id), ['new']);
  assert.equal(History.forget(l, 0, now).length, 2);
});

test('記録: リズムは日ごとの分数（休んだ日は 0、責めない）', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const l = [entry('a', now - 1000), entry('b', now - 2 * DAY), entry('c', now - 2 * DAY - 1000, 5 * MIN)];
  const r = History.rhythm(l, now, 7, 0);
  assert.equal(r.length, 7);
  assert.equal(r[6].minutes, 10);
  assert.equal(r[4].minutes, 15);
  assert.equal(r[5].minutes, 0);
});

test('記録: ストリーク（連続日数）は提供しない', () => {
  assert.equal(History.streak, undefined);
  assert.equal(History.currentStreak, undefined);
});

test('記録: 壊れたリストの検証', () => {
  const l = History.validateList([null, 5, { id: 'x', startedAt: 'nope' }, { id: 'y', startedAt: 10, sitMs: 1000 }]);
  assert.deepEqual(l.map((e) => e.id), ['y']);
  assert.deepEqual(History.validateList('garbage'), []);
});

test('記録: 書き出し JSON に記録と設定が入る', () => {
  const json = JSON.parse(History.exportJSON([entry('a', 1)], { x: 1 }, 0));
  assert.equal(json.history.length, 1);
  assert.equal(json.format, 1);
});

// ── 表示 ───────────────────────────────────
test('表示: 残り時間は既定で非表示、約◯分、最後の 1 分は「まもなく」', () => {
  assert.equal(remainingView(5 * MIN, 'hidden'), null);
  assert.deepEqual(remainingView(5 * MIN + 1, 'approx'), { kind: 'approx', minutes: 6 });
  assert.deepEqual(remainingView(59_000, 'approx'), { kind: 'soon' });
  assert.deepEqual(remainingView(65 * MIN + 5000, 'exact'), { kind: 'exact', text: '1:05:05' });
  assert.deepEqual(remainingView(9 * MIN + 1000, 'exact'), { kind: 'exact', text: '9:01' });
});

// ── 文言 ───────────────────────────────────
function shape(o) {
  if (typeof o === 'function') return `fn${o.length}`;
  if (Array.isArray(o)) return o.map(shape);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])]));
  return typeof o;
}

test('文言: 日本語と英語の鍵・引数がそろっている', () => {
  assert.deepEqual(shape(en), shape(ja));
});

function allText(o, out = []) {
  if (typeof o === 'string') out.push(o);
  else if (typeof o === 'function') { try { out.push(String(o(3, 5))); } catch { /* noop */ } }
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => allText(v, out));
  return out;
}

test('文言: 評価・罪悪感・競争を生む言葉を使わない', () => {
  const banned = ['失敗', '間違', '頑張', '連続記録', '途切れ', '上位', 'ランキング', 'streak', 'fail', 'wrong', 'top 10', 'you beat', '%の人', 'もっと集中'];
  const text = [...allText(ja), ...allText(en)].join('\n').toLowerCase();
  for (const w of banned) assert.ok(!text.includes(w.toLowerCase()), `banned word: ${w}`);
});

test('文言: 治療効果を断定しない（医療の語は免責の文脈のみ）', () => {
  const text = allText(ja).join('\n');
  for (const w of ['治る', '治します', '改善します', '効果があります']) assert.ok(!text.includes(w), w);
});

// ── 景色 ───────────────────────────────────
test('景色: 月相（既知の満月・新月）', () => {
  assert.approx(moonPhase(Date.UTC(2024, 0, 25, 17, 54)), 0.5, 0.02); // 満月
  const nm = moonPhase(Date.UTC(2024, 1, 9, 22, 59)); // 新月
  assert.ok(nm < 0.02 || nm > 0.98, `new moon phase ${nm}`);
});

test('景色: 時刻から昼夜', () => {
  assert.equal(timeOfDay(new Date(2026, 0, 1, 2)), 'night');
  assert.equal(timeOfDay(new Date(2026, 0, 1, 6)), 'dawn');
  assert.equal(timeOfDay(new Date(2026, 0, 1, 12)), 'day');
  assert.equal(timeOfDay(new Date(2026, 0, 1, 18)), 'dusk');
});
