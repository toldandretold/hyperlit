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
  writeNodeChunks,
  prepareLibraryForIndexedDB
          } from "./indexedDB.js";
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

import { SaveQueue, debounce } from './divEditor/saveQueue.js';
import { MutationProcessor } from './divEditor/mutationProcessor.js';
import { EnterKeyHandler } from './divEditor/enterKeyHandler.js';

// Re-export debounce for backward compatibility (used by indexedDB.js)
export { debounce };

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

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from './convertMarkdown.js';

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

let observedChunks = new Map(); // chunkId -> chunk element
let deletionHandler = null;

let isObserverRestarting = false;
let selectionChangeDebounceTimer = null;

// 🔧 FIX 7b: Track video delete handler for cleanup
let videoDeleteHandler = null;

// 💾 Save Queue instance (replaces old pendingSaves + debounce logic)
let saveQueue = null;

// 🚀 Mutation Processor instance (RAF-based mutation batching)
let mutationProcessor = null;



// ================================================================
// PUBLIC API - Save Queue Functions (delegate to SaveQueue instance)
// ================================================================

export function queueNodeForSave(nodeId, action = 'update') {
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue node', nodeId);
    return;
  }
  saveQueue.queueNode(nodeId, action);
}


// ================================================================
// PAGE UNLOAD HANDLING
// ================================================================

// Force save all pending changes (useful for page unload)
export function flushAllPendingSaves() {
  console.log('🚨 Flushing all pending saves...');

  if (saveQueue) {
    saveQueue.flush();
  }
}

// Add page unload handler to flush saves and pending mutations
window.addEventListener('beforeunload', () => {
  // 🚀 PERFORMANCE: Flush any queued mutations immediately
  if (mutationProcessor) {
    mutationProcessor.flush();
  }

  // Flush pending saves
  flushAllPendingSaves();
});

