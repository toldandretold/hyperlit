import { book } from "./app.js";
import { broadcastToOpenTabs } from "./divEditor.js";

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
}

// Helper function to convert a string ID to the appropriate numeric format
export function parseNodeId(id) {
  
  if (typeof id === 'number') return id;
  
  // Handle string IDs like "1" or "1.1"
  if (id.includes('.')) {
    // For decimal IDs like "1.1", parse as float
    return parseFloat(id);
  } else {
    // For integer IDs like "1", parse as integer
    return parseInt(id, 10);
  }
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
      processedContent = processNodeContentHighlightsAndCites(node);
    }
    
    const db = await openDatabase();
    const tx = db.transaction(["nodeChunks", "hyperlights", "hypercites"], "readwrite");
    
    // Set transaction event handlers INSIDE the transaction context
    tx.oncomplete = () => console.log(`✅ TX complete for node ${nodeId}`);
    tx.onerror = (e) => console.error(`❌ TX error for node ${nodeId}:`, e.target.error);
    
    const nodeChunksStore = tx.objectStore("nodeChunks");
    const hyperlightsStore = tx.objectStore("hyperlights");
    const hypercitesStore = tx.objectStore("hypercites");
    
    // Convert nodeId to numeric format for database operations
    const numericNodeId = parseNodeId(nodeId);
    
    // Track which hyperlights and hypercites need updating
    let hyperlightsToUpdate = [];
    let hypercitesToUpdate = [];
    
    if (record.action !== "normalize") {
      // Create the proper key for database operations
      const key = createNodeChunksKey(bookId, nodeId);
      console.log("Using database key:", key);
      
      const baseRequest = nodeChunksStore.get(key);
      
      baseRequest.onsuccess = () => {
        let inheritedChunkId = null;
        const baseRecord = baseRequest.result;
        if (baseRecord && baseRecord.chunk_id !== undefined) {
          inheritedChunkId = baseRecord.chunk_id;
        } else {
          inheritedChunkId = 0;
        }
        
        // Use the same key for the main lookup
        const getRequest = nodeChunksStore.get(key);
        getRequest.onsuccess = () => {
          const existingRecord = getRequest.result;
          
          let nodeRecord;
          if (existingRecord) {
            nodeRecord = {
              ...existingRecord,
              content: processedContent ? processedContent.content : record.html
            };
            
            // For hyperlights: update only the position fields.
            if (processedContent && processedContent.hyperlights.length > 0) {
              const updatedHyperlights = existingRecord.hyperlights || [];
              processedContent.hyperlights.forEach(newHyperlight => {
                const index = updatedHyperlights.findIndex(
                  h => h.highlightID === newHyperlight.highlightID
                );
                if (index !== -1) {
                  // Update only the changed position fields
                  updatedHyperlights[index].charStart = newHyperlight.charStart;
                  updatedHyperlights[index].charEnd = newHyperlight.charEnd;
                  
                  // Add to list of hyperlights that need updating in the hyperlights store
                  hyperlightsToUpdate.push({
                    id: newHyperlight.highlightID,
                    startChar: newHyperlight.charStart,
                    endChar: newHyperlight.charEnd,
                    startLine: numericNodeId, // Use numeric value
                    highlightedText: newHyperlight.highlightedText,
                    highlightedHTML: newHyperlight.highlightedHTML
                  });
                } else {
                  updatedHyperlights.push(newHyperlight);
                  
                  // Add new hyperlight to update list
                  hyperlightsToUpdate.push({
                    id: newHyperlight.highlightID,
                    startChar: newHyperlight.charStart,
                    endChar: newHyperlight.charEnd,
                    startLine: numericNodeId, // Use numeric value
                    highlightedText: newHyperlight.highlightedText,
                    highlightedHTML: newHyperlight.highlightedHTML
                  });
                }
              });
              nodeRecord.hyperlights = updatedHyperlights;
            }
            
            // For hypercites: update only the position fields.
            if (processedContent && processedContent.hypercites.length > 0) {
              const updatedHypercites = existingRecord.hypercites || [];
              processedContent.hypercites.forEach(newHypercite => {
                const index = updatedHypercites.findIndex(
                  h => h.hyperciteId === newHypercite.hyperciteId
                );
                if (index !== -1) {
                  // Update only the positional fields.
                  updatedHypercites[index].charStart = newHypercite.charStart;
                  updatedHypercites[index].charEnd = newHypercite.charEnd;
                  
                  // Add to list of hypercites that need updating in the hypercites store
                  hypercitesToUpdate.push({
                    id: newHypercite.hyperciteId,
                    startChar: newHypercite.charStart,
                    endChar: newHypercite.charEnd,
                    hypercitedText: newHypercite.hypercitedText,
                    hypercitedHTML: newHypercite.hypercitedHTML
                  });
                } else {
                  updatedHypercites.push(newHypercite);
                  
                  // Add new hypercite to update list
                  hypercitesToUpdate.push({
                    id: newHypercite.hyperciteId,
                    startChar: newHypercite.charStart,
                    endChar: newHypercite.charEnd,
                    hypercitedText: newHypercite.hypercitedText,
                    hypercitedHTML: newHypercite.hypercitedHTML
                  });
                }
              });
              nodeRecord.hypercites = updatedHypercites;
            }
          } else {
            nodeRecord = {
              book: bookId,
              startLine: numericNodeId, // Store as numeric value
              chunk_id: inheritedChunkId,
              content: processedContent ? processedContent.content : record.html,
              hyperlights: processedContent ? processedContent.hyperlights : [],
              hypercites: processedContent ? processedContent.hypercites : []
            };
            
            // Add all hyperlights and hypercites to update lists
            if (processedContent) {
              processedContent.hyperlights.forEach(hyperlight => {
                hyperlightsToUpdate.push({
                  id: hyperlight.highlightID,
                  startChar: hyperlight.charStart,
                  endChar: hyperlight.charEnd,
                  startLine: numericNodeId, // Use numeric value
                  highlightedText: hyperlight.highlightedText,
                  highlightedHTML: hyperlight.highlightedHTML
                });
              });
              
              processedContent.hypercites.forEach(hypercite => {
                hypercitesToUpdate.push({
                  id: hypercite.hyperciteId,
                  startChar: hypercite.charStart,
                  endChar: hypercite.charEnd,
                  hypercitedText: hypercite.hypercitedText,
                  hypercitedHTML: hypercite.hypercitedHTML
                });
              });
            }
          }

          const putRequest = nodeChunksStore.put(nodeRecord);
          putRequest.onsuccess = () => {
            console.log(`Successfully ${record.action === "add" ? "added" : "updated"} record for node ${nodeId}`);
            
            // Update hyperlights store
            updateHyperlightsStore(hyperlightsStore, bookId, hyperlightsToUpdate);
            
            // Update hypercites store
            updateHypercitesStore(hypercitesStore, bookId, hypercitesToUpdate);
          };
        };
      };
    } else {
      // Normalization branch
      // Create the proper key for old record lookup
      const oldKey = createNodeChunksKey(bookId, record.oldId);
      console.log("Looking up old record with key:", oldKey);
      
      const getRequest = nodeChunksStore.get(oldKey);
      getRequest.onsuccess = () => {
        const oldRecord = getRequest.result;
        if (oldRecord) {
          const newRecord = {
            ...oldRecord,
            startLine: numericNodeId, // Store as numeric value
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
                
                // Add to list of hyperlights that need updating
                hyperlightsToUpdate.push({
                  id: newHyperlight.highlightID,
                  startChar: newHyperlight.charStart,
                  endChar: newHyperlight.charEnd,
                  startLine: numericNodeId, // Use numeric value
                  highlightedText: newHyperlight.highlightedText,
                  highlightedHTML: newHyperlight.highlightedHTML
                });
              } else {
                updatedHyperlights.push(newHyperlight);
                
                // Add new hyperlight to update list
                hyperlightsToUpdate.push({
                  id: newHyperlight.highlightID,
                  startChar: newHyperlight.charStart,
                  endChar: newHyperlight.charEnd,
                  startLine: numericNodeId, // Use numeric value
                  highlightedText: newHyperlight.highlightedText,
                  highlightedHTML: newHyperlight.highlightedHTML
                });
              }
            });
            newRecord.hyperlights = updatedHyperlights;
          }
          
          // Update hypercites during normalization if needed
          if (processedContent && processedContent.hypercites.length > 0) {
            const updatedHypercites = oldRecord.hypercites || [];
            processedContent.hypercites.forEach(newHypercite => {
              const existingIndex = updatedHypercites.findIndex(
                h => h.hyperciteId === newHypercite.hyperciteId
              );
              if (existingIndex !== -1) {
                updatedHypercites[existingIndex] = newHypercite;
                
                // Add to list of hypercites that need updating
                hypercitesToUpdate.push({
                  id: newHypercite.hyperciteId,
                  startChar: newHypercite.charStart,
                  endChar: newHypercite.charEnd,
                  hypercitedText: newHypercite.hypercitedText,
                  hypercitedHTML: newHypercite.hypercitedHTML
                });
              } else {
                updatedHypercites.push(newHypercite);
                
                // Add new hypercite to update list
                hypercitesToUpdate.push({
                  id: newHypercite.hyperciteId,
                  startChar: newHypercite.charStart,
                  endChar: newHypercite.charEnd,
                  hypercitedText: newHypercite.hypercitedText,
                  hypercitedHTML: newHypercite.hypercitedHTML
                });
              }
            });
            newRecord.hypercites = updatedHypercites;
          }
          
          const putRequest = nodeChunksStore.put(newRecord);
          putRequest.onsuccess = () => {
            nodeChunksStore.delete(oldKey);
            console.log(`Normalized record from ID ${record.oldId} to ${nodeId}`);
            
            // Update hyperlights store
            updateHyperlightsStore(hyperlightsStore, bookId, hyperlightsToUpdate);
            
            // Update hypercites store
            updateHypercitesStore(hypercitesStore, bookId, hypercitesToUpdate);
          };
        } else {
          console.log(`No record found with ID ${record.oldId} for normalization`);
          const newRecord = {
            book: bookId,
            startLine: numericNodeId, // Store as numeric value
            chunk_id: parseNodeId(baseNumber), // Parse to numeric value
            content: processedContent ? processedContent.content : record.html,
            hyperlights: processedContent ? processedContent.hyperlights : [],
            hypercites: processedContent ? processedContent.hypercites : []
          };
          
          // Add all hyperlights and hypercites to update lists
          if (processedContent) {
            processedContent.hyperlights.forEach(hyperlight => {
              hyperlightsToUpdate.push({
                id: hyperlight.highlightID,
                startChar: hyperlight.charStart,
                endChar: hyperlight.charEnd,
                startLine: numericNodeId, // Use numeric value
                highlightedText: hyperlight.highlightedText,
                highlightedHTML: hyperlight.highlightedHTML
              });
            });
            
            processedContent.hypercites.forEach(hypercite => {
              hypercitesToUpdate.push({
                id: hypercite.hyperciteId,
                startChar: hypercite.charStart,
                endChar: hypercite.charEnd,
                hypercitedText: hypercite.hypercitedText,
                hypercitedHTML: hypercite.hypercitedHTML
              });
            });
          }
          
          const putRequest = nodeChunksStore.put(newRecord);
          putRequest.onsuccess = () => {
            console.log(`Created new record for normalized node ${nodeId}`);
            
            // Update hyperlights store
            updateHyperlightsStore(hyperlightsStore, bookId, hyperlightsToUpdate);
            
            // Update hypercites store
            updateHypercitesStore(hypercitesStore, bookId, hypercitesToUpdate);
          };
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

// Function to update IndexedDB when normalizing IDs
export async function updateIndexedDBRecordForNormalization(oldId, newId, html) {
  console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);
  try {
    // First, add the new record
    await updateIndexedDBRecord({
      id: newId,
      html: html,
      action: "add" // Use "add" instead of "normalize" if your updateIndexedDBRecord doesn't handle "normalize"
    });
    
    // Then, after ensuring the new record is added, delete the old one
    await deleteIndexedDBRecord(oldId);
    
    console.log(`Successfully normalized record: ${oldId} -> ${newId}`);
    return true;
  } catch (error) {
    console.error(`Error normalizing record ${oldId} -> ${newId}:`, error);
    return false;
  }
}


