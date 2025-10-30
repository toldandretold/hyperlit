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
import { ChunkMutationHandler } from './divEditor/chunkMutationHandler.js';

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
