import {
  book,
  mainContentDiv
} from './reader-DOMContentLoaded.js';

import {
    parseMarkdownIntoChunks
} from './convert-markdown.js';

// Helper function to get the current page URL as a key
export function getPageKey() {
    // Remove protocol, query parameters, and hash to get a clean URL
    return window.location.pathname;
}

// cache-indexedDB.js
export const DB_VERSION = 7; // Increment version for schema change

export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = (event) => {
      console.log("📌 Upgrading IndexedDB to version " + DB_VERSION);
      const db = event.target.result;

      // List all stores that need to be created with the same keyPath.
      const storeNames = ["nodeChunks", "markdownStore", "footnotes"];

      storeNames.forEach((storeName) => {
        // Delete the object store if it already exists.
        if (db.objectStoreNames.contains(storeName)) {
          db.deleteObjectStore(storeName);
          console.log(`Deleted existing store: ${storeName}`);
        }

        // Create the store with the composite key [url, container, book].
        db.createObjectStore(storeName, {
          keyPath: ["url", "container", "book"],
        });
        console.log(
          `✅ Created store '${storeName}' with composite keyPath: ["url", "container", "book"]`
        );
      });
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}

export async function checkIndexedDBSize() {
    let dbRequest = indexedDB.open("MarkdownDB", DB_VERSION); // Use same version
    dbRequest.onsuccess = function(event) {
        let db = event.target.result;
        let tx = db.transaction("nodeChunks", "readonly");
        let store = tx.objectStore("nodeChunks");
        let getRequest = store.get("latest");
        getRequest.onsuccess = function() {
            let data = getRequest.result;
            if (data) {
                let sizeInKB = new Blob([JSON.stringify(data)]).size / 1024;
                console.log("📂 IndexedDB nodeChunks Size:", sizeInKB.toFixed(2), "KB");
            } else {
                console.log("❌ No data found in IndexedDB.");
            }
        };
        getRequest.onerror = function() {
            console.log("❌ Error retrieving data from IndexedDB.");
        };
    };
    dbRequest.onerror = function() {
        console.log("❌ Error opening IndexedDB.");
    };
}

export async function saveNodeChunksToIndexedDB(
  nodeChunks,
  containerId = "default",
  bookId = "latest"
) {
  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readwrite");
  const store = tx.objectStore("nodeChunks");

  store.put({
    url: window.location.pathname,
    container: containerId,
    book: bookId,
    data: nodeChunks
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

export async function getNodeChunksFromIndexedDB() {
    if (!window.db) {
        window.db = await openDatabase();
    }
    const tx = window.db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    
    return new Promise((resolve, reject) => {
        const request = store.get([getPageKey(), "latest"]);
        request.onsuccess = () => {
            console.log("✅ Retrieved nodeChunks from IndexedDB for", getPageKey());
            resolve(request.result?.data || []);
        };
        request.onerror = () => reject("❌ Error loading nodeChunks from IndexedDB");
    });
}

// === pulling from cache/indexedDB // 
export function reconstructSavedChunks() {
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.error("❌ No `nodeChunks` available to reconstruct `savedChunks`.");
        return;
    }

    // ✅ Ensure we use the latest server timestamp
    let latestServerTimestamp = localStorage.getItem("markdownLastModified") || Date.now().toString();

    let reconstructedChunks = window.nodeChunks.slice(0, 3).map(chunk => ({
        id: chunk.chunk_id,
        html: document.querySelector(`[data-chunk-id="${chunk.chunk_id}"]`)?.outerHTML || null
    })).filter(chunk => chunk.html); // Remove any null chunks

    let reconstructedSavedChunks = { 
        timestamp: latestServerTimestamp,  // ✅ Ensure we use the latest stored timestamp
        chunks: reconstructedChunks 
    };

    localStorage.setItem("savedChunks", JSON.stringify(reconstructedSavedChunks));

    console.log("✅ `savedChunks` successfully reconstructed and stored with timestamp:", latestServerTimestamp);
}

export async function clearIndexedDB() {
    try {
        let db = await openDatabase();
        let tx = db.transaction("nodeChunks", "readwrite");
        let store = tx.objectStore("nodeChunks");
        store.clear();
        return new Promise((resolve) => {
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

// footnotes //
// Modified footnotes functions
export async function getFootnotesFromIndexedDB(
  containerId = "default",
  bookId = "latest"
) {
  let db = await openDatabase();

  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("footnotes")) {
      console.warn("⚠️ 'footnotes' object store still missing after initialization.");
      return resolve(null);
    }

    let transaction = db.transaction(["footnotes"], "readonly");
    let store = transaction.objectStore("footnotes");
    let key = [getPageKey(), containerId, bookId];
    let getRequest = store.get(key);

    getRequest.onsuccess = () =>
      resolve(getRequest.result?.data || null);
    getRequest.onerror = () => resolve(null);
  });
}

export async function saveFootnotesToIndexedDB(
  footnotesData,
  containerId = "default",
  bookId = "latest"
) {
  let db = await openDatabase();

  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains("footnotes")) {
      console.warn("⚠️ Cannot save: 'footnotes' store missing.");
      return reject("Object store missing");
    }

    let transaction = db.transaction(["footnotes"], "readwrite");
    let store = transaction.objectStore("footnotes");

    let request = store.put({
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
    url: window.location.pathname, // or your getPageKey() helper
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