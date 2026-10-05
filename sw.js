/* Viaje a China: copia de la app para que abra sin conexión.
   Sirve primero lo guardado y se actualiza por detrás; la versión nueva aparece al abrir la app la vez siguiente. */
const CACHE = "china-v4";
const FOTOS = ["pekin", "xian", "shanghai", "zhangjiajie", "yangshuo", "shenzhen", "hongkong"].map(k => `./img/${k}.jpg`);
const ARCHIVOS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png", ...FOTOS];
// Iconos, tipografía de iconos, mapas e iconos del tiempo: se guardan la primera vez que se usan
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net)\//;

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
  if (req.method !== "GET") return;
  if (CDN.test(req.url)) {                                          // ficheros con versión fija: lo guardado vale para siempre
    e.respondWith(caches.open(CACHE).then(async cache => {
      const guardado = await cache.match(req);
      if (guardado) return guardado;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (new URL(req.url).origin !== location.origin) return;         // la hoja, el clima, el cambio y los mapas van directos
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
