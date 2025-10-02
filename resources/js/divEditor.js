import { book } from "./app.js";
import { getCurrentUserId } from "./auth.js";
import { 
  updateIndexedDBRecord, 
  deleteIndexedDBRecordWithRetry,
  batchDeleteIndexedDBRecords,
  openDatabase,
  updateCitationForExistingHypercite,
  batchUpdateIndexedDBRecords,
  getNodeChunksAfter,
  deleteNodeChunksAfter,
  writeNodeChunks
          } from "./cache-indexedDB.js";
import { 
  withPending,
  chunkOverflowInProgress,
  currentObservedChunk,
  setCurrentObservedChunk,
  hypercitePasteInProgress,
  keyboardLayoutInProgress,
  isProgrammaticUpdateInProgress,
  isPasteInProgress
} from './operationState.js';

import { showSpinner, showTick, isProcessing } from './editIndicator.js';

import { buildBibtexEntry } from "./bibtexProcessor.js";
import { generateIdBetween,
         setElementIds,
         isNumericalId,
         ensureNodeHasValidId,
          } from "./IDfunctions.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from './convert-markdown.js';

import { 
  trackChunkNodeCount, 
  handleChunkOverflow, 
  NODE_LIMIT, 
  chunkNodeCounts,
  getCurrentChunk
} from './chunkManager.js';
import { isPasteOperationActive } from './paste.js';
import { isChunkLoadingInProgress, getLoadingChunkId } from './chunkLoadingState.js';
import { SelectionDeletionHandler } from './selectionDelete.js';
import { initializeMainLazyLoader } from './initializePage.js';
import { getEditToolbar } from './editToolbar.js';
import { delinkHypercite, handleHyperciteDeletion } from './hyperCites.js';
import { checkAndInvalidateTocCache, invalidateTocCacheForDeletion } from './toc.js';




export let movedNodesByOverflow = new Set();
// Tracking sets
const modifiedNodes = new Set(); // Track element IDs whose content was modified.
const addedNodes = new Set(); // Track newly-added element nodes.
const removedNodeIds = new Set(); // Track IDs of removed nodes.

let observer;
let documentChanged = false;
let debounceTimer = null;
let spanCleanupInterval;

let observedChunks = new Map(); // chunkId -> chunk element
let deletionHandler = null;

let isObserverRestarting = false;
let selectionChangeDebounceTimer = null;



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
  nodes: new Map(),
  deletions: new Set(),                   
  lastActivity: null          
};



/**
 * Creates a debounced function that delays invoking `func` until after `delay`
 * milliseconds have passed since the last time the debounced function was invoked.
 *
 * This version includes a `.cancel()` method to cancel a pending invocation.
 *
 * @param {Function} func The function to debounce.
 * @param {number} delay The number of milliseconds to delay.
 * @returns {Function} The new debounced function with a `.cancel()` method.
 */
// In your utility file (e.g., divEditor.js)

export function debounce(func, delay) {
  let timeoutId;
  // ✅ NEW: Variables to store the context and arguments of the last call
  let lastArgs;
  let lastThis;

  const debouncedFunction = function (...args) {
    // Store the context and arguments from the most recent call
    lastThis = this;
    lastArgs = args;

    // Clear the previous timeout to reset the delay timer
    clearTimeout(timeoutId);

    // Set a new timeout
    timeoutId = setTimeout(() => {
      // When the timeout completes, call the original function
      // with the arguments from the last call.
      func.apply(lastThis, lastArgs);
      // Reset after execution
      timeoutId = null;
    }, delay);
  };

  // This function cancels the pending debounced call
  debouncedFunction.cancel = function () {
    clearTimeout(timeoutId);
    timeoutId = null; // Reset the timer ID
  };

  // ✅ NEW: This function immediately executes the pending debounced call
  debouncedFunction.flush = function () {
    // If there's a pending timeout...
    if (timeoutId) {
      // ...cancel the scheduled execution...
      clearTimeout(timeoutId);
      timeoutId = null;
      // ...and immediately call the function with the last-saved arguments.
      func.apply(lastThis, lastArgs);
    }
  };

  return debouncedFunction;
}

// Specialized debounced functions
const debouncedSaveNode = debounce(saveNodeToDatabase, DEBOUNCE_DELAYS.SAVES, 'saves');
const debouncedBatchDelete = debounce(processBatchDeletions, DEBOUNCE_DELAYS.SAVES, 'deletions');
// ================================================================
// SAVE QUEUE MANAGEMENT
// ================================================================

async function processBatchDeletions() {
  if (pendingSaves.deletions.size === 0) return;
  
  const nodeIdsToDelete = Array.from(pendingSaves.deletions);
  pendingSaves.deletions.clear();
  
  console.log(`🗑️ Batch deleting ${nodeIdsToDelete.length} nodes`);
  
  try {
    // Batch delete from IndexedDB
    await batchDeleteIndexedDBRecords(nodeIdsToDelete);
    
    console.log(`✅ Batch deleted ${nodeIdsToDelete.length} nodes`);

    setTimeout(() => {
      ensureMinimumDocumentStructure();
    }, 100);
  } catch (error) {
    console.error('❌ Error in batch deletion:', error);
    // Re-queue failed deletions
    nodeIdsToDelete.forEach(id => pendingSaves.deletions.add(id));
  }
}

