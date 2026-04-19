/**
 * Database Connection Module
 * Handles IndexedDB connection and schema management.
 *
 * Uses a singleton cached connection so the entire app shares one IDBDatabase
 * instance. Safari iOS aggressively kills IDB connections when tabs are
 * backgrounded — the `onclose` listener detects this and nulls the cache so
 * the next caller transparently reopens.
 */

/**
 * Database schema version
 * IMPORTANT: Increment this version number ONLY when you need to change the database schema.
 * For instance, if you add a new store, add a new index, or modify a keyPath.
 *
 * Version 23: Added 'license' and 'custom_license_text' fields to library store
 * Version 24: Added multi-entry node_id index to hyperlights and hypercites stores
 * Version 25: Fixed node_id index to properly set multiEntry: true
 * Version 26: Added source_id index to bibliography store for linked citations
 */
export const DB_VERSION = 26;

// Exponential backoff delays for IDB connection retries (ms).
// Covers iOS bfcache recovery which can take 1-5 seconds.
const RETRY_DELAYS = [200, 400, 800, 1500, 2500];

// ── Singleton state ─────────────────────────────────────────────────
let cachedDb = null;
let openingPromise = null; // prevents parallel open races

/**
 * Opens (or returns the cached) IndexedDB database.
 * Attaches `onclose` and `onversionchange` handlers so the singleton
 * self-heals when Safari kills the connection or another tab upgrades.
 *
 * @returns {Promise<IDBDatabase>} The opened database instance
 */
export async function openDatabase(retryCount = 0) {
  // Return cached connection if still alive
  if (cachedDb) {
    try {
      // Quick liveness check — if the connection is dead this will throw
      cachedDb.transaction('nodes', 'readonly');
      return cachedDb;
    } catch {
      // Connection is dead, clear and reopen
      console.warn('[Connection] Cached connection is dead, reopening...');
      cachedDb = null;
    }
  }

  // Prevent parallel opens — if another caller is already opening, wait for it
  if (openingPromise) return openingPromise;

  openingPromise = _openFresh(retryCount);
  try {
    const db = await openingPromise;
    return db;
  } finally {
    openingPromise = null;
  }
}

/**
 * Explicitly close the cached connection and clear the singleton.
 * Used by HealthMonitor before recovery and by bfcache restore.
 */
export function closeDatabase() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // Already closed — ignore
    }
    console.log('[Connection] Closed cached connection');
    cachedDb = null;
  }
}

/**
 * Convenience wrapper: opens the connection (or returns cached) with an
 * internal retry on failure so callers don't need their own retry loops.
 *
 * @returns {Promise<IDBDatabase>}
 */
export async function getConnection() {
  try {
    return await openDatabase();
  } catch (e) {
    // One transparent retry after clearing the cache
    console.warn('[Connection] getConnection first attempt failed, retrying...', e);
    cachedDb = null;
    return await openDatabase();
  }
}

/**
 * Wrap a write operation in a Web Lock so only one tab writes at a time.
 * If the lock isn't available (another tab holds it), the callback is skipped
 * and the function returns `undefined` — the server sync will catch up later.
 *
 * Falls back to executing without a lock on browsers that lack navigator.locks
 * (iOS < 15.4).
 *
 * @param {Function} fn  async callback receiving the IDBDatabase
 * @returns {Promise<*>} result of fn, or undefined if lock wasn't available
 */
export async function withWriteLock(fn) {
  if (typeof navigator.locks?.request !== 'function') {
    // No Web Locks API — run without lock (same as today's behaviour)
    const db = await getConnection();
    return fn(db);
  }

  return navigator.locks.request(
    'hyperlit-idb-write',
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        console.warn('[Connection] Write lock held by another tab — skipping IDB write');
        return undefined;
      }
      const db = await getConnection();
      return fn(db);
    }
  );
}

// ── Internal open logic ─────────────────────────────────────────────

