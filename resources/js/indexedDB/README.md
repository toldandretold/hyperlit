# IndexedDB Module

**Modular, organized IndexedDB operations for Hyperlit**

This directory contains a refactored, modular version of the previously monolithic `indexedDB.js` file (3,257 lines). The new structure improves maintainability, testability, and contributor-friendliness.

## 📁 Directory Structure

```
indexedDB/
├── core/                              # Core database operations
│   ├── connection.js                  # DB connection & schema management
│   ├── utilities.js                   # Helper functions (debounce, parseNodeId, etc.)
│   └── library.js                     # Library/book metadata operations
├── nodes/                             # Node chunk operations
│   ├── read.js                        # Read operations (get, getAll, getAfter)
│   ├── write.js                       # Write operations (add, save, delete, renumber, addNewBook)
│   ├── batch.js                       # Batch operations (update, delete with highlights)
│   ├── delete.js                      # Delete single node with associations
│   ├── normalize.js                   # Node renumbering/normalization
│   ├── syncNodesToPostgreSQL.js       # Sync node chunks to PostgreSQL
│   └── index.js                       # Module exports
├── highlights/                        # Highlight operations
│   ├── syncHighlightsToPostgreSQL.js  # Sync highlights to PostgreSQL
│   └── index.js                       # Module exports
├── hypercites/                        # Two-way citation system
│   ├── index.js                       # CRUD operations for hypercites
│   ├── helpers.js                     # Helper functions (resolveHypercite)
│   └── syncHypercitesToPostgreSQL.js  # Sync hypercites to PostgreSQL
├── footnotes/                         # Footnote operations
│   ├── index.js                       # Get, save, bulk save footnotes
│   └── syncFootnotesToPostgreSQL.js   # Sync footnotes to PostgreSQL
├── references/                        # Bibliography operations
│   ├── index.js                       # Save references
│   └── syncReferencesToPostgreSQL.js  # Sync references to PostgreSQL
├── syncQueue/                         # Sync queue infrastructure
│   ├── queue.js                       # Sync queue management
│   ├── master.js                      # Main debounced sync logic
│   ├── unload.js                      # Page unload sync (sendBeacon)
│   └── index.js                       # Module exports
├── utilities/                         # Database utilities
│   ├── retry.js                       # Retry logic with exponential backoff
│   ├── cleanup.js                     # Database cleanup operations
│   └── index.js                       # Module exports
├── index.js                           # Main entry point - exports everything
└── README.md                          # This file
```

## 🚀 Usage

### New Code (Recommended)

Import directly from the IndexedDB module:

```javascript
import {
  openDatabase,
  getNodeChunksFromIndexedDB,
  updateIndexedDBRecord,
  queueForSync,
  debouncedMasterSync,
} from './indexedDB/index.js';
```

### Legacy Code (Deprecated)

Existing code can continue using the compatibility facade:

```javascript
import {
  openDatabase,
  getNodeChunksFromIndexedDB,
} from './indexedDB-compat.js';
```

⚠️ **Note**: The compatibility facade will be removed in a future version. Please migrate imports to use `./indexedDB/index.js`.

## 📦 Module Overview

### Core (`database/core/`)

**connection.js**
- `openDatabase()` - Opens/creates IndexedDB with schema migrations
- `DB_VERSION` - Current schema version (21)

**utilities.js**
- `debounce()` - Debounce utility with flush support
- `parseNodeId()` - Parse node IDs to numeric format
- `createNodeChunksKey()` - Create composite keys
- `getLocalStorageKey()` - Get namespaced localStorage keys
- `toPublicChunk()` - Convert internal chunk format to public format

**library.js**
- `cleanLibraryItemForStorage()` - Clean library data before storing
- `prepareLibraryForIndexedDB()` - Prepare library records
- `getLibraryObjectFromIndexedDB()` - Get library metadata
- `updateBookTimestamp()` - Update book timestamp (triggers sync)

### Nodes (`database/nodes/`)

**read.js** - Read operations
- `getNodeChunksFromIndexedDB()` - Get all chunks for a book (sorted by chunk_id)
- `getAllNodeChunksForBook()` - Get all chunks (sorted by startLine)
- `getNodeChunkFromIndexedDB()` - Get single chunk by book + startLine
- `getNodeChunksAfter()` - Get chunks after a specific node ID

**write.js** - Write operations
- `addNodeChunkToIndexedDB()` - Add single chunk
- `saveAllNodeChunksToIndexedDB()` - Bulk save chunks
- `deleteNodeChunksAfter()` - Delete all chunks after a node ID
- `renumberNodeChunksInIndexedDB()` - Renumber all chunks (for system-wide renumbering)
- `addNewBookToIndexedDB()` - Convenience function for adding a new book

