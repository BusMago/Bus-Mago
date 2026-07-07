// Incrementa questo valore ad ogni deploy per invalidare la cache degli utenti
const CACHE_NAME = 'bus-mago-cache-v11';

// Immagini: cache-first (cambiano raramente, utili offline)
const STATIC_IMAGES = [
  './img/icona_bus_mago.webp',
  './img/icona_bus_mago.png',
  './img/icona_fs.webp',
  './img/icona_uni.webp',
  './img/barcola.webp',
  './img/icona_bateo_gambling.webp'
];

// File app: network-first (aggiornati ad ogni push su GitHub)
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './style-classic.css',
  './script.js',
  './lines.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([...STATIC_IMAGES, ...APP_FILES]);
    })
  );
  // Attiva subito senza aspettare che le tab vecchie siano chiuse
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      // Prende controllo di tutte le tab aperte immediatamente
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Lascia passare le richieste esterne (tile OSM, API TPL FVG)
  if (url.includes('tile.openstreetmap.org') || url.includes('tplfvg.it') || url.includes('unpkg.com')) {
    return;
  }

  // Solo richieste GET
  if (event.request.method !== 'GET') return;

  const isImage = /\.(webp|png|jpg|jpeg|gif|svg|ico)(\?.*)?$/i.test(url);

  if (isImage) {
    // Cache-first per le immagini: veloce e disponibile offline
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  } else {
    // Network-first per HTML/JS/CSS: ad ogni push su GitHub l'utente riceve subito
    // la versione aggiornata. Se offline, usa la cache come fallback.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
