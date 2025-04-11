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
          keyPath: ["book", "hyperciteId"],
          indices: ["hyperciteId"]
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
    const nodeChunksStore = tx.objectStore("nodeChunks");
    const hyperlightsStore = tx.objectStore("hyperlights");
    const hypercitesStore = tx.objectStore("hypercites");
    
    const newStartLine = parseFloat(nodeId);
    const baseNumber = parseFloat(nodeId.match(/^(\d+)/)[1]);
    
    // Track which hyperlights and hypercites need updating
    let hyperlightsToUpdate = [];
    let hypercitesToUpdate = [];
    
    if (record.action !== "normalize") {
      const baseKey = [bookId, baseNumber];
      const baseRequest = nodeChunksStore.get(baseKey);
      
      baseRequest.onsuccess = () => {
        let inheritedChunkId = null;
        const baseRecord = baseRequest.result;
        if (baseRecord && baseRecord.chunk_id !== undefined) {
          inheritedChunkId = baseRecord.chunk_id;
        } else {
          inheritedChunkId = 0;
        }
        
        const getRequest = nodeChunksStore.get([bookId, newStartLine]);
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
                    startLine: newStartLine,
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
                    startLine: newStartLine,
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
              startLine: newStartLine,
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
                  startLine: newStartLine,
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
      const oldKey = [bookId, parseFloat(record.oldId)];
      const getRequest = nodeChunksStore.get(oldKey);
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
                
                // Add to list of hyperlights that need updating
                hyperlightsToUpdate.push({
                  id: newHyperlight.highlightID,
                  startChar: newHyperlight.charStart,
                  endChar: newHyperlight.charEnd,
                  startLine: newStartLine,
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
                  startLine: newStartLine,
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
            startLine: newStartLine,
            chunk_id: parseInt(baseNumber, 10),
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
                startLine: newStartLine,
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

