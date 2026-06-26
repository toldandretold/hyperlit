/**
 * Node Operations Module
 * Exports all node operations
 */

// Read operations
export {
  getNodesFromIndexedDB,
  getAllNodesForBook,
  getNodeFromIndexedDB,
  getNodesAfter,
} from './read';

// Write operations
export {
  addNodeToIndexedDB,
  saveAllNodesToIndexedDB,
  deleteNodesAfter,
  renumberNodesInIndexedDB,
  addNewBookToIndexedDB,
  writeNodes,
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
  deleteNodesByNodeIds,
  initNodeDeleteDependencies,
} from './delete';

// Normalize operations
export {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from './normalize';

// PostgreSQL Sync
export {
  syncNodesToPostgreSQL,
} from './syncNodesToPostgreSQL';
