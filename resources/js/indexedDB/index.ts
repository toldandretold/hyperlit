/**
 * Database Module - Main Entry Point
 * Unified exports for all IndexedDB operations
 *
 * This module provides a clean, organized API for interacting with IndexedDB.
 * It replaces the monolithic indexedDB.js file with a modular architecture.
 *
 * @module database
 */

import { verbose } from '../utilities/logger';
import { queueForSync } from './syncQueue/queue';
import { debouncedMasterSync } from './syncQueue/master';
import { updateBookTimestamp } from './core/library';
import { getNodeChunksFromIndexedDB } from './nodes/read';
import { initLibraryDependencies } from './core/library';
import { initNodeWriteDependencies } from './nodes/write';
import { initNodeBatchDependencies } from './nodes/batch';
import { initNodeDeleteDependencies } from './nodes/delete';
import { initNodeNormalizeDependencies } from './nodes/normalize';
import { initHypercitesDependencies } from './hypercites/index';
import { initFootnotesDependencies } from './footnotes/index';
import { initReferencesDependencies } from './bibliography/index';
import { initSyncQueueDependencies } from './syncQueue/queue';
import { initMasterSyncDependencies } from './syncQueue/master';
import { initUnloadSyncDependencies } from './syncQueue/unload';

// ============================================================================
// CORE OPERATIONS
// ============================================================================

// Connection & Schema
export {
  openDatabase,
  DB_VERSION,
} from './core/connection';

// Utility Functions
export {
  parseNodeId,
  createNodeChunksKey,
  getLocalStorageKey,
  toPublicNode,
} from './core/utilities';

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
} from './core/library';

// ============================================================================
// NODE OPERATIONS
// ============================================================================

// Node Read Operations
export {
  getNodeChunksFromIndexedDB,
  getAllNodeChunksForBook,
  getNodeChunkFromIndexedDB,
  getNodeChunksAfter,
} from './nodes/read';

// Node Write Operations
export {
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  addNewBookToIndexedDB,
  writeNodeChunks,
  initNodeWriteDependencies,
} from './nodes/write';

// Node Batch Operations
export {
  updateSingleIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  initNodeBatchDependencies,
} from './nodes/batch';

// Node Delete Operations
export {
  deleteIndexedDBRecord,
  initNodeDeleteDependencies,
} from './nodes/delete';

// Node Normalize Operations
export {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from './nodes/normalize';

// Node Hydration (NEW SYSTEM)
export {
  rebuildNodeArrays,
  getNodesByDataNodeIDs,
} from './hydration/rebuild';

// Node PostgreSQL Sync
export {
  syncNodeChunksToPostgreSQL,
} from './nodes/syncNodesToPostgreSQL';

// ============================================================================
// HIGHLIGHTS
// ============================================================================

export {
  syncHyperlightToPostgreSQL,
  syncHyperlightDeletionsToPostgreSQL,
} from './highlights/syncHighlightsToPostgreSQL';

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
} from './hypercites/index';

// ============================================================================
// FOOTNOTES
// ============================================================================

export {
  saveAllFootnotesToIndexedDB,
  initFootnotesDependencies,
  syncFootnotesToPostgreSQL,
} from './footnotes/index';

// ============================================================================
// REFERENCES (BIBLIOGRAPHY)
// ============================================================================

export {
  saveAllReferencesToIndexedDB,
  initReferencesDependencies,
  syncReferencesToPostgreSQL,
} from './bibliography/index';

// ============================================================================
// SYNC QUEUE SYSTEM
// ============================================================================

// Sync Queue
export {
  pendingSyncs,
  queueForSync,
  clearPendingSyncsForBook,
  initSyncQueueDependencies,
} from './syncQueue/queue';

// Master Sync
export {
  updateHistoryLog,
  executeSyncPayload,
  debouncedMasterSync,
  syncIndexedDBtoPostgreSQLBlocking,  // Renamed to avoid collision with indexedDB/serverSync version
  initMasterSyncDependencies,
} from './syncQueue/master';

// Unload Sync
export {
  setupUnloadSync,
  initUnloadSyncDependencies,
} from './syncQueue/unload';

// ============================================================================
// UTILITIES
// ============================================================================

export {
  retryOperation,
  deleteIndexedDBRecordWithRetry,
  clearDatabase,
  deleteBookFromIndexedDB,
  clearBookContentFromIndexedDB,
} from './utilities/index';

// ============================================================================
// INITIALIZATION
// ============================================================================

import type { BookId } from './types';

/** Everything the app injects into the IndexedDB layer at startup. */
export interface DatabaseDependencies {
  book: BookId | null | undefined;
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
  getInitialBookSyncPromise: () => Promise<unknown> | null;
  glowCloudGreen?: (opts?: unknown) => void;
  glowCloudRed?: (opts?: unknown) => void;
  glowCloudLocalSave?: () => void;
}

// Module-level storage for dependencies (needed for updateDatabaseBookId)
let _storedDeps: DatabaseDependencies | null = null;

/**
 * Initialize all database modules with their dependencies
 * This function should be called once during application startup
 *
 * @param {Object} dependencies - Object containing all required dependencies
 */
export async function initializeDatabaseModules(dependencies: DatabaseDependencies): Promise<void> {
  // Store dependencies for later use by updateDatabaseBookId
  _storedDeps = dependencies;

  const {
    book,
    withPending,
    getInitialBookSyncPromise,
    glowCloudGreen,
    glowCloudRed,
    glowCloudLocalSave,
  } = dependencies;

  // All functions already statically imported at top of file - no need for dynamic imports here

  // Initialize all modules
  initLibraryDependencies({ book });
  initNodeWriteDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initNodeBatchDependencies({ book });
  initNodeDeleteDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initNodeNormalizeDependencies({ withPending, book, updateBookTimestamp, queueForSync });
  initHypercitesDependencies({ updateBookTimestamp, queueForSync, withPending, getNodeChunksFromIndexedDB });
  initFootnotesDependencies({ updateBookTimestamp, withPending });
  initReferencesDependencies({ withPending });
  initSyncQueueDependencies({ debouncedMasterSync });
  initMasterSyncDependencies({ book, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave });
  initUnloadSyncDependencies({ book });

  verbose.init('Database modules initialized', '/indexedDB/index');
}

/**
 * Update the book ID in all database modules
 * Call this during SPA navigation when the current book changes
 *
 * @param {string} newBookId - The new book ID to use
 */
export function updateDatabaseBookId(newBookId: BookId): void {
  if (!_storedDeps) {
    console.warn('⚠️ updateDatabaseBookId called before initializeDatabaseModules');
    return;
  }

  const { withPending, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave } = _storedDeps;

  // Re-initialize modules that depend on book
  initLibraryDependencies({ book: newBookId });
  initNodeWriteDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initNodeBatchDependencies({ book: newBookId });
  initNodeDeleteDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initNodeNormalizeDependencies({ withPending, book: newBookId, updateBookTimestamp, queueForSync });
  initMasterSyncDependencies({ book: newBookId, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave });
  initUnloadSyncDependencies({ book: newBookId });

  console.log('📚 Database modules updated to book:', newBookId);
}