async function _openFresh(retryCount = 0) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = (event) => {
      console.log(`📌 IndexedDB upgrade: from version ${event.oldVersion} to ${event.newVersion}`);
      const db = event.target.result;
      const transaction = event.target.transaction;
      const oldVersion = event.oldVersion;

      // Define ALL store configurations for the FINAL desired schema
      const ALL_STORE_CONFIGS = [
        {
          name: "nodes",
          keyPath: ["book", "startLine"],
          indices: [
            "chunk_id",
            "book",
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false },
            { name: "node_id", keyPath: "node_id", unique: false }
          ],
        },
        {
          name: "footnotes",
          keyPath: ["book", "footnoteId"],
          indices: ["book", "footnoteId"],
        },
        {
          name: "bibliography",
          keyPath: ["book", "referenceId"],
          indices: ["book", "referenceId", "source_id"],
        },
        {
          name: "markdownStore",
          keyPath: ["url", "book"],
        },
        {
          name: "hyperlights",
          keyPath: ["book", "hyperlight_id"],
          indices: [
            "hyperlight_id",
            "book",
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false },
            { name: "node_id", keyPath: "node_id", unique: false, multiEntry: true }
          ],
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: [
            "hyperciteId",
            "book",
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false },
            { name: "node_id", keyPath: "node_id", unique: false, multiEntry: true }
          ],
        },
        {
          name: "library",
          keyPath: "book",
        },
        {
          name: "historyLog",
          keyPath: "id",
          autoIncrement: true,
          indices: ["status", "bookId"],
        },
        {
          name: "redoLog",
          keyPath: "id",
          autoIncrement: true,
          indices: ["bookId"],
        },
      ];

      // Migration logic for schema version 21
      if (oldVersion < 21) {
        console.log("Migrating to schema version 21: Updating footnotes and adding references.");

        // Delete old footnotes store to update schema
        if (db.objectStoreNames.contains("footnotes")) {
          db.deleteObjectStore("footnotes");
          console.log("🔥 Deleted old 'footnotes' store to update schema.");
        }

        // Create stores from configuration
        ALL_STORE_CONFIGS.forEach((storeConfig) => {
          if (!db.objectStoreNames.contains(storeConfig.name)) {
            const storeOptions = { keyPath: storeConfig.keyPath };
            if (storeConfig.autoIncrement) {
              storeOptions.autoIncrement = true;
            }
            const store = db.createObjectStore(storeConfig.name, storeOptions);
            console.log(`✅ Created store: ${storeConfig.name}`);

            // Create indices for the newly created store
            if (storeConfig.indices) {
              storeConfig.indices.forEach((indexDef) => {
                const indexName = typeof indexDef === "string" ? indexDef : indexDef.name;
                const indexKeyPath = typeof indexDef === "string" ? indexDef : indexDef.keyPath;
                const indexUnique = (typeof indexDef !== "string" && indexDef.unique) || false;

                store.createIndex(indexName, indexKeyPath, { unique: indexUnique });
                console.log(`  ✅ Created index '${indexName}' for '${storeConfig.name}'`);
              });
            }
          }
        });
      }

      // Migration logic for schema version 22
      if (oldVersion < 22) {
        console.log("📦 Migrating to schema version 22: Renaming nodeChunks → nodes, references → bibliography");

        // Migrate nodeChunks → nodes
        if (db.objectStoreNames.contains("nodeChunks")) {
          console.log("🔄 Migrating nodeChunks → nodes...");

          // Get old data
          const oldNodeStore = transaction.objectStore("nodeChunks");
          const nodeData = [];
          const nodeRequest = oldNodeStore.openCursor();

          nodeRequest.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              nodeData.push(cursor.value);
              cursor.continue();
            } else {
              // All data collected, now delete old store
              db.deleteObjectStore("nodeChunks");
              console.log("🔥 Deleted old 'nodeChunks' store");

              // Create new store
              const newNodeStore = db.createObjectStore("nodes", { keyPath: ["book", "startLine"] });
              newNodeStore.createIndex("chunk_id", "chunk_id", { unique: false });
              newNodeStore.createIndex("book", "book", { unique: false });
              newNodeStore.createIndex("book_startLine", ["book", "startLine"], { unique: false });
              console.log("✅ Created new 'nodes' store");

              // Copy data to new store
              nodeData.forEach(item => {
                newNodeStore.add(item);
              });
              console.log(`✅ Migrated ${nodeData.length} records to 'nodes' store`);
            }
          };
        }

        // Migrate references → bibliography
        if (db.objectStoreNames.contains("references")) {
          console.log("🔄 Migrating references → bibliography...");

          // Get old data
          const oldRefStore = transaction.objectStore("references");
          const refData = [];
          const refRequest = oldRefStore.openCursor();

          refRequest.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              refData.push(cursor.value);
              cursor.continue();
            } else {
              // All data collected, now delete old store
              db.deleteObjectStore("references");
              console.log("🔥 Deleted old 'references' store");

              // Create new store
              const newBibStore = db.createObjectStore("bibliography", { keyPath: ["book", "referenceId"] });
              newBibStore.createIndex("book", "book", { unique: false });
              newBibStore.createIndex("referenceId", "referenceId", { unique: false });
              console.log("✅ Created new 'bibliography' store");

              // Copy data to new store
              refData.forEach(item => {
                newBibStore.add(item);
              });
              console.log(`✅ Migrated ${refData.length} records to 'bibliography' store`);
            }
          };
        }
      }

      // Migration logic for schema version 24
      if (oldVersion < 24) {
        console.log("📦 Migrating to schema version 24: Adding node_id index to nodes, hyperlights and hypercites");

        // Add node_id index to nodes
        if (db.objectStoreNames.contains("nodes")) {
          const nodesStore = transaction.objectStore("nodes");
          if (!nodesStore.indexNames.contains("node_id")) {
            nodesStore.createIndex("node_id", "node_id", { unique: false });
            console.log("✅ Added node_id index to nodes store");
          }
        }

        // Add node_id index to hyperlights
        if (db.objectStoreNames.contains("hyperlights")) {
          const hyperlightsStore = transaction.objectStore("hyperlights");
          if (!hyperlightsStore.indexNames.contains("node_id")) {
            hyperlightsStore.createIndex("node_id", "node_id", { unique: false, multiEntry: true });
            console.log("✅ Added multi-entry node_id index to hyperlights store");
          }
        }

        // Add node_id index to hypercites
        if (db.objectStoreNames.contains("hypercites")) {
          const hypercitesStore = transaction.objectStore("hypercites");
          if (!hypercitesStore.indexNames.contains("node_id")) {
            hypercitesStore.createIndex("node_id", "node_id", { unique: false, multiEntry: true });
            console.log("✅ Added multi-entry node_id index to hypercites store");
          }
        }
      }

      // Migration logic for schema version 25
      if (oldVersion < 25) {
        console.log("📦 Migrating to schema version 25: Fixing node_id index to set multiEntry: true");

        // Fix node_id index on hyperlights - delete and recreate with multiEntry
        if (db.objectStoreNames.contains("hyperlights")) {
          const hyperlightsStore = transaction.objectStore("hyperlights");
          if (hyperlightsStore.indexNames.contains("node_id")) {
            hyperlightsStore.deleteIndex("node_id");
            console.log("🔥 Deleted old node_id index from hyperlights");
          }
          hyperlightsStore.createIndex("node_id", "node_id", { unique: false, multiEntry: true });
          console.log("✅ Recreated node_id index on hyperlights with multiEntry: true");
        }

        // Fix node_id index on hypercites - delete and recreate with multiEntry
        if (db.objectStoreNames.contains("hypercites")) {
          const hypercitesStore = transaction.objectStore("hypercites");
          if (hypercitesStore.indexNames.contains("node_id")) {
            hypercitesStore.deleteIndex("node_id");
            console.log("🔥 Deleted old node_id index from hypercites");
          }
          hypercitesStore.createIndex("node_id", "node_id", { unique: false, multiEntry: true });
          console.log("✅ Recreated node_id index on hypercites with multiEntry: true");
        }
      }

      // Migration logic for schema version 26
      if (oldVersion < 26) {
        console.log("📦 Migrating to schema version 26: Adding source_id index to bibliography");

        // Add source_id index to bibliography store for linked citations
        if (db.objectStoreNames.contains("bibliography")) {
          const bibliographyStore = transaction.objectStore("bibliography");
          if (!bibliographyStore.indexNames.contains("source_id")) {
            bibliographyStore.createIndex("source_id", "source_id", { unique: false });
            console.log("✅ Added source_id index to bibliography store");
          }
        }
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;

      // Safari fires `close` when it kills the connection in the background.
      db.onclose = () => {
        console.warn('[Connection] IDB connection closed by browser');
        if (cachedDb === db) cachedDb = null;
      };

      // Another tab opened a higher version — close gracefully so it can upgrade.
      db.onversionchange = () => {
        console.warn('[Connection] IDB version change detected — closing for upgrade');
        db.close();
        if (cachedDb === db) cachedDb = null;
      };

      cachedDb = db;
      resolve(db);
    };

    request.onerror = async (event) => {
      const error = event.target.error;
      const isConnectionLost =
        error?.name === 'UnknownError' &&
        error?.message?.includes('Connection to Indexed Database server lost');

      if (isConnectionLost && retryCount < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[retryCount];
        console.warn(`IDB connection lost, retrying in ${delay}ms (${retryCount + 1}/${RETRY_DELAYS.length})...`);
        await new Promise(r => setTimeout(r, delay));
        try {
          resolve(await _openFresh(retryCount + 1));
        } catch (e) {
          reject(e);
        }
        return;
      }

      console.error("Failed to open IndexedDB:", error);
      reject(`IndexedDB Error: ${error}`);
    };
  });
}
