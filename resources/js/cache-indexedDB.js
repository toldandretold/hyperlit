import { book } from "./app.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';
import { withPending } from "./operationState.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";

export const DB_VERSION = 15;


 
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
          indices: ["hyperlight_id", "book"], // ✅ ADD "book" here
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: ["hyperciteId", "book"], // ✅ ADD "book" here
        },
        {
          name: "library",
          keyPath: "book",
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




/**
 * Adds a new nodeChunk record directly to IndexedDB without DOM processing.
 * Used for creating initial book structure or adding nodes programmatically.
 * 
 * @param {string} bookId - The book identifier
 * @param {number} startLine - The line number (will be converted to numeric)
 * @param {string} content - The HTML content for the node
 * @param {number} chunkId - The chunk ID (defaults to 0)
 * @returns {Promise<boolean>} - Success status
 */
export async function addNewBookToIndexedDB(bookId, startLine, content, chunkId = 0) {
  return withPending(async () => {
    console.log(`Adding nodeChunk: book=${bookId}, startLine=${startLine}, chunkId=${chunkId}`);

    try {
      const db = await openDatabase();
      const tx = db.transaction("nodeChunks", "readwrite");
      const store = tx.objectStore("nodeChunks");

      const numericStartLine = parseNodeId(startLine);
      
      const nodeChunkRecord = {
        book: bookId,
        startLine: numericStartLine,
        chunk_id: chunkId,
        content: content,
        hyperlights: [],
        hypercites: []
      };

      console.log("Creating nodeChunk record:", nodeChunkRecord);
      store.put(nodeChunkRecord);

      return new Promise((resolve, reject) => {
        tx.oncomplete = async() => {
          console.log(`✅ Successfully added nodeChunk [${bookId}, ${numericStartLine}]`);

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


function processNodeContentHighlightsAndCites(node) {
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
      hypercites.push({
        hyperciteId: uTag.id,
        charStart: startPos,
        charEnd: startPos + uLength,
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
      
      // Process the node content
      const processedData = node ? processNodeContentHighlightsAndCites(node) : null;

      // Get existing record
      return new Promise((resolve, reject) => {
        const getReq = chunksStore.get(compositeKey);
        
        getReq.onsuccess = () => {
          const existing = getReq.result;
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

export async function syncBatchUpdateWithPostgreSQL(bookId, batchData, libraryRecord) {
  const transformedData = batchData.nodeChunks.map(chunk => ({
    book: chunk.book,
    startLine: chunk.startLine,
    chunk_id: chunk.chunk_id,
    content: chunk.content,
    hyperlights: chunk.hyperlights || [],
    hypercites: chunk.hypercites || [],
    footnotes: chunk.footnotes || [],
    plainText: chunk.plainText || null,
    type: chunk.type || null
  }));

  const url = `/api/db/node-chunks/targeted-upsert`;
  console.log('🔍 Making request to:', url);
  console.log('🔍 Transformed data count:', transformedData.length);
  console.log('🔍 Sample data:', transformedData[0]);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
    },
    body: JSON.stringify({
      data: transformedData
    })
  });

  console.log('🔍 Response status:', response.status);
  console.log('🔍 Response URL:', response.url);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('🔍 Error response:', errorText);
    throw new Error(`Batch sync failed: ${response.status}`);
  }
  
  const result = await response.json();
  console.log(`✅ Batch synced ${transformedData.length} chunks to PostgreSQL`, result);
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

// Sync batch deletions with PostgreSQL
export async function syncBatchDeletionWithPostgreSQL(bookId, deletedData, libraryRecord) {
  console.log(`🔍 Syncing batch deletion to PostgreSQL for book: ${bookId}`);
  
  try {
    const response = await fetch("/api/db/node-chunks/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        book: bookId,
        deletedNodeChunks: deletedData.nodeChunks,
        deletedHyperlights: deletedData.hyperlights,
        deletedHypercites: deletedData.hypercites,
        libraryRecord: libraryRecord
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`✅ Batch deletion synced to PostgreSQL:`, result);
    
    return result;
  } catch (error) {
    console.error("❌ Failed to sync batch deletion to PostgreSQL:", error);
    throw error;
  }
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

// WE NEED TO ALSO SYNC THE LIBRARY RECORD...
// 🆕 UPDATED: Sync function now includes library record
// 🆕 UPDATED: Sync function now includes library record
async function syncNodeUpdateWithPostgreSQL(bookId, nodeChunk, hyperlights, hypercites, libraryRecord) {
  try {
    console.log("🔄 Starting PostgreSQL sync for node update...");

    // Sync node chunk if it exists
    if (nodeChunk) {
      const nodeChunkResponse = await fetch("/api/db/node-chunks/targeted-upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: [nodeChunk]
        }),
      });

      if (!nodeChunkResponse.ok) {
        throw new Error(
          `NodeChunk sync failed: ${nodeChunkResponse.statusText}`
        );
      }

      console.log("✅ NodeChunk synced with PostgreSQL");
    }

    // Sync hyperlights if any exist
    if (hyperlights.length > 0) {
      const hyperlightResponse = await fetch("/api/db/hyperlights/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: hyperlights
        }),
      });

      if (!hyperlightResponse.ok) {
        throw new Error(
          `Hyperlight sync failed: ${hyperlightResponse.statusText}`
        );
      }

      console.log(`✅ ${hyperlights.length} Hyperlights synced with PostgreSQL`);
    }

    // Sync hypercites if any exist
    if (hypercites.length > 0) {
      const hyperciteResponse = await fetch("/api/db/hypercites/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: hypercites
        }),
      });

      if (!hyperciteResponse.ok) {
        throw new Error(`Hypercite sync failed: ${hyperciteResponse.statusText}`);
      }

      console.log(`✅ ${hypercites.length} Hypercites synced with PostgreSQL`);
    }

    // 🔥 FIXED: Sync library record as single object (not array)
    if (libraryRecord) {
      const libraryResponse = await fetch("/api/db/library/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: libraryRecord // 🔥 Send as single object, not array
        }),
      });

      if (!libraryResponse.ok) {
        throw new Error(`Library sync failed: ${libraryResponse.statusText}`);
      }

      console.log("✅ Library record synced with PostgreSQL");
    }

    console.log("🎉 Node update successfully synced with PostgreSQL");
  } catch (error) {
    console.error("❌ Error syncing node update with PostgreSQL:", error);
    throw error;
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

      if (result.success) {
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
        relationshipStatus: updatedRelationshipStatus
      }
    );

    if (!hyperciteSuccess) {
      console.error(`Failed to update hypercite ${hyperciteIDa}`);
      return false;
    }

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
        const nodeChunkSyncResult = await syncNodeChunksToPostgreSQL(updatedNodeChunks);
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

      // 🔥 FIXED: Sync library records individually
      if (libraryRecords.length > 0) {
        console.log(`🔄 Syncing ${libraryRecords.length} library records to PostgreSQL...`);
        
        // Send each library record individually
        for (const libraryRecord of libraryRecords) {
          const libraryResponse = await fetch("/api/db/library/upsert", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-TOKEN": document
                .querySelector('meta[name="csrf-token"]')
                ?.getAttribute("content"),
            },
            body: JSON.stringify({
              data: libraryRecord // 🔥 Send as single object
            }),
          });

          if (!libraryResponse.ok) {
            console.error(`❌ Failed to sync library record for book ${libraryRecord.book}`);
          } else {
            console.log(`✅ Successfully synced library record for book ${libraryRecord.book}`);
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
async function syncNodeChunksToPostgreSQL(nodeChunks) {
  try {
    const response = await fetch('/api/db/node-chunks/targeted-upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
      },
      body: JSON.stringify({
        data: nodeChunks
      })
    });

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error syncing nodeChunks to PostgreSQL:', error);
    return { success: false, message: error.message };
  }
}

