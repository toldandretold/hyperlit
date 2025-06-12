import { book } from "./app.js";
import { 
  updateIndexedDBRecord, 
  deleteIndexedDBRecordWithRetry,
  openDatabase,
  updateCitationForExistingHypercite,
  batchUpdateIndexedDBRecords,
  syncBatchUpdateWithPostgreSQL,
  getNodeChunksAfter,
  deleteNodeChunksAfter,
  writeNodeChunks
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
         findPreviousElementId,
         findNextElementId,
         isNumericalId,
         compareDecimalStrings,
         getNextIntegerId
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
import { initializeMainLazyLoader } from './initializePage.js';

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


// ================================================================
// DEBOUNCING INFRASTRUCTURE
// ================================================================

// Debounce timers for different operations
const debounceTimers = {
  typing: null,
  mutations: null,
  saves: null,
  titleSync: null
};

// Debounce delays (in milliseconds)
const DEBOUNCE_DELAYS = {
  TYPING: 800,        // Wait 800ms after user stops typing
  MUTATIONS: 300,     // Wait 300ms after mutations stop
  SAVES: 500,         // Wait 500ms between save operations
  BULK_SAVE: 1000 , // Wait 1s for bulk operations
  TITLE_SYNC: 500,    
};

// Track what needs to be saved
const pendingSaves = {
  nodes: new Map(),           // Node IDs that need saving         
  lastActivity: null          // Timestamp of last activity
};

// Generic debounce function
function debounce(func, delay, timerId) {
  return function(...args) {
    clearTimeout(debounceTimers[timerId]);
    debounceTimers[timerId] = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

// Specialized debounced functions
const debouncedSaveNode = debounce(saveNodeToDatabase, DEBOUNCE_DELAYS.SAVES, 'saves');
const debouncedProcessMutations = debounce(processPendingMutations, DEBOUNCE_DELAYS.MUTATIONS, 'mutations');

// ================================================================
// SAVE QUEUE MANAGEMENT
// ================================================================

// Add node to pending saves queue
function queueNodeForSave(nodeId, action = 'update') {
  pendingSaves.nodes.set(nodeId, { id: nodeId, action }); // ✅ Overwrites duplicates
  pendingSaves.lastActivity = Date.now();
  
  console.log(`📝 Queued node ${nodeId} for ${action}`);
  debouncedSaveNode(); 
}




async function saveNodeToDatabase() {
  if (pendingSaves.nodes.size === 0) return;
  
  const nodesToSave = Array.from(pendingSaves.nodes.values());
  pendingSaves.nodes.clear();
  
  console.log(`💾 Processing ${nodesToSave.length} pending node saves`);
  
  // Separate by action type
  const updates = nodesToSave.filter(n => n.action === 'update');
  const additions = nodesToSave.filter(n => n.action === 'add');
  const deletions = nodesToSave.filter(n => n.action === 'delete');
  
  try {
    // Batch process updates and additions together
    const recordsToUpdate = [...updates, ...additions].filter(node => {
      const element = document.getElementById(node.id);
      if (!element) {
        console.warn(`⚠️ Skipping save for node ${node.id} - element not found in DOM`);
        return false;
      }
      return true;
    });

    if (recordsToUpdate.length > 0) {
      await batchUpdateIndexedDBRecords(recordsToUpdate);
    }
    
    // Handle deletions separately (still individual for now)
    if (deletions.length > 0) {
      await Promise.all(deletions.map(node => 
        deleteIndexedDBRecordWithRetry(node.id)
      ));
      console.log(`✅ Deleted ${deletions.length} nodes`);
    }
    
  } catch (error) {
    console.error('❌ Error in batch save:', error);
    // Re-queue failed saves
    nodesToSave.forEach(node => pendingSaves.nodes.set(node.id, node));
  }
}

async function processPendingMutations() {
  // This function can be used for any additional mutation processing
  // For now, it can be empty or just log
  console.log('📋 Processing pending mutations...');
}

// ================================================================
// ACTIVITY MONITORING
// ================================================================

// Monitor pending saves and log activity
setInterval(() => {
  const now = Date.now();
  const timeSinceLastActivity = pendingSaves.lastActivity ? now - pendingSaves.lastActivity : null;
  
  if (pendingSaves.nodes.size > 0 ) {
    console.log(`📊 Pending saves: ${pendingSaves.nodes.size} nodes (${timeSinceLastActivity}ms since last activity)`);
  }
}, 5000); // Log every 5 seconds if there's pending activity

// Force save all pending changes (useful for page unload)
export function flushAllPendingSaves() {
  console.log('🚨 Flushing all pending saves...');
  
  // Clear all timers
  Object.keys(debounceTimers).forEach(key => {
    clearTimeout(debounceTimers[key]);
  });
  
  // Execute saves immediately
  if (pendingSaves.nodes.size > 0) {
    saveNodeToDatabase();
  }
}

// Add page unload handler to flush saves
window.addEventListener('beforeunload', flushAllPendingSaves);

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

  // NEW: Set the current observed chunk after everything is set up
  const currentChunk = getCurrentChunk();
  if (currentChunk && currentChunk.dataset) {
    const chunkId = currentChunk.dataset.chunkId || currentChunk.id;
    setCurrentObservedChunk(chunkId);
    console.log(`📍 Set current observed chunk to: ${chunkId}`);
  } else {
    console.log(`📍 No valid chunk detected, leaving currentObservedChunk as null`);
  }

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
  
  // NEW: Return the chunks array
  return chunks;
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

            // Check if this is the last node in the chunk
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
          // Handle hypercites
          else if (node.id && node.id.startsWith("hypercite_")) {
            // Instead of deleting, mark the parent for update
            parentNode = mutation.target;
            shouldUpdateParent = true;
            console.log(`Hypercite removed from parent: ${parentNode.id}`, node);
          }
        }
      }
      
      // Handle parent updates after processing all removed nodes
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

    // Skip any childList where all added nodes are arrow-icons
    if (mutation.type === "childList") {
      const allAreIcons = Array.from(mutation.addedNodes).every((n) => {
        if (n.nodeType !== Node.ELEMENT_NODE) return false;
        const el = n;
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
        // 🔄 CONVERTED TO DEBOUNCED:
        queueNodeForSave(h1.id, 'update');
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
        // 🔄 CONVERTED TO DEBOUNCED:
        queueNodeForSave(h1.id, 'update');
      }
    }

    // 2) Process added nodes
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (window.NodeIdManager && typeof NodeIdManager.exists === 'function') {
            // [Your existing NodeIdManager logic - unchanged]
            // ... (keeping all your existing ID management code)
          } else {
            // Fall back to original method if NodeIdManager is not available
            ensureNodeHasValidId(node);
          }
          
          addedNodes.add(node);
          addedCount++;
          newNodes.push(node);
          
          // If this might be a paste, explicitly queue this node
          if (pasteDetected && node.id) {
            console.log(`Queueing potentially pasted node: ${node.id}`);
            queueNodeForSave(node.id, 'add');
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
        console.log(`Queueing characterData change in parent: ${parent.id}`);
        // 🔄 CONVERTED TO DEBOUNCED:
        queueNodeForSave(parent.id, 'update');
        modifiedNodes.add(parent.id);
      } else {
        console.warn("characterData change detected but couldn't find parent with ID");
      }
    }

  }

  // Process all parent nodes that need updates
  parentsToUpdate.forEach(parent => {
    console.log(`Queueing parent node after child removal: ${parent.id}`);
    queueNodeForSave(parent.id, 'update');
    modifiedNodes.add(parent.id);
  });

  if (addedCount > 0) {
    const BULK_THRESHOLD = 20;
    if (addedCount < BULK_THRESHOLD) {
      // small: queue each individually
      console.log(`Queueing ${newNodes.length} new nodes individually`);
      newNodes.forEach(node => {
        if (node.id) {
          console.log(`Queueing new node: ${node.id}`);
          queueNodeForSave(node.id, 'add');
        }
      });
    } 
  }
}





