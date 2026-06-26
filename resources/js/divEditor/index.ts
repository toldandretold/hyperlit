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
  chunkOverflowInProgress,
  currentObservedChunk,
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
// Resolve the TRUE top-level node (not an innermost phantom) + clean stray
// descendant ids — see utilities/nodeResolve for why broken-image delete needs it.
import { resolveTopLevelNode, stripPhantomDescendantIds } from '../utilities/nodeResolve';
export { movedNodesByOverflow, queueNodeForSave, queueNodeForDeletion };
import { MutationProcessor } from './mutationProcessor';
import { EnterKeyHandler } from './enterKeyHandler/index';
import { SupTagHandler } from './supTagHandler/index';
import { ChunkMutationHandler } from './chunkMutationHandler/index';
import {
  registerEditSession,
  unregisterEditSession,
  verifyMutationSource,
  isEventInActiveDiv,
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
  setNoDeleteMarker,
  findNextNoDeleteNode,
  transferNoDeleteMarker
} from './domUtilities';

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
import { generateIdBetween,
         setElementIds,
         isNumericalId,
         ensureNodeHasValidId,
         asLineId,
         NUMERICAL_ID_PATTERN,
         findPreviousElementId,
         findNextElementId,
         type BookId,
         type LineId,
          } from "../utilities/idHelpers";
import {
  broadcastToOpenTabs
} from '../utilities/BroadcastListener';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown';
import { BLOCK_ELEMENT_SELECTOR } from '../utilities/blockElements';
import { listItemIsEmpty, placeCaretAtEndOfListItem } from '../utilities/listItemCaret';
import { stripInlineStylePreservingIntensity } from '../utilities/stripInlineStyle';

import {
  trackChunkNodeCount,
  handleChunkOverflow,
  NODE_LIMIT,
  chunkNodeCounts,
  getCurrentChunk
} from './chunkManager';
import { isPasteOperationActive } from '../paste/pasteState';
import { isChunkLoadingInProgress, getLoadingChunkId } from '../lazyLoader/utilities/chunkLoadingState';
import { SelectionDeletionHandler } from './selectionDelete';
import { getEditToolbar } from '../editToolbar/index';
import { delinkHypercite, handleHyperciteDeletion } from "../hypercites/index";
import { checkAndInvalidateTocCache, invalidateTocCacheForDeletion } from '../components/tocContainer/index';

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
let debounceTimer = null;

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
let deletionHandler = null;

// 🚀 PERFORMANCE: Input event handler for text changes (replaces characterData observer)
let inputEventHandler: ((e: Event) => void) | null = null;
let debouncedInputHandlerRef: ReturnType<typeof debounce> | null = null; // Reference to debounced handler for flushing on close
let isComposing = false; // Track mobile IME composition state

// 🚀 PERFORMANCE: Cache for input handler parent lookups (50-90% faster)
const elementToNumericalParent = new WeakMap();

