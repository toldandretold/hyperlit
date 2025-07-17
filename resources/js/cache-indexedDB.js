import {
  broadcastToOpenTabs
} from './BroadcastListener.js';
import { withPending } from "./operationState.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser } from './auth.js';   

export const DB_VERSION = 16;
import { book } from "./app.js";


 
/**
 * Opens (or creates) the IndexedDB database.
 * 
 * For the nodeChunks store, we now use a composite key: [book, startLine],
 * and keep only chunk_id as an index.
 * 
 * For the footnotes store, the key is now just "book".
 */
export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = (event) => {
      console.log("📌 Upgrading IndexedDB to version " + DB_VERSION);
      const db = event.target.result;

      const storeConfigs = [
        {
          name: "nodeChunks",
          keyPath: ["book", "startLine"],
          indices: ["chunk_id", "book"],
        },
        {
          name: "footnotes",
          keyPath: "book",
        },
        {
          name: "markdownStore",
          keyPath: ["url", "book"],
        },
        {
          name: "hyperlights",
          keyPath: ["book", "hyperlight_id"],
          indices: ["hyperlight_id", "book"],
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: ["hyperciteId", "book"],
        },
        {
          name: "library",
          keyPath: "book",
        },
        // ✅ ADD THIS: failedSyncs store for retry mechanism
        {
          name: "failedSyncs",
          keyPath: "bookId",
          indices: ["timestamp", "syncType"],
        }
      ];

      storeConfigs.forEach(({ name, keyPath, indices }) => {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
          console.log(`Deleted existing store: ${name}`);
        }
        const objectStore = db.createObjectStore(name, { keyPath });
        console.log(
          `✅ Created store '${name}' with keyPath: ${JSON.stringify(keyPath)}`
        );
        if (indices) {
          indices.forEach((indexName) => {
            objectStore.createIndex(indexName, indexName, { unique: false });
            console.log(`  ✅ Created index '${indexName}'`);
          });
        }
      });
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}




// In cache-indexedDB.js

/**
 * Adds a new nodeChunk record to IndexedDB.
 * Can operate within an existing transaction or create its own.
 *
 * @param {string} bookId - The book identifier.
 * @param {number} startLine - The line number.
 * @param {string} content - The HTML content for the node.
 * @param {number} [chunkId=0] - The chunk ID.
 * @param {IDBTransaction} [transaction] - An optional existing transaction to use.
 * @returns {Promise<boolean>} - Success status.
 */
export async function addNewBookToIndexedDB(
  bookId,
  startLine,
  content,
  chunkId = 0,
  transaction // <-- The new optional parameter
) {
  // Your withPending wrapper is preserved.
  return withPending(async () => {
    console.log(
      `Adding nodeChunk: book=${bookId}, startLine=${startLine}, chunkId=${chunkId}`
    );

    try {
      // --- MODIFICATION START ---

      // If a transaction is NOT provided, create a new one for the 'nodeChunks' store.
      // Otherwise, use the transaction that was passed in.
      const tx =
        transaction ||
        (await openDatabase()).transaction("nodeChunks", "readwrite");

      const store = tx.objectStore("nodeChunks");
      const numericStartLine = parseNodeId(startLine);

      const nodeChunkRecord = {
        book: bookId,
        startLine: numericStartLine,
        chunk_id: chunkId,
        content: content,
        hyperlights: [],
        hypercites: [], // Preserved your original object structure
      };

      console.log("Creating nodeChunk record:", nodeChunkRecord);
      store.put(nodeChunkRecord);

      // If we are in STANDALONE mode (we created our own transaction),
      // we are responsible for awaiting its completion.
      if (!transaction) {
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => {
            console.log(
              `✅ Successfully added nodeChunk [${bookId}, ${numericStartLine}]`
            );
            resolve(true);
          };
          tx.onerror = (e) => {
            console.error("❌ Error adding nodeChunk:", e.target.error);
            reject(e.target.error);
          };
          tx.onabort = (e) => {
            console.warn("❌ Transaction aborted:", e);
            reject(new Error("Transaction aborted"));
          };
        });
      } else {
        // If we are in SHARED mode, the caller is responsible for the transaction.
        // We just log that our part is done and resolve immediately.
        console.log(
          `✅ Queued nodeChunk [${bookId}, ${numericStartLine}] to existing transaction.`
        );
        return true; // Resolve immediately.
      }
      // --- MODIFICATION END ---
    } catch (err) {
      console.error("❌ Failed to add nodeChunk:", err);
      throw err;
    }
  });
}

export async function saveAllNodeChunksToIndexedDB(
  nodeChunks,
  bookId = "latest",
  onComplete
) {
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    nodeChunks.forEach((record) => {
      record.book = bookId;
      record.startLine = parseNodeId(record.startLine);
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ nodeChunks successfully saved for book:", bookId);
        try {
          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);
        } catch (err) {
          console.warn(
            "⚠️ post-save hook failed (timestamp/sync):",
            err
          );
        } finally {
          if (onComplete) {
            try {
              onComplete();
            } catch (_) {}
          }
          resolve();
        }
      };
      tx.onerror = () => {
        console.error("❌ Error saving nodeChunks to IndexedDB");
        reject();
      };
    });
  });
}

// Helper function to convert a string ID to the appropriate numeric format
export function parseNodeId(id) {
  // If already a number, return it directly
  if (typeof id === 'number') return id;
  
  // Otherwise, convert string to float (works for both "1" and "1.1")
  return parseFloat(id);
}


export function createNodeChunksKey(bookId, startLine) {

  return [bookId, parseNodeId(startLine)];
}


export async function getNodeChunksFromIndexedDB(bookId = "latest") {
  console.log("Fetching nodeChunks for book:", bookId);

  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readonly");
  const store = tx.objectStore("nodeChunks");
  
  return new Promise((resolve, reject) => {
    // Use the book index for more efficient lookup
    const index = store.index("book");
    const request = index.getAll(bookId);
    
    request.onsuccess = () => {
      let results = request.result || [];
      
      // Sort the results by chunk_id for proper lazy loading order
      results.sort((a, b) => a.chunk_id - b.chunk_id);

      console.log(`✅ Retrieved ${results.length} nodeChunks for book: ${bookId}`);
      resolve(results);
    };
    
    request.onerror = () => {
      reject("❌ Error loading nodeChunks from IndexedDB");
    };
  });
}


/**
 * Clears the entire nodeChunks store in IndexedDB.
 */
export async function clearIndexedDB() {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    store.clear();
    return new Promise((resolve) => {
      tx.oncomplete = () => {
        console.log("🗑 IndexedDB 'nodeChunks' cleared.");
        resolve();
      };
      tx.onerror = () => {
        console.error("❌ Error clearing nodeChunks in IndexedDB.");
        resolve();
      };
    });
  } catch (error) {
    console.error("❌ Failed to clear IndexedDB:", error);
  }
}

/* ---------- Footnotes Functions ---------- */

/**
 * Retrieves footnotes data for a specified book from IndexedDB.
 * 
 * The key for footnotes is now simply the book ID.
 */
export async function getFootnotesFromIndexedDB(bookId = "latest") {
  try {
    const db = await openDatabase();
    // Log the object store names to ensure "footnotes" exists.
    console.log("Database object stores:", Array.from(db.objectStoreNames));
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn(
          "⚠️ 'footnotes' object store is missing after initialization."
        );
        return resolve(null);
      }
      const transaction = db.transaction(["footnotes"], "readonly");
      const store = transaction.objectStore("footnotes");
      let getRequest = store.get(bookId);
      getRequest.onsuccess = () => {
        console.log(`Data retrieved for key "${bookId}":`, getRequest.result);
        resolve(getRequest.result?.data || null);
      };
      getRequest.onerror = (event) => {
        console.error(
          "❌ Error retrieving data from IndexedDB for key:",
          bookId,
          event
        );
        resolve(null);
      };
    });
  } catch (error) {
    console.error("❌ Error in getFootnotesFromIndexedDB:", error);
    return null;
  }
}


