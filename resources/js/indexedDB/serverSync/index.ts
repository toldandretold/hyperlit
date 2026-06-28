/**
 * serverSync — the server↔IndexedDB hydrate/sync layer (formerly the
 * top-level postgreSQL.js). Despite the old name it talks to the Laravel API,
 * not Postgres directly. It is the pull/hydrate counterpart to syncQueue
 * (push), so it lives under the indexedDB data layer.
 *
 * Barrel re-exporting the public surface; importers depend on this path only.
 */
export { syncBookDataFromDatabase, syncAnnotationsOnly } from './pull';
export { syncIndexedDBtoPostgreSQL } from './push';
export { flushAllPendingEdits } from './flush';
export { clearBookDataFromIndexedDB, purgeStaleBookFromIndexedDB } from './clear';
export {
  loadNodesToIndexedDB,
  loadFootnotesToIndexedDB,
  loadBibliographyToIndexedDB,
  loadHyperlightsToIndexedDB,
  loadHypercitesToIndexedDB,
  loadLibraryToIndexedDB,
} from './loaders';
