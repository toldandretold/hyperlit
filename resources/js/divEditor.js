import { book } from "./app.js";
import { 
  updateIndexedDBRecord, 
  deleteIndexedDBRecordWithRetry,
  renumberChunkAndSave,
  openDatabase,
  updateCitationForExistingHypercite
          } from "./cache-indexedDB.js";
import { 
  withPending,
  chunkOverflowInProgress,
  currentObservedChunk,
  setCurrentObservedChunk
} from './operationState.js';


import { buildBibtexEntry } from "./bibtexProcessor.js";
import { generateUniqueId, 
         isDuplicateId, 
         getNextDecimalForBase,
         generateInsertedNodeId,
         generateIdBetween,
         isNumericalId
          } from "./IDfunctions.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from './convert-markdown.js';
import { processFootnotes } from './footnotes.js';
//import { NodeIdManager } from './IDmanager.js';
import { 
  trackChunkNodeCount, 
  handleChunkOverflow, 
  NODE_LIMIT, 
  chunkNodeCounts 
} from './chunkManager.js';
import { isChunkLoadingInProgress, getLoadingChunkId } from './chunkLoadingState.js';
import { SelectionDeletionHandler } from './selectionDelete.js';

// Tracking sets
const modifiedNodes = new Set(); // Track element IDs whose content was modified.
const addedNodes = new Set(); // Track newly-added element nodes.
const removedNodeIds = new Set(); // Track IDs of removed nodes.

// Global observer variable
let observer;
// Global variable to track the currently observed chunk.
// Track document changes for debounced normalization
let documentChanged = false;
// hypercite paste handling
let hypercitePasteInProgress = false;
// track user activity
let debounceTimer = null;
// Flag to prevent double-handling
let pasteHandled = false;

// Global state for tracking observed chunks
let observedChunks = new Map(); // chunkId -> chunk element

let deletionHandler = null;


// Modified startObserving function. 
// Note: editable div = <div class="main-content" id="book" contenteditable="true">
export function startObserving(editableDiv) {

  console.log("🤓 startObserving function called - multi-chunk mode");

  // Stop any existing observer first
  stopObserving();
                     
  if (!editableDiv) {
    console.warn("No .main-content container found; observer not attached.");
    return;
  }

  // Initialize tracking for all current chunks
  initializeCurrentChunks(editableDiv);

  // Create observer for the main-content container
  observer = new MutationObserver(async (mutations) => {
    // Skip processing if a hypercite paste is in progress
    if (hypercitePasteInProgress) {
      console.log("Skipping mutations during hypercite paste");
      return;
    }

    // 🚨 NEW: Skip processing if chunk loading is in progress
    if (isChunkLoadingInProgress()) {
      console.log(`Skipping mutations during chunk loading for chunk ${getLoadingChunkId()}`);
      return;
    }

    // Skip mutations related to status icons
    if (shouldSkipMutation(mutations)) {
      console.log("Skipping mutations related to status icons");
      return;
    }

    // Filter mutations to only those within chunks (ignore sentinels)
    const chunkMutations = filterChunkMutations(mutations);
    
    if (chunkMutations.length > 0) {
      await processMutationsByChunk(chunkMutations);
    }
  });

  // Initialize deletion handler with callbacks
  // In your startObserving function
    deletionHandler = new SelectionDeletionHandler(editableDiv, {
      onDeleted: (nodeId) => {
        console.log(`Selection deletion handler wants to delete: ${nodeId}`);
        // Just delete from IndexedDB - the DOM removal is handled by the class
        deleteIndexedDBRecordWithRetry(nodeId);
      }
    });


  // Observe the main-content container
  observer.observe(editableDiv, {
    childList: true,
    subtree: true, // Observe all descendants
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true
  });

  console.log(`Multi-chunk observer attached to .main-content`);
}

// Initialize tracking for all chunks currently in the DOM
function initializeCurrentChunks(editableDiv) {
  const chunks = editableDiv.querySelectorAll('.chunk');

  
  observedChunks.clear(); // Start fresh
  
  chunks.forEach(chunk => {
    const chunkId = chunk.getAttribute('data-chunk-id');
    if (chunkId) {
      observedChunks.set(chunkId, chunk);
      trackChunkNodeCount(chunk);
      
      console.log(`📦 Initialized tracking for chunk ${chunkId}`);
    } else {
      console.warn("Found chunk without data-chunk-id:", chunk);
    }
  });
  
  console.log(`Now tracking ${observedChunks.size} chunks`);
}

// Filter mutations to only include those within .chunk elements
function filterChunkMutations(mutations) {
  const filteredMutations = [];
  
  mutations.forEach(mutation => {
    // Check if mutation target is within a chunk (not a sentinel)
    const chunk = findContainingChunk(mutation.target);
    
    // If we found a chunk, include the mutation
    if (chunk !== null) {
      filteredMutations.push(mutation);
      return;
    }
    
    // Special case: Check for deletion of chunks
    if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
      const chunkDeletions = Array.from(mutation.removedNodes).filter(node => 
        node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('chunk')
      );
      
      if (chunkDeletions.length > 0) {
        console.log('Detected chunk deletion(s):', chunkDeletions);
        
        // For each deleted chunk, handle deletion of numerical ID nodes directly
        chunkDeletions.forEach(deletedChunk => {
          const numericalIdNodes = findNumericalIdNodesInChunk(deletedChunk);
          
          if (numericalIdNodes.length > 0) {
            console.log('Deleting numerical ID nodes from IndexedDB:', numericalIdNodes);
            
            // Directly delete each numerical ID node from IndexedDB
            numericalIdNodes.forEach(node => {
              console.log(`Deleting node ${node.id} from IndexedDB due to chunk deletion`);
              deleteIndexedDBRecordWithRetry(node.id);
            });
          }
        });
        
        // Include the original chunk deletion mutation for any other processing
        filteredMutations.push(mutation);
      } else {
        // Check for other numerical ID deletions (your original case)
        const hasNumericalIdDeletion = Array.from(mutation.removedNodes).some(node => 
          isNumericalIdDeletion(node, mutation.target)
        );
        
        if (hasNumericalIdDeletion) {
          filteredMutations.push(mutation);
        }
      }
    }
  });
  
  return filteredMutations;
}

// Check if a removed node meets the numerical id criteria (for non-chunk deletions)
function isNumericalIdDeletion(removedNode, mutationTarget) {
  // Only check element nodes
  if (removedNode.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  
  // Check if the node has a numerical id
  const nodeId = removedNode.id;
  if (!nodeId || !isNumericalId(nodeId)) {
    return false;
  }
  
  // Check if mutation target is within .main-content but not within .chunk
  const parentChunk = findContainingChunk(mutationTarget);
  const isWithinMainContent = isNodeWithinMainContent(mutationTarget);
  
  return parentChunk === null && isWithinMainContent;
}

// Find the .chunk element that contains the given node
function findContainingChunk(node) {
  if (!node) return null;
  
  // Handle text nodes
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node = node.parentElement;
  }
  
  // Walk up until we find a .chunk or reach .main-content
  while (node && !node.classList?.contains('main-content')) {
    if (node.classList?.contains('chunk')) {
      return node;
    }
    node = node.parentElement;
  }
  
  return null;
}

