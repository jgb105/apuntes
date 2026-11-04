import * as db from './db.js';
import * as sync from './sync.js';
import { CONFIG } from '../config.js';
import { sanitize, serialize, runCommand, handleChecklistClick, fixNewChecklistItem,
  compressImage, toMarkdown, closestIn } from './editor.js';
import { firstLine } from './importer.js';

export const APP_VERSION = '1.1.1';

const $ = (s) => document.querySelector(s);
const el = {
  setup: $('#setup'), setupForm: $('#setupForm'), setupError: $('#setupError'), cfgFields: $('#cfgFields'),
  app: $('#app'), tree: $('#notebookTree'), tagList: $('#tagList'), noteList: $('#noteList'),
  listTitle: $('#listTitle'), listEmpty: $('#listEmpty'), search: $('#search'), sort: $('#sort'),
  editorPane: $('#editorPane'), editor: $('#editor'), editorScroll: $('#editorScroll'),
  saveState: $('#saveState'), noteNotebooks: $('#noteNotebooks'), btnPin: $('#btnPin'), btnFav: $('#btnFav'),
  moreMenu: $('#moreMenu'), tagChips: $('#tagChips'), tagInput: $('#tagInput'), noteDates: $('#noteDates'),
  trashBanner: $('#trashBanner'), trashBar: $('#trashBar'), toolbar: $('#toolbar'),
  syncStatus: $('#syncStatus'), syncText: $('#syncText'), toast: $('#toast'),
  subNbs: $('#subNbs'), listScroll: $('#listScroll'), btnMenu: $('#btnMenu'), syncMini: $('#btnSyncMini'),
  listMenu: $('#listMenu'), lightbox: $('#lightbox'), lbImg: $('#lbImg'), lbScroll: $('#lbScroll'),
};
const ICON = {
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};

const state = {
  notes: new Map(),
  notebooks: new Map(),
  view: { type: 'all', id: null },
  query: '',
  sort: localStorage.getItem('apuntes_sort') || 'updated',
  currentId: null,
  openNbs: new Set(JSON.parse(localStorage.getItem('apuntes_open_nbs') || '[]')),
  mode: 'local', // 'cloud' | 'local'
};

// ---------------- Utilidades ----------------
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const norm = (s) => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('es-CL', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Hoy, ${time}`;
  const opts = d.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${d.toLocaleDateString('es-CL', opts)}, ${time}`;
}

// Ícono de color para cada libreta (estable según su id).
function nbTile(nb) {
  let h = 0;
  for (const c of nb.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = esc((nb.title || '?').trim().charAt(0) || '?');
  return `<i class="nb-tile" style="--h:${h}" aria-hidden="true">${letter}</i>`;
}

const isAlive = (n) => n && !n.deleted;
// Las plantillas de UpNote viven en su propia libreta y no se cuentan en "Todas las notas" (igual que en UpNote).
const TEMPLATES_NB = 'upnote-plantillas';
const isTemplate = (n) => (n.notebook_ids || []).includes(TEMPLATES_NB);
const isNarrow = () => matchMedia('(max-width: 760px)').matches;
const isDrawer = () => matchMedia('(max-width: 1100px)').matches;

// Otras pestañas/ventanas abiertas en el mismo dispositivo se enteran al instante de los cambios.
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('apuntes') : null;
function tellTabs() { try { tabs?.postMessage({ type: 'changed' }); } catch { /* nada */ } }

async function persist(store, rec) {
  rec._dirty = 1;
  (store === 'notes' ? state.notes : state.notebooks).set(rec.id, rec);
  await db.put(store, rec);
  sync.schedulePush();
  tellTabs();
}

// ---------------- Arranque ----------------
async function boot() {
  $('#appVersion').textContent = APP_VERSION;
  registerSW();
  const cfg = loadConfig();
  if (localStorage.getItem('apuntes_local_only') === '1') {
    state.mode = 'local';
    return startApp();
  }
  if (!cfg) return showSetup({ needConfig: true });
  try {
    const user = await sync.init(cfg);
    state.mode = 'cloud';
    if (!user) return showSetup({ needConfig: false });
    return startApp();
  } catch (err) {
    console.error(err);
    // Sin conexión en el primer arranque: si ya hay datos locales, abrir igual.
    if ((await db.getAll('notes')).length) { state.mode = 'local'; return startApp(true); }
    return showSetup({ needConfig: !CONFIG.supabaseUrl, error: 'No se pudo conectar. Revisa tu conexión.' });
  }
}

function loadConfig() {
  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) return { url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey };
  try {
    const c = JSON.parse(localStorage.getItem('apuntes_cfg') || 'null');
    if (c?.url && c?.key) return c;
  } catch { /* nada */ }
  return null;
}

function showSetup({ needConfig, error = '' }) {
  el.app.classList.add('hidden');
  el.setup.classList.remove('hidden');
  el.cfgFields.classList.toggle('hidden', !needConfig);
  for (const i of el.cfgFields.querySelectorAll('input')) i.required = needConfig;
  el.setupError.textContent = error;
}

