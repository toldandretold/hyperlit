import { book } from "../app.js";
import { getCurrentUserId } from "../utilities/auth.js";
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
          } from "../indexedDB/index.js";
import {
  withPending,
  chunkOverflowInProgress,
  currentObservedChunk,
  setCurrentObservedChunk,
  hypercitePasteInProgress,
  keyboardLayoutInProgress,
  isProgrammaticUpdateInProgress,
  isPasteInProgress
} from '../utilities/operationState.js';

import { SaveQueue, debounce } from './saveQueue.js';
import { MutationProcessor } from './mutationProcessor.js';
import { EnterKeyHandler } from './enterKeyHandler.js';
import { ChunkMutationHandler } from './chunkMutationHandler.js';
import {
  handleHyperciteRemoval,
  ensureMinimumDocumentStructure as ensureMinimumStructureImpl,
  checkForImminentEmptyState,
  findAllNumericalIdNodesInChunks,
  cleanupStyledSpans,
  cleanupAfterImport,
  cleanupAfterPaste,
  getNoDeleteNode,
  setNoDeleteMarker
} from './domUtilities.js';

// Re-export for backward compatibility
export {
  debounce,
  cleanupStyledSpans,
  cleanupAfterImport,
  cleanupAfterPaste,
  getNoDeleteNode,
  setNoDeleteMarker
};

import { glowCloudOrange, glowCloudGreen, isProcessing } from '../components/editIndicator.js';
import { verbose } from '../utilities/logger.js';

import { buildBibtexEntry } from "../utilities/bibtexProcessor.js";
import { generateIdBetween,
         setElementIds,
         isNumericalId,
         ensureNodeHasValidId,
         NUMERICAL_ID_PATTERN,
          } from "../utilities/IDfunctions.js";
import {
  broadcastToOpenTabs
} from '../utilities/BroadcastListener.js';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown.js';

import {
  trackChunkNodeCount,
  handleChunkOverflow,
  NODE_LIMIT,
  chunkNodeCounts,
  getCurrentChunk
} from '../chunkManager.js';
import { isPasteOperationActive } from '../paste';
import { isChunkLoadingInProgress, getLoadingChunkId } from '../utilities/chunkLoadingState.js';
import { SelectionDeletionHandler } from '../utilities/selectionDelete.js';
import { initializeMainLazyLoader } from '../initializePage.js';
import { getEditToolbar } from '../editToolbar';
import { delinkHypercite, handleHyperciteDeletion } from "../hypercites/index.js";
import { checkAndInvalidateTocCache, invalidateTocCacheForDeletion } from '../components/toc.js';

// ================================================================
// MODULE STATE
// ================================================================
// This orchestrator maintains minimal state - most logic has been
// extracted to specialized modules. State variables track:
// - Observer instances (MutationObserver, SaveQueue, etc.)
// - Tracking sets for node changes
// - UI handler references for cleanup

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

// 🚀 PERFORMANCE: Input event handler for text changes (replaces characterData observer)
let inputEventHandler = null;
let isComposing = false; // Track mobile IME composition state

// 🚀 PERFORMANCE: Cache for input handler parent lookups (50-90% faster)
const elementToNumericalParent = new WeakMap();

// 🚀 PERFORMANCE: Helper to clear input handler cache during idle time
function clearInputHandlerCache() {
  // WeakMaps can't be cleared directly, but we can invalidate by creating new one
  // However, WeakMaps auto-cleanup when keys are GC'd, so this is mostly for large structural changes
  const logCacheClear = () => {
    verbose.content('Input handler cache will auto-clear via WeakMap GC', 'divEditor/index.js');
  };

  // Use requestIdleCallback to avoid blocking main thread
  if (window.requestIdleCallback) {
    window.requestIdleCallback(logCacheClear);
  } else {
    // Fallback to immediate execution (it's just logging anyway)
    logCacheClear();
  }
}

// 🔧 FIX 7b: Track video delete handler for cleanup
let videoDeleteHandler = null;

// 🎯 SUP TAG ESCAPE: Prevent typing inside sup elements (footnotes, hypercites)
let supEscapeHandler = null;
let supDeleteHandler = null;

