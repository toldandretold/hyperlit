import { book } from "../app.js";
import { getCurrentUserId } from "../utilities/auth.js";
import {
  updateSingleIndexedDBRecord,
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
import { SupTagHandler } from './supTagHandler.js';
import { ChunkMutationHandler } from './chunkMutationHandler.js';
import {
  registerEditSession,
  unregisterEditSession,
  verifyMutationSource,
  isEventInActiveDiv,
  getActiveEditSession
} from './editSessionManager.js';
import {
  handleHyperciteRemoval,
  ensureMinimumDocumentStructure as ensureMinimumStructureImpl,
  checkForImminentEmptyState,
  findAllNumericalIdNodesInChunks,
  cleanupStyledSpans,
  cleanupAfterImport,
  cleanupAfterPaste,
  getNoDeleteNode,
  setNoDeleteMarker,
  findNextNoDeleteNode,
  transferNoDeleteMarker
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
         findPreviousElementId,
         findNextElementId,
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
let debouncedInputHandlerRef = null; // Reference to debounced handler for flushing on close
let isComposing = false; // Track mobile IME composition state

// 🚀 PERFORMANCE: Cache for input handler parent lookups (50-90% faster)
const elementToNumericalParent = new WeakMap();

// 🛡️ SAFETY NET: Track last input node ID so flush can save even when selection moves
// (e.g., user clicks overlay to close within 200ms debounce window)
let lastInputNodeId = null;

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

// 🎯 SUP TAG HANDLER: Handles typing, deleting, and navigation around sup elements
let supTagHandler = null;

// 💾 Save Queue instance (replaces old pendingSaves + debounce logic)
let saveQueue = null;

// 📌 Store the currently-observed editable div so stopObserving removes listeners from the right element
let observedEditableDiv = null;

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

export function queueNodeForSave(IDnumerical, action = 'update', bookId = null) {
  verbose.content(`queueNodeForSave: ${IDnumerical}, action: ${action}, bookId: ${bookId || '(inherit)'}`, 'divEditor/index.js');
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue node', IDnumerical);
    return;
  }
  glowCloudOrange();
  saveQueue.queueNode(IDnumerical, action, bookId);
}

export function queueNodeForDeletion(IDnumerical, nodeElement = null, bookId = null) {
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue deletion', IDnumerical);
    return;
  }
  glowCloudOrange();
  saveQueue.queueDeletion(IDnumerical, nodeElement, bookId);
}


// ================================================================
// PAGE UNLOAD HANDLING
// ================================================================

// Force save all pending changes (useful for page unload)
export async function flushAllPendingSaves() {
  verbose.content('Flushing all pending saves...', 'divEditor/index.js');

  if (saveQueue) {
    await saveQueue.flush();
    verbose.content('All pending saves flushed', 'divEditor/index.js');
  }
}

