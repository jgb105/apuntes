// Importa un respaldo de UpNote (.upnx).
// Formato observado (UpNote 9.x): archivo gzip con texto "version:2" y luego una línea
// JSON por registro: {"type":"notebooks"|"organizers"|"tags"|"notes"|"files"|..., "data":{...}}.
// Las imágenes en el HTML apuntan a http://localhost:9425/<archivo>; los archivos vienen
// en la carpeta "files" del respaldo cuando se marca "Backup attachments".
import * as db from './db.js';
import { saveFile, filePrefix } from './sync.js';
import { UPNOTE_COVER_MAP } from './covers.js';

const LOCAL_FILE_PREFIX = 'http://localhost:9425/';
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm';

function revive(_k, v) {
  if (v && typeof v === 'object' && v.__type__ === 'Set') return new Set(v.__value__);
  if (v && typeof v === 'object' && v.__type__ === 'Map') return new Map(v.__value__);
  return v;
}

async function gunzipText(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  if (!isGzip) return file.text();
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function parseBackup(file) {
  const text = await gunzipText(file);
  const lines = text.split('\n');
  if (!lines[0].startsWith('version:')) {
    throw new Error('El archivo no parece un respaldo de UpNote (.upnx).');
  }
  const out = { version: lines[0].slice(8), notebooks: [], organizers: [], tags: [], notes: [], files: [], workspaces: [], lists: [] };
  let bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line, revive);
      if (out[rec.type]) out[rec.type].push(rec.data);
    } catch { bad++; }
  }
  out.badLines = bad;
  return out;
}

// Convierte un campo que puede venir como arreglo, Set, Map, objeto o texto JSON en lista de ids.
function idList(v) {
  if (!v) return [];
  if (typeof v === 'string') {
    try { return idList(JSON.parse(v, revive)); } catch { return v.split(',').map(s => s.trim()).filter(Boolean); }
  }
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x ? x.id ?? x[0] : x)).filter(Boolean);
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (typeof v === 'object') return Object.keys(v);
  return [];
}

const truthy = v => v === true || v === 1 || v === '1';
const num = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : d);

function fileNameVariants(name) {
  const decoded = (() => { try { return decodeURIComponent(name); } catch { return name; } })();
  const set = new Set([name, decoded]);
  for (const n of [...set]) {
    const i = n.lastIndexOf('__');
    if (i > 0) set.add(`${n.slice(0, i)}.${n.slice(i + 2)}`);
    const base = n.split('/').pop();
    set.add(base);
  }
  return [...set];
}

// Reúne archivos entregados como selección múltiple, carpeta o .zip → Map(nombre → Blob)
export async function collectAttachmentFiles(fileList) {
  const map = new Map();
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      const { default: JSZip } = await import(JSZIP);
      const zip = await JSZip.loadAsync(f);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const name = entry.name.split('/').pop();
        if (!name || name.startsWith('.')) continue;
        const blob = await entry.async('blob');
        map.set(name, new File([blob], name, { type: guessType(name) }));
      }
    } else {
      map.set(f.name, f);
    }
  }
  return map;
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', txt: 'text/plain' })[ext] || 'application/octet-stream';
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name) || /__([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1].toLowerCase() : 'bin';
}