// Find all nodes with numerical IDs within a chunk
function findNumericalIdNodesInChunk(chunkNode) {
  const numericalIdNodes = [];
  
  // Use querySelectorAll to find elements with numerical IDs
  const elementsWithIds = chunkNode.querySelectorAll('[id]');
  
  elementsWithIds.forEach(element => {
    if (isNumericalId(element.id)) {
      numericalIdNodes.push(element);
    }
  });
  
  return numericalIdNodes;
}

// Lightweight check if node is within .main-content
function isNodeWithinMainContent(node) {
  if (!node) return false;
  
  // Handle text nodes
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node = node.parentElement;
  }
  
  // Walk up until we find .main-content or reach the top
  while (node) {
    if (node.classList?.contains('main-content')) {
      return true;
    }
    node = node.parentElement;
  }
  
  return false;
}





// Check if mutations should be skipped (existing logic)
function shouldSkipMutation(mutations) {
  return mutations.some(mutation => 
    mutation.target.id === "status-icon" || 
    (mutation.target.parentNode && mutation.target.parentNode.id === "status-icon") ||
    mutation.addedNodes.length && Array.from(mutation.addedNodes).some(node => 
      node.id === "status-icon" || (node.parentNode && node.parentNode.id === "status-icon")
    )
  );
}



// Process mutations grouped by their containing chunk
async function processMutationsByChunk(mutations) {
  const mutationsByChunk = new Map(); // chunkId -> mutations[]
  const newChunksFound = new Set();
  
  // Group mutations by chunk
  for (const mutation of mutations) {
    const chunk = findContainingChunk(mutation.target);
    
    if (chunk) {
      const chunkId = chunk.getAttribute('data-chunk-id');
      
      if (!chunkId) {
        console.warn("Found chunk without data-chunk-id:", chunk);
        continue;
      }
      
      // Handle new chunks being added via lazy loading
      if (!observedChunks.has(chunkId)) {
        handleNewChunk(chunk);
        newChunksFound.add(chunkId);
      }
      
      if (!mutationsByChunk.has(chunkId)) {
        mutationsByChunk.set(chunkId, []);
      }
      mutationsByChunk.get(chunkId).push(mutation);
    }
  }
  
  if (newChunksFound.size > 0) {
    console.log(`📦 Found ${newChunksFound.size} new chunks:`, Array.from(newChunksFound));
  }
  
  // Process mutations for each chunk
  for (const [chunkId, chunkMutations] of mutationsByChunk) {
    const chunk = observedChunks.get(chunkId);
    if (chunk && document.contains(chunk)) { // Ensure chunk is still in DOM
      await processChunkMutations(chunk, chunkMutations);
    } else if (chunk) {
  // Chunk was removed, clean up - but delay it to let any pending transactions finish
  console.log(`🗑️ Chunk ${chunkId} removed from DOM, scheduling cleanup...`);
  
  setTimeout(() => {
    observedChunks.delete(chunkId);
    delete chunkNodeCounts[chunkId];
    console.log(`✅ Chunk ${chunkId} cleanup completed`);
  }, 300); // Give enough time for the deletion transaction to complete
}
  }
}

// Handle a new chunk being discovered
function handleNewChunk(chunk) {
  const chunkId = chunk.getAttribute('data-chunk-id');
  
  if (!chunkId) {
    console.warn("Found chunk without data-chunk-id:", chunk);
    return;
  }
  
  console.log(`📦 New chunk loaded: ${chunkId}`);
  
  observedChunks.set(chunkId, chunk);
  trackChunkNodeCount(chunk);
}