async function handleAuth(kind) {
  const f = el.setupForm;
  el.setupError.textContent = '';
  if (!f.reportValidity()) return;
  const btns = f.querySelectorAll('button');
  btns.forEach(b => b.disabled = true);
  try {
    if (!el.cfgFields.classList.contains('hidden')) {
      const cfg = { url: f.url.value.trim().replace(/\/+$/, ''), key: f.key.value.trim() };
      await sync.init(cfg);
      localStorage.setItem('apuntes_cfg', JSON.stringify(cfg));
    }
    const email = f.email.value.trim();
    const password = f.password.value;
    if (kind === 'signup') {
      const res = await sync.signUp(email, password);
      if (!res.session) {
        el.setupError.textContent = 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.';
        return;
      }
    } else {
      await sync.signIn(email, password);
    }
    localStorage.removeItem('apuntes_local_only');
    state.mode = 'cloud';
    el.setup.classList.add('hidden');
    await startApp();
  } catch (err) {
    el.setupError.textContent = traducirError(err);
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}

function traducirError(err) {
  const m = err?.message || String(err);
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Email not confirmed/i.test(m)) return 'Falta confirmar el correo (revisa tu bandeja).';
  if (/Signups not allowed/i.test(m)) return 'El registro de cuentas nuevas está desactivado.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No se pudo conectar. Revisa la URL y tu conexión.';
  if (/Invalid API key|apikey/i.test(m)) return 'La clave pública no es válida.';
  return m;
}

async function startApp(offlineFallback = false) {
  el.setup.classList.add('hidden');
  el.app.classList.remove('hidden');
  el.sort.value = state.sort;
  await loadLocal();
  renderAll();
  if (state.mode === 'cloud') {
    sync.on('status', setSyncStatus);
    sync.on('change', () => { onRemoteChange(); tellTabs(); prefetchSoon(); });
    sync.startRealtime();
    sync.syncNow().then(() => sync.migrateImportedFiles((n, total) => setSyncStatus('syncing', '', `Moviendo imágenes migradas ${n}/${total}…`)))
      .then((n) => { if (n) { setSyncStatus('ok'); toast(`${n} imágenes migradas listas`); } })
      .finally(() => prefetchSoon(1500));
    setInterval(() => sync.syncNow(), 30_000);
    addEventListener('online', () => { sync.ensureRealtime(); sync.syncNow(); });
    addEventListener('offline', () => setSyncStatus('offline'));
    addEventListener('focus', () => { sync.ensureRealtime(); sync.syncNow(); });
    addEventListener('pageshow', () => { sync.ensureRealtime(); sync.syncNow(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { sync.ensureRealtime(); sync.syncNow(); }
      else flushSave();
    });
  } else {
    setSyncStatus(offlineFallback ? 'offline' : 'local');
  }
  addEventListener('pagehide', flushSave);
  if (tabs) tabs.onmessage = (e) => { if (e.data?.type === 'changed') onRemoteChange(); };
  const last = localStorage.getItem('apuntes_last_note');
  if (!isNarrow() && last && state.notes.get(last) && isAlive(state.notes.get(last))) openNote(last);
}

async function loadLocal() {
  const [notes, nbs] = await Promise.all([db.getAll('notes'), db.getAll('notebooks')]);
  state.notes = new Map(notes.map(n => [n.id, n]));
  state.notebooks = new Map(nbs.map(n => [n.id, n]));
}

async function onRemoteChange() {
  const cur = state.currentId ? state.notes.get(state.currentId) : null;
  await loadLocal();
  renderSidebar();
  renderList();
  // Si la nota abierta cambió en otro dispositivo y no la estoy editando, refrescarla.
  const fresh = state.currentId ? state.notes.get(state.currentId) : null;
  if (cur && fresh && fresh.updated_at !== cur.updated_at && !saveTimer && document.activeElement !== el.editor) {
    openNote(fresh.id, { keepView: true });
  } else if (cur && (!fresh || fresh.deleted)) {
    closeNote();
  }
}

function setSyncStatus(s, detail, custom) {
  el.syncMini.dataset.s = s;
  if (custom) { el.syncStatus.dataset.s = s; el.syncText.textContent = custom; el.syncMini.title = custom; return; }
  const labels = {
    ok: 'Sincronizado', syncing: 'Sincronizando…', offline: 'Sin conexión · guardado en el dispositivo',
    error: `Error: ${detail || ''}`, local: 'Solo en este dispositivo',
  };
  el.syncStatus.dataset.s = s;
  el.syncText.textContent = labels[s] || s;
  el.syncStatus.title = labels[s] || s;
  el.syncMini.title = labels[s] || s;
}

// ---------------- Barra lateral ----------------
function aliveNotes() { return [...state.notes.values()].filter(n => isAlive(n) && !n.trashed); }
function aliveNotebooks() { return [...state.notebooks.values()].filter(isAlive); }

function childrenOf(parentId) {
  return aliveNotebooks().filter(n => (n.parent_id || null) === parentId && (n.parent_id ? state.notebooks.get(n.parent_id) && isAlive(state.notebooks.get(n.parent_id)) : true))
    .sort((a, b) => collator.compare(a.title, b.title));
}

function descendantIds(id) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of aliveNotebooks()) if (c.parent_id === cur && !out.has(c.id)) { out.add(c.id); stack.push(c.id); }
  }
  return out;
}