export function stopObserving() {
  
  if (window.selectionDeletionInProgress) {
    console.log("Skipping observer reset during selection deletion");
    return;
  }

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
  
  // Reset current observed chunk
  setCurrentObservedChunk(null);
  
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
  if (!window.isEditing || chunkOverflowInProgress) return;

  const newChunkId = getCurrentChunk();
  const currentChunkId = currentObservedChunk ? 
    (currentObservedChunk.id || currentObservedChunk.dataset.chunkId) : null;
    
  if (newChunkId !== currentChunkId) {
    console.log(`Chunk change detected: ${currentChunkId} → ${newChunkId}`);
    stopObserving();
    if (newChunkId) {
      const chunkElement = document.querySelector(`[id="${newChunkId}"], [data-chunk-id="${newChunkId}"]`);
      startObserving(chunkElement);
    } else {
      setCurrentObservedChunk(null);
      console.warn("Lost focus on any chunk.");
    }
  }
});



// Track typing activity
// Replace your existing keydown listener (around line 300) with this:
document.addEventListener("keydown", function handleTypingActivity(event) {
  // Only show spinner if in edit mode
  if (!window.isEditing) return;
  
  // Track typing activity
  pendingSaves.lastActivity = Date.now();
  
  // For character-generating keys, queue the current node for save
  if (event.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(event.key)) {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let currentNode = range.startContainer;
      if (currentNode.nodeType !== Node.ELEMENT_NODE) {
        currentNode = currentNode.parentElement;
      }
      
      // Find the closest element with an ID
      let elementWithId = currentNode.closest('[id]');
      if (elementWithId && elementWithId.id) {
        queueNodeForSave(elementWithId.id, 'update');
      }
    }
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
    console.warn('initTitleSync: no <h1 id="1"> found');
    return;
  }
  console.log("initTitleSync: found titleNode", titleNode);

  const writeTitle = debounce(
    async () => {
      const newTitle = titleNode.innerText.trim();
      console.log("🖉 [title-sync] writeTitle firing, newTitle=", newTitle);
      try {
        await updateLibraryTitle(bookId, newTitle);
        console.log("✔ [title-sync] updated library.title=", newTitle);
      } catch (err) { // <--- ADDED BRACES HERE
        console.error("✖ [title-sync] failed to update library.title:", err);
      } // <--- AND HERE
    },
    DEBOUNCE_DELAYS.TITLE_SYNC,
    "titleSync"
  );

  titleNode.addEventListener("input", (e) => {
    console.log("🖉 [title-sync] input event on H1", e);
    writeTitle();
  });

  editableContainer.addEventListener("input", (e) => {
    if (e.target === titleNode || titleNode.contains(e.target)) {
      console.log("🖉 [title-sync] container catch of input on H1", e);
      writeTitle();
    }
  });

  const titleObserver = new MutationObserver((mutationsList) => {
    mutationsList.forEach((mutation) => {
      if (mutation.type === "characterData") {
        const parent = mutation.target.parentNode;
        if (
          parent &&
          parent.nodeType === Node.ELEMENT_NODE &&
          parent.closest('h1[id="1"]') === titleNode
        ) {
          console.log("🖉 [title-sync] mutation detect (characterData)", mutation);
          writeTitle();
        }
      }
    });
  });

  titleObserver.observe(titleNode, {
    characterData: true,
    subtree: true,
  });

  console.log("🛠 Title-sync initialized for book:", bookId);
  // return titleObserver;
}











