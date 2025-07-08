import { book } from "./app.js";
import { 
  updateIndexedDBRecord, 
  deleteIndexedDBRecordWithRetry,
  batchDeleteIndexedDBRecords,
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
  setCurrentObservedChunk,
  hypercitePasteInProgress
} from './operationState.js';

import { showSpinner, showTick } from './editIndicator.js';

import { buildBibtexEntry } from "./bibtexProcessor.js";
import { generateIdBetween,
         isNumericalId,
         ensureNodeHasValidId,
          } from "./IDfunctions.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from './convert-markdown.js';
import { processFootnotes } from './footnotes.js';

import { 
  trackChunkNodeCount, 
  handleChunkOverflow, 
  NODE_LIMIT, 
  chunkNodeCounts,
  getCurrentChunk
} from './chunkManager.js';
import { isChunkLoadingInProgress, getLoadingChunkId } from './chunkLoadingState.js';
import { SelectionDeletionHandler } from './selectionDelete.js';
import { initializeMainLazyLoader } from './initializePage.js';
import { getEditToolbar } from './editToolbar.js';
import { delinkHypercite, handleHyperciteDeletion } from './hyperCites.js';





// Tracking sets
const modifiedNodes = new Set(); // Track element IDs whose content was modified.
const addedNodes = new Set(); // Track newly-added element nodes.
const removedNodeIds = new Set(); // Track IDs of removed nodes.

let observer;
let documentChanged = false;
let debounceTimer = null;

let observedChunks = new Map(); // chunkId -> chunk element
let deletionHandler = null;

