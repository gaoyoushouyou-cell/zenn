import { test, assert, setFile } from '../harness.js';
import { renderBell, bellPattern, TONES } from '../../src/audio/bell.js';
import { buildAmbience, LEVEL } from '../../src/audio/ambience.js';
import { createAudioEngine } from '../../src/audio/engine.js';
import { fakeClock } from '../../src/core/clock.js';
import { makeFakeAudio, bellStarts } from '../fakes.js';

setFile('unit/audio');

function stats(arr) {
  let peak = 0, sum = 0, nan = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) nan = true;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / arr.length), nan };
}

for (const tone of Object.keys(TONES)) {
  test(`鐘(${tone}): 数値が正常で、クリップしない`, () => {
    const b = renderBell({ tone, sampleRate: 16000, velocity: 1 });
    const l = stats(b.left), r = stats(b.right);
    assert.ok(!l.nan && !r.nan, 'no NaN');
    assert.ok(l.peak <= 1 && r.peak <= 1, `peak ${l.peak} ${r.peak}`);
    assert.ok(l.peak > 0.3, 'audible');
  });

  test(`鐘(${tone}): 頭と尻にクリックがない`, () => {
    const b = renderBell({ tone, sampleRate: 16000, velocity: 0.8 });
    assert.ok(Math.abs(b.left[0]) < 1e-3 && Math.abs(b.right[0]) < 1e-3, 'starts at zero');
    const n = b.left.length;
    assert.ok(Math.abs(b.left[n - 1]) < 1e-4 && Math.abs(b.right[n - 1]) < 1e-4, 'ends at zero');
    // 最初の 2ms に急峻な段差がない
    let maxStep = 0;
    for (let i = 1; i < 32; i++) maxStep = Math.max(maxStep, Math.abs(b.left[i] - b.left[i - 1]));
    assert.ok(maxStep < 0.2, `attack step ${maxStep}`);
  });
}

test('鐘: 弱く撞くと小さく、決定的（毎回同じ音）', () => {
  const a = renderBell({ tone: 'kei', sampleRate: 16000, velocity: 1 });
  const b = renderBell({ tone: 'kei', sampleRate: 16000, velocity: 0.5 });
  const c = renderBell({ tone: 'kei', sampleRate: 16000, velocity: 1 });
  assert.ok(stats(b.left).rms < stats(a.left).rms * 0.8, 'softer');
  assert.equal(a.left[5000], c.left[5000]);
});

test('鐘: 時間とともに減衰する', () => {
  const b = renderBell({ tone: 'kei', sampleRate: 16000 });
  const sr = 16000;
  const early = stats(b.left.subarray(sr * 0.5, sr * 1.5)).rms;
  const late = stats(b.left.subarray(sr * 10, sr * 11)).rms;
  assert.ok(late < early * 0.5, `${early} -> ${late}`);
});

test('鐘の打ち方: 伝統は始め三つ・終わり一つ、経行の始めは二つ', () => {
  assert.equal(bellPattern('start', 'traditional').length, 3);
  assert.equal(bellPattern('start', 'traditional', 'kinhin').length, 2);
  assert.equal(bellPattern('end', 'traditional').length, 1);
  assert.equal(bellPattern('start', 'simple').length, 1);
  assert.ok(bellPattern('interval', 'traditional')[0].v < bellPattern('end', 'traditional')[0].v, 'interval is softer');
});

// 実際の音声エンジンで環境音をレンダリングし、音量をそろえる
const TARGET_DB = -30;
for (const type of Object.keys(LEVEL)) {
  test(`環境音(${type}): 実レンダリングで音量が目標付近・NaN なし`, async () => {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) return; // 非対応ブラウザでは省略
    const sr = 24000;
    const seconds = 12;
    const ctx = new OAC(2, sr * seconds, sr);
    const amb = buildAmbience(ctx, type, 42);
    amb.output.connect(ctx.destination);
    amb.start(0);
    amb.modulate(0, seconds);
    const buf = await ctx.startRendering();
    const l = stats(buf.getChannelData(0).subarray(sr * 2));
    assert.ok(!l.nan, 'no NaN');
    const db = 20 * Math.log10(l.rms + 1e-12);
    globalThis.__ambienceDb = { ...(globalThis.__ambienceDb || {}), [type]: Math.round(db * 10) / 10 };
    assert.approx(db, TARGET_DB, 4, `${type} rms dBFS`);
    assert.ok(l.peak < 0.9, `peak ${l.peak}`);
  }, { timeout: 30_000 });
}

// ── 音声エンジン（偽の AudioContext） ─────────
test('音声: 予約した鐘は ensure で二重に鳴らない', async () => {
  const fc = fakeClock();
  const { AudioCtor, log } = makeFakeAudio(fc);
  const eng = createAudioEngine({ AudioCtor });
  assert.ok(await eng.unlock());
  eng.schedule('end', 10, { kind: 'end', style: 'traditional', tone: 'rin' });
  fc.advance(10_000);
  assert.equal(eng.ensure('end', { kind: 'end', style: 'traditional', tone: 'rin' }), 'scheduled');
  assert.equal(bellStarts(log).length, 1);
});

test('音声: 予約が遅れていれば（音声クロック停止など）今鳴らす', async () => {
  const fc = fakeClock();
  const { AudioCtor, log } = makeFakeAudio(fc);
  const eng = createAudioEngine({ AudioCtor });
  await eng.unlock();
  eng.schedule('end', 60, { kind: 'end', style: 'simple', tone: 'rin' });
  // JS 側では既に終わり（音声側の予約はまだ先）
  assert.equal(eng.ensure('end', { kind: 'end', style: 'simple', tone: 'rin' }), 'played');
  const live = bellStarts(log);
  assert.equal(live.length, 1, 'old schedule cancelled, played once');
});

test('音声: 一時停止で未来の予約を取り消す', async () => {
  const fc = fakeClock();
  const { AudioCtor, log } = makeFakeAudio(fc);
  const eng = createAudioEngine({ AudioCtor });
  await eng.unlock();
  eng.schedule('start', 5, { kind: 'start', style: 'traditional', tone: 'rin' });
  eng.schedule('end', 600, { kind: 'end', style: 'traditional', tone: 'rin' });
  eng.cancelPending();
  assert.equal(bellStarts(log).length, 0);
  assert.equal(eng.scheduledIn('end'), null);
});

test('音声: AudioContext が作れない環境でも例外を出さない', async () => {
  const fc = fakeClock();
  const { AudioCtor } = makeFakeAudio(fc, { failConstruct: true });
  const eng = createAudioEngine({ AudioCtor });
  assert.equal(await eng.unlock(), false);
  assert.equal(eng.available, false);
  assert.equal(eng.ensure('end', { kind: 'end', style: 'simple', tone: 'kei' }), 'unavailable');
  eng.startAmbience('rain');
  eng.stopAmbience();
});

test('音声: Web Audio 非対応ブラウザ', async () => {
  const eng = createAudioEngine({ AudioCtor: null });
  assert.equal(eng.available, false);
  assert.equal(await eng.unlock(), false);
});

test('音声: 鐘の間は環境音を下げる（ダッキング）', async () => {
  const fc = fakeClock();
  const { AudioCtor } = makeFakeAudio(fc);
  const eng = createAudioEngine({ AudioCtor });
  await eng.unlock();
  eng.startAmbience('rain');
  eng.schedule('end', 1, { kind: 'end', style: 'simple', tone: 'kei' });
  assert.ok(eng.ambienceType === 'rain');
  eng.stopAmbience(1);
  assert.equal(eng.ambienceType, 'none');
});