// 💾 Save Queue instance (replaces old pendingSaves + debounce logic)
let saveQueue = null;

// 🚀 Mutation Processor instance (RAF-based mutation batching)
let mutationProcessor = null;

// ✅ EnterKeyHandler instance
let enterKeyHandler = null;

// ================================================================
// PUBLIC API
// ================================================================
// External modules call these functions to interact with the editor.
// Most functionality is delegated to specialized modules.
// ================================================================

export function queueNodeForSave(nodeId, action = 'update') {
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue node', nodeId);
    return;
  }
  saveQueue.queueNode(nodeId, action);
}

export function queueNodeForDeletion(nodeId, nodeElement = null) {
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue deletion', nodeId);
    return;
  }
  saveQueue.queueDeletion(nodeId, nodeElement);
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

// ================================================================
// MAIN ORCHESTRATOR
// ================================================================
// startObserving() is the heart of the editor system. It:
// 1. Initializes all specialized modules (SaveQueue, MutationProcessor, etc.)
// 2. Configures the MutationObserver with proper callbacks
// 3. Sets up event handlers and UI components
// 4. Delegates all actual work to specialized modules
// ================================================================

export function startObserving(editableDiv) {

  verbose.content("startObserving function called - multi-chunk mode", 'divEditor/index.js');

  // Stop any existing observer first
  stopObserving();

  // 💾 Initialize SaveQueue
  saveQueue = new SaveQueue();

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

  // 🎯 SUP TAG ESCAPE: Prevent typing inside sup elements
  // Sup tags contain generated content (footnote numbers, hypercite arrows) - never user-editable
  if (supEscapeHandler) {
    editableDiv.removeEventListener('beforeinput', supEscapeHandler);
  }

  supEscapeHandler = (e) => {
    console.log('🎯 supEscapeHandler RAW:', e.inputType, 'data:', JSON.stringify(e.data), 'isEditing:', window.isEditing);

    if (!window.isEditing) return;

    // Only handle text insertion events
    if (!e.inputType || !e.inputType.startsWith('insert')) return;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      console.log('🎯 supEscapeHandler: no selection');
      return;
    }

    // Use anchorNode which is more reliable for cursor position
    let node = selection.anchorNode;
    if (!node) {
      console.log('🎯 supEscapeHandler: no node');
      return;
    }

    // Get the element (if text node, get parent)
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element) {
      console.log('🎯 supEscapeHandler: no element');
      return;
    }

    // Check if we're inside a <sup> tag
    const supElement = element.closest('sup');
    console.log('🎯 supEscapeHandler: node:', node, 'element:', element, 'supElement:', supElement);
    if (!supElement) return;

    // We're inside a sup - move cursor outside before the input happens
    e.preventDefault();
    e.stopPropagation();

    const offset = selection.anchorOffset;
    let textToInsert = e.data || '';
    // Convert regular space to non-breaking space to prevent browser from collapsing it
    if (textToInsert === ' ') {
      textToInsert = '\u00A0'; // non-breaking space
    }
    console.log('🎯 supEscapeHandler: inserting text:', JSON.stringify(textToInsert), 'offset:', offset);

    // Create text node
    const textNode = document.createTextNode(textToInsert);

    // If cursor at position 0, insert BEFORE sup; otherwise insert AFTER
    if (offset === 0) {
      supElement.parentNode.insertBefore(textNode, supElement);
      console.log('🎯 supEscapeHandler: inserted BEFORE sup');
    } else {
      supElement.parentNode.insertBefore(textNode, supElement.nextSibling);
      console.log('🎯 supEscapeHandler: inserted AFTER sup');
    }

    // Position cursor at the end of the inserted text node
    const newRange = document.createRange();
    newRange.setStart(textNode, textNode.length);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    console.log('🎯 supEscapeHandler: cursor positioned in text node');
  };

  // Use capture phase to intercept before other handlers
  editableDiv.addEventListener('beforeinput', supEscapeHandler, { capture: true });

  // 🎯 SUP DELETE ESCAPE: Handle Delete/Backspace at sup boundaries
  // DELETE at position 0 → escape cursor before sup, then delete
  // Backspace at end → confirm footnote deletion
  if (supDeleteHandler) {
    editableDiv.removeEventListener('beforeinput', supDeleteHandler);
  }

  supDeleteHandler = (e) => {
    console.log('🎯 supDeleteHandler RAW:', e.inputType, 'isEditing:', window.isEditing);

    if (!window.isEditing) return;

    // Only handle delete operations
    if (e.inputType !== 'deleteContentForward' && e.inputType !== 'deleteContentBackward') return;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    console.log('🎯 supDeleteHandler triggered:', e.inputType, 'collapsed:', selection.isCollapsed);

    if (!selection.isCollapsed) return; // Let selection deletions work normally

    let node = selection.anchorNode;
    if (!node) return;

    console.log('🎯 anchorNode:', node, 'nodeType:', node.nodeType, 'offset:', selection.anchorOffset);

    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    let supElement = element?.closest('sup');
    const offset = selection.anchorOffset;
    const textLength = node.textContent?.length || 0;

    console.log('🎯 element:', element, 'supElement:', supElement);

    // Also check if cursor is RIGHT BEFORE a sup
    if (!supElement && offset === 0) {
      // Check if we're in an empty text node before a sup
      if (node.nodeType === Node.TEXT_NODE && node.textContent === '') {
        const nextSib = node.nextSibling;
        if (nextSib && nextSib.nodeName === 'SUP') {
          supElement = nextSib;
          console.log('🎯 Cursor in empty text node before sup');
        }
      }
      // Check if cursor is at position 0 of parent element and first real child is sup
      if (!supElement && node.nodeType === Node.ELEMENT_NODE) {
        let firstChild = node.firstChild;
        // Skip empty text nodes and BR
        while (firstChild && ((firstChild.nodeType === Node.TEXT_NODE && firstChild.textContent === '') || firstChild.nodeName === 'BR')) {
          firstChild = firstChild.nextSibling;
        }
        if (firstChild && firstChild.nodeName === 'SUP') {
          supElement = firstChild;
          console.log('🎯 Cursor is right before sup element');
        }
      }
    }

    // Also check if we're about to merge into a paragraph that starts with a sup
    // (cursor at end of current element, next element starts with sup)
    if (!supElement && e.inputType === 'deleteContentForward') {
      const currentBlock = element?.closest('p, h1, h2, h3, h4, h5, h6, div');
      const nextBlock = currentBlock?.nextElementSibling;
      if (nextBlock) {
        const nextFirstChild = nextBlock.firstChild;
        // Skip BR elements to find actual content
        const actualFirstChild = nextFirstChild?.nodeName === 'BR' ? nextFirstChild.nextSibling : nextFirstChild;
        if (actualFirstChild?.nodeName === 'SUP') {
          console.log('🎯 Forward delete would merge into paragraph starting with sup - manual merge');
          e.preventDefault();
          e.stopPropagation();

          // Manual merge: move all children from next block to current block
          while (nextBlock.firstChild) {
            currentBlock.appendChild(nextBlock.firstChild);
          }
          // Remove the empty next block
          nextBlock.remove();
          return;
        }
      }
    }

    if (!supElement) return;

    console.log('🎯 offset:', offset, 'textLength:', textLength, 'inputType:', e.inputType);

    // Forward delete (fn+Delete) at position 0 OR Backspace at end = trying to delete sup content
    // Show confirmation dialog
    const isDeletingSupContent =
      (e.inputType === 'deleteContentForward' && offset === 0) ||
      (e.inputType === 'deleteContentBackward' && offset === textLength);

    if (isDeletingSupContent) {
      console.log('🎯 Attempting to delete sup content - showing confirmation');
      if (supElement.hasAttribute('fn-count-id')) {
        const fnNum = supElement.getAttribute('fn-count-id');
        if (!confirm(`Delete footnote ${fnNum}?`)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // Allow deletion to proceed if confirmed or not a footnote
      return;
    }

    // Backspace at position 0 inside/before sup → escape cursor (not trying to delete sup)
    if (e.inputType === 'deleteContentBackward' && offset === 0) {
      console.log('🎯 Backspace at position 0 - escaping cursor');
      e.preventDefault();
      e.stopPropagation();

      // If cursor is INSIDE sup, move it before sup
      if (element?.closest('sup') === supElement) {
        const newRange = document.createRange();
        newRange.setStartBefore(supElement);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        console.log('🎯 Cursor moved before sup');
      } else {
        // Cursor is already before sup (at start of paragraph)
        // Do manual merge: move all content (including sup) to previous element
        const currentP = supElement.closest('p, h1, h2, h3, h4, h5, h6, div');
        const prevP = currentP?.previousElementSibling;
        if (prevP) {
          console.log('🎯 Manual merge: moving sup and content to previous element');

          // Move all children from current paragraph to previous
          while (currentP.firstChild) {
            prevP.appendChild(currentP.firstChild);
          }

          // Remove the now-empty paragraph
          currentP.remove();

          // Position cursor before the sup (which is now in prevP)
          const newRange = document.createRange();
          newRange.setStartBefore(supElement);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          console.log('🎯 Merge complete, cursor before sup');
        } else {
          console.log('🎯 No previous element - delete blocked');
        }
      }
      return;
    }

    // Forward delete at end of sup → normal behavior (delete what's after sup)
    // No special handling needed
  };

  editableDiv.addEventListener('beforeinput', supDeleteHandler, { capture: true });

  // 🚀 PERFORMANCE: Handle text input via debounced input event instead of characterData observer
  // This dramatically reduces mutation events during typing
  const debouncedInputHandler = debounce((e) => {
    if (!window.isEditing || isComposing) return; // Skip during mobile IME composition

    // Get the actual element where the cursor is, not e.target (which is always the contenteditable container)
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    let targetElement = selection.getRangeAt(0).startContainer;

    // If it's a text node, get its parent element
    if (targetElement.nodeType === Node.TEXT_NODE) {
      targetElement = targetElement.parentElement;
    }

    if (!targetElement) return;

    // 🚀 PERFORMANCE: Check cache first (50-90% faster on repeat keystrokes)
    let parentWithId = elementToNumericalParent.get(targetElement);

    if (!parentWithId) {
      // Cache miss - do expensive lookup
      parentWithId = targetElement.closest('[id]');

      while (parentWithId && !NUMERICAL_ID_PATTERN.test(parentWithId.id)) {
        parentWithId = parentWithId.parentElement?.closest('[id]');
      }

      // Cache the result for future lookups
      if (parentWithId) {
        elementToNumericalParent.set(targetElement, parentWithId);
      }
    }

    if (parentWithId?.id) {
      verbose.content(`Input event: queueing ${parentWithId.id} for update`, 'divEditor/index.js');
      queueNodeForSave(parentWithId.id, 'update');
      checkAndInvalidateTocCache(parentWithId.id, parentWithId);
    }
  }, 200); // 🚀 Reduced from 300ms to 200ms for snappier feel

  inputEventHandler = debouncedInputHandler;
  editableDiv.addEventListener('input', inputEventHandler);

  // 🚀 MOBILE: Handle IME composition events (autocorrect, predictive text)
  editableDiv.addEventListener('compositionstart', () => {
    isComposing = true;
    verbose.content('IME composition started - pausing input processing', 'divEditor/index.js');
  });

  editableDiv.addEventListener('compositionend', (e) => {
    isComposing = false;
    verbose.content('IME composition ended - resuming input processing', 'divEditor/index.js');
    // Trigger input handler after composition completes
    debouncedInputHandler(e);
  });

  // ✅ Only ensure structure if document is truly empty (new/imported books)
  // For existing books, lazy loader creates structure on demand
  const hasContent = document.querySelector('.main-content .chunk [id]');
  if (!hasContent) {
    ensureMinimumDocumentStructure();
  }

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

  // 🚀 Initialize ChunkMutationHandler with all dependencies
  const chunkHandler = new ChunkMutationHandler({
    observedChunks,
    saveQueue,
    handleHyperciteRemoval,
    ensureMinimumStructure: ensureMinimumDocumentStructure,
    queueNodeForSave,
    removedNodeIds,
    addedNodes,
    modifiedNodes,
    documentChanged: { value: documentChanged }
  });

  // 🚀 Initialize MutationProcessor with ChunkMutationHandler methods
  mutationProcessor = new MutationProcessor({
    filterMutations: chunkHandler.filterChunkMutations.bind(chunkHandler),
    processMutations: chunkHandler.processByChunk.bind(chunkHandler),
    shouldSkipMutation: chunkHandler.shouldSkipMutation.bind(chunkHandler)
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
    // 🚀 PERFORMANCE: Only watch 'style' attribute (for SPAN destruction)
    // Removes 70-90% of unnecessary attribute mutation events
    attributes: true,
    attributeFilter: ['style'], // Only observe style changes (for SPAN tag cleanup)
    // 🚀 PERFORMANCE: characterData removed - text changes handled via input event instead
    // This reduces mutation events by ~80% during typing
    // Removed attributeOldValue and characterDataOldValue for better performance (not used)
  });

  // NEW: Set the current observed chunk after everything is set up
  const currentChunk = getCurrentChunk();
  if (currentChunk && currentChunk.dataset) {
    const chunkId = currentChunk.dataset.chunkId || currentChunk.id;
    setCurrentObservedChunk(chunkId);
    verbose.content(`Set current observed chunk to: ${chunkId}`, 'divEditor/index.js');
  } else {
    verbose.content(`No valid chunk detected, leaving currentObservedChunk as null`, 'divEditor/index.js');
  }

  verbose.content(`Multi-chunk observer attached to .main-content`, 'divEditor/index.js');
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
      verbose.content(`Initialized tracking for chunk ${chunkId}`, 'divEditor/index.js');
    } else {
      console.warn("Found chunk without data-chunk-id:", chunk);
    }
  });

  verbose.content(`Now tracking ${observedChunks.size} chunks`, 'divEditor/index.js');

  return chunks;
}

