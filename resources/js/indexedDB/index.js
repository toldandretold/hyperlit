/**
 * Database Module - Main Entry Point
 * Unified exports for all IndexedDB operations
 *
 * This module provides a clean, organized API for interacting with IndexedDB.
 * It replaces the monolithic indexedDB.js file with a modular architecture.
 *
 * @module database
 */

import { verbose } from '../utilities/logger.js';

// ============================================================================
// CORE OPERATIONS
// ============================================================================

// Connection & Schema
export {
  openDatabase,
  DB_VERSION,
} from './core/connection.js';

// Utility Functions
export {
  debounce,
  parseNodeId,
  createNodeChunksKey,
  getLocalStorageKey,
  toPublicChunk,
} from './core/utilities.js';

// Library Management
export {
  cleanLibraryItemForStorage,
  prepareLibraryForIndexedDB,
  getLibraryObjectFromIndexedDB,
  updateBookTimestamp,
  initLibraryDependencies,
} from './core/library.js';

// ============================================================================
// NODE OPERATIONS
// ============================================================================

// Node Read Operations
export {
  getNodeChunksFromIndexedDB,
  getAllNodeChunksForBook,
  getNodeChunkFromIndexedDB,
  getNodeChunksAfter,
} from './nodes/read.js';

// Node Write Operations
export {
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  addNewBookToIndexedDB,
  writeNodeChunks,
  initNodeWriteDependencies,
} from './nodes/write.js';

// Node Batch Operations
export {
  updateIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  initNodeBatchDependencies,
} from './nodes/batch.js';

// Node Delete Operations
export {
  deleteIndexedDBRecord,
  initNodeDeleteDependencies,
} from './nodes/delete.js';

// Node Normalize Operations
export {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from './nodes/normalize.js';

// Node PostgreSQL Sync
export {
  syncNodeChunksToPostgreSQL,
} from './nodes/syncNodesToPostgreSQL.js';

// ============================================================================
// HIGHLIGHTS
// ============================================================================

export {
  syncHyperlightToPostgreSQL,
  syncHyperlightDeletionsToPostgreSQL,
} from './highlights/syncHighlightsToPostgreSQL.js';

// ============================================================================
// HYPERCITES (TWO-WAY CITATIONS)
// ============================================================================

export {
  getHyperciteFromIndexedDB,
  updateHyperciteInIndexedDB,
  addCitationToHypercite,
  updateCitationForExistingHypercite,
  initHypercitesDependencies,
  syncHyperciteToPostgreSQL,
  syncHyperciteUpdateImmediately,
} from './hypercites/index.js';

// ============================================================================
// FOOTNOTES
// ============================================================================

export {
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  saveAllFootnotesToIndexedDB,
  initFootnotesDependencies,
  syncFootnotesToPostgreSQL,
} from './footnotes/index.js';

// ============================================================================
// REFERENCES (BIBLIOGRAPHY)
// ============================================================================

export {
  saveAllReferencesToIndexedDB,
  initReferencesDependencies,
  syncReferencesToPostgreSQL,
} from './references/index.js';

// ============================================================================
// SYNC QUEUE SYSTEM
// ============================================================================

// Sync Queue
export {
  pendingSyncs,
  queueForSync,
  clearPendingSyncsForBook,
  initSyncQueueDependencies,
} from './syncQueue/queue.js';

// Master Sync
export {
  updateHistoryLog,
  executeSyncPayload,
  debouncedMasterSync,
  syncIndexedDBtoPostgreSQLBlocking,  // Renamed to avoid collision with postgreSQL.js version
  initMasterSyncDependencies,
} from './syncQueue/master.js';

// Unload Sync
export {
  setupUnloadSync,
  initUnloadSyncDependencies,
} from './syncQueue/unload.js';

// ============================================================================
// UTILITIES
// ============================================================================

export {
  retryOperation,
  deleteIndexedDBRecordWithRetry,
  clearDatabase,
} from './utilities/index.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize all database modules with their dependencies
 * This function should be called once during application startup
 *
 * @param {Object} dependencies - Object containing all required dependencies
 */
export async function initializeDatabaseModules(dependencies) {
  const {
    book,
    withPending,
    clearRedoHistory,
    getInitialBookSyncPromise,
    showTick,
    showError,
  } = dependencies;

  // Import all init functions
  const { initLibraryDependencies } = await import('./core/library.js');
  const { initNodeWriteDependencies } = await import('./nodes/write.js');
  const { initNodeBatchDependencies } = await import('./nodes/batch.js');
  const { initNodeDeleteDependencies } = await import('./nodes/delete.js');
  const { initNodeNormalizeDependencies } = await import('./nodes/normalize.js');
  const { initHypercitesDependencies } = await import('./hypercites/index.js');
  const { initFootnotesDependencies } = await import('./footnotes/index.js');
  const { initReferencesDependencies } = await import('./references/index.js');
  const { initSyncQueueDependencies } = await import('./syncQueue/queue.js');
  const { initMasterSyncDependencies } = await import('./syncQueue/master.js');
  const { initUnloadSyncDependencies } = await import('./syncQueue/unload.js');
  const { queueForSync } = await import('./syncQueue/queue.js');
  const { debouncedMasterSync } = await import('./syncQueue/master.js');
  const { updateBookTimestamp } = await import('./core/library.js');
  const { getNodeChunksFromIndexedDB } = await import('./nodes/read.js');

  // Initialize all modules
  initLibraryDependencies({ book, queueForSync });
  initNodeWriteDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initNodeBatchDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initNodeDeleteDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initNodeNormalizeDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initHypercitesDependencies({ updateBookTimestamp, queueForSync, withPending, getNodeChunksFromIndexedDB });
  initFootnotesDependencies({ updateBookTimestamp, withPending });
  initReferencesDependencies({ withPending });
  initSyncQueueDependencies({ clearRedoHistory, debouncedMasterSync });
  initMasterSyncDependencies({ book, getInitialBookSyncPromise, showTick, showError });
  initUnloadSyncDependencies({ book });

  verbose.init('Database modules initialized', '/indexedDB/index.js');
}