/**
 * Saves footnotes data for a specified book to IndexedDB.
 *
 * Uses the book ID as the key.
 */
export async function saveFootnotesToIndexedDB(footnotesData, bookId = "latest") {
  console.log("🙏 Attempting to save to 'footnotes' object store in IndexedDB...");

  try {
    // Open the database
    const db = await openDatabase();

    // Return a promise to handle the transaction
    return new Promise((resolve, reject) => {
      // Check if the 'footnotes' object store exists
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn("⚠️ Cannot save: 'footnotes' store missing.");
        return reject("Object store missing");
      }

      // Start a readwrite transaction on the 'footnotes' store
      const transaction = db.transaction(["footnotes"], "readwrite");
      const store = transaction.objectStore("footnotes");

      // Prepare the data to be saved
      const dataToSave = {
        book: bookId, // Use the provided bookId or default to "latest"
        data: footnotesData, // The footnotes data to save
      };

      // Save the data to the store
      const request = store.put(dataToSave);

      // Handle success
      request.onsuccess = async() => {
        console.log("✅ Successfully saved footnotes to IndexedDB.");
          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);
        resolve();
      };

      // Handle errors
      request.onerror = () => {
        console.error("❌ Failed to save footnotes to IndexedDB.");
        reject("Failed to save footnotes to IndexedDB");
      };
    });
  } catch (error) {
    console.error("❌ Error opening database:", error);
    throw error;
  }
}



/**
 * Clears nodeChunks records for a specified book.
 */
export async function clearNodeChunksForBook(bookId = "latest") {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      records.forEach((record) => {
        if (record.book === bookId) {
          const key = [record.book, record.startLine];
          store.delete(key);
        }
      });
      console.log(`Cleared nodeChunks for book "${bookId}".`);
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject("Error clearing nodeChunks for book " + bookId);
    });
  } catch (error) {
    console.error("Failed to clear nodeChunks for book:", error);
  }
}

/**
 * Generates a localStorage key based on a provided base key and book.
 */
export function getLocalStorageKey(baseKey, bookId = "latest") {
  return `${baseKey}_${bookId}`;
}


function processNodeContentHighlightsAndCites(node, existingHypercites = []) {
  const hyperlights = [];
  const hypercites = [];
  
  console.log("Processing node:", node.outerHTML);
  
  // Create a text representation of the node to calculate positions
  const textContent = node.textContent;
  
  // Function to find the text position of an element within its parent
  function findElementPosition(element, parent) {
    // Create a TreeWalker to walk through all text nodes
    const walker = document.createTreeWalker(
      parent,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let position = 0;
    let currentNode;
    
    // Walk through all text nodes until we find one that's inside our target element
    while ((currentNode = walker.nextNode())) {
      // If this text node is inside our target element, we've found the start
      if (element.contains(currentNode) || element === currentNode) {
        return position;
      }
      
      // Otherwise, add this text node's length to our position counter
      position += currentNode.textContent.length;
    }
    
    return -1; // Element not found
  }
  
  // Process <mark> tags for hyperlights
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    const startPos = findElementPosition(mark, node);
    const highlightLength = mark.textContent.length;
    
    if (startPos >= 0) {
      hyperlights.push({
        highlightID: mark.id,
        charStart: startPos,
        charEnd: startPos + highlightLength,
      });
      
      console.log("Calculated hyperlight positions:", {
        id: mark.id,
        text: mark.textContent,
        startPos,
        endPos: startPos + highlightLength,
        totalNodeLength: textContent.length,
      });
    }
  });
  
  // Process <u> tags for hypercites
  const uTags = node.getElementsByTagName("u");
  Array.from(uTags).forEach((uTag) => {
    const startPos = findElementPosition(uTag, node);
    const uLength = uTag.textContent.length;
    
    if (startPos >= 0) {
      // ✅ MERGE: Find existing hypercite data or use defaults
      const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === uTag.id);
      
      hypercites.push({
        hyperciteId: uTag.id,
        charStart: startPos,
        charEnd: startPos + uLength,
        relationshipStatus: existingHypercite?.relationshipStatus || "single",
        citedIN: existingHypercite?.citedIN || []
      });
      
      console.log("Calculated hypercite positions:", {
        id: uTag.id,
        text: uTag.textContent,
        startPos,
        endPos: startPos + uLength,
        totalNodeLength: textContent.length,
      });
    }
  });
  
  // Create a clone to remove the mark and u tags
  const contentClone = node.cloneNode(true);
  
  // Remove all <mark> tags from the cloned content while preserving their text content
  const clonedMarkTags = contentClone.getElementsByTagName("mark");
  while (clonedMarkTags.length > 0) {
    const markTag = clonedMarkTags[0];
    const textContent = markTag.textContent;
    markTag.parentNode.replaceChild(document.createTextNode(textContent), markTag);
  }
  
  // Remove all <u> tags from the cloned content while preserving their text content
  const clonedUTags = contentClone.getElementsByTagName("u");
  while (clonedUTags.length > 0) {
    const uTag = clonedUTags[0];
    const textContent = uTag.textContent;
    uTag.parentNode.replaceChild(document.createTextNode(textContent), uTag);
  }
  
  const result = {
    content: contentClone.outerHTML,
    hyperlights,
    hypercites,
  };
  
  console.log("Processed result:", result);
  return result;
}