function renderSidebar() {
  const alive = aliveNotes();
  $('#cntAll').textContent = alive.filter(n => !isTemplate(n)).length || '';
  $('#cntFav').textContent = alive.filter(n => n.bookmarked).length || '';
  $('#cntTrash').textContent = [...state.notes.values()].filter(n => isAlive(n) && n.trashed).length || '';

  const counts = new Map();
  for (const n of alive) for (const id of n.notebook_ids || []) counts.set(id, (counts.get(id) || 0) + 1);

  const chevron = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
  const dots = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';
  const build = (parentId) => childrenOf(parentId).map(nb => {
    const kids = childrenOf(nb.id);
    const open = state.openNbs.has(nb.id);
    const active = state.view.type === 'notebook' && state.view.id === nb.id;
    return `<li>
      <div class="nb-row">
        <button class="twisty ${kids.length ? '' : 'leaf'} ${open ? 'open' : ''}" data-twisty="${esc(nb.id)}" aria-label="Expandir">${chevron}</button>
        <button class="nb ${active ? 'active' : ''}" data-nb="${esc(nb.id)}">${nbTile(nb)}<span>${esc(nb.title)}</span><em>${counts.get(nb.id) || ''}</em></button>
        <button class="icon-btn sm nb-menu" data-nbmenu="${esc(nb.id)}" aria-label="Opciones de libreta">${dots}</button>
      </div>
      ${kids.length && open ? `<ul>${build(nb.id)}</ul>` : ''}
    </li>`;
  }).join('');
  el.tree.innerHTML = build(null) || '<li class="muted small" style="padding:4px 10px">Sin libretas</li>';

  const tagCount = new Map();
  for (const n of alive) for (const t of n.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const hash = '<svg viewBox="0 0 24 24"><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>';
  el.tagList.innerHTML = [...tagCount.keys()].sort(collator.compare).map(t =>
    `<li><button data-tag="${esc(t)}" class="${state.view.type === 'tag' && state.view.id === t ? 'active' : ''}">${hash}<span>${esc(t)}</span><em>${tagCount.get(t)}</em></button></li>`
  ).join('');
  $('#tagSection').classList.toggle('hidden', !tagCount.size);

  for (const b of document.querySelectorAll('#navFixed button')) b.classList.toggle('active', b.dataset.nav === state.view.type);
}

function setView(view) {
  state.view = view;
  if (view.type === 'notebook') { // abrir en el árbol las libretas que la contienen
    let p = state.notebooks.get(view.id)?.parent_id;
    while (p && !state.openNbs.has(p)) { state.openNbs.add(p); p = state.notebooks.get(p)?.parent_id; }
    saveOpenNbs();
  }
  state.query = '';
  el.search.value = '';
  el.app.classList.remove('nav-open');
  renderSidebar();
  renderList();
  el.listScroll.scrollTop = 0;
  if (isNarrow()) el.app.dataset.view = 'list';
}

// ---------------- Lista de notas ----------------
function viewNotes() {
  const all = [...state.notes.values()].filter(isAlive);
  const v = state.view;
  let list;
  if (v.type === 'trash') list = all.filter(n => n.trashed);
  else {
    list = all.filter(n => !n.trashed);
    if (v.type === 'all') list = list.filter(n => !isTemplate(n));
    if (v.type === 'fav') list = list.filter(n => n.bookmarked);
    else if (v.type === 'notebook') {
      const ids = childrenOf(v.id).length ? new Set([v.id]) : descendantIds(v.id);
      list = list.filter(n => (n.notebook_ids || []).some(id => ids.has(id)));
    } else if (v.type === 'tag') list = list.filter(n => (n.tags || []).includes(v.id));
  }
  const q = norm(state.query.trim());
  if (q && v.type === 'notebook' && childrenOf(v.id).length) {
    const ids = descendantIds(v.id);
    list = all.filter(n => !n.trashed && (n.notebook_ids || []).some(id => ids.has(id)));
  }
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter(n => { const hay = norm(`${n.title}\n${n.text}\n${(n.tags || []).join(' ')}`); return words.every(w => hay.includes(w)); });
  }
  const by = {
    updated: (a, b) => b.updated_at - a.updated_at,
    created: (a, b) => b.created_at - a.created_at,
    title: (a, b) => collator.compare(a.title || '', b.title || ''),
  }[state.sort];
  return list.sort((a, b) => (v.type !== 'trash' && (b.pinned - a.pinned)) || by(a, b));
}

function viewTitle() {
  const v = state.view;
  if (v.type === 'fav') return 'Favoritos';
  if (v.type === 'trash') return 'Papelera';
  if (v.type === 'notebook') return state.notebooks.get(v.id)?.title || 'Libreta';
  if (v.type === 'tag') return `# ${v.id}`;
  return 'Todas las notas';
}

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return safe;
  // Resalta coincidencias ignorando tildes: se busca sobre la versión normalizada, carácter a carácter.
  const base = norm(text);
  if (base.length !== text.length) return safe;
  const marks = new Array(text.length).fill(false);
  for (const w of words) { let i = base.indexOf(w); while (i >= 0) { for (let k = i; k < i + w.length; k++) marks[k] = true; i = base.indexOf(w, i + w.length); } }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

function snippetFor(n) {
  const text = (n.text || '').replace(/\s+/g, ' ').trim();
  const title = (n.title || '').trim();
  let s = text.startsWith(title) ? text.slice(title.length).trim() : text;
  const q = norm(state.query.trim()).split(/\s+/)[0];
  if (q) {
    const i = norm(s).indexOf(q);
    if (i > 60) s = '…' + s.slice(i - 40);
  }
  return s.slice(0, 220);
}

function firstImage(n) {
  const m = /<img[^>]*data-file="([^"]+)"/i.exec(n.html || '');
  return m ? m[1] : null;
}
function imageCount(n) { return ((n.html || '').match(/<img[^>]*data-file=/gi) || []).length; }

function renderHeader() {
  const v = state.view;
  const nb = v.type === 'notebook' ? state.notebooks.get(v.id) : null;
  const parent = nb?.parent_id ? state.notebooks.get(nb.parent_id) : null;
  const back = !!(parent && isAlive(parent));
  el.btnMenu.innerHTML = back ? ICON.back : ICON.menu;
  el.btnMenu.setAttribute('aria-label', back ? `Volver a ${parent.title}` : 'Menú');
  el.btnMenu.dataset.back = back ? parent.id : '';
}