function getCurrentChunk() {
  const selection = document.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }
    const chunkElement = node.closest(".chunk");
    return chunkElement ? chunkElement.id || chunkElement.dataset.chunkId : null;
  }
  return null;
}


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

  // 🆕 NEW: Skip elements that shouldn't have IDs
  const skipElements = ['BR', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'SUP', 'SUB'];
  if (skipElements.includes(node.tagName)) {
    console.log(`Skipping ID assignment for ${node.tagName} element`);
    return;
  }
  
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
    // NEW: Determine proper numerical ID based on position
    if (referenceNode && typeof insertAfter === "boolean") {
      node.id = generateInsertedNodeId(referenceNode, insertAfter);
      console.log(`Assigned new id ${node.id} based on reference insertion direction.`);
    } else {
      // Find the node's position in the DOM and assign appropriate ID
      const beforeId = findPreviousElementId(node);
      const afterId = findNextElementId(node);
      
      node.id = generateIdBetween(beforeId, afterId);
      console.log(`Assigned positional id ${node.id} to node <${node.tagName.toLowerCase()}> (between ${beforeId} and ${afterId})`);
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
    if (
      blockElement.tagName === "BLOCKQUOTE" ||
      blockElement.tagName === "PRE"
    ) {
      event.preventDefault(); // Prevent default Enter behavior

      // If this is the third consecutive Enter press, we either exit or split the block
      if (enterCount >= 3) {
        // Determine if the cursor is effectively at the end of the block.
        const rangeToEnd = document.createRange();
        rangeToEnd.setStart(range.endContainer, range.endOffset);
        rangeToEnd.setEndAfter(blockElement);
        const contentAfterCursor = rangeToEnd.cloneContents();
        const isEffectivelyAtEnd =
          contentAfterCursor.textContent.replace(/\u200B/g, "").trim() === "";

        // --- PATH A: User is at the end of the block (Exit Logic) ---
        if (isEffectivelyAtEnd) {
          console.log("Exiting block from the end.");
          let targetElement = blockElement;
          if (
            blockElement.tagName === "PRE" &&
            blockElement.querySelector("code")
          ) {
            targetElement = blockElement.querySelector("code");
          }

          while (targetElement.lastChild) {
            const last = targetElement.lastChild;
            if (last.nodeName === "BR") {
              targetElement.removeChild(last);
            } else if (
              last.nodeType === Node.TEXT_NODE &&
              last.textContent.replace(/\u200B/g, "").trim() === ""
            ) {
              targetElement.removeChild(last);
            } else {
              break;
            }
          }

          if (targetElement.innerHTML.trim() === "") {
            targetElement.innerHTML = "<br>";
          }
          if (blockElement.id) {
            queueNodeForSave(blockElement.id, "update");
          }
          const newParagraph = createAndInsertParagraph(
            blockElement,
            chunkContainer,
            null,
            selection
          );
          setTimeout(() => {
            newParagraph.scrollIntoView({ behavior: "auto", block: "nearest" });
          }, 10);
        } else {
          // --- PATH B: User is in the middle of the block (Split Logic) ---
          console.log("Splitting block from the middle.");

          // 1. Extract content from cursor to end.
          const contentToMove = rangeToEnd.extractContents();

          // 2. Get the correct element to clean up (the <blockquote> or <code> tag)
          let firstBlockTarget = blockElement;
          if (
            blockElement.tagName === "PRE" &&
            blockElement.querySelector("code")
          ) {
            firstBlockTarget = blockElement.querySelector("code");
          }

          // 3. Robustly clean up ALL trailing <br>s and whitespace from the first block.
          while (firstBlockTarget.lastChild) {
            const last = firstBlockTarget.lastChild;
            if (last.nodeName === "BR") {
              firstBlockTarget.removeChild(last);
            } else if (
              last.nodeType === Node.TEXT_NODE &&
              last.textContent.replace(/\u200B/g, "").trim() === ""
            ) {
              firstBlockTarget.removeChild(last);
            } else {
              break;
            }
          }
          if (firstBlockTarget.innerHTML.trim() === "") {
            firstBlockTarget.innerHTML = "<br>";
          }
          if (blockElement.id) {
            queueNodeForSave(blockElement.id, "update");
          }

          // 4. Create the new paragraph and the new block for the split content
          const newParagraph = document.createElement("p");
          newParagraph.innerHTML = "<br>";
          const newSplitBlock = document.createElement(blockElement.tagName);

          // 5. Populate the new block, intelligently unwrapping the fragment.
          let targetForMovedContent = newSplitBlock;
          if (newSplitBlock.tagName === "PRE") {
            const newCode = document.createElement("code");
            newSplitBlock.appendChild(newCode);
            targetForMovedContent = newCode;
          }
          let sourceOfNodes = contentToMove;
          const wrapperNode = contentToMove.querySelector("blockquote, pre");
          if (wrapperNode) {
            if (wrapperNode.tagName === "PRE") {
              sourceOfNodes = wrapperNode.querySelector("code") || wrapperNode;
            } else {
              sourceOfNodes = wrapperNode;
            }
          }
          Array.from(sourceOfNodes.childNodes).forEach((child) => {
            targetForMovedContent.appendChild(child);
          });

          // 6. ***REWRITTEN*** Robustly clean up all leading junk from the new block.
          while (targetForMovedContent.firstChild) {
            const first = targetForMovedContent.firstChild;

            // If it's a <br>, remove it and check the next node.
            if (first.nodeName === "BR") {
              targetForMovedContent.removeChild(first);
              continue;
            }

            // If it's a text node, check if it's effectively empty.
            if (first.nodeType === Node.TEXT_NODE) {
              // Check for emptiness (ZWS and whitespace)
              if (first.nodeValue.replace(/\u200B/g, "").trim() === "") {
                // This node is junk, remove it and check the next one.
                targetForMovedContent.removeChild(first);
                continue;
              } else {
                // This is the first REAL content. Trim leading whitespace from it.
                first.nodeValue = first.nodeValue.replace(/^\s+/, "");
                // We are done cleaning, so exit the loop.
                break;
              }
            }

            // If we reach here, it's a non-text, non-BR element (e.g. <span>).
            // This is content, so we stop cleaning.
            break;
          }

          // 7. Generate IDs and insert into the DOM
          const nextSibling = blockElement.nextElementSibling;
          const nextSiblingId = nextSibling ? nextSibling.id : null;
          newParagraph.id = generateIdBetween(blockElement.id, nextSiblingId);
          newSplitBlock.id = generateIdBetween(newParagraph.id, nextSiblingId);
          blockElement.after(newParagraph, newSplitBlock);

          // 8. Save new elements and position cursor
          queueNodeForSave(newParagraph.id, "create");
          queueNodeForSave(newSplitBlock.id, "create");
          moveCaretTo(newParagraph, 0);
          newParagraph.scrollIntoView({ behavior: "auto", block: "center" });
        }

        enterCount = 0; // Reset enter count after action
      } else {
        // This is the original logic for 1st/2nd Enter press (inserting a <br>)
        // It remains unchanged.
        let targetElement = range.startContainer;
        let insertTarget = blockElement;

        if (blockElement.tagName === "PRE") {
          const codeElement = blockElement.querySelector("code");
          if (codeElement) {
            insertTarget = codeElement;
          }
        }

        const br = document.createElement("br");
        range.insertNode(br);
        const textNode = document.createTextNode("\u200B");
        range.setStartAfter(br);
        range.insertNode(textNode);
        moveCaretTo(textNode, 0);
        blockElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      return; // Stop further execution
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
 * Handle normal (non-mass) paste events
 */
function handleNormalPaste(event, chunkElement, plainText, htmlContent) {
  
  // For regular pastes, we'll handle them ourselves to ensure clean content
  event.preventDefault(); // Prevent default paste behavior
  
  if (!chunkElement) {
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
      const remainingParagraphs = Array.from(tempDiv.children).slice(1);
      
      remainingParagraphs.forEach((el, index) => {
        const newP = document.createElement('p');
        newP.innerHTML = el.innerHTML;
        
        // Use generateIdBetween logic instead of getNextDecimalForBase
        const beforeId = insertAfter.id;
        const afterElement = insertAfter.nextElementSibling;
        const afterId = afterElement ? afterElement.id : null;
        
        newP.id = generateIdBetween(beforeId, afterId);
        
        // Insert after the previous paragraph
        if (insertAfter.nextSibling) {
          chunk.insertBefore(newP, insertAfter.nextSibling);
        } else {
          chunk.appendChild(newP);
        }
        insertAfter = newP;
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
        queueNodeForSave(el.id, 'add');
      });
    }
    
    // Always save the current paragraph
    if (paragraph && paragraph.id) {
      console.log(`Saving current paragraph after paste: ${paragraph.id}`);
      queueNodeForSave(paragraph.id, 'update');
    }
    
    // Log the final state
    console.log('DOM AFTER PASTE PROCESSING:', {
      newElements: newElements.length,
      currentParagraph: paragraph.id
    });
  }, 100);
}


/**
 * Main paste event handler that delegates to specialized handlers
 * based on the content type
 */
/**
 * Main paste event handler that cleans up pasted content and delegates to specialized handlers
 */

/**
 * Updated main paste handler with mass paste detection
 */
async function handlePaste(event) {
  // ——————————————————————————————————————————————
  // 1) Prevent double-handling
  if (pasteHandled) return;
  pasteHandled = true;
  setTimeout(() => { pasteHandled = false; }, 0);

  // 2) Pull out plain-text, HTML, and your estimate
  const plainText    = event.clipboardData.getData('text/plain');
  const htmlContent  = event.clipboardData.getData('text/html');
  
  // 3) Pass the right content into your estimate
  const estimatedNodes = estimatePasteNodeCount(
    htmlContent && htmlContent.trim() ? htmlContent : plainText
  );

  console.log('PASTE EVENT:', {
    length: plainText.length,
    hasHTML: !!htmlContent,
    estimatedNodes
  });

  // 3) Try hypercite paste
  if (handleHypercitePaste(event)) {
    return; // hypercite handled it
  }

  // 4) Try code-block paste
  const chunk = getCurrentChunk();
  const chunkElement = chunk
    ? document.querySelector(`[data-chunk-id="${chunk}"],[id="${chunk}"]`)
    : null;
  if (handleCodeBlockPaste(event, chunkElement)) {
    return; // code block handled it
  }

  // 5) SMALL-PASTE EARLY EXIT
  //    If it’s small enough, let the browser do its native paste
  const SMALL_NODE_LIMIT = 20;
  let actualNodeCount = estimatedNodes;

  if (htmlContent) {
    // count real element nodes in the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');
    actualNodeCount = doc.body.querySelectorAll('*').length;
  }

  if (
    (htmlContent  && actualNodeCount  <= SMALL_NODE_LIMIT) ||
    (!htmlContent && estimatedNodes <= SMALL_NODE_LIMIT)
  ) {
    console.log(
      `Small paste (≈${actualNodeCount} nodes); ` +
      `deferring to native contentEditable paste.`
    );
    return; // no event.preventDefault() → browser handles it
  }

  // 6) HEAVY LIFTING FOR LARGE PASTE
  //    Now we know it’s a “large” paste, so do your JSON/chunk logic.
  const insertionPoint = getInsertionPoint(chunkElement);
  await handleJsonPaste(event, insertionPoint, plainText);
  const loader = initializeMainLazyLoader();
  await loader.refresh();
}


function getInsertionPoint(chunkElement) {
  console.log('=== getInsertionPoint START ===');
  
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  const currentNode = range.startContainer;
  
  console.log('Selection details:', {
    currentNode: currentNode,
    nodeType: currentNode.nodeType,
    textContent: currentNode.textContent?.substring(0, 50)
  });
  
  // Find the current node element (handle text nodes)
  let currentNodeElement = currentNode.nodeType === Node.TEXT_NODE 
    ? currentNode.parentElement 
    : currentNode;
  
  console.log('Initial currentNodeElement:', {
    element: currentNodeElement,
    id: currentNodeElement?.id,
    tagName: currentNodeElement?.tagName
  });
  
  // Traverse up to find parent with numerical ID (including decimals)
  while (currentNodeElement && currentNodeElement !== chunkElement) {
    const id = currentNodeElement.id;
    console.log('Checking element:', {
      element: currentNodeElement,
      id: id,
      tagName: currentNodeElement.tagName,
      matchesRegex: id && /^\d+(\.\d+)*$/.test(id)
    });
    
    // Check if ID exists and is numerical (including decimals)
    if (id && /^\d+(\.\d+)*$/.test(id)) {
      console.log('Found target element with numerical ID:', id);
      break; // Found our target element
    }
    
    // Move up to parent
    currentNodeElement = currentNodeElement.parentElement;
  }
  
  // If we didn't find a numerical ID, we might be at chunk level or need fallback
  if (!currentNodeElement || !currentNodeElement.id || !/^\d+(\.\d+)*$/.test(currentNodeElement.id)) {
    console.warn('Could not find parent element with numerical ID');
    return null;
  }
  
  const currentNodeId = currentNodeElement.id;
  const chunkId = chunkElement.dataset.chunkId || chunkElement.id;
  
  console.log('Found current node:', {
    currentNodeId,
    chunkId,
    element: currentNodeElement
  });
  
  // Current node becomes the beforeNodeId (we're inserting after it)
  const beforeNodeId = currentNodeId;
  
  // Find the next element with a numerical ID (this is the afterNodeId)
  let afterElement = currentNodeElement.nextElementSibling;
  console.log('Starting search for afterElement from:', afterElement);
  
  while (afterElement) {
    console.log('Examining potential afterElement:', {
      element: afterElement,
      id: afterElement.id,
      tagName: afterElement.tagName,
      hasNumericalId: afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)
    });
    
    if (afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)) {
      console.log('Found afterElement with numerical ID:', afterElement.id);
      break;
    }
    
    afterElement = afterElement.nextElementSibling;
  }
  
  const afterNodeId = afterElement?.id || null;
  
  console.log('Final before/after determination:', {
    beforeNodeId,
    afterNodeId,
    afterElement: afterElement
  });
  
  // Use existing chunk tracking
  const currentChunkNodeCount = chunkNodeCounts[chunkId] || 0;
  
  const result = {
    chunkId: chunkId,
    currentNodeId: currentNodeId,
    beforeNodeId: beforeNodeId,
    afterNodeId: afterNodeId,
    currentChunkNodeCount: currentChunkNodeCount,
    insertionStartLine: parseInt(currentNodeId), // startLine = node ID
    book: book // Available as const
  };
  
  console.log('=== getInsertionPoint RESULT ===', result);
  return result;
}

