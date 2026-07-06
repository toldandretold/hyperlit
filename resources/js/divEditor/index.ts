import { book } from "../app";
import { getCurrentUserId } from "../utilities/auth/index";
import { registerPendingEditFlush } from "../utilities/pendingEditsRegistry";
import {
  updateSingleIndexedDBRecord,
  deleteIndexedDBRecordWithRetry,
  batchDeleteIndexedDBRecords,
  openDatabase,
  updateCitationForExistingHypercite,
  batchUpdateIndexedDBRecords,
  getNodesAfter,
  deleteNodesAfter,
  writeNodes,
  prepareLibraryForIndexedDB
          } from "../indexedDB/index.js";
import {
  withPending,
  setCurrentObservedChunk,
  hypercitePasteInProgress,
  keyboardLayoutInProgress,
  isProgrammaticUpdateInProgress,
  isPasteInProgress
} from '../utilities/operationState';

import { SaveQueue } from './saveQueue';
// `debounce` lives in a zero-import leaf — import it directly rather than bouncing
// through saveQueue. index↔saveQueue is a circular import (via ../paste); reaching
// through it for a top-level debounce() call hit a TDZ ("debounce is not a function")
// when load order flipped. The SaveQueue class is only used at runtime, so it's safe.
import { debounce } from '../utilities/debounce';
// Shared editor state + enqueue API — extracted to a leaf to break the index↔handler cycle.
import { movedNodesByOverflow, queueNodeForSave, queueNodeForDeletion, setActiveSaveQueue } from './editorState';
export { movedNodesByOverflow, queueNodeForSave, queueNodeForDeletion };
import { MutationProcessor } from './mutationProcessor';
import { EnterKeyHandler } from './enterKeyHandler/index';
import { SupTagHandler } from './supTagHandler/index';
import { ChunkMutationHandler } from './chunkMutationHandler/index';
import {
  registerEditSession,
  unregisterEditSession,
  verifyMutationSource,
  getActiveEditSession,
  setPreemptStop
} from './editSessionManager';
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
} from './domUtilities';
import { handleNoDeleteGuard, handleListItemBackspace } from './keydownGuards/index';

// Re-export for backward compatibility
export {
  debounce,
  cleanupStyledSpans,
  cleanupAfterImport,
  cleanupAfterPaste,
  getNoDeleteNode,
  setNoDeleteMarker
};

import { glowCloudOrange, glowCloudGreen, isProcessing } from '../components/cloudRef/editIndicator';
import { verbose } from '../utilities/logger';

import { buildBibtexEntry } from "../utilities/bibtexProcessor";
import { type BookId } from "../utilities/idHelpers";
import { createVideoDeleteHandler } from './videoDeleteHandler';
import { createInputHandler, type InputHandler } from './inputHandler';
import {
  broadcastToOpenTabs
} from '../utilities/BroadcastListener';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown';

import {
  trackChunkNodeCount,
  handleChunkOverflow,
  NODE_LIMIT,
  chunkNodeCounts,
  getCurrentChunk
} from './chunkManager';
import { isPasteOperationActive } from '../paste/pasteState';
import { isChunkLoadingInProgress, getLoadingChunkId } from '../lazyLoader/utilities/chunkLoadingState';
import { delinkHypercite, handleHyperciteDeletion } from "../hypercites/index";
import { initSelectionFocusTracker } from './selectionFocusTracker';

// ================================================================
// MODULE STATE
// ================================================================
// This orchestrator maintains minimal state - most logic has been
// extracted to specialized modules. State variables track:
// - Observer instances (MutationObserver, SaveQueue, etc.)
// - Tracking sets for node changes
// - UI handler references for cleanup

// movedNodesByOverflow now lives in the editorState leaf (imported + re-exported above).
// Tracking sets
const modifiedNodes = new Set<string>(); // Track element IDs whose content was modified.
const addedNodes = new Set<Node>(); // Track newly-added element nodes.
const removedNodeIds = new Set<string>(); // Track IDs of removed nodes.