function renderSubNotebooks() {
  const v = state.view;
  if (v.type !== 'notebook' || state.query.trim()) { el.subNbs.innerHTML = ''; return; }
  const counts = new Map();
  for (const n of aliveNotes()) for (const id of n.notebook_ids || []) counts.set(id, (counts.get(id) || 0) + 1);
  el.subNbs.innerHTML = childrenOf(v.id).map(nb => `<li><button data-subnb="${esc(nb.id)}">${nbTile(nb)}<span>${esc(nb.title)}</span><em>${counts.get(nb.id) || ''}</em>${childrenOf(nb.id).length ? ICON.chevron : ''}</button></li>`).join('');
}

function renderList() {
  el.listTitle.textContent = viewTitle();
  el.trashBar.classList.toggle('hidden', state.view.type !== 'trash');
  renderHeader();
  renderSubNotebooks();
  const notes = viewNotes();
  const pin = '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 4H6l4-4ZM12 14v7"/></svg>';
  const star = '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>';
  const shown = notes.slice(0, 600); // lista larga: se muestran las primeras 600 (la búsqueda filtra todas)
  el.noteList.innerHTML = shown.map(n => {
    const nbNames = (n.notebook_ids || []).map(id => state.notebooks.get(id)).filter(isAlive).map(nb => nb.title).join(', ');
    const date = state.sort === 'created' ? n.created_at : n.updated_at;
    const img = firstImage(n);
    const nImg = img ? imageCount(n) : 0;
    const snip = highlight(snippetFor(n), state.query) || (nImg ? `${nImg} ${nImg === 1 ? 'imagen' : 'imágenes'}` : '&nbsp;');
    const showNb = nbNames && !(state.view.type === 'notebook' && (n.notebook_ids || []).includes(state.view.id));
    return `<li><button class="note-item ${n.id === state.currentId ? 'active' : ''}" data-note="${esc(n.id)}">
      <div class="body">
        <div class="t">${n.pinned && state.view.type !== 'trash' ? pin : ''}<span>${highlight(n.title || 'Nota sin título', state.query)}</span>${n.bookmarked ? star : ''}</div>
        <div class="s">${snip}</div>
        <div class="m"><span>${fmtDate(date)}</span>${showNb ? `<span>· ${esc(nbNames)}</span>` : ''}</div>
      </div>
      ${img ? `<span class="thumb" data-thumb="${esc(img)}"></span>` : ''}
    </button></li>`;
  }).join('') + (notes.length > shown.length ? `<li class="list-empty">… y ${notes.length - shown.length} más. Usa la búsqueda.</li>` : '');
  observeThumbs();
  el.listEmpty.classList.toggle('hidden', notes.length > 0 || !!el.subNbs.children.length);
  if (state.query && !notes.length) el.listEmpty.textContent = 'Sin resultados.';
  else el.listEmpty.textContent = 'No hay notas aquí.';
}

function renderAll() { renderSidebar(); renderList(); }

// Miniaturas: se cargan solo cuando la nota aparece en pantalla.
const thumbIO = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbIO.unobserve(e.target);
    loadThumb(e.target);
  }
}, { root: null, rootMargin: '300px 0px' }) : null;

function observeThumbs() {
  for (const t of el.noteList.querySelectorAll('.thumb[data-thumb]')) {
    if (thumbIO) thumbIO.observe(t); else loadThumb(t);
  }
}
function loadThumb(node) {
  sync.thumbURL(node.dataset.thumb).then(url => { if (url) node.style.backgroundImage = `url("${url}")`; }).catch(() => {});
}

// Precarga en segundo plano todas las imágenes, para verlas al instante y sin conexión.
let prefetchTimer = null;
function prefetchSoon(ms = 4000) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const paths = new Set();
    for (const n of aliveNotes()) for (const m of (n.html || '').matchAll(/data-file="([^"]+)"/g)) paths.add(m[1]);
    sync.prefetchFiles([...paths]);
  }, ms);
}

// ---------------- Editor ----------------
let saveTimer = null;
let dirtyEditor = false;

async function openNote(id, { keepView = false } = {}) {
  if (state.currentId && state.currentId !== id) await flushSave(true);
  const n = state.notes.get(id);
  if (!n) return;
  state.currentId = id;
  localStorage.setItem('apuntes_last_note', id);
  el.editorPane.classList.add('has-note');
  el.editor.innerHTML = sanitize(n.html);
  hydrateFiles(el.editor);
  el.editor.contentEditable = n.trashed ? 'false' : 'true';
  el.toolbar.classList.toggle('hidden', !!n.trashed);
  el.trashBanner.classList.toggle('hidden', !n.trashed);
  el.saveState.textContent = '';
  dirtyEditor = false;
  renderNoteMeta();
  for (const b of el.noteList.querySelectorAll('.note-item')) b.classList.toggle('active', b.dataset.note === id);
  if (!keepView) {
    el.editorScroll.scrollTop = 0;
    if (isNarrow()) {
      if (el.app.dataset.view !== 'editor') history.pushState({ apuntes: 'editor' }, '');
      el.app.dataset.view = 'editor';
    }
  }
}

function closeNote() {
  state.currentId = null;
  el.editorPane.classList.remove('has-note');
  el.editor.innerHTML = '';
  if (isNarrow()) el.app.dataset.view = 'list';
}

