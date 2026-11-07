// 起動。?test のときはテスト用に仮想時計と偽の音声を差し込めるよう、起動を保留する。

import { createApp } from './app.js';

const params = new URLSearchParams(location.search);
const testMode = params.has('test');

function boot(overrides = {}) {
  const app = createApp({
    root: document.getElementById('main'),
    canvas: document.getElementById('scene'),
    srRegion: document.getElementById('sr'),
    toastRegion: document.getElementById('toast'),
    dialogEl: document.getElementById('dialog'),
    testMode,
    ...overrides,
  });
  app.init();
  document.documentElement.dataset.ready = 'true';
  // ホーム画面のショートカット「すぐ座る」: 音の制約上、開始には一度の操作が要るので「座る」に焦点を置く
  if (params.get('start') === '1') document.getElementById('sit')?.focus();
  document.getElementById('toast')?.addEventListener('sw-updated', () => app.ctx.toast(app.ctx.t.updated));
  return app;
}

if (testMode) {
  // テストハーネスが window.__zazenBoot(overrides) を呼ぶ
  window.__zazenBoot = (overrides) => (window.__zazen = boot(overrides));
} else {
  boot();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          w?.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller) {
              document.getElementById('toast')?.dispatchEvent(new CustomEvent('sw-updated'));
            }
          });
        });
      }).catch(() => { /* オフライン機能なしでも動く */ });
    });
  }
}