// 🛡️ SAFETY NET: Track last input node ID so flush can save even when selection moves
// (e.g., user clicks overlay to close within 200ms debounce window)
let lastInputNodeId: LineId | null = null;

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

  // Create named function so we can remove it later
  videoDeleteHandler = (e: any) => {
    const deleteBtn = e.target.closest('[data-action="delete-video"], [data-action="delete-broken-image"]');
    if (!deleteBtn) return; // Early exit for performance

    e.preventDefault();
    e.stopPropagation();

    const isImage = deleteBtn.dataset.action === 'delete-broken-image';

    if (isImage) {
      const wrapper = deleteBtn.closest('.broken-image-wrapper');
      if (!wrapper) return;

      // ✅ Resolve the REAL top-level node (e.g. the <figure>), NOT an innermost
      // phantom node that backend conversion may have stamped inside it. Using
      // wrapper.closest('[data-node-id]') here climbed to a ghost <p>/<button>
      // inside the figure, so the figure's stored content was never updated and
      // the broken image returned on refresh. See utilities/nodeResolve.
      const nodeEl = resolveTopLevelNode(wrapper, editableDiv);
      console.log(`🗑️ Deleting broken image in node: ${nodeEl?.id}`);

      if (!nodeEl) {
        wrapper.remove();
        return;
      }

      const lineId = nodeEl.id ? asLineId(nodeEl.id) : null;
      // When the <picture>/<img> IS the node, the wrapper we created sits OUTSIDE
      // the node element (it contains it) — so the node holds nothing but the
      // image and deleting the image means deleting the whole node.
      const nodeInsideWrapper = wrapper.contains(nodeEl);

      let deleteWholeNode = nodeInsideWrapper;
      let focusTarget: Element | null = null;

      if (nodeInsideWrapper) {
        // Remove the whole node (the wrapper carries it out of the DOM). The
        // MutationObserver can't see a numeric-id removal when a non-id wrapper
        // is removed, so we persist the deletion explicitly below.
        focusTarget = wrapper.nextElementSibling || wrapper.previousElementSibling;
        wrapper.remove();
      } else {
        // The image is one part of a richer node → drop just the image subtree.
        wrapper.remove();
        // 🧹 Strip phantom numeric id / data-node-id off descendants so the node
        // persists as a single clean record (defensive for already-imported
        // books that have these baked in).
        stripPhantomDescendantIds(nodeEl);

        const hasMedia = !!nodeEl.querySelector('img, picture, iframe, video');
        if (nodeEl.textContent.trim() === '' && !hasMedia) {
          // Nothing meaningful left — delete the whole node rather than leaving
          // an empty shell (e.g. <figure><br></figure>).
          deleteWholeNode = true;
          focusTarget = nodeEl.nextElementSibling || nodeEl.previousElementSibling;
          nodeEl.remove();
        } else {
          focusTarget = nodeEl;
        }
      }

      if (deleteWholeNode) {
        // deletionMap is keyed by lineId, so this is idempotent even if the
        // MutationObserver also catches the figure-shell removal.
        if (lineId && saveQueue) {
          saveQueue.queueDeletion(lineId, nodeEl, bookId);
        }
        console.log(`✅ Broken image removed (node ${lineId ?? '?'} deleted)`);
      } else {
        // Explicit save — don't rely on MutationObserver alone
        if (lineId && saveQueue) {
          saveQueue.queueNode(lineId, 'update');
        }
        console.log(`✅ Broken image removed`);
      }

      if (focusTarget && (focusTarget as HTMLElement).isConnected) {
        const range = document.createRange();
        const selection: any = window.getSelection();
        range.selectNodeContents(focusTarget);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
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
          const selection: any = window.getSelection();

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
          const selection: any = window.getSelection();
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
  debouncedInputHandlerRef = debounce((e: any) => {
    verbose.user(`INPUT EVENT: ${e.type} ${e.inputType}, isEditing: ${(window as any).isEditing}, isComposing: ${isComposing}`, 'divEditor/index.js');
    if (!(window as any).isEditing || isComposing) {
      verbose.user('INPUT HANDLER: Skipped (not editing or composing)', 'divEditor/index.js');
      return; // Skip during mobile IME composition
    }

    // Get the actual element where the cursor is, not e.target (which is always the contenteditable container)
    const selection: any = window.getSelection();
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
      // Strip browser-injected inline style attributes (e.g. font-family from execCommand)
      // Keeps the live DOM clean — batch.js already strips on save, this fixes it sooner.
      // Preserve the *-intensity custom properties (hyperlight/hypercite opacity) so marks
      // don't go invisible mid-edit — same as batch.js, so DOM and IndexedDB stay in sync.
      parentWithId.querySelectorAll('[style]').forEach((el: any) => {
        if (!el.matches(BLOCK_ELEMENT_SELECTOR + ', li')) {
          stripInlineStylePreservingIntensity(el);
        }
      });
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
  inputEventHandler = (e: any) => {
    if ((window as any).isEditing && !isComposing) {
      if (saveQueue) saveQueue.recordInputEvent();
      const sel: any = window.getSelection();
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
    debouncedInputHandlerRef?.(e);
  };
  editableDiv.addEventListener('input', inputEventHandler);

  // 🚀 MOBILE: Handle IME composition events (autocorrect, predictive text)
  editableDiv.addEventListener('compositionstart', () => {
    isComposing = true;
    verbose.content('IME composition started - pausing input processing', 'divEditor/index.js');
  });

  editableDiv.addEventListener('compositionend', (e: any) => {
    isComposing = false;
    verbose.content('IME composition ended - resuming input processing', 'divEditor/index.js');
    // Trigger input handler after composition completes
    debouncedInputHandlerRef?.(e);
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
        // Mutation is from wrong container - log and skip
        console.warn('[Observer] Skipping leaked mutation:', mutation.type, 'on', mutation.target?.id || mutation.target?.nodeName);
        return false;
      }
      return true;
    });
    
    // 🚀 PERFORMANCE: Queue valid mutations for batch processing via MutationProcessor
    if (validMutations.length > 0) {
      mutationProcessor?.enqueue(validMutations);
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

// Inject the observer-stop into the session manager so it can preempt a previous
// session without importing back from this module (breaks the index↔session cycle).
// stopObserving is a hoisted function declaration, so this is safe at module load.
setPreemptStop(stopObserving);

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

  // Drop the module-level rebalance handle (a fresh one is set on the next startObserving).
  activeChunkHandler = null;

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
  if (!(window as any).isEditing || chunkOverflowInProgress) return;

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
  if (!(window as any).isEditing) return;

  // 🛡️ VERIFY: Check if selection is in the active edit container
  const selection: any = window.getSelection();
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
      const validElement = editableDiv?.querySelector('[id]:not([id$="-top-sentinel"]):not([id$="-bottom-sentinel"])') as HTMLElement | null;

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
  if (!(window as any).isEditing) return;

  // 🆕 O(1) CHECK: Use no-delete-id marker instead of expensive DOM queries
  if (['Backspace', 'Delete'].includes(event.key)) {
    const selection: any = document.getSelection();
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
          // EMPTY bullet + Backspace: don't outdent to a paragraph. If there's a
          // previous bullet, just remove this one and drop the caret at the end
          // of that previous bullet — the caret stays in the list (intuitive
          // backward-delete). Only an empty FIRST bullet (no previous sibling)
          // falls through to the outdent-to-paragraph path below.
          // NOTE: an empty bullet holds a zero-width-space caret anchor (see
          // listItemCaret.js), so listItemIsEmpty — not a raw offset check — is
          // what reliably detects "empty" here.
          if (listItemIsEmpty(liElement)) {
            const prevLi = liElement.previousElementSibling;
            if (prevLi && prevLi.tagName === 'LI') {
              event.preventDefault();
              const parentList = liElement.closest('ul, ol');
              if (parentList) {
                ensureNodeHasValidId(parentList);
                liElement.remove();
                placeCaretAtEndOfListItem(prevLi);
                queueNodeForSave(parentList.id, 'update');
                return;
              }
            }
          }

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

          // An empty FIRST bullet (no previous sibling, so not handled above)
          // holds a zero-width-space anchor → caret at offset 1, not 0. Treat it
          // as "at start" so a single Backspace still outdents it to a paragraph.
          if (listItemIsEmpty(liElement)) {
            isAtStart = true;
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

            // Create paragraph with LI content. An empty bullet may hold a
            // zero-width-space caret anchor — normalise that to a <br> so the
            // new paragraph isn't seeded with a stray ZWSP.
            const newParagraph = document.createElement('p');
            newParagraph.innerHTML = listItemIsEmpty(liElement) ? '<br>' : (liElement.innerHTML || '<br>');

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

// Register editor-buffer flushing so the orchestrator/sync layer can flush us on close/unload
// without importing divEditor (dependency points down into the registry leaf). Order preserved:
// input debounce (captures pending typing into the SaveQueue) → drain the SaveQueue.
registerPendingEditFlush(async () => {
  flushInputDebounce();
  await flushAllPendingSaves();
});
