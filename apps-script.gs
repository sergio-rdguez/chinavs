/**
 * Viaje a China — puente entre la hoja de cálculo y la app (versión 3).
 *
 * Cómo actualizarlo SIN cambiar la URL de la app:
 *   1. Extensiones → Apps Script: borra todo y pega este archivo. Guarda.
 *   2. Implementar → Gestionar implementaciones → lápiz (editar)
 *      → Versión: "Nueva versión" → Implementar.
 *
 * La primera vez crea solo las pestañas Agenda, Lugares, Gastos, Diario y
 * Ajustes, y añade columnas nuevas al final de Alojamiento y Transporte.
 */

const VERSION = 3;   // 3: envío de varios cambios a la vez y filas que se buscan por su clave si se han movido

// Columnas que la app puede modificar en vuestras pestañas (las fórmulas no se tocan)
const EDITABLES = {
  Itinerario: ['Actividades Principales'],
  Alojamiento: ['Hotel', 'Precio total', 'Estado', 'Notas', 'Dirección (chino)', 'Localizador'],
  Transporte: ['Salida', 'Llegada', 'Nº vuelo/tren', 'Precio', 'Estado', 'Notas', 'Localizador']
};

// Columnas que se añaden al final de vuestras pestañas si no existen
const COLUMNAS_NUEVAS = {
  Alojamiento: ['Dirección (chino)', 'Localizador'],
  Transporte: ['Localizador']
};

// Pestañas que gestiona la app. La primera columna es siempre un identificador.
const HOJAS = {
  Agenda:  { cols: ['ID', 'Fecha', 'Hora', 'Fin', 'Qué', 'Lugar', 'Tipo', 'Notas'], num: [] },
  Lugares: { cols: ['ID', 'Ciudad', 'Nombre', 'Chino', 'Dirección', 'Horario', 'Precio', 'Reserva', 'Notas', 'Lat', 'Lon'], num: [] },
  Gastos:  { cols: ['ID', 'Fecha', 'Ciudad', 'Concepto', 'Categoría', 'Importe', 'Moneda', 'EUR', 'Pagó'], num: ['Importe', 'EUR'] },
  Diario:  { cols: ['ID', 'Fecha', 'Nota'], num: [] },
  Ajustes: { cols: ['ID', 'Valor'], num: [] }
};
const SEMBRABLES = ['Agenda', 'Lugares'];

const TAREAS_INICIALES = [
  'Pasaportes con validez suficiente (mínimo 6 meses)',
  'Comprobar requisitos de entrada / visado para China y Hong Kong',
  'Seguro de viaje',
  'Alipay y/o WeChat Pay con tarjeta vinculada',
  'eSIM o roaming con datos',
  'Mapas y traductor descargados sin conexión',
  'Entradas Ciudad Prohibida',
  'Entradas Guerreros de Terracota',
  'Entradas Tianmen y Parque Forestal de Zhangjiajie',
  'Crucero / balsas del río Li',
  'Adaptador de enchufe y batería externa',
  'Copias de pasaportes y reservas'
];

