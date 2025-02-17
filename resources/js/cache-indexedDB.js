import {
  book,
  mainContentDiv
} from './reader-DOMContentLoaded.js';


// Helper function to get the current page URL as a key
export function getPageKey() {
    // Remove protocol, query parameters, and hash to get a clean URL
    return window.location.pathname;
}

// Modified localStorage functions with URL-specific keys
function getLocalStorageKey(baseKey) {
    return `${baseKey}_${getPageKey()}`;
}



export function reloadMarkdownFromCache() {
    console.log("✅ Reloading Markdown from cache...");
    let cachedMarkdown = localStorage.getItem(getLocalStorageKey("cachedMarkdown"));
    if (cachedMarkdown) {
        console.log("✅ Using Cached Markdown for rendering.");
        window.markdownContent = cachedMarkdown;
        window.nodeChunks = parseMarkdownIntoChunks(cachedMarkdown);
        initializePage();
    } else {
        console.warn("⚠️ No cached Markdown found, fetching...");
        loadMarkdownContent();
    }
}



// cache-indexedDB.js
export const DB_VERSION = 6; // Increment version for schema change

export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = event => {
      console.log("📌 Resetting IndexedDB...");
      const db = event.target.result;

      // Delete existing stores
      if (db.objectStoreNames.contains("nodeChunks")) {
        db.deleteObjectStore("nodeChunks");
      }
      if (db.objectStoreNames.contains("markdownStore")) {
        db.deleteObjectStore("markdownStore");
      }
      if (db.objectStoreNames.contains("footnotes")) {
        db.deleteObjectStore("footnotes"); // Delete the footnotes store if it exists
      }

      // Create new stores with composite keys
      db.createObjectStore("nodeChunks", {
        keyPath: ["url", "id"]
      });
      db.createObjectStore("markdownStore", {
        keyPath: ["url", "id"]
      });
      db.createObjectStore("footnotes", {
        keyPath: ["url", "id"]
      }); // Create the footnotes store with the correct keyPath
      console.log("✅ IndexedDB stores created with URL-specific keys.");
    };

    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => {
      console.error("❌ IndexedDB failed to open:", event.target.error);
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


export async function saveNodeChunksToIndexedDB(nodeChunks) {
    console.log("📝 Attempting to save nodeChunks to IndexedDB for", getPageKey());
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    
    // Save with URL-specific key
    store.put({
        url: getPageKey(),
        id: "latest",
        data: nodeChunks
    });

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log("✅ nodeChunks successfully saved in IndexedDB for", getPageKey());
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



export async function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION); // Use the correct database name and version

    request.onerror = () => {
      console.error("❌ IndexedDB Error");
      reject("❌ IndexedDB Error"); // Reject the promise on error
    };

    request.onupgradeneeded = (event) => {
      console.log("⚡ IndexedDB upgrade detected: Ensuring 'footnotes' store exists...");
      const db = event.target.result;

      // ✅ Create "footnotes" object store if missing
      if (!db.objectStoreNames.contains("footnotes")) {
        db.createObjectStore("footnotes", {
          keyPath: ["url", "id"]
        }); // Use the correct keyPath
        console.log("✅ Created 'footnotes' object store with composite key.");
      }
    };

    request.onsuccess = (event) => {
      console.log("✅ IndexedDB initialized successfully.");
      resolve(event.target.result);
    };
  });
}





// footnotes //

// Modified footnotes functions
export async function getFootnotesFromIndexedDB() {
    let db = await initIndexedDB();

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ 'footnotes' object store still missing after initialization.");
            return resolve(null);
        }

        let transaction = db.transaction(["footnotes"], "readonly");
        let store = transaction.objectStore("footnotes");
        let getRequest = store.get([getPageKey(), "latest"]);

        getRequest.onsuccess = () => resolve(getRequest.result?.data || null);
        getRequest.onerror = () => resolve(null);
    });
}

export async function saveFootnotesToIndexedDB(footnotesData) {
    let db = await initIndexedDB();

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ Cannot save: 'footnotes' store missing.");
            return reject("Object store missing");
        }

        let transaction = db.transaction(["footnotes"], "readwrite");
        let store = transaction.objectStore("footnotes");

        let request = store.put({
            url: getPageKey(),
            id: "latest",
            data: footnotesData
        });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject("❌ Failed to save footnotes to IndexedDB");
    });
}

