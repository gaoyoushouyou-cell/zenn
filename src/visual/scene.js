// 景色。墨と霧の 2D 表現（Canvas 2D）。
// 3D を選ばなかった理由: 座禅中に「見るもの」は少ないほどよく、
// 遠景・霧・月・水面だけで「そこにいる」感覚は作れる。2D なら低性能端末でも安定し、電池と発熱を抑えられる。
//
// 設計:
// - 低解像度（最大 640px 幅）で描き、CSS で拡大する。霧は柔らかいので粗さが目立たない
// - 山並みは日付から決まる乱数で描く。毎日わずかに違う景色になる（移ろい）
// - 月は実際の月相を計算する
// - 霧の動きは周期の異なる正弦波の和。ループ感を出さない
// - 動きを減らす設定では、静止画を 30 秒ごとに描き直すだけ
// - タブ非表示・「闇」・静寂モードでは描画を完全に止める

import { mulberry32 } from '../audio/bell.js';

const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC

/** 月齢 0..1（0=新月, 0.5=満月） */
export function moonPhase(ts) {
  const days = (ts - NEW_MOON_REF) / 86_400_000;
  return ((days / SYNODIC) % 1 + 1) % 1;
}

/** 時刻から昼夜の重み。auto 用 */
export function timeOfDay(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 4.5 || h >= 20) return 'night';
  if (h < 7.5) return 'dawn';
  if (h < 17) return 'day';
  return 'dusk';
}

const PALETTES = {
  night: { skyTop: [9, 11, 18], skyLow: [24, 28, 40], ridge: [[30, 34, 46], [20, 23, 32], [12, 14, 20]], mist: [120, 130, 150], water: [8, 10, 15], moon: 1 },
  dawn: { skyTop: [38, 40, 55], skyLow: [118, 104, 104], ridge: [[88, 84, 96], [60, 58, 70], [34, 33, 42]], mist: [196, 186, 186], water: [26, 26, 34], moon: 0.35 },
  day: { skyTop: [78, 88, 100], skyLow: [130, 134, 138], ridge: [[100, 106, 112], [74, 80, 88], [48, 52, 58]], mist: [196, 198, 202], water: [44, 48, 54], moon: 0 },
  dusk: { skyTop: [26, 28, 44], skyLow: [96, 78, 82], ridge: [[66, 60, 74], [44, 42, 54], [24, 24, 32]], mist: [170, 156, 160], water: [16, 16, 24], moon: 0.6 },
  rain: { skyTop: [28, 32, 38], skyLow: [62, 68, 74], ridge: [[54, 60, 66], [40, 45, 50], [24, 27, 31]], mist: [140, 148, 154], water: [16, 18, 22], moon: 0 },
  snow: { skyTop: [44, 48, 58], skyLow: [112, 116, 124], ridge: [[118, 122, 130], [86, 90, 98], [56, 58, 66]], mist: [214, 216, 222], water: [34, 36, 42], moon: 0.15 },
};

const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function resolveScene(scene, date) {
  if (scene === 'auto') return timeOfDay(date);
  return scene;
}

