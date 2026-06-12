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
} from './read';

// Write operations
export {
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  addNewBookToIndexedDB,
  writeNodeChunks,
  initNodeWriteDependencies,
} from './write';

// Batch operations
export {
  updateSingleIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  initNodeBatchDependencies,
} from './batch';

// Delete operations
export {
  deleteIndexedDBRecord,
  initNodeDeleteDependencies,
} from './delete';

// Normalize operations
export {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from './normalize';

// PostgreSQL Sync
export {
  syncNodeChunksToPostgreSQL,
} from './syncNodesToPostgreSQL';