export async function importBackup(backup, attachments = new Map(), onProgress = () => {}) {
  const now = Date.now();
  const report = { notebooks: 0, notes: 0, trashed: 0, filesLinked: 0, filesRemote: 0, filesMissing: [] };

  const lists = backup.lists || [];
  const key = (id) => String(id || '').toLowerCase();

  // Libretas
  const liveNotebooks = backup.notebooks.filter(n => !truthy(n.deleted));
  const nbIds = new Set(liveNotebooks.map(n => n.id));
  const notebooks = liveNotebooks.map((n, i) => ({
    id: n.id,
    title: n.title || 'Sin título',
    parent_id: n.parent && nbIds.has(n.parent) ? n.parent : null,
    sort_order: i,
    deleted: false,
    created_at: num(n.createdAt, now),
    updated_at: num(n.updatedAt, now),
    _dirty: 1,
  }));

  // Nota ↔ libreta. UpNote 9 lo guarda en "lists" (id "notebooks_<libreta>", contenido = ids de notas);
  // versiones anteriores usaban la tabla "organizers". Se aceptan ambas. Ids sin distinguir mayúsculas.
  const noteNotebooks = new Map();
  const link = (noteId, nbId) => {
    if (!nbIds.has(nbId)) return;
    const k = key(noteId);
    if (!noteNotebooks.has(k)) noteNotebooks.set(k, new Set());
    noteNotebooks.get(k).add(nbId);
  };
  for (const o of backup.organizers) if (!truthy(o.deleted)) link(o.noteId, o.notebookId);
  const bookmarkedIds = new Set();
  for (const l of lists) {
    if (truthy(l.deleted) || typeof l.id !== 'string') continue;
    if (l.id.startsWith('notebooks_')) for (const noteId of idList(l.content)) link(noteId, l.id.slice(10));
    else if (l.id === 'bookmarkedNotes') for (const noteId of idList(l.content)) bookmarkedIds.add(key(noteId));
  }

  // Plantillas de UpNote: se importan como notas normales dentro de una libreta "Plantillas".
  const hasTemplates = backup.notes.some(n => truthy(n.isTemplate) && !truthy(n.deleted) && !truthy(n.trashed));
  if (hasTemplates) {
    const tplId = 'upnote-plantillas';
    nbIds.add(tplId);
    notebooks.push({ id: tplId, title: 'Plantillas', parent_id: null, sort_order: notebooks.length, deleted: false,
      created_at: now, updated_at: now, _dirty: 1 });
  }

  // Etiquetas: se guardan por nombre en cada nota
  const tagTitle = new Map();
  const noteTags = new Map();
  const addTag = (noteId, title) => {
    if (!title) return;
    if (!noteTags.has(noteId)) noteTags.set(noteId, new Set());
    noteTags.get(noteId).add(title);
  };
  for (const t of backup.tags) {
    if (truthy(t.deleted)) continue;
    tagTitle.set(t.id, t.title);
    for (const noteId of idList(t.notes)) addTag(noteId, t.title);
  }

  // Archivos registrados en UpNote (para URLs remotas de respaldo)
  const fileRows = new Map();
  for (const f of backup.files) {
    if (truthy(f.deleted)) continue;
    for (const k of [f.id, f.name].filter(Boolean)) for (const v of fileNameVariants(k)) fileRows.set(v, f);
  }
  const attachByName = new Map();
  for (const [name, blob] of attachments) for (const v of fileNameVariants(name)) attachByName.set(v, blob);

  const uploaded = new Map(); // nombre original → ruta propia
  async function resolveLocalRef(ref) {
    const name = ref.slice(LOCAL_FILE_PREFIX.length).split(/[?#]/)[0];
    if (uploaded.has(name)) return { path: uploaded.get(name) };
    const variants = fileNameVariants(name);
    const blob = variants.map(v => attachByName.get(v)).find(Boolean);
    if (blob) {
      const ext = extOf(blob.name || name);
      const path = `${filePrefix()}/${crypto.randomUUID()}.${ext}`;
      const typed = blob.type ? blob : new Blob([blob], { type: guessType(`x.${ext}`) });
      await saveFile(path, typed);
      uploaded.set(name, path);
      report.filesLinked++;
      return { path };
    }
    const row = variants.map(v => fileRows.get(v)).find(Boolean);
    if (row?.downloadURL) { report.filesRemote++; return { url: row.downloadURL }; }
    report.filesMissing.push(name);
    return null;
  }

  // Portadas de libretas: las predeterminadas de UpNote → dibujo propio parecido; las subidas por el usuario → su imagen.
  for (const nb of notebooks) {
    const raw = String(liveNotebooks.find(x => x.id === nb.id)?.cover || '');
    if (!raw) continue;
    if (UPNOTE_COVER_MAP[raw]) nb.cover = `preset:${UPNOTE_COVER_MAP[raw]}`;
    else if (raw.includes('__')) {
      const name = raw.replace('__', '.');
      if (fileNameVariants(name).some(v => attachByName.has(v))) {
        const r = await resolveLocalRef(`${LOCAL_FILE_PREFIX}images/${name}`);
        if (r?.path) nb.cover = `file:${r.path}`;
      }
    }
  }

  const parser = new DOMParser();
  const liveNotes = backup.notes.filter(n => !truthy(n.deleted));
  const notes = [];
  let i = 0;
  for (const n of liveNotes) {
    i++;
    if (i % 25 === 0) onProgress(`Procesando notas ${i}/${liveNotes.length}…`);
    for (const tagId of idList(n.tagLinks)) addTag(n.id, tagTitle.get(tagId));
    for (const nbId of idList(n.notebookLinks)) link(n.id, nbId);
    if (truthy(n.isTemplate)) link(n.id, 'upnote-plantillas');

    const doc = parser.parseFromString(`<body>${n.html || ''}</body>`, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith(LOCAL_FILE_PREFIX)) continue;
      const r = await resolveLocalRef(src);
      if (r?.path) { img.setAttribute('data-file', r.path); img.removeAttribute('src'); }
      else if (r?.url) img.setAttribute('src', r.url);
    }
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith(LOCAL_FILE_PREFIX)) continue;
      const r = await resolveLocalRef(href);
      if (r?.path) { a.setAttribute('data-file', r.path); a.setAttribute('href', '#'); }
      else if (r?.url) a.setAttribute('href', r.url);
    }
    const html = doc.body.innerHTML;
    const text = (n.text || doc.body.textContent || '').trim();
    const title = (n.title || firstLine(doc.body) || text.split('\n')[0] || '').slice(0, 200);
    const trashed = truthy(n.trashed);
    if (trashed) report.trashed++;
    notes.push({
      id: n.id,
      title,
      html,
      text,
      notebook_ids: [...(noteNotebooks.get(key(n.id)) || [])],
      tags: [...(noteTags.get(n.id) || [])],
      pinned: truthy(n.pinned),
      bookmarked: truthy(n.bookmarked) || bookmarkedIds.has(key(n.id)),
      trashed,
      deleted: false,
      created_at: num(n.createdAt, now),
      updated_at: num(n.updatedAt, now),
      _dirty: 1,
    });
  }

  onProgress('Guardando en el dispositivo…');
  await db.putMany('notebooks', notebooks);
  await db.putMany('notes', notes);
  report.notebooks = notebooks.length;
  report.notes = notes.length;
  report.filesMissing = [...new Set(report.filesMissing)];
  return report;
}

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,div,li,blockquote,pre';
export function firstLine(root) {
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue; // solo bloques "hoja"
    const t = el.textContent.trim();
    if (t) return t.split('\n')[0].trim();
  }
  return root.textContent.trim().split('\n')[0] || '';
}
