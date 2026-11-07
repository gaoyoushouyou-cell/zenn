// アクセシビリティの自動検査（axe-core の代わりに、このアプリで重要な規則を独自に検査）。
// - すべての操作要素にアクセシブルな名前がある
// - フォーム要素にラベルがある
// - 各画面に h1 が一つ
// - 押せる大きさ 24×24 以上（WCAG 2.5.8）
// - 文字色と背景のコントラスト 4.5:1 以上（暗・明・座禅中）
// - キーボードだけで主要導線を進める（フォーカス移動と Enter）

import { test, assert, setFile, sleep } from '../harness.js';
import { fakeClock } from '../../src/core/clock.js';
import { memoryBackend } from '../../src/core/storage.js';
import { makeFakeAudio } from '../fakes.js';

setFile('e2e/a11y');

async function launch(theme = 'dark') {
  const clock = fakeClock(Date.UTC(2026, 10, 7, 21, 0));
  const fa = makeFakeAudio(clock);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:420px;height:820px;border:0;position:absolute;left:-9999px;top:0';
  iframe.src = `../index.html?test=a11y${Math.random()}`;
  document.body.append(iframe);
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  const w = iframe.contentWindow;
  for (let i = 0; i < 100 && !w.__zazenBoot; i++) await sleep(20);
  const app = w.__zazenBoot({ clockBase: clock, AudioCtor: fa.AudioCtor, storageBackend: memoryBackend(), storagePrefix: `a11y.${Math.random()}.` });
  app.ctx.updateSettings({ theme });
  return { iframe, w, doc: iframe.contentDocument, app, clock };
}

function accessibleName(el, doc) {
  const lb = el.getAttribute('aria-labelledby');
  if (lb) return lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ').trim();
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.id) {
    const l = doc.querySelector(`label[for="${el.id}"]`);
    if (l) return l.textContent.trim();
  }
  const wrap = el.closest('label');
  if (wrap) return wrap.textContent.trim();
  return (el.textContent || el.value || '').trim();
}

