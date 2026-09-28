// Incrementa questo valore ad ogni deploy per invalidare la cache degli utenti
const CACHE_NAME = 'bus-mago-cache-v21';

// Immagini e font: cache-first (cambiano raramente, utili offline)
const STATIC_IMAGES = [
  './img/icona_bus_mago.webp',
  './img/icona_bus_mago.png',
  './img/units.webp',
  './img/icona_fs.webp',
  './img/icona_uni.webp',
  './img/barcola.webp',
  './fonts/barlow-400.woff2',
  './fonts/barlow-500.woff2',
  './fonts/barlow-600.woff2',
  './fonts/barlow-condensed-600.woff2',
  './fonts/barlow-condensed-700.woff2'
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
      // cache:'reload' salta la cache HTTP del browser: subito dopo un deploy
      // (GitHub Pages max-age=600) addAll potrebbe altrimenti salvare i file vecchi.
      return cache.addAll([...STATIC_IMAGES, ...APP_FILES].map((u) => new Request(u, { cache: 'reload' })));
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

// Salva in cache una risposta valida (clonata). Ritorna la promise della
// scrittura, da passare a event.waitUntil: senza, il SW può essere terminato
// prima che cache.put finisca.
function cachePut(request, response) {
  if (!response || response.status !== 200) return Promise.resolve();
  const clone = response.clone();
  return caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
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
  const cacheFirst = /\.(webp|png|jpg|jpeg|gif|svg|ico|woff2)(\?.*)?$/i.test(url)
    || url.includes('unpkg.com');

  if (cacheFirst) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          event.waitUntil(cachePut(event.request, response));
          return response;
        })
      )
    );
    return;
  }

  // Stale-while-revalidate per HTML/JS/CSS/JSON: risposta immediata dalla cache,
  // copia nuova scaricata in background ed usata al riavvio successivo. Il bump
  // di CACHE_NAME a ogni deploy resta la garanzia "versione nuova per tutti".
  const network = fetch(event.request).then((response) => {
    event.waitUntil(cachePut(event.request, response));
    return response;
  });
  // Il revalidate in background deve completarsi anche se la pagina ha già
  // ricevuto la copia in cache.
  event.waitUntil(network.catch(() => {}));
  event.respondWith(
    caches.match(event.request).then((cached) => cached || network.catch(() => cached))
  );
});
