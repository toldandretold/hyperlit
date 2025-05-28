import { book } from "./app.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';
import { withPending } from "./operationState.js"

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
export async function addNodeChunkToIndexedDB(bookId, startLine, content, chunkId = 0) {
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
        tx.oncomplete = () => {
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

    // Process the current state of the DOM node to get updated content, hyperlights, and hypercites
    const processed = node
      ? processNodeContentHighlightsAndCites(node)
      : null;

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const compositeKey = [bookId, numericNodeId];

    // Fetch the existing chunk record
    const getReq = chunksStore.get(compositeKey);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      let toSave;

      if (existing) {
        console.log("Existing nodeChunk found for merge:", JSON.stringify(existing));

        // Start with a copy of the existing record to preserve its structure
        toSave = { ...existing };

        // Update content based on processed result or record.html
        toSave.content = processed?.content ?? record.html;

        // Add the chunk_ID update here
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
          console.log(`Updated chunk_id to ${record.chunk_id} for node ${nodeId}`);
        }

        // Update hyperlights (assuming simple replacement based on DOM is acceptable)
        toSave.hyperlights = processed ? (processed.hyperlights ?? []) : existing.hyperlights;


        // --- MERGE HYPERCITES INTELLIGENTLY ---
        // This is the core part to prevent data loss
        if (processed?.hypercites) {
          // Ensure toSave has a hypercites array to merge into
          if (!Array.isArray(toSave.hypercites)) {
            toSave.hypercites = [];
            console.log("Initialized empty hypercites array in toSave.");
          }

          // Create a map of existing hypercites by ID for easy lookup
          const existingHypercitesMap = new Map(toSave.hypercites.map(hc => [hc.hyperciteId, hc]));
          console.log("Existing hypercites map:", existingHypercitesMap);

          // Create a new array for the merged hypercites
          const mergedHypercites = [];

          // Iterate through the hypercites extracted from the *current DOM state*
          processed.hypercites.forEach(processedHypercite => {
            const existingHypercite = existingHypercitesMap.get(processedHypercite.hyperciteId);

            if (existingHypercite) {
              // If the hypercite with this ID already exists in the database record:
              // Update its position (charStart, charEnd) based on the current DOM.
              // PRESERVE its existing citedIN and relationshipStatus.
              console.log(`Merging existing hypercite ${processedHypercite.hyperciteId}: Updating position, preserving citedIN/status.`);
              mergedHypercites.push({
                ...existingHypercite, // Start with the existing hypercite's full data
                charStart: processedHypercite.charStart, // Override position from DOM
                charEnd: processedHypercite.charEnd,     // Override position from DOM
                // citedIN and relationshipStatus are implicitly preserved from existingHypercite
              });
              // Remove from map so we know which existing ones were matched
              existingHypercitesMap.delete(processedHypercite.hyperciteId);
            } else {
              // If this hypercite is found in the DOM but *not* in the existing database record:
              // This is likely a newly created hypercite in the DOM.
              // Add it to the merged list with initial citedIN and relationshipStatus.
              console.log(`Adding new hypercite from DOM ${processedHypercite.hyperciteId} to merged list.`);
              mergedHypercites.push({
                 ...processedHypercite, // Includes hyperciteId, charStart, charEnd from DOM
                 citedIN: [], // Initialize as empty
                 relationshipStatus: "single" // Initialize as single
              });
            }
          });

          // After iterating through processed.hypercites, mergedHypercites contains:
          // 1. Updated versions of hypercites found in both DOM and DB (position updated, status/citedIN preserved).
          // 2. New hypercites found only in the DOM (added with initial status/citedIN).

          // Existing hypercites that are still in existingHypercitesMap were *not* found in the processed.hypercites.
          // This means they were likely removed from the DOM. Filter them out from the final list.
          // (Assuming if an <u> tag is removed from the DOM, you want to remove the hypercite from the nodeChunk).
          // If you wanted to keep them (e.g., as historical data), you would add them back from the map here.
          console.log("Existing hypercites not found in current DOM:", existingHypercitesMap.keys());
          // The current implementation of the loop already only added those found in the DOM,
          // so no need to filter 'mergedHypercites'. The check below handles the case
          // where processed.hypercites was empty.

          toSave.hypercites = mergedHypercites;

        } else if (processed) {
           // If processNodeContentHighlightsAndCites ran but returned an empty array (no <u> tags found),
           // it means all hypercites were removed from the DOM.
           // In this case, clear the hypercites array in the database record.
           console.log("No hypercites found in processed result, clearing hypercites in record.");
           toSave.hypercites = [];
        } else {
            // If processed is null (node not found for some reason), keep existing hypercites
            console.log("Processed result is null, keeping existing hypercites.");
            toSave.hypercites = existing.hypercites ?? [];
        }
        // --- END MERGE HYPERCITES ---


      } else {
        // Case: No existing record, create a new one
        console.log("No existing nodeChunk record, creating new one.");
        toSave = {
          book: bookId,
          startLine: numericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : 0, // Use provided chunk_ID if available
          content: processed?.content ?? record.html,
          hyperlights: processed?.hyperlights ?? [],
          // For a new record, initialize hypercites with initial values if found in DOM
          hypercites: processed?.hypercites?.map(hc => ({
             ...hc, // Includes hyperciteId, charStart, charEnd from DOM
             citedIN: [], // Initialize as empty
             relationshipStatus: "single" // Initialize as single
          })) ?? [], // If processed.hypercites is null or empty, initialize as empty array
        };
        console.log("New nodeChunk record to create:", JSON.stringify(toSave));
      }

      console.log("Final nodeChunk record to put:", JSON.stringify(toSave));

      // write the node chunk
      chunksStore.put(toSave);

      // update the hyperlights/hypercites stores (master records)
      // These stores hold the *master* record for each hyperlight/hypercite.
      // The nodeChunk record just stores their positions and relationship to the node.
      if (toSave.hyperlights) {
        for (const h of toSave.hyperlights) {
            // updateHyperlightInStore needs to be separate and smart enough not to
            // overwrite annotation or other master properties.
            updateHyperlightInStore(lightsStore, bookId, h, numericNodeId);
        }
      }
      if (toSave.hypercites) {
        for (const c of toSave.hypercites) {
            // updateHyperciteInStore needs to be separate and smart enough to NOT overwrite
            // citedIN and relationshipStatus if it finds an existing master record.
            updateHyperciteInStore(citesStore, bookId, c);
        }
      }
    };

    getReq.onerror = (e) => {
      console.error("Error fetching nodeChunk for update:", e.target.error);
      // let tx.onerror handle the rejection
    };

    // return a promise that resolves/rejects with the transaction
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log("✅ IndexedDB record update complete");
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

    console.log(
      `Successfully updated hypercite ${hyperciteIDa} in book ${booka}`
    );
    return true;
  });
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
          
          updateRequest.onsuccess = () => {
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}] with citation for hypercite ${hyperciteId}`);
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
          
          updateRequest.onsuccess = () => {
            console.log(`✅ Successfully updated hypercite ${hyperciteId} in nodeChunk [${book}, ${numericStartLine}]`);
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