// Add node to pending saves queue
export function queueNodeForSave(nodeId, action = 'update') {
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
  
  const updates = nodesToSave.filter(n => n.action === 'update');
  const additions = nodesToSave.filter(n => n.action === 'add');
  const deletions = nodesToSave.filter(n => n.action === 'delete');
  
  try {
    const recordsToUpdate = [...updates, ...additions].filter(node => {
      const element = document.getElementById(node.id);
      if (!element) {
        console.warn(`⚠️ Skipping save for node ${node.id} - element not found in DOM`);
        return false;
      }
      // We need to pass the element itself or enough info for batchUpdate to find it.
      // The current structure { id, action } is what batchUpdateIndexedDBRecords expects.
      return true;
    });

    if (recordsToUpdate.length > 0) {
      // This function now correctly saves to IndexedDB AND queues the changes
      // for the master debounced sync in cache-indexedDB.js.
      await batchUpdateIndexedDBRecords(recordsToUpdate);
    }
    
    if (deletions.length > 0) {
      // This function also correctly queues deletions.
      await Promise.all(deletions.map(node => 
        deleteIndexedDBRecordWithRetry(node.id)
      ));
    }
    
    // CRITICAL: There should be NO other sync calls here.
    // The functions above handle all necessary queuing.
    
  } catch (error) {
    console.error('❌ Error in batch save:', error);
    // Re-queue failed saves
    nodesToSave.forEach(node => pendingSaves.nodes.set(node.id, node));
    // Note: Error handling for IndexedDB save failures is handled by the debounced sync
  }
  
  // Note: showTick() removed - now only shows green after successful server sync in debouncedMasterSync
}


// ================================================================
// ACTIVITY MONITORING
// ================================================================

