// 홈 화면에 추가한 뒤 신호가 약한 곳에서도 열리도록 앱 껍데기를 캐싱한다.
//
// 앱 파일은 '네트워크 먼저'로 가져온다. 캐시를 먼저 주면(stale-while-revalidate)
// 고친 코드가 배포돼도 사용자는 한 박자 늦은 옛날 화면을 계속 보게 된다.
// 글꼴처럼 절대 안 바뀌는 것만 캐시를 먼저 준다.
const VERSION = 'v3';
const CACHE = `hab-shell-${VERSION}`;
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './assets/styles.css', './assets/app.js', './assets/views.js',
  './assets/store.js', './assets/charts.js', './assets/util.js',
  './assets/firebase.js', './assets/firebase-config.js', './assets/version.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 앱에서 '업데이트 확인'을 누르면 캐시를 통째로 버린다
self.addEventListener('message', (e) => {
  if (e.data === 'flush') {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
  if (!sameOrigin && !isFont) return;

  // 글꼴은 바뀌지 않으니 캐시 먼저
  if (isFont) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
    return;
  }

  // 앱 파일은 네트워크 먼저, 끊겼을 때만 캐시
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
