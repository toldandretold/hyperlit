import { book, mainContentDiv } from "./app.js";

/**
 * Returns the current page URL (without protocol, query params, etc.) for use
 * as a composite key.
 */
export function getPageKey() {
  const key = window.location.pathname;
  console.log("getPageKey() returns:", key);
  return key;
}

export const DB_VERSION = 9;

/**
 * Opens (or creates) the IndexedDB database.
 * IMPORTANT: For the nodeChunks store, we now use startLine as the keyPath,
 * and chunk_id as an index.
 */
export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = event => {
      console.log("📌 Upgrading IndexedDB to version " + DB_VERSION);
      const db = event.target.result;

      const storeConfigs = [
        {
          name: "nodeChunks",
          keyPath: "startLine",
          indices: ["chunk_id", "url", "container", "book"]
        },
        {
          name: "markdownStore",
          keyPath: ["url", "container", "book"]
        },
        {
          name: "footnotes",
          keyPath: ["url", "container", "book"]
        },
        {
          name: "hyperlights",
          keyPath: ["url", "container", "book", "hyperlight_id"],
          indices: ["hyperlight_id"] // Add this line to create the index
        },
        {
          name: "hypercites",
          keyPath: ["url", "container", "book", "hypercite_id"]
        }
      ];

      storeConfigs.forEach(({ name, keyPath, indices }) => {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
          console.log(`Deleted existing store: ${name}`);
        }
        const objectStore = db.createObjectStore(name, { keyPath });
        console.log(
          `✅ Created store '${name}' with keyPath: ${JSON.stringify(
            keyPath
          )}`
        );

        if (indices) {
          indices.forEach(indexName => {
            objectStore.createIndex(indexName, indexName, { unique: false });
            console.log(`  ✅ Created index '${indexName}'`);
          });
        }
      });
    };

    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}


/**
 * Saves nodeChunks (the array of chunk records) to IndexedDB.
 * It expects that each record already has:
 *   - url, container, and book (which are added here),
 *   - and a chunk_id property produced by the new parser,
 *   - AND a startLine that is unique.
 */
export async function saveNodeChunksToIndexedDB(
  nodeChunks,
  containerId = "default",
  bookId = "latest"
) {
  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readwrite");
  const store = tx.objectStore("nodeChunks");

  nodeChunks.forEach(record => {
    record.url = window.location.pathname;
    record.container = containerId;
    record.book = bookId;
    // record.chunk_id is already set by the parser
    // record.startLine is already set by the parser, and MUST be unique
    store.put(record);
  });

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(
        "✅ nodeChunks successfully saved in IndexedDB for",
        containerId,
        bookId
      );
      resolve();
    };
    tx.onerror = () => {
      console.error("❌ Error saving nodeChunks to IndexedDB");
      reject();
    };
  });
}

/**
 * Retrieves nodeChunks from IndexedDB using the index on chunk_id, url,
 * container, and book.
 */
export async function getNodeChunksFromIndexedDB(
  containerId = "default",
  bookId = "latest"
) {
  console.log("Fetching nodeChunks for container:", containerId, "and book:", bookId);
  
  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readonly");
  const store = tx.objectStore("nodeChunks");

  // Use the "book" index instead of "chunk_id"
  const bookIndex = store.index("book");

  return new Promise((resolve, reject) => {
    // Get all records for the specified bookId
    const request = bookIndex.getAll(bookId);
    request.onsuccess = () => {
      let results = request.result || [];

      // Optionally filter further by container and url (the composite key)
      results = results.filter(record => 
        record.container === containerId &&
        record.url === window.location.pathname
      );

      // If you need the records sorted by chunk_id, you can do so:
      results.sort((a, b) => a.chunk_id - b.chunk_id);

      console.log("✅ Retrieved nodeChunks from IndexedDB for", getPageKey());
      resolve(results);
    };
    request.onerror = () => {
      reject("❌ Error loading nodeChunks from IndexedDB");
    };
  });
}


/**
 * Reconstructs saved chunks based on window.nodeChunks.
 * (This is optional and may be used for debugging or to rebuild UI state.)
 */
