// Service Worker: アプリ本体をすべて端末に保存し、通信なしで動かす。
// 外部への通信は一切しない（同一オリジンの GET だけを扱う）。
// VERSION と ASSETS は tools/build.py が検証・更新する。

const VERSION = 'dev';
const CACHE = `shizuka-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'styles/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'src/main.js',
  'src/app.js',
  'src/platform.js',
  'src/core/clock.js',
  'src/core/session.js',
  'src/core/settings.js',
  'src/core/storage.js',
  'src/core/history.js',
  'src/core/format.js',
  'src/i18n/strings.js',
  'src/audio/bell.js',
  'src/audio/ambience.js',
  'src/audio/engine.js',
  'src/visual/scene.js',
  'src/ui/dom.js',
  'src/ui/views.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shizuka-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// キャッシュ優先。座禅の途中で通信状況に左右されないことを最優先にする。
// 開発版（VERSION=dev）だけは、通信できればネットワークの最新を使う。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/tests/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    if (VERSION === 'dev') {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch {
        return (await cache.match(key, { ignoreSearch: true })) || Response.error();
      }
    }
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});

// 終了通知をタップしたら、開いているアプリに戻る
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
