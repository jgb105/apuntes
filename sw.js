// Service worker: deja la app disponible sin conexión.
// Al publicar cambios, sube el número de VERSION para que los dispositivos tomen la nueva versión.
const VERSION = 'apuntes-v1.2.0';
const SHELL = [
  './', './index.html', './app.css', './config.js', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/sync.js', './js/editor.js', './js/importer.js', './js/covers.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'apuntes-cdn') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Librerías del CDN (versiones fijas): caché primero.
  if (req.url.startsWith(CDN)) {
    e.respondWith(caches.open('apuntes-cdn').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Archivos propios: red primero (para recibir actualizaciones), caché si no hay conexión.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      // no-cache: revalida con el servidor (GitHub Pages guarda copias 10 min) para recibir las versiones nuevas al tiro.
      const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
        if (res.ok) await (await caches.open(VERSION)).put(req, res.clone());
        return res;
      });
      try {
        // Si la red tarda más de 2,5 s y hay copia guardada, se usa la copia (la red igual la actualiza).
        const cached = await caches.match(req, { ignoreSearch: true });
        if (!cached) return await network;
        const timeout = new Promise(r => setTimeout(() => r(cached), 2500));
        return await Promise.race([network.catch(() => cached), timeout]);
      } catch {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('Sin conexión');
      }
    })());
  }
  // Supabase y demás: directo a la red (la app maneja el modo sin conexión).
});