export function updateIndexedDBRecord(record) {
  return withPending(async () => {
    const bookId = book || "latest";

    // Find the nearest ancestor with a numeric ID
    let nodeId = record.id;
    let node = document.getElementById(nodeId);
    while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
      node = node.parentElement;
      if (node?.id) nodeId = node.id;
    }

    if (!/^\d+(\.\d+)?$/.test(nodeId)) {
      console.log(
        `Skipping IndexedDB update – no valid parent node ID for ${record.id}`
      );
      return;
    }

    const numericNodeId = parseNodeId(nodeId);
    console.log(
      `Updating IndexedDB record for node ${nodeId} (numeric: ${numericNodeId})`
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const compositeKey = [bookId, numericNodeId];

    // Arrays to collect what we actually save for sync
    let savedNodeChunk = null;
    const savedHyperlights = [];
    const savedHypercites = [];

    // 🔥 USE YOUR EXISTING FUNCTION TO PROPERLY PROCESS THE NODE
    const processedData = node ? processNodeContentHighlightsAndCites(node) : null;

    // Fetch the existing chunk record
    const getReq = chunksStore.get(compositeKey);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      let toSave;

      if (existing) {
        console.log("Existing nodeChunk found for merge:", JSON.stringify(existing));

        // Start with a copy of the existing record to preserve its structure
        toSave = { ...existing };

        // 🔥 USE PROCESSED CONTENT (WITHOUT MARK/U TAGS)
        if (processedData) {
          toSave.content = processedData.content;
          // Update hyperlights and hypercites arrays in the node chunk
          toSave.hyperlights = processedData.hyperlights;
          toSave.hypercites = processedData.hypercites;
        } else {
          // Fallback to record.html if no DOM node available
          toSave.content = record.html;
        }

        // Add the chunk_ID update here
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
          console.log(`Updated chunk_id to ${record.chunk_id} for node ${nodeId}`);
        }

      } else {
        // Case: No existing record, create a new one
        console.log("No existing nodeChunk record, creating new one.");
        toSave = {
          book: bookId,
          startLine: numericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : 0,
          content: processedData ? processedData.content : record.html,
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : []
        };
        console.log("New nodeChunk record to create:", JSON.stringify(toSave));
      }

      console.log("Final nodeChunk record to put:", JSON.stringify(toSave));

      // Store for sync
      savedNodeChunk = toSave;

      // write the node chunk
      chunksStore.put(toSave);

      // 🔥 UPDATE INDIVIDUAL HYPERLIGHT/HYPERCITE RECORDS USING PROCESSED DATA
      if (processedData) {
        updateHyperlightRecords(processedData.hyperlights, lightsStore, bookId, numericNodeId, savedHyperlights, node);
        updateHyperciteRecords(processedData.hypercites, citesStore, bookId, savedHypercites, node);
      }
    };

    getReq.onerror = (e) => {
      console.error("Error fetching nodeChunk for update:", e.target.error);
    };

    // return a promise that resolves/rejects with the transaction
    return new Promise((resolve, reject) => {
      tx.oncomplete = async() => {
        console.log("✅ IndexedDB record update complete");

        // 🆕 Update the book timestamp FIRST (before sync)
        await updateBookTimestamp(bookId);
        
        // 🆕 Get updated library record for sync
        const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
        
        // 🔥 SYNC EVERYTHING THAT WAS ACTUALLY SAVED
        try {
          await syncNodeUpdateWithPostgreSQL(
            bookId, 
            savedNodeChunk, 
            savedHyperlights, 
            savedHypercites,
            libraryRecord // 🆕 Pass library record
          );
        } catch (syncError) {
          console.error("❌ PostgreSQL sync failed:", syncError);
          // Don't reject - IndexedDB update was successful
        }

        resolve();
      };
      tx.onerror = (e) => {
        console.error("Transaction failed during update:", e.target.error);
        reject(e.target.error);
      };
      tx.onabort = (e) => {
        console.warn("Transaction aborted during update:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}
// New batched function to replace individual updateIndexedDBRecord calls
export async function batchUpdateIndexedDBRecords(recordsToProcess) {
  return withPending(async () => {
    const bookId = book || "latest";
    
    console.log(`🔄 Batch updating ${recordsToProcess.length} IndexedDB records`);
    
    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");

    // Collect all data for sync
    const batchSyncData = {
      nodeChunks: [],
      hyperlights: [],
      hypercites: []
    };

    // Process each record in the same transaction
    const processPromises = recordsToProcess.map(async (record) => {
      // Find the nearest ancestor with a numeric ID
      let nodeId = record.id;
      let node = document.getElementById(nodeId);
      while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
        node = node.parentElement;
        if (node?.id) nodeId = node.id;
      }

      if (!/^\d+(\.\d+)?$/.test(nodeId)) {
        console.log(`Skipping IndexedDB update – no valid parent node ID for ${record.id}`);
        return;
      }

      const numericNodeId = parseNodeId(nodeId);
      const compositeKey = [bookId, numericNodeId];
      
      // Get existing record FIRST to preserve hypercite data
      return new Promise((resolve, reject) => {
        const getReq = chunksStore.get(compositeKey);
        
        getReq.onsuccess = () => {
          const existing = getReq.result;
          
          // ✅ PASS EXISTING HYPERCITES TO PRESERVE RELATIONSHIP STATUS
          const existingHypercites = existing?.hypercites || [];
          const processedData = node ? processNodeContentHighlightsAndCites(node, existingHypercites) : null;
          
          let toSave;

          if (existing) {
            toSave = { ...existing };
            if (processedData) {
              toSave.content = processedData.content;
              toSave.hyperlights = processedData.hyperlights;
              toSave.hypercites = processedData.hypercites;
            } else {
              toSave.content = record.html;
            }
            if (record.chunk_id !== undefined) {
              toSave.chunk_id = record.chunk_id;
            }
          } else {
            toSave = {
              book: bookId,
              startLine: numericNodeId,
              chunk_id: record.chunk_id !== undefined ? record.chunk_id : 0,
              content: processedData ? processedData.content : record.html,
              hyperlights: processedData ? processedData.hyperlights : [],
              hypercites: processedData ? processedData.hypercites : []
            };
          }

          // Store the chunk
          chunksStore.put(toSave);
          batchSyncData.nodeChunks.push(toSave);

          // Update hyperlight/hypercite records
          if (processedData) {
            const savedHyperlights = [];
            const savedHypercites = [];
            
            updateHyperlightRecords(processedData.hyperlights, lightsStore, bookId, numericNodeId, savedHyperlights, node);
            updateHyperciteRecords(processedData.hypercites, citesStore, bookId, savedHypercites, node);
            
            batchSyncData.hyperlights.push(...savedHyperlights);
            batchSyncData.hypercites.push(...savedHypercites);
          }

          resolve();
        };

        getReq.onerror = (e) => {
          console.error("Error fetching nodeChunk for batch update:", e.target.error);
          reject(e.target.error);
        };
      });
    });

    // Wait for all individual processing to complete
    await Promise.all(processPromises);

    // Return promise that resolves when transaction completes
    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ Batch IndexedDB update complete");

        // Single timestamp update
        await updateBookTimestamp(bookId);
        
        // Single library record fetch
        const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
        
        // Single batched sync
        try {
          await syncBatchUpdateWithPostgreSQL(
            bookId, 
            batchSyncData,
            libraryRecord
          );
        } catch (syncError) {
          console.error("❌ PostgreSQL batch sync failed:", syncError);
        }

        resolve();
      };
      
      tx.onerror = (e) => {
        console.error("Batch transaction failed:", e.target.error);
        reject(e.target.error);
      };
      
      tx.onabort = (e) => {
        console.warn("Batch transaction aborted:", e);
        reject(new Error("Batch transaction aborted"));
      };
    });
  });
}


export async function syncBatchUpdateWithPostgreSQL(
  bookId,
  batchData,
  libraryRecord      
) {
  /* ------------------------------------------------------------- */
  /* 1. build the payload                                          */
  /* ------------------------------------------------------------- */
  const transformedData = batchData.nodeChunks.map(chunk => ({
    book:        chunk.book,
    startLine:   chunk.startLine,
    chunk_id:    chunk.chunk_id,
    content:     chunk.content,
    hyperlights: chunk.hyperlights ?? [],
    hypercites:  chunk.hypercites  ?? [],
    footnotes:   chunk.footnotes   ?? [],
    plainText:   chunk.plainText   ?? null,
    type:        chunk.type        ?? null
  }));

  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: transformedData
  };

  console.log('🔍 Making request to /api/db/node-chunks/targeted-upsert');
  console.log('🔍 Payload rows:', transformedData.length);
  console.log('🔍 Sample row:', transformedData[0]);

  /* ------------------------------------------------------------- */
  /* 2. send the request with cookies (credentials)                */
  /* ------------------------------------------------------------- */
  const response = await fetch('/api/db/node-chunks/targeted-upsert', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN':
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: 'include',        // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  console.log('🔍 Response status:', response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('🔍 Error response:', errorText);
    throw new Error(`Batch sync failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(
    `✅ Batch-synced ${transformedData.length} nodeChunks to PostgreSQL`,
    result
  );
  return result;
}


// New batched deletion function
export async function batchDeleteIndexedDBRecords(nodeIds) {
  return withPending(async () => {
    const bookId = book || "latest";
    
    console.log(`🗑️ Batch deleting ${nodeIds.length} IndexedDB records`);
    console.log(`🔍 First 10 IDs:`, nodeIds.slice(0, 10));
    
    try {
      const db = await openDatabase();
      console.log(`✅ Database opened successfully`);
      
      const tx = db.transaction(
        ["nodeChunks", "hyperlights", "hypercites"],
        "readwrite"
      );
      console.log(`✅ Transaction created`);
      
      const chunksStore = tx.objectStore("nodeChunks");
      const lightsStore = tx.objectStore("hyperlights");
      const citesStore = tx.objectStore("hypercites");

      // Collect data for sync (what was deleted)
      const deletedData = {
        nodeChunks: [],
        hyperlights: [],
        hypercites: []
      };

      let processedCount = 0;
      
      // Process each node ID for deletion
      const deletePromises = nodeIds.map(async (nodeId, index) => {
        console.log(`🔍 Processing deletion ${index + 1}/${nodeIds.length}: ${nodeId}`);
        
        // Ensure we have a numeric ID
        if (!/^\d+(\.\d+)?$/.test(nodeId)) {
          console.log(`❌ Skipping deletion – invalid node ID: ${nodeId}`);
          return;
        }

        const numericNodeId = parseNodeId(nodeId);
        const compositeKey = [bookId, numericNodeId];
        
        console.log(`🔍 Deleting composite key:`, compositeKey);
        
        return new Promise((resolve, reject) => {
          // Get the record before deleting (for sync purposes)
          const getReq = chunksStore.get(compositeKey);
          
          getReq.onsuccess = () => {
            const existing = getReq.result;
            
            if (existing) {
              console.log(`✅ Found existing record for ${nodeId}, deleting...`);
              
              // Store what we're deleting for sync
              deletedData.nodeChunks.push({
                ...existing,
                _deleted: true // Mark as deleted for sync
              });
              
              // Delete the main record
              const deleteReq = chunksStore.delete(compositeKey);
              
              deleteReq.onsuccess = () => {
                processedCount++;
                console.log(`✅ Deleted ${nodeId} (${processedCount}/${nodeIds.length})`);
                resolve();
              };
              
              deleteReq.onerror = (e) => {
                console.error(`❌ Failed to delete ${nodeId}:`, e.target.error);
                reject(e.target.error);
              };
              
              // Delete associated hyperlights
              try {
                const lightIndex = lightsStore.index("book_startLine");
                const lightRange = IDBKeyRange.only([bookId, numericNodeId]);
                const lightReq = lightIndex.openCursor(lightRange);
                
                lightReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hyperlights.push({
                      ...cursor.value,
                      _deleted: true
                    });
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (lightError) {
                console.warn(`⚠️ Error deleting hyperlights for ${nodeId}:`, lightError);
              }
              
              // Delete associated hypercites
              try {
                const citeIndex = citesStore.index("book_startLine");
                const citeRange = IDBKeyRange.only([bookId, numericNodeId]);
                const citeReq = citeIndex.openCursor(citeRange);
                
                citeReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hypercites.push({
                      ...cursor.value,
                      _deleted: true
                    });
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (citeError) {
                console.warn(`⚠️ Error deleting hypercites for ${nodeId}:`, citeError);
              }
            } else {
              console.log(`⚠️ No existing record found for ${nodeId}`);
              resolve();
            }
          };

          getReq.onerror = (e) => {
            console.error(`❌ Error fetching record for deletion ${nodeId}:`, e.target.error);
            reject(e.target.error);
          };
        });
      });

      // Wait for all deletions to complete
      console.log(`⏳ Waiting for ${deletePromises.length} deletion promises...`);
      await Promise.all(deletePromises);
      console.log(`✅ All deletion promises completed`);

      // Return promise that resolves when transaction completes
      return new Promise((resolve, reject) => {
        tx.oncomplete = async () => {
          console.log(`✅ Batch IndexedDB deletion transaction complete - deleted ${processedCount}/${nodeIds.length} records`);

          try {
            // Update timestamp
            await updateBookTimestamp(bookId);
            console.log(`✅ Updated book timestamp`);
            
            // Get library record
            const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
            console.log(`✅ Retrieved library record`);
            
            // Sync deletions with PostgreSQL
            if (typeof syncBatchDeletionWithPostgreSQL === 'function') {
              await syncBatchDeletionWithPostgreSQL(
                bookId, 
                deletedData,
                libraryRecord
              );
              console.log(`✅ Synced deletions with PostgreSQL`);
            } else {
              console.log(`⚠️ PostgreSQL sync function not available`);
            }
          } catch (syncError) {
            console.error("❌ Error in post-deletion operations:", syncError);
          }

          resolve();
        };
        
        tx.onerror = (e) => {
          console.error("❌ Batch deletion transaction failed:", e.target.error);
          reject(e.target.error);
        };
        
        tx.onabort = (e) => {
          console.warn("⚠️ Batch deletion transaction aborted:", e);
          reject(new Error("Batch deletion transaction aborted"));
        };
      });
      
    } catch (error) {
      console.error("❌ Error in batchDeleteIndexedDBRecords:", error);
      throw error;
    }
  });
}

export async function syncBatchDeletionWithPostgreSQL(
  bookId,
  deletedData,
  libraryRecord = null
) {
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: deletedData.nodeChunks.map(c => ({
      book: bookId,
      startLine: c.startLine,
      _action: "delete"
    }))
  };

  console.log(
    `🔄 Syncing batch deletion of ${payload.data.length} nodeChunks (book ${bookId})…`
  );

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Accept":          "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Batch-deletion sync error:", txt);
    throw new Error(txt);
  }
  console.log("✅ Batch deletion synced");

  /* optionally upsert the library record */
  if (libraryRecord) {
    await upsertLibraryRecord(libraryRecord);
  }
}

async function upsertLibraryRecord(libraryRecord) {
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: libraryRecord.book,
    data: libraryRecord
  };

  const res = await fetch("/api/db/library/upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Library sync error:", txt);
    throw new Error(txt);
  }
  console.log("✅ Library record synced");
}

// 🔥 UPDATED: Function to update hyperlight records using processed data
function updateHyperlightRecords(hyperlights, store, bookId, numericNodeId, syncArray, node) {
  hyperlights.forEach((hyperlight) => {
    const key = [bookId, hyperlight.highlightID];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      // Find the actual mark element to get text content
      const markElement = node.querySelector(`#${hyperlight.highlightID}`);
      const highlightedText = markElement ? markElement.textContent : "";
      const highlightedHTML = markElement ? markElement.outerHTML : "";
      
      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hyperlight.charStart;
        existingRecord.endChar = hyperlight.charEnd;
        existingRecord.startLine = numericNodeId;
        existingRecord.highlightedText = highlightedText;
        existingRecord.highlightedHTML = highlightedHTML;
        
        store.put(existingRecord);
        syncArray.push(existingRecord);
        
        console.log(`Updated hyperlight ${hyperlight.highlightID} positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperlight_id: hyperlight.highlightID,
          startChar: hyperlight.charStart,
          endChar: hyperlight.charEnd,
          startLine: numericNodeId,
          highlightedText: highlightedText,
          highlightedHTML: highlightedHTML,
          annotation: ""
        };
        
        store.put(newRecord);
        syncArray.push(newRecord);
        
        console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      }
    };
  });
}

// 🔥 UPDATED: Function to update hypercite records using processed data
function updateHyperciteRecords(hypercites, store, bookId, syncArray, node) {
  hypercites.forEach((hypercite) => {
    const key = [bookId, hypercite.hyperciteId];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      // Find the actual u element to get text content
      const uElement = node.querySelector(`#${hypercite.hyperciteId}`);
      const hypercitedText = uElement ? uElement.textContent : "";
      const hypercitedHTML = uElement ? uElement.outerHTML : "";
      
      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hypercite.charStart;
        existingRecord.endChar = hypercite.charEnd;
        existingRecord.hypercitedText = hypercitedText;
        existingRecord.hypercitedHTML = hypercitedHTML;
        
        store.put(existingRecord);
        syncArray.push(existingRecord);
        
        console.log(`Updated hypercite ${hypercite.hyperciteId} positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperciteId: hypercite.hyperciteId,
          startChar: hypercite.charStart,
          endChar: hypercite.charEnd,
          hypercitedText: hypercitedText,
          hypercitedHTML: hypercitedHTML,
          citedIN: [],
          relationshipStatus: "single"
        };
        
        store.put(newRecord);
        syncArray.push(newRecord);
        
        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      }
    };
  });
}




async function syncNodeUpdateWithPostgreSQL (
  bookId,
  nodeChunk,
  hyperlights,
  hypercites,
  libraryRecord
) {
    try {
      console.log('🔄 Starting PostgreSQL sync for node update…');

      /* ------------------------------------------------------------------ */
      /* 1. node-chunks /targeted-upsert                                    */
      /* ------------------------------------------------------------------ */
      if (nodeChunk) {
        console.log('📝 Syncing node chunk:', {
          book:          nodeChunk.book,
          startLine:     nodeChunk.startLine,
          hasHyperlights: !!nodeChunk.hyperlights,
          hasHypercites:  !!nodeChunk.hypercites,
          hasContent:     !!nodeChunk.content
        });

        // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
        const body = {
          book: bookId,
          data: [nodeChunk]
        };

        const res = await fetch('/api/db/node-chunks/targeted-upsert', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN':
              document.querySelector('meta[name="csrf-token"]')?.content
          },
          credentials: 'include', // ← ensures cookies are sent
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(
            `NodeChunk sync failed: ${res.status} ${res.statusText}\n${await res.text()}`
          );
        }
        console.log('✅ NodeChunk synced with PostgreSQL');
      }

      /* ------------------------------------------------------------------ */
      /* 2. hyperlights                                                     */
      /* ------------------------------------------------------------------ */
      if (hyperlights.length) {
        const body = { book: bookId, data: hyperlights };

        const res = await fetch('/api/db/hyperlights/upsert', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN':
              document.querySelector('meta[name="csrf-token"]')?.content
          },
          credentials: 'include', // ← ensures cookies are sent
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(
            `Hyperlight sync failed: ${res.status} ${res.statusText}\n${await res.text()}`
          );
        }
        console.log(`✅ ${hyperlights.length} hyperlights synced`);
      }

      /* ------------------------------------------------------------------ */
      /* 3. hypercites                                                      */
      /* ------------------------------------------------------------------ */
      if (hypercites.length) {
        const body = { book: bookId, data: hypercites };

        const res = await fetch('/api/db/hypercites/upsert', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN':
              document.querySelector('meta[name="csrf-token"]')?.content
          },
          credentials: 'include', // ← ensures cookies are sent
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(
            `Hypercite sync failed: ${res.status} ${res.statusText}\n${await res.text()}`
          );
        }
        console.log(`✅ ${hypercites.length} hypercites synced`);
      }

      /* ------------------------------------------------------------------ */
      /* 4. library record                                                  */
      /* ------------------------------------------------------------------ */
      if (libraryRecord) {
        const body = { book: bookId, data: libraryRecord };

        const res = await fetch('/api/db/library/upsert', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN':
              document.querySelector('meta[name="csrf-token"]')?.content
          },
          credentials: 'include', // ← ensures cookies are sent
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          throw new Error(
            `Library sync failed: ${res.status} ${res.statusText}\n${await res.text()}`
          );
        }
        console.log('✅ Library record synced');
      }

      console.log('🎉 Node update successfully synced with PostgreSQL');
    } catch (err) {
      console.error('❌ Error syncing node update with PostgreSQL:', err);
      throw err;
    }
  }

// Helper function to update a specific hypercite in IndexedDB
export async function updateHyperciteInIndexedDB(book, hyperciteId, updatedFields) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";
    
    console.log(`Updating in hypercites store: ${dbName}, key: [${book}, ${hyperciteId}]`);
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(false);
    };
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);
        
        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];
        
        // Get the record using the composite key
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;
          
          if (!existingRecord) {
            console.error(`Hypercite record not found for key: [${book}, ${hyperciteId}]`);
            resolve(false);
            return;
          }
          
          console.log("Found existing hypercite record:", existingRecord);
          
          // Update the fields in the existing record
          Object.assign(existingRecord, updatedFields);
          
          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);
          
          updateRequest.onsuccess = async() => {
            console.log(`Successfully updated hypercite for key: [${book}, ${hyperciteId}]`);
            await updateBookTimestamp(book);
            resolve(true);
          };
          
          updateRequest.onerror = (event) => {
            console.error(`Error updating hypercite record:`, event.target.error);
            resolve(false);
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite record:`, event.target.error);
          resolve(false);
        };
        
        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(false);
      }
    };
  });
}