**batch.js** - Batch operations (CORE - used in read mode)
- `updateIndexedDBRecord()` - Update single record with highlights/hypercites processing
- `batchUpdateIndexedDBRecords()` - Batch update multiple records
- `batchDeleteIndexedDBRecords()` - Batch delete multiple records

**delete.js** - Delete operations
- `deleteIndexedDBRecord()` - Delete single node with all associated highlights and hypercites

**normalize.js** - Normalization operations
- `updateIndexedDBRecordForNormalization()` - Renumber node IDs (creates new, deletes old)

**syncNodesToPostgreSQL.js** - PostgreSQL sync
- `syncNodeChunksToPostgreSQL()` - Sync node chunks to PostgreSQL API
- `writeNodeChunks()` - Write node chunks via unified sync API

**Why batch operations are CORE**: These functions process highlights and hypercites, which can be added/updated in read mode (user can highlight and cite without entering edit mode).

### Highlights (`database/highlights/`)

**syncHighlightsToPostgreSQL.js** - PostgreSQL sync
- `syncHyperlightToPostgreSQL()` - Sync highlight upserts to PostgreSQL
- `syncHyperlightDeletionsToPostgreSQL()` - Sync highlight deletions to PostgreSQL

### Hypercites (`database/hypercites/`)

**index.js** - CORE operations for two-way citations
- `getHyperciteFromIndexedDB()` - Get hypercite by book + ID
- `updateHyperciteInIndexedDB()` - Update hypercite fields
- `addCitationToHypercite()` - Add citation to citedIN array
- `updateCitationForExistingHypercite()` - Update citation relationships

**helpers.js**
- `resolveHypercite()` - Resolve hypercite from local DB or server

**syncHypercitesToPostgreSQL.js** - PostgreSQL sync
- `syncHyperciteToPostgreSQL()` - Sync hypercites to PostgreSQL (batched)
- `syncHyperciteUpdateImmediately()` - Immediate sync for single hypercite

**Why hypercites are CORE**: Users can copy text as hypercites in read mode, which updates the database.

### Footnotes (`database/footnotes/`)

**index.js** - Footnote operations
- `getFootnotesFromIndexedDB()` - Get footnotes for a book
- `saveFootnotesToIndexedDB()` - Save footnote data
- `saveAllFootnotesToIndexedDB()` - Bulk save footnotes (syncs to PostgreSQL)

**syncFootnotesToPostgreSQL.js** - PostgreSQL sync
- `syncFootnotesToPostgreSQL()` - Sync footnotes to PostgreSQL

### References (`database/references/`)

**index.js** - Bibliography operations
- `saveAllReferencesToIndexedDB()` - Bulk save bibliography references

**syncReferencesToPostgreSQL.js** - PostgreSQL sync
- `syncReferencesToPostgreSQL()` - Sync references to PostgreSQL

### Sync Queue System (`database/syncQueue/`)

**queue.js** - Sync queue
- `pendingSyncs` - Map of pending sync operations
- `queueForSync()` - Queue an operation for sync
- `clearPendingSyncsForBook()` - Clear queue for a book

**master.js** - Main sync logic
- `debouncedMasterSync()` - Debounced sync (3 second delay)
- `executeSyncPayload()` - Execute sync via unified API
- `updateHistoryLog()` - Update history log entry
- `syncIndexedDBtoPostgreSQL()` - Full sync for a book

**unload.js** - Page unload sync
- `setupUnloadSync()` - Register unload event handlers
- Uses `navigator.sendBeacon()` for reliable sync during page transitions

**Note**: This folder contains only generic sync queue infrastructure. Domain-specific PostgreSQL sync functions (like `syncHypercitesToPostgreSQL.js`) are located in their respective domain folders for better organization and console log clarity.

### Utilities (`database/utilities/`)

**retry.js** - Retry operations
- `retryOperation()` - Generic retry with exponential backoff (max 3 attempts)
- `deleteIndexedDBRecordWithRetry()` - Delete with automatic retry

**cleanup.js** - Database cleanup
- `clearDatabase()` - Clear all IndexedDB data (for logout/reset)

## 🔄 Dependency Injection

The modular structure uses dependency injection to avoid circular imports. Initialize modules during app startup:

