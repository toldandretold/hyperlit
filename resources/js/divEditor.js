import { book } from "./app.js";
import { updateIndexedDBRecord, deleteIndexedDBRecord, getNodeChunksFromIndexedDB } from "./cache-indexedDB.js";
import { showSpinner, showTick } from "./editIndicator.js";
import { openDatabase } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";

// Global observer variable
let observer;

// Global variable to track the currently observed chunk.
let currentObservedChunk = null;

// Tracking sets
const modifiedNodes = new Set(); // Track element IDs whose content was modified.
const addedNodes = new Set(); // Track newly-added element nodes.
const removedNodeIds = new Set(); // Track IDs of removed nodes.

// Track document changes for debounced normalization
let documentChanged = false;
let isTyping = false;
let typingTimer;

// ----------------------------------------------------------------
// Debounce function for delayed operations
// ----------------------------------------------------------------
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

function observeEditableDiv(editableDiv) {
  const originalContent = new Map();
  editableDiv.querySelectorAll("[id]").forEach((node) => {
    originalContent.set(node.id, node.innerHTML);
  });

  const observer = new MutationObserver((mutations) => {
    // Indicate that saving/processing is starting.
    showSpinner();
    documentChanged = true;

    mutations.forEach((mutation) => {
      // Process additions/removals first.
      if (mutation.type === "childList") {
        // Process newly added nodes
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (window.__enterKeyInfo) {
              const { nodeId, cursorPosition } = window.__enterKeyInfo;
              const referenceNode = document.getElementById(nodeId);
              if (referenceNode) {
                if (cursorPosition === "start") {
                  const parent = referenceNode.parentElement;
                  if (parent) {
                    const siblings = Array.from(parent.children);
                    const refIndex = siblings.indexOf(referenceNode);
                    if (refIndex > 0) {
                      const nodeAbove = siblings[refIndex - 1];
                      if (nodeAbove.id) {
                        const baseMatch = nodeAbove.id.match(/^(\d+)/);
                        if (baseMatch) {
                          const baseId = baseMatch[1];
                          node.id = getNextDecimalForBase(baseId);
                          console.log(
                            `Cursor at start: New node gets ID ${node.id} based on node above (${nodeAbove.id})`
                          );
                        } else {
                          node.id = generateUniqueId();
                          console.log(
                            `Node above has non-numeric ID; assigned unique id ${node.id}`
                          );
                        }
                      } else {
                        node.id = generateUniqueId();
                        console.log(
                          `Node above has no ID; assigned unique id ${node.id}`
                        );
                      }
                    } else {
                      const baseMatch = referenceNode.id.match(/^(\d+)/);
                      if (baseMatch) {
                        const baseId = parseInt(baseMatch[1], 10);
                        const newBaseId = Math.max(1, baseId - 1).toString();
                        node.id = newBaseId;
                        console.log(
                          `No node above; new node gets ID ${node.id} (one less than reference ${referenceNode.id})`
                        );
                      } else {
                        node.id = generateUniqueId();
                        console.log(
                          `Reference node has non-numeric ID; assigned unique id ${node.id}`
                        );
                      }
                    }
                  } else {
                    node.id = generateUniqueId();
                    console.log(
                      `Reference node has no parent; assigned unique id ${node.id}`
                    );
                  }
                } else {
                  // For non-"start" positions.
                  const baseMatch = referenceNode.id.match(/^(\d+)/);
                  if (baseMatch) {
                    const baseId = baseMatch[1];
                    node.id = getNextDecimalForBase(baseId);
                    console.log(
                      `Cursor at ${cursorPosition}: New node gets ${node.id}, reference node stays ${referenceNode.id}`
                    );
                  } else {
                    node.id = generateUniqueId();
                    console.log(
                      `Reference node has non-numeric ID; assigned unique id ${node.id}`
                    );
                  }
                }
              } else {
                node.id = generateUniqueId();
                console.log(
                  `Reference node not found; assigned unique id ${node.id}`
                );
              }
              window.__enterKeyInfo = null;
            } else {
              node.id = generateUniqueId();
              console.log(
                `No Enter key info available; assigned unique id ${node.id}`
              );
            }
            addedNodes.add(node);
            // Save the new node to IndexedDB.
            // Wrap the call in Promise.resolve to support both synchronous and promise-based APIs.
            Promise.resolve(
              updateIndexedDBRecord({
                id: node.id,
                html: node.outerHTML,
                action: "add"
              })
            )
              .then(() => {
                // Show tick for each added node.
                showTick();
              })
              .catch((error) =>
                console.error("Error adding node to IndexedDB", error)
              );
          }
        });

        // Process removed nodes.
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.id) {
            removedNodeIds.add(node.id);
            deleteIndexedDBRecord(node.id);
            originalContent.delete(node.id);
          }
        });
      } else if (mutation.type === "characterData") {
        const parent = mutation.target.parentElement;
        if (parent && parent.id) {
          if (parent.innerHTML !== originalContent.get(parent.id)) {
            modifiedNodes.add(parent.id);
            originalContent.set(parent.id, parent.innerHTML);
            Promise.resolve(
              updateIndexedDBRecord({
                id: parent.id,
                html: parent.outerHTML,
                action: "update"
              })
            )
              .then(() => {
                // Show tick for an updated node.
                showTick();
              })
              .catch((error) =>
                console.error("Error updating node in IndexedDB", error)
              );
          }
        }
      }
    });

    console.log(
      "Added nodes:",
      Array.from(addedNodes).map((node) => node.id)
    );
    console.log("Modified nodes:", Array.from(modifiedNodes));
    console.log("Removed nodes:", Array.from(removedNodeIds));

    // Trigger the debounced normalization
    if (editableDiv) {
      debouncedNormalize(editableDiv);
    }
  });

  observer.observe(editableDiv, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

// ----------------------------------------------------------------
// Existing helper functions
// ----------------------------------------------------------------

// Utility: Generate a fallback unique ID if needed (used as a last resort).
function generateUniqueId() {
  return (
    "node_" +
    Date.now() +
    "_" +
    Math.random().toString(36).substr(2, 5)
  );
}

// Utility: Check if an id is duplicate within the document.
function isDuplicateId(id) {
  const elements = document.querySelectorAll(`#${CSS.escape(id)}`);
  return elements.length > 1;
}

// ----------------------------------------------------------------
// New helper: Given a numeric base (as a string), find the next available decimal suffix.
// For example:
//    If there is no node with an ID "17.x", return "17.1".
//    If nodes with IDs "17.1" and "17.2" exist, return "17.3" (formatted with one decimal).
// New helper: Given a numeric base (as a string), return the next available ID
// as a number with one decimal place. It will scan all elements whose ID, when parsed
// as a float, is between base and base+1. For example, if "17" exists (i.e. 17.0)
// and the highest duplicate is 17.2, it returns "17.3".
function getNextDecimalForBase(baseId) {
  const baseNumber = parseFloat(baseId);
  if (isNaN(baseNumber)) return baseId; // fallback

  const allNodes = Array.from(document.querySelectorAll("[id]"));

  // Start with the base number (i.e. 17.0) and look for duplicates in the range [17, 18)
  let maxVal = baseNumber; // if only "17" exists, think of it as 17.0
  for (const node of allNodes) {
    const parsed = parseFloat(node.id);
    // only consider IDs that parse as numbers in the range [baseNumber, baseNumber+1)
    if (!isNaN(parsed) && parsed >= baseNumber && parsed < baseNumber + 1) {
      if (parsed > maxVal) {
        maxVal = parsed;
      }
    }
  }
  // Increment by 0.1 using one decimal precision
  const nextVal = (maxVal + 0.1).toFixed(1);
  return nextVal;
}


// ----------------------------------------------------------------
// New helper for generating an ID when inserting a new node with decimal logic.
// This replaces the previous letter‐based suffix. For a reference node with id "17",
// inserting after will yield "17.1".
function generateInsertedNodeId(referenceNode, insertAfter = true) {
  if (!referenceNode || !referenceNode.id) {
    return generateUniqueId();
  }
  // Extract the numeric base from the reference node id.
  const baseMatch = referenceNode.id.match(/^(\d+)/);
  if (!baseMatch) {
    return generateUniqueId();
  }
  const baseId = baseMatch[1];
  if (insertAfter) {
    return getNextDecimalForBase(baseId);
  } else {
    // For inserting before, try to derive from the previous sibling.
    const parent = referenceNode.parentElement;
    if (!parent) return generateUniqueId();
    const siblings = Array.from(parent.children);
    const pos = siblings.indexOf(referenceNode);
    if (pos > 0) {
      const prevSibling = siblings[pos - 1];
      if (prevSibling.id) {
        const prevMatch = prevSibling.id.match(/^(\d+)/);
        if (prevMatch) {
          const prevBase = prevMatch[1];
          return getNextDecimalForBase(prevBase);
        }
      }
    }
    return `${baseId}.1`;
  }
}

// ----------------------------------------------------------------
// Normalization function to ensure IDs are in ascending order 
// using decimal increments for nodes sharing the same base.
async function normalizeNodeIds(container) {
  console.log("Starting node ID normalization...");

  // Filter nodes where id is a number with an optional decimal.
  const nodes = Array.from(container.querySelectorAll("[id]")).filter(
    (el) => /^(\d+)(\.\d+)?$/.test(el.id)
  );

  // Sort nodes by their interaction order in the DOM.
  nodes.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // Check if normalization is needed by comparing sorted order.
  let needsNormalization = false;
  for (let i = 0; i < nodes.length - 1; i++) {
    const currentId = parseFloat(nodes[i].id);
    const nextId = parseFloat(nodes[i + 1].id);
    // If the current numeric value is greater than the next,
    // something is off.
    if (currentId > nextId) {
      needsNormalization = true;
      console.log(
        `Found out-of-order IDs: ${nodes[i].id} comes before ${nodes[i + 1].id} in DOM`
      );
      break;
    }
  }

  if (!needsNormalization) {
    console.log("IDs are already in correct order, skipping normalization");
    return false;
  }

  // Group nodes by numeric base (the integer part)
  const baseGroups = {};
  nodes.forEach((node) => {
    const match = node.id.match(/^(\d+)/);
    if (match) {
      const base = match[1];
      if (!baseGroups[base]) {
        baseGroups[base] = [];
      }
      baseGroups[base].push(node);
    }
  });

  // Build a mapping from old ids to new ids.
  // For each group, we assign the first node the id equal to base,
  // and then subsequent nodes get base.1, base.2, etc.
  const idMap = {};
  Object.keys(baseGroups).forEach((base) => {
    const group = baseGroups[base];
    // You may choose to sort the group again by DOM position if needed.
    group.forEach((node, index) => {
      // By default, the first node remains as the base.
      // Subsequent nodes get a new id with decimal increments.
      const newId = index === 0 ? base : `${base}.${index}`;
      if (node.id !== newId) {
        idMap[node.id] = newId;
      }
    });
  });

  // Now apply the new IDs and update IndexedDB.
  let changesCount = 0;
  const changes = [];
  for (const [oldId, newId] of Object.entries(idMap)) {
    // Look up the node from the old id.
    const node = document.getElementById(oldId);
    if (node && oldId !== newId) {
      changes.push({ node, oldId, newId });
    }
  }

  for (const { node, oldId, newId } of changes) {
    console.log(`Normalizing: Changing node ID from ${oldId} to ${newId}`);
    node.id = newId;
    changesCount++;
    await updateIndexedDBRecordForNormalization(oldId, newId, node.outerHTML);
  }

  console.log(
    `Normalized node IDs in container. Made ${changesCount} changes.`
  );
  return changesCount > 0;
}


// ----------------------------------------------------------------
// Function to update IndexedDB when normalizing IDs
async function updateIndexedDBRecordForNormalization(oldId, newId, html) {
  console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);
  try {
    await updateIndexedDBRecord({
      id: newId,
      oldId: oldId,
      html: html,
      action: "normalize"
    });
    await deleteIndexedDBRecord(oldId);
    console.log(`Successfully normalized record: ${oldId} -> ${newId}`);
  } catch (error) {
    console.error(`Error normalizing record ${oldId} -> ${newId}:`, error);
  }
}