// Helper function to update hyperlights store
function updateHyperlightsStore(store, bookId, hyperlightsToUpdate) {
  if (!hyperlightsToUpdate.length) return;
  
  hyperlightsToUpdate.forEach(hyperlight => {
    const key = [bookId, hyperlight.id];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      if (existingRecord) {
        // Update only the position fields and text content
        const updatedRecord = {
          ...existingRecord,
          startChar: hyperlight.startChar,
          endChar: hyperlight.endChar,
          startLine: hyperlight.startLine
        };
        
        // Only update text content if it's provided
        if (hyperlight.highlightedText) {
          updatedRecord.highlightedText = hyperlight.highlightedText;
        }
        if (hyperlight.highlightedHTML) {
          updatedRecord.highlightedHTML = hyperlight.highlightedHTML;
        }
        
        store.put(updatedRecord);
        console.log(`Updated hyperlight record for ID: ${hyperlight.id}`);
      } else {
        // Create a new record if it doesn't exist
        const newRecord = {
          book: bookId,
          hyperlight_id: hyperlight.id,
          startChar: hyperlight.startChar,
          endChar: hyperlight.endChar,
          startLine: hyperlight.startLine,
          highlightedText: hyperlight.highlightedText || "",
          highlightedHTML: hyperlight.highlightedHTML || "",
          annotation: ""
        };
        
        store.put(newRecord);
        console.log(`Created new hyperlight record for ID: ${hyperlight.id}`);
      }
    };
  });
}