```javascript
import { initializeDatabaseModules } from './indexedDB/index.js';
import { book } from './app.js';
import { withPending, getInitialBookSyncPromise } from './utilities/operationState.js';
import { clearRedoHistory } from './historyManager.js';
import { glowCloudGreen, glowCloudRed } from './components/editIndicator.js';

// Initialize all IndexedDB modules
initializeDatabaseModules({
  book,
  withPending,
  clearRedoHistory,
  getInitialBookSyncPromise,
  glowCloudGreen,
  glowCloudRed,
  updateBookTimestamp,
  queueForSync,
});
```

Individual modules can also be initialized separately:

```javascript
import { initNodeBatchDependencies } from './indexedDB/index.js';

initNodeBatchDependencies({
  withPending,
  book,
  updateBookTimestamp,
  queueForSync,
});
```

## 🗄️ IndexedDB Schema (Version 21)

**Stores:**
- `nodeChunks` - Document content chunks
  - keyPath: `["book", "startLine"]`
  - Contains: content, hyperlights[], hypercites[], footnotes[]
- `hyperlights` - User highlights
  - keyPath: `["book", "hyperlight_id"]`
- `hypercites` - Citations with backlinks
  - keyPath: `["book", "hyperciteId"]`
- `footnotes` - Footnotes
  - keyPath: `["book", "footnoteId"]`
- `references` - Bibliography entries
  - keyPath: `["book", "referenceId"]`
- `library` - Book metadata
  - keyPath: `"book"`
- `historyLog` - Undo/redo log
  - keyPath: `"id"` (autoIncrement)
- `redoLog` - Redo operations
  - keyPath: `"id"` (autoIncrement)

## 🔧 Migration Guide

### Step 1: Update imports

**Before:**
```javascript
import {
  getNodeChunksFromIndexedDB,
  updateIndexedDBRecord
} from './indexedDB.js';
```

**After:**
```javascript
import {
  getNodeChunksFromIndexedDB,
  updateIndexedDBRecord
} from './indexedDB/index.js';
```

### Step 2: Initialize modules

Add initialization call in your app startup:

```javascript
import { initializeDatabaseModules } from './indexedDB/index.js';

// After all dependencies are loaded
initializeDatabaseModules({
  book,
  withPending,
  clearRedoHistory,
  getInitialBookSyncPromise,
  glowCloudGreen,
  glowCloudRed,
  updateBookTimestamp,
  queueForSync,
});
```

### Step 3: Test

Run your application and verify:
- ✅ Page loads without errors
- ✅ Content loads correctly
- ✅ Highlights work
- ✅ Hypercites work
- ✅ Edit mode works
- ✅ Sync to PostgreSQL works
- ✅ Undo/redo works

## 📝 Design Principles

1. **Single Responsibility**: Each module handles one specific domain
2. **Dependency Injection**: Modules don't import from each other directly
3. **Backward Compatibility**: Existing code continues to work via facade
4. **Gradual Migration**: Can be adopted incrementally
5. **Clear Organization**: Easy for contributors to find relevant code
6. **Console Log Clarity**: Unique, descriptive filenames (e.g., `syncHypercitesToPostgreSQL.js`) for easy debugging in browser DevTools

## 🐛 Troubleshooting

**"Module not found" errors**
- Check import paths - use `./indexedDB/index.js` not `./indexedDB.js`
- Ensure `indexedDB/` directory is in the same location as `indexedDB.js`

**"Cannot read property of undefined" errors**
- Ensure modules are initialized with `initializeDatabaseModules()`
- Check that all required dependencies are provided

**Sync not working**
- Verify `debouncedMasterSync` is initialized
- Check browser console for sync errors
- Ensure `queueForSync()` is being called

## 📚 Further Reading

- See `CLAUDE.md` in project root for overall architecture
- See individual module files for detailed documentation
- See `indexedDB-compat.js` for the backward compatibility facade

## ✅ Refactoring Status

**100% Complete** - All functions from the original 3,257-line `indexedDB.js` file have been extracted into the modular structure.

**What was extracted:**
- ✅ Core operations (connection, utilities, library)
- ✅ Node operations (read, write, batch, delete, normalize)
- ✅ Highlight operations and sync
- ✅ Hypercite operations and sync
- ✅ Footnote operations and sync
- ✅ Reference operations and sync
- ✅ Sync queue system (queue, master sync, unload)
- ✅ Database utilities (retry, cleanup)
- ✅ All PostgreSQL sync functions
- ✅ Dependency injection and initialization system

**Next steps:**
- Migrate existing imports from `indexedDB-compat.js` to `indexedDB/index.js`
- Remove `indexedDB-compat.js` once all imports migrated
- Consider adding TypeScript definitions
- Consider adding unit tests for each module