function toPublicChunk(chunk) {
  return {
    book:        chunk.book,
    startLine:   chunk.startLine,
    hyperlights: chunk.hyperlights ?? [],
    hypercites:  chunk.hypercites  ?? []
  };
}

export function updateCitationForExistingHypercite(
  booka,
  hyperciteIDa,
  citationIDb,
  insertContent = true
) {
  return withPending(async () => {
    console.log(
      `Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`
    );

    const isInternalPaste = booka === book;

    // Load all nodeChunks for this book
    const nodeChunks = await getNodeChunksFromIndexedDB(booka);
    if (!nodeChunks?.length) {
      console.warn(`No nodeChunks found for book ${booka}`);
      return false;
    }

    let foundAndUpdated = false;
    let updatedRelationshipStatus = "single";
    const updatedNodeChunks = []; // Track updated nodeChunks for PostgreSQL sync
    const affectedBooks = new Set([booka]); // 🆕 Track all affected books

    // 🆕 If this is a cross-book citation, track the target book too
    if (citationIDb && citationIDb !== hyperciteIDa) {
      // Extract book from citationIDb if it's a cross-book reference
      // This assumes citationIDb format includes book info - adjust as needed
      affectedBooks.add(book || "latest"); // Add current book
    }

    // 1) Update the nodeChunks store
    for (const record of nodeChunks) {
      const hcList = record.hypercites;
      if (!Array.isArray(hcList)) continue;

      const idx = hcList.findIndex(hc => hc.hyperciteId === hyperciteIDa);
      if (idx === -1) continue;

      const startLine = record.startLine;
      
      // Use the new function to add the citation
      const result = await addCitationToHypercite(
        booka,
        startLine,
        hyperciteIDa,
        citationIDb
      );

      console.log('🔍 addCitationToHypercite result:', result);

      if (result.success) {
        // IMMEDIATELY verify the nodeChunk update worked
        const verifyChunk = await getNodeChunkFromIndexedDB(booka, startLine);
        const verifyHypercite = verifyChunk?.hypercites?.find(hc => hc.hyperciteId === hyperciteIDa);
        
        console.log('🔍 VERIFICATION - Updated nodeChunk hypercite:', verifyHypercite);
        console.log('🔍 VERIFICATION - citedIN array:', verifyHypercite?.citedIN);
        
        foundAndUpdated = true;
        updatedRelationshipStatus = result.relationshipStatus;
        
        // Get the updated nodeChunk for PostgreSQL sync
        const updatedNodeChunk = await getNodeChunkFromIndexedDB(booka, startLine);
        if (updatedNodeChunk) {
          updatedNodeChunks.push(updatedNodeChunk);
        }
        
        broadcastToOpenTabs(booka, startLine);

        if (isInternalPaste) {
          const elem = document.getElementById(hyperciteIDa);
          if (elem) {
            elem.className = updatedRelationshipStatus;
          }
        }
      } else {
        console.error(
          `Failed to update nodeChunk ${startLine} in book ${booka}`
        );
      }
    }

    if (!foundAndUpdated) {
      console.log(
        `No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`
      );
      return false;
    }

    // 2) Update the hypercites object store itself
    const existing = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
    if (!existing) {
      console.error(`Hypercite ${hyperciteIDa} not found in book ${booka}`);
      return false;
    }

    existing.citedIN ||= [];
    if (!existing.citedIN.includes(citationIDb)) {
      existing.citedIN.push(citationIDb);
    }
    existing.relationshipStatus = updatedRelationshipStatus;

    const hyperciteSuccess = await updateHyperciteInIndexedDB(
      booka,
      hyperciteIDa,
      {
        citedIN: existing.citedIN,
        relationshipStatus: updatedRelationshipStatus,
        // 🔧 RECONSTRUCT: Build new hypercitedHTML with correct class
        hypercitedHTML: `<u id="${hyperciteIDa}" class="${updatedRelationshipStatus}">${existing.hypercitedText}</u>`
      }
    );

    if (!hyperciteSuccess) {
      console.error(`Failed to update hypercite ${hyperciteIDa}`);
      return false;
    }

    // 🔧 MOVED VERIFICATION HERE - After main hypercites store update:
    const verifyMainHypercite = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
    console.log('🔍 VERIFICATION - Main hypercites store AFTER update:', verifyMainHypercite);

    // 🆕 3) Update timestamps for all affected books
    const libraryRecords = [];
    for (const bookId of affectedBooks) {
      await updateBookTimestamp(bookId);
      const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
      if (libraryRecord) {
        libraryRecords.push(libraryRecord);
      }
    }

    // 🆕 4) Sync to PostgreSQL
    try {
      console.log(`🔄 Syncing ${updatedNodeChunks.length} nodeChunks to PostgreSQL...`);
      
      // Sync updated nodeChunks
      if (updatedNodeChunks.length > 0) {
        const publicChunks = updatedNodeChunks.map(toPublicChunk);
        const nodeChunkSyncResult = await syncNodeChunksToPostgreSQL(publicChunks);
        if (!nodeChunkSyncResult.success) {
          console.error('❌ Failed to sync nodeChunks to PostgreSQL:', nodeChunkSyncResult.message);
        } else {
          console.log('✅ Successfully synced nodeChunks to PostgreSQL');
        }
      }

      // Sync updated hypercite
      console.log(`🔄 Syncing hypercite ${hyperciteIDa} to PostgreSQL...`);
      const hyperciteSyncResult = await syncHyperciteToPostgreSQL(existing);
      if (!hyperciteSyncResult.success) {
        console.error('❌ Failed to sync hypercite to PostgreSQL:', hyperciteSyncResult.message);
      } else {
        console.log('✅ Successfully synced hypercite to PostgreSQL');
      }

      if (libraryRecords.length) {
        console.log(
          `🔄 Updating timestamps for ${libraryRecords.length} library records...`
        );

        for (const lr of libraryRecords) {
          // ✅ Only send book and timestamp, like hyperlights do
          const payload = {
            book: lr.book,
            timestamp: lr.timestamp || Date.now()
          };

          const res = await fetch("/api/db/library/update-timestamp", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-TOKEN":
                document.querySelector('meta[name="csrf-token"]')?.content
            },
            credentials: "include",
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            console.error(
              `❌ Failed to update timestamp for book ${lr.book}:`,
              await res.text()
            );
          } else {
            console.log(`✅ Timestamp updated for book ${lr.book}`);
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Error during PostgreSQL sync:', error);
      // Don't fail the entire operation if sync fails
    }

    console.log(
      `Successfully updated hypercite ${hyperciteIDa} in book ${booka}`
    );
      
    return true;
  });
}

// 🆕 Helper function to get a single nodeChunk from IndexedDB
export async function getNodeChunkFromIndexedDB(book, startLine) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    const numericStartLine = parseNodeId(startLine);
    const request = indexedDB.open(dbName);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction([storeName], "readonly");
      const objectStore = transaction.objectStore(storeName);
      
      const key = [book, numericStartLine];
      const getRequest = objectStore.get(key);
      
      getRequest.onsuccess = (event) => {
        resolve(event.target.result);
      };
      
      getRequest.onerror = (event) => {
        console.error('Error getting nodeChunk:', event.target.error);
        resolve(null);
      };
      
      transaction.oncomplete = () => {
        db.close();
      };
    };
    
    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      resolve(null);
    };
  });
}

