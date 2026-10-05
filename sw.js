/* Viaje a China: copia de la app para que abra sin conexión.
   Sirve primero lo guardado y se actualiza por detrás; la versión nueva aparece al abrir la app la vez siguiente. */
const CACHE = "china-v5";
const FOTOS = ["pekin", "xian", "shanghai", "zhangjiajie", "yangshuo", "shenzhen", "hongkong"].map(k => `./img/${k}.jpg`);
const ARCHIVOS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png", ...FOTOS];
// Iconos y mapas se descargan ya en casa: en China estos CDN pueden ir lentos o estar bloqueados
const FA = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/";
const EXTRA = [FA + "css/all.min.css", FA + "webfonts/fa-solid-900.woff2", FA + "webfonts/fa-regular-400.woff2", FA + "webfonts/fa-brands-400.woff2",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
// Iconos, tipografía de iconos, mapas e iconos del tiempo: se guardan la primera vez que se usan
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ARCHIVOS);
    await Promise.allSettled(EXTRA.map(u => c.match(u).then(h => h || c.add(u))));   // si alguno falla, la app se instala igual
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(async ks => {
      const nueva = await caches.open(CACHE);                         // lo ya descargado de los CDN pasa a la caché nueva
      for (const k of ks.filter(k => k !== CACHE)) {
        const vieja = await caches.open(k);
        for (const req of await vieja.keys()) if (CDN.test(req.url) && !(await nueva.match(req))) await nueva.put(req, await vieja.match(req));
        await caches.delete(k);
      }
    })
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
      if (res.ok && !res.redirected) {
        cache.put(clave, res.clone());
        const firma = r => r && (r.headers.get("etag") || r.headers.get("last-modified"));
        if (req.mode === "navigate" && guardado && firma(res) && firma(res) !== firma(guardado))   // se ha publicado una versión nueva
          e.waitUntil(new Promise(r => setTimeout(r, 2500))             // espera a que la página esté lista para escuchar
            .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
            .then(cs => cs.forEach(c => c.postMessage({ tipo: "nueva" }))));
      }
      return res;
    }).catch(() => guardado || cache.match("./index.html"));
    return guardado || red;
  }));
});