// Helper function to update hypercites store
function updateHypercitesStore(store, bookId, hypercitesToUpdate) {
  if (!hypercitesToUpdate.length) return;
  
  hypercitesToUpdate.forEach(hypercite => {
    const key = [bookId, hypercite.id];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      if (existingRecord) {
        // Update only the position fields and text content
        const updatedRecord = {
          ...existingRecord,
          startChar: hypercite.startChar,
          endChar: hypercite.endChar
        };
        
        // Only update text content if it's provided
        if (hypercite.hypercitedText) {
          updatedRecord.hypercitedText = hypercite.hypercitedText;
        }
        if (hypercite.hypercitedHTML) {
          updatedRecord.hypercitedHTML = hypercite.hypercitedHTML;
        }
        
        store.put(updatedRecord);
        console.log(`Updated hypercite record for ID: ${hypercite.id}`);
      } else {
        // Create a new record if it doesn't exist
        const newRecord = {
          book: bookId,
          hyperciteId: hypercite.id,
          startChar: hypercite.startChar,
          endChar: hypercite.endChar,
          hypercitedText: hypercite.hypercitedText || "",
          hypercitedHTML: hypercite.hypercitedHTML || "",
          citedIN: [],
          relationshipStatus: "single"
        };
        
        store.put(newRecord);
        console.log(`Created new hypercite record for ID: ${hypercite.id}`);
      }
    };
  });
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
    

    // Create the proper key for deletion
  const key = createNodeChunksKey(bookId, id);
  console.log("Deleting with key:", key);


  const deleteRequest = store.delete(key);
    
    
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