function renderNoteMeta() {
  const n = state.notes.get(state.currentId);
  if (!n) return;
  const names = (n.notebook_ids || []).map(id => state.notebooks.get(id)).filter(isAlive).map(nb => nb.title);
  el.noteNotebooks.textContent = names.length ? names.join(', ') : 'Sin libreta';
  el.btnPin.classList.toggle('on', !!n.pinned);
  el.btnFav.classList.toggle('on', !!n.bookmarked);
  el.tagChips.innerHTML = (n.tags || []).map(t => `<span class="tag">${esc(t)}<button data-untag="${esc(t)}" aria-label="Quitar etiqueta ${esc(t)}">×</button></span>`).join('');
  el.tagInput.disabled = !!n.trashed;
  el.noteDates.textContent = `Creada ${new Date(n.created_at).toLocaleString('es-CL')} · Editada ${new Date(n.updated_at).toLocaleString('es-CL')}`;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
async function hydrateFiles(root) {
  const forNote = state.currentId;
  for (const img of root.querySelectorAll('img[data-file]')) {
    img.classList.add('loading');
    img.decoding = 'async';
    const load = (tries) => sync.fileURL(img.dataset.file).then(url => {
      if (url) {
        img.onload = () => { if (img.naturalWidth >= 320) img.classList.add('wide'); };
        img.src = url; img.classList.remove('loading');
      }
    }).catch(() => {
      if (tries > 0 && state.currentId === forNote) setTimeout(() => load(tries - 1), 2500);
      else img.alt = navigator.onLine ? 'No se pudo cargar la imagen' : 'Imagen no disponible sin conexión';
    });
    load(2);
  }
  for (const a of root.querySelectorAll('a[data-file]')) {
    if (!VIDEO_EXT.test(a.dataset.file) || a.nextElementSibling?.dataset?.ephemeral) continue;
    const v = document.createElement('video');
    Object.assign(v, { controls: true, playsInline: true, preload: 'metadata' });
    v.dataset.ephemeral = '1';
    v.contentEditable = 'false';
    a.after(v);
    sync.fileURL(a.dataset.file).then(url => { if (url) v.src = url; }).catch(() => v.remove());
  }
}

// Visor de imágenes a pantalla completa (tocar para acercar).
function openLightbox(src) {
  el.lbImg.src = src;
  el.lbScroll.classList.remove('zoom');
  el.lightbox.classList.remove('hidden');
  history.pushState({ apuntes: 'lightbox' }, '');
}
function closeLightbox(fromHistory = false) {
  if (el.lightbox.classList.contains('hidden')) return;
  el.lightbox.classList.add('hidden');
  el.lbImg.removeAttribute('src');
  if (!fromHistory && history.state?.apuntes === 'lightbox') history.back();
}

function scheduleSave() {
  dirtyEditor = true;
  el.saveState.textContent = 'Editando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 700);
}

async function flushSave(leaving = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const n = state.notes.get(state.currentId);
  if (!n) return;
  if (dirtyEditor) {
    dirtyEditor = false;
    const html = serialize(el.editor);
    const text = el.editor.innerText.replace(/ /g, ' ').trim();
    if (html !== n.html) {
      const next = { ...n, html, text, title: firstLine(el.editor).slice(0, 200), updated_at: now() };
      await persist('notes', next);
      el.saveState.textContent = 'Guardado';
      if (state.currentId === next.id) renderNoteMeta();
      renderListItemOnly(next);
    }
  }
  // Nota nueva que quedó vacía: se descarta al salir.
  const cur = state.notes.get(state.currentId);
  if (leaving && cur && !cur.text && !/<img/i.test(cur.html) && now() - cur.created_at < 30 * 60_000) {
    await persist('notes', { ...cur, deleted: true, updated_at: now() });
    renderAll();
  }
}

function renderListItemOnly(n) {
  // Reordenar al editar solo si la lista está por fecha de edición; si no, refrescar en su lugar.
  renderList();
  renderSidebarCountsSoon();
}
let sideTimer = null;
function renderSidebarCountsSoon() { clearTimeout(sideTimer); sideTimer = setTimeout(renderSidebar, 400); }

async function newNote() {
  await flushSave(true);
  const v = state.view;
  const n = {
    id: uid(), title: '', html: '<h1><br></h1>', text: '',
    notebook_ids: v.type === 'notebook' ? [v.id] : [],
    tags: v.type === 'tag' ? [v.id] : [],
    pinned: false, bookmarked: v.type === 'fav', trashed: false, deleted: false,
    created_at: now(), updated_at: now(),
  };
  if (v.type === 'trash') setView({ type: 'all' });
  await persist('notes', n);
  renderAll();
  await openNote(n.id);
  el.editor.focus();
  const h = el.editor.querySelector('h1');
  if (h) { const r = document.createRange(); r.setStart(h, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}

async function updateCurrent(patch) {
  const n = state.notes.get(state.currentId);
  if (!n) return;
  await persist('notes', { ...n, ...patch, updated_at: now() });
  renderNoteMeta();
  renderAll();
}

// ---------------- Diálogos ----------------
function ask(title, value = '') {
  const dlg = $('#dlgAsk');
  $('#askTitle').textContent = title;
  const input = $('#askInput');
  input.value = value;
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
    dlg.returnValue = '';
    dlg.showModal();
    input.select();
  });
}

function pickNotebooks() {
  const n = state.notes.get(state.currentId);
  if (!n) return;
  const dlg = $('#dlgPick');
  const selected = new Set(n.notebook_ids || []);
  const rows = [];
  const walk = (parentId, depth) => {
    for (const nb of childrenOf(parentId)) {
      rows.push(`<li><label style="padding-left:${depth * 18 + 4}px"><input type="checkbox" value="${esc(nb.id)}" ${selected.has(nb.id) ? 'checked' : ''}>${esc(nb.title)}</label></li>`);
      walk(nb.id, depth + 1);
    }
  };
  walk(null, 0);
  $('#pickList').innerHTML = rows.join('') || '<li class="muted">Primero crea una libreta (+ en la barra lateral).</li>';
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const ids = [...dlg.querySelectorAll('input:checked')].map(i => i.value);
    await updateCurrent({ notebook_ids: ids });
  };
  dlg.showModal();
}

