/**
 * Database Connection Module
 * Handles IndexedDB connection and schema management
 */

/**
 * Database schema version
 * IMPORTANT: Increment this version number ONLY when you need to change the database schema.
 * For instance, if you add a new store, add a new index, or modify a keyPath.
 */
export const DB_VERSION = 21;

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
          name: "nodeChunks",
          keyPath: ["book", "startLine"],
          indices: [
            "chunk_id",
            "book",
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
          ],
        },
        {
          name: "footnotes",
          keyPath: ["book", "footnoteId"],
          indices: ["book", "footnoteId"],
        },
        {
          name: "references",
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
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
          ],
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: [
            "hyperciteId",
            "book",
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
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
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}