// Debounced normalization function for editable div, including saving cues
const debouncedNormalize = debounce(async (container) => {
  if (documentChanged && !isTyping) {
    console.log("User stopped typing; normalizing and saving...");
    // show spinner at the beginning of save process
    showSpinner();
    const changes = await normalizeNodeIds(container);
    // Optionally, update IndexedDB for any change outside of normalization
    if (changes) {
      console.log("Normalization complete with changes");
    } else {
      console.log("Normalization complete - no changes needed");
    }
    // After save is complete, show tick:
    showTick();
    documentChanged = false;
  }
}, 1000); // 1 second delay


// ----------------------------------------------------------------
// Track typing activity
// ----------------------------------------------------------------
// Track typing activity
document.addEventListener("keydown", () => {
  // Only show spinner if in edit mode
  if (!window.isEditing) return;
  
  // Immediately show the spinner when a key is pressed.
  showSpinner();
  isTyping = true;
  documentChanged = true;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    if (currentObservedChunk) {
      debouncedNormalize(currentObservedChunk);
    }
  }, 500);
});



// ----------------------------------------------------------------
// Track cursor position when Enter is pressed
// ----------------------------------------------------------------
document.addEventListener("keydown", function(event) {
  if (event.key === "Enter") {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let currentNode = range.startContainer;
      if (currentNode.nodeType !== Node.ELEMENT_NODE) {
        currentNode = currentNode.parentElement;
      }
      while (currentNode && (!currentNode.id || 
             !['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI'].includes(currentNode.tagName))) {
        currentNode = currentNode.parentElement;
      }
      if (currentNode && currentNode.id) {
        let cursorPosition = "middle";
        if (range.startOffset === 0) {
          cursorPosition = "start";
        } else if (range.startContainer.nodeType === Node.TEXT_NODE && 
                  range.startOffset === range.startContainer.length) {
          cursorPosition = "end";
        }
        window.__enterKeyInfo = {
          nodeId: currentNode.id,
          cursorPosition: cursorPosition,
          timestamp: Date.now()
        };
        console.log("Enter pressed in node:", currentNode.id, "at position:", cursorPosition);
      }
    }
  }
});