export async function getNodeChunksAfter(book, afterNodeId) {
  const numericAfter = parseNodeId(afterNodeId);
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";

  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve([]);

    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readonly");
      const store = tx.objectStore(storeName);

      // lower bound is ["book", afterLine]
      const lower = [book, numericAfter];
      // upper bound is ["book", +∞] -- Number.MAX_SAFE_INTEGER is usually enough
      const upper = [book, Number.MAX_SAFE_INTEGER];
      const range = IDBKeyRange.bound(lower, upper, /*lowerOpen=*/false, /*upperOpen=*/false);

      const cursorReq = store.openCursor(range);
      const results = [];

      cursorReq.onsuccess = (evt) => {
        const cur = evt.target.result;
        if (!cur) return;          // done
        results.push(cur.value);
        cur.continue();
      };

      tx.oncomplete = () => {
        db.close();
        resolve(results);
      };
      tx.onerror = () => {
        db.close();
        resolve(results);
      };
    };
  });
}

// 🆕 2) Delete all nodeChunks for `book` with startLine >= afterNodeId
export async function deleteNodeChunksAfter(book, afterNodeId) {
  const numericAfter = parseNodeId(afterNodeId);
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";
  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve();
    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);

      // lower = [book, after], upper = [book, +∞]
      const lower = [book, numericAfter];
      const upper = [book, Number.MAX_SAFE_INTEGER];
      const range = IDBKeyRange.bound(
        lower,
        upper,
        /*lowerOpen=*/ false,
        /*upperOpen=*/ false
      );

      const cursorReq = store.openCursor(range);
      cursorReq.onsuccess = (evt) => {
        const cur = evt.target.result;
        if (!cur) return;      // done
        store.delete(cur.primaryKey);
        cur.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
}