// Process mutations for a specific chunk (adapted from your existing logic)
async function processChunkMutations(chunk, mutations) {
  const chunkId = chunk.getAttribute('data-chunk-id');
  
  console.log(`🔄 Processing ${mutations.length} mutations for chunk ${chunkId}`);
  
  // Track node count CHANGES after mutations 
  trackChunkNodeCount(chunk, mutations);
  
  // Check if current chunk has reached the limit
  const currentNodeCount = chunkNodeCounts[chunkId] || 0;
  
  // If we're at the limit and adding new nodes, handle overflow
  if (currentNodeCount > NODE_LIMIT && 
      mutations.some(m => m.type === "childList" && m.addedNodes.length > 0)) {
    console.log(`Chunk ${chunkId} has reached limit (${currentNodeCount}/${NODE_LIMIT}). Managing overflow...`);
    await handleChunkOverflow(chunk, mutations);
    return;
  }
  
  // Track parent nodes that need updates
  const parentsToUpdate = new Set();
  let addedCount = 0;
  const newNodes = [];
  let pasteDetected = false;
  
  
    // Check if this might be a paste operation (multiple nodes added at once)
    if (mutations.some(m => m.type === "childList" && m.addedNodes.length > 1)) {
      pasteDetected = true;
      console.log("Possible paste operation detected");
    }

    for (const mutation of mutations) {
      // Process removals first to ensure they're not missed
      if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
        let shouldUpdateParent = false;
        let parentNode = null;
        
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this is a top-level paragraph/heading being removed
            if (node.id && node.id.match(/^\d+(\.\d+)?$/)) {
              console.log(`🗑️ Attempting to delete node ${node.id} from IndexedDB`);

              // 🚨 NEW: Check if this is the last node in the chunk
              const remainingNodes = chunk.querySelectorAll('[id]').length;
              console.log(`Chunk ${chunkId} has ${remainingNodes} remaining nodes after this deletion`);
              
              if (remainingNodes === 0) {
                // This is the last node - handle it specially
                console.log(`🚨 Last node ${node.id} being deleted from chunk ${chunkId}`);
                
                try {
                  await deleteIndexedDBRecordWithRetry(node.id);
                  console.log(`✅ Successfully deleted last node ${node.id} from IndexedDB`);
                } catch (error) {
                  console.error(`❌ Failed to delete last node ${node.id}:`, error);
                }
                removedNodeIds.add(node.id);
                
                // Exit early to avoid further processing since chunk will disappear
                return;
              } else {
                // Normal deletion for non-last nodes
                try {
                  await deleteIndexedDBRecordWithRetry(node.id);
                  console.log(`✅ Successfully deleted node ${node.id} from IndexedDB`);
                } catch (error) {
                  console.error(`❌ Failed to delete node ${node.id}:`, error);
                }
                removedNodeIds.add(node.id);
              }
            } 
            // 🚨 ADD THIS MISSING 'else if' for hypercites
            else if (node.id && node.id.startsWith("hypercite_")) {
              // Instead of deleting, mark the parent for update
              parentNode = mutation.target;
              shouldUpdateParent = true;
              console.log(`Hypercite removed from parent: ${parentNode.id}`, node);
            }
          }
        }
        
        // 🚨 ADD THIS: Handle parent updates after processing all removed nodes
        if (shouldUpdateParent && parentNode) {
          // Find the closest parent with a numeric ID
          let closestParent = parentNode;
          while (closestParent && (!closestParent.id || !closestParent.id.match(/^\d+(\.\d+)?$/))) {
            closestParent = closestParent.parentElement;
          }
          
          if (closestParent && closestParent.id) {
            parentsToUpdate.add(closestParent);
          }
        }
      }

      // --- NEW GUARD: skip any childList where all added nodes are arrow‐icons ---
      
      if (mutation.type === "childList") {
        const allAreIcons = Array.from(mutation.addedNodes).every((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return false;
          const el = /** @type {HTMLElement} */ (n);
          // span.open-icon itself
          if (el.classList.contains("open-icon")) return true;
          // or an <a> whose only child is that span
          if (
            el.tagName === "A" &&
            el.children.length === 1 &&
            el.firstElementChild.classList.contains("open-icon")
          ) {
            return true;
          }
          return false;
        });
        if (allAreIcons) {
          // console.log("Skipping pure-icon mutation");
          continue;
        }
      } 

      // 1) Title-sync logic for H1#1
      const h1 = document.getElementById("1");
      if (h1) {
        // characterData inside H1
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode?.closest('h1[id="1"]')
        ) {
          const newTitle = h1.innerText.trim();
          updateLibraryTitle(book, newTitle).catch(console.error);
          updateIndexedDBRecord({
            id: h1.id,
            html: h1.outerHTML,
            chunk_id: getNodeChunkId(h1),
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
            chunk_id: getNodeChunkId(h1),
            action: "update"
          }).catch(console.error);
        }
      }

      // 2) Process added nodes
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (window.NodeIdManager && typeof NodeIdManager.exists === 'function') {
              // If node already has an ID
              if (node.id) {
                // Check if it's a duplicate
                if (NodeIdManager.exists(node.id) && document.getElementById(node.id) !== node) {
                  console.log(`Duplicate ID detected: ${node.id}`);
                  
                  // Find reference nodes for context-aware ID generation
                  const parent = node.parentElement;
                  if (parent) {
                    const siblings = Array.from(parent.children);
                    const index = siblings.indexOf(node);
                    
                    let newId;
                    if (index > 0) {
                      const prevSibling = siblings[index - 1];
                      if (index < siblings.length - 1) {
                        const nextSibling = siblings[index + 1];
                        if (prevSibling.id && nextSibling.id) {
                          newId = NodeIdManager.getIntermediateId(prevSibling.id, nextSibling.id);
                        } else if (prevSibling.id) {
                          newId = NodeIdManager.getNextId(prevSibling.id);
                        } else if (nextSibling.id) {
                          newId = NodeIdManager.getIdBefore(nextSibling.id);
                        } else {
                          newId = NodeIdManager.generateUniqueId();
                        }
                      } else {
                        // Last child
                        if (prevSibling.id) {
                          newId = NodeIdManager.getNextId(prevSibling.id);
                        } else {
                          newId = NodeIdManager.generateUniqueId();
                        }
                      }
                    } else {
                      // First child
                      if (index < siblings.length - 1) {
                        const nextSibling = siblings[index + 1];
                        if (nextSibling.id) {
                          newId = NodeIdManager.getIdBefore(nextSibling.id);
                        } else {
                          newId = NodeIdManager.generateUniqueId();
                        }
                      } else {
                        // Only child
                        newId = NodeIdManager.generateUniqueId();
                      }
                    }
                    
                    console.log(`Changing duplicate ID from ${node.id} to ${newId}`);
                    node.id = newId;
                  } else {
                    // No parent, generate a completely unique ID
                    const oldId = node.id;
                    node.id = NodeIdManager.generateUniqueId();
                    console.log(`Changed orphaned duplicate ID from ${oldId} to ${node.id}`);
                  }
                } else {
                  // ID exists but is not a duplicate, register it
                  NodeIdManager.register(node.id);
                }
              } else {
                // Node has no ID, generate one based on context
                const parent = node.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children);
                  const index = siblings.indexOf(node);
                  
                  let newId;
                  if (index > 0) {
                    const prevSibling = siblings[index - 1];
                    if (prevSibling.id && /^\d+(\.\d+)?$/.test(prevSibling.id)) {
                      newId = NodeIdManager.getNextId(prevSibling.id);
                    } else {
                      newId = NodeIdManager.generateUniqueId();
                    }
                  } else if (index < siblings.length - 1) {
                    const nextSibling = siblings[index + 1];
                    if (nextSibling.id && /^\d+(\.\d+)?$/.test(nextSibling.id)) {
                      newId = NodeIdManager.getIdBefore(nextSibling.id);
                    } else {
                      newId = NodeIdManager.generateUniqueId();
                    }
                  } else {
                    newId = NodeIdManager.generateUniqueId();
                  }
                  
                  console.log(`Assigned new ID to node: ${newId}`);
                  node.id = newId;
                } else {
                  // No parent, generate a completely unique ID
                  node.id = NodeIdManager.generateUniqueId();
                  console.log(`Assigned unique ID to orphaned node: ${node.id}`);
                }
              }
            } else {
              // Fall back to original method if NodeIdManager is not available
              ensureNodeHasValidId(node);
            }
            
            addedNodes.add(node);
            addedCount++;
            newNodes.push(node); // Add to newNodes array for saving later
            
            // If this might be a paste, explicitly save this node
            if (pasteDetected && node.id) {
              console.log(`Saving potentially pasted node: ${node.id}`);
              updateIndexedDBRecord({
                id: node.id,
                html: node.outerHTML,
                chunk_id: getNodeChunkId(node),
                action: "update"
              }).catch(console.error);
            }
          }
        });
      }
      // 3) Process text changes
      else if (mutation.type === "characterData") {
        let parent = mutation.target.parentNode;
        
        // Find the closest parent with an ID (typically a paragraph)
        while (parent && !parent.id) {
          parent = parent.parentNode;
        }
        
        if (parent && parent.id) {
          console.log(`Saving characterData change in parent: ${parent.id}`);
          updateIndexedDBRecord({
            id: parent.id,
            html: parent.outerHTML,
            chunk_id: getNodeChunkId(parent),
            action: "update"
          }).catch(console.error);
          modifiedNodes.add(parent.id);
        } else {
          console.warn("characterData change detected but couldn't find parent with ID");
        }
      }
    }
    
    // Process all parent nodes that need updates
    parentsToUpdate.forEach(parent => {
      console.log(`Updating parent node after child removal: ${parent.id}`);
      updateIndexedDBRecord({
        id: parent.id,
        html: parent.outerHTML,
        chunk_id: getNodeChunkId(parent),
        action: "update"
      }).catch(console.error);
      modifiedNodes.add(parent.id);
    });

    // If we detected a paste operation with multiple nodes, save the whole chunk
    if (pasteDetected && addedCount > 1) {
      console.log(`Paste operation detected with ${addedCount} nodes - saving entire chunk`);
      await renumberChunkAndSave(currentObservedChunk);
    }
    // Otherwise, save individual nodes if there aren't too many
    else if (addedCount > 0) {
      // 🚨 ADD MISSING CONSTANT
      const BULK_THRESHOLD = 20;
      if (addedCount < BULK_THRESHOLD) {
        // small: update each individually
        console.log(`Saving ${newNodes.length} new nodes individually`);
        await Promise.all(
          newNodes.map(node => {
            if (node.id) {
              console.log(`Saving new node: ${node.id}`);
              return updateIndexedDBRecord({
                id: node.id,
                html: node.outerHTML,
                chunk_id: getNodeChunkId(node),
                action: "add"
              }).catch(console.error);
            }
            return Promise.resolve();
          })
        );
      } else {
        // bulk: renumber the whole chunk & save in one pass
        console.log(`Bulk insert of ${addedCount} nodes—doing batch save`);
        await renumberChunkAndSave(currentObservedChunk);
      }
    }

    // then your existing debounced normalize
    debouncedNormalize(currentObservedChunk);
  
}