// ----------------------------------------------------------------
// Replace original ensureNodeHasValidId with enhanced version using decimal logic.
function ensureNodeHasValidId(node, options = {}) {
  const { referenceNode, insertAfter } = options;
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  
  if (window.__enterKeyInfo && Date.now() - window.__enterKeyInfo.timestamp < 500) {
    const { nodeId, cursorPosition } = window.__enterKeyInfo;
    const referenceNode = document.getElementById(nodeId);
    if (referenceNode) {
      if (cursorPosition === "start") {
        const parent = referenceNode.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const refIndex = siblings.indexOf(referenceNode);
          if (refIndex > 0) {
            const nodeAbove = siblings[refIndex - 1];
            if (nodeAbove.id) {
              const baseMatch = nodeAbove.id.match(/^(\d+)/);
              if (baseMatch) {
                const baseId = baseMatch[1];
                node.id = getNextDecimalForBase(baseId);
                console.log(`Cursor at start: New node gets ID ${node.id} based on node above (${nodeAbove.id})`);
                window.__enterKeyInfo = null;
                return;
              }
            }
          } else {
            const baseMatch = referenceNode.id.match(/^(\d+)/);
            if (baseMatch) {
              const baseId = parseInt(baseMatch[1], 10);
              const newBaseId = Math.max(1, baseId - 1).toString();
              node.id = newBaseId;
              console.log(`No node above; new node gets ID ${node.id} (one less than reference ${referenceNode.id})`);
              window.__enterKeyInfo = null;
              return;
            }
          }
        }
      } else {
        const baseMatch = referenceNode.id.match(/^(\d+)/);
        if (baseMatch) {
          const baseId = baseMatch[1];
          node.id = getNextDecimalForBase(baseId);
          console.log(`Cursor at ${cursorPosition}: New node gets ${node.id}, reference node stays ${referenceNode.id}`);
          window.__enterKeyInfo = null;
          return;
        }
      }
    }
    window.__enterKeyInfo = null;
  }
  
  // If node already has an id, check for duplicates:
  if (node.id) {
    if (isDuplicateId(node.id)) {
      const match = node.id.match(/^(\d+)(\.\d+)?$/);
      if (match) {
        const baseId = match[1];
        const newId = getNextDecimalForBase(baseId);
        console.log(`ID conflict detected. Changing node id from ${node.id} to ${newId}`);
        node.id = newId;
      } else {
        const oldId = node.id;
        node.id = generateUniqueId();
        console.log(`ID conflict detected (non-numeric). Changing node id from ${oldId} to ${node.id}`);
      }
    }
  } else {
    if (referenceNode && typeof insertAfter === "boolean") {
      node.id = generateInsertedNodeId(referenceNode, insertAfter);
      console.log(`Assigned new id ${node.id} based on reference insertion direction.`);
    } else {
      node.id = generateUniqueId();
      console.log(`Assigned new unique id ${node.id} to node <${node.tagName.toLowerCase()}>`);
    }
  }
  
  documentChanged = true;
}