// 🆕 3) Bulk‐write an array of nodeChunk objects back into IndexedDB
//    Each object must have at least { book, startLine, chunk_id, content }
export async function writeNodeChunks(chunks) {
  if (!chunks.length) return;
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";
  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve();
    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);

      for (const chunk of chunks) {
        // chunk must have the inline key fields (book, startLine) already on it
        store.put(chunk);
      }

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
}
// 🆕 Function to sync nodeChunks to PostgreSQL
export async function syncNodeChunksToPostgreSQL(nodeChunks = []) {
  if (!nodeChunks.length) {
    console.log("ℹ️  syncNodeChunksToPostgreSQL: nothing to sync");
    return { success: true };
  }

  const bookId = nodeChunks[0].book;
  
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: nodeChunks
  };

  // 🆕 DEBUG LOGGING
  console.log("🔍 DEBUG - Raw nodeChunk from IndexedDB:", JSON.stringify(nodeChunks[0], null, 2));
  console.log("🔍 DEBUG - Transformed payload:", JSON.stringify(payload, null, 2));
  console.log("🔍 DEBUG - First hypercite in payload:", JSON.stringify(payload.data[0]?.hypercites?.[0], null, 2));

  console.log(
    `🔄 Syncing ${nodeChunks.length} nodeChunks for book ${bookId}…`
  );

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Accept":          "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ NodeChunk sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ nodeChunks synced:", out);
  return out;
}