// (1) change convertToJsonObjects to return both the list
//     and the final state it left off in

function convertToJsonObjects(textBlocks, insertionPoint) {
  console.log('=== convertToJsonObjects START ===');
  const jsonObjects = [];

  let currentChunkId       = insertionPoint.chunkId;
  let nodesInCurrentChunk  = insertionPoint.currentChunkNodeCount;
  let beforeId             = insertionPoint.beforeNodeId;
  const afterId            = insertionPoint.afterNodeId;

  textBlocks.forEach((block) => {
    // rotate chunk?
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId      = getNextIntegerId(currentChunkId);
      nodesInCurrentChunk = 0;
    }

    // new node id
    const newNodeId = getNextIntegerId(beforeId);

    const trimmed     = block.trim();
    const htmlContent = convertTextToHtml(trimmed, newNodeId);

    const key = `${insertionPoint.book},${newNodeId}`;
    jsonObjects.push({
      [key]: {
        content:   htmlContent,
        startLine: parseFloat(newNodeId),
        chunk_id:  parseFloat(currentChunkId)
      }
    });

    // advance
    beforeId            = newNodeId;
    nodesInCurrentChunk++;
  });

  console.log('=== convertToJsonObjects END ===');
  return {
    jsonObjects,
    state: {
      currentChunkId,
      nodesInCurrentChunk,
      beforeId
    }
  };
}