async function notebookMenu(id, anchor) {
  const nb = state.notebooks.get(id);
  if (!nb) return;
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `<button data-a="sub">Nueva sublibreta</button><button data-a="ren">Renombrar</button><button data-a="del" class="danger">Eliminar libreta</button>`;
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, { position: 'fixed', left: `${Math.min(r.left, innerWidth - 220)}px`, top: `${r.bottom + 4}px`, right: 'auto' });
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  menu.onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'sub') {
      const title = await ask('Nombre de la sublibreta');
      if (title) { await createNotebook(title, id); state.openNbs.add(id); saveOpenNbs(); renderSidebar(); }
    } else if (a === 'ren') {
      const title = await ask('Renombrar libreta', nb.title);
      if (title) { await persist('notebooks', { ...nb, title, updated_at: now() }); renderAll(); renderNoteMeta(); }
    } else if (a === 'del') {
      if (!confirm(`¿Eliminar la libreta "${nb.title}"? Las notas no se borran; las sublibretas suben un nivel.`)) return;
      for (const child of aliveNotebooks().filter(c => c.parent_id === id)) {
        await persist('notebooks', { ...child, parent_id: nb.parent_id || null, updated_at: now() });
      }
      for (const n of [...state.notes.values()].filter(n => isAlive(n) && (n.notebook_ids || []).includes(id))) {
        await persist('notes', { ...n, notebook_ids: n.notebook_ids.filter(x => x !== id), updated_at: now() });
      }
      await persist('notebooks', { ...nb, deleted: true, updated_at: now() });
      if (state.view.type === 'notebook' && state.view.id === id) state.view = { type: 'all' };
      renderAll(); renderNoteMeta();
    }
  };
}

async function createNotebook(title, parentId = null) {
  const nb = { id: uid(), title, parent_id: parentId, sort_order: 0, deleted: false, created_at: now(), updated_at: now() };
  await persist('notebooks', nb);
  return nb;
}
function saveOpenNbs() { localStorage.setItem('apuntes_open_nbs', JSON.stringify([...state.openNbs])); }

