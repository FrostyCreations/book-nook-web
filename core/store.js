// Everything the app keeps on the iPad lives in the browser's own database (IndexedDB):
// the shelf, the book files, and scans in progress.

const DB_NAME = 'booknook';
const DB_VERSION = 1;
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          const pages = db.createObjectStore('pages', { keyPath: 'id' });
          pages.createIndex('scanId', 'scanId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return opening;
}

function run(storeName, mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));
    let result;
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The iPad would not save this. Its storage may be full.'));
  }));
}

export const store = {
  get: (name, key) => run(name, 'readonly', (s) => s.get(key)),
  all: (name) => run(name, 'readonly', (s) => s.getAll()),
  put: (name, value) => run(name, 'readwrite', (s) => s.put(value)),
  remove: (name, key) => run(name, 'readwrite', (s) => s.delete(key)),
  byIndex: (name, index, key) => run(name, 'readonly', (s) => s.index(index).getAll(key))
};

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Asks the browser not to clear the library when storage runs low. */
export async function keepStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (error) { /* not supported: nothing to do */ }
}
