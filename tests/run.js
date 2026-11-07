// すべてのテストを読み込んで実行し、画面に表示する。
// ?report=1 のときは結果を /__report へ POST する（tools/test.py が受け取る）。
import { run } from './harness.js';
import './unit/core.test.js';
import './unit/audio.test.js';
import './e2e/app.test.js';
import './e2e/a11y.test.js';

const params = new URLSearchParams(location.search);
const errors = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const results = await run({ filter: params.get('filter') || '' });
const failed = results.filter((r) => !r.ok);
document.getElementById('summary').textContent = `${results.length - failed.length} / ${results.length} 成功` + (failed.length ? `（失敗 ${failed.length}）` : '');
const ol = document.getElementById('results');
for (const r of results) {
  const li = document.createElement('li');
  li.dataset.ok = String(r.ok);
  li.textContent = `${r.ok ? '✓' : '✗'} [${r.file}] ${r.name} (${r.ms}ms)`;
  if (!r.ok) { const pre = document.createElement('pre'); pre.textContent = r.error; li.append(pre); }
  ol.append(li);
}
const payload = { results, errors, ambienceDb: globalThis.__ambienceDb || null, userAgent: navigator.userAgent };
document.documentElement.dataset.done = 'true';
window.__testResults = payload;
if (params.has('report')) {
  await fetch('/__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