// 🔑 CRITICAL: Flush input debounce to capture recent typing
// This forces the 200ms debounced input handler to execute immediately
export function flushInputDebounce() {
  verbose.content('[EditSession] Flushing input debounce...', 'divEditor/index.js');
  if (debouncedInputHandlerRef) {
    debouncedInputHandlerRef.flush();
    verbose.content('[EditSession] Input debounce flushed', 'divEditor/index.js');
  } else {
    verbose.content('[EditSession] No input debounce to flush', 'divEditor/index.js');
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

export function isEditorObserving() {
  return observer !== null;
}

export async function startObserving(editableDiv, bookId = null) {

  verbose.content("startObserving function called - multi-chunk mode", 'divEditor/index.js');

  // Stop any existing observer first
  await stopObserving();

  // 📌 Store reference so stopObserving removes listeners from the right element
  observedEditableDiv = editableDiv;

  // 📝 Register this edit session (handles preemption of existing sessions)
  const containerId = bookId || 'main-content';
  await registerEditSession(containerId, editableDiv, bookId);

  // 💾 Initialize SaveQueue (passes bookId for sub-book saves)
  saveQueue = new SaveQueue(bookId);

  // 🎬 VIDEO DELETE HANDLER: Handle video embed delete button clicks
  // 🔧 FIX 7b: Remove old handler if it exists
  if (videoDeleteHandler) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
  }

  // Create named function so we can remove it later
  videoDeleteHandler = (e) => {
    const deleteBtn = e.target.closest('[data-action="delete-video"], [data-action="delete-broken-image"]');
    if (!deleteBtn) return; // Early exit for performance

    e.preventDefault();
    e.stopPropagation();

    const isImage = deleteBtn.dataset.action === 'delete-broken-image';

    if (isImage) {
      // Broken image: wrapper sits INSIDE a node element — remove just the wrapper
      const wrapper = deleteBtn.closest('.broken-image-wrapper');
      if (!wrapper) return;

      const nodeEl = wrapper.closest('[data-node-id]');
      console.log(`🗑️ Deleting broken image in node: ${nodeEl?.id}`);

      wrapper.remove();

      // If the node is now empty, give it a <br> so it stays editable
      if (nodeEl && nodeEl.textContent.trim() === '' && !nodeEl.querySelector('img, iframe, video')) {
        nodeEl.innerHTML = '<br>';
      }

      // Place cursor in the parent node
      if (nodeEl) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(nodeEl);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      console.log(`✅ Broken image removed`);
    } else {
      // Video embed: the .video-embed IS the node element
      const videoEmbed = deleteBtn.closest('.video-embed');
      if (!videoEmbed || !videoEmbed.id) return;

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

  // 🎯 SUP TAG HANDLER: Initialize handlers for typing, deleting, and navigating around sup elements
  if (supTagHandler) {
    supTagHandler.stopListening();
  }
  supTagHandler = new SupTagHandler(editableDiv);
  supTagHandler.startListening();

  // 🚀 PERFORMANCE: Handle text input via debounced input event instead of characterData observer
  // This dramatically reduces mutation events during typing
  debouncedInputHandlerRef = debounce((e) => {
    verbose.user(`INPUT EVENT: ${e.type} ${e.inputType}, isEditing: ${window.isEditing}, isComposing: ${isComposing}`, 'divEditor/index.js');
    if (!window.isEditing || isComposing) {
      verbose.user('INPUT HANDLER: Skipped (not editing or composing)', 'divEditor/index.js');
      return; // Skip during mobile IME composition
    }

    // Get the actual element where the cursor is, not e.target (which is always the contenteditable container)
    const selection = window.getSelection();
    verbose.user(`SELECTION: ${selection ? 'exists' : 'null'}, rangeCount: ${selection?.rangeCount}`, 'divEditor/index.js');
    if (!selection || !selection.rangeCount) {
      // 🛡️ Selection gone (e.g., user clicked overlay during debounce) — use cached node ID
      if (lastInputNodeId) {
        verbose.user(`FALLBACK: No selection, using lastInputNodeId: ${lastInputNodeId}`, 'divEditor/index.js');
        queueNodeForSave(lastInputNodeId, 'update');
      } else {
        verbose.user('INPUT HANDLER: No selection and no lastInputNodeId', 'divEditor/index.js');
      }
      return;
    }

    let targetElement = selection.getRangeAt(0).startContainer;

    // If it's a text node, get its parent element
    if (targetElement.nodeType === Node.TEXT_NODE) {
      targetElement = targetElement.parentElement;
    }

    if (!targetElement) {
      verbose.user('INPUT HANDLER: No target element', 'divEditor/index.js');
      return;
    }
    verbose.user(`TARGET ELEMENT: ${targetElement.nodeName}, id: ${targetElement.id}`, 'divEditor/index.js');

    // 🚀 PERFORMANCE: Check cache first (50-90% faster on repeat keystrokes)
    let parentWithId = elementToNumericalParent.get(targetElement);
    verbose.user(`CACHE CHECK: ${parentWithId ? `found ${parentWithId.id}` : 'cache miss'}`, 'divEditor/index.js');

    if (!parentWithId) {
      // Cache miss - do expensive lookup
      parentWithId = targetElement.closest('[id]');
      verbose.user(`CLOSEST [id]: ${parentWithId ? parentWithId.id : 'none found'}`, 'divEditor/index.js');

      while (parentWithId && !NUMERICAL_ID_PATTERN.test(parentWithId.id)) {
        parentWithId = parentWithId.parentElement?.closest('[id]');
        verbose.user(`PARENT SEARCH: ${parentWithId ? parentWithId.id : 'no match'}`, 'divEditor/index.js');
      }

      // Cache the result for future lookups
      if (parentWithId) {
        elementToNumericalParent.set(targetElement, parentWithId);
      }
    }

    if (parentWithId?.id) {
      lastInputNodeId = parentWithId.id;
      verbose.content(`Input event: queueing ${parentWithId.id} for update`, 'divEditor/index.js');
      queueNodeForSave(parentWithId.id, 'update');
      checkAndInvalidateTocCache(parentWithId.id, parentWithId);
    } else {
      // 🛡️ Selection moved away from contenteditable (e.g., to overlay) — use cached node ID
      if (lastInputNodeId) {
        verbose.user(`FALLBACK: No numerical parent, using lastInputNodeId: ${lastInputNodeId}`, 'divEditor/index.js');
        queueNodeForSave(lastInputNodeId, 'update');
        checkAndInvalidateTocCache(lastInputNodeId, document.getElementById(lastInputNodeId));
      } else {
        verbose.user('INPUT HANDLER: No parent with valid ID found', 'divEditor/index.js');
      }
    }
  }, 200); // 🚀 Reduced from 300ms to 200ms for snappier feel

  // 🛡️ Wrap input event to eagerly capture node ID before debounce
  // Selection may move by the time the 200ms debounce fires (e.g., overlay click)
  inputEventHandler = (e) => {
    if (window.isEditing && !isComposing) {
      if (saveQueue) saveQueue.recordInputEvent();
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        let el = sel.getRangeAt(0).startContainer;
        if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
        if (el) {
          let parent = elementToNumericalParent.get(el);
          if (!parent) {
            parent = el.closest('[id]');
            while (parent && !NUMERICAL_ID_PATTERN.test(parent.id)) {
              parent = parent.parentElement?.closest('[id]');
            }
            if (parent) elementToNumericalParent.set(el, parent);
          }
          if (parent?.id) lastInputNodeId = parent.id;
        }
      }
    }
    debouncedInputHandlerRef(e);
  };
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
    debouncedInputHandlerRef(e);
  });

  // ✅ Only ensure structure if document is truly empty (new/imported books)
  // For sub-book editors (bookId set), skip — sub-book content is always pre-populated
  if (!bookId) {
    const hasContent = document.querySelector('.main-content .chunk [id]');
    if (!hasContent) {
      ensureMinimumDocumentStructure();
    }
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
    // Skip all mutations during programmatic DOM updates (e.g. highlight reprocessing)
    if (isProgrammaticUpdateInProgress()) return;

    // 🛡️ Verify mutations are from the correct container
    const validMutations = mutations.filter(mutation => {
      if (!verifyMutationSource(mutation)) {
        // Mutation is from wrong container - log and skip
        console.warn('[Observer] Skipping leaked mutation:', mutation.type, 'on', mutation.target?.id || mutation.target?.nodeName);
        return false;
      }
      return true;
    });
    
    // 🚀 PERFORMANCE: Queue valid mutations for batch processing via MutationProcessor
    if (validMutations.length > 0) {
      mutationProcessor.enqueue(validMutations);
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
    // 🚀 PERFORMANCE: Only watch 'style' attribute (for SPAN destruction)
    // Removes 70-90% of unnecessary attribute mutation events
    attributes: true,
    attributeFilter: ['style'], // Only observe style changes (for SPAN tag cleanup)
    // 🚀 PERFORMANCE: characterData removed - text changes handled via input event instead
    // This reduces mutation events by ~80% during typing
    // Removed attributeOldValue and characterDataOldValue for better performance (not used)
  });

  // Log successful connection
  const targetId = editableDiv.id || editableDiv.getAttribute('data-book-id') || 'unknown';
  console.log(`[Observer] 🔌 CONNECTED to ${targetId}`);

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

export async function stopObserving() {
  if (observer) {
    const oldTarget = observedEditableDiv?.id || observedEditableDiv?.getAttribute('data-book-id') || 'unknown';
    observer.disconnect();
    console.log(`[Observer] 🔌 DISCONNECTED from ${oldTarget}`);
    observer = null;
  }

  // 📝 Unregister the edit session
  const activeSession = getActiveEditSession();
  if (activeSession) {
    unregisterEditSession(activeSession.containerId);
  }

  if (enterKeyHandler) {
    enterKeyHandler.destroy();
    enterKeyHandler = null;
  }

  // 🚀 Cleanup MutationProcessor — flush pending structural mutations before destroying
  if (mutationProcessor) {
    mutationProcessor.flush();
    mutationProcessor.destroy();
    mutationProcessor = null;
    verbose.content("MutationProcessor flushed and destroyed", 'divEditor/index.js');
  }

  // 🔑 CRITICAL: Flush input debounce BEFORE SaveQueue cleanup
  // This captures typing that hasn't been queued yet (within debounce window)
  if (debouncedInputHandlerRef) {
    verbose.content('[EditSession] Flushing pending input debounce...', 'divEditor/index.js');
    debouncedInputHandlerRef.flush();
    debouncedInputHandlerRef = null;
    verbose.content('[EditSession] Input debounce flushed', 'divEditor/index.js');
  }

  // 💾 Flush then cleanup SaveQueue
  if (saveQueue) {
    await saveQueue.flush();
    saveQueue.destroy();
    saveQueue = null;
    verbose.content("SaveQueue destroyed", 'divEditor/index.js');
  }

  // 🔧 FIX 7b: Remove video delete handler
  // Use stored observedEditableDiv (not hardcoded .main-content) so sub-book editors clean up correctly
  const editableDiv = observedEditableDiv;
  if (videoDeleteHandler && editableDiv) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
    videoDeleteHandler = null;
    verbose.content("Video delete handler removed", 'divEditor/index.js');
  }

  // 🎯 Cleanup SupTagHandler
  if (supTagHandler) {
    supTagHandler.stopListening();
    supTagHandler = null;
    verbose.content("SupTagHandler destroyed", 'divEditor/index.js');
  }

  // 🚀 PERFORMANCE: Remove input event handlers
  if (inputEventHandler && editableDiv) {
    editableDiv.removeEventListener('input', inputEventHandler);
    editableDiv.removeEventListener('compositionstart', () => {});
    editableDiv.removeEventListener('compositionend', () => {});
    inputEventHandler = null;
    verbose.content("Input event handlers removed", 'divEditor/index.js');
  }

  // 📌 Clear stored div reference
  observedEditableDiv = null;

  observedChunks.clear();
  verbose.content("Multi-chunk observer stopped and tracking cleared", 'divEditor/index.js');
  
  // Reset all state variables
  modifiedNodes.clear();
  addedNodes.clear();
  removedNodeIds.clear();
  documentChanged = false;
  lastInputNodeId = null;
  
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

  // 🛡️ VERIFY: Check if selection is in the active edit container
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    
    // Check if selection is within the active edit div
    if (!isEventInActiveDiv(element)) {
      // Selection is outside active container - ignore this selectionchange
      // This prevents main-content cursor changes from affecting hyperlit editing
      verbose.content(`selectionchange ignored - outside active div`, 'divEditor/index.js');
      return;
    }

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

      // 🆕 LI HANDLING: Backspace at start of LI converts it to paragraph
      if (event.key === 'Backspace' && range.collapsed) {
        const liElement = targetElement?.closest('li');
        if (liElement) {
          // Check if cursor is at the very start of the LI
          let isAtStart = false;
          if (range.startContainer.nodeType === Node.TEXT_NODE) {
            isAtStart = range.startOffset === 0 &&
              (range.startContainer === liElement.firstChild ||
               range.startContainer.parentNode === liElement.firstChild ||
               !liElement.textContent.substring(0, range.startContainer.textContent.length).trim());
          } else if (range.startContainer === liElement) {
            isAtStart = range.startOffset === 0;
          }

          if (isAtStart) {
            event.preventDefault();

            const parentList = liElement.closest('ul, ol');
            if (!parentList) return;

            // Ensure parent list has ID
            ensureNodeHasValidId(parentList);
            if (!parentList.id) {
              console.error("Could not assign ID to parent list");
              return;
            }

            // Get position of this LI
            const allItems = Array.from(parentList.children);
            const itemIndex = allItems.indexOf(liElement);
            const itemsBefore = allItems.slice(0, itemIndex);
            const itemsAfter = allItems.slice(itemIndex + 1);

            // Create paragraph with LI content
            const newParagraph = document.createElement('p');
            newParagraph.innerHTML = liElement.innerHTML || '<br>';

            // Remove the LI
            liElement.remove();

            if (parentList.children.length === 0) {
              // List is now empty - replace it with the paragraph
              setElementIds(newParagraph, findPreviousElementId(parentList), findNextElementId(parentList), book);
              parentList.replaceWith(newParagraph);
              queueNodeForSave(newParagraph.id, 'add');
            } else if (itemsBefore.length === 0) {
              // Was first item - put paragraph before list
              setElementIds(newParagraph, findPreviousElementId(parentList), parentList.id, book);
              parentList.before(newParagraph);
              queueNodeForSave(newParagraph.id, 'add');
              queueNodeForSave(parentList.id, 'update');
            } else if (itemsAfter.length === 0) {
              // Was last item - put paragraph after list
              setElementIds(newParagraph, parentList.id, findNextElementId(parentList), book);
              parentList.after(newParagraph);
              queueNodeForSave(parentList.id, 'update');
              queueNodeForSave(newParagraph.id, 'add');
            } else {
              // Was in the middle - split the list
              const newList = document.createElement(parentList.tagName);
              itemsAfter.forEach(item => newList.appendChild(item));

              setElementIds(newParagraph, parentList.id, null, book);
              parentList.after(newParagraph);

              setElementIds(newList, newParagraph.id, findNextElementId(newParagraph), book);
              newParagraph.after(newList);

              queueNodeForSave(parentList.id, 'update');
              queueNodeForSave(newParagraph.id, 'add');
              queueNodeForSave(newList.id, 'add');
            }

            // Move cursor to start of new paragraph
            const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
              ? newParagraph.firstChild
              : newParagraph;
            const newRange = document.createRange();
            newRange.setStart(target, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            return;
          }
        }
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
          // Try to transfer the marker to another node
          const nextNode = findNextNoDeleteNode();
          if (nextNode && nextNode !== elementWithId) {
            // Transfer marker and allow deletion to proceed
            console.log(`🔄 [NO-DELETE] Transferring marker from ${elementWithId.id} to ${nextNode.id}`);
            transferNoDeleteMarker(elementWithId, nextNode);
            // Don't preventDefault - let deletion proceed
          } else {
            // This is the LAST node - refuse deletion
            console.log(`🛑 [NO-DELETE] Refusing deletion - this is the last node`);
            event.preventDefault();
            return;
          }
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
