/* Viaje a China: copia de la app para que abra sin conexión.
   Sirve primero lo guardado y se actualiza por detrás; la versión nueva aparece al abrir la app la vez siguiente. */
const CACHE = "china-v3";
const ARCHIVOS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;   // la hoja, el clima y el cambio van directos
  e.respondWith(caches.open(CACHE).then(async cache => {
    const clave = req.mode === "navigate" ? "./index.html" : req;     // cualquier entrada a la app usa la misma copia
    const guardado = await cache.match(clave);
    const red = fetch(req).then(res => {
      if (res.ok) cache.put(clave, res.clone());
      return res;
    }).catch(() => guardado || cache.match("./index.html"));
    return guardado || red;
  }));
});