// ----------------------------------------------------------------
// Utility: Get the chunk element where the cursor is currently located.
function getCurrentChunk() {
  const selection = document.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }
    return node.closest(".chunk");
  }
  return null;
}

// Start observing only inside the current chunk container.
export function startObserving(editableDiv) {
  console.log("🤓 startObserving function called");

  // Stop any existing observer first
  stopObserving();
  
  const currentChunk = editableDiv || getCurrentChunk();
  if (!currentChunk) {
    console.warn("No active chunk found; observer not attached.");
    return;
  }
  currentObservedChunk = currentChunk;
  console.log("Observing changes in chunk:", currentChunk);

    observer = new MutationObserver((mutations) => {
  showSpinner();
  documentChanged = true;

  mutations.forEach((mutation) => {
    // 1) Title‑sync logic for H1#1
    const h1 = document.getElementById("1");
    if (h1) {
      // characterData inside H1
      if (
        mutation.type === "characterData" &&
        mutation.target.parentNode?.closest('h1[id="1"]')
      ) {
        const newTitle = h1.innerText.trim();
        updateLibraryTitle(book, newTitle).catch(console.error);
        // also update the H1 node in nodeChunks
        updateIndexedDBRecord({
          id: h1.id,
          html: h1.outerHTML,
          action: "update"
        }).catch(console.error);
      }
      // childList under H1 (e.g. paste)
      if (
        mutation.type === "childList" &&
        Array.from(mutation.addedNodes).some((n) =>
          n.closest && n.closest('h1[id="1"]')
        )
      ) {
        const newTitle = h1.innerText.trim();
        updateLibraryTitle(book, newTitle).catch(console.error);
        updateIndexedDBRecord({
          id: h1.id,
          html: h1.outerHTML,
          action: "update"
        }).catch(console.error);
      }
    }

    // 2) Original logic: additions
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // generate ID etc...
          ensureNodeHasValidId(node);
          updateIndexedDBRecord({
            id: node.id,
            html: node.outerHTML,
            action: "add"
          }).catch(console.error);
          addedNodes.add(node);
        }
      });
      // deletions
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.id) {
          deleteIndexedDBRecord(node.id);
          removedNodeIds.add(node.id);
        }
      });
    }
    // 3) Original logic: characterData updates
    else if (mutation.type === "characterData") {
      const parent = mutation.target.parentNode;
      if (parent && parent.id) {
        updateIndexedDBRecord({
          id: parent.id,
          html: parent.outerHTML,
          action: "update"
        }).catch(console.error);
        modifiedNodes.add(parent.id);
      }
    }
  });

  debouncedNormalize(currentObservedChunk);
});


  observer.observe(currentChunk, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  console.log("Observer started in chunk:", currentChunk);
  
  setTimeout(() => {
    normalizeNodeIds(currentChunk);
  }, 1000);
}