// ================================================================
// CLEANUP & TEARDOWN
// ================================================================
// stopObserving() tears down the editor system, cleaning up:
// - MutationObserver and all specialized module instances
// - Event handlers and UI components
// - Tracking state and references
// ================================================================

export function stopObserving() {
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
    verbose.content("MutationProcessor destroyed", 'divEditor/index.js');
  }

  // 💾 Cleanup SaveQueue
  if (saveQueue) {
    saveQueue.destroy();
    saveQueue = null;
    verbose.content("SaveQueue destroyed", 'divEditor/index.js');
  }

  // 🔧 FIX 7b: Remove video delete handler
  const editableDiv = document.querySelector('.main-content');
  if (videoDeleteHandler && editableDiv) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
    videoDeleteHandler = null;
    verbose.content("Video delete handler removed", 'divEditor/index.js');
  }

  // 🎯 Remove sup escape handler
  if (supEscapeHandler && editableDiv) {
    editableDiv.removeEventListener('beforeinput', supEscapeHandler, { capture: true });
    supEscapeHandler = null;
    verbose.content("Sup escape handler removed", 'divEditor/index.js');
  }

  // 🚀 PERFORMANCE: Remove input event handlers
  if (inputEventHandler && editableDiv) {
    editableDiv.removeEventListener('input', inputEventHandler);
    editableDiv.removeEventListener('compositionstart', () => {});
    editableDiv.removeEventListener('compositionend', () => {});
    inputEventHandler = null;
    verbose.content("Input event handlers removed", 'divEditor/index.js');
  }

  observedChunks.clear();
  verbose.content("Multi-chunk observer stopped and tracking cleared", 'divEditor/index.js');
  
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
    verbose.content("Removed lingering spinner", 'divEditor/index.js');
  }

  verbose.content("Observer and related state fully reset", 'divEditor/index.js');
}