// Helper function to update a specific nodeChunk in IndexedDB
async function updateNodeChunkInIndexedDB(book, startLine, updatedRecord) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    console.log(`Attempting to update nodeChunk: book=${book}, startLine=${startLine}`);
    console.log("startLine type:", typeof startLine, "value:", startLine);
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(false);
    };
    
    request.onsuccess = async (event) => {
      const db = event.target.result;
      
      try {
        // First try to find the record using various formats
        const transaction = db.transaction([storeName], "readonly");
        const objectStore = transaction.objectStore("nodeChunks");
        const index = objectStore.index("book");
        
        // Get all records for this book
        const bookRecords = await new Promise((resolve) => {
          const request = index.getAll(book);
          request.onsuccess = () => resolve(request.result);
        });
        
        console.log(`Found ${bookRecords.length} records for book ${book}`);
        
        // Try different formats of startLine
        const possibleStartLines = [
          startLine,                                  // Original
          typeof startLine === 'string' ? parseFloat(startLine) : startLine,  // As float
          typeof startLine === 'string' ? parseInt(startLine, 10) : startLine, // As int
          String(startLine)                           // As string
        ];
        
        let matchingRecord = null;
        for (const record of bookRecords) {
          if (possibleStartLines.includes(record.startLine)) {
            matchingRecord = record;
            console.log(`Found matching record with startLine=${record.startLine}`);
            break;
          }
        }
        
        await transaction.complete;
        
        if (!matchingRecord) {
          console.error(`No matching record found for startLine=${startLine} in book ${book}`);
          console.log("Available startLines:", bookRecords.map(r => r.startLine));
          resolve(false);
          return;
        }
        
        // Now update the record
        const writeTx = db.transaction([storeName], "readwrite");
        const writeStore = writeTx.objectStore(storeName);
        
        // Create the key using the exact format from the matching record
        const key = [book, matchingRecord.startLine];
        console.log("Using key for update:", key);
        
        // Update the hypercites array
        if (updatedRecord.hypercites) {
          matchingRecord.hypercites = updatedRecord.hypercites;
        }
        
        // Put the updated record back
        const updateRequest = writeStore.put(matchingRecord);
        
        updateRequest.onsuccess = () => {
          console.log(`Successfully updated record for key:`, key);
          resolve(true);
        };
        
        updateRequest.onerror = (event) => {
          console.error(`Error updating record:`, event.target.error);
          resolve(false);
        };
        
        writeTx.oncomplete = () => {
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

// Modified function to update both nodeChunks and hypercites
export async function updateCitationForExistingHypercite(
  booka,
  hyperciteIDa,
  citationIDb,
  insertContent = true // Default to true for backward compatibility
) {
  // Only insert content if explicitly requested
  /* if (insertContent) {
    const clipboardHtml = event.clipboardData.getData("text/html");
    if (clipboardHtml) {
      document.execCommand("insertHTML", false, clipboardHtml);
    } else {
      const clipboardText = event.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, clipboardText);
    }
  } */

  try {
    console.log(
      `Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`
    );

    // Check if this is an internal paste (same book)
    const isInternalPaste = booka === book;

    // Retrieve nodeChunks for booka.
    const nodeChunks = await getNodeChunksFromIndexedDB(booka);
    if (!nodeChunks || nodeChunks.length === 0) {
      console.warn(`No nodeChunks found for book ${booka}`);
      return false;
    }

    let foundAndUpdated = false;
    let updatedRelationshipStatus = "single";

    // Search through all nodeChunks for the matching hypercite.
    for (let i = 0; i < nodeChunks.length; i++) {
      const record = nodeChunks[i];
      if (!record.hypercites || !Array.isArray(record.hypercites)) continue;

      // Find the index of the hypercite with a matching ID.
      const hyperciteIndex = record.hypercites.findIndex(
        (hc) => hc.hyperciteId === hyperciteIDa
      );

      if (hyperciteIndex !== -1) {
        const startLine = record.startLine;
        console.log(
          `Found matching hypercite in record with startLine=${startLine}`
        );

        // Get a reference to the hypercite.
        const hypercite = record.hypercites[hyperciteIndex];

        // Initialize the citedIN array if it doesn't exist.
        if (!hypercite.citedIN) {
          hypercite.citedIN = [];
        }

        // Add the citation if it isn't already present.
        if (!hypercite.citedIN.includes(citationIDb)) {
          hypercite.citedIN.push(citationIDb);
          console.log(`Added citation ${citationIDb} to hypercite`);
        } else {
          console.log(`Citation ${citationIDb} already exists in hypercite`);
        }

        // Update relationshipStatus based on the count of citations.
        if (hypercite.citedIN.length === 1) {
          // First citation: update to "couple".
          hypercite.relationshipStatus = "couple";
        } else if (hypercite.citedIN.length >= 2) {
          // Two or more citations: update to "poly".
          hypercite.relationshipStatus = "poly";
        }
        
        updatedRelationshipStatus = hypercite.relationshipStatus;

        // Update the record in IndexedDB using the composite key.
        const success = await updateNodeChunkInIndexedDB(
          booka,
          startLine,
          record
        );
        
        if (success) {
          console.log(
            `Successfully updated nodeChunk with startLine=${startLine} in book ${booka}`
          );
          foundAndUpdated = true;
          broadcastToOpenTabs(booka, startLine);
          
          // Update the DOM to reflect the new relationship status for internal pastes
          if (isInternalPaste) {
            const originalUnderline = document.getElementById(hyperciteIDa);
            if (originalUnderline) {
              originalUnderline.className = updatedRelationshipStatus;
              console.log(`Updated original underline class to ${updatedRelationshipStatus}`);
            }
          }
        } else {
          console.error(
            `Failed to update nodeChunk with startLine=${startLine} in book ${booka}`
          );
        }
      }
    }

    // Now update the corresponding hypercite in the hypercites object store
    if (foundAndUpdated) {
      // Prepare the fields to update in the hypercites store
      const hyperciteUpdates = {
        relationshipStatus: updatedRelationshipStatus
      };
      
      // Get the existing hypercite to update its citedIN array
      const hyperciteRecord = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
      
      if (hyperciteRecord) {
        // Initialize citedIN array if it doesn't exist
        if (!hyperciteRecord.citedIN) {
          hyperciteRecord.citedIN = [];
        }
        
        // Add the citation if it isn't already present
        if (!hyperciteRecord.citedIN.includes(citationIDb)) {
          hyperciteRecord.citedIN.push(citationIDb);
        }
        
        hyperciteUpdates.citedIN = hyperciteRecord.citedIN;
        
        // Update the hypercite in IndexedDB
        const hyperciteSuccess = await updateHyperciteInIndexedDB(
          booka,
          hyperciteIDa,
          hyperciteUpdates
        );
        
        if (hyperciteSuccess) {
          console.log(`Successfully updated hypercite ${hyperciteIDa} in book ${booka}`);
          return true;
        } else {
          console.error(`Failed to update hypercite ${hyperciteIDa} in book ${booka}`);
          return false;
        }
      } else {
        console.error(`Hypercite ${hyperciteIDa} not found in book ${booka}`);
        return false;
      }
    }

    console.log(
      `No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`
    );
    return false;
  } catch (error) {
    console.error("Error updating citation:", error);
    return false;
  }
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