export function createScene(canvas, { now = () => Date.now(), onFrameStats } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let w = 0, h = 0;
  let sceneName = 'night';
  let reduced = false;
  let quality = 'auto'; // 'low' | 'high' | 'auto'
  let scale = 1; // 自動の解像度係数
  let running = false;
  let raf = 0;
  let lastDraw = 0;
  let staticTimer = 0;
  let cache = null; // 背景（空・山・水面）の事前描画
  let cacheKey = '';
  let particles = [];
  const frameTimes = [];
  let contextLost = false;
  let moonPos = null;

  function targetFps() {
    if (quality === 'low') return 12;
    if (quality === 'high') return 30;
    return 24;
  }

  function resize() {
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight;
    const maxW = quality === 'low' ? 360 : quality === 'high' ? 720 : 560;
    const base = Math.min(1, maxW / cssW) * scale;
    const nw = Math.max(160, Math.round(cssW * base));
    const nh = Math.max(120, Math.round(cssH * base));
    if (nw !== w || nh !== h) {
      w = canvas.width = nw;
      h = canvas.height = nh;
      cacheKey = '';
      seedParticles();
    }
  }

  function dayIndex() {
    const d = new Date(now());
    return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
  }

  function ridgeLine(rand, baseY, amp, rough) {
    // 中点変位法で 1 次元の稜線
    const n = 65;
    const pts = new Float32Array(n);
    pts[0] = rand(); pts[n - 1] = rand();
    let step = n - 1, a = 1;
    while (step > 1) {
      const half = step >> 1;
      for (let i = half; i < n - 1; i += step) {
        pts[i] = (pts[i - half] + pts[i + half]) / 2 + (rand() - 0.5) * a;
      }
      step = half; a *= rough;
    }
    return { pts, baseY, amp };
  }

  function buildCache() {
    const pal = PALETTES[sceneName] || PALETTES.night;
    const key = `${w}x${h}:${sceneName}:${dayIndex()}`;
    if (key === cacheKey && cache) return;
    cacheKey = key;
    cache = cache || document.createElement('canvas');
    cache.width = w; cache.height = h;
    const c = cache.getContext('2d');
    const rand = mulberry32(dayIndex() * 7 + sceneName.length);
    const horizon = h * 0.66;

    // 空
    const sky = c.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, rgb(pal.skyTop));
    sky.addColorStop(1, rgb(pal.skyLow));
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h);

    // 月（夜・夕・夜明け）
    moonPos = null;
    if (pal.moon > 0) moonPos = drawMoon(c, w * (0.76 + rand() * 0.08), h * (w < h ? 0.09 + rand() * 0.03 : 0.14 + rand() * 0.05), Math.max(5, Math.min(w, h) * 0.04), pal);

    // 山並み（遠いほど空に溶ける）
    const layers = [
      { y: 0.5, amp: 0.12, rough: 0.55 },
      { y: 0.57, amp: 0.1, rough: 0.6 },
      { y: 0.63, amp: 0.07, rough: 0.5 },
    ];
    layers.forEach((L, i) => {
      const r = ridgeLine(rand, L.y, L.amp, L.rough);
      const col = mix(pal.ridge[i], pal.skyLow, 0.35 - i * 0.12);
      c.beginPath();
      c.moveTo(0, h);
      for (let k = 0; k < r.pts.length; k++) {
        const x = (k / (r.pts.length - 1)) * w;
        const y = h * (L.y - r.pts[k] * L.amp);
        c.lineTo(x, y);
      }
      c.lineTo(w, h);
      c.closePath();
      c.fillStyle = rgb(col);
      c.fill();
      // 山裾の霧
      const fog = c.createLinearGradient(0, h * (L.y - L.amp * 0.4), 0, h * (L.y + 0.06));
      fog.addColorStop(0, rgb(pal.mist, 0));
      fog.addColorStop(1, rgb(pal.mist, 0.16 - i * 0.03));
      c.fillStyle = fog;
      c.fillRect(0, h * (L.y - L.amp), w, h * (L.amp + 0.1));
    });

    // 水面
    const water = c.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, rgb(mix(pal.water, pal.skyLow, 0.25)));
    water.addColorStop(1, rgb(pal.water));
    c.fillStyle = water;
    c.fillRect(0, horizon, w, h - horizon);

    // 紙の肌理（静的なごく弱いノイズ）
    const grain = c.createImageData(w, h);
    const g = grain.data;
    for (let i = 0; i < g.length; i += 4) {
      const v = (rand() * 255) | 0;
      g[i] = g[i + 1] = g[i + 2] = v; g[i + 3] = 7;
    }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(grain, 0, 0);
    c.drawImage(tmp, 0, 0);

    // 周辺減光
    const vg = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.3, w / 2, h * 0.5, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);
  }

  function drawMoon(c, x, y, r, pal) {
    const phase = moonPhase(now());
    const glow = c.createRadialGradient(x, y, r * 0.5, x, y, r * 7);
    const lum = Math.sin(Math.PI * phase); // 満月ほど明るい
    glow.addColorStop(0, `rgba(220,220,210,${0.16 * pal.moon * (0.3 + lum)})`);
    glow.addColorStop(1, 'rgba(220,220,210,0)');
    c.fillStyle = glow;
    c.fillRect(x - r * 7, y - r * 7, r * 14, r * 14);
    // 欠けた部分も薄く見える（地球照）
    c.fillStyle = `rgba(200,200,190,${0.05 * pal.moon})`;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    // 明るい部分: 半円 + 楕円で明暗境界を作る
    const waxing = phase < 0.5;
    const k = Math.cos(phase * 2 * Math.PI); // 1=新月, -1=満月
    c.save();
    c.fillStyle = `rgba(232,230,218,${0.85 * pal.moon})`;
    c.beginPath();
    // 光っている側の半円
    c.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !waxing);
    // 明暗境界（楕円）
    c.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === waxing);
    c.fill();
    c.restore();
    return { x, y, r };
  }

  function seedParticles() {
    const rand = mulberry32(99);
    particles = [];
    const n = quality === 'low' ? 0.5 : 1;
    if (sceneName === 'rain') {
      for (let i = 0; i < 90 * n; i++) particles.push({ x: rand() * w, y: rand() * h, v: 0.6 + rand() * 0.5, l: 4 + rand() * 7, a: 0.05 + rand() * 0.1 });
    } else if (sceneName === 'snow') {
      for (let i = 0; i < 70 * n; i++) particles.push({ x: rand() * w, y: rand() * h, v: 0.05 + rand() * 0.08, r: 0.5 + rand() * 1.3, p: rand() * 6.28, a: 0.25 + rand() * 0.4 });
    }
  }

  function draw(t) {
    if (contextLost) return;
    const t0 = performance.now();
    buildCache();
    ctx.drawImage(cache, 0, 0);
    const pal = PALETTES[sceneName] || PALETTES.night;
    const sec = t / 1000;

    // 霧の帯: 周期の異なる正弦の和で、ゆっくり揺らぐ
    const bands = quality === 'low' ? 3 : 5;
    for (let i = 0; i < bands; i++) {
      const speed = 0.0018 + i * 0.0007; // 画面幅/秒
      const x = (((sec * speed + i * 0.37) % 1.6) - 0.3) * w;
      const y = h * (0.5 + i * 0.045 + 0.012 * Math.sin(sec / (41 + i * 7)));
      const alpha = 0.05 + 0.035 * (Math.sin(sec / (37 + i * 11) + i) * 0.6 + Math.sin(sec / (61 + i * 5) + i * 2) * 0.4);
      const rx = w * (0.45 + 0.1 * i), ry = h * 0.05;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      gr.addColorStop(0, rgb(pal.mist, Math.max(0, alpha)));
      gr.addColorStop(1, rgb(pal.mist, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
    }

    // 水面に映る月の光（ごくわずかに揺れる）
    if (moonPos) {
      const m = moonPos;
      const horizon = h * 0.66;
      const shimmer = 0.5 + 0.5 * Math.sin(sec / 7.3) * Math.sin(sec / 3.1);
      const col = ctx.createLinearGradient(0, horizon, 0, h);
      col.addColorStop(0, `rgba(220,220,205,${0.07 + 0.03 * shimmer})`);
      col.addColorStop(1, 'rgba(220,220,205,0)');
      ctx.fillStyle = col;
      const bw = m.r * (1.6 + 0.2 * Math.sin(sec / 5.7));
      ctx.fillRect(m.x - bw / 2, horizon, bw, h - horizon);
    }

    // 天気の粒
    if (!reduced && particles.length) {
      if (sceneName === 'rain') {
        ctx.strokeStyle = 'rgba(200,210,220,1)';
        ctx.lineWidth = 1;
        for (const p of particles) {
          p.y += p.v * (h / 120);
          p.x -= p.v * 0.6;
          if (p.y > h) { p.y = -p.l; p.x = Math.random() * w * 1.1; }
          ctx.globalAlpha = p.a;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.l * 0.15, p.y + p.l); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (sceneName === 'snow') {
        ctx.fillStyle = 'rgba(240,242,246,1)';
        for (const p of particles) {
          p.y += p.v * (h / 120);
          p.p += 0.01;
          const x = p.x + Math.sin(p.p) * 6;
          if (p.y > h) { p.y = -2; p.x = Math.random() * w; }
          ctx.globalAlpha = p.a;
          ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // 性能の自己調整: 描画が重ければ解像度を落とす
    const dt = performance.now() - t0;
    frameTimes.push(dt);
    if (frameTimes.length >= 30) {
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      frameTimes.length = 0;
      onFrameStats && onFrameStats({ avg, scale, w, h });
      if (quality !== 'high' && avg > 10 && scale > 0.5) { scale = Math.max(0.5, scale - 0.15); resize(); }
    }
  }

  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (t - lastDraw < 1000 / targetFps() - 2) return;
    lastDraw = t;
    draw(t);
  }

  function stopLoop() {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(staticTimer); staticTimer = 0;
  }

  function startLoop() {
    stopLoop();
    if (!running || document.hidden || contextLost) return;
    resize();
    if (reduced) {
      draw(performance.now());
      staticTimer = setInterval(() => draw(performance.now()), 30_000);
    } else {
      raf = requestAnimationFrame(loop);
    }
  }

  const onVis = () => (document.hidden ? stopLoop() : startLoop());
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => { if (running) { resize(); if (reduced) draw(performance.now()); } };
  window.addEventListener('resize', onResize);
  canvas.addEventListener('contextlost', () => { contextLost = true; stopLoop(); });
  canvas.addEventListener('contextrestored', () => { contextLost = false; cacheKey = ''; cache = null; startLoop(); });

  return {
    /** scene: 'night'|'dawn'|'day'|'dusk'|'rain'|'snow'|'dark' */
    configure({ scene, reducedMotion, power }) {
      const changed = scene !== sceneName || reducedMotion !== reduced || power !== quality;
      quality = power; reduced = reducedMotion;
      if (scene === 'dark') {
        running = false; stopLoop();
        canvas.dataset.dark = 'true';
        sceneName = scene;
        return;
      }
      canvas.dataset.dark = 'false';
      if (scene !== sceneName) { sceneName = scene; cacheKey = ''; seedParticles(); }
      if (!running || changed) { running = true; startLoop(); }
    },
    stop() { running = false; stopLoop(); },
    get running() { return running && (raf !== 0 || staticTimer !== 0); },
    get size() { return { w, h, scale }; },
    renderOnce() { resize(); draw(performance.now()); },
  };
}
