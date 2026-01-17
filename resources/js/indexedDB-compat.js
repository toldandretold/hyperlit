/**
 * IndexedDB Backward Compatibility Facade
 *
 * This file maintains backward compatibility with existing code that imports
 * from indexedDB.js. All functions are re-exported from the new modular structure.
 *
 * MIGRATION NOTE:
 * New code should import directly from './indexedDB/index.js' instead of this file.
 * This facade allows gradual migration of existing imports.
 *
 * @deprecated Use './indexedDB/index.js' for new code
 */

// ============================================================================
// Re-export ALL functions from the new modular IndexedDB structure
// ============================================================================

export {
  // Core
  DB_VERSION,
  openDatabase,
  debounce,
  parseNodeId,
  createNodeChunksKey,
  getLocalStorageKey,
  toPublicChunk,
  cleanLibraryItemForStorage,
  prepareLibraryForIndexedDB,
  getLibraryObjectFromIndexedDB,
  updateBookTimestamp,

  // Nodes - Read
  getNodeChunksFromIndexedDB,
  getAllNodeChunksForBook,
  getNodeChunkFromIndexedDB,
  getNodeChunksAfter,

  // Nodes - Write
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  addNewBookToIndexedDB,

  // Nodes - Batch
  updateSingleIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,

  // Nodes - Delete
  deleteIndexedDBRecord,

  // Nodes - Normalize
  updateIndexedDBRecordForNormalization,

  // Nodes - PostgreSQL Sync
  syncNodeChunksToPostgreSQL,
  writeNodeChunks,

  // Highlights
  syncHyperlightToPostgreSQL,
  syncHyperlightDeletionsToPostgreSQL,

  // Hypercites
  getHyperciteFromIndexedDB,
  updateHyperciteInIndexedDB,
  addCitationToHypercite,
  updateCitationForExistingHypercite,
  syncHyperciteToPostgreSQL,
  syncHyperciteUpdateImmediately,

  // Footnotes & References
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  saveAllFootnotesToIndexedDB,
  saveAllReferencesToIndexedDB,
  syncFootnotesToPostgreSQL,
  syncReferencesToPostgreSQL,

  // Sync Queue
  pendingSyncs,
  queueForSync,
  clearPendingSyncsForBook,
  updateHistoryLog,
  executeSyncPayload,
  debouncedMasterSync,
  syncIndexedDBtoPostgreSQL,
  setupUnloadSync,

  // Utilities
  retryOperation,
  deleteIndexedDBRecordWithRetry,
  clearDatabase,

  // Initialization
  initializeDatabaseModules,
} from './indexedDB/index.js';

console.log('⚠️ Using indexedDB-compat.js - Please migrate imports to ./indexedDB/index.js for new code');
