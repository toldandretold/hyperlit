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
import { queueForSync } from './syncQueue/queue.js';
import { debouncedMasterSync } from './syncQueue/master.js';
import { updateBookTimestamp } from './core/library.js';
import { getNodeChunksFromIndexedDB } from './nodes/read.js';
import { initLibraryDependencies } from './core/library.js';
import { initNodeWriteDependencies } from './nodes/write.js';
import { initNodeBatchDependencies } from './nodes/batch.js';
import { initNodeDeleteDependencies } from './nodes/delete.js';
import { initNodeNormalizeDependencies } from './nodes/normalize.js';
import { initHypercitesDependencies } from './hypercites/index.js';
import { initFootnotesDependencies } from './footnotes/index.js';
import { initReferencesDependencies } from './bibliography/index.js';
import { initSyncQueueDependencies } from './syncQueue/queue.js';
import { initMasterSyncDependencies } from './syncQueue/master.js';
import { initUnloadSyncDependencies } from './syncQueue/unload.js';

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
  updateAnnotationsTimestamp,
  updateLocalAnnotationsTimestamp,
  initLibraryDependencies,
  getAllOfflineAvailableBooks,
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
  updateSingleIndexedDBRecord,
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

// Node Hydration (NEW SYSTEM)
export {
  rebuildNodeArrays,
  getNodesByUUIDs,
} from './hydration/rebuild.js';

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
  syncHyperciteWithNodeChunkImmediately,
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
} from './bibliography/index.js';

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
  createGenesisHistoryEntry,
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
  deleteBookFromIndexedDB,
} from './utilities/index.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

// Module-level storage for dependencies (needed for updateDatabaseBookId)
let _storedDeps = null;

/**
 * Initialize all database modules with their dependencies
 * This function should be called once during application startup
 *
 * @param {Object} dependencies - Object containing all required dependencies
 */
export async function initializeDatabaseModules(dependencies) {
  // Store dependencies for later use by updateDatabaseBookId
  _storedDeps = dependencies;

  const {
    book,
    withPending,
    clearRedoHistory,
    getInitialBookSyncPromise,
    glowCloudGreen,
    glowCloudRed,
    glowCloudLocalSave,
  } = dependencies;

  // All functions already statically imported at top of file - no need for dynamic imports here

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
  initMasterSyncDependencies({ book, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave });
  initUnloadSyncDependencies({ book });

  verbose.init('Database modules initialized', '/indexedDB/index.js');
}

/**
 * Update the book ID in all database modules
 * Call this during SPA navigation when the current book changes
 *
 * @param {string} newBookId - The new book ID to use
 */
export function updateDatabaseBookId(newBookId) {
  if (!_storedDeps) {
    console.warn('⚠️ updateDatabaseBookId called before initializeDatabaseModules');
    return;
  }

  const { withPending, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave } = _storedDeps;

  // Re-initialize modules that depend on book
  initLibraryDependencies({ book: newBookId, queueForSync });
  initNodeWriteDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initNodeBatchDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initNodeDeleteDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initNodeNormalizeDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initMasterSyncDependencies({ book: newBookId, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave });
  initUnloadSyncDependencies({ book: newBookId });

  console.log('📚 Database modules updated to book:', newBookId);
}
