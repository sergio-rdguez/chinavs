/* ============================================================
   Motor de las audioguías: mapa con GPS, voz del iPhone y plan de tiempos.
   Cada página define CFG (textos, recinto del mapa y RUTA) y carga
   su guion.js (window.GUION) antes que este archivo.
   ============================================================ */
const RUTA=CFG.ruta;
const G=window.GUION||{};
const P=RUTA.map(([id,nombre,zh,py,lat,lon,min,radio,am,ir],i)=>{
  const g=G[id]||{};
  return {i,id,nombre,zh,py,lat,lon,min,radio,am,ir,resumen:g.resumen||"",mira:g.mira||[],pistas:(g.pistas||[]).map(p=>({...p,pal:palabras(p.texto)}))};
});
function palabras(t){return String(t||"").trim().split(/\s+/).filter(Boolean).length}

/* ---------- Utilidades ---------- */
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LS={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const PARAMS=new URLSearchParams(location.search);
function distM(a,b,c,d){const R=6371000,r=x=>x*Math.PI/180,dl=r(c-a),dn=r(d-b);
  const h=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function rumbo(a,b,c,d){const r=x=>x*Math.PI/180,y=Math.sin(r(d-b))*Math.cos(r(c)),x=Math.cos(r(a))*Math.sin(r(c))-Math.sin(r(a))*Math.cos(r(c))*Math.cos(r(d-b));
  return (Math.atan2(y,x)*180/Math.PI+360)%360}
const PUNTOS=["norte","noreste","este","sureste","sur","suroeste","oeste","noroeste"];
const cardinal=g=>PUNTOS[Math.round(g/45)%8];
const fmtM=m=>m<1000?`${Math.round(m/5)*5} m`:`${(m/1000).toFixed(1).replace(".",",")} km`;
const fmtDur=min=>{min=Math.round(min);return min<60?`${min} min`:`${Math.floor(min/60)} h${min%60?" "+String(min%60).padStart(2,"0"):""}`};
const hora=ms=>new Date(ms).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"});
let avisoT;
function aviso(t){const a=$("aviso");a.textContent=t;a.classList.add("on");clearTimeout(avisoT);avisoT=setTimeout(()=>a.classList.remove("on"),2800)}
const urlMapas=p=>`https://maps.apple.com/?q=${encodeURIComponent(p.am)}${p.lat?`&sll=${p.lat},${p.lon}`:""}`;
const urlAPie=p=>`https://maps.apple.com/?daddr=${encodeURIComponent(p.am)}&dirflg=w`;

/* ---------- Estado guardado ---------- */
const E=Object.assign({oidas:{},inicio:null,auto:true,vel:1,voz:"",p:0,k:0},LS.get(CFG.clave+"-guia",{}));
const guardar=()=>LS.set(CFG.clave+"-guia",E);
const oida=(i,k)=>!!E.oidas[P[i].id+"/"+k];
const paradaOida=i=>P[i].pistas.length>0&&P[i].pistas.every((_,k)=>oida(i,k));
const minPista=p=>p.pal/150/(E.vel||1);              // la voz del iPhone lee unas 150 palabras por minuto
const minAudio=i=>P[i].pistas.reduce((s,p)=>s+minPista(p),0);

/* ============================================================
   VOZ: la síntesis del propio iPhone, en español, sin conexión.
   Se lee frase a frase: así se puede pausar, volver atrás
   y no se corta en textos largos.
   ============================================================ */
const S=window.speechSynthesis;
let VOCES=[],sonando=false,frases=[],fi=0,turno=0,desbloqueado=false;
function cargarVoces(){
  if(!S) return;
  VOCES=S.getVoices().filter(v=>/^es/i.test(v.lang));
  if(!E.voz||!VOCES.some(v=>v.voiceURI===E.voz)){const m=mejorVoz();if(m) E.voz=m.voiceURI}
}
function mejorVoz(){                       // primero las voces mejoradas de España, después cualquier español
  const pt=v=>(/es[-_]ES/i.test(v.lang)?10:0)+(/premium|mejorad|enhanced|siri/i.test(v.name)?6:0)+(/m[oó]nica|jorge|marisol|paulina/i.test(v.name)?2:0)+(v.localService?1:0);
  return [...VOCES].sort((a,b)=>pt(b)-pt(a))[0];
}
if(S){cargarVoces();S.onvoiceschanged=cargarVoces}
function trocear(t){                        // frases de hasta ~240 caracteres
  const fr=String(t).replace(/\s+/g," ").match(/[^.!?…]+[.!?…]+[»"”)]*\s*|[^.!?…]+$/g)||[t],out=[];
  for(const f of fr){const s=f.trim();if(!s) continue;
    if(out.length&&(out[out.length-1].length+s.length<140)) out[out.length-1]+=" "+s; else out.push(s)}
  return out;
}
function textoPista(i,k){
  const p=P[i],x=p.pistas[k];if(!x) return "";
  let t=(k===0?`${p.nombre}. `:"")+`${x.t}. ${x.texto}`;
  if(k===p.pistas.length-1){const s=P[i+1];
    t+=s?` Aquí termina esta parada. La siguiente es ${s.nombre}. ${s.ir}`:" Aquí termina la audioguía. Gracias por la compañía, y buen viaje."}
  return t;
}
function cargar(i,k,desde=0){E.p=i;E.k=k;guardar();frases=trocear(textoPista(i,k));fi=Math.min(desde,frases.length-1)}
function hablar(){
  if(!S){aviso("Este navegador no puede leer en voz alta.");return}
  const mio=++turno;S.cancel();
  if(!frases.length) return parar();
  sonando=true;bloqueo(true);
  const u=new SpeechSynthesisUtterance(frases[fi]);
  const v=VOCES.find(v=>v.voiceURI===E.voz);if(v){u.voice=v;u.lang=v.lang}else u.lang="es-ES";
  u.rate=E.vel||1;u.pitch=1;
  u.onend=()=>{if(mio!==turno) return;siguienteFrase()};
  u.onerror=e=>{if(mio!==turno||e.error==="interrupted"||e.error==="canceled") return;siguienteFrase()};
  window._u=u;                               // Safari olvida a veces los enunciados que nadie retiene
  setTimeout(()=>{if(mio===turno) S.speak(u)},S.speaking?120:0);
  pintarRepro();
}
function siguienteFrase(){
  if(fi<frases.length-1){fi++;return hablar()}
  E.oidas[P[E.p].id+"/"+E.k]=1;guardar();
  if(E.k<P[E.p].pistas.length-1){cargar(E.p,E.k+1);return hablar()}
  parar();pintarParadas();pintarEstado();pintarMapa();       // al acabar una parada se espera a llegar a la siguiente
}
function parar(){turno++;if(S) S.cancel();sonando=false;bloqueo(false);pintarRepro()}
function play(i,k){
  desbloqueado=true;
  if(i!=null){cargar(i,k||0);abrir(i,false)}
  else if(!frases.length) cargar(E.p,E.k);
  hablar();pintarParadas();
}
function alternar(){sonando?parar():play()}
function saltarFrase(d){if(!frases.length) cargar(E.p,E.k);fi=Math.max(0,Math.min(frases.length-1,fi+d));sonando?hablar():pintarRepro()}
function saltarPista(d){
  let i=E.p,k=E.k+d;
  if(k<0){if(i>0){i--;k=P[i].pistas.length-1}else k=0}
  else if(k>=P[i].pistas.length){if(i<P.length-1){i++;k=0}else k=P[i].pistas.length-1}
  cargar(i,k);if(sonando) hablar();else pintarRepro();pintarParadas();
}
// La pantalla no se apaga mientras suena: con el iPhone bloqueado Safari corta la voz
let wake=null;
async function bloqueo(on){
  try{
    if(on&&!wake&&navigator.wakeLock){wake=await navigator.wakeLock.request("screen");wake.addEventListener("release",()=>{wake=null})}
    if(!on&&wake){await wake.release();wake=null}
  }catch(e){}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&sonando) bloqueo(true)});

/* ============================================================
   GPS
   ============================================================ */
let POS=null,vigia=null,seguir=true,llegadaI=null;
function ubicar(){
  const f=PARAMS.get("pos");                // ?pos=lat,lon para probar sin estar allí
  if(f){const [a,b]=f.split(",").map(Number);return nuevaPos({latitude:a,longitude:b,accuracy:5})}
  if(!navigator.geolocation){aviso("Este móvil no da la ubicación.");return}
  if(vigia!=null) return;
  vigia=navigator.geolocation.watchPosition(p=>{LS.set(CFG.clave+"-geo",1);nuevaPos(p.coords)},e=>{
    navigator.geolocation.clearWatch(vigia);vigia=null;
    aviso(e.code===1?"Ubicación denegada: actívala en Ajustes › Privacidad › Localización › Safari.":"No se ha podido obtener la ubicación.");
    pintarEstado();
  },{enableHighAccuracy:true,maximumAge:5000,timeout:30000});
  pintarEstado();
}
function nuevaPos(c){
  POS={lat:c.latitude,lon:c.longitude,acc:c.accuracy||0,t:Date.now()};
  if(POS.acc<=70){
    const cerca=P.filter(p=>p.lat).map(p=>({p,d:distM(POS.lat,POS.lon,p.lat,p.lon)})).filter(x=>x.d<=x.p.radio).sort((a,b)=>a.d-b.d)[0];
    if(cerca&&cerca.p.i!==llegadaI) llegar(cerca.p.i);
  }
  pintarEstado();pintarYo();
}
function llegar(i){
  llegadaI=i;
  if(sonando&&E.p===i) return;
  if(!paradaOida(i)&&E.auto&&desbloqueado&&!sonando){aviso(`Habéis llegado: ${P[i].nombre}`);play(i,0);return}
  if(!(sonando&&E.p===i)) $("llegada").innerHTML=`<div class="llegada"><i class="fa-solid fa-location-dot"></i><div><small class="n">Habéis llegado a</small><b>${esc(P[i].nombre)}</b></div>
    <button class="btn pri sm" data-play="${i}"><i class="fa-solid fa-play"></i>Escuchar</button><button class="btn sm" data-act="cerrar-llegada" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button></div>`;
  if(navigator.vibrate) navigator.vibrate(200);
}

/* ============================================================
   MAPA (Leaflet + OpenStreetMap, que va en WGS-84 como el GPS)
   ============================================================ */
let MAPA=null,PINES=[],YO=null,YOacc=null;
function montarMapa(){
  if(!window.L){$("mapa").innerHTML=`<p class="n" style="padding:16px">El mapa no ha cargado (sin conexión). La guía y el GPS funcionan igual.</p>`;return}
  const oscuro=document.documentElement.dataset.tema==="oscuro";
  MAPA=L.map("mapa",{zoomControl:false,attributionControl:false,maxZoom:19}).fitBounds(CFG.limites);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,maxNativeZoom:19}).addTo(MAPA);
  if(CFG.foso) L.polygon(CFG.foso,{color:"#60A5FA",weight:5,opacity:.35,fill:false,interactive:false}).addTo(MAPA);
  (CFG.muros||[]).forEach(m=>L.polygon(m,{color:oscuro?"#F87171":"#B91C1C",weight:2,dashArray:"6 6",fill:false,interactive:false}).addTo(MAPA));
  if(CFG.muralla) L.polygon(CFG.muralla,{color:oscuro?"#F87171":"#B91C1C",weight:2,dashArray:"6 6",fillColor:"#DC2626",fillOpacity:.04,interactive:false}).addTo(MAPA);
  L.polyline(P.filter(p=>p.lat).map(p=>[p.lat,p.lon]),{color:"#B7791F",weight:4,opacity:.75,dashArray:"2 8",lineCap:"round",interactive:false}).addTo(MAPA);
  PINES=P.map(p=>p.lat?L.marker([p.lat,p.lon],{icon:icono(p),title:p.nombre}).addTo(MAPA)
    .bindTooltip(esc(p.nombre),{direction:"top",offset:[0,-14],className:"tt"}).on("click",()=>abrir(p.i,true)):null);
  MAPA.on("dragstart",()=>{seguir=false;$("bSeguir").classList.remove("on")});
}
function icono(p){
  const c=p.i===E.p?"act":paradaOida(p.i)?"oido":"";
  return L.divIcon({className:"",html:`<span class="pinP ${c}">${p.i}</span>`,iconSize:[26,26],iconAnchor:[13,13]});
}
function pintarMapa(){PINES.forEach((m,i)=>m&&m.setIcon(icono(P[i])))}
function pintarYo(){
  if(!MAPA||!POS) return;
  const ll=[POS.lat,POS.lon];
  if(!YO){YO=L.marker(ll,{icon:L.divIcon({className:"",html:`<div class="yo"></div>`,iconSize:[18,18],iconAnchor:[9,9]}),zIndexOffset:1000,interactive:false}).addTo(MAPA);
    YOacc=L.circle(ll,{radius:POS.acc,color:"#2563EB",weight:1,fillOpacity:.08,interactive:false}).addTo(MAPA)}
  else{YO.setLatLng(ll);YOacc.setLatLng(ll).setRadius(POS.acc)}
  if(seguir) MAPA.panTo(ll,{animate:true});
}

