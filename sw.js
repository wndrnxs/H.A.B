// 홈 화면에 추가한 뒤 지하철처럼 신호가 약한 곳에서도 열리도록 앱 껍데기를 캐싱한다.
const CACHE = 'hab-shell-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './assets/styles.css', './assets/app.js', './assets/views.js',
  './assets/store.js', './assets/charts.js', './assets/util.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
  if (!sameOrigin && !isFont) return;

  // 껍데기는 캐시를 먼저 보여 주고 뒤에서 조용히 갱신한다
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
