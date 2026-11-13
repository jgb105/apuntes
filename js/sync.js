// Sincronización con Supabase.
// Modelo: cada cambio se guarda primero en el dispositivo (marcado _dirty) y luego se sube.
// El servidor pone un sello de tiempo (server_updated_at) a cada fila; cada dispositivo
// baja solo lo que cambió desde su último sello. Si dos dispositivos editan la misma
// nota, gana la edición más reciente (lo aplica el trigger en la base).
import * as db from './db.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
export const BUCKET = 'adjuntos';

const COLS = {
  notebooks: ['id', 'title', 'parent_id', 'sort_order', 'cover', 'deleted', 'created_at', 'updated_at'],
  notes: ['id', 'title', 'html', 'text', 'notebook_ids', 'tags', 'pinned', 'bookmarked',
          'trashed', 'deleted', 'created_at', 'updated_at'],
};
const TABLES = ['notebooks', 'notes'];
const PAGE = 500;
const MAX_BATCH_BYTES = 900_000;

let client = null;
let user = null;
let running = null;
let again = false;
let pullTimer = null;
let pushTimer = null;
let channel = null;
const listeners = { change: () => {}, status: () => {} };
// Enlace de "recuperar contraseña": llega con #...type=recovery en la URL (supabase-js la limpia al leerla).
let recovery = /type=recovery/.test(location.hash);

export function on(event, fn) { listeners[event] = fn; }
export function getUser() { return user; }
export function isCloud() { return !!client; }
function status(s, detail) { listeners.status(s, detail); }

export async function init({ url, key }) {
  if (!client) {
    const { createClient } = await import(SUPABASE_JS);
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    client.auth.onAuthStateChange((evt, session) => {
      user = session?.user || null;
      if (evt === 'PASSWORD_RECOVERY') recovery = true;
    });
  }
  const { data } = await client.auth.getSession();
  user = data.session?.user || null;
  return user;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  user = data.user;
  return user;
}

export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  user = data.user;
  return data;
}

export function takeRecovery() { const r = recovery && !!user; if (r) recovery = false; return r; }

const APP_URL = new URL('./', location.href).href;

export async function resetPassword(email) {
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  stopRealtime();
  if (client) await client.auth.signOut();
  user = null;
}

// Tiempo real: el servidor avisa de cada cambio y se baja al instante. Si el canal se cae
// (celular suspendido, cambio de red), se reconecta solo y se hace una sincronización completa.
let rtState = 'closed';
let rtRetry = null;
let rtDelay = 1000;