function getNextChunkId(currentChunkId) {
  console.log('Finding next chunk ID after:', currentChunkId);
  
  // Get all elements with data-chunk-id attribute
  const elementsWithChunkId = document.querySelectorAll('[data-chunk-id]');
  console.log('Found elements with data-chunk-id:', elementsWithChunkId.length);
  
  // Extract and filter numerical chunk IDs
  const allChunkIds = Array.from(elementsWithChunkId)
    .map(el => el.dataset.chunkId)
    .filter(id => id && /^\d+(\.\d+)*$/.test(id)) // Only numerical chunk IDs
    .filter((id, index, arr) => arr.indexOf(id) === index) // Remove duplicates
    .sort((a, b) => parseFloat(a) - parseFloat(b)); // Sort numerically
  
  console.log('All existing chunk IDs:', allChunkIds);
  
  // Find the next chunk ID after currentChunkId
  const currentNum = parseFloat(currentChunkId);
  const nextChunk = allChunkIds.find(id => parseFloat(id) > currentNum);
  
  console.log('Next chunk ID found:', nextChunk || 'null');
  return nextChunk || null;
}


function convertTextToHtml(text, nodeId) {
  // Your existing conversion logic, but wrap in <p> with ID
  const processedText = text; // Whatever processing you do
  return `<p id="${nodeId}">${processedText}</p>`;
}