function doGet() {
  try {
    const ss = SpreadsheetApp.getActive();
    preparar(ss);
    return salida(leerTodo(ss));
  } catch (err) {
    return salida({ error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const p = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActive();
    preparar(ss);
    var errores = [];
    if (p.action === 'batch') {             // varios cambios de golpe: un error no frena a los demás
      (p.ops || []).forEach(function (op, i) {
        try { aplicarOp(ss, op); } catch (err) { errores.push({ i: i, error: String(err.message || err) }); }
      });
    } else {
      aplicarOp(ss, p);
    }
    SpreadsheetApp.flush();
    const datos = leerTodo(ss);
    if (errores.length) datos.errores = errores;
    return salida(datos);
  } catch (err) {
    return salida({ error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function aplicarOp(ss, p) {
  if (p.action === 'update') {
    const permitidas = EDITABLES[p.sheet];
    if (!permitidas) throw new Error('Hoja no editable: ' + p.sheet);
    const sh = ss.getSheetByName(p.sheet);
    const fila = filaDe(sh, p.row, p.key);
    const cab = cabeceras(sh);
    Object.keys(p.values).forEach(function (h) {
      const c = cab.indexOf(h);
      if (permitidas.indexOf(h) < 0 || c < 0) return;
      sh.getRange(fila, c + 1).setValue(p.values[h]);
    });

  } else if (p.action === 'check') {
    const sh = ss.getSheetByName('Checklist');
    sh.getRange(filaDe(sh, p.row, p.key), 2).setValue(Boolean(p.done));

  } else if (p.action === 'addTask') {
    const texto = String(p.text || '').trim();
    if (!texto) throw new Error('Tarea vacía');
    const sh = ss.getSheetByName('Checklist');
    if (buscarId(sh, texto) < 0) {             // no duplica si el envío se repite
      sh.appendRow([texto, false]);
      sh.getRange(sh.getLastRow(), 2).insertCheckboxes();
    }

  } else if (p.action === 'upsert') {
    const sh = hojaApp(ss, p.sheet);
    const id = String(p.id || '').trim();
    if (!id) throw new Error('Falta el identificador');
    const cab = cabeceras(sh);
    const fila = buscarId(sh, id);
    const vals = p.values || {};
    if (fila > 0) {
      const rango = sh.getRange(fila, 1, 1, cab.length);
      const actual = rango.getValues()[0];
      cab.forEach(function (h, i) {
        if (i > 0 && Object.prototype.hasOwnProperty.call(vals, h)) actual[i] = vals[h];
      });
      rango.setValues([actual]);
    } else {
      sh.appendRow(cab.map(function (h, i) {
        return i === 0 ? id : (vals[h] !== undefined ? vals[h] : '');
      }));
    }

  } else if (p.action === 'remove') {
    const sh = hojaApp(ss, p.sheet);
    const fila = buscarId(sh, String(p.id || ''));
    if (fila > 0) sh.deleteRow(fila);

  } else if (p.action === 'seed') {
    if (SEMBRABLES.indexOf(p.sheet) < 0) throw new Error('Hoja no válida: ' + p.sheet);
    const sh = hojaApp(ss, p.sheet);
    const filas = p.rows || [];
    if (sh.getLastRow() < 2 && filas.length) {   // solo si la pestaña está vacía
      const cab = cabeceras(sh);
      sh.getRange(2, 1, filas.length, cab.length).setValues(filas.map(function (r) {
        return cab.map(function (h) { return r[h] !== undefined ? r[h] : ''; });
      }));
    }

  } else {
    throw new Error('Acción desconocida');
  }
}

/* ---------- Lectura ---------- */

function leerTodo(ss) {
  return {
    version: VERSION,
    itinerario: leerHoja(ss, 'Itinerario'),
    alojamiento: leerHoja(ss, 'Alojamiento'),
    transporte: leerHoja(ss, 'Transporte'),
    checklist: leerHoja(ss, 'Checklist'),
    agenda: leerHoja(ss, 'Agenda'),
    lugares: leerHoja(ss, 'Lugares'),
    gastos: leerHoja(ss, 'Gastos'),
    diario: leerHoja(ss, 'Diario'),
    ajustes: leerHoja(ss, 'Ajustes')
  };
}

function leerHoja(ss, nombre) {
  const sh = ss.getSheetByName(nombre);
  if (!sh) return [];
  const rango = sh.getDataRange();
  const vals = rango.getValues();
  const disp = rango.getDisplayValues();
  const tz = ss.getSpreadsheetTimeZone();
  const cab = disp[0].map(function (h) { return h.trim(); });
  const filas = [];
  for (var r = 1; r < disp.length; r++) {
    if (disp[r][0] === '') break;            // la tabla acaba en la primera fila vacía
    var o = { _row: r + 1, _k: disp[r][0] };
    for (var c = 0; c < cab.length; c++) {
      if (!cab[c]) continue;
      var v = vals[r][c];
      if (v instanceof Date) {
        o[cab[c]] = v.getFullYear() >= 2000 ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : disp[r][c];
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        o[cab[c]] = v;
      } else {
        o[cab[c]] = disp[r][c];
      }
    }
    filas.push(o);
  }
  return filas;
}

/* ---------- Preparación de la hoja ---------- */

function preparar(ss) {
  hojaChecklist(ss);
  Object.keys(HOJAS).forEach(function (n) { hojaApp(ss, n); });
  Object.keys(COLUMNAS_NUEVAS).forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (!sh) return;
    const cab = cabeceras(sh);
    var ultima = 0;
    cab.forEach(function (h, i) { if (h) ultima = i + 1; });
    COLUMNAS_NUEVAS[n].forEach(function (h) {
      if (cab.indexOf(h) >= 0) return;
      ultima++;
      sh.getRange(1, ultima).setValue(h).setFontWeight('bold');
    });
  });
}

function hojaApp(ss, nombre) {
  const def = HOJAS[nombre];
  if (!def) throw new Error('Hoja no válida: ' + nombre);
  var sh = ss.getSheetByName(nombre);
  if (sh) return sh;
  sh = ss.insertSheet(nombre);
  const n = def.cols.length;
  sh.getRange(1, 1, sh.getMaxRows(), n).setNumberFormat('@');   // texto: ni fechas ni horas se transforman
  def.num.forEach(function (h) {
    sh.getRange(2, def.cols.indexOf(h) + 1, sh.getMaxRows() - 1, 1).setNumberFormat('0.00');
  });
  sh.getRange(1, 1, 1, n).setValues([def.cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function hojaChecklist(ss) {
  var sh = ss.getSheetByName('Checklist');
  if (sh) return sh;
  sh = ss.insertSheet('Checklist');
  sh.getRange(1, 1, 1, 2).setValues([['Tarea', 'Hecho']]).setFontWeight('bold');
  sh.getRange(2, 1, TAREAS_INICIALES.length, 1)
    .setValues(TAREAS_INICIALES.map(function (t) { return [t]; }));
  sh.getRange(2, 2, TAREAS_INICIALES.length, 1).insertCheckboxes();
  sh.setColumnWidth(1, 420);
  return sh;
}

/* ---------- Utilidades ---------- */

function cabeceras(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0]
    .map(function (h) { return h.trim(); });
}

// Fila (1 = cabecera) cuyo primer valor coincide, o -1
function buscarId(sh, id) {
  const ultima = sh.getLastRow();
  if (ultima < 2) return -1;
  const col = sh.getRange(2, 1, ultima - 1, 1).getDisplayValues();
  for (var i = 0; i < col.length; i++) if (col[i][0] === id) return i + 2;
  return -1;
}

// Fila donde escribir: la que dice la app si su clave sigue ahí; si alguien ha movido filas,
// se busca la clave, pero solo si aparece una única vez (si no, no se sabe cuál es).
function filaDe(sh, fila, clave) {
  if (!sh) throw new Error('Falta la pestaña');
  clave = String(clave);
  if (fila > 1 && fila <= sh.getLastRow() && sh.getRange(fila, 1).getDisplayValue() === clave) return fila;
  const ultima = sh.getLastRow();
  if (ultima >= 2) {
    const col = sh.getRange(2, 1, ultima - 1, 1).getDisplayValues();
    const hay = [];
    for (var i = 0; i < col.length; i++) if (col[i][0] === clave) hay.push(i + 2);
    if (hay.length === 1) return hay[0];
  }
  throw new Error('La hoja ha cambiado. Actualiza la app y vuelve a intentarlo.');
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