/* ---------- Descargar el mapa para usarlo sin conexión ---------- */
function teselas(){
  const out=[],t=(la,lo,z)=>{const n=2**z,x=Math.floor((lo+180)/360*n),r=la*Math.PI/180;return [x,Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n)]};
  for(let z=14;z<=18;z++){const [x0,y1]=t(CFG.zona[0][0],CFG.zona[0][1],z),[x1,y0]=t(CFG.zona[1][0],CFG.zona[1][1],z);
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) out.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`)}
  return out;
}
async function descargarMapa(b){
  if(!window.caches){aviso("Este navegador no permite guardar el mapa.");return}
  const L0=teselas(),c=await caches.open("china-teselas");let hechas=0,fallos=0;
  b.disabled=true;
  const cola=[...L0],obrero=async()=>{while(cola.length){const u=cola.shift();
    try{if(!(await c.match(u))){const r=await fetch(u,{mode:"cors"});if(r.ok) await c.put(u,r);else fallos++}}catch(e){fallos++}
    hechas++;b.innerHTML=`<i class="fa-solid fa-spinner fa-spin"></i>${hechas} de ${L0.length}`}};
  await Promise.all([obrero(),obrero(),obrero(),obrero()]);
  b.disabled=false;b.innerHTML=`<i class="fa-solid fa-circle-check"></i>Mapa guardado`;LS.set(CFG.clave+"-mapa",fallos?0:1);
  aviso(fallos?`Guardado con ${fallos} huecos: repetidlo con mejor conexión.`:"Mapa guardado: funcionará sin conexión.");
}

/* ============================================================
   PANTALLA
   ============================================================ */
function plan(){                             // minuto previsto de llegada a cada parada (sin contar la intro)
  let m=0;return P.map(p=>{const r=m;if(p.id!=="intro") m+=p.min;return r});
}
function pintarPortada(){
  const tot=P.filter(p=>p.id!=="intro").reduce((s,p)=>s+p.min,0),audio=P.reduce((s,_,i)=>s+minAudio(i),0),np=P.reduce((s,p)=>s+p.pistas.length,0);
  const hechas=P.filter((_,i)=>paradaOida(i)).length;
  $("portada").innerHTML=`<p class="eb">Audioguía · Pekín</p><h2>${esc(CFG.titulo)}<span>${esc(CFG.zh)}</span></h2>
    <p>${esc(CFG.texto(np))}</p>
    <div class="kpis"><div><b>${fmtDur(tot)}</b><small>de visita</small></div><div><b>${fmtDur(audio)}</b><small>de audio</small></div><div><b>${hechas}/${P.length}</b><small>paradas oídas</small></div></div>
    <div class="btns">${E.inicio?`<button class="btn pri" data-act="seguir-visita"><i class="fa-solid fa-play"></i>Seguir: ${esc(P[E.p].nombre)}</button>`
      :`<button class="btn pri" data-act="empezar"><i class="fa-solid fa-play"></i>Empezar la visita</button>`}
      <button class="btn" data-act="ajustes"><i class="fa-solid fa-sliders"></i>Voz y mapa</button></div>`;
}
function pintarEstado(){
  const gps=POS?(Date.now()-POS.t<60000?`Precisión ±${Math.round(POS.acc)} m`:"Sin señal reciente"):vigia!=null?"Buscando…":"Desactivado";
  let sig="";
  const obj=P.find((p,i)=>p.lat&&i>=E.p&&!paradaOida(i))||P.find(p=>p.lat&&!paradaOida(p.i));
  if(obj){
    if(POS){const d=distM(POS.lat,POS.lon,obj.lat,obj.lon),g=rumbo(POS.lat,POS.lon,obj.lat,obj.lon);
      sig=`<b>${esc(obj.nombre)}</b><span>${d<=obj.radio?"Estáis aquí":`<span class="flecha" style="transform:rotate(${Math.round(g)}deg)">↑</span> ${fmtM(d)} al ${cardinal(g)} · ${Math.max(1,Math.round(d/70))} min andando`}</span>`}
    else sig=`<b>${esc(obj.nombre)}</b><span>Activad el GPS para ver la distancia</span>`;
  }else sig=`<b>¡Visita completada!</b><span>Ya lo habéis oído todo</span>`;
  let pl=`<b>Sin empezar</b><span>Previsto: ${fmtDur(P.filter(p=>p.id!=="intro").reduce((s,p)=>s+p.min,0))}</span>`;
  if(E.inicio){
    const pasado=(Date.now()-E.inicio)/60000,PL=plan(),i=Math.max(1,E.p),dif=Math.round(pasado-PL[i]);
    pl=`<b>${fmtDur(pasado)} desde las ${hora(E.inicio)}</b><span>${Math.abs(dif)<=5?"Vais bien de tiempo":dif>0?`Unos ${fmtDur(dif)} por detrás del plan`:`Unos ${fmtDur(-dif)} por delante del plan`}</span>`;
  }
  $("estado").innerHTML=`<div class="est"><small><span class="punto ${POS&&Date.now()-POS.t<60000?"ok":""}"></span>GPS</small><b>${gps}</b>
      <span>${vigia!=null||POS?(E.auto?"Avisa al llegar a cada parada":"Aviso automático apagado"):`<button class="btn sm" data-act="gps" style="margin-top:4px"><i class="fa-solid fa-location-arrow"></i>Activar</button>`}</span></div>
    <div class="est"><small><i class="fa-regular fa-clock"></i>Tiempo</small>${pl}</div>
    <div class="est ancha"><small><i class="fa-solid fa-person-walking"></i>Siguiente parada</small>${sig}</div>`;
}
function pintarParadas(){
  const PL=plan(),abiertas=new Set([...document.querySelectorAll(".parada.abierta")].map(x=>+x.dataset.i));
  if(!document.querySelector(".parada")) abiertas.add(E.p);
  $("paradas").innerHTML=P.map(p=>{
    const hecha=paradaOida(p.i);
    return `<article class="parada ${abiertas.has(p.i)?"abierta":""} ${hecha?"hecha":""} ${p.i===E.p?"act":""}" id="p-${p.id}" data-i="${p.i}">
      <button class="pc" data-abrir="${p.i}" aria-expanded="${abiertas.has(p.i)}"><span class="num"><span>${p.i||'<i class="fa-solid fa-headphones"></i>'}</span></span>
        <span class="tx"><b>${esc(p.nombre)}</b><span class="sub"><span class="zh">${esc(p.zh)}</span> ${esc(p.py)} · ${p.pistas.length} historias · ${fmtDur(minAudio(p.i))} de audio${p.id!=="intro"?` · ${p.min} min aquí · <i class="fa-regular fa-clock"></i> +${fmtDur(PL[p.i])}`:""}</span></span>
        <i class="fa-solid fa-chevron-down chev"></i></button>
      <div class="pb">
        ${p.resumen?`<p class="resumen">${esc(p.resumen)}</p>`:""}
        <div class="ir"><i class="fa-solid fa-signs-post"></i><span>${esc(p.ir)}</span></div>
        ${p.mira.length?`<div><p class="lbl" style="margin:0 0 8px"><i class="fa-solid fa-eye"></i>Fijaos en</p><ul class="mira">${p.mira.map(m=>`<li><i class="fa-solid fa-star"></i><span>${esc(m)}</span></li>`).join("")}</ul></div>`:""}
        <div class="pistas">${p.pistas.map((x,k)=>`<button class="pista ${p.i===E.p&&k===E.k&&sonando?"sonando":""} ${oida(p.i,k)?"oida":""}" data-play="${p.i}" data-k="${k}">
          <span class="pl"><i class="fa-solid ${p.i===E.p&&k===E.k&&sonando?"fa-volume-high":oida(p.i,k)?"fa-check":"fa-play"}"></i></span>
          <span class="tx"><b>${esc(x.t)}</b><small><span class="tipo t-${esc(x.tipo)}">${esc(x.tipo)}</span>${fmtDur(Math.max(1,minPista(x)))}</small></span></button>`).join("")
          ||`<p class="n">Falta el texto de esta parada.</p>`}</div>
        <div class="btns">${p.pistas.length?`<button class="btn pri sm" data-play="${p.i}"><i class="fa-solid fa-play"></i>Escuchar la parada</button>`:""}
          ${p.lat?`<a class="btn azul sm" href="${esc(urlAPie(p))}" target="_blank" rel="noopener"><i class="fa-solid fa-person-walking"></i>A pie en Mapas</a>
          <a class="btn sm" href="${esc(urlMapas(p))}" target="_blank" rel="noopener"><i class="fa-solid fa-map-location-dot"></i>Ver en Mapas</a>
          <button class="btn sm" data-centrar="${p.i}"><i class="fa-solid fa-crosshairs"></i>En el mapa</button>`:""}</div>
        ${p.pistas.length?`<details class="texto"><summary><i class="fa-solid fa-align-left"></i> Leer el texto</summary>${p.pistas.map(x=>`<h4>${esc(x.t)}</h4>${x.texto.split(/\n+/).map(t=>`<p>${esc(t)}</p>`).join("")}`).join("")}</details>`:""}
      </div></article>`}).join("");
}
function abrir(i,mover){
  const el=document.querySelector(`.parada[data-i="${i}"]`);if(!el) return;
  el.classList.add("abierta");el.querySelector(".pc").setAttribute("aria-expanded","true");
  if(mover) el.scrollIntoView({behavior:"smooth",block:"start"});
}
function pintarRepro(){
  const p=P[E.p],x=p&&p.pistas[E.k],tot=frases.length||1;
  $("repro").innerHTML=`<div class="repro-in">
    <button class="rinfo" data-ir-parada="${E.p}"><span class="num" style="width:30px;height:30px;font-size:12.5px">${E.p||'<i class="fa-solid fa-headphones"></i>'}</span>
      <span class="tx"><b>${x?esc(x.t):"Elige una historia"}</b><small>${esc(p.nombre)} · ${E.k+1} de ${p.pistas.length||1}</small></span></button>
    <div class="barra"><i style="width:${frases.length?(fi+(sonando?.5:0))/tot*100:0}%"></i></div>
    <div class="ctrl">
      <button data-act="pista-ant" aria-label="Historia anterior"><i class="fa-solid fa-backward-step"></i></button>
      <button data-act="frase-ant" aria-label="Frase anterior"><i class="fa-solid fa-rotate-left"></i></button>
      <button class="play" data-act="play" aria-label="${sonando?"Pausa":"Reproducir"}"><i class="fa-solid ${sonando?"fa-pause":"fa-play"}"></i></button>
      <button data-act="frase-sig" aria-label="Frase siguiente"><i class="fa-solid fa-rotate-right"></i></button>
      <button data-act="pista-sig" aria-label="Historia siguiente"><i class="fa-solid fa-forward-step"></i></button>
      <button class="vel" data-act="vel" aria-label="Velocidad">${String(E.vel).replace(".",",")}×</button>
    </div>
    ${sonando&&frases[fi]?`<p class="frase">${esc(frases[fi])}</p>`:""}</div>`;
  document.querySelectorAll(".pista").forEach(b=>{const on=sonando&&+b.dataset.play===E.p&&+b.dataset.k===E.k;
    b.classList.toggle("sonando",on);b.querySelector(".pl i").className="fa-solid "+(on?"fa-volume-high":oida(+b.dataset.play,+b.dataset.k)?"fa-check":"fa-play")});
}
function ajustes(){
  cargarVoces();
  $("hoja").innerHTML=`<h3>Ajustes<button class="ico" data-act="cerrar" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button></h3>
    <div><label for="sVoz">Voz</label><select id="sVoz">${VOCES.length?VOCES.map(v=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===E.voz?"selected":""}>${esc(v.name)} · ${esc(v.lang)}</option>`).join(""):`<option>Voz en español del sistema</option>`}</select>
      <p class="n" style="margin-top:6px">Para una voz más natural: Ajustes del iPhone › Accesibilidad › Contenido leído › Voces › Español (España) y descargad «Mónica (mejorada)» o una voz «Premium». Después recargad esta página.</p>
      <div class="btns" style="margin-top:8px"><button class="btn sm" data-act="probar"><i class="fa-solid fa-volume-high"></i>Probar la voz</button></div></div>
    <div><label for="sVel">Velocidad</label><select id="sVel">${[.85,.9,1,1.1,1.2,1.35].map(v=>`<option value="${v}" ${v===E.vel?"selected":""}>${String(v).replace(".",",")}×</option>`).join("")}</select></div>
    <div class="fila"><span>Empezar a hablar sola al llegar a cada parada</span><input type="checkbox" class="sw" id="sAuto" ${E.auto?"checked":""}></div>
    <div><label>Sin conexión</label><p class="n" style="margin:4px 0 8px">La guía y la voz ya funcionan sin internet. Descargad también el mapa del recinto con wifi en el hotel (unos pocos MB).</p>
      <button class="btn azul sm" data-act="descargar">${LS.get(CFG.clave+"-mapa",0)?`<i class="fa-solid fa-circle-check"></i>Mapa guardado · repetir`:`<i class="fa-solid fa-download"></i>Descargar mapa`}</button></div>
    <div><label>Consejos</label><ul class="mira" style="margin-top:6px">
      <li><i class="fa-solid fa-star"></i><span>Mientras suena, la pantalla no se apaga: si el iPhone se bloquea, Safari corta la voz.</span></li>
      <li><i class="fa-solid fa-star"></i><span>Con unos auriculares compartidos o el altavoz bajito podéis escucharla los dos.</span></li>
      <li><i class="fa-solid fa-star"></i><span>Dentro de los patios el GPS puede desviarse 20 o 30 metros: si no salta el aviso, tocad la parada.</span></li></ul></div>
    <div class="btns"><button class="btn sm" data-act="reiniciar"><i class="fa-solid fa-rotate"></i>Empezar de cero</button></div>`;
  $("dlg").showModal();
  $("sVoz").onchange=e=>{E.voz=e.target.value;guardar()};
  $("sVel").onchange=e=>{E.vel=+e.target.value;guardar();pintarRepro();pintarParadas();pintarPortada()};
  $("sAuto").onchange=e=>{E.auto=e.target.checked;guardar();pintarEstado()};
}
function todo(){pintarPortada();pintarEstado();pintarParadas();pintarRepro();pintarMapa()}