/**
 * 1) Assumes you have this helper already defined:
 *    async function getNodeChunksAfter(book, afterNodeId) { … }
 *
 * 2) Your convertToJsonObjects(textBlocks, insertionPoint) must
 *    produce an array of objects like:
 *      [ { "Book,2": { content, startLine: 2, chunk_id: 1 } }, … ]
 *
 * 3) This function merges them, renumbers the "tail", and logs the result.
 */
async function handleJsonPaste(event, insertionPoint, pastedText) {
  event.preventDefault();
  const { book, afterNodeId } = insertionPoint;

  // split into text blocks
  const textBlocks = pastedText
    .split(/\n\s*\n/)
    .filter((blk) => blk.trim());
  if (!textBlocks.length) return [];

  // run through convertToJsonObjects
  const {
    jsonObjects: newJsonObjects,
    state: {
      currentChunkId: startChunkId,
      nodesInCurrentChunk: startNodeCount
    }
  } = convertToJsonObjects(textBlocks, insertionPoint);

  // If there's no afterNodeId, we're at the end of the doc → just return the new ones
  if (afterNodeId == null) {
    console.log(
      "📌 No afterNodeId — pasting at end; skipping tail renumbering."
    );
    console.log("✅ Final merged JSON objects:", newJsonObjects);
    return newJsonObjects;
  }

  // find highest startLine so far
  const newLines   = newJsonObjects.map((o) => {
    const k = Object.keys(o)[0];
    return o[k].startLine;
  });
  const maxNewLine = Math.max(...newLines);

  // grab the existing chunks
  const existingChunks = await getNodeChunksAfter(book, afterNodeId);

  // renumber the tail, carrying on the same chunk logic
  let currentChunkId      = startChunkId;
  let nodesInCurrentChunk = startNodeCount;

  const tailJsonObjects = existingChunks.map((chunk, idx) => {
    // rotate chunk?
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId      = getNextIntegerId(currentChunkId);
      nodesInCurrentChunk = 0;
    }

    // we _do_ want to keep sequential node IDs
    const newStart = maxNewLine + idx + 1;

    // rewrite the HTML so its id= matches newStart
    const updatedContent = chunk.content.replace(
      /id="[^"]*"/,
      `id="${newStart}"`
    );

    const key = `${book},${newStart}`;
    const obj = {
      [key]: {
        content:   updatedContent,
        startLine: newStart,
        chunk_id:  parseFloat(currentChunkId)
      }
    };

    nodesInCurrentChunk++;
    return obj;
  });

  const merged = [...newJsonObjects, ...tailJsonObjects];
  console.log("✅ Final merged JSON objects:", merged);

  const tailKey = insertionPoint.afterNodeId;

  // 1) delete old tail for this book only
  if (tailKey != null) {
    await deleteNodeChunksAfter(book, tailKey);
  }

  // 2) prepare a flat array for writeNodeChunks
  const toWrite = merged.map((obj) => {
    const key   = Object.keys(obj)[0];      // "book,57"
    const [ , startLineStr ] = key.split(',');
    const { content, chunk_id } = obj[key];
    return {
      book,
      startLine: parseFloat(startLineStr),
      chunk_id,
      content
    };
  });

  // 3) bulk‐write new + renumbered nodes
  await writeNodeChunks(toWrite);

  console.log("📦 IndexedDB has been updated!");
  return merged;
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
      queueNodeForSave(blockElement.id, 'update');
    }
  }
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
    queueNodeForSave(codeBlock.id, 'update');

    return true;
  }

  return false;
}




