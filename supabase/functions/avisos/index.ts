/* Viaje a China: envía los avisos push que tocan ahora (Web Push, RFC 8291 y 8292, sin dependencias).
   Se llama cada 5 minutos y al activar los avisos en un móvil. Se despliega con la verificación de JWT
   desactivada: qué se manda y a quién lo decide la base de datos, y cada aviso sale una sola vez. */
const BASE = Deno.env.get("SUPABASE_URL")!;
const CLAVE = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUJETO = "https://sergio-rdguez.github.io/chinavs/";
const CORS = { "Access-Control-Allow-Origin": "*" };

const txt = new TextEncoder();
const aB64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const unir = (...ps: Uint8Array[]) => {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of ps) { out.set(p, i); i += p.length; }
  return out;
};

async function rpc(fn: string, cuerpo: unknown = {}) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: CLAVE, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

// Las claves se crean aquí la primera vez y no salen de la base de datos
async function crearVapid() {
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return rpc("china_vapid_guardar", {
    p: {
      publica: aB64(await crypto.subtle.exportKey("raw", par.publicKey)),
      privada: await crypto.subtle.exportKey("jwk", par.privateKey),
    },
  });
}

async function firmaVapid(endpoint: string, vapid: { publica: string; privada: JsonWebKey }) {
  const cabecera = aB64(txt.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const datos = aB64(txt.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUJETO,
  })));
  const clave = await crypto.subtle.importKey("jwk", vapid.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, clave, txt.encode(`${cabecera}.${datos}`));
  return `vapid t=${cabecera}.${datos}.${aB64(firma)}, k=${vapid.publica}`;
}

async function hkdf(sal: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bytes: number) {
  const clave = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sal, info }, clave, bytes * 8));
}

// Cifrado aes128gcm para el móvil (RFC 8291)
async function cifrar(sub: { p256dh: string; auth: string }, mensaje: unknown) {
  const movil = deB64(sub.p256dh);
  const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const nuestra = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const suya = await crypto.subtle.importKey("raw", movil, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secreto = await crypto.subtle.deriveBits({ name: "ECDH", public: suya }, par.privateKey, 256);
  const prk = await hkdf(deB64(sub.auth), secreto, unir(txt.encode("WebPush: info\0"), movil, nuestra), 32);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sal, prk, txt.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sal, prk, txt.encode("Content-Encoding: nonce\0"), 12);
  const clave = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const claro = unir(txt.encode(JSON.stringify(mensaje)), new Uint8Array([2]));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, clave, claro));
  return unir(sal, new Uint8Array([0, 0, 16, 0]), new Uint8Array([nuestra.length]), nuestra, cifrado);
}

// Devuelve false si el móvil ya no existe (hay que olvidar la suscripción)
async function enviar(sub: { endpoint: string; p256dh: string; auth: string }, vapid: { publica: string; privada: JsonWebKey }, mensaje: unknown) {
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await firmaVapid(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
    },
    body: await cifrar(sub, mensaje),
  });
  if (r.status === 404 || r.status === 410) return false;
  if (!r.ok) console.error("push", new URL(sub.endpoint).host, r.status, await r.text());
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Headers": "*" } });
  try {
    const { subs, avisos, vapid: guardada } = await rpc("china_avisos_tomar");
    const vapid = guardada || await crearVapid();
    const muertas = new Set<string>();
    let total = 0;
    for (const sub of subs) {
      const suyos = sub.avisos || avisos || [];
      total += suyos.length;
      const lista = sub.bienvenida
        ? [{ clave: "bienvenida", titulo: "Avisos activados", cuerpo: "Así os llegarán los transportes y lo próximo del viaje." }, ...suyos]
        : suyos;
      for (const a of lista) {
        try {
          if (!await enviar(sub, vapid, a)) muertas.add(sub.endpoint);
        } catch (e) {
          console.error("push", String(e));
        }
      }
    }
    if (muertas.size) await rpc("china_avisos_quitar", { p: [...muertas] });
    return Response.json({ subs: subs.length, avisos: total, quitadas: muertas.size }, { headers: CORS });
  } catch (e) {
    console.error(String(e));
    return Response.json({ error: "No se han podido enviar los avisos" }, { status: 500, headers: CORS });
  }
});
