/**
 * Node Operations Module
 * Exports all node chunk operations
 */

// Read operations
export {
  getNodeChunksFromIndexedDB,
  getAllNodeChunksForBook,
  getNodeChunkFromIndexedDB,
  getNodeChunksAfter,
} from './read.js';

// Write operations
export {
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  addNewBookToIndexedDB,
  writeNodeChunks,
  initNodeWriteDependencies,
} from './write.js';

// Batch operations
export {
  updateIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  initNodeBatchDependencies,
} from './batch.js';

// Delete operations
export {
  deleteIndexedDBRecord,
  initNodeDeleteDependencies,
} from './delete.js';

// Normalize operations
export {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from './normalize.js';

// PostgreSQL Sync
export {
  syncNodeChunksToPostgreSQL,
} from './syncNodesToPostgreSQL.js';
