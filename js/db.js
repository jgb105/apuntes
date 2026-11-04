// Almacén local (IndexedDB): permite trabajar sin conexión y abrir la app al instante.
const DB_NAME = 'apuntes';
const DB_VERSION = 1;
const STORES = ['notes', 'notebooks', 'files'];

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function del(store, id) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return done(tx);
}

// Aplica una función a registros existentes dentro de una sola transacción.
// fn(registroActual | undefined, id) -> registro nuevo | undefined (no cambia)
export async function updateMany(store, ids, fn) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const id of ids) {
    const r = os.get(id);
    r.onsuccess = () => {
      const next = fn(r.result, id);
      if (next) os.put(next);
    };
  }
  return done(tx);
}

export async function metaGet(key) {
  const db = await openDB();
  return reqP(db.transaction('meta').objectStore('meta').get(key));
}

export async function metaSet(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return done(tx);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction([...STORES, 'meta'], 'readwrite');
  for (const s of [...STORES, 'meta']) tx.objectStore(s).clear();
  return done(tx);
}