/*export function reconstructSavedChunks() {
  if (!window.nodeChunks || window.nodeChunks.length === 0) {
    console.error("❌ No `nodeChunks` available to reconstruct `savedChunks`.");
    return;
  }

  // Group records by chunk_id.
  const groupedByChunk = window.nodeChunks.reduce((acc, record) => {
    if (!acc[record.chunk_id]) {
      acc[record.chunk_id] = [];
    }
    acc[record.chunk_id].push(record);
    return acc;
  }, {});

  // For demonstration, use the first three groups.
  const reconstructedChunks = Object.keys(groupedByChunk)
    .slice(0, 3)
    .map(chunkId => {
      const html = document.querySelector(`[data-chunk-id="${chunkId}"]`)
        ?.outerHTML;
      return html ? { id: chunkId, html } : null;
    })
    .filter(chunk => chunk !== null);

  const latestServerTimestamp =
    localStorage.getItem("markdownLastModified") || Date.now().toString();

  const reconstructedSavedChunks = {
    timestamp: latestServerTimestamp,
    chunks: reconstructedChunks
  };

  localStorage.setItem(
    "savedChunks",
    JSON.stringify(reconstructedSavedChunks)
  );
  console.log(
    "✅ `savedChunks` successfully reconstructed and stored with timestamp:",
    latestServerTimestamp
  );
}*/

/**
 * Clears the nodeChunks store in IndexedDB.
 */
export async function clearIndexedDB() {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    store.clear();
    return new Promise(resolve => {
      tx.oncomplete = () => {
        console.log("🗑 IndexedDB `nodeChunks` cleared.");
        resolve();
      };
      tx.onerror = () => {
        console.error("❌ Error clearing IndexedDB.");
        resolve();
      };
    });
  } catch (error) {
    console.error("❌ Failed to clear IndexedDB:", error);
  }
}

/* --- Footnotes functions remain mostly unchanged --- */

export async function getFootnotesFromIndexedDB(
  containerId = "default",
  bookId = "latest"
) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("footnotes")) {
      console.warn(
        "⚠️ 'footnotes' object store still missing after initialization."
      );
      return resolve(null);
    }
    const transaction = db.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");
    let key = [getPageKey(), containerId, bookId];
    let getRequest = store.get(key);
    getRequest.onsuccess = () => resolve(getRequest.result?.data || null);
    getRequest.onerror = () => resolve(null);
  });
}

export async function saveFootnotesToIndexedDB(
  footnotesData,
  containerId = "default",
  bookId = "latest"
) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("footnotes")) {
      console.warn("⚠️ Cannot save: 'footnotes' store missing.");
      return reject("Object store missing");
    }
    const transaction = db.transaction(["footnotes"], "readwrite");
    const store = transaction.objectStore("footnotes");
    const request = store.put({
      url: getPageKey(),
      container: containerId,
      book: bookId,
      data: footnotesData
    });
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject("❌ Failed to save footnotes to IndexedDB");
  });
}

function getCompositeKey(containerId = "default", bookId = "latest") {
  return {
    url: window.location.pathname,
    container: containerId,
    book: bookId
  };
}

export function getLocalStorageKey(
  baseKey,
  containerId = "default",
  bookId = "latest"
) {
  return `${baseKey}_${window.location.pathname}_${containerId}_${bookId}`;
}

export async function clearNodeChunksForBook(containerId = "default", bookId = "latest") {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    
    // Use the "book" index to find keys for this book.
    const bookIndex = store.index("book");
    const request = bookIndex.getAllKeys(bookId);
    
    request.onsuccess = () => {
      const keys = request.result || [];
      // Optionally filter keys by container and url
      keys.forEach(key => {
        store.delete(key);
      });
      console.log(`Cleared nodeChunks for container "${containerId}" and book "${bookId}".`);
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject("Error clearing nodeChunks for current book.");
    });
  } catch (error) {
    console.error("Failed to clear nodeChunks for book:", error);
  }
}