// Utility function to get current chunks (for other parts of your code)
export function getCurrentChunks() {
  return Array.from(observedChunks.values());
}

// Utility function to get a specific chunk
export function getChunkById(chunkId) {
  return observedChunks.get(chunkId);
}





// Function to stop the MutationObserver.
export function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  
  observedChunks.clear();
  console.log("Multi-chunk observer stopped and tracking cleared");
  
  // Reset all state variables
  modifiedNodes.clear();
  addedNodes.clear();
  removedNodeIds.clear();
  documentChanged = false;

  
  // Remove any lingering spinner
  const existingSpinner = document.getElementById("status-icon");
  if (existingSpinner) {
    existingSpinner.remove();
    console.log("Removed lingering spinner");
  }
  
  console.log("Observer and related state fully reset");
}

/*
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
      setCurrentObservedChunk(null);
      console.warn("Lost focus on any chunk.");
    }
  }
}); */



// Track typing activity
document.addEventListener("keydown", function handleTypingActivity() {
  // Only show spinner if in edit mode
  if (!window.isEditing) return;
  
  
    if (currentObservedChunk) {
      debouncedNormalize(currentObservedChunk);
    }
});







// Helper: Parse hypercite URL to extract components
export function parseHyperciteHref(href) {
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

// Debounced normalization function for editable div, including saving cues
const debouncedNormalize = debounce((container) => {
  if (!documentChanged) return;
  console.log("User stopped typing; normalizing and saving…");
  // this wrapper will increment before running, and decrement when done
  
}, 500);

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

// Helper function to get chunk_id for a node as a float
// Helper function to get chunk_id for a node as a float
// Enhanced helper function to get chunk_id for a node as a float
function getNodeChunkId(node) {
  // Make sure we have a valid node
  if (!node) {
    console.warn("getNodeChunkId called with null/undefined node");
    return 0;
  }
  
  // Find the closest parent with a data-chunk-id attribute
  const parentChunk = node.closest('[data-chunk-id]');
  
  if (parentChunk) {
    const chunkIdStr = parentChunk.getAttribute('data-chunk-id');
    console.log(`Found chunk_id ${chunkIdStr} for node ${node.id || 'unknown'}`);
    return parseFloat(chunkIdStr);
  } 
  
  // FALLBACK 1: If node is not attached to a chunk, check if it's in currentObservedChunk
  if (currentObservedChunk && currentObservedChunk.contains(node)) {
    const observedChunkId = currentObservedChunk.getAttribute('data-chunk-id');
    console.log(`Node ${node.id || 'unknown'} is in currentObservedChunk with ID ${observedChunkId}`);
    return parseFloat(observedChunkId);
  }
  
  // FALLBACK 2: Look for any chunk in the document that contains this node
  const allChunks = document.querySelectorAll('[data-chunk-id]');
  for (const chunk of allChunks) {
    if (chunk.contains(node)) {
      const foundChunkId = chunk.getAttribute('data-chunk-id');
      console.log(`Found node ${node.id || 'unknown'} in chunk ${foundChunkId} by document search`);
      return parseFloat(foundChunkId);
    }
  }
  
  // FALLBACK 3: If we still can't find a chunk, use the current active chunk ID
  if (currentObservedChunk) {
    const defaultChunkId = currentObservedChunk.getAttribute('data-chunk-id');
    console.warn(`No parent chunk found for node ${node.id || 'unknown'}, using current active chunk ${defaultChunkId}`);
    return parseFloat(defaultChunkId);
  }
  
  // Last resort fallback
  console.warn(`No chunk context found for node ${node.id || 'unknown'}, using default chunk_id 0`);
  return 0;
}



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
// Track consecutive Enter presses
let lastKeyWasEnter = false;
let enterCount = 0;
let lastEnterTime = 0;

function createAndInsertParagraph(blockElement, chunkContainer, content, selection) {
  // 1. Create the new paragraph
  const newParagraph = document.createElement('p');

  // 2. Handle content
  if (content) {
    // Unwrap any nested paragraphs
    const nodes = content.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? Array.from(content.childNodes)
      : [content];

    nodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'P') {
        Array.from(node.childNodes).forEach(child => {
          newParagraph.appendChild(child.cloneNode(true));
        });
      } else {
        newParagraph.appendChild(node.cloneNode(true));
      }
    });
  } else {
    const br = document.createElement('br');
    newParagraph.appendChild(br);

  }

  // 3. Generate an ID for the new paragraph
  if (blockElement.id) {
    // Find the correct container to insert into
    const container = blockElement.closest('.chunk') || blockElement.parentNode;
    
    // Find the next element with a numeric ID (if any)
    let nextElement = blockElement.nextElementSibling;
    while (nextElement && (!nextElement.id || !/^\d+(\.\d+)?$/.test(nextElement.id))) {
      nextElement = nextElement.nextElementSibling;
    }
    
    if (nextElement && nextElement.id) {
      // Generate ID between current and next
      newParagraph.id = generateIdBetween(blockElement.id, nextElement.id);
    } else {
      // Generate ID after current
      const blockId = parseFloat(blockElement.id);
      if (!isNaN(blockId)) {
        if (Number.isInteger(blockId)) {
          newParagraph.id = (blockId + 1).toString();
        } else {
          newParagraph.id = Math.ceil(blockId).toString();
        }
      } else {
        newParagraph.id = generateIdBetween(blockElement.id, null);
      }
    }
    
    // 4. Insert the paragraph at the correct position in the DOM
    // IMPORTANT: Insert as a sibling, not a child
    if (blockElement.nextSibling) {
      container.insertBefore(newParagraph, blockElement.nextSibling);
    } else {
      container.appendChild(newParagraph);
    }
    
    console.log(`Created new paragraph with ID ${newParagraph.id} after ${blockElement.id}`);
  }

  // 5. Move cursor to the new paragraph
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  moveCaretTo(target, 0);
  // 2) Immediately scroll the new paragraph into view:
  // Then scroll after a tiny delay to let the DOM settle
    setTimeout(() => {
    const rect = newParagraph.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    
    // Only scroll if needed
    if (rect.top < 0 || rect.bottom > viewportHeight) {
      // Position the element 20% from the top of the viewport
      const scrollTarget = window.scrollY + rect.top - (viewportHeight * 0.2);
      window.scrollTo(0, scrollTarget);
    }
  }, 10);
  return newParagraph;
}



