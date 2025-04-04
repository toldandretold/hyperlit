import { book } from "./app.js";

export const DB_VERSION = 9;

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
          // For nodeChunks, we use a composite primary key [book, startLine]
          name: "nodeChunks",
          keyPath: ["book", "startLine"],
          indices: ["chunk_id", "book"],
        },
        {
          // For footnotes, we now use just "book" as the key
          name: "footnotes",
          keyPath: "book"
        },
        {
          // The remaining stores remain unchanged;
          // update these later if you plan to remove url/container there as well.
          name: "markdownStore",
          keyPath: ["url", "book"]
        },
        {
          name: "hyperlights",
          keyPath: ["book", "hyperlight_id"],
          indices: ["hyperlight_id"]
        },
        {
          name: "hypercites",
          keyPath: ["url", "book", "hypercite_id"]
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
export async function saveNodeChunksToIndexedDB(nodeChunks, bookId = "latest") {
  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readwrite");
  const store = tx.objectStore("nodeChunks");

  nodeChunks.forEach((record) => {
    // Tag the record with the proper book identifier.
    record.book = bookId;
    // record.chunk_id and record.startLine must be set by the parser.
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
}

/**
 * Retrieves nodeChunks for a specified book from IndexedDB.
 * 
 * The returned array is sorted by chunk_id.
 */
export async function getNodeChunksFromIndexedDB(bookId = "latest") {
  console.log("Fetching nodeChunks for book:", bookId);

  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readonly");
  const store = tx.objectStore("nodeChunks");
  
  return new Promise((resolve, reject) => {
    // Get all records and filter manually
    const request = store.getAll();
    
    request.onsuccess = () => {
      let results = request.result || [];
      
      // Filter by book ID directly
      results = results.filter((record) => record.book === bookId);

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
function processNodeContentAndHighlights(node) {
  const content = node.cloneNode(true);
  const hyperlights = [];
  
  // Find all mark tags in the original node
  const markTags = node.getElementsByTagName('mark');
  
  console.log("Processing node:", node.outerHTML);
  
  // Process each mark tag to get position data
  Array.from(markTags).forEach(mark => {
    // Get text content up to the mark tag's start position
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
          // If the current element contains our mark, we need to traverse its children
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
    
    const highlightData = {
      highlightID: mark.id,
      charStart: startPos,
      charEnd: startPos + highlightLength
    };
    
    console.log("Calculated highlight positions:", {
      id: mark.id,
      text: mark.textContent,
      startPos,
      endPos: startPos + highlightLength,
      totalNodeLength: node.textContent.length
    });
    
    hyperlights.push(highlightData);
  });
  
  // Remove all mark tags from the clone while preserving their text content
  const markTagsInClone = content.getElementsByTagName('mark');
  while (markTagsInClone.length > 0) {
    const markTag = markTagsInClone[0];
    const textContent = markTag.textContent;
    markTag.parentNode.replaceChild(document.createTextNode(textContent), markTag);
  }
  
  const result = {
    content: content.outerHTML,
    hyperlights
  };
  
  console.log("Processed result:", result);
  
  return result;
}


export async function updateIndexedDBRecord(record) {
  try {
    const bookId = book || "latest";
    
    // Find the parent node with a numeric ID if we're dealing with a mark tag
    let nodeId = record.id;
    let node = document.getElementById(record.id);
    
    if (node && !nodeId.match(/^\d+(\.\d+)?$/)) {
      // Traverse up until we find a parent with a numeric ID
      while (node && node.parentElement) {
        node = node.parentElement;
        if (node.id && node.id.match(/^\d+(\.\d+)?$/)) {
          nodeId = node.id;
          break;
        }
      }
    }
    
    if (!nodeId.match(/^\d+(\.\d+)?$/)) {
      console.log(`Skipping IndexedDB update - no valid parent node ID found for: ${record.id}`);
      return;
    }
    
    console.log(`Updating IndexedDB record for node ${nodeId}, action: ${record.action}`);
    
    // Process content and hyperlights if we have a node
    let processedContent = null;
    if (node) {
      processedContent = processNodeContentAndHighlights(node);
    }
    
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    
    const newStartLine = parseFloat(nodeId);
    const baseNumber = parseFloat(nodeId.match(/^(\d+)/)[1]);
    
    if (record.action !== "normalize") {
      const baseKey = [bookId, baseNumber];
      const baseRequest = store.get(baseKey);
      
      baseRequest.onsuccess = () => {
        let inheritedChunkId = null;
        const baseRecord = baseRequest.result;
        if (baseRecord && baseRecord.chunk_id !== undefined) {
          inheritedChunkId = baseRecord.chunk_id;
        } else {
          inheritedChunkId = 0;
        }
        
        const getRequest = store.get([bookId, newStartLine]);
        getRequest.onsuccess = () => {
          const existingRecord = getRequest.result;
          
          let nodeRecord;
          if (existingRecord) {
            nodeRecord = {
              ...existingRecord,
              content: processedContent ? processedContent.content : record.html
            };
            // Update existing hyperlights if we have new ones
            if (processedContent && processedContent.hyperlights.length > 0) {
              // Update existing hyperlights while preserving any that weren't changed
              const updatedHyperlights = existingRecord.hyperlights || [];
              processedContent.hyperlights.forEach(newHyperlight => {
                const existingIndex = updatedHyperlights.findIndex(
                  h => h.highlightID === newHyperlight.highlightID
                );
                if (existingIndex !== -1) {
                  // Update existing hyperlight
                  updatedHyperlights[existingIndex] = newHyperlight;
                } else {
                  // Add new hyperlight
                  updatedHyperlights.push(newHyperlight);
                }
              });
              nodeRecord.hyperlights = updatedHyperlights;
            }
          } else {
            nodeRecord = {
              book: bookId,
              startLine: newStartLine,
              chunk_id: inheritedChunkId,
              content: processedContent ? processedContent.content : record.html,
              hyperlights: processedContent ? processedContent.hyperlights : []
            };
          }
          
          const putRequest = store.put(nodeRecord);
          putRequest.onsuccess = () => {
            console.log(`Successfully ${record.action === "add" ? "added" : "updated"} record for node ${nodeId}`);
          };
        };
      };
    } else {
      // Normalization branch
      const oldKey = [bookId, parseFloat(record.oldId)];
      const getRequest = store.get(oldKey);
      getRequest.onsuccess = () => {
        const oldRecord = getRequest.result;
        if (oldRecord) {
          const newRecord = {
            ...oldRecord,
            startLine: newStartLine,
            content: processedContent ? processedContent.content : record.html
          };
          // Update hyperlights during normalization if needed
          if (processedContent && processedContent.hyperlights.length > 0) {
            const updatedHyperlights = oldRecord.hyperlights || [];
            processedContent.hyperlights.forEach(newHyperlight => {
              const existingIndex = updatedHyperlights.findIndex(
                h => h.highlightID === newHyperlight.highlightID
              );
              if (existingIndex !== -1) {
                updatedHyperlights[existingIndex] = newHyperlight;
              } else {
                updatedHyperlights.push(newHyperlight);
              }
            });
            newRecord.hyperlights = updatedHyperlights;
          }
          const putRequest = store.put(newRecord);
          putRequest.onsuccess = () => {
            store.delete(oldKey);
            console.log(`Normalized record from ID ${record.oldId} to ${nodeId}`);
          };
        } else {
          console.log(`No record found with ID ${record.oldId} for normalization`);
          const newRecord = {
            book: bookId,
            startLine: newStartLine,
            chunk_id: parseInt(baseNumber, 10),
            content: processedContent ? processedContent.content : record.html,
            hyperlights: processedContent ? processedContent.hyperlights : []
          };
          store.put(newRecord);
          console.log(`Created new record for normalized node ${nodeId}`);
        }
      };
    }
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (event) => {
        console.error("Transaction error:", event.target.error);
        reject(event.target.error);
      };
    });
    
  } catch (error) {
    console.error("Error in updateIndexedDBRecord:", error);
  }
}



export async function deleteIndexedDBRecord(id) {
  try {
    const bookId = book || "latest";
    
    const node = document.getElementById(id);
    
    // Updated regex to accept decimal IDs.
    if (!id.match(/^\d+(\.\d+)?$/)) {
      console.log(`Skipping IndexedDB delete for node with non-standard ID: ${id}`);
      return;
    }
    
    console.log(`Deleting node with ID ${id} from IndexedDB`);
    
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    
    // Convert id to a number for the composite key.
    const numericId = parseFloat(id);
    
    // Delete the record using the composite key [book, numericId].
    const deleteRequest = store.delete([bookId, numericId]);
    
    deleteRequest.onsuccess = () => {
      console.log(`Successfully deleted record for node ${id}`);
    };
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (event) => {
        console.error("Transaction error:", event.target.error);
        reject(event.target.error);
      };
    });
  } catch (error) {
    console.error("Error in deleteIndexedDBRecord:", error);
  }
}