/* ---------- Eventos ---------- */
document.addEventListener("click",e=>{
  const q=s=>e.target.closest(s);let b;
  if(b=q("[data-play]")){const i=+b.dataset.play;$("llegada").innerHTML="";play(i,b.dataset.k!=null?+b.dataset.k:0);todo();return}
  if(b=q("[data-abrir]")){const el=b.closest(".parada"),on=el.classList.toggle("abierta");b.setAttribute("aria-expanded",on);return}
  if(b=q("[data-ir-parada]")){abrir(+b.dataset.irParada,true);return}
  if(b=q("[data-centrar]")){const p=P[+b.dataset.centrar];if(MAPA){seguir=false;$("bSeguir").classList.remove("on");MAPA.setView([p.lat,p.lon],18);
    PINES[p.i].openTooltip();$("mapa").scrollIntoView({behavior:"smooth",block:"center"})}return}
  if(!(b=q("[data-act]"))) return;
  const a=b.dataset.act;
  if(a==="empezar"){E.inicio=E.inicio||Date.now();guardar();ubicar();play(0,0);todo();return}
  if(a==="seguir-visita"){ubicar();play();todo();return}
  if(a==="play") alternar();
  if(a==="pista-ant") saltarPista(-1);
  if(a==="pista-sig") saltarPista(1);
  if(a==="frase-ant") saltarFrase(-1);
  if(a==="frase-sig") saltarFrase(1);
  if(a==="vel"){const vs=[.9,1,1.1,1.2],j=vs.indexOf(E.vel);E.vel=vs[(j+1)%vs.length];guardar();if(sonando) hablar();pintarRepro()}
  if(a==="gps") ubicar();
  if(a==="seguir"){seguir=true;b.classList.add("on");if(POS&&MAPA) MAPA.setView([POS.lat,POS.lon],18);else ubicar()}
  if(a==="encuadrar"&&MAPA){seguir=false;$("bSeguir").classList.remove("on");MAPA.fitBounds(CFG.limites)}
  if(a==="ajustes") ajustes();
  if(a==="cerrar") $("dlg").close();
  if(a==="cerrar-llegada") $("llegada").innerHTML="";
  if(a==="probar"){desbloqueado=true;const u=new SpeechSynthesisUtterance(CFG.saludo);
    const v=VOCES.find(v=>v.voiceURI===E.voz);if(v){u.voice=v;u.lang=v.lang}else u.lang="es-ES";u.rate=E.vel;parar();S.speak(u)}
  if(a==="descargar") descargarMapa(b);
  if(a==="reiniciar"&&confirm("¿Borrar el progreso y empezar la visita de cero?")){parar();Object.assign(E,{oidas:{},inicio:null,p:0,k:0});frases=[];guardar();$("dlg").close();todo()}
});
$("dlg").addEventListener("click",e=>{if(e.target===$("dlg")) $("dlg").close()});
addEventListener("pagehide",()=>{if(S) S.cancel()});

/* ---------- Arranque ---------- */
if(E.p>=P.length) E.p=0;
cargar(E.p,E.k);
montarMapa();todo();
if(LS.get(CFG.clave+"-geo",0)||PARAMS.get("pos")) ubicar();       // si ya disteis permiso, el GPS arranca solo
setInterval(pintarEstado,30000);
if("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js",{scope:"../"}).catch(()=>{});