let observer: MutationObserver | null = null;
let documentChanged = false;

// Per-chunk cache — NOT "which chunk is observed" (the
// observer always watches the whole container, below).
//
// Only ChunkMutationHandler.processByChunk reads it
// (chunkMutationHandler/index.ts): when edits land it groups
// the mutations per chunk under a `${bookId}:${chunkId}` key,
// then looks the chunk up here to get
//   • a cached reference to the chunk's DOM node, to skip
//     re-querying the page on every edit, and
//   • the bookId that chunk belongs to (the editing can
//     hold MAIN-book and open footnote/hyperlight SUB-BOOK chunks at
//     once)
// On a miss it derives the bookId and caches it. index.ts
// just owns the Map (hands it to the handler, clears it on
// teardown); it never reads it.
let observedChunks = new Map();

// 🚀 PERFORMANCE: Input event pipeline (debounced input + IME composition) — logic and its
// state (isComposing / lastInputNodeId / parent-lookup cache) live in inputHandler.ts.
let inputHandler: InputHandler | null = null;

// 🔧 FIX 7b: Track video delete handler for cleanup
let videoDeleteHandler: ((e: MouseEvent) => void) | null = null;

// 🎯 SUP TAG HANDLER: Handles typing, deleting, and navigation around sup elements
let supTagHandler: SupTagHandler | null = null;

// 💾 Save Queue instance (replaces old pendingSaves + debounce logic)
let saveQueue: SaveQueue | null = null;

// 📌 Store the currently-observed editable div so stopObserving removes listeners from the right element
let observedEditableDiv: HTMLElement | null = null;

// 🚀 Mutation Processor instance (RAF-based mutation batching)
let mutationProcessor: MutationProcessor | null = null;

// 📌 Active ChunkMutationHandler — kept module-level so flushAllPendingSaves can force any
// deferred (debounced) chunk rebalance to run before we persist (see flushRebalance).
let activeChunkHandler: ChunkMutationHandler | null = null;

// ✅ EnterKeyHandler instance
let enterKeyHandler: EnterKeyHandler | null = null;

// ================================================================
// PUBLIC API
// ================================================================
// External modules call these functions to interact with the editor.
// Most functionality is delegated to specialized modules.
// ================================================================

// queueNodeForSave / queueNodeForDeletion now live in the editorState leaf (see the
// import + re-export near the top of this file) so the handlers can import them
// without the index↔handler cycle. They delegate to the SaveQueue instance that
// index.js wires in via setActiveSaveQueue() in startObserving/stopObserving.


// ================================================================
// PAGE UNLOAD HANDLING
// ================================================================

// Force save all pending changes (useful for page unload)
export async function flushAllPendingSaves() {
  verbose.content('Flushing all pending saves...', 'divEditor/index.js');

  // Force any deferred (debounced) chunk rebalance to run + persist FIRST, so we never leave an
  // over-limit chunk as the persisted state at a flush boundary (edit-exit / beforeunload /
  // redownload). No-op when no chunk is over the limit.
  if (activeChunkHandler) {
    await activeChunkHandler.flushRebalance();
  }

  if (saveQueue) {
    await saveQueue.flush();
    verbose.content('All pending saves flushed', 'divEditor/index.js');
  }
}

/**
 * Read-only view of the node ids (= LineId / startLine strings) with edits queued but not yet
 * flushed to IndexedDB. Used by chunk windowing to avoid removing a chunk's DOM while it still
 * holds an unsaved edit (the save path reads the live DOM at flush). Empty when no edit session.
 */
export function getPendingSaveNodeIds(): Set<string> {
  return saveQueue ? new Set(saveQueue.pendingSaves.nodes.keys()) : new Set();
}