// Function to stop the MutationObserver.
export function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
    console.log("Observer disconnected");
  }
  
  // Reset all state variables
  currentObservedChunk = null;
  modifiedNodes.clear();
  addedNodes.clear();
  removedNodeIds.clear();
  documentChanged = false;
  isTyping = false;
  clearTimeout(typingTimer);
  
  // Remove any lingering spinner
  const existingSpinner = document.getElementById("status-icon");
  if (existingSpinner) {
    existingSpinner.remove();
    console.log("Removed lingering spinner");
  }
  
  console.log("Observer and related state fully reset");
}


// Listen for selection changes and restart observing if the current chunk has changed.
document.addEventListener("selectionchange", () => {
  // Only perform chunk-observer restarts in edit mode.
  if (!window.isEditing) return;

  const newChunk = getCurrentChunk();
  if (newChunk !== currentObservedChunk) {
    console.log("Chunk change detected. Restarting observer...");
    stopObserving();
    if (newChunk) {
      startObserving(newChunk);
    } else {
      currentObservedChunk = null;
      console.warn("Lost focus on any chunk.");
    }
  }
});



//PASTED Hypercite:

// === Pasted Hypercite Handling Code ===

// Helper: Generate a new hypercite ID for the pasted instance
function generateNewHyperciteID() {
  return "hypercite_" + Math.random().toString(36).substr(2, 9);
}