/** 
 * Collapse the caret at the start of an element, preferring its first Text child 
 * Returns a new Range ready to be `selection.addRange`d.
 */
function collapseAtStart(el) {
  const r = document.createRange();
  const first = el.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    console.log("collapseAtStart → text node");
    r.setStart(first, 0);
  } else {
    console.log("collapseAtStart → element");
    r.setStart(el, 0);
  }
  r.collapse(true);
  return r;
}

/**
 * Move the caret to (node, offset), then scroll it into view.
 */
function moveCaretTo(node, offset = 0) {
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  scrollCaretIntoView();
}


// Helper function to check if element is in viewport
function isElementInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}



document.addEventListener("keydown", function(event) {
  // Skip paragraph creation if chunk overflow is in progress
  if (event.key === "Enter" && chunkOverflowInProgress) {
    event.preventDefault();
    console.log("Enter key ignored during chunk overflow processing");
    return;
  }

  // Reset enter count if any other key is pressed
  if (event.key !== "Enter") {
    lastKeyWasEnter = false;
    enterCount = 0;
    return;
  }
  
  // Check if this is a consecutive Enter press (within 2 seconds)
  const now = Date.now();
  if (lastKeyWasEnter && (now - lastEnterTime < 2000)) {
    enterCount++;
  } else {
    enterCount = 1;
  }
  
  lastKeyWasEnter = true;
  lastEnterTime = now;
  
  // Debug
  console.log("Enter count:", enterCount);
  
  if (window.isEditing) {
    // Get the current selection
    const selection = document.getSelection();
    if (selection.rangeCount === 0) return;
    
    const range = selection.getRangeAt(0);
    
    // Find the current node and its parent block element
    let currentNode = range.startContainer;
    if (currentNode.nodeType !== Node.ELEMENT_NODE) {
      currentNode = currentNode.parentElement;
    }
    
    // Find the parent block element
    let blockElement = currentNode;
    while (blockElement && 
           !['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'].includes(blockElement.tagName)) {
      blockElement = blockElement.parentElement;
    }
    
    if (!blockElement) return;
    
    // Find the chunk container
    const chunkContainer = blockElement.closest('.chunk');
    if (!chunkContainer) return;

    // Check if we're at the beginning of a heading
    const isHeading = /^H[1-6]$/.test(blockElement.tagName);
    let isAtStart = false;

    // Determine if cursor is at the start
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      isAtStart = range.startOffset === 0 && 
                  (range.startContainer === blockElement.firstChild || 
                   range.startContainer.parentNode === blockElement.firstChild);
    } else if (range.startContainer === blockElement) {
      isAtStart = range.startOffset === 0;
    }

    if (isHeading && isAtStart) {
      event.preventDefault();
      
      // 1. Create a new paragraph to insert BEFORE the heading
      const newParagraph = document.createElement('p');
      newParagraph.innerHTML = '<br>';
      
      // 2. Generate ID for the new paragraph
      if (blockElement.id) {
        // Find previous element with numeric ID
        let prevElement = blockElement.previousElementSibling;
        while (prevElement && (!prevElement.id || !/^\d+(\.\d+)?$/.test(prevElement.id))) {
          prevElement = prevElement.previousElementSibling;
        }
        
        // Special case: if heading is ID "1" and no previous element, use "0" as beforeId
        if (!prevElement && blockElement.id === "1") {
          newParagraph.id = generateIdBetween("0", "1");
        } else if (prevElement && prevElement.id) {
          // Generate ID between previous and current
          newParagraph.id = generateIdBetween(prevElement.id, blockElement.id);
        } else {
          // Generate ID before current
          newParagraph.id = generateIdBetween(null, blockElement.id);
        }
        
        // 3. Insert the new paragraph before the heading
        blockElement.parentNode.insertBefore(newParagraph, blockElement);
        
        // 4. Save the current scroll position
        const scrollYBefore = window.scrollY;
        
        // 5. Position cursor at start of heading (where it already is)
        // No need to move the cursor as it's already at the start of the heading
        
        // 6. Ensure the heading stays visible by restoring scroll position
        setTimeout(() => {
          // Restore scroll position to keep heading in view
          window.scrollTo(0, scrollYBefore);
          
          // If heading is still not visible, scroll it into view
          if (!isElementInViewport(blockElement)) {
            blockElement.scrollIntoView({
              behavior: 'auto',
              block: 'nearest'
            });
          }
        }, 0);
      }
      
      // The MutationObserver will handle saving both elements
      
      enterCount = 0;
      return;
    }


    
    //==========================================================================
    // SECTION 1: Special handling for blockquote and pre (code blocks)
    //==========================================================================
    if (blockElement.tagName === 'BLOCKQUOTE' || blockElement.tagName === 'PRE') {
      event.preventDefault(); // Prevent default Enter behavior
      
      // Check if we're inside a hypercite
      let insideHypercite = false;
      let hyperciteElement = null;
      let currentElement = range.startContainer;
      if (currentElement.nodeType !== Node.ELEMENT_NODE) {
        currentElement = currentElement.parentElement;
      }
      
      // Check if we're inside a hypercite (u tag)
      hyperciteElement = currentElement.closest('u[id^="hypercite_"]');
      insideHypercite = !!hyperciteElement;
      
      // If this is the third consecutive Enter press, escape the block
      if (enterCount >= 3) {
        // For code blocks, we need to look inside the CODE element
        let targetElement = blockElement;
        if (blockElement.tagName === 'PRE' && blockElement.querySelector('code')) {
          targetElement = blockElement.querySelector('code');
        }
        
        // First, if we're inside a hypercite, move any BR elements outside of it
        if (insideHypercite) {
          const brElements = hyperciteElement.querySelectorAll('br');
          if (brElements.length > 0) {
            // Move BR elements after the hypercite
            Array.from(brElements).forEach(br => {
              hyperciteElement.parentNode.insertBefore(br, hyperciteElement.nextSibling);
            });
          }
        }
        
        // Clean up the last two BR elements and any zero-width spaces
        const childNodes = Array.from(targetElement.childNodes);
        let brRemoved = 0;
        
        // Start from the end and work backwards
        for (let i = childNodes.length - 1; i >= 0 && brRemoved < 2; i--) {
          const node = childNodes[i];
          
          // Remove text nodes that are just zero-width spaces
          if (node.nodeType === Node.TEXT_NODE && node.textContent === '\u200B') {
            targetElement.removeChild(node);
          }
          // Remove BR elements
          else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
            targetElement.removeChild(node);
            brRemoved++;
          }
        }

        // Save the modified blockElement to IndexedDB
        if (blockElement.id) {
          console.log("Saving modified block element after BR cleanup:", blockElement.id);
          updateIndexedDBRecord({
            id: blockElement.id,
            html: blockElement.outerHTML,
            action: "update"
          }).catch(console.error);
        }
        console.log("blockElement:", blockElement);
        
        // Create and insert new paragraph
        const newParagraph = createAndInsertParagraph(blockElement, chunkContainer, null, selection);
        
        // Scroll the new paragraph into view
        // Then scroll after a tiny delay to let the DOM settle
        setTimeout(() => {
          newParagraph.scrollIntoView({
            behavior: 'auto',  // or keep 'smooth' if you prefer
            block: 'nearest'
          });
        }, 10);
        
        // Reset enter count
        enterCount = 0;
      } else {
        // For code blocks, we need to insert the BR inside the CODE element
        let targetElement = range.startContainer;
        if (blockElement.tagName === 'PRE') {
          // Find the CODE element
          let codeElement = null;
          if (targetElement.nodeType === Node.TEXT_NODE) {
            // If we're in a text node, look at its parent
            if (targetElement.parentElement.tagName === 'CODE') {
              codeElement = targetElement.parentElement;
            }
          } else if (targetElement.tagName === 'CODE') {
            codeElement = targetElement;
          } else {
            codeElement = targetElement.querySelector('code') || targetElement.closest('code');
          }
          
          if (codeElement) {
            // Insert a <br> at the cursor position
            const br = document.createElement('br');
            range.insertNode(br);
            
            // Insert a text node after the <br> to position the cursor on the next line
            const textNode = document.createTextNode('\u200B'); // Zero-width space
            range.setStartAfter(br);
            range.insertNode(textNode);
            
            // Move the cursor to the text node (which is now after the <br>)
            moveCaretTo(textNode, 0);
            
            // Scroll the code element into view
            codeElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest'
            });
          }
        } else {
          // For blockquotes, we need to handle hypercites specially
          if (insideHypercite) {
            // If we're inside a hypercite, insert the BR after the hypercite
            const br = document.createElement('br');
            
            // Insert after the hypercite
            if (hyperciteElement.nextSibling) {
              blockElement.insertBefore(br, hyperciteElement.nextSibling);
            } else {
              blockElement.appendChild(br);
            }
            
            // Insert a text node after the <br> to position the cursor on the next line
            const textNode = document.createTextNode('\u200B');
            blockElement.insertBefore(textNode, br.nextSibling);
            
            // Move the cursor to the text node
            moveCaretTo(textNode, 0);
            
            // Scroll the blockquote into view
            blockElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest'
            });
          } else {
            // Normal blockquote handling
            const br = document.createElement('br');
            range.insertNode(br);
            
            const textNode = document.createTextNode('\u200B');
            range.setStartAfter(br);
            range.insertNode(textNode);
            
            moveCaretTo(textNode, 0);
            
            // Scroll the blockquote into view
            blockElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest'
            });
          }
        }
      }
      
      return;
    }

    //==========================================================================
    // SECTION 2: For all other elements, proceed with normal paragraph creation
    //==========================================================================
    event.preventDefault();
    
    // Split the content at cursor position
    const cursorOffset = range.startOffset;
    
    // Check if cursor is at the end of the text content
    let isAtEnd = false;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      isAtEnd = cursorOffset === range.startContainer.length;
    } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      isAtEnd = cursorOffset === range.startContainer.childNodes.length;
    }
    
    // Prepare content for the new paragraph
    let content = null;
    if (!(isAtEnd && range.startContainer === blockElement.lastChild || 
          range.startContainer === blockElement && blockElement.textContent.trim() === '')) {
      const rangeToExtract = document.createRange();
      rangeToExtract.setStart(range.startContainer, cursorOffset);
      rangeToExtract.setEndAfter(blockElement);
      
      const clonedContent = rangeToExtract.cloneContents();
      const tempDiv = document.createElement('div');
      tempDiv.appendChild(clonedContent);
      const extractedText = tempDiv.textContent.trim();
      
      // Store the content to move to the new paragraph
      content = rangeToExtract.extractContents();
      
      // If the current block is now empty, add a <br>
      if (blockElement.innerHTML === '' || blockElement.textContent.trim() === '') {
        blockElement.innerHTML = '<br>';
      }
      
      if (extractedText === '') {
        content = null;
      }
    }
    console.log("blockElement:", blockElement);
    
    // Create and insert new paragraph
    const newParagraph = createAndInsertParagraph(blockElement, chunkContainer, content, selection);
    
    // Scroll the new paragraph into view
    // Then scroll after a tiny delay to let the DOM settle
    setTimeout(() => {
      newParagraph.scrollIntoView({
        behavior: 'auto',  // or keep 'smooth' if you prefer
        block: 'nearest'
      });
    }, 10);
    
    // Reset enter count after creating a new paragraph
    enterCount = 0;
  }
});



