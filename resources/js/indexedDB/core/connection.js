/**
 * Database Connection Module
 * Handles IndexedDB connection and schema management
 */

/**
 * Database schema version
 * IMPORTANT: Increment this version number ONLY when you need to change the database schema.
 * For instance, if you add a new store, add a new index, or modify a keyPath.
 *
 * Version 23: Added 'license' and 'custom_license_text' fields to library store
 * Version 24: Added multi-entry node_id index to hyperlights and hypercites stores
 */
export const DB_VERSION = 24;

/**
 * Opens (or creates) the IndexedDB database.
 * This function implements proper schema migration using `event.oldVersion`.
 * It will preserve existing data during upgrades and only apply necessary changes.
 *
 * @returns {Promise<IDBDatabase>} The opened database instance
 */
export async function openDatabase() {
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
          indices: ["book", "referenceId"],
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
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}