export async function syncHyperciteToPostgreSQL(hypercite) {
  // 🔧 Ensure hypercitedHTML matches the current relationshipStatus
  const hyperciteData = {
    ...hypercite,
    hypercitedHTML: `<u id="${hypercite.hyperciteId}" class="${hypercite.relationshipStatus}">${hypercite.hypercitedText}</u>`
  };

  const payload = {
    book: hypercite.book,
    data: [hyperciteData]
  };

  // 🔍 DEBUG: Log what we're sending
  console.log(`🔄 Syncing hypercite ${hypercite.hyperciteId}…`);
  console.log('🔍 Payload being sent:', JSON.stringify(payload, null, 2));
  console.log('🔍 Hypercite relationshipStatus:', hyperciteData.relationshipStatus);
  console.log('🔍 Hypercite hypercitedHTML:', hyperciteData.hypercitedHTML);

  const res = await fetch("/api/db/hypercites/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Hypercite synced:", out);
  return out;
}

async function addCitationToHypercite(book, startLine, hyperciteId, newCitation) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    const numericStartLine = parseNodeId(startLine);
    
    console.log(`Adding citation to hypercite in nodeChunk: book=${book}, startLine=${numericStartLine}, hyperciteId=${hyperciteId}, citation=${newCitation}`);
    
    const request = indexedDB.open(dbName);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);
        
        const key = [book, numericStartLine];
        console.log("Using key for update:", key);
        
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const record = event.target.result;
          
          if (!record) {
            console.error(`Record not found for key: [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }
          
          console.log("Existing nodeChunk before update:", JSON.stringify(record)); // Log the full record

          // Ensure hypercites array exists and is an array
          if (!Array.isArray(record.hypercites)) {
            record.hypercites = [];
          }
          
          // Find the specific hypercite to update
          const hyperciteIndex = record.hypercites.findIndex(h => h.hyperciteId === hyperciteId);
          
          if (hyperciteIndex === -1) {
            console.error(`Hypercite ${hyperciteId} not found in nodeChunk [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }
          
          // Get a reference to the existing hypercite object within the array
          const hyperciteToUpdate = record.hypercites[hyperciteIndex];
          
          // Ensure citedIN array exists for the hypercite being updated
          if (!Array.isArray(hyperciteToUpdate.citedIN)) {
            hyperciteToUpdate.citedIN = [];
          }
          
          // Add the citation if it doesn't already exist
          if (!hyperciteToUpdate.citedIN.includes(newCitation)) {
            hyperciteToUpdate.citedIN.push(newCitation);
            console.log(`Added citation ${newCitation} to hypercite ${hyperciteId}`);
          } else {
             console.log(`Citation ${newCitation} already exists for hypercite ${hyperciteId}`);
          }
          
          // Update relationshipStatus based on citedIN length
          hyperciteToUpdate.relationshipStatus = 
            hyperciteToUpdate.citedIN.length === 1 ? "couple" : 
            hyperciteToUpdate.citedIN.length >= 2 ? "poly" : "single";

          console.log("Updated hypercite object:", JSON.stringify(hyperciteToUpdate)); // Log the updated hypercite object
          console.log("NodeChunk after modifying hypercite:", JSON.stringify(record)); // Log the full record after modification

          // Put the *entire* updated record back
          const updateRequest = objectStore.put(record);
          
          updateRequest.onsuccess = async() => {
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}]`);
            
            // IMMEDIATE verification within the same function
            const immediateVerify = objectStore.get(key);
            immediateVerify.onsuccess = (e) => {
              const verifyRecord = e.target.result;
              const verifyHypercite = verifyRecord?.hypercites?.find(h => h.hyperciteId === hyperciteId);
              console.log('🔍 IMMEDIATE VERIFY - hypercite after put:', verifyHypercite);
              console.log('🔍 IMMEDIATE VERIFY - citedIN:', verifyHypercite?.citedIN);
            };
            
            await updateBookTimestamp(book);
            resolve({
              success: true,
              relationshipStatus: hyperciteToUpdate.relationshipStatus
            });
          };
          
          updateRequest.onerror = (event) => {
            console.error(`❌ Error updating nodeChunk record:`, event.target.error);
            resolve({ success: false });
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`❌ Error getting nodeChunk record:`, event.target.error);
          resolve({ success: false });
        };
      } catch (error) {
        console.error("❌ Transaction error:", error);
        resolve({ success: false });
      }
    };
    
    request.onerror = (event) => {
      console.error(`❌ IndexedDB error: ${event.target.errorCode}`);
      resolve({ success: false });
    };
  });
}




export async function getHyperciteFromIndexedDB(book, hyperciteId) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(null);
    };
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readonly");
        const objectStore = transaction.objectStore(storeName);
        
        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];
        
        // Get the record using the composite key
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const record = event.target.result;
          resolve(record);
        };
        
        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite:`, event.target.error);
          resolve(null);
        };
        
        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(null);
      }
    };
  });
} 