// ---------------- Copias de seguridad ----------------
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportAll() {
  const clean = (r) => { const { _dirty, ...rest } = r; return rest; };
  const data = {
    app: 'apuntes', version: 1, exported_at: new Date().toISOString(),
    notebooks: aliveNotebooks().map(clean),
    notes: [...state.notes.values()].filter(isAlive).map(clean),
  };
  download(`apuntes-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}

async function restoreBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'apuntes') throw new Error('No es una copia de Apuntes.');
  const t = now();
  const nbs = (data.notebooks || []).map(n => ({ ...n, updated_at: Math.max(n.updated_at || 0, t), _dirty: 1 }));
  const notes = (data.notes || []).map(n => ({ ...n, updated_at: Math.max(n.updated_at || 0, t), _dirty: 1 }));
  await db.putMany('notebooks', nbs);
  await db.putMany('notes', notes);
  await loadLocal();
  renderAll();
  sync.schedulePush(200);
  toast(`Restauradas ${notes.length} notas`);
}

async function runImport() {
  const status = $('#impStatus');
  const backupFile = $('#impBackup').files[0];
  if (!backupFile) { status.textContent = 'Elige primero el archivo .upnx'; return; }
  const btn = $('#impRun');
  btn.disabled = true;
  try {
    const { parseBackup, importBackup, collectAttachmentFiles } = await import('./importer.js');
    status.textContent = 'Leyendo respaldo…';
    const backup = await parseBackup(backupFile);
    status.textContent = `Respaldo leído: ${backup.notes.length} notas, ${backup.notebooks.length} libretas, ${backup.tags.length} etiquetas.`;
    const files = [...$('#impFolder').files, ...$('#impFiles').files];
    const attachments = files.length ? await collectAttachmentFiles(files) : new Map();
    const report = await importBackup(backup, attachments, (msg) => { status.textContent = msg; });
    await loadLocal();
    renderAll();
    const lines = [
      `Listo: ${report.notes} notas (${report.trashed} en papelera) y ${report.notebooks} libretas.`,
      `Imágenes/adjuntos copiados: ${report.filesLinked}.`,
    ];
    if (report.filesRemote) lines.push(`Adjuntos que siguen apuntando a la nube de UpNote: ${report.filesRemote} (agrega la carpeta "files" y vuelve a importar para traerlos).`);
    if (report.filesMissing.length) lines.push(`Adjuntos no encontrados: ${report.filesMissing.length}.`);
    if (backup.badLines) lines.push(`Líneas ilegibles en el respaldo: ${backup.badLines}.`);
    lines.push(state.mode === 'cloud' ? 'Subiendo a la nube en segundo plano…' : 'Guardado en este dispositivo.');
    status.textContent = lines.join('\n');
    if (state.mode === 'cloud') sync.syncNow();
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- Eventos ----------------
function bind() {
  el.setupForm.addEventListener('submit', (e) => { e.preventDefault(); handleAuth('login'); });
  $('#btnSignup').onclick = () => handleAuth('signup');
  $('#btnLocal').onclick = () => {
    if (!confirm('Modo local: las notas quedan solo en este dispositivo y no se sincronizan. ¿Continuar?')) return;
    localStorage.setItem('apuntes_local_only', '1');
    state.mode = 'local';
    startApp();
  };

  $('#navFixed').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-nav]');
    if (b) setView({ type: b.dataset.nav, id: null });
  });
  el.tree.addEventListener('click', (e) => {
    const tw = e.target.closest('[data-twisty]');
    if (tw) {
      const id = tw.dataset.twisty;
      state.openNbs.has(id) ? state.openNbs.delete(id) : state.openNbs.add(id);
      saveOpenNbs(); renderSidebar(); return;
    }
    const m = e.target.closest('[data-nbmenu]');
    if (m) { notebookMenu(m.dataset.nbmenu, m); return; }
    const nb = e.target.closest('[data-nb]');
    if (nb) setView({ type: 'notebook', id: nb.dataset.nb });
  });
  el.tagList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (b) setView({ type: 'tag', id: b.dataset.tag });
  });
  $('#btnNewNotebook').onclick = async () => {
    const title = await ask('Nombre de la libreta');
    if (title) { const nb = await createNotebook(title); setView({ type: 'notebook', id: nb.id }); }
  };
  $('#btnMenu').onclick = () => {
    if (el.btnMenu.dataset.back) setView({ type: 'notebook', id: el.btnMenu.dataset.back });
    else el.app.classList.toggle('nav-open');
  };
  el.app.addEventListener('click', (e) => {
    if (el.app.classList.contains('nav-open') && !e.target.closest('#sidebar') && !e.target.closest('#btnMenu') && !e.target.closest('#btnBooks')) el.app.classList.remove('nav-open');
  });
  $('#btnSync').onclick = () => { if (state.mode === 'cloud') sync.syncNow(); else toast('Modo local: sin sincronización'); };

  el.noteList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note]');
    if (b) openNote(b.dataset.note);
  });
  el.search.addEventListener('input', () => { state.query = el.search.value; renderList(); });
  el.sort.addEventListener('change', () => { state.sort = el.sort.value; localStorage.setItem('apuntes_sort', state.sort); renderList(); });
  $('#btnNewNote').onclick = newNote;
  const backToList = async () => { await flushSave(true); el.app.dataset.view = 'list'; state.currentId = null; el.editorPane.classList.remove('has-note'); renderList(); };
  $('#btnBack').onclick = () => { if (history.state?.apuntes === 'editor') history.back(); else backToList(); };
  addEventListener('popstate', () => {
    if (!el.lightbox.classList.contains('hidden')) { closeLightbox(true); return; }
    if (el.app.dataset.view === 'editor' && isNarrow()) backToList();
  });
  $('#lbClose').onclick = () => closeLightbox();
  el.lbScroll.addEventListener('click', (e) => {
    if (e.target === el.lbImg) el.lbScroll.classList.toggle('zoom'); else closeLightbox();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // Barra inferior del celular
  $('#btnFab').onclick = newNote;
  $('#btnBooks').onclick = () => el.app.classList.add('nav-open');
  $('#btnListMore').onclick = (e) => {
    e.stopPropagation();
    for (const b of el.listMenu.querySelectorAll('[data-sort]')) b.classList.toggle('on', b.dataset.sort === state.sort);
    el.listMenu.classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#listMenu')) el.listMenu.classList.add('hidden'); });
  el.listMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    el.listMenu.classList.add('hidden');
    if (b.dataset.sort) { state.sort = b.dataset.sort; el.sort.value = state.sort; localStorage.setItem('apuntes_sort', state.sort); renderList(); }
    else if (b.dataset.lact === 'sync') $('#setSync').click();
    else if (b.dataset.lact === 'settings') $('#btnSettings').click();
  });
  el.syncMini.onclick = () => {
    if (state.mode === 'cloud') { sync.ensureRealtime(); sync.syncNow(); }
    toast(el.syncMini.title || 'Sincronización');
  };
  el.subNbs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-subnb]');
    if (b) setView({ type: 'notebook', id: b.dataset.subnb });
  });

  // En el celular la barra de formato va pegada sobre el teclado.
  const vv = window.visualViewport;
  if (vv) {
    const place = () => {
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--kb', `${kb}px`);
      document.documentElement.style.setProperty('--kb-safe', kb > 40 ? '0px' : 'env(safe-area-inset-bottom)');
    };
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    place();
  }
  $('#btnEmptyTrash').onclick = async () => {
    const trashed = [...state.notes.values()].filter(n => isAlive(n) && n.trashed);
    if (!trashed.length || !confirm(`¿Eliminar para siempre ${trashed.length} notas?`)) return;
    for (const n of trashed) await persist('notes', { ...n, deleted: true, html: '', text: '', updated_at: now() });
    closeNote(); renderAll();
  };

  // Editor
  el.editor.addEventListener('input', (e) => {
    if (e.inputType === 'insertParagraph') fixNewChecklistItem(el.editor);
    scheduleSave();
  });
  el.editor.addEventListener('click', (e) => {
    if (handleChecklistClick(e, el.editor)) { scheduleSave(); return; }
    const img = e.target.closest('img');
    if (img && img.src && !img.classList.contains('loading')) { e.preventDefault(); openLightbox(img.src); return; }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.dataset.file) {
      e.preventDefault();
      sync.fileURL(a.dataset.file).then(url => url ? open(url, '_blank') : toast('Adjunto no disponible sin conexión'));
    } else if (e.ctrlKey || e.metaKey || el.editor.contentEditable === 'false') {
      e.preventDefault(); open(a.href, '_blank', 'noopener');
    }
  });
  el.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && closestIn(e.target === el.editor ? getSelection().anchorNode : e.target, 'li', el.editor)) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    }
  });
  el.editor.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); for (const f of files) await insertImage(f); return; }
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize(html.replace(/<!--[\s\S]*?-->/g, '')));
    }
  });
  el.editor.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); for (const f of files) await insertImage(f); }
  });
  el.toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // no perder la selección
  el.toolbar.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    const special = runCommand(b.dataset.cmd, el.editor);
    if (special === 'link') {
      const sel = getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = await ask('Dirección del enlace', 'https://');
      if (url && range) {
        el.editor.focus(); sel.removeAllRanges(); sel.addRange(range);
        if (range.collapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
        else document.execCommand('createLink', false, url);
      }
    } else if (special === 'image') {
      $('#imgInput').click();
    }
    scheduleSave();
  });
  $('#imgInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await insertImage(f);
    e.target.value = '';
  });

  // Meta de la nota
  $('#btnNotebooks').onclick = pickNotebooks;
  el.btnPin.onclick = () => { const n = state.notes.get(state.currentId); if (n) updateCurrent({ pinned: !n.pinned }); };
  el.btnFav.onclick = () => { const n = state.notes.get(state.currentId); if (n) updateCurrent({ bookmarked: !n.bookmarked }); };
  el.tagInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const t = el.tagInput.value.trim().replace(/^#/, '').replace(/,$/, '');
    el.tagInput.value = '';
    const n = state.notes.get(state.currentId);
    if (t && n && !(n.tags || []).includes(t)) await updateCurrent({ tags: [...(n.tags || []), t] });
  });
  el.tagChips.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-untag]');
    const n = state.notes.get(state.currentId);
    if (b && n) await updateCurrent({ tags: (n.tags || []).filter(t => t !== b.dataset.untag) });
  });
  $('#btnMore').onclick = (e) => { e.stopPropagation(); el.moreMenu.classList.toggle('hidden'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#moreMenu')) el.moreMenu.classList.add('hidden'); });
  el.moreMenu.addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    el.moreMenu.classList.add('hidden');
    await flushSave();
    const n = state.notes.get(state.currentId);
    if (!n || !act) return;
    if (act === 'trash') { await updateCurrent({ trashed: true, pinned: false }); closeNote(); toast('Movida a la papelera'); }
    else if (act === 'copy') { await navigator.clipboard.writeText(el.editor.innerText); toast('Texto copiado'); }
    else if (act === 'md') download(`${(n.title || 'nota').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.md`, toMarkdown(el.editor), 'text/markdown');
    else if (act === 'dup') {
      const copy = { ...n, id: uid(), title: `${n.title} (copia)`, created_at: now(), updated_at: now(), pinned: false };
      await persist('notes', copy); renderAll(); openNote(copy.id);
    }
  });
  $('#btnRestore').onclick = async () => { await updateCurrent({ trashed: false }); openNote(state.currentId, { keepView: true }); toast('Nota restaurada'); };
  $('#btnPurge').onclick = async () => {
    if (!confirm('¿Eliminar esta nota para siempre?')) return;
    await updateCurrent({ deleted: true, html: '', text: '' }); closeNote();
  };

  // Ajustes
  $('#btnSettings').onclick = () => {
    const u = sync.getUser();
    $('#setAccount').textContent = state.mode === 'cloud' && u ? `Sesión: ${u.email}` : 'Modo local (sin sincronizar).';
    $('#setLogout').textContent = state.mode === 'cloud' ? 'Cerrar sesión' : 'Conectar a la nube';
    $('#dlgSettings').showModal();
  };
  $('#setSync').onclick = () => { if (state.mode === 'cloud') { sync.syncNow(); toast('Sincronizando…'); } else toast('Modo local'); };
  $('#setImport').onclick = () => { $('#dlgSettings').close(); $('#impStatus').textContent = ''; $('#dlgImport').showModal(); };
  $('#impRun').onclick = runImport;
  $('#setExport').onclick = exportAll;
  $('#setRestore').onclick = () => $('#restoreInput').click();
  $('#restoreInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await restoreBackup(f); } catch (err) { toast(`Error: ${err.message}`, 4000); }
  });
  $('#setLogout').onclick = async () => {
    if (state.mode === 'cloud') {
      const pending = [...state.notes.values()].some(n => n._dirty);
      if (pending && !confirm('Hay cambios sin subir todavía. Si cierras sesión se perderán en este dispositivo. ¿Continuar?')) return;
      if (!confirm('¿Cerrar sesión? Se borrará la copia local de este dispositivo.')) return;
      await sync.signOut();
      await db.clearAll();
    } else {
      localStorage.removeItem('apuntes_local_only');
    }
    location.reload();
  };

  // Atajos de teclado
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newNote(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); el.search.focus(); }
  });
}

async function insertImage(file) {
  if (!state.currentId) return;
  const blob = await compressImage(file);
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const path = `${sync.filePrefix()}/${uid()}.${ext}`;
  const url = await sync.saveFile(path, blob);
  el.editor.focus();
  document.execCommand('insertHTML', false, `<img data-file="${esc(path)}" src="${url}" alt=""><p><br></p>`);
  scheduleSave();
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW no registrado', err));
  }
}

bind();
boot();
