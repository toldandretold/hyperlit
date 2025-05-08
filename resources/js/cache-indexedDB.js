import { book } from "./app.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';
import { withPending } from "./operationState.js"

export const DB_VERSION = 13;



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
          indices: ["hyperlight_id"],
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: ["hyperciteId"],
        },
        // <<< NEW: Library store >>>
        {
          name: "library",
          keyPath: "citationID",
    
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
 * Saves nodeChunks (an array of chunk records) into IndexedDB.
 * 
 * Each record must have:
 *   - book,
 *   - chunk_id,
 *   - startLine (unique within the book).
 *
 * The composite key for nodeChunks is [book, startLine].
 */
// For saving nodeChunks
export async function saveNodeChunksToIndexedDB(nodeChunks, bookId = "latest") {
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    nodeChunks.forEach((record) => {
      // Tag the record with the proper book identifier
      record.book = bookId;
      
      // Convert startLine to the appropriate numeric format
      record.startLine = parseNodeId(record.startLine);
      
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log("✅ nodeChunks successfully saved for book:", bookId);
        resolve();
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


// Helper function to ensure consistent key format for nodeChunks
export function createNodeChunksKey(bookId, startLine) {

  return [bookId, parseNodeId(startLine)];
}

/**
 * Retrieves nodeChunks for a specified book from IndexedDB.
 * 
 * The returned array is sorted by chunk_id.
 */
// For retrieving nodeChunks
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
      request.onsuccess = () => {
        console.log("✅ Successfully saved footnotes to IndexedDB.");
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


// Helper function to process node content and highlights
// Helper function to process node content, highlights (<mark>) and citations (<u>)
// Helper function to process node content for highlights (<mark>) and citations (<u>)
function processNodeContentHighlightsAndCites(node) {
  // Clone the node to work on a copy of its content.
  const contentClone = node.cloneNode(true);
  const hyperlights = [];
  const hypercites = [];

  console.log("Processing node:", node.outerHTML);

  // --- Process <mark> tags for hyperlights ---
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    // Get text content up to the <mark>'s start position.
    let currentNode = node.firstChild;
    let startPos = 0;
    let foundMark = false;

    while (currentNode && !foundMark) {
      if (currentNode === mark) {
        foundMark = true;
      } else if (currentNode.nodeType === Node.TEXT_NODE) {
        startPos += currentNode.length;
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        if (currentNode.contains(mark)) {
          // Traverse the children until we find the mark.
          let child = currentNode.firstChild;
          while (child && child !== mark) {
            if (child.nodeType === Node.TEXT_NODE) {
              startPos += child.length;
            }
            child = child.nextSibling;
          }
          foundMark = true;
        } else {
          startPos += currentNode.textContent.length;
        }
      }
      if (!foundMark) {
        currentNode = currentNode.nextSibling;
      }
    }

    const highlightLength = mark.textContent.length;
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
      totalNodeLength: node.textContent.length,
    });
  });

  // --- Process <u> tags for hypercites ---
  const uTags = node.getElementsByTagName("u");
  Array.from(uTags).forEach((uTag) => {
    // Get text content up to the <u>'s start position.
    let currentNode = node.firstChild;
    let startPos = 0;
    let foundU = false;

    while (currentNode && !foundU) {
      if (currentNode === uTag) {
        foundU = true;
      } else if (currentNode.nodeType === Node.TEXT_NODE) {
        startPos += currentNode.length;
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        if (currentNode.contains(uTag)) {
          // Traverse the children until we find the u tag.
          let child = currentNode.firstChild;
          while (child && child !== uTag) {
            if (child.nodeType === Node.TEXT_NODE) {
              startPos += child.length;
            }
            child = child.nextSibling;
          }
          foundU = true;
        } else {
          startPos += currentNode.textContent.length;
        }
      }
      if (!foundU) {
        currentNode = currentNode.nextSibling;
      }
    }

    const uLength = uTag.textContent.length;
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
      totalNodeLength: node.textContent.length,
    });
  });

  // --- Remove all <mark> tags from the cloned content while preserving their text content ---
  const clonedMarkTags = contentClone.getElementsByTagName("mark");
  while (clonedMarkTags.length > 0) {
    const markTag = clonedMarkTags[0];
    const textContent = markTag.textContent;
    markTag.parentNode.replaceChild(document.createTextNode(textContent), markTag);
  }

  // --- Remove all <u> tags from the cloned content while preserving their text content ---
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

    // find a numeric parent ID
    let nodeId = record.id;
    let node   = document.getElementById(nodeId);
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

    const processed = node
      ? processNodeContentHighlightsAndCites(node)
      : null;

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore    = tx.objectStore("nodeChunks");
    const lightsStore    = tx.objectStore("hyperlights");
    const citesStore     = tx.objectStore("hypercites");
    const compositeKey   = [bookId, numericNodeId];

    // fetch the existing chunk (if any)
    const getReq = chunksStore.get(compositeKey);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      let toSave;

      if (existing) {
        toSave = {
          ...existing,
          content: processed?.content ?? record.html,
          hyperlights: processed?.hyperlights ?? existing.hyperlights,
          hypercites: processed?.hypercites  ?? existing.hypercites,
        };
      } else {
        toSave = {
          book: bookId,
          startLine: numericNodeId,
          chunk_id: 0,
          content: processed?.content ?? record.html,
          hyperlights: processed?.hyperlights ?? [],
          hypercites: processed?.hypercites ?? [],
        };
      }

      // write the node chunk
      chunksStore.put(toSave);

      // update the hyperlights/hypercites stores
      for (const h of toSave.hyperlights) {
        updateHyperlightInStore(lightsStore, bookId, h, numericNodeId);
      }
      for (const c of toSave.hypercites) {
        updateHyperciteInStore(citesStore, bookId, c);
      }
    };

    getReq.onerror = (e) => {
      console.error("Error fetching nodeChunk:", e.target.error);
      // let tx.onerror handle the rejection
    };

    // return a promise that resolves/rejects with the transaction
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log("✅ IndexedDB record update complete");
        resolve();
      };
      tx.onerror = (e) => {
        console.error("Transaction failed:", e.target.error);
        reject(e.target.error);
      };
      tx.onabort = (e) => {
        console.warn("Transaction aborted:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}


// Helper functions for updating hyperlights and hypercites
function updateHyperlightInStore(store, bookId, hyperlight, numericNodeId) {
    const key = [bookId, hyperlight.highlightID];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      if (existingRecord) {
        // Update existing record
        existingRecord.startChar = hyperlight.charStart;
        existingRecord.endChar = hyperlight.charEnd;
        existingRecord.startLine = numericNodeId;
        
        store.put(existingRecord);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperlight_id: hyperlight.highlightID,
          startChar: hyperlight.charStart,
          endChar: hyperlight.charEnd,
          startLine: numericNodeId,
          highlightedText: hyperlight.highlightedText || "",
          highlightedHTML: hyperlight.highlightedHTML || "",
          annotation: ""
        };
        
        store.put(newRecord);
      }
    };
}

