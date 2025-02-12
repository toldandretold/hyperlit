
window.cachedTimestamp = localStorage.getItem("markdownLastModified") || "null";
console.log("📂 Initial Cached Timestamp:", window.cachedTimestamp);

function reloadMarkdownFromCache() {
    console.log("✅ Reloading Markdown from cache...");
    let cachedMarkdown = localStorage.getItem("cachedMarkdown");
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

// ========= IndexedDB Setup =========
const DB_VERSION = 4; // Use a consistent version
async function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("MarkdownDB", DB_VERSION);
        request.onupgradeneeded = event => {
            console.log("📌 Resetting IndexedDB...");
            const db = event.target.result;
            if (db.objectStoreNames.contains("nodeChunks")) {
                db.deleteObjectStore("nodeChunks");
            }
            if (db.objectStoreNames.contains("markdownStore")) {
                db.deleteObjectStore("markdownStore");
            }
            db.createObjectStore("nodeChunks");
            db.createObjectStore("markdownStore");
            console.log("✅ IndexedDB stores created.");
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => {
            console.error("❌ IndexedDB failed to open:", event.target.error);
            reject("IndexedDB Error: " + event.target.error);
        };
    });
}
window.openDatabase = openDatabase;

async function checkIndexedDBSize() {
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
window.checkIndexedDBSize = checkIndexedDBSize;

async function getNodeChunksFromIndexedDB() {
    if (!window.db) {
        window.db = await openDatabase();
    }
    const tx = window.db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    return new Promise((resolve, reject) => {
        const request = store.get("latest");
        request.onsuccess = () => {
            console.log("✅ Retrieved nodeChunks from IndexedDB.");
            resolve(request.result || []);
        };
        request.onerror = () => reject("❌ Error loading nodeChunks from IndexedDB");
    });
}
window.getNodeChunksFromIndexedDB = getNodeChunksFromIndexedDB;

async function saveNodeChunksToIndexedDB(nodeChunks) {
    console.log("📝 Attempting to save nodeChunks to IndexedDB:", nodeChunks);
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    store.put(nodeChunks, "latest");
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log("✅ nodeChunks successfully saved in IndexedDB.");
            resolve();
        };
        tx.onerror = () => {
            console.error("❌ Error saving nodeChunks to IndexedDB");
            reject();
        };
    });
}
window.saveNodeChunksToIndexedDB = saveNodeChunksToIndexedDB;


// === pulling from cache/indexedDB // 

function reconstructSavedChunks() {
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

window.reconstructSavedChunks = reconstructSavedChunks;

async function clearIndexedDB() {
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

window.clearIndexedDB = clearIndexedDB;


async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        let request = indexedDB.open("MarkdownCache", 2); // ⬆️ Increment version to trigger upgrade

        request.onerror = () => reject("❌ IndexedDB Error");

        request.onupgradeneeded = (event) => {
            console.log("⚡ IndexedDB upgrade detected: Ensuring 'footnotes' store exists...");
            let db = event.target.result;

            // ✅ Create "footnotes" object store if missing
            if (!db.objectStoreNames.contains("footnotes")) {
                db.createObjectStore("footnotes", { keyPath: "id" });
                console.log("✅ Created 'footnotes' object store.");
            }
        };

        request.onsuccess = (event) => {
            console.log("✅ IndexedDB initialized successfully.");
            resolve(event.target.result);
        };
    });
}


window.initIndexedDB = initIndexedDB;


// footnotes //

async function getFootnotesFromIndexedDB() {
    let db = await initIndexedDB(); // ✅ Ensures DB is initialized

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ 'footnotes' object store still missing after initialization.");
            return resolve(null);
        }

        let transaction = db.transaction(["footnotes"], "readonly");
        let store = transaction.objectStore("footnotes");
        let getRequest = store.get("latest");

        getRequest.onsuccess = () => resolve(getRequest.result?.data || null);
        getRequest.onerror = () => resolve(null);
    });
}

window.getFootnotesFromIndexedDB = getFootnotesFromIndexedDB;

async function saveFootnotesToIndexedDB(footnotesData) {
    let db = await initIndexedDB(); // ✅ Ensures DB is initialized

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ Cannot save: 'footnotes' store missing.");
            return reject("Object store missing");
        }

        let transaction = db.transaction(["footnotes"], "readwrite");
        let store = transaction.objectStore("footnotes");

        let request = store.put({ id: "latest", data: footnotesData });
        request.onsuccess = () => resolve();
        request.onerror = () => reject("❌ Failed to save footnotes to IndexedDB");
    });
}

window. saveFootnotesToIndexedDB = saveFootnotesToIndexedDB;