export function startRealtime() {
  if (!client || !user || channel) return;
  rtState = 'connecting';
  const ch = client.channel(`apuntes-${user.id}`);
  for (const table of TABLES) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${user.id}` }, () => schedulePull(250));
  }
  ch.subscribe((st) => {
    if (channel !== ch) return;
    if (st === 'SUBSCRIBED') {
      const wasDown = rtState !== 'connecting';
      rtState = 'joined';
      rtDelay = 1000;
      if (wasDown) schedulePull(100); // lo que cambió mientras estaba desconectado
      else schedulePull(300);
    } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
      rtState = 'down';
      restartRealtimeLater();
    }
  });
  channel = ch;
}

function restartRealtimeLater() {
  clearTimeout(rtRetry);
  rtRetry = setTimeout(() => {
    stopRealtime();
    if (navigator.onLine && document.visibilityState !== 'hidden') startRealtime();
  }, rtDelay);
  rtDelay = Math.min(rtDelay * 2, 30_000);
}

// Llamar al volver a la app o recuperar la red.
export function ensureRealtime() {
  if (!client || !user) return;
  const socketOk = client.realtime?.isConnected?.() ?? true;
  if (!channel || rtState === 'down' || rtState === 'closed' || !socketOk) {
    stopRealtime();
    rtDelay = 1000;
    startRealtime();
  }
}

export function realtimeState() { return rtState; }

function stopRealtime() {
  clearTimeout(rtRetry);
  if (channel) { const ch = channel; channel = null; client.removeChannel(ch); }
  rtState = 'closed';
}

export function schedulePush(ms = 1500) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), ms);
}

export function schedulePull(ms = 800) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => syncNow(), ms);
}

// Ejecuta una sincronización completa; si llega otra petición mientras corre, repite al final.
export async function syncNow() {
  if (!client || !user) return;
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      if (!navigator.onLine) { status('offline'); break; }
      status('syncing');
      try {
        // Un adjunto con problemas no debe frenar la sincronización de las notas.
        const fileProblem = await pushFiles().then(() => null, (e) => e);
        for (const t of TABLES) await pushTable(t);
        let changed = false;
        for (const t of TABLES) changed = (await pullTable(t)) || changed;
        if (fileProblem) {
          console.warn('Adjunto pendiente', fileProblem);
          status('error', `No se pudo subir una imagen (${fileProblem?.message || fileProblem}). Las notas sí están sincronizadas; se reintenta solo.`);
        } else status('ok');
        if (changed) listeners.change();
      } catch (err) {
        console.error('Error de sincronización', err);
        status('error', err?.message || String(err));
        break;
      }
    } while (again);
  })();
  try { await running; } finally { running = null; }
}

function pick(row, cols) {
  const out = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

async function pushTable(table) {
  const all = await db.getAll(table);
  const dirty = all.filter(r => r._dirty);
  if (!dirty.length) return;
  let batch = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch.map(r => pick(r, COLS[table]));
    const { error } = await client.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    const sent = new Map(batch.map(r => [r.id, r.updated_at]));
    // Solo se limpia la marca si nadie volvió a editar la nota mientras se subía.
    await db.updateMany(table, [...sent.keys()], (cur, id) =>
      cur && cur._dirty && cur.updated_at === sent.get(id) ? { ...cur, _dirty: 0 } : undefined);
    batch = [];
    bytes = 0;
  };
  for (const r of dirty) {
    const size = (r.html?.length || 0) + (r.text?.length || 0) + 500;
    if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= 200)) await flush();
    batch.push(r);
    bytes += size;
  }
  await flush();
}

// Margen de seguridad: se vuelve a pedir lo de los últimos segundos por si una transacción
// de otro dispositivo terminó tarde con un sello anterior. Repetir filas no causa problemas.
const OVERLAP_MS = 10_000;

function minusOverlap(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > OVERLAP_MS ? new Date(t - OVERLAP_MS).toISOString() : iso;
}

async function pullTable(table) {
  // v1.2 agregó la portada de las libretas: se vuelven a bajar todas una vez para traerla.
  const key = table === 'notebooks' ? `pull_${table}_${user.id}_c2` : `pull_${table}_${user.id}`;
  const saved = (await db.metaGet(key)) || '1970-01-01T00:00:00Z';
  let since = minusOverlap(saved);
  let newest = saved;
  let changed = false;
  for (;;) {
    const { data, error } = await client.from(table)
      .select([...COLS[table], 'server_updated_at'].join(','))
      .gt('server_updated_at', since)
      .order('server_updated_at', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    if (!data.length) break;
    const remote = new Map(data.map(r => [r.id, r]));
    await db.updateMany(table, [...remote.keys()], (local, id) => {
      const r = remote.get(id);
      if (local && local._dirty && local.updated_at > r.updated_at) return undefined;
      // Ya la tengo: misma fecha de edición y mismos campos (comparar campos evita perder datos
      // que una versión anterior de la app no bajaba, como la portada de las libretas).
      if (local && !local._dirty && local.updated_at === r.updated_at &&
          COLS[table].every(c => JSON.stringify(local[c] ?? null) === JSON.stringify(r[c] ?? null))) return undefined;
      changed = true;
      const { server_updated_at, ...rest } = r;
      return { ...rest, _dirty: 0 };
    });
    since = data[data.length - 1].server_updated_at;
    if (since > newest || Date.parse(since) > Date.parse(newest)) newest = since;
    if (data.length < PAGE) break;
  }
  if (newest !== saved) await db.metaSet(key, newest);
  return changed;
}

// ---------- Adjuntos (imágenes, PDFs) ----------
const urlCache = new Map();

export function filePrefix() {
  return user ? user.id : 'local';
}

// Lista de adjuntos por subir (evita recorrer todas las imágenes guardadas en cada sincronización).
async function pendingFiles() {
  let list = await db.metaGet('pending_files');
  if (!Array.isArray(list)) { // primera vez con esta versión: revisar una sola vez
    list = [];
    for (const id of await db.getAllKeys('files')) {
      if (String(id).startsWith('thumb:')) continue;
      const f = await db.get('files', id);
      if (f?.dirty) list.push(id);
    }
    await db.metaSet('pending_files', list);
  }
  return list;
}

async function pushFiles() {
  const list = await pendingFiles();
  if (!list.length) return;
  const done = new Set();
  const forget = async () => {
    const cur = (await db.metaGet('pending_files')) || [];
    await db.metaSet('pending_files', cur.filter(id => !done.has(id)));
  };
  try {
    for (const id of list) {
      if (String(id).startsWith('local/')) continue;
      const f = await db.get('files', id);
      if (!f || !f.dirty) { done.add(id); continue; }
      // Imagen vacía o ilegible (pasa en iPhone si el sistema borró datos del navegador): no hay nada
      // que subir; se descarta para que no bloquee las demás.
      let readable = !!(f.blob && f.blob.size > 0);
      if (readable) { try { await f.blob.slice(0, 1).arrayBuffer(); } catch { readable = false; } }
      if (!readable) {
        console.warn('Adjunto vacío descartado', id);
        await db.put('files', { ...f, dirty: 0 });
        done.add(id);
        continue;
      }
      const { error } = await client.storage.from(BUCKET)
        .upload(f.id, f.blob, { upsert: true, contentType: f.blob.type || 'application/octet-stream' });
      if (error && /no content/i.test(error.message || '')) { await db.put('files', { ...f, dirty: 0 }); done.add(id); continue; }
      if (error) throw error;
      await db.put('files', { ...f, dirty: 0 });
      done.add(id);
    }
  } finally {
    await forget();
  }
}

export async function saveFile(path, blob) {
  await db.put('files', { id: path, blob, dirty: 1, name: blob.name || '' });
  const list = await pendingFiles();
  if (!list.includes(path)) await db.metaSet('pending_files', [...list, path]);
  const url = URL.createObjectURL(blob);
  urlCache.set(path, url);
  return url;
}

// Mueve al almacenamiento los archivos que llegaron por migración (tabla import_files).
// Se hace de a uno para no cargar la memoria del celular; si se corta, sigue la próxima vez.
let migrating = false;
export async function migrateImportedFiles(onProgress = () => {}) {
  if (!client || !user || migrating || !navigator.onLine) return 0;
  migrating = true;
  let moved = 0;
  try {
    const { data: list, error } = await client.from('import_files').select('path').limit(1000);
    if (error) { if (!/import_files/.test(error.message || '')) console.warn(error); return 0; }
    for (const { path } of list) {
      const { data: row, error: e1 } = await client.from('import_files').select('path,mime,content_b64').eq('path', path).single();
      if (e1 || !row) continue;
      const bin = Uint8Array.from(atob(row.content_b64), c => c.charCodeAt(0));
      const blob = new Blob([bin], { type: row.mime });
      const { error: e2 } = await client.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: row.mime });
      if (e2) throw e2;
      await db.put('files', { id: path, blob, dirty: 0 });
      await client.from('import_files').delete().eq('path', path);
      moved++;
      onProgress(moved, list.length);
    }
  } catch (err) {
    console.error('Error moviendo archivos importados', err);
  } finally {
    migrating = false;
  }
  return moved;
}

// Blob de un adjunto: primero el guardado en el dispositivo; si no está, se descarga y se guarda.
const inflight = new Map();
export async function fileBlob(path) {
  const rec = await db.get('files', path);
  if (rec) return rec.blob;
  if (!client || !user || !navigator.onLine) return null;
  if (inflight.has(path)) return inflight.get(path);
  const p = (async () => {
    const { data, error } = await client.storage.from(BUCKET).download(path);
    let blob = data;
    if (error) {
      const { data: row } = await client.from('import_files').select('mime,content_b64').eq('path', path).maybeSingle();
      if (!row) throw error;
      const bin = Uint8Array.from(atob(row.content_b64), c => c.charCodeAt(0));
      blob = new Blob([bin], { type: row.mime });
    }
    await db.put('files', { id: path, blob, dirty: 0 });
    return blob;
  })();
  inflight.set(path, p);
  try { return await p; } finally { inflight.delete(path); }
}

// Miniatura (≈200 px) guardada aparte para que la lista cargue rápido.
const thumbCache = new Map();
export async function thumbURL(path) {
  if (thumbCache.has(path)) return thumbCache.get(path);
  const key = `thumb:${path}`;
  let rec = await db.get('files', key);
  if (!rec) {
    const blob = await fileBlob(path);
    if (!blob) return null;
    let small = blob;
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 220 / Math.min(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      small = await new Promise(res => c.toBlob(b => res(b || blob), 'image/jpeg', 0.78));
    } catch { /* si no se puede achicar, se usa la original */ }
    rec = { id: key, blob: small, dirty: 0 };
    await db.put('files', rec);
  }
  const url = URL.createObjectURL(rec.blob);
  thumbCache.set(path, url);
  return url;
}

// Descarga en segundo plano los adjuntos que faltan en este dispositivo (de a 3 a la vez).
let prefetching = false;
export async function prefetchFiles(paths) {
  if (prefetching || !client || !user || !navigator.onLine || navigator.connection?.saveData) return;
  prefetching = true;
  try {
    const have = new Set(await db.getAllKeys('files'));
    const queue = paths.filter(p => !have.has(p));
    const worker = async () => {
      while (queue.length && navigator.onLine) {
        const p = queue.shift();
        try { await fileBlob(p); } catch { /* se reintenta en la próxima pasada */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    prefetching = false;
  }
}

export async function fileURL(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const blob = await fileBlob(path);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(path, url);
  return url;
}