function updateHyperciteInStore(store, bookId, hypercite) {
    const key = [bookId, hypercite.hyperciteId];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      if (existingRecord) {
        // Update existing record
        existingRecord.startChar = hypercite.charStart;
        existingRecord.endChar = hypercite.charEnd;
        
        store.put(existingRecord);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperciteId: hypercite.hyperciteId,
          startChar: hypercite.charStart,
          endChar: hypercite.charEnd,
          hypercitedText: hypercite.hypercitedText || "",
          hypercitedHTML: hypercite.hypercitedHTML || "",
          citedIN: [],
          relationshipStatus: "single"
        };
        
        store.put(newRecord);
      }
    };
}




// Helper function to update a specific nodeChunk in IndexedDB
async function updateNodeChunkInIndexedDB(book, startLine, updatedFields) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    // Always convert startLine to float
    const numericStartLine = parseNodeId(startLine);
    
    console.log(`Updating nodeChunk: book=${book}, startLine=${numericStartLine}`);
    
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
        
        // Create the key using the numeric startLine
        const key = [book, numericStartLine];
        console.log("Using key for update:", key);
        
        // Get the existing record
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;
          
          if (!existingRecord) {
            console.error(`Record not found for key: [${book}, ${numericStartLine}]`);
            resolve(false);
            return;
          }
          
          // Update the fields in the existing record
          Object.assign(existingRecord, updatedFields);
          
          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);
          
          updateRequest.onsuccess = () => {
            console.log(`Successfully updated record for key: [${book}, ${numericStartLine}]`);
            resolve(true);
          };
          
          updateRequest.onerror = (event) => {
            console.error(`Error updating record:`, event.target.error);
            resolve(false);
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`Error getting record:`, event.target.error);
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
          
          updateRequest.onsuccess = () => {
            console.log(`Successfully updated hypercite for key: [${book}, ${hyperciteId}]`);
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

    // 1) Update the nodeChunks store
    for (const record of nodeChunks) {
      const hcList = record.hypercites;
      if (!Array.isArray(hcList)) continue;

      const idx = hcList.findIndex(hc => hc.hyperciteId === hyperciteIDa);
      if (idx === -1) continue;

      const startLine = record.startLine;
      const hypercite = hcList[idx];

      // ensure citedIN array
      hypercite.citedIN ||= [];

      if (!hypercite.citedIN.includes(citationIDb)) {
        hypercite.citedIN.push(citationIDb);
        console.log(`Added citation ${citationIDb} to hypercite`);
      }

      // relationshipStatus logic
      const count = hypercite.citedIN.length;
      hypercite.relationshipStatus =
        count === 1 ? "couple" : count >= 2 ? "poly" : "single";
      updatedRelationshipStatus = hypercite.relationshipStatus;

      const success = await updateNodeChunkInIndexedDB(
        booka,
        startLine,
        record
      );

      if (success) {
        foundAndUpdated = true;
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
    //    (to persist citedIN array + relationshipStatus)
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

    console.log(
      `Successfully updated hypercite ${hyperciteIDa} in book ${booka}`
    );
    return true;
  });
}

