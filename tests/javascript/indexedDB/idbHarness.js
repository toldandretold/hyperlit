/**
 * Shared harness for IndexedDB characterization tests.
 *
 * Installs a fresh in-memory IndexedDB (fake-indexeddb) per test and provides
 * thin seed/read helpers that go through the REAL connection module, so the
 * production upgrade path (connection.js onupgradeneeded) builds the schema —
 * the tests exercise the same stores/indexes the app runs against.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { closeDatabase, openDatabase } from '../../../resources/js/indexedDB/core/connection';

/**
 * Drop the cached singleton connection and swap in an empty IDB factory.
 * Call from beforeEach so every test starts from a blank database.
 */
export function installFreshIndexedDB() {
  closeDatabase();
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
}

export async function seedStore(storeName, records) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  for (const record of records) tx.objectStore(storeName).put(record);
  await txDone(tx);
}

export async function readAll(storeName) {
  const db = await openDatabase();
  const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
  return reqDone(req);
}

export async function readOne(storeName, key) {
  const db = await openDatabase();
  const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
  return reqDone(req);
}

/**
 * Poll until predicate() is truthy. Needed for the fire-and-forget cache
 * writes (rebuild.js updateNodesInDB is intentionally not awaited in prod).
 */
export async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