// Modified startObserving function.
// Note: editable div = <div class="main-content" id="book" contenteditable="true">
export function startObserving(editableDiv) {

  console.log("🤓 startObserving function called - multi-chunk mode");

  // Stop any existing observer first
  stopObserving();

  // 💾 Initialize SaveQueue with ensureMinimumDocumentStructure callback
  saveQueue = new SaveQueue(ensureMinimumDocumentStructure);

  // 🎬 VIDEO DELETE HANDLER: Handle video embed delete button clicks
  // 🔧 FIX 7b: Remove old handler if it exists
  if (videoDeleteHandler) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
  }

  // Create named function so we can remove it later
  videoDeleteHandler = (e) => {
    const deleteBtn = e.target.closest('[data-action="delete-video"]');
    if (!deleteBtn) return; // Early exit for performance

    e.preventDefault();
    e.stopPropagation();

    const videoEmbed = deleteBtn.closest('.video-embed');
    if (videoEmbed && videoEmbed.id) {
      console.log(`🗑️ Deleting video embed: ${videoEmbed.id}`);

        // Check for adjacent content to focus cursor
        let focusTarget = null;
        let focusAtEnd = false;

        const nextSibling = videoEmbed.nextElementSibling;
        const prevSibling = videoEmbed.previousElementSibling;

        // Prefer next sibling, fall back to previous
        if (nextSibling && nextSibling.matches('p, h1, h2, h3, h4, h5, h6, div, blockquote, pre, li')) {
          focusTarget = nextSibling;
          focusAtEnd = false; // Place cursor at start
        } else if (prevSibling && prevSibling.matches('p, h1, h2, h3, h4, h5, h6, div, blockquote, pre, li')) {
          focusTarget = prevSibling;
          focusAtEnd = true; // Place cursor at end
        }

        if (focusTarget) {
          // Remove video and focus existing adjacent content
          videoEmbed.remove();

          const range = document.createRange();
          const selection = window.getSelection();

          // Find first text node or use element itself
          const textNode = focusTarget.firstChild;
          if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            range.setStart(textNode, focusAtEnd ? textNode.length : 0);
          } else {
            range.selectNodeContents(focusTarget);
            range.collapse(!focusAtEnd);
          }

          selection.removeAllRanges();
          selection.addRange(range);

          console.log(`✅ Video embed removed, cursor ${focusAtEnd ? 'at end of' : 'at start of'} ${focusTarget.tagName.toLowerCase()}`);
        } else {
          // No adjacent content - create replacement paragraph
          const replacementP = document.createElement('p');
          replacementP.id = videoEmbed.id;
          if (videoEmbed.hasAttribute('data-node-id')) {
            replacementP.setAttribute('data-node-id', videoEmbed.getAttribute('data-node-id'));
          }
          replacementP.innerHTML = '<br>';

          videoEmbed.parentNode.insertBefore(replacementP, videoEmbed);
          videoEmbed.remove();

          // Set cursor to new paragraph
          const range = document.createRange();
          const selection = window.getSelection();
          range.setStart(replacementP, 0);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);

          console.log(`✅ Video embed ${replacementP.id} replaced with paragraph (standalone video)`);
        }
      }
  };

  // Attach the handler
  editableDiv.addEventListener('click', videoDeleteHandler);

  ensureMinimumDocumentStructure();

  // 💾 Start monitoring pending saves (for debugging)
  if (saveQueue) {
    saveQueue.startMonitoring();
  }

  // Initialize tracking for all current chunks
  initializeCurrentChunks(editableDiv);

  // 🔧 FIX 7c: Safely replace EnterKeyHandler (create new one first, then destroy old)
  const newHandler = new EnterKeyHandler();

  if (enterKeyHandler) {
    console.warn('⚠️ EnterKeyHandler already exists! Destroying old one after creating new.');
    enterKeyHandler.destroy();
  }

  enterKeyHandler = newHandler;

  // 🚀 Initialize MutationProcessor with filter and processing functions
  mutationProcessor = new MutationProcessor({
    filterMutations: filterChunkMutations,
    processMutations: processMutationsByChunk,
    shouldSkipMutation: shouldSkipMutation
  });

  // Create observer for the main-content container
  observer = new MutationObserver((mutations) => {
    // 🚀 PERFORMANCE: Queue mutations for batch processing via MutationProcessor
    mutationProcessor.enqueue(mutations);
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
    characterData: true, // Keep enabled - mutation batching handles mobile performance
    // Removed attributeOldValue and characterDataOldValue for better performance (not used)
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
              if (saveQueue) {
                saveQueue.queueDeletion(node.id);
              }
            });
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

    // 🔍 Query for fresh chunk element to avoid stale references
    // When SPAN tags are destroyed, stored references can become detached even though
    // the chunk element still exists in the DOM
    const liveChunk = document.querySelector(`[data-chunk-id="${chunkId}"]`);

    if (liveChunk) {
      // Update our stored reference to the live element
      observedChunks.set(chunkId, liveChunk);

      // Process mutations with live reference
      setTimeout(async () => {
        // By wrapping this in a timeout, we yield to the main thread,
        // allowing the browser to render the typed character immediately.
        // This makes the UI feel much snappier during fast typing.
        await processChunkMutations(liveChunk, chunkMutations);
      }, 0);
    } else if (chunk && !window.isEditing) {
      // Chunk was actually removed from DOM (not just a stale reference)
      // Only log and cleanup if NOT in edit mode to reduce spam
      console.log(`🗑️ Chunk ${chunkId} actually removed from DOM`);

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

  // Skip all mutation processing during renumbering (DOM updates are programmatic)
  if (window.renumberingInProgress) {
    console.log(`⚠️ Skipping mutation processing for chunk ${chunkId} during renumbering`);
    return;
  }

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
            console.log(`🔍 [LAST NODE CHECK] Chunk ${chunkId} has ${remainingNodes} remaining nodes after deleting ${node.id}`);

            if (remainingNodes === 0) {
                console.log(`🚨 [LAST NODE] Last node ${node.id} being deleted from chunk ${chunkId}`);

                // Delete immediately and restore structure
                deleteIndexedDBRecordWithRetry(node.id).then(() => {
                  const pasteActive = isPasteOperationActive();
                  console.log(`🔍 [LAST NODE] After deletion, paste active: ${pasteActive}`);
                  if (!pasteActive) {
                    console.log(`🔧 [LAST NODE] Calling ensureMinimumDocumentStructure()`);
                    ensureMinimumDocumentStructure();
                  } else {
                    console.log(`⏸️ [LAST NODE] Skipping structure check - paste in progress`);
                  }
                });

                return;
              } else {
              // Normal deletion for non-last nodes
              console.log(`🗑️ Queueing node ${node.id} for batch deletion`);
              if (saveQueue) {
                saveQueue.queueDeletion(node.id);
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
    
    // 🔥 Handle attribute mutations that might be creating styled elements
    if (mutation.type === "attributes" && mutation.target.nodeType === Node.ELEMENT_NODE) {
      const element = mutation.target;

      // If a SPAN gets a style attribute, destroy it immediately
      if (element.tagName === 'SPAN' && mutation.attributeName === 'style') {
        console.log(`🔥 DESTROYING SPAN that gained style attribute`, element);

        // Save current selection/cursor position
        const selection = window.getSelection();
        let savedRange = null;
        let cursorWasInSpan = false;
        let cursorOffset = 0;

        if (selection.rangeCount > 0) {
          savedRange = selection.getRangeAt(0);
          // Check if cursor is inside this span
          if (element.contains(savedRange.startContainer)) {
            cursorWasInSpan = true;
            // Calculate offset relative to span's text content
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
            let textNode;
            let offset = 0;
            while (textNode = walker.nextNode()) {
              if (textNode === savedRange.startContainer) {
                cursorOffset = offset + savedRange.startOffset;
                break;
              }
              offset += textNode.length;
            }
          }
        }

        // Preserve text content but remove the span wrapper
        let replacementTextNode = null;
        if (element.textContent.trim()) {
          replacementTextNode = document.createTextNode(element.textContent);
          if (element.parentNode && document.contains(element.parentNode)) {
            element.parentNode.insertBefore(replacementTextNode, element);
          }
        }

        if (document.contains(element)) {
          element.remove();
        }

        // Restore cursor position if it was in the span
        if (cursorWasInSpan && replacementTextNode) {
          const newRange = document.createRange();
          const safeOffset = Math.min(cursorOffset, replacementTextNode.length);
          newRange.setStart(replacementTextNode, safeOffset);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);
          console.log(`✅ Cursor restored at offset ${safeOffset} after SPAN attribute destruction`);
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

            // Save current selection/cursor position
            const selection = window.getSelection();
            let savedRange = null;
            let cursorWasInSpan = false;
            let cursorOffset = 0;

            if (selection.rangeCount > 0) {
              savedRange = selection.getRangeAt(0);
              // Check if cursor is inside this span
              if (node.contains(savedRange.startContainer)) {
                cursorWasInSpan = true;
                // Calculate offset relative to span's text content
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
                let textNode;
                let offset = 0;
                while (textNode = walker.nextNode()) {
                  if (textNode === savedRange.startContainer) {
                    cursorOffset = offset + savedRange.startOffset;
                    break;
                  }
                  offset += textNode.length;
                }
              }
            }

            // Preserve text content but remove the span wrapper
            let replacementTextNode = null;
            if (node.textContent.trim()) {
              replacementTextNode = document.createTextNode(node.textContent);
              node.parentNode.insertBefore(replacementTextNode, node);
            }

            node.remove();

            // Restore cursor position if it was in the span
            if (cursorWasInSpan && replacementTextNode) {
              const newRange = document.createRange();
              const safeOffset = Math.min(cursorOffset, replacementTextNode.length);
              newRange.setStart(replacementTextNode, safeOffset);
              newRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(newRange);
              console.log(`✅ Cursor restored at offset ${safeOffset} after SPAN destruction`);
            }

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

  if (enterKeyHandler) {
    enterKeyHandler.destroy();
    enterKeyHandler = null;
  }

  // 🚀 Cleanup MutationProcessor
  if (mutationProcessor) {
    mutationProcessor.destroy();
    mutationProcessor = null;
    console.log("🚀 MutationProcessor destroyed");
  }

  // 💾 Cleanup SaveQueue
  if (saveQueue) {
    saveQueue.destroy();
    saveQueue = null;
    console.log("💾 SaveQueue destroyed");
  }

  // 🔧 FIX 7b: Remove video delete handler
  const editableDiv = document.querySelector('.main-content');
  if (videoDeleteHandler && editableDiv) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
    videoDeleteHandler = null;
    console.log("🎬 Video delete handler removed");
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
  // Early return for performance - don't process if not editing
  if (!window.isEditing) return;

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
      const imminentEmpty = checkForImminentEmptyState();
      console.log(`🔍 [KEYDOWN DELETE] checkForImminentEmptyState returned: ${imminentEmpty}`);

      if (imminentEmpty) {
        // Check if this deletion would leave us empty
        let willBeEmpty = false;

        // Get the element that would be affected
        let targetElement = range.startContainer;
        if (targetElement.nodeType !== Node.ELEMENT_NODE) {
          targetElement = targetElement.parentElement;
        }

        // Find the closest element with an ID
        let elementWithId = targetElement.closest('[id]');
        console.log(`🔍 [KEYDOWN DELETE] Target element ID: ${elementWithId?.id}`);

        if (elementWithId && isNumericalId(elementWithId.id)) {
          // SIMPLIFIED: Back to the original working conditions
          const textContent = elementWithId.textContent || '';
          const isSelectingAll = !range.collapsed &&
            range.toString().trim() === textContent.trim();
          const isAtStartAndEmpty = range.collapsed &&
            range.startOffset === 0 &&
            textContent.trim().length <= 1; // Back to original condition

          console.log(`🔍 [KEYDOWN DELETE] isSelectingAll: ${isSelectingAll}, isAtStartAndEmpty: ${isAtStartAndEmpty}`);

          if (isSelectingAll || isAtStartAndEmpty) {
            willBeEmpty = true;
          }
        }

        if (willBeEmpty) {
          const pasteActive = isPasteOperationActive();
          console.log(`🚨 [KEYDOWN DELETE] Will be empty! Paste active: ${pasteActive}`);

          // Prevent the deletion
          event.preventDefault();

          // Use the ORIGINAL working restoration method
          if (!pasteActive) {
            console.log(`🔧 [KEYDOWN DELETE] Calling ensureMinimumDocumentStructure()`);
            ensureMinimumDocumentStructure();
          } else {
            console.log(`⏸️ [KEYDOWN DELETE] Skipping structure check - paste in progress`);
          }

          return;
        }
      }
    }
  }

  // Rest of your existing keydown logic (unchanged)
  // Note: lastActivity is now tracked automatically by SaveQueue
});

// ✅ Module-level variable to hold EnterKeyHandler instance
let enterKeyHandler = null;

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
  console.log(`🔧 [STRUCTURE CHECK] ===== ensureMinimumDocumentStructure() called =====`);
  console.log(`🔧 [STRUCTURE CHECK] Call stack:`, new Error().stack);

  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    console.warn('🔧 [STRUCTURE CHECK] No .main-content found - exiting');
    return;
  }

  // ✅ CHECK FOR IMPORTED BOOK FIRST
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');
  if (isImportedBook) {
    console.log("🔧 [STRUCTURE CHECK] Imported book detected - skipping document structure creation");
    return; // Exit early, don't create default structure
  }

  // ✅ CHECK FOR PASTE OPERATION IN PROGRESS
  const pasteActive = isPasteOperationActive();
  console.log(`🔧 [STRUCTURE CHECK] Paste operation active: ${pasteActive}`);
  if (pasteActive) {
    console.log("🔧 [STRUCTURE CHECK] Paste operation in progress - skipping document structure creation");
    return; // Exit early, don't interfere with paste operation
  }

  console.log('🔧 [STRUCTURE CHECK] Proceeding with structure check...');

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
  
  console.log(`🔧 [STRUCTURE CHECK] Found: ${chunks.length} chunks, ${numericalIdNodes.length} numerical nodes (${nonSentinelNodes.length} non-sentinel)`);
  console.log(`🔧 [STRUCTURE CHECK] Sentinel status - Top: ${!!hasTopSentinel}, Bottom: ${!!hasBottomSentinel}`);
  console.log(`🔧 [STRUCTURE CHECK] Non-sentinel node IDs: ${nonSentinelNodes.map(n => n.id).join(', ')}`);

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
    console.log('🔧 [STRUCTURE CHECK] *** CASE 2: Creating default document structure ***');

    // Preserve existing title content if it exists
    const existingTitle = mainContent.querySelector('h1');
    const preservedTitleContent = existingTitle ? existingTitle.innerHTML : null;
    console.log('📝 Preserved title content:', preservedTitleContent);

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

    // Create default paragraph
    const p = document.createElement('p');
    // Use setElementIds to set both id and data-node-id
    setElementIds(p, null, null, book);
    // Force id to be "1" (setElementIds might generate something else)
    if (p.id !== '1') {
      p.id = '1';
      p.setAttribute('data-node-id', `${book}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    }

    // 🆕 RESTORE TITLE CONTENT FIRST (highest priority)
    if (preservedTitleContent) {
      console.log('✅ Restoring preserved title content');
      p.innerHTML = preservedTitleContent;
    }
    // Otherwise, add preserved orphaned content
    else if (preservedContent.length > 0) {
      console.log('📝 Restoring preserved content to new paragraph');
      preservedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          p.appendChild(node);
        } else {
          // For element nodes, move their content
          while (node.firstChild) {
            p.appendChild(node.firstChild);
          }
        }
      });
    }
    // Otherwise, create empty but editable paragraph
    else {
      p.innerHTML = '<br>';
    }

    // Assemble structure
    chunk.appendChild(p);

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

    // Position cursor in the new paragraph
    setTimeout(() => {
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(p);
      range.collapse(false); // Collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
    }, 0);
    
    return;
  }
  
  // CASE 3: Has chunks but they're empty - add content to first chunk
  if (chunks.length > 0 && nonSentinelNodes.length === 0) {
    console.log('🔧 [STRUCTURE CHECK] *** CASE 3: Adding content to existing empty chunk ***');

    const firstChunk = chunks[0];
    const p = document.createElement('p');

    // Use setElementIds to set both id and data-node-id
    setElementIds(p, null, null, book);
    // Force id to be "1"
    if (p.id !== '1') {
      p.id = '1';
      p.setAttribute('data-node-id', `${book}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    }

    // 🆕 ADD ORPHANED CONTENT TO THE NEW PARAGRAPH
    if (orphanedContent.length > 0) {
      console.log('📝 Adding orphaned content to new paragraph in existing chunk');
      orphanedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          p.appendChild(node);
        } else {
          while (node.firstChild) {
            p.appendChild(node.firstChild);
          }
          node.remove();
        }
      });
    } else {
      p.innerHTML = '<br>';
    }

    firstChunk.appendChild(p);
    queueNodeForSave('1', 'add');

    console.log('✅ Added p#1 to existing chunk with content');
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

  console.log('🔧 [STRUCTURE CHECK] ✅ Document structure is adequate - no changes needed');
}

