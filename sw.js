const CACHE = "partes-erdella-logistica-v3";
const ASSETS = ["index.html?v=3", "styles.css?v=8", "data.js?v=1", "xlsx-export.js?v=9", "app.js?v=3", "manifest.webmanifest?v=3", "icon.svg", "icon-192.png", "icon-512.png"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && /^partes-erdella-logistica-v\d+$/.test(key)).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response;
  }).catch(() => caches.match("index.html?v=3"))));
});