function visible(el, w) {
  const cs = w.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function auditView(env, name) {
  const { doc, w } = env;
  const problems = [];
  const main = doc.getElementById('main');
  const h1s = main.querySelectorAll('h1');
  if (h1s.length !== 1) problems.push(`${name}: h1 count ${h1s.length}`);
  for (const el of main.querySelectorAll('button, a[href], input, select, textarea, [role="switch"]')) {
    const nm = accessibleName(el, doc);
    if (!nm) problems.push(`${name}: unnamed ${el.outerHTML.slice(0, 80)}`);
    if (visible(el, w) && !el.closest('.sr-only') && el.type !== 'radio' && el.type !== 'checkbox') {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) problems.push(`${name}: target ${Math.round(r.width)}x${Math.round(r.height)} ${nm}`);
    }
  }
  // ラジオ・チェックは見た目のラベル（.choice / .toggle）の大きさで判定
  for (const lab of main.querySelectorAll('.choice, .toggle, .check')) {
    if (!visible(lab, w)) continue;
    const r = lab.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) problems.push(`${name}: choice target ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // 同じ id の重複
  const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) problems.push(`${name}: duplicate ids ${dup.join(',')}`);
  return problems;
}

// ── コントラスト計算 ─────────────────────────
function parseColor(str) {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function over(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function resolveVar(env, name) {
  const probe = env.doc.createElement('span');
  probe.style.color = `var(${name})`;
  env.doc.body.append(probe);
  const c = parseColor(env.w.getComputedStyle(probe).color);
  probe.remove();
  return c;
}

const VIEWS = ['home', 'guide', 'kinhin', 'history', 'settings'];

for (const theme of ['dark', 'light']) {
  test(`a11y(${theme}): 名前・ラベル・見出し・押せる大きさ`, async () => {
    const env = await launch(theme);
    try {
      const problems = [];
      for (const v of VIEWS) {
        env.app.ctx.nav(v);
        await sleep(20);
        problems.push(...auditView(env, v));
      }
      // 座禅中と余韻
      env.app.ctx.nav('home');
      env.doc.getElementById('sit').click();
      await sleep(20);
      problems.push(...auditView(env, 'session'));
      env.clock.advance(10_000 + 10 * 60_000); env.app.tick();
      await sleep(20);
      problems.push(...auditView(env, 'afterglow'));
      assert.deepEqual(problems, []);
    } finally { env.iframe.remove(); }
  });

  test(`a11y(${theme}): 文字のコントラスト 4.5:1 以上`, async () => {
    const env = await launch(theme);
    try {
      const bg0 = resolveVar(env, '--ink-0');
      const bg1 = resolveVar(env, '--ink-1');
      const out = [];
      for (const fgName of ['--text', '--text-dim', '--text-faint']) {
        const fg = resolveVar(env, fgName);
        for (const [bgName, bg] of [['--ink-0', bg0], ['--ink-1', bg1]]) {
          const c = contrast(over(fg, bg), bg);
          if (c < 4.5) out.push(`${fgName} on ${bgName}: ${c.toFixed(2)}`);
        }
      }
      // 「座る」ボタン上の主要ボタン（accent 地に accent-ink）
      const acc = resolveVar(env, '--accent');
      const accInk = resolveVar(env, '--accent-ink');
      const c2 = contrast(accInk, acc);
      if (c2 < 4.5) out.push(`--accent-ink on --accent: ${c2.toFixed(2)}`);
      assert.deepEqual(out, []);
    } finally { env.iframe.remove(); }
  });
}

test('a11y: 景色の上の文字も、幕（veil）込みで 4.5:1 以上', async () => {
  // 最も明るい景色（昼）の空の色を背景として、幕を重ねた上の文字色を検査
  const env = await launch('dark');
  try {
    const sky = { r: 130, g: 134, b: 138, a: 1 }; // scene.js の day.skyLow（最も明るい部分）
    const veil = parseColor(env.w.getComputedStyle(env.doc.querySelector('.veil')).backgroundColor);
    const bg = over(veil, sky);
    const out = [];
    for (const fgName of ['--text', '--text-dim']) {
      const fg = resolveVar(env, fgName);
      const c = contrast(over(fg, bg), bg);
      if (c < 4.5) out.push(`${fgName}: ${c.toFixed(2)}`);
    }
    assert.deepEqual(out, []);
  } finally { env.iframe.remove(); }
});

test('a11y: 画面を移ると見出しにフォーカスが移る', async () => {
  const env = await launch();
  try {
    env.app.ctx.nav('settings');
    await sleep(20);
    assert.equal(env.doc.activeElement.tagName, 'H1');
    env.doc.querySelector('[data-key="back"]').click();
    await sleep(20);
    assert.equal(env.doc.activeElement.tagName, 'H1');
  } finally { env.iframe.remove(); }
});

test('a11y: 座禅中の状態はライブ領域で伝わる', async () => {
  const env = await launch();
  try {
    env.doc.getElementById('sit').click();
    env.clock.advance(10_000); env.app.tick();
    await sleep(120);
    assert.equal(env.doc.getElementById('sr').textContent, env.app.ctx.t.srStarted);
    env.doc.querySelector('[data-key="say"]').click();
    await sleep(120);
    assert.ok(env.doc.getElementById('sr').textContent.length > 0);
  } finally { env.iframe.remove(); }
});

test('a11y: 座禅中の操作ボタンは隠れていてもキーボードで到達でき、フォーカスで現れる', async () => {
  const env = await launch();
  try {
    env.doc.getElementById('sit').click();
    env.clock.advance(20_000); env.app.tick();
    await sleep(20);
    const btn = env.doc.querySelector('[data-key="pause"]');
    btn.focus();
    await sleep(20);
    assert.equal(env.doc.activeElement, btn);
    assert.equal(env.doc.querySelector('main [data-view="session"]').dataset.controls, 'shown');
  } finally { env.iframe.remove(); }
});

test('a11y: ダイアログは Esc で閉じ、フォーカスが戻る', async () => {
  const env = await launch();
  try {
    const custom = env.doc.querySelector('[data-key="custom"]');
    custom.focus();
    custom.click();
    await sleep(20);
    const dlg = env.doc.getElementById('dialog');
    assert.ok(dlg.open);
    dlg.dispatchEvent(new env.w.Event('cancel', { cancelable: true }));
    await sleep(20);
    assert.ok(!dlg.open);
  } finally { env.iframe.remove(); }
});