let isObserverRestarting = false;

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

  showTick();
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

  // Initialize tracking for all current chunks
  initializeCurrentChunks(editableDiv);

  // Create observer for the main-content container
  observer = new MutationObserver(async (mutations) => {

    // When to NOT observe:
    if (hypercitePasteInProgress) {
      console.log("Skipping mutations during hypercite paste");
      return;
    }

    if (isChunkLoadingInProgress()) {
      console.log(`Skipping mutations during chunk loading for chunk ${getLoadingChunkId()}`);
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

  
  // In your startObserving function
  deletionHandler = new SelectionDeletionHandler(editableDiv, {
    onDeleted: (nodeId) => {
      console.log(`Selection deletion handler queueing: ${nodeId}`);
      pendingSaves.deletions.add(nodeId);
      debouncedBatchDelete();
    }
  });

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
              console.log(`Queueing node ${node.id} for batch deletion (chunk removal)`);
              pendingSaves.deletions.add(node.id);
            });
            debouncedBatchDelete();
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

          // 🆕 ADD THIS: Check for hypercite removals
          await handleHyperciteRemoval(node);

          // Check if this is a top-level paragraph/heading being removed
          if (node.id && node.id.match(/^\d+(\.\d+)?$/)) {
            console.log(`🗑️ Attempting to delete node ${node.id} from IndexedDB`);

            // Check if this is the last node in the chunk 
            const remainingNodes = chunk.querySelectorAll('[id]').length;
            console.log(`Chunk ${chunkId} has ${remainingNodes} remaining nodes after this deletion`);
            
            if (remainingNodes === 0) {
              // This is the last node - handle it specially
              console.log(`🚨 Last node ${node.id} being deleted from chunk ${chunkId}`);
              
              console.log(`🗑️ Queueing node ${node.id} for batch deletion`);
                pendingSaves.deletions.add(node.id);
                removedNodeIds.add(node.id);
                debouncedBatchDelete();
              // Exit early to avoid further processing since chunk will disappear
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
    // 2) Process added nodes
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          ensureNodeHasValidId(node);
          documentChanged = true;
          addedNodes.add(node);
          addedCount++;
          newNodes.push(node);
          
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




// Fix your selectionchange listener:
document.addEventListener("selectionchange", () => {
  if (!window.isEditing || chunkOverflowInProgress || isObserverRestarting) return;

  const toolbar = getEditToolbar();
  if (toolbar && toolbar.isFormatting) {
    console.log("Skipping chunk change detection during formatting");
    return;
  }

  const newChunkId = getCurrentChunk();
  const currentChunkId = currentObservedChunk ? 
    (currentObservedChunk.id || currentObservedChunk.dataset.chunkId) : null;
    
  if (newChunkId !== currentChunkId) {
    console.log(`Chunk change detected: ${currentChunkId} → ${newChunkId}`);
    
    // Set guard flag
    isObserverRestarting = true;
    
    stopObserving();
    
    if (newChunkId) {
      // ✅ ALWAYS pass the main container, not individual chunks
      const mainContainer = document.querySelector('.main-content');
      if (mainContainer) {
        startObserving(mainContainer);
      }
    } else {
      setCurrentObservedChunk(null);
      console.warn("Lost focus on any chunk.");
    }
    
    // Clear guard flag after a short delay
    setTimeout(() => {
      isObserverRestarting = false;
    }, 100);
  }
});

// Track typing activity
document.addEventListener("keydown", function handleTypingActivity(event) {
  // Only show spinner if in edit mode
  if (!window.isEditing) return;

  showSpinner();
  
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

    // SECTION 1: Special handling for paragraph elements
    //==========================================================================
    if (blockElement.tagName === "P") {
      event.preventDefault();
      
      if (enterCount === 1) {
        // First Enter: Just insert <br> and position cursor after it
        const br = document.createElement("br");
        range.insertNode(br);
        
        // Store reference
        blockElement._lastInsertedBr = br;
        
        // Force cursor after the br by inserting a zero-width space
        const zwsp = document.createTextNode('\u200B'); // zero-width space
        br.parentNode.insertBefore(zwsp, br.nextSibling);
        
        // Position cursor in the zero-width space
        const newRange = document.createRange();
        newRange.setStart(zwsp, 1);
        newRange.collapse(true);
        
        selection.removeAllRanges();
        selection.addRange(newRange);
        
        console.log("First Enter: Added <br>");
        return;
      } else if (enterCount >= 2) {
        // Second Enter: Remove the <br> we just created and split/create paragraph
        
        // Remove only the br we created on the first enter
        if (blockElement._lastInsertedBr && blockElement._lastInsertedBr.parentNode === blockElement) {
          blockElement._lastInsertedBr.remove();
          delete blockElement._lastInsertedBr;
        }
        
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
        
        // Create and insert new paragraph
        const newParagraph = createAndInsertParagraph(blockElement, chunkContainer, content, selection);
        
        // Scroll the new paragraph into view
        setTimeout(() => {
          newParagraph.scrollIntoView({
            behavior: 'auto',
            block: 'nearest'
          });
        }, 10);
        
        // Reset enter count after creating a new paragraph
        enterCount = 0;
        console.log("Second Enter: Split paragraph");
        return;
      }
    }


    //==========================================================================
    // SECTION 2: Special handling for blockquote and pre (code blocks)
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
    // SECTION 3: For all other elements, proceed with normal paragraph creation
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
 * Check if a removed node is a hypercite element and handle delinking
 * @param {Node} removedNode - The node that was removed
 */
async function handleHyperciteRemoval(removedNode) {
  // Check if the removed node is a hypercite element
  if (removedNode.nodeType === Node.ELEMENT_NODE && 
      removedNode.tagName === 'A' && 
      removedNode.id && 
      removedNode.id.startsWith('hypercite_') && 
      removedNode.href) {
    
    console.log(`🔗 Hypercite element removed: ${removedNode.id}`);
    console.log(`📍 Href: ${removedNode.href}`);
    
    // Import the delink function (assuming it's available globally or import it)
    try {
      // If you made the functions global for testing, use:
      if (window.testDelinkHypercite) {
        await window.testDelinkHypercite(removedNode.id, removedNode.href);
      } else {
        // Or import the function if modules are supported
        const { delinkHypercite } = await import('./hyperCites.js');
        await delinkHypercite(removedNode.id, removedNode.href);
      }
    } catch (error) {
      console.error('❌ Error handling hypercite removal:', error);
    }
  }
  
  // Also check for hypercites within removed elements
  if (removedNode.nodeType === Node.ELEMENT_NODE && removedNode.querySelectorAll) {
    const hypercites = removedNode.querySelectorAll('a[id^="hypercite_"][href]');
    
    if (hypercites.length > 0) {
      console.log(`🔗 Found ${hypercites.length} hypercites within removed element`);
      
      for (const hypercite of hypercites) {
        console.log(`🔗 Processing nested hypercite: ${hypercite.id}`);
        
        try {
          if (window.testDelinkHypercite) {
            await window.testDelinkHypercite(hypercite.id, hypercite.href);
          } else {
            const { delinkHypercite } = await import('./hyperCites.js');
            await delinkHypercite(hypercite.id, hypercite.href);
          }
        } catch (error) {
          console.error('❌ Error handling nested hypercite removal:', error);
        }
      }
    }
  }
}