// Helper: Parse HTML string to DOM element
function parseHtml(htmlString) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = htmlString;
  return wrapper;
}




// Helper function to update a specific nodeChunk in IndexedDB
async function updateNodeChunkInIndexedDB(book, startLine, updatedRecord) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB"; // Correct database name
    const storeName = "nodeChunks"; // Correct object store name
    
    console.log(`Updating in DB: ${dbName}, store: ${storeName}, key: [${book}, ${startLine}]`);
    
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
        
        // Create the composite key [book, startLine]
        const key = [book, parseInt(startLine, 10)];
        
        // Get the record using the composite key
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;
          
          if (!existingRecord) {
            console.error(`Record not found for key: [${book}, ${startLine}]`);
            resolve(false);
            return;
          }
          
          console.log("Found existing record:", existingRecord);
          
          // Update the hypercites array in the existing record
          if (updatedRecord.hypercites) {
            existingRecord.hypercites = updatedRecord.hypercites;
          }
          
          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);
          
          updateRequest.onsuccess = () => {
            console.log(`Successfully updated record for key: [${book}, ${startLine}]`);
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


// Update the nodeChunks record to track citation and relationship
// Helper function to update a specific hypercite in IndexedDB
async function updateHyperciteInIndexedDB(book, hyperciteId, updatedFields) {
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
async function updateCitationForExistingHypercite(
  booka,
  hyperciteIDa,
  citationIDb
) {
  event.preventDefault();

  // Retrieve the HTML from the clipboard.
  const clipboardHtml = event.clipboardData.getData("text/html");

  if (clipboardHtml) {
    // Insert the HTML directly into the contenteditable element.
    document.execCommand("insertHTML", false, clipboardHtml);
  } else {
    // Fallback: if no HTML data is available, fallback to plain text.
    const clipboardText = event.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, clipboardText);
  }

  try {
    console.log(
      `Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`
    );

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

// Helper function to get a hypercite from IndexedDB
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


function broadcastToOpenTabs(booka, startLine) {
  const channel = new BroadcastChannel("node-updates");
  console.log(
    `Broadcasting update: book=${booka}, startLine=${startLine}`
  );
  channel.postMessage({
    book: booka,
    startLine,
  });
}




// Helper: Parse hypercite URL to extract components
function parseHyperciteHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    const booka = url.pathname.replace(/^\//, ""); // e.g., "booka"
    const hyperciteIDa = url.hash.substr(1);       // e.g., "hyperciteIda"
    const citationIDa = `/${booka}#${hyperciteIDa}`; // e.g., "/booka#hyperciteIda"
    return { citationIDa, hyperciteIDa, booka };
  } catch (error) {
    console.error("Error parsing hypercite href:", href, error);
    return null;
  }
}



// Add paste event listener to handle hypercites
export function addPasteListener(editableDiv) {
  console.log("Adding paste listener for hypercite updates");
  
  editableDiv.addEventListener("paste", async (event) => {
    const clipboardHtml = event.clipboardData.getData("text/html");
    if (!clipboardHtml) return;
    
    // Parse clipboard HTML
    const pasteWrapper = document.createElement("div");
    pasteWrapper.innerHTML = clipboardHtml;
    const citeLink = pasteWrapper.querySelector("a");
    
    // Check if this is a hypercite link
    if (citeLink && citeLink.innerText.trim() === "[:]") {
      console.log("Detected a hypercite in pasted content");
      
      const originalHref = citeLink.getAttribute("href");
      const parsed = parseHyperciteHref(originalHref);
      if (!parsed) return;
      
      const { booka, hyperciteIDa, citationIDa } = parsed;
      console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });
      
      // Generate new hypercite ID for this instance
      const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
      
      // Get current book (where paste is happening)
      const bookb = book; // Assuming 'book' is a global variable
      
      // Create the citation ID for this new instance
      const citationIDb = `/${bookb}#${hyperciteIDb}`;
      
      // Assign ID to the pasted link (don't change href)
      citeLink.id = hyperciteIDb;
      
      // Update the original hypercite's citedIN array
      const updated = await updateCitationForExistingHypercite(
        booka, 
        hyperciteIDa, 
        citationIDb
      );
      
      if (updated) {
        console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
      } else {
        console.warn(`Failed to update citation for ${citationIDa}`);
      }
    }
  });
}