function scrollCaretIntoView() {
  console.log("→ scrollCaretIntoView start");
  const sel = document.getSelection();
  if (!sel.rangeCount) {
    console.log("  no selection range → abort");
    return;
  }

  const range = sel.getRangeAt(0);
  const clientRects = range.getClientRects();
  const rect = clientRects.length
    ? clientRects[0]
    : range.getBoundingClientRect();

  console.log(
    "  caret rect:",
    `top=${Math.round(rect.top)}`,
    `bottom=${Math.round(rect.bottom)}`,
    `height=${Math.round(rect.height)}`
  );

  const padding = 20;
  const vh = window.innerHeight || document.documentElement.clientHeight;

  if (rect.height > 0) {
    // Normal: scroll to keep caret visible
    if (rect.bottom > vh - padding) {
      const delta = rect.bottom - (vh - padding);
      console.log(`  scrolling down by ${delta}px`);
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else if (rect.top < padding) {
      const delta = rect.top - padding;
      console.log(`  scrolling up by ${delta}px`);
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      console.log("  caret in view, no scroll");
    }
  } 
}






/**
 * Main paste event handler that delegates to specialized handlers
 * based on the content type
 */
/**
 * Main paste event handler that cleans up pasted content and delegates to specialized handlers
 */
function handlePaste(event) {
  // Prevent double-handling
  if (pasteHandled) return;
  pasteHandled = true;
  
  // Reset the flag after the event cycle
  setTimeout(() => { pasteHandled = false; }, 0);
  
  // Log detailed paste information
  const plainText = event.clipboardData.getData('text/plain');
  const htmlContent = event.clipboardData.getData('text/html');
  
  console.log('PASTE EVENT DETECTED:', {
    plainTextLength: plainText.length,
    plainTextPreview: plainText.substring(0, 50) + (plainText.length > 50 ? '...' : ''),
    hasHTML: !!htmlContent,
    target: event.target,
    targetId: event.target.id || 'no-id',
    targetNodeName: event.target.nodeName
  });

  
  // Try to handle as hypercite first
  if (handleHypercitePaste(event)) {
    return; // Handled as hypercite
  }
  
  // Try to handle as code block paste first
  if (handleCodeBlockPaste(event, chunk)) {
    return; // Handled as code block paste
  }
  
  // Then try to handle as markdown
  if (handleMarkdownPaste(event)) {
    return; // Handled as markdown
  }
  
  // For regular pastes, we'll handle them ourselves to ensure clean content
  event.preventDefault(); // Prevent default paste behavior
  
  // Get the current chunk and selection
  const chunk = getCurrentChunk();
  if (!chunk) {
    console.warn("No active chunk found for paste operation");
    return;
  }
  
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    console.warn("No selection found for paste operation");
    return;
  }
  
  // Find the current paragraph
  const range = selection.getRangeAt(0);
  let currentNode = range.startContainer;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) {
    currentNode = currentNode.parentElement;
  }
  
  // Find the closest paragraph or block element
  let paragraph = currentNode.closest('p, div, h1, h2, h3, h4, h5, h6, li');
  if (!paragraph) {
    console.warn("Could not find paragraph for paste");
    // Create a new paragraph if none exists
    paragraph = document.createElement('p');
    paragraph.id = generateUniqueId();
    range.insertNode(paragraph);
  }
  
  console.log("Pasting into paragraph:", paragraph.id);
  
  // Get a snapshot of existing IDs before paste
  const existingIds = new Set();
  chunk.querySelectorAll('[id]').forEach(el => {
    existingIds.add(el.id);
  });
  
  // Clean the content - convert to plain paragraphs without spans or inline styles
  let cleanContent;
  
  if (plainText.includes('\n')) {
    // Text with line breaks - convert to paragraphs
    cleanContent = plainText.split('\n')
      .filter(line => line.trim() !== '')
      .map(line => `<p>${line}</p>`)
      .join('');
  } else {
    // Single line text - insert directly
    cleanContent = plainText;
  }
  
  // Insert the clean content
  if (cleanContent.startsWith('<p>')) {
    // If we're inserting multiple paragraphs, replace the current paragraph
    // with the first paragraph and insert the rest after
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = cleanContent;
    
    // Replace current paragraph content with first paragraph content
    const firstP = tempDiv.querySelector('p');
    if (firstP && paragraph.id) {
      paragraph.innerHTML = firstP.innerHTML;
      
      // Insert remaining paragraphs after the current one
      let insertAfter = paragraph;
      Array.from(tempDiv.children).forEach((el, index) => {
        if (index > 0) { // Skip the first one as we already used its content
          const newP = document.createElement('p');
          newP.innerHTML = el.innerHTML;
          newP.id = getNextDecimalForBase(paragraph.id.split('.')[0]);
          
          // Insert after the previous paragraph
          if (insertAfter.nextSibling) {
            chunk.insertBefore(newP, insertAfter.nextSibling);
          } else {
            chunk.appendChild(newP);
          }
          insertAfter = newP;
        }
      });
    }
  } else {
    // Single line - just insert at cursor
    document.execCommand('insertText', false, plainText);
  }
  
  // After the paste completes, find and save new elements
  setTimeout(() => {
    // Find all elements with IDs in the chunk
    const currentElements = chunk.querySelectorAll('[id]');
    const newElements = [];
    
    // Check for new elements that weren't there before
    currentElements.forEach(el => {
      if (!existingIds.has(el.id)) {
        newElements.push(el);
        console.log(`New element detected after paste: ${el.id}`);
      }
    });
    
    // Save all new elements
    if (newElements.length > 0) {
      console.log(`Found ${newElements.length} new elements after paste`);
      
      // Save each new element
      newElements.forEach(el => {
        console.log(`Saving new element: ${el.id}`);
        updateIndexedDBRecord({
          id: el.id,
          html: el.outerHTML,
          action: "add"
        }).catch(console.error);
      });
    }
    
    // Always save the current paragraph
    if (paragraph && paragraph.id) {
      console.log(`Saving current paragraph after paste: ${paragraph.id}`);
      updateIndexedDBRecord({
        id: paragraph.id,
        html: paragraph.outerHTML,
        action: "update"
      }).catch(console.error);
    }
    
    // Log the final state
    console.log('DOM AFTER PASTE PROCESSING:', {
      newElements: newElements.length,
      currentParagraph: paragraph.id
    });
  }, 100);
}