async function getHyperciteFromIndexedDB(book, hyperciteId) {
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

    // optional transaction timeout
    const TRANSACTION_TIMEOUT = 10000;
    const timeoutId = setTimeout(() => tx.abort(), TRANSACTION_TIMEOUT);

    store.delete(key);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        clearTimeout(timeoutId);
        console.log(`Successfully deleted record with key: ${key}`);
        resolve(true);
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
      tx.oncomplete = () => {
        clearTimeout(timeoutId);
        console.log(`Successfully normalized record: ${oldId} -> ${newId}`);
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

export async function renumberChunkAndSave(chunkEl) {
  // 1) Collect block‐level children
  const blocks = Array.from(chunkEl.children)
    .filter(el => el.nodeType === 1); // narrow if you like

  // 2) Renumber in DOM and save each
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    const newLine = i + 1;
    el.id = String(newLine);
    el.setAttribute("data-block-id", String(newLine));

    // Persist via your existing routine
    await updateIndexedDBRecord({
      id: el.id,
      html: el.outerHTML,
      action: "update"
    });
  }

  // 3) Re‐chunk the entire book
  await rechunkAllNodeChunks();
}

async function rechunkAllNodeChunks() {
  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readwrite");
  const store = tx.objectStore("nodeChunks");

  // 1) Load all entries for this book
  const all = [];
  await new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return resolve();
      const rec = cursor.value;
      if (rec.book === book) {
        all.push(rec);
      }
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });

  // 2) Sort by startLine (numeric)
  all.sort((a, b) => parseFloat(a.startLine) - parseFloat(b.startLine));

  // 3) Re-assign chunk_id and put back
  all.forEach((rec, idx) => {
    const newChunk = Math.floor(idx / 100);
    if (rec.chunk_id !== newChunk) {
      rec.chunk_id = newChunk;
      store.put(rec);
    }
  });

  // 4) Wait for the transaction to finish
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
    tx.onabort    = () => reject(new Error("rechunk aborted"));
  });
}