// 🆕 Function to sync hypercite to PostgreSQL
async function syncHyperciteToPostgreSQL(hypercite) {
  try {
    const response = await fetch('/api/db/hypercites/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
      },
      body: JSON.stringify({
        data: [hypercite] // Wrap in array if the endpoint expects an array
      })
    });

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error syncing hypercite to PostgreSQL:', error);
    return { success: false, message: error.message };
  }
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
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}] with citation for hypercite ${hyperciteId}`);
            await updateBookTimestamp(book);
            resolve({
              success: true,
              relationshipStatus: hyperciteToUpdate.relationshipStatus // Return the updated status
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

/*
async function updateHyperciteInNodeChunk(book, startLine, hyperciteId, updates) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    // Always convert startLine to float
    const numericStartLine = parseNodeId(startLine);
    
    console.log(`🔍 DEBUGGING: updateHyperciteInNodeChunk called with:`, {
      book,
      startLine,
      numericStartLine,
      hyperciteId,
      updates: JSON.stringify(updates)
    });
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`❌ IndexedDB error: ${event.target.errorCode}`);
      resolve(false);
    };
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);
        
        // Create the key using the numeric startLine
        const key = [book, numericStartLine];
        console.log("🔑 Using key for update:", key);
        
        // Get the existing record
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;
          
          if (!existingRecord) {
            console.error(`❌ Record not found for key: [${book}, ${numericStartLine}]`);
            resolve(false);
            return;
          }
          
          console.log("📄 BEFORE: Full nodeChunk record:", JSON.stringify(existingRecord));
          console.log("🔍 BEFORE: All hypercites in this nodeChunk:", JSON.stringify(existingRecord.hypercites));
          
          // Ensure hypercites array exists
          if (!existingRecord.hypercites) {
            existingRecord.hypercites = [];
            console.log("⚠️ Created empty hypercites array");
          }
          
          // Find the specific hypercite to update
          const hyperciteIndex = existingRecord.hypercites.findIndex(
            h => h.hyperciteId === hyperciteId
          );
          
          if (hyperciteIndex === -1) {
            console.error(`❌ Hypercite ${hyperciteId} not found in nodeChunk [${book}, ${numericStartLine}]`);
            resolve(false);
            return;
          }
          
          console.log(`🎯 Found hypercite at index ${hyperciteIndex}:`, 
            JSON.stringify(existingRecord.hypercites[hyperciteIndex]));
          
          // IMPORTANT: Create a new array with all hypercites
          const updatedHypercites = [...existingRecord.hypercites];
          
          // Update only the specific hypercite
          const targetHypercite = {...updatedHypercites[hyperciteIndex]};
          
          // Special handling for citedIN array
          if (updates.citedIN) {
            console.log("🔄 Processing citedIN update");
            
            // Ensure targetHypercite has a citedIN array
            targetHypercite.citedIN = targetHypercite.citedIN || [];
            console.log("📋 Original citedIN:", JSON.stringify(targetHypercite.citedIN));
            
            // Add any new citations that don't already exist
            updates.citedIN.forEach(citation => {
              if (!targetHypercite.citedIN.includes(citation)) {
                targetHypercite.citedIN.push(citation);
                console.log(`➕ Added citation: ${citation}`);
              } else {
                console.log(`ℹ️ Citation already exists: ${citation}`);
              }
            });
          }
          
          // Apply other updates
          Object.keys(updates).forEach(key => {
            if (key !== 'citedIN') {
              targetHypercite[key] = updates[key];
              console.log(`🔄 Updated ${key} to:`, updates[key]);
            }
          });
          
          // Replace the hypercite in our array copy
          updatedHypercites[hyperciteIndex] = targetHypercite;
          
          // Replace the entire hypercites array in the record
          existingRecord.hypercites = updatedHypercites;
          
          console.log("📄 AFTER: Updated hypercite:", JSON.stringify(targetHypercite));
          console.log("🔍 AFTER: All hypercites in nodeChunk:", JSON.stringify(existingRecord.hypercites));
          
          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);
          
          updateRequest.onsuccess = async() => {
            console.log(`✅ Successfully updated hypercite ${hyperciteId} in nodeChunk [${book}, ${numericStartLine}]`);
            await updateBookTimestamp(bookId);
            resolve(true);
          };
          
          updateRequest.onerror = (event) => {
            console.error(`❌ Error updating record:`, event.target.error);
            resolve(false);
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`❌ Error getting record:`, event.target.error);
          resolve(false);
        };
        
        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("❌ Transaction error:", error);
        resolve(false);
      }
    };
  });
}

*/


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
async function syncDeletionToPostgreSQL(bookId, startLine, libraryRecord) {
  try {
    console.log(`🔄 Syncing deletion to PostgreSQL: book=${bookId}, startLine=${startLine}`);

    // Create a deletion record for the targeted-upsert endpoint
    const deletionRecord = {
      book: bookId,
      startLine: startLine,
      _action: "delete" // Flag to indicate this is a deletion
    };

    // Sync the deletion to PostgreSQL
    const nodeChunkResponse = await fetch("/api/db/node-chunks/targeted-upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content"),
      },
      body: JSON.stringify({
        data: [deletionRecord]
      }),
    });

    if (!nodeChunkResponse.ok) {
      throw new Error(
        `NodeChunk deletion sync failed: ${nodeChunkResponse.statusText}`
      );
    }

    console.log("✅ NodeChunk deletion synced with PostgreSQL");

    // Sync updated library record if it exists
    if (libraryRecord) {
      const libraryResponse = await fetch("/api/db/library/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: libraryRecord
        }),
      });

      if (!libraryResponse.ok) {
        throw new Error(`Library sync failed: ${libraryResponse.statusText}`);
      }

      console.log("✅ Library record synced with PostgreSQL");
    }

    console.log("🎉 Deletion successfully synced with PostgreSQL");
  } catch (error) {
    console.error("❌ Error syncing deletion with PostgreSQL:", error);
    throw error;
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
    const db = await openDatabase();
    const tx = db.transaction(["library"], "readonly");
    const libraryStore = tx.objectStore("library");
    
    const getRequest = libraryStore.get(book);
    
    const libraryObject = await new Promise((resolve, reject) => {
      getRequest.onsuccess = (e) => resolve(e.target.result);
      getRequest.onerror = (e) => reject(e.target.error);
    });

    console.log("📚 Retrieved library object for book:", book, libraryObject);
    return libraryObject;
    
  } catch (error) {
    console.error("❌ Error getting library object from IndexedDB:", error);
    return null;
  }
}
