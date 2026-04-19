const CACHE_NAME = 'lipu-app-v21';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './lipu-profile.png',
  './lipu-memory.json',
  './js/main.js',
  './js/boot.js',
  './js/dom.js',
  './js/pwa.js',
  './js/handlers.js',
  './js/render.js',
  './js/particles-bg.js',
  './js/settings.js',
  './js/state.js',
  './js/services.js',
  './js/config.js',
  './js/utils.js',
  './js/recorder.js',
  './js/theme.js',
  './js/profiles.js',
  './js/context.js',
  './js/known-faces.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => (key === CACHE_NAME ? null : caches.delete(key)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});