/**
 * Estimate how many nodes a paste operation will create
 */
/**
 * Estimate how many nodes a paste operation will create
 */
function estimatePasteNodeCount(content) {
  if (typeof content !== 'string') {
    return 1
  }

  // Quick & dirty HTML detection
  const isHTML = /<([a-z]+)(?:\s[^>]*)?>/i.test(content)

  if (isHTML) {
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = content

    let count = 0

    // Count block-level elements
    count +=
      tempDiv.querySelectorAll(
        'p, h1, h2, h3, h4, h5, h6, div, pre, blockquote, li'
      ).length

    // Count <br> as its own node
    count += tempDiv.querySelectorAll('br').length

    // Count top-level text fragments as paragraphs
    tempDiv.childNodes.forEach(node => {
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.textContent.trim()
      ) {
        const paras = node.textContent
          .split(/\n\s*\n/) // split on blank lines
          .filter(p => p.trim())
        count += paras.length
      }
    })

    return Math.max(1, count)
  } else {
    // Plain text: first try splitting on blank lines
    const paragraphs = content
      .split(/\n\s*\n/)
      .filter(p => p.trim())

    if (paragraphs.length > 1) {
      return paragraphs.length
    }

    // Fallback: split on every newline
    const lines = content
      .split('\n')
      .filter(line => line.trim())

    return Math.max(1, lines.length)
  }
}