export async function deleteIndexedDBRecord(id) {
  return withPending(async () => {
    // Only process numeric IDs
    if (!id || !id.match(/^\d+(\.\d+)?$/)) {
      console.log(`Skipping deletion for non-numeric ID: ${id}`);
      return false;
    }

    const bookId = book || "latest";
    const numericId = parseNodeId(id);
    console.log(
      `Deleting node with ID ${id} (numeric: ${numericId}) from IndexedDB`
    );

    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    const key = [bookId, numericId];

    // Get the record before deleting it (for PostgreSQL sync)
    let recordToDelete = null;
    const getRequest = store.get(key);
    
    return new Promise((resolve, reject) => {
      const TRANSACTION_TIMEOUT = 10000;
      const timeoutId = setTimeout(() => tx.abort(), TRANSACTION_TIMEOUT);

      getRequest.onsuccess = () => {
        recordToDelete = getRequest.result;
        
        if (recordToDelete) {
          console.log("Found record to delete:", recordToDelete);
        } else {
          console.log(`No record found for key: ${key}`);
        }

        // Delete the record from IndexedDB
        store.delete(key);
      };

      getRequest.onerror = (event) => {
        clearTimeout(timeoutId);
        console.error("Error getting record for deletion:", event.target.error);
        reject(event.target.error);
      };

      tx.oncomplete = async() => {
        clearTimeout(timeoutId);
        console.log(`Successfully deleted record with key: ${key}`);
        
        try {
          // Update the book timestamp
          await updateBookTimestamp(bookId);
          
          // Get updated library record for sync
          const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
          
          // Sync deletion to PostgreSQL
          await syncDeletionToPostgreSQL(bookId, numericId, libraryRecord);
          
          resolve(true);
        } catch (syncError) {
          console.error("❌ PostgreSQL sync failed:", syncError);
          // Don't reject - IndexedDB deletion was successful
          resolve(true);
        }
      };

      tx.onerror = (event) => {
        clearTimeout(timeoutId);
        console.error("Transaction error:", event.target.error);
        reject(event.target.error);
      };

      tx.onabort = (event) => {
        clearTimeout(timeoutId);
        console.warn("Transaction aborted:", event);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}

// 🆕 Function to sync deletion to PostgreSQL
export async function syncDeletionToPostgreSQL(
  bookId,
  startLine,
  libraryRecord = null
) {
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: [
      { book: bookId, startLine, _action: "delete" }
    ]
  };

  console.log(`🔄 Syncing deletion (book ${bookId}, startLine ${startLine})…`);

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Deletion sync error:", txt);
    throw new Error(txt);
  }
  console.log("✅ NodeChunk deletion synced");

  /* optionally upsert the library record */
  if (libraryRecord) {
    await upsertLibraryRecord(libraryRecord); // ← removed anon parameter
  }
}

export async function updateIndexedDBRecordForNormalization(
  oldId, newId, html
) {
  return withPending(async () => {
    console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);

    // Only numeric IDs allowed
    const numericOldId = parseNodeId(oldId);
    const numericNewId = parseNodeId(newId);
    const bookId = book || "latest";

    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    // Optional timeout/abort
    const TRANSACTION_TIMEOUT = 15_000;
    const timeoutId = setTimeout(() => tx.abort(), TRANSACTION_TIMEOUT);

    // Kick off the get/put/delete sequence
    const oldKey = [bookId, numericOldId];
    const getOld = store.get(oldKey);

    getOld.onsuccess = () => {
      const oldRecord = getOld.result;
      if (oldRecord) console.log("Found old record:", oldRecord);

      // Build new record
      const newRecord = oldRecord
        ? { ...oldRecord,
            book: bookId,
            startLine: numericNewId,
            content: html || oldRecord.content }
        : { book: bookId,
            startLine: numericNewId,
            chunk_id: 0,
            content: html,
            hyperlights: [],
            hypercites: [] };

      const newKey = [bookId, numericNewId];
      const putReq = store.put(newRecord);

      putReq.onerror = (e) => {
        console.error("Error adding new record:", e.target.error);
        // Let the tx.onerror handler reject
      };

      // If we had an old record, delete it
      if (oldRecord) {
        const delReq = store.delete(oldKey);
        delReq.onerror = (e) => {
          console.error("Error deleting old record:", e.target.error);
        };
      }
    };

    getOld.onerror = (e) => {
      console.error("Error getting old record:", e.target.error);
      // Let the tx.onerror handler reject
    };

    // Now wait for the transaction to finish
    return new Promise((resolve, reject) => {
      tx.oncomplete = async() => {
        clearTimeout(timeoutId);
        console.log(`Successfully normalized record: ${oldId} -> ${newId}`);
        await updateBookTimestamp(bookId);
        await syncIndexedDBtoPostgreSQL(bookId);
        resolve(true);
      };
      tx.onerror = (e) => {
        clearTimeout(timeoutId);
        console.error("Transaction error during normalization:", e.target.error);
        reject(e.target.error);
      };
      tx.onabort = (e) => {
        clearTimeout(timeoutId);
        console.warn("Transaction aborted:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}


// Generic retry function for IndexedDB operations
export async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`Operation failed (attempt ${attempt}/${maxRetries}):`, error);
      lastError = error;
      
      if (attempt < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
        // Increase delay for next attempt (exponential backoff)
        delay *= 1.5;
      }
    }
  }
  
  // If we get here, all retries failed
  console.error(`Operation failed after ${maxRetries} attempts:`, lastError);
  throw lastError;
}

// Example usage with the delete function
export async function deleteIndexedDBRecordWithRetry(id) {
  return retryOperation(() => deleteIndexedDBRecord(id));
}

// Example usage with the normalization function
export async function normalizeIndexedDBRecordWithRetry(oldId, newId, html) {
  return retryOperation(() => updateIndexedDBRecordForNormalization(oldId, newId, html));
}



/**
 * Updates the timestamp for a book in the library object store to the current time.
 * Call this after successful IndexedDB operations to track when the book was last modified.
 * 
 * @param {string} bookId - The book identifier (defaults to current book)
 * @returns {Promise<boolean>} - Success status
 */
export async function updateBookTimestamp(bookId = book || "latest") {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    
    // Get the existing library record for this book
    const getRequest = store.get(bookId);
    
    return new Promise((resolve, reject) => {
      getRequest.onsuccess = () => {
        const existingRecord = getRequest.result;
        
        if (existingRecord) {
          // Update the timestamp in the existing record
          existingRecord.timestamp = Date.now();
          
          console.log(`Updating timestamp for book "${bookId}" to ${existingRecord.timestamp}`);
          
          // Put the updated record back
          const putRequest = store.put(existingRecord);
          
          putRequest.onsuccess = () => {
            console.log(`✅ Successfully updated timestamp for book: ${bookId}`);
            resolve(true);
          };
          
          putRequest.onerror = (e) => {
            console.error(`❌ Error updating timestamp for book ${bookId}:`, e.target.error);
            resolve(false);
          };
        } else {
          // If no library record exists, create one with just the timestamp
          const newRecord = {
            book: bookId,
            timestamp: Date.now(),
            // Add other default fields if needed
            title: bookId,
            description: "",
            tags: []
          };
          
          console.log(`Creating new library record for book "${bookId}" with timestamp ${newRecord.timestamp}`);
          
          const putRequest = store.put(newRecord);
          
          putRequest.onsuccess = () => {
            console.log(`✅ Successfully created library record with timestamp for book: ${bookId}`);
            resolve(true);
          };
          
          putRequest.onerror = (e) => {
            console.error(`❌ Error creating library record for book ${bookId}:`, e.target.error);
            resolve(false);
          };
        }
      };
      
      getRequest.onerror = (e) => {
        console.error(`❌ Error getting library record for book ${bookId}:`, e.target.error);
        resolve(false);
      };
      
      tx.onerror = (e) => {
        console.error(`❌ Transaction error updating timestamp:`, e.target.error);
        resolve(false);
      };
    });
  } catch (error) {
    console.error("❌ Failed to update book timestamp:", error);
    return false;
  }
}


// Helper function to get library object from IndexedDB
export async function getLibraryObjectFromIndexedDB(book) {
  try {
    // ✅ Validate the book parameter first
    if (!book) {
      console.warn("⚠️ No book ID provided to getLibraryObjectFromIndexedDB");
      return null;
    }

    if (typeof book !== 'string' && typeof book !== 'number') {
      console.warn("⚠️ Invalid book ID type:", typeof book, book);
      return null;
    }

    console.log("🔍 Looking up library object for book:", book);

    const db = await openDatabase();
    const tx = db.transaction(["library"], "readonly");
    const libraryStore = tx.objectStore("library");
    
    const getRequest = libraryStore.get(book);
    
    const libraryObject = await new Promise((resolve, reject) => {
      getRequest.onsuccess = (e) => {
        const result = e.target.result;
        console.log("📚 IndexedDB lookup result for book:", book, result ? "found" : "not found");
        resolve(result);
      };
      getRequest.onerror = (e) => {
        console.error("❌ IndexedDB get request failed:", e.target.error);
        reject(e.target.error);
      };
    });

    if (libraryObject) {
      console.log("📚 Retrieved library object for book:", book, libraryObject);
    } else {
      console.log("📚 No library object found for book:", book);
    }
    
    return libraryObject;
    
  } catch (error) {
    console.error("❌ Error getting library object from IndexedDB:", error);
    console.error("❌ Book parameter was:", book, typeof book);
    return null;
  }
}
