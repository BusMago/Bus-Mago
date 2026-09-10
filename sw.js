// Incrementa questo valore ad ogni deploy per invalidare la cache degli utenti
const CACHE_NAME = 'bus-mago-cache-v19';

// Immagini: cache-first (cambiano raramente, utili offline)
const STATIC_IMAGES = [
  './img/icona_bus_mago.webp',
  './img/icona_bus_mago.png',
  './img/units.webp',
  './img/icona_fs.webp',
  './img/icona_uni.webp',
  './img/barcola.webp'
];

// File app: stale-while-revalidate (serviti subito dalla cache, aggiornati in
// background). trips.json NON è qui: 564 KB che servono solo al matcher statico
// in background, si mette in cache al primo uso reale.
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './style-classic.css',
  './script.js',
  './lines.js',
  './stops.js',
  './tracks.js',
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

// Salva in cache una risposta valida (clonata) senza bloccare il ritorno.
function cachePut(request, response) {
  if (response && response.status === 200) {
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Lascia passare le richieste esterne dinamiche (tile OSM, API TPL FVG)
  if (url.includes('tile.openstreetmap.org') || url.includes('tplfvg.it')) {
    return;
  }

  // Solo richieste GET
  if (event.request.method !== 'GET') return;

  // Cache-first: immagini + Leaflet da unpkg (versione pinnata nell'URL =
  // immutabile). Così l'app è davvero offline e non fa round-trip a ogni avvio.
  const cacheFirst = /\.(webp|png|jpg|jpeg|gif|svg|ico)(\?.*)?$/i.test(url)
    || url.includes('unpkg.com');

  if (cacheFirst) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => cachePut(event.request, response))
      )
    );
    return;
  }

  // Stale-while-revalidate per HTML/JS/CSS/JSON: risposta immediata dalla cache,
  // copia nuova scaricata in background ed usata al riavvio successivo. Il bump
  // di CACHE_NAME a ogni deploy resta la garanzia "versione nuova per tutti".
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => cachePut(event.request, response))
        .catch(() => cached);
      return cached || network;
    })
  );
});