/**
 * Ensure there's a library record for this book. If it doesn't exist,
 * create a minimal one (you can expand this with author/timestamp/bibtex).
 */
/** Ensure there’s a library record for this book (or create a stub). */
async function ensureLibraryRecord(bookId) {
  const db = await openDatabase();

  // FIRST: read‑only to check existence
  {
    const tx = db.transaction("library", "readonly");
    const store = tx.objectStore("library");
    const rec = await new Promise((res, rej) => {
      const req = store.get(bookId);
      req.onsuccess  = () => res(req.result);
      req.onerror    = () => rej(req.error);
    });
    await tx.complete;  // make sure the readonly tx closes
    if (rec) {
      return rec;      // already there—no open tx left dangling
    }
  }

  // SECOND: read‑write to create
  {
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const newRec = {
      citationID: bookId,
      title: "",
      author: localStorage.getItem("authorId") || "anon",
      type: "book",
      timestamp: new Date().toISOString(),
    };
    store.put(newRec);
    await tx.complete;
    return newRec;
  }
}



/** Update only the title field (and regenerate bibtex) in the library record. */
export async function updateLibraryTitle(bookId, newTitle) {
  const db = await openDatabase();
  const tx = db.transaction("library", "readwrite");
  const store = tx.objectStore("library");

  return new Promise((resolve, reject) => {
    const req = store.get(bookId);
    req.onsuccess = (e) => {
      const rec = e.target.result;
      if (!rec) return reject(new Error("Library record missing"));

      // 1) Update title
      rec.title = newTitle;

      // 2) Regenerate the bibtex string so it stays in sync
      rec.bibtex = buildBibtexEntry(rec);

      // 3) Write back the record
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror   = (e) => reject(e.target.error);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}


/** Simple debounce helper */
function debounce(fn, wait = 500) {
  let tid;
  return (...args) => {
    clearTimeout(tid);
    tid = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Call this in edit mode to:
 *   1) make sure library[bookId] exists
 *   2) watch <h1 id="1"> inside the div#bookId
 *   3) sync its text into library.title
 */
export async function initTitleSync(bookId) {
  console.log("⏱ initTitleSync()", { bookId });
  const editableContainer = document.getElementById(bookId);
  if (!editableContainer) {
    console.warn(`initTitleSync: no div#${bookId}`);
    return;
  }

  await ensureLibraryRecord(bookId);

  const titleNode = editableContainer.querySelector('h1[id="1"]');
  if (!titleNode) {
    console.warn("initTitleSync: no <h1 id=\"1\"> found");
    return;
  }
  console.log("initTitleSync: found titleNode", titleNode);

  // Debounced writer, with logging
  const writeTitle = debounce(async () => {
    const newTitle = titleNode.innerText.trim();
    console.log("🖉 [title-sync] writeTitle firing, newTitle=", newTitle);
    try {
      await updateLibraryTitle(bookId, newTitle);
      console.log("✔ [title-sync] updated library.title=", newTitle);
    } catch (err) {
      console.error("✖ [title-sync] failed to update:", err);
    }
  }, 500);

  // direct listener on the h1
  titleNode.addEventListener("input", (e) => {
    console.log("🖉 [title-sync] input event on H1", e);
    writeTitle();
  });

  // fallback: capture any input in the container and see if it's the H1
  editableContainer.addEventListener("input", (e) => {
    if (e.target === titleNode || titleNode.contains(e.target)) {
      console.log("🖉 [title-sync] container catch of input on H1", e);
      writeTitle();
    }
  });

  // also observe mutations just in case execCommand or paste bypasses input
    new MutationObserver((muts) => {
    muts.forEach((m) => {
      if (m.type === "characterData") {
        // m.target could be a Text node
        const parent = m.target.parentNode;
        if (
          parent &&
          parent.nodeType === Node.ELEMENT_NODE &&
          parent.closest('h1[id="1"]')
        ) {
          console.log("🖉 [title-sync] mutation detect", m);
          writeTitle();
        }
      }
    });
  }).observe(titleNode, { characterData: true, subtree: true });


  console.log("🛠 Title‑sync initialized for book:", bookId);
}