// Monitor pending saves and log activity
setInterval(() => {
  const now = Date.now();
  const timeSinceLastActivity = pendingSaves.lastActivity ? now - pendingSaves.lastActivity : null;
  
  if (pendingSaves.nodes.size > 0 || pendingSaves.deletions.size > 0 ) {
    console.log(`📊 Pending saves: ${pendingSaves.nodes.size} nodes, ${pendingSaves.deletions.size} deletions (${timeSinceLastActivity}ms since last activity)`);
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

  // ADD THIS: Execute deletions immediately
  if (pendingSaves.deletions.size > 0) {
    processBatchDeletions();
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

  ensureMinimumDocumentStructure();


  // Initialize tracking for all current chunks
  initializeCurrentChunks(editableDiv);

  enterKeyHandler = new EnterKeyHandler();

  // 🔥 PERIODIC SPAN ANNIHILATION - runs every 3 seconds
  function periodicSpanCleanup() {
    const spans = document.querySelectorAll('span[style]');
    if (spans.length > 0) {
      console.log(`🔥 PERIODIC CLEANUP: Found ${spans.length} styled spans to destroy`);
      spans.forEach(span => {
        console.log(`🔥 PERIODIC: Destroying span with style`, span);
        
        // Preserve text content but remove the span wrapper
        if (span.textContent.trim()) {
          const textNode = document.createTextNode(span.textContent);
          if (span.parentNode && document.contains(span.parentNode)) {
            span.parentNode.insertBefore(textNode, span);
          }
        }
        
        if (document.contains(span)) {
          span.remove();
        }
      });
    }
  }

  // Start periodic cleanup
  if (spanCleanupInterval) {
    clearInterval(spanCleanupInterval);
  }
  spanCleanupInterval = setInterval(periodicSpanCleanup, 3000);

  // Create observer for the main-content container
  observer = new MutationObserver(async (mutations) => {

    if (isPasteInProgress()) {
      console.log("🚫 Skipping mutations: Paste operation is in control.");
      return;
    }

    if (isProgrammaticUpdateInProgress()) {
      console.log("Skipping mutations: Programmatic update in progress.");
      return;
    }

    // When to NOT observe:
    if (hypercitePasteInProgress) {
      console.log("Skipping mutations during hypercite paste");
      return;
    }

    if (isChunkLoadingInProgress()) {
      console.log(`Skipping mutations during chunk loading for chunk ${getLoadingChunkId()}`);
      return;
    }

    const toolbar = getEditToolbar();
    if (toolbar && toolbar.isFormatting) {
      console.log("Skipping mutations during formatting");
      return;
    }


     if (keyboardLayoutInProgress) {
      console.log("Skipping mutations during keyboard layout adjustment");
      return;
    }
  
    if (shouldSkipMutation(mutations)) {
      console.log("Skipping mutations related to status icons");
      return;
    }

    // Filter to ignore mutations outside of <div class="chunk">
    const chunkMutations = filterChunkMutations(mutations);
    
    if (chunkMutations.length > 0) {
      await processMutationsByChunk(chunkMutations);
    }
  });

  
  // COMMENTED OUT FOR TESTING - SelectionDeletionHandler might be causing incorrect deletions
  // deletionHandler = new SelectionDeletionHandler(editableDiv, {
  //   onDeleted: (nodeId) => {
  //     console.log(`Selection deletion handler queueing: ${nodeId}`);
  //     pendingSaves.deletions.add(nodeId);
  //     debouncedBatchDelete();
  //   }
  // });

  // Observe the main-content/editableDiv container
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
  
  return chunks;
}

// Filter mutations to only include those within .chunk elements
function filterChunkMutations(mutations) {
  const filteredMutations = [];
  
  mutations.forEach(mutation => {
    // Check if mutation target is within a chunk (not a sentinel)
    const chunk = findContainingChunk(mutation.target);

    console.log("Mutation target:", mutation.target);
    console.log("Found chunk:", chunk);
    console.log("Mutation type:", mutation.type);
    
    // If we found a chunk, include the mutation
    if (chunk !== null) {


      if (mutation.type === 'childList') {
        const isOnlyHighlightNodes = (nodeList) => {
          if (nodeList.length === 0) return false; // Not this type of mutation
          // Check if every node in the list is either a MARK tag or a plain text node.
          return Array.from(nodeList).every(
            (node) => node.nodeName === 'MARK' || node.nodeType === Node.TEXT_NODE
          );
        };

        // If the only things added/removed were MARK tags (and their text), ignore it.
        if (isOnlyHighlightNodes(mutation.addedNodes) || isOnlyHighlightNodes(mutation.removedNodes)) {
          console.log("✍️ Ignoring MARK tag mutation in divEditor, handled by hyperLights.js.");
          return; // Exit this iteration of forEach, do not add to filteredMutations.
        }
      }
      
      filteredMutations.push(mutation);
      return;
    }
    
    // Special case: Check for deletion of chunks
    if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
      const chunkDeletions = Array.from(mutation.removedNodes).filter(node => 
        node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('chunk')
      );
      
      if (chunkDeletions.length > 0) {
        // *** ADD THE GUARD HERE ***
        if (chunkOverflowInProgress) {
            console.log(`⚠️ Skipping direct chunk deletion handling (DB) because chunk overflow is in progress.`);
            // DO NOT process deletion here. `handleChunkOverflow` will manage the DB state for these nodes.
            // Still push the mutation if you need `processChunkMutations` to see the DOM change,
            // but `processChunkMutations` should also ignore it for specific IDs.
            // We push the mutation to `filteredMutations` below this `if` block.
        } else {
            // *** ORIGINAL DELETION LOGIC (ONLY IF NO OVERFLOW) ***
        console.log('Detected chunk deletion(s):', chunkDeletions);
        
        // For each deleted chunk, handle deletion of numerical ID nodes directly
        chunkDeletions.forEach(deletedChunk => {
          const numericalIdNodes = findNumericalIdNodesInChunk(deletedChunk);
          
          if (numericalIdNodes.length > 0) {
            console.log('Deleting numerical ID nodes from IndexedDB:', numericalIdNodes);
            
            // Directly delete each numerical ID node from IndexedDB
            numericalIdNodes.forEach(node => {
              console.log(`Queueing node ${node.id} for batch deletion (chunk removal)`);
              pendingSaves.deletions.add(node.id);
            });
            debouncedBatchDelete();
          }
        });

    }
        
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
      setTimeout(async () => {
        // By wrapping this in a timeout, we yield to the main thread,
      // allowing the browser to render the typed character immediately.
      // This makes the UI feel much snappier during fast typing.
      await processChunkMutations(chunk, chunkMutations);
    }, 0);
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

  // *** CRITICAL ADDITION HERE ***
  // If chunk overflow is in progress, handle it directly and prevent other mutation processing
  if (chunkOverflowInProgress) {
    const isRemovalMutation = mutations.some(m => m.type === "childList" && m.removedNodes.length > 0);
    const isAddedMutation = mutations.some(m => m.type === "childList" && m.addedNodes.length > 0);
    
    if (isRemovalMutation) {
        console.log(`⚠️ Skipping mutation processing for chunk ${chunkId} during chunk overflow (due to removal).`);
        return; // Prevents deleted nodes from being queued for batch deletion
    }
  
  }
  

  // Only show spinner if we're not already processing
  if (!isProcessing) {  // ← ADD THIS CHECK
    showSpinner();
  }
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


          // **** ADD THIS CHECK HERE ****
          if (node.id && movedNodesByOverflow.has(node.id)) {
            console.log(`🗑️ Skipping deletion for node ${node.id} as it's handled by chunk overflow.`);
            movedNodesByOverflow.delete(node.id); // Remove it from the set once it's seen here
            continue; // Skip the rest of the deletion logic for this node
          }
          // *****************************

          // 🆕 ADD THIS: Check for hypercite removals
          await handleHyperciteRemoval(node);

          // Check if this is a top-level paragraph/heading being removed
          if (node.id && node.id.match(/^\d+(\.\d+)?$/)) {
            console.log(`🗑️ Attempting to delete node ${node.id} from IndexedDB`);

            // For deletions, we can't check tagName since node is removed, so invalidate cache for any numerical ID deletion
            invalidateTocCacheForDeletion(node.id);

            // Check if this is the last node in the chunk 
            const remainingNodes = chunk.querySelectorAll('[id]').length;
            console.log(`Chunk ${chunkId} has ${remainingNodes} remaining nodes after this deletion`);
            
            if (remainingNodes === 0) {
                console.log(`🚨 Last node ${node.id} being deleted from chunk ${chunkId}`);
                
                // Delete immediately and restore structure
                deleteIndexedDBRecordWithRetry(node.id).then(() => {
                  ensureMinimumDocumentStructure();
                });
                
                return;
              } else {
              // Normal deletion for non-last nodes
              console.log(`🗑️ Queueing node ${node.id} for batch deletion`);
              pendingSaves.deletions.add(node.id);
              removedNodeIds.add(node.id);
              debouncedBatchDelete();
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
    
    // 🔥 Handle attribute mutations that might be creating styled elements
    if (mutation.type === "attributes" && mutation.target.nodeType === Node.ELEMENT_NODE) {
      const element = mutation.target;
      
      // If a SPAN gets a style attribute, destroy it immediately
      if (element.tagName === 'SPAN' && mutation.attributeName === 'style') {
        console.log(`🔥 DESTROYING SPAN that gained style attribute`, element);
        
        // Preserve text content but remove the span wrapper
        if (element.textContent.trim()) {
          const textNode = document.createTextNode(element.textContent);
          if (element.parentNode && document.contains(element.parentNode)) {
            element.parentNode.insertBefore(textNode, element);
          }
        }
        
        if (document.contains(element)) {
          element.remove();
        }
        continue; // Skip to next mutation
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

    // 2) Process added nodes
    // 2) Process added nodes
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          
          if (node.id && node.id.startsWith('hypercite_')) {
            console.log(`✍️ Ignoring standalone hypercite mutation for ${node.id}. It will be saved with its parent.`);
            return; // Skip to the next node
          }

          // 🔥 BROWSER BULLSHIT ANNIHILATION: Kill spans and styled formatting elements
          if (node.tagName === 'SPAN') {
            console.log(`🔥 DESTROYING SPAN tag - NO SPANS ALLOWED`);
            
            // Preserve text content but remove the span wrapper
            if (node.textContent.trim()) {
              const textNode = document.createTextNode(node.textContent);
              node.parentNode.insertBefore(textNode, node);
            }
            
            node.remove();
            return; // Skip all further processing for this node
          }

          // 🔥 Kill I/B/EM/STRONG tags with suspicious inline styles (browser-generated)
          if (['I', 'B', 'EM', 'STRONG'].includes(node.tagName) && node.style && node.style.length > 0) {
            // Check for browser-generated style patterns
            const hasSuspiciousStyles = node.style.fontSize || 
                                      node.style.fontWeight || 
                                      node.style.letterSpacing ||
                                      node.style.wordSpacing;
            
            if (hasSuspiciousStyles) {
              console.log(`🔥 DESTROYING browser-generated ${node.tagName} with inline styles`);
              
              // Create a clean version without the inline styles but preserve the tag
              const cleanElement = document.createElement(node.tagName.toLowerCase());
              
              // Copy attributes except style
              Array.from(node.attributes).forEach(attr => {
                if (attr.name !== 'style') {
                  cleanElement.setAttribute(attr.name, attr.value);
                }
              });
              
              // Move text content
              cleanElement.textContent = node.textContent;
              
              // Replace the styled element with the clean one
              node.parentNode.insertBefore(cleanElement, node);
              node.remove();
              return; // Skip all further processing for this node
            }
          }

          ensureNodeHasValidId(node);
          documentChanged = true;
          addedNodes.add(node);
          addedCount++;
          newNodes.push(node);
          
          // Check if this affects TOC and invalidate cache if needed
          checkAndInvalidateTocCache(node.id, node);
          
          // If this might be a paste, explicitly queue this node
          if (pasteDetected && node.id) {
            console.log(`Queueing potentially pasted node: ${node.id}`);
            queueNodeForSave(node.id, 'add');
          }
          
          // NEW: Handle formatting elements (bold, italic, etc.)
          if (['B', 'STRONG', 'I', 'EM', 'SPAN'].includes(node.tagName) && !node.id) {
            // This is a formatting element without an ID
            // Queue the parent element that has an ID for update
            let parentWithId = node.parentElement;
            while (parentWithId && !parentWithId.id) {
              parentWithId = parentWithId.parentElement;
            }
            
            if (parentWithId && parentWithId.id) {
              console.log(`Queueing parent ${parentWithId.id} due to formatting change (${node.tagName})`);
              queueNodeForSave(parentWithId.id, 'update');
              modifiedNodes.add(parentWithId.id);
            }
          }
        }
      });
    }
    // 3) Process text changes
    else if (mutation.type === "characterData") {
      let parent = mutation.target.parentNode;
      
      // Find the closest parent with an ID (typically a paragraph)
       while (parent && (!parent.id || !/^\d+(\.\d+)?$/.test(parent.id))) {
        parent = parent.parentNode;
      }
      
      if (parent && parent.id) {
        console.log(`Queueing characterData change in parent: ${parent.id}`);
        
        // Check if this affects TOC and invalidate cache if needed
        checkAndInvalidateTocCache(parent.id, parent);
        
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
  
  // Clean up periodic span cleanup
  if (spanCleanupInterval) {
    clearInterval(spanCleanupInterval);
    spanCleanupInterval = null;
  }

  if (enterKeyHandler) {
    enterKeyHandler.destroy();
    enterKeyHandler = null;
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




// Replace your old selectionchange listener with this one
document.addEventListener("selectionchange", () => {
  // Clear any previous timer
  clearTimeout(selectionChangeDebounceTimer);

  // Set a new timer
  selectionChangeDebounceTimer = setTimeout(() => {
    // The actual logic only runs after 150ms of no selection changes
    if (!window.isEditing || chunkOverflowInProgress || isObserverRestarting) return;

    const toolbar = getEditToolbar();
    if (toolbar && toolbar.isFormatting) {
      return;
    }

    const newChunkId = getCurrentChunk(); // Assumes this gets the ID of the current chunk
    const currentChunkId = currentObservedChunk; // Assumes this is the stored ID string

    // This is the key: we ONLY update the state. We don't restart the observer.
    if (newChunkId && newChunkId !== currentChunkId) {
      console.log(`✅ Chunk focus changed (debounced): ${currentChunkId} → ${newChunkId}`);
      setCurrentObservedChunk(newChunkId);
    }
  }, 150); // 150ms is a good delay to feel responsive but avoid storms
});

document.addEventListener("keydown", function handleTypingActivity(event) {
  if (!window.isEditing) return;

  // 🆕 SIMPLIFIED: Go back to the working Safari version
  if (['Backspace', 'Delete'].includes(event.key)) {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      
      // Check if we're about to delete the last content
      if (checkForImminentEmptyState()) {
        // Check if this deletion would leave us empty
        let willBeEmpty = false;
        
        // Get the element that would be affected
        let targetElement = range.startContainer;
        if (targetElement.nodeType !== Node.ELEMENT_NODE) {
          targetElement = targetElement.parentElement;
        }
        
        // Find the closest element with an ID
        let elementWithId = targetElement.closest('[id]');
        
        if (elementWithId && isNumericalId(elementWithId.id)) {
          // SIMPLIFIED: Back to the original working conditions
          const textContent = elementWithId.textContent || '';
          const isSelectingAll = !range.collapsed && 
            range.toString().trim() === textContent.trim();
          const isAtStartAndEmpty = range.collapsed && 
            range.startOffset === 0 && 
            textContent.trim().length <= 1; // Back to original condition
          
          if (isSelectingAll || isAtStartAndEmpty) {
            willBeEmpty = true;
          }
        }
        
        if (willBeEmpty) {
          console.log('🚨 About to delete last content - preparing new structure');
          
          // Prevent the deletion
          event.preventDefault();
          
          // Use the ORIGINAL working restoration method
          ensureMinimumDocumentStructure();
          
          return;
        }
      }
    }
  }

  // Rest of your existing keydown logic (unchanged)
  pendingSaves.lastActivity = Date.now();
  
 
});

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
      book: bookId,  // This is the keyPath field required by IndexedDB
      citationID: bookId,
      title: "",
      author: await getCurrentUserId() || "anon",
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

      // 1) Update title (truncate to 250 characters to leave room for "..." suffix)
      if (newTitle && newTitle.length > 255) {
        newTitle = newTitle.substring(0, 250) + '...';
      }
      rec.title = newTitle;

      // 2) Update timestamp to mark as recently modified
      rec.timestamp = Date.now();

      // 3) Regenerate the bibtex string so it stays in sync
      rec.bibtex = buildBibtexEntry(rec);

      // 4) Write back the record
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


function createAndInsertParagraph(blockElement, chunkContainer, content, selection) {
  // ==================================================================
  // 1. PROACTIVELY FIX THE SOURCE ELEMENT (THE KEY CHANGE)
  // ==================================================================
  // This ensures the source element has an ID before we try to use it.
  ensureNodeHasValidId(blockElement);
  if (!blockElement.id) {
    console.error("FATAL: Could not assign an ID to the source block element. Aborting paragraph creation.", blockElement);
    return null; // Or handle error appropriately
  }

  // 2. Create the new paragraph
  const newParagraph = document.createElement('p');

  // 3. Handle content (your existing logic is fine here)
  if (content) {
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

  // ==================================================================
  // 4. SIMPLIFIED AND UNIFIED ID GENERATION
  // ==================================================================
  // This logic is now guaranteed to run because we know blockElement.id exists.
  const container = blockElement.closest('.chunk') || blockElement.parentNode;
    
  // Find the next element with a numeric ID (your existing logic is good)
  let nextElement = blockElement.nextElementSibling;
  while (nextElement && (!nextElement.id || !/^\d+(\.\d+)?$/.test(nextElement.id))) {
    nextElement = nextElement.nextElementSibling;
  }
  
  // ALWAYS use setElementIds to set both id and data-node-id
  const nextElementId = nextElement ? nextElement.id : null;
  setElementIds(newParagraph, blockElement.id, nextElementId, book);

  // 5. Insert the paragraph at the correct position in the DOM
  if (blockElement.nextSibling) {
    container.insertBefore(newParagraph, blockElement.nextSibling);
  } else {
    container.appendChild(newParagraph);
  }
  
  console.log(`Created new paragraph with ID ${newParagraph.id} after ${blockElement.id}`);

  // 6. Move cursor and scroll (your existing logic is fine)
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  moveCaretTo(target, 0);
  setTimeout(() => {
    newParagraph.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, 10);

  return newParagraph;
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


class EnterKeyHandler {
  constructor() {
    // State is now instance-specific, not global.
    this.lastKeyWasEnter = false;
    this.enterCount = 0;
    this.lastEnterTime = 0;

    // Bind the event handler to this instance.
    this.handleKeyDown = this.handleKeyDown.bind(this);

    // Attach the listener.
    document.addEventListener("keydown", this.handleKeyDown);
    console.log("✅ EnterKeyHandler initialized.");
  }

  handleKeyDown(event) {
  if (event.key === "Enter" && chunkOverflowInProgress) {
    event.preventDefault();
    console.log("Enter key ignored during chunk overflow processing");
    return;
  }

  if (event.key !== "Enter") {
    this.lastKeyWasEnter = false;
    this.enterCount = 0;
    return;
  }

  const now = Date.now();
  if (this.lastKeyWasEnter && now - this.lastEnterTime < 2000) {
    this.enterCount++;
  } else {
    this.enterCount = 1;
  }

  this.lastKeyWasEnter = true;
  this.lastEnterTime = now;

  console.log("Enter count:", this.enterCount);

  if (window.isEditing) {
    // Get the current selection
    const selection = document.getSelection();
    if (selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

        let currentNode = range.startContainer;
    if (currentNode.nodeType !== Node.ELEMENT_NODE) {
      currentNode = currentNode.parentElement;
    }
    let blockElement = currentNode;
    while (
      blockElement &&
      ![
        "P",
        "DIV",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "LI",
        "BLOCKQUOTE",
        "PRE",
      ].includes(blockElement.tagName)
    ) {
      blockElement = blockElement.parentElement;
    }
    if (!blockElement) return;
    const chunkContainer = blockElement.closest(".chunk");
    if (!chunkContainer) return;
    const isHeading = /^H[1-6]$/.test(blockElement.tagName);
    let isAtStart = false;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      isAtStart =
        range.startOffset === 0 &&
        (range.startContainer === blockElement.firstChild ||
          range.startContainer.parentNode === blockElement.firstChild);
    } else if (range.startContainer === blockElement) {
      isAtStart = range.startOffset === 0;
    }

    if (isHeading && isAtStart) {


          event.preventDefault();

          // PROACTIVELY FIX THE HEADING'S ID
          ensureNodeHasValidId(blockElement);
          if (!blockElement.id) {
            console.error(
              "Could not assign ID to heading. Aborting.",
              blockElement
            );
            return;
          }

          // 1. Create a new paragraph to insert BEFORE the heading
          const newParagraph = document.createElement("p");
          newParagraph.innerHTML = "<br>";

          // 2. Generate ID for the new paragraph
          if (blockElement.id) {
            // Find previous element with numeric ID
            let prevElement = blockElement.previousElementSibling;
            while (
              prevElement &&
              (!prevElement.id || !/^\d+(\.\d+)?$/.test(prevElement.id))
            ) {
              prevElement = prevElement.previousElementSibling;
            }

            // Special case: if heading is ID "1" and no previous element, use "0" as beforeId
            if (!prevElement && blockElement.id === "1") {
              setElementIds(newParagraph, "0", "1", book);
            } else if (prevElement && prevElement.id) {
              // Generate ID between previous and current
              setElementIds(newParagraph, prevElement.id, blockElement.id, book);
            } else {
              // Generate ID before current
              setElementIds(newParagraph, null, blockElement.id, book);
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
                  behavior: "auto",
                  block: "nearest",
                });
              }
            }, 0);
          }

          // The MutationObserver will handle saving both elements

          this.enterCount = 0;
          return;
        }

        // ==========================================================================
        // SECTION 1: REWRITTEN special handling for paragraph elements
        // ==========================================================================
        if (blockElement.tagName === "P") {
          event.preventDefault();

          // --- PATH A: User wants a line break (Shift+Enter) ---
          if (event.shiftKey) {
            console.log("Shift+Enter in <p>: Inserting <br>");
            const br = document.createElement("br");
            range.insertNode(br);

            // Force cursor after the br by inserting a zero-width space
            const zwsp = document.createTextNode("\u200B");
            br.parentNode.insertBefore(zwsp, br.nextSibling);

            // Position cursor in the zero-width space
            const newRange = document.createRange();
            newRange.setStart(zwsp, 1);
            newRange.collapse(true);

            selection.removeAllRanges();
            selection.addRange(newRange);

            // Reset enter count so this doesn't affect other blocks
            this.enterCount = 0;
            return; // Stop execution here
          }

          // --- PATH B: User wants a new paragraph (Regular Enter) ---
          console.log("Enter in <p>: Creating new paragraph");

          // Split the content at cursor position
          const cursorOffset = range.startOffset;

          // Check if cursor is at the end of the text content
          let isAtEnd = false;
          if (range.startContainer.nodeType === Node.TEXT_NODE) {
            isAtEnd = cursorOffset === range.startContainer.textContent.length;
          } else if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
            isAtEnd = cursorOffset === range.startContainer.childNodes.length;
          }

          // Prepare content for the new paragraph
          let content = null;
          if (
            !(
              (isAtEnd && range.startContainer === blockElement.lastChild) ||
              (range.startContainer === blockElement &&
                blockElement.textContent.trim() === "")
            )
          ) {
            const rangeToExtract = document.createRange();
            rangeToExtract.setStart(range.startContainer, cursorOffset);
            rangeToExtract.setEndAfter(blockElement);

            const clonedContent = rangeToExtract.cloneContents();
            const tempDiv = document.createElement("div");
            tempDiv.appendChild(clonedContent);
            const extractedText = tempDiv.textContent.trim();

            // Store the content to move to the new paragraph
            content = rangeToExtract.extractContents();

            // If the current block is now empty, add a <br>
            if (
              blockElement.innerHTML === "" ||
              blockElement.textContent.trim() === ""
            ) {
              blockElement.innerHTML = "<br>";
            }

            if (extractedText === "") {
              content = null;
            }
          }

          // Create and insert new paragraph
          const newParagraph = createAndInsertParagraph(
            blockElement,
            chunkContainer,
            content,
            selection
          );

          // Scroll the new paragraph into view
          setTimeout(() => {
            newParagraph.scrollIntoView({
              behavior: "auto",
              block: "nearest",
            });
          }, 10);

          // Reset enter count after creating a new paragraph
          this.enterCount = 0;
          return; // Stop execution here
        }

        // ==========================================================================
        // SECTION 2: UNCHANGED handling for blockquote and pre (code blocks)
        // ==========================================================================
        if (
          blockElement.tagName === "BLOCKQUOTE" ||
          blockElement.tagName === "PRE"
        ) {
          event.preventDefault(); // Prevent default Enter behavior

          // If this is the third consecutive Enter press, we either exit or split the block
          if (this.enterCount >= 3) {
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
              setElementIds(newParagraph, blockElement.id, nextSiblingId, book);
              setElementIds(newSplitBlock, newParagraph.id, nextSiblingId, book);
              blockElement.after(newParagraph, newSplitBlock);

              // 8. Save new elements and position cursor
              queueNodeForSave(newParagraph.id, "create");
              queueNodeForSave(newSplitBlock.id, "create");
              moveCaretTo(newParagraph, 0);
              newParagraph.scrollIntoView({ behavior: "auto", block: "center" });
            }

            this.enterCount = 0; // Reset enter count after action
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

        // ==========================================================================
        // SECTION 3: UNCHANGED handling for all other elements (e.g., headings)
        // ==========================================================================
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
        if (
          !(
            (isAtEnd && range.startContainer === blockElement.lastChild) ||
            (range.startContainer === blockElement &&
              blockElement.textContent.trim() === "")
          )
        ) {
          const rangeToExtract = document.createRange();
          rangeToExtract.setStart(range.startContainer, cursorOffset);
          rangeToExtract.setEndAfter(blockElement);

          const clonedContent = rangeToExtract.cloneContents();
          const tempDiv = document.createElement("div");
          tempDiv.appendChild(clonedContent);
          const extractedText = tempDiv.textContent.trim();

          // Store the content to move to the new paragraph
          content = rangeToExtract.extractContents();

          // If the current block is now empty, add a <br>
          if (
            blockElement.innerHTML === "" ||
            blockElement.textContent.trim() === ""
          ) {
            blockElement.innerHTML = "<br>";
          }

          if (extractedText === "") {
            content = null;
          }
        }
        console.log("blockElement:", blockElement);

        // Create and insert new paragraph
        const newParagraph = createAndInsertParagraph(
          blockElement,
          chunkContainer,
          content,
          selection
        );

        // Scroll the new paragraph into view
        // Then scroll after a tiny delay to let the DOM settle
        setTimeout(() => {
          newParagraph.scrollIntoView({
            behavior: "auto", // or keep 'smooth' if you prefer
            block: "nearest",
          });
        }, 10);

        // Reset enter count after creating a new paragraph
        this.enterCount = 0;
      }
    }

  // The crucial cleanup method.
  destroy() {
    document.removeEventListener("keydown", this.handleKeyDown);
    console.log("🧹 EnterKeyHandler destroyed.");
  }
}

// ✅ ADD a module-level variable to hold our handler instance.
let enterKeyHandler = null;



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
 * Check if a removed node is a hypercite element and handle delinking
 * @param {Node} removedNode - The node that was removed
 */
async function handleHyperciteRemoval(removedNode) {
  // Helper function to verify removal with optional delay
  const verifyRemoval = async (hyperciteId, delay = 0) => {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return !document.getElementById(hyperciteId);
  };

  // ✅ CHECK 1: Anchor tags that LINK TO hypercites (pasted citations)
  if (removedNode.nodeType === Node.ELEMENT_NODE &&
      removedNode.tagName === 'A' &&
      removedNode.href) {

    // Check if this is a link to a hypercite (contains #hypercite_)
    const href = removedNode.href;
    const hyperciteMatch = href.match(/#(hypercite_[a-z0-9]+)/);

    if (hyperciteMatch) {
      const targetHyperciteId = hyperciteMatch[1];

      // Verify the link is truly deleted (not just moved)
      const immediateCheck = await verifyRemoval(removedNode.id || targetHyperciteId);
      const delayedCheck = immediateCheck ? await verifyRemoval(removedNode.id || targetHyperciteId, 50) : false;

      if (!delayedCheck) {
        console.log(`✅ Hypercite link ${targetHyperciteId} still exists in DOM - skipping delink`);
        return;
      }

      console.log(`🔗 Hypercite citation link deleted, target: ${targetHyperciteId}`);
      console.log(`📍 Href: ${href}`);

      try {
        // Extract just the hypercite ID from the removed node (if it has one)
        // The delinkHypercite function needs just the ID, not the full URL
        const deletedLinkId = removedNode.id || targetHyperciteId;

        if (window.testDelinkHypercite) {
          await window.testDelinkHypercite(deletedLinkId, href);
        } else {
          const { delinkHypercite } = await import('./hyperCites.js');
          await delinkHypercite(deletedLinkId, href);
        }
      } catch (error) {
        console.error('❌ Error handling hypercite link removal:', error);
      }

      return; // Exit early, we've handled this case
    }
  }

  // ✅ CHECK 2: Source hypercite <u> wrappers being deleted
  // TODO: Phase 2 - Replace with tombstone anchor instead of allowing deletion
  if (removedNode.nodeType === Node.ELEMENT_NODE &&
      removedNode.tagName === 'U' &&
      removedNode.id &&
      removedNode.id.startsWith('hypercite_')) {

    console.log(`⚠️ Source hypercite <u> wrapper deleted: ${removedNode.id}`);
    console.log(`📌 TODO: This should be prevented and replaced with tombstone <a> tag`);
    // For now, just log it - Phase 2 will handle this properly

    return;
  }

  // ✅ CHECK 3: Handle nested hypercite links within deleted containers
  if (removedNode.nodeType === Node.ELEMENT_NODE && removedNode.querySelectorAll) {
    const hyperciteLinks = removedNode.querySelectorAll('a[href*="#hypercite_"]');

    if (hyperciteLinks.length > 0) {
      console.log(`🔗 Found ${hyperciteLinks.length} hypercite links within removed element`);

      for (const link of hyperciteLinks) {
        const href = link.href;
        const hyperciteMatch = href.match(/#(hypercite_[a-z0-9]+)/);

        if (hyperciteMatch) {
          const targetHyperciteId = hyperciteMatch[1];

          // Verify deletion
          const immediateCheck = await verifyRemoval(link.id || targetHyperciteId);
          const delayedCheck = immediateCheck ? await verifyRemoval(link.id || targetHyperciteId, 50) : false;

          if (!delayedCheck) {
            console.log(`✅ Nested hypercite link ${targetHyperciteId} still exists - skipping`);
            continue;
          }

          try {
            // Extract just the hypercite ID from the removed link (if it has one)
            const deletedLinkId = link.id || targetHyperciteId;

            if (window.testDelinkHypercite) {
              await window.testDelinkHypercite(deletedLinkId, href);
            } else {
              const { delinkHypercite } = await import('./hyperCites.js');
              await delinkHypercite(deletedLinkId, href);
            }
          } catch (error) {
            console.error('❌ Error handling nested hypercite link removal:', error);
          }
        }
      }
    }
  }
}

// Add this helper function near the top of your file
function findAllNumericalIdNodesInChunks(container) {
  const numericalIdNodes = [];
  const elementsWithIds = container.querySelectorAll('[id]');
  
  elementsWithIds.forEach(element => {
    if (isNumericalId(element.id)) {
      numericalIdNodes.push(element);
    }
  });
  
  return numericalIdNodes;
}

export function ensureMinimumDocumentStructure() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return;

  // ✅ CHECK FOR IMPORTED BOOK FIRST
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');
  if (isImportedBook) {
    console.log("🔒 Imported book detected - skipping document structure creation");
    return; // Exit early, don't create default structure
  }
  
  // ✅ CHECK FOR PASTE OPERATION IN PROGRESS
  if (isPasteOperationActive()) {
    console.log("🔄 Paste operation in progress - skipping document structure creation");
    return; // Exit early, don't interfere with paste operation
  }
  
  console.log('🔍 Checking document structure...');
  
  const bookId = book;
  
  // Check for sentinels
  const topSentinelId = `${bookId}-top-sentinel`;
  const bottomSentinelId = `${bookId}-bottom-sentinel`;
  const hasTopSentinel = document.getElementById(topSentinelId);
  const hasBottomSentinel = document.getElementById(bottomSentinelId);
  
  // Check for chunks
  const chunks = mainContent.querySelectorAll('.chunk');
  
  // Check for numerical ID nodes
  const numericalIdNodes = findAllNumericalIdNodesInChunks(mainContent);
  const nonSentinelNodes = numericalIdNodes.filter(node => 
    !node.id.includes('-sentinel')
  );
  
  console.log(`Found: ${chunks.length} chunks, ${numericalIdNodes.length} numerical nodes (${nonSentinelNodes.length} non-sentinel)`);
  
  // 🆕 COLLECT ORPHANED CONTENT FIRST, before any structure changes
  const orphanedContent = [];
  Array.from(mainContent.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      orphanedContent.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE && 
               !node.classList.contains('chunk') && 
               !node.classList.contains('sentinel')) {
      orphanedContent.push(node);
    }
  });
  
  if (orphanedContent.length > 0) {
    console.log(`🧹 Found ${orphanedContent.length} orphaned content nodes to preserve`);
  }
  
  // CASE 1: Create missing sentinels
  if (!hasTopSentinel) {
    console.log('📍 Creating top sentinel...');
    const topSentinel = document.createElement('div');
    topSentinel.id = topSentinelId;
    topSentinel.className = 'sentinel';
    
    mainContent.insertBefore(topSentinel, mainContent.firstChild);
    queueNodeForSave(topSentinelId, 'add');
    console.log(`✅ Created top sentinel: ${topSentinelId}`);
  }
  
  if (!hasBottomSentinel) {
    console.log('📍 Creating bottom sentinel...');
    const bottomSentinel = document.createElement('div');
    bottomSentinel.id = bottomSentinelId;
    bottomSentinel.className = 'sentinel';
    
    mainContent.appendChild(bottomSentinel);
    queueNodeForSave(bottomSentinelId, 'add');
    console.log(`✅ Created bottom sentinel: ${bottomSentinelId}`);
  }
  
  // CASE 2: No chunks OR no content nodes - create default structure
  if (chunks.length === 0 || nonSentinelNodes.length === 0) {
    console.log('📦 Creating default document structure...');
    
    // 🆕 PRESERVE orphaned content by temporarily removing it from DOM
    const preservedContent = orphanedContent.map(node => {
      const clone = node.cloneNode(true);
      node.remove(); // Remove from DOM but keep the clone
      return clone;
    });
    
    // Clear any remaining content (except sentinels)
    Array.from(mainContent.children).forEach(child => {
      if (!child.classList.contains('sentinel')) {
        child.remove();
      }
    });
    
    // Create chunk between sentinels
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', '0');
    
    // Create default h1
    const h1 = document.createElement('h1');
    h1.id = '1';
    
    // 🆕 ADD PRESERVED CONTENT TO THE NEW H1
    if (preservedContent.length > 0) {
      console.log('📝 Restoring preserved content to new h1');
      preservedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          h1.appendChild(node);
        } else {
          // For element nodes, move their content
          while (node.firstChild) {
            h1.appendChild(node.firstChild);
          }
        }
      });
    } else {
      h1.innerHTML = '<br>'; // Empty but editable
    }
    
    // Assemble structure
    chunk.appendChild(h1);
    
    // Insert before bottom sentinel
    const bottomSentinel = document.getElementById(bottomSentinelId);
    if (bottomSentinel) {
      mainContent.insertBefore(chunk, bottomSentinel);
    } else {
      mainContent.appendChild(chunk);
    }
    
    // Save to database
    queueNodeForSave('1', 'add');
    
    // Initialize chunk tracking
    if (window.trackChunkNodeCount) {
      trackChunkNodeCount(chunk);
    }
    
    console.log('✅ Created default structure with preserved content');
    
    // Position cursor in the new h1
    setTimeout(() => {
      const range = document.createRange();
      const selection = document.getSelection();
      range.selectNodeContents(h1);
      range.collapse(false); // Collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
    }, 0);
    
    return;
  }
  
  // CASE 3: Has chunks but they're empty - add content to first chunk
  if (chunks.length > 0 && nonSentinelNodes.length === 0) {
    console.log('📝 Adding content to existing empty chunk...');
    
    const firstChunk = chunks[0];
    const h1 = document.createElement('h1');
    h1.id = '1';
    
    // 🆕 ADD ORPHANED CONTENT TO THE NEW H1
    if (orphanedContent.length > 0) {
      console.log('📝 Adding orphaned content to new h1 in existing chunk');
      orphanedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          h1.appendChild(node);
        } else {
          while (node.firstChild) {
            h1.appendChild(node.firstChild);
          }
          node.remove();
        }
      });
    } else {
      h1.innerHTML = '<br>';
    }
    
    firstChunk.appendChild(h1);
    queueNodeForSave('1', 'add');
    
    console.log('✅ Added h1#1 to existing chunk with content');
    return;
  }
  
  // CASE 4: Normal case - just handle orphaned content if any exists
  if (orphanedContent.length > 0) {
    console.log('📝 Moving orphaned content to existing structure...');
    
    let targetChunk = mainContent.querySelector('.chunk');
    let targetElement = targetChunk?.querySelector('[id]:not([id*="-sentinel"])');
    
    if (!targetElement) {
      // This shouldn't happen in normal case, but just in case
      targetElement = document.createElement('p');
      targetElement.id = '1';
      if (targetChunk) {
        targetChunk.appendChild(targetElement);
      }
    }
    
    // Move orphaned content to the target element
    orphanedContent.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        targetElement.appendChild(node);
      } else {
        while (node.firstChild) {
          targetElement.appendChild(node.firstChild);
        }
        node.remove();
      }
    });
    
    queueNodeForSave(targetElement.id, 'update');
    console.log('✅ Moved orphaned content to existing element');
  }
  
  console.log('✅ Document structure is adequate');
}

function checkForImminentEmptyState() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) return false;
  
  const numericalIdNodes = findAllNumericalIdNodesInChunks(mainContent);
  const nonSentinelNodes = numericalIdNodes.filter(node => 
    !node.id.includes('-sentinel')
  );
  
  // If we're down to 1 node, we're about to be empty
  return nonSentinelNodes.length <= 1;
}


// UNDO //

// In your main application logic file