// 🔑 CRITICAL: Flush input debounce to capture recent typing
// This forces the 200ms debounced input handler to execute immediately
export function flushInputDebounce() {
  verbose.content('[EditSession] Flushing input debounce...', 'divEditor/index.js');
  if (inputHandler) {
    inputHandler.flush();
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

export async function startObserving(editableDiv: HTMLElement, bookId: BookId | null = null) {

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
  setActiveSaveQueue(saveQueue);   // wire the enqueue API in editorState to this instance

  // 🎬 VIDEO DELETE HANDLER: Handle video embed delete button clicks
  // 🔧 FIX 7b: Remove old handler if it exists
  if (videoDeleteHandler) {
    editableDiv.removeEventListener('click', videoDeleteHandler);
  }

  // Create named function so we can remove it later (logic lives in videoDeleteHandler.ts)
  videoDeleteHandler = createVideoDeleteHandler({
    editableDiv,
    bookId,
    getSaveQueue: () => saveQueue,
  });

  // Attach the handler
  editableDiv.addEventListener('click', videoDeleteHandler);

  // 🎯 SUP TAG HANDLER: Initialize handlers for typing, deleting, and navigating around sup elements
  if (supTagHandler) {
    supTagHandler.stopListening();
  }
  supTagHandler = new SupTagHandler(editableDiv);
  supTagHandler.startListening();

  // 🚀 PERFORMANCE: Text input pipeline (debounced input + eager node-id capture + IME
  // composition) lives in inputHandler.ts. It owns its own state and listeners; destroy()
  // removes the real references (fixes the old composition-listener teardown leak).
  inputHandler = createInputHandler({ editableDiv, getSaveQueue: () => saveQueue });

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
  activeChunkHandler = chunkHandler;

  // 🚀 Initialize MutationProcessor with ChunkMutationHandler methods
  mutationProcessor = new MutationProcessor({
    filterMutations: chunkHandler.filterChunkMutations.bind(chunkHandler),
    processMutations: chunkHandler.processByChunk.bind(chunkHandler),
    shouldSkipMutation: chunkHandler.shouldSkipMutation.bind(chunkHandler),
    // When a paste/programmatic op makes us drop a mutation batch, run a structural overflow
    // sweep once it finishes — a small paste's direct DOM insertion can push a chunk past the
    // limit and those dropped mutations are never redelivered. No-op after a large paste.
    onTransientSkip: () => chunkHandler.scheduleOverflowSweep()
  });

  // Create observer for the main-content container
  observer = new MutationObserver((mutations) => {
    // Skip all mutations during programmatic DOM updates (e.g. highlight reprocessing) — the
    // editor mustn't process its own programmatic changes as user edits. BUT a programmatic
    // INSERT (e.g. small-paste direct DOM insertion) can push a chunk past NODE_LIMIT, and these
    // dropped MutationObserver records are never redelivered. So schedule a pure structural
    // overflow sweep that runs once the programmatic/paste operation finishes (no-op if clean).
    if (isProgrammaticUpdateInProgress()) {
      chunkHandler.scheduleOverflowSweep();
      return;
    }

    // 🛡️ Verify mutations are from the correct container
    const validMutations = mutations.filter((mutation: any) => {
      if (!verifyMutationSource(mutation)) {
        // Mutation is from wrong container - skip
        return false;
      }
      return true;
    });
    
    // 🚀 PERFORMANCE: Queue valid mutations for batch processing via MutationProcessor
    if (validMutations.length > 0) {
      mutationProcessor?.enqueue(validMutations);
    }
  });

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

  // Seed the focus tracker with the chunk the caret is currently in (a chunk-id string,
  // or null). The selectionchange handler keeps it updated from here on.
  const currentChunkId = getCurrentChunk();
  setCurrentObservedChunk(currentChunkId);
  verbose.content(`Set current observed chunk to: ${currentChunkId}`, 'divEditor/index.js');

  verbose.content(`Multi-chunk observer attached to .main-content`, 'divEditor/index.js');
}

// Initialize tracking for all chunks currently in the DOM
function initializeCurrentChunks(editableDiv: HTMLElement) {
  const chunks = editableDiv.querySelectorAll('.chunk');

  observedChunks.clear(); // Start fresh
  
  chunks.forEach((chunk: any) => {
    const chunkId = chunk.getAttribute('data-chunk-id');
    if (chunkId) {
      observedChunks.set(chunkId, chunk);
      trackChunkNodeCount(chunk);
      verbose.content(`Initialized tracking for chunk ${chunkId}`, 'divEditor/index.js');
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

// Inject the observer-stop into the session manager so it can preempt a previous
// session without importing back from this module (breaks the index↔session cycle).
// stopObserving is a hoisted function declaration, so this is safe at module load.
setPreemptStop(stopObserving);

export async function stopObserving() {
  if (observer) {
    observer.disconnect();
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

  // Drop the module-level rebalance handle (a fresh one is set on the next startObserving).
  activeChunkHandler = null;

  // 🔑 CRITICAL: Flush input debounce BEFORE SaveQueue cleanup
  // This captures typing that hasn't been queued yet (within debounce window).
  // Listeners are detached later (inputHandler.destroy()); flush only, here.
  if (inputHandler) {
    verbose.content('[EditSession] Flushing pending input debounce...', 'divEditor/index.js');
    inputHandler.flush();
    verbose.content('[EditSession] Input debounce flushed', 'divEditor/index.js');
  }

  // 💾 Flush then cleanup SaveQueue
  if (saveQueue) {
    await saveQueue.flush();
    saveQueue.destroy();
    saveQueue = null;
    setActiveSaveQueue(null);   // clear the editorState reference too
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

  // 🚀 PERFORMANCE: Remove input event handlers (input + compositionstart/end). destroy()
  // detaches the REAL listener references — the previous inline teardown removed the
  // composition listeners with fresh empty arrow fns, so they leaked across sessions.
  if (inputHandler) {
    inputHandler.destroy();
    inputHandler = null;
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

// 🚀 selectionchange focus tracking + sentinel-caret rescue live in selectionFocusTracker.ts
// (extracted + unit-tested); attach the single document listener once at module load.
initSelectionFocusTracker();

document.addEventListener("keydown", function handleTypingActivity(event) {
  if (!(window as any).isEditing) return;

  // Only act while keyboard FOCUS is inside the editable content — the
  // editor's selection lingers when Tab moves focus to a chrome button, and
  // Backspace/Delete pressed on a button must not mutate editor content
  // (same guard as enterKeyHandler).
  const focusTarget = event.target instanceof HTMLElement ? event.target : null;
  if (focusTarget && !focusTarget.closest('[contenteditable="true"]')) return;

  // 🆕 O(1) CHECK: delete-key guards. Both handlers are extracted to ./keydownGuards
  // (pure + unit-tested); this listener is just a thin dispatcher over them.
  if (['Backspace', 'Delete'].includes(event.key)) {
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);

      // Get the element that would be affected
      let targetNode: Node | null = range.startContainer;
      if (targetNode.nodeType !== Node.ELEMENT_NODE) {
        targetNode = targetNode.parentElement;
      }
      const targetElement = targetNode as Element | null;

      // 🆕 LI HANDLING: Backspace at start of LI converts it to paragraph
      if (handleListItemBackspace(event, range, selection, targetElement)) return;

      // 🛡️ NO-DELETE guard: protect (or transfer the marker off) the last node
      const elementWithId = targetElement?.closest('[id]');
      if (elementWithId && handleNoDeleteGuard(range, elementWithId)) {
        event.preventDefault();
        return;
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

// Register editor-buffer flushing so the orchestrator/sync layer can flush us on close/unload
// without importing divEditor (dependency points down into the registry leaf). Order preserved:
// input debounce (captures pending typing into the SaveQueue) → drain the SaveQueue.
registerPendingEditFlush(async () => {
  flushInputDebounce();
  await flushAllPendingSaves();
});