function checkForImminentEmptyState() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    console.log(`🔍 [IMMINENT EMPTY] No main-content found, returning false`);
    return false;
  }

  const numericalIdNodes = findAllNumericalIdNodesInChunks(mainContent);
  const nonSentinelNodes = numericalIdNodes.filter(node =>
    !node.id.includes('-sentinel')
  );

  console.log(`🔍 [IMMINENT EMPTY] Found ${numericalIdNodes.length} numerical nodes, ${nonSentinelNodes.length} non-sentinel nodes`);
  console.log(`🔍 [IMMINENT EMPTY] Node IDs: ${nonSentinelNodes.map(n => n.id).join(', ')}`);

  // If we're down to 1 node, we're about to be empty
  const result = nonSentinelNodes.length <= 1;
  console.log(`🔍 [IMMINENT EMPTY] Returning: ${result}`);
  return result;
}


// UNDO //

// In your main application logic file


// ================================================================
// TARGETED SPAN CLEANUP (replaces periodic cleanup)
// ================================================================

/**
 * Clean up styled spans from a container.
 * Called after specific operations (paste, import) rather than periodically.
 *
 * @param {HTMLElement} container - Container to clean (or null for entire document)
 */
export function cleanupStyledSpans(container = null) {
  const searchRoot = container || document.querySelector('.main-content');
  if (!searchRoot) return;

  const spans = searchRoot.querySelectorAll('span[style]');
  if (spans.length === 0) return;

  console.log(`🧹 Targeted cleanup: Found ${spans.length} styled spans to remove`);

  spans.forEach(span => {
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

  console.log(`✅ Cleaned up ${spans.length} styled spans`);
}

/**
 * Clean up styled spans after document import.
 * Should be called once after the entire import process completes.
 */
export function cleanupAfterImport() {
  console.log('🧹 Running post-import span cleanup...');
  cleanupStyledSpans();
}

/**
 * Clean up styled spans after paste operation.
 * Should be called after paste content is processed.
 *
 * @param {HTMLElement} pastedContainer - Container with pasted content
 */
export function cleanupAfterPaste(pastedContainer) {
  console.log('🧹 Running post-paste span cleanup...');
  cleanupStyledSpans(pastedContainer);
}