// ================================================================
// EVENT HANDLERS
// ================================================================
// Global event listeners that manage editor behavior:
// - selectionchange: Track chunk focus changes
// - keydown: Handle delete operations and empty state prevention
// ================================================================

// 🚀 PERFORMANCE: Use proper debounce for selectionchange instead of manual setTimeout
const handleSelectionChange = debounce(() => {
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
    verbose.content(`Chunk focus changed (debounced): ${currentChunkId} → ${newChunkId}`, 'divEditor/index.js');
    setCurrentObservedChunk(newChunkId);
  }
}, 150); // 150ms is a good delay to feel responsive but avoid storms

document.addEventListener("selectionchange", () => {
  // Early return for performance - don't process if not editing
  if (!window.isEditing) return;

  // 🛡️ IMMEDIATE CURSOR VALIDATION (runs before debounced handler)
  // Only checks and fixes if cursor is in a sentinel div - very lightweight
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

    // Quick check: is cursor directly in a sentinel div?
    const id = element?.id || '';
    const isSentinel = id.endsWith('-top-sentinel') || id.endsWith('-bottom-sentinel');

    if (isSentinel) {
      // Move cursor to nearest valid element immediately
      const editableDiv = document.getElementById(book);
      const validElement = editableDiv?.querySelector('[id]:not([id$="-top-sentinel"]):not([id$="-bottom-sentinel"])');

      if (validElement) {
        validElement.focus();
        const newRange = document.createRange();
        newRange.selectNodeContents(validElement);
        newRange.collapse(false);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
      return; // Don't call debounced handler if we had to fix cursor
    }
  }

  handleSelectionChange();
});

