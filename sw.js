const CACHE_NAME = 'bus-mago-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './lines.js',
  './icona_bus_mago.webp',
  './icona_centre_map.webp',
  './icona_fs.webp',
  './icona_uni.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Pass through external requests (like OpenStreetMap or TPL FVG)
  if (event.request.url.includes('tile.openstreetmap.org') || event.request.url.includes('tplfvg.it')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