/**
 * Handle pasting of hypercites
 * @returns {boolean} true if handled as hypercite, false otherwise
 */
function handleHypercitePaste(event) {
  const clipboardHtml = event.clipboardData.getData("text/html");
  if (!clipboardHtml) return false;
  
  // Parse clipboard HTML
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = clipboardHtml;
  
  // Clear any numeric IDs to prevent conflicts
  pasteWrapper.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)?$/.test(el.id)) {
      el.removeAttribute('id');
    }
  });
  
  // Look for hypercite link
  const citeLink = pasteWrapper.querySelector(
    'a[id^="hypercite_"] > span.open-icon'
  )?.parentElement;
  
  // Check if this is a hypercite link
  if (!(citeLink && 
      (citeLink.innerText.trim() === "↗" || 
       (citeLink.closest("span") && citeLink.closest("span").classList.contains("open-icon"))))) {
    return false; // Not a hypercite
  }
  
  // Prevent default paste behavior
  event.preventDefault();
  
  console.log("Detected a hypercite in pasted content");
  
  const originalHref = citeLink.getAttribute("href");
  const parsed = parseHyperciteHref(originalHref);
  if (!parsed) return false;
  
  const { booka, hyperciteIDa, citationIDa } = parsed;
  console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });
  
  // Generate new hypercite ID for this instance
  const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
  
  // Get current book (where paste is happening)
  const bookb = book;
  
  // Create the citation ID for this new instance
  const citationIDb = `/${bookb}#${hyperciteIDb}`;
  
  // Extract quoted text - IMPROVED VERSION
  let quotedText = "";
  
  // First try to find the text directly before the citation link
  let textNode = citeLink.previousSibling;
  while (textNode) {
    if (textNode.nodeType === Node.TEXT_NODE) {
      quotedText = textNode.textContent.trim() + quotedText;
      break;
    }
    textNode = textNode.previousSibling;
  }
  
  // If that didn't work, try the fallback method
  if (!quotedText) {
    quotedText = extractQuotedText(pasteWrapper);
  }
  
  // Remove any blockquote tags or other structural elements from the quoted text
  quotedText = quotedText.replace(/^['"]|['"]$/g, ''); // Remove quotes
  
  // Create the reference HTML with no space between text and sup
  const referenceHtml = `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;
  
  // Set the flag to prevent MutationObserver from processing this paste
  hypercitePasteInProgress = true;
  console.log("Setting hypercitePasteInProgress flag to true");
  
  // Insert the content - use a more controlled approach
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    
    // Create a document fragment with just the text and link
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = referenceHtml;
    
    // Move all nodes from tempDiv to fragment
    while (tempDiv.firstChild) {
      fragment.appendChild(tempDiv.firstChild);
    }
    
    // Clear the range and insert our clean fragment
    range.deleteContents();
    range.insertNode(fragment);
    
    // Move cursor to end of insertion
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback to execCommand if selection isn't available
    document.execCommand("insertHTML", false, referenceHtml);
  }
  
  // Get the current paragraph to manually save it
  saveCurrentParagraph();
  
  // Update the original hypercite's citedIN array
  updateCitationForExistingHypercite(
    booka, 
    hyperciteIDa, 
    citationIDb,
    false // Don't insert content, just update the database
  ).then(updated => {
    if (updated) {
      console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
    } else {
      console.warn(`Failed to update citation for ${citationIDa}`);
    }
    
    // Clear the flag after a short delay
    setTimeout(() => {
      hypercitePasteInProgress = false;
      console.log("Cleared hypercitePasteInProgress flag");
    }, 100);
  });
  
  return true; // Successfully handled as hypercite
}


/**
 * Extract quoted text from a paste wrapper element
 */
export function extractQuotedText(pasteWrapper) {
  let quotedText = "";
  const fullText = pasteWrapper.textContent;
  const quoteMatch = fullText.match(/^"(.+?)"/);
  
  if (quoteMatch && quoteMatch[1]) {
    quotedText = quoteMatch[1];
  } else {
    // Fallback to just using text before the citation
    const textNodes = Array.from(pasteWrapper.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
      quotedText = textNodes[0].textContent.replace(/^"(.+)"$/, "$1");
    }
  }
  
  return quotedText;
}

/**
 * Save the current paragraph after a paste operation
 */
function saveCurrentParagraph() {
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let currentElement = range.startContainer;
    if (currentElement.nodeType !== Node.ELEMENT_NODE) {
      currentElement = currentElement.parentElement;
    }
    
    // Find the closest block element (paragraph, pre, blockquote, etc.)
    let blockElement = currentElement.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');
    
    if (blockElement && blockElement.id) {
      console.log("Manually saving block element:", blockElement.id, blockElement.tagName);
      // Manually save the element to IndexedDB
      updateIndexedDBRecord({
        id: blockElement.id,
        html: blockElement.outerHTML,
        action: "update"
      }).catch(console.error);
    }
  }
}


/**
 * Handle pasting of markdown content
 * @returns {boolean} true if handled as markdown, false otherwise
 */
function handleMarkdownPaste(event) {
  const markdown = event.clipboardData.getData("text/plain");
  if (!markdown.trim()) return false;
  
  // Check if this looks like markdown (has headings, lists, etc.)
  // This is optional - you can remove this check if you want to handle all plain text as markdown
  const hasMarkdownSyntax = /^#+\s|\n#+\s|^\s*[-*+]\s|\n\s*[-*+]\s|^\s*\d+\.\s|\n\s*\d+\.\s|`|_\w+_|\*\w+\*/.test(markdown);
  if (!hasMarkdownSyntax) return false;
  
  event.preventDefault();

  // 1) find ref node under cursor
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  let ref = sel.getRangeAt(0).startContainer;
  while (ref && !ref.id) ref = ref.parentElement;
  if (!ref) return false;
  const parent = ref.parentNode;

  // 2) parse into chunk‐objects
  const blocks = parseMarkdownIntoChunksInitial(markdown);

  // 3) build fragment and insert
  const frag = document.createDocumentFragment();
  blocks.forEach(block => {
    // block.content is something like '<p data‐original‐line=…>…</p>'
    const wrapper = document.createElement("div");
    wrapper.innerHTML = block.content;
    const el = wrapper.firstElementChild;
    // remove any old id so it doesn't collide
    el.removeAttribute("id");
    frag.appendChild(el);
  });
  
  // insert them all
  let insertAfter = ref;
  Array.from(frag.childNodes).forEach(node => {
    parent.insertBefore(node, insertAfter.nextSibling);
    insertAfter = node;
  });

  // 4) assign decimal IDs under ref.id's base
  const base = (ref.id.match(/^(\d+)/) || [])[1];
  if (!base) return false;
  let node = ref.nextSibling;
  while (node && !node.id) {
    if (node.nodeType === 1) {
      node.id = getNextDecimalForBase(base);
    }
    node = node.nextSibling;
  }
  
  return true; // Successfully handled as markdown
}

/**
 * Add paste event listener to the editable div
 */
export function addPasteListener(editableDiv) {
  console.log("Adding modular paste listener");
  editableDiv.addEventListener("paste", handlePaste);
  
}



function isCompleteHTML(text) {
  // Basic check if the text appears to be complete HTML
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<") &&
    trimmed.endsWith(">") &&
    (trimmed.includes("</") || trimmed.match(/<\s*[a-z]+[^>]*\/>/i))
  );
}

function handleCodeBlockPaste(event, chunk) {
  const plainText = event.clipboardData.getData("text/plain");
  const htmlContent = event.clipboardData.getData("text/html");

  // Get the current selection and find if we're in a code block
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  let currentNode = range.startContainer;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) {
    currentNode = currentNode.parentElement;
  }

  // Check if we're in a code block
  const codeBlock = currentNode.closest("pre");
  if (!codeBlock) return false;

  // If we have HTML content and it appears to be complete HTML
  if (htmlContent && isCompleteHTML(plainText)) {
    event.preventDefault();

    // Just insert the plain text directly
    range.deleteContents();
    const textNode = document.createTextNode(plainText);
    range.insertNode(textNode);

    // Update the code block in IndexedDB
    updateIndexedDBRecord({
      id: codeBlock.id,
      html: codeBlock.outerHTML,
      action: "update",
    }).catch(console.error);

    return true;
  }

  return false;
}