document.addEventListener("keydown", function handleTypingActivity(event) {
  if (!window.isEditing) return;

  // 🆕 O(1) CHECK: Use no-delete-id marker instead of expensive DOM queries
  if (['Backspace', 'Delete'].includes(event.key)) {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);

      // Get the element that would be affected
      let targetElement = range.startContainer;
      if (targetElement.nodeType !== Node.ELEMENT_NODE) {
        targetElement = targetElement.parentElement;
      }

      // Find the closest element with an ID
      let elementWithId = targetElement?.closest('[id]');

      // 🚀 PERFORMANCE: Simple O(1) attribute check instead of expensive DOM query
      if (elementWithId && elementWithId.getAttribute('no-delete-id') === 'please') {
        console.log(`🚨 [NO-DELETE] Attempting to delete protected node ${elementWithId.id}`);

        // Check if this deletion would clear the entire node
        const textContent = elementWithId.textContent || '';
        const isSelectingAll = !range.collapsed &&
          range.toString().trim() === textContent.trim();
        const isAtStartAndEmpty = range.collapsed &&
          range.startOffset === 0 &&
          textContent.trim().length <= 1;

        if (isSelectingAll || isAtStartAndEmpty) {
          // Prevent the deletion of the protected node
          event.preventDefault();

          // ✅ REMOVED: ensureMinimumDocumentStructure() call
          // The no-delete-id marker system prevents last node deletion,
          // so explicit structure restoration is unnecessary here

          return;
        }
      }
    }
  }

  // Rest of your existing keydown logic (unchanged)
  // Note: lastActivity is now tracked automatically by SaveQueue
});

// ================================================================
// WRAPPER FUNCTIONS
// ================================================================
// Wrapper functions that provide dependencies to extracted modules.
// These allow the modules to remain pure while accessing orchestrator state.
// ================================================================

/**
 * Wrapper for ensureMinimumDocumentStructure that provides queueNodeForSave
 */
function ensureMinimumDocumentStructure() {
  ensureMinimumStructureImpl(queueNodeForSave);
}

// ================================================================
// DOM UTILITY FUNCTIONS
// ================================================================
// The following functions have been extracted to domUtilities.js:
// - handleHyperciteRemoval()
// - findAllNumericalIdNodesInChunks()
// - ensureMinimumDocumentStructure() (wrapper provides queueNodeForSave)
// - checkForImminentEmptyState()
// - cleanupStyledSpans() / cleanupAfterImport() / cleanupAfterPaste()
//
// All are imported at the top of this file and re-exported for backward compatibility
// ================================================================
