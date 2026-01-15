import { log, verbose } from './utilities/logger.js';
import { renderBlockToHtml } from "./utilities/convertMarkdown.js";
import { sanitizeHtml } from './utilities/sanitizeConfig.js';
import { attachMarkListeners } from "./hyperlights/index.js";
import {
  //saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  getLocalStorageKey,
  getHyperciteFromIndexedDB
} from "./indexedDB/index.js";
import { attachUnderlineClickListeners } from "./hypercites/index.js";
import {
  setChunkLoadingInProgress,
  clearChunkLoadingInProgress,
  isChunkLoadingInProgress,
  scheduleAutoClear
} from "./utilities/chunkLoadingState.js";
import { setupUserScrollDetection, shouldSkipScrollRestoration, isActivelyScrollingForLinkBlock } from './scrolling.js';
import { scrollElementIntoMainContent } from "./scrolling.js";
import { isNewlyCreatedHighlight } from "./utilities/operationState.js";
import { LinkNavigationHandler } from './navigation/LinkNavigationHandler.js';
import { isCacheDirty, clearCacheDirtyFlag } from './utilities/cacheState.js';
import { getDisplayNumber } from './footnotes/FootnoteNumberingService.js';

/**
 * Apply dynamic footnote numbers to rendered HTML element.
 * Looks up display numbers from FootnoteNumberingService and updates
 * the fn-count-id attribute and link text.
 *
 * @param {HTMLElement} element - The DOM element containing footnote references
 */
function applyDynamicFootnoteNumbers(element) {
  // Find all footnote reference links
  const footnoteLinks = element.querySelectorAll('sup a.footnote-ref, a.footnote-ref');

  for (const link of footnoteLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Extract footnote ID from href (e.g., "#bookId_Fn1758412345001" → "bookId_Fn1758412345001")
    const footnoteId = href.replace(/^#/, '');
    if (!footnoteId) continue;

    // Get the dynamic display number from the service
    const displayNumber = getDisplayNumber(footnoteId);

    if (displayNumber) {
      // Update the parent sup's fn-count-id attribute
      const sup = link.closest('sup');
      if (sup) {
        sup.setAttribute('fn-count-id', displayNumber.toString());
      }
      // Update the visible link text
      link.textContent = displayNumber.toString();
    }
  }
}

// --- A simple throttle helper to limit scroll firing
function throttle(fn, delay) {
  let timer = null;
  return function (...args) {
    if (!timer) {
      timer = setTimeout(() => {
        fn.apply(this, args);
        timer = null;
      }, delay);
    }
  };
}

/**
 * Ensure exactly ONE no-delete-id marker exists per book.
 * Checks DOM first (fast), then IndexedDB, then adds if not found anywhere.
 *
 * Uses dynamic import to avoid circular dependency with divEditor/domUtilities.js
 * Persists marker to IndexedDB and syncs to backend.
 *
 * @param {HTMLElement} chunkElement - The chunk element that was just loaded
 * @param {Array} allNodesInBook - All nodes for this book from IndexedDB
 */
async function ensureNoDeleteMarkerForBook(chunkElement, allNodesInBook) {
  try {
    // 🔄 LAZY IMPORT: Avoid circular dependency (toc.js → containerManager → initializePage → lazyLoader → domUtilities → chunkMutationHandler → toc.js)
    const { getNoDeleteNode, setNoDeleteMarker } = await import('./divEditor/domUtilities.js');
    const { updateIndexedDBRecord } = await import('./indexedDB/index.js');

    // Step 1: Check DOM for marker (O(1) - very fast)
    if (getNoDeleteNode()) {
      verbose.content('no-delete-id marker already exists in DOM', 'lazyLoaderFactory.js');
      return; // Already exists in DOM
    }

    // Step 2: Check if marker exists in any node in IndexedDB
    // Safety check: allNodesInBook might be undefined/null for new books
    const hasMarkerInDB = allNodesInBook && Array.isArray(allNodesInBook)
      ? allNodesInBook.some(node => node.content && node.content.includes('no-delete-id="please"'))
      : false;

    if (hasMarkerInDB) {
      verbose.content('no-delete-id marker exists in IndexedDB (not yet loaded)', 'lazyLoaderFactory.js');
      return; // Exists in DB, will appear when that chunk loads
    }

    // Step 3: No marker anywhere - add to first node in this chunk
    const firstNode = chunkElement.querySelector('[id]');
    if (!firstNode) {
      console.warn('⚠️ Could not find node with ID to set no-delete marker');
      return;
    }

    // Step 3a: Set marker on DOM element
    setNoDeleteMarker(firstNode);
    console.log(`✅ Set no-delete-id marker on node ${firstNode.id} in DOM`);

    // Step 3b: Persist to IndexedDB and sync to backend
    await updateIndexedDBRecord({ id: firstNode.id });
    console.log(`✅ Persisted no-delete-id marker to IndexedDB & queued for backend sync`);
  } catch (error) {
    console.error('❌ FATAL: ensureNoDeleteMarkerForBook failed:', error);
    throw error; // Re-throw so we can see it in console
  }
}

/**
 * Factory function for lazy loading.
 *
 * IMPORTANT: The config object must include a property "bookId" which also
 * corresponds to the id of the container DIV in the DOM. For example, if bookId
 * is "book1", then the container is expected to be:
 *    <div id="book1" class="main-content"></div>
 */
export function createLazyLoader(config) {
  const {
    nodes,
    loadNextChunk,
    loadPreviousChunk,
    attachMarkListeners: attachMarkers,
    isRestoringFromCache = false,
    isNavigatingToInternalId = false,
    isUpdatingJsonContent = false,
    bookId = "latest",
    onFirstChunkLoaded,
  } = config;

  if (!nodes || nodes.length === 0) {
    log.error('No nodes available for lazy loader', 'lazyLoaderFactory.js');
    return null;
  }

  // --- MOVE THIS BLOCK UP! ---
  const container = document.getElementById(bookId); // <<< DEFINE CONTAINER FIRST
  if (!container) {
    log.error(`Container element with id "${bookId}" not found in the DOM`, 'lazyLoaderFactory.js');
    return null;
  }
  // --- END MOVED BLOCK ---

  // Now, container is defined, so you can safely use it:
  let scrollableParent;
  const readerWrapper = container.closest(".reader-content-wrapper");
  const homeWrapper = container.closest(".home-content-wrapper");
  const userWrapper = container.closest(".user-content-wrapper");

  if (readerWrapper) {
      scrollableParent = readerWrapper;
  } else if (homeWrapper) {
      scrollableParent = homeWrapper;
  } else if (userWrapper) {
      scrollableParent = userWrapper;
  } else {
      scrollableParent = window;
      verbose.init('Using window as scrollable parent', 'lazyLoaderFactory.js');
  }
  
  // Create the instance to track lazy-loader state.
  const instance = {
    nodes, // Array of chunk objects
    currentlyLoadedChunks: new Set(),
    observer: null,
    topSentinel: null,
    bottomSentinel: null,
    isRestoringFromCache,
    isNavigatingToInternalId,
    isUpdatingJsonContent,
    bookId,
    container, // Now 'container' is defined.
    scrollableParent,
    onFirstChunkLoadedCallback: onFirstChunkLoaded,
    scrollLocked: false, // NEW: Scroll position lock flag
    scrollLockReason: null, // NEW: Reason for lock (for debugging)
    scrollSaveCooldown: false, // NEW: Cooldown period after navigation
    refreshInProgress: false, // NEW: Prevents unlock during refresh
    lastViewportWidth: null, // Track viewport width for smart resize handling
  };

  // Set up user scroll detection to prevent restoration interference
  if (scrollableParent && scrollableParent !== window) {
    verbose.init("User scroll detection for container", 'lazyLoaderFactory.js');
    setupUserScrollDetection(scrollableParent);
  } else {
    verbose.init("User scroll detection for window", 'lazyLoaderFactory.js');
    setupUserScrollDetection(document.documentElement);
  }

  // 🔗 CENTRALIZED LINK HANDLING - scoped to this lazy loader instance
  const globalLinkHandler = async (event) => {
    const link = event.target.closest('a');
    if (!link || !link.href) return;

    // 🛑 PREVENT LINK CLICKS DURING ACTIVE SCROLLING
    if (isActivelyScrollingForLinkBlock()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // 🔗 CHECK FOR HYPERCITE CITATION LINKS (links pointing TO hypercites)
    // These should open the unified container instead of navigating
    // UNLESS they are:
    // 1. Inside the hyperlit-container (already in a container, should navigate directly)
    // 2. Have the "see-in-source-btn" class (action button from container)
    try {
      const url = new URL(link.href, window.location.origin);
      const hash = url.hash;

      // Check if link is inside the hyperlit-container
      const isInsideContainer = link.closest('#hyperlit-container');

      if (hash && hash.startsWith('#hypercite_') && !link.classList.contains('see-in-source-btn') && !isInsideContainer) {
        // Prevent default navigation immediately
        event.preventDefault();
        event.stopPropagation();

        // Extract target book ID from URL
        const targetBookId = url.pathname.replace('/', '');

        // Check if target book is private and if user has access
        try {
          const { openDatabase } = await import('./indexedDB/index.js');
          const db = await openDatabase();
          const tx = db.transaction('library', 'readonly');
          const libraryStore = tx.objectStore('library');
          const libraryData = await new Promise((resolve) => {
            const req = libraryStore.get(targetBookId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
          });

          // If book is deleted, prevent navigation and animate trash icon
          if (libraryData && libraryData.visibility === 'deleted') {
            const parentBlock = link.closest('p, blockquote, div');
            if (parentBlock) {
              const deletedIcon = parentBlock.querySelector('.deleted-icon');
              if (deletedIcon) {
                deletedIcon.style.transform = 'scale(1.3)';
                setTimeout(() => {
                  deletedIcon.style.transform = 'scale(1)';
                }, 200);
              }
            }
            return;
          }

          // If book is private, check access
          if (libraryData && libraryData.visibility === 'private') {
            const { canUserEditBook } = await import('./utilities/auth.js');
            const hasAccess = await canUserEditBook(targetBookId);

            if (!hasAccess) {

              // Find and animate the lock icon if this link has one nearby
              const parentBlock = link.closest('p, blockquote, div');
              if (parentBlock) {
                const lockIcon = parentBlock.querySelector('.private-lock-icon');
                if (lockIcon) {
                  lockIcon.style.transform = 'scale(1.3)';
                  setTimeout(() => {
                    lockIcon.style.transform = 'scale(1)';
                  }, 200);
                }
              }
              return;
            }
          }
        } catch (accessError) {
          console.error('🔗 LazyLoader: Error checking book access:', accessError);
          // Continue anyway - let the container handle it
        }

        // Import and call unified container handler
        const { handleUnifiedContentClick } = await import('./hyperlitContainer/index.js');
        await handleUnifiedContentClick(link);
        return;
      }
    } catch (error) {
      console.error('🔗 LazyLoader: Error checking for hypercite citation:', error);
      // Continue to normal link handling
    }

    try {
      // Delegate to LinkNavigationHandler for processing
      const handled = await LinkNavigationHandler.handleLinkClick(event);

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      } else if (handled === false) {
        // LinkNavigationHandler explicitly said not to handle this (e.g., homepage navigation)
        // Let the default browser behavior occur for proper history management
      }
    } catch (error) {
      console.error('🔗 LazyLoader: Link handling failed:', error);
    }
  };

  // Add the centralized link handler
  document.addEventListener('click', globalLinkHandler);
  instance.globalLinkHandler = globalLinkHandler; // Store for cleanup

  if (instance.isRestoringFromCache) {
    attachMarkers(container);
    return instance;
  }

  // Remove any existing sentinels.
  container.querySelectorAll(".sentinel").forEach((sentinel) => sentinel.remove());
  verbose.init("Removed existing sentinels", 'lazyLoaderFactory.js');

  // Here, the container's id is assumed to equal the book id. Use that as a unique id.
  const uniqueId = container.id || Math.random().toString(36).substr(2, 5);
  verbose.init(`Container ID: ${uniqueId}`, 'lazyLoaderFactory.js');

  // Wrap caching methods so the instance passes only bookId.
  //instance.saveNodeChunks = (chunks) => {
    //return saveNodeChunksToIndexedDB(chunks, instance.bookId);
  //};
  instance.getNodeChunks = () => {
    return getNodeChunksFromIndexedDB(instance.bookId);
  };

  // --- SCROLL POSITION SAVING LOGIC ---

  // Core saving logic. Can be called directly when a save is required.
  const forceSavePosition = (bypassLock = false) => {
    // 🔒 Ultimate guard - check locks unless explicitly bypassed
    if (!bypassLock && (instance.scrollLocked || instance.refreshInProgress)) {
      return;
    }
    // More efficient query for valid, trackable elements.
    const elements = instance.container.querySelectorAll("p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
    if (elements.length === 0) {
      return;
    }

    const scrollSourceRect = instance.scrollableParent === window
      ? { top: 0 } // Viewport top is always 0
      : instance.scrollableParent.getBoundingClientRect();

    // Find the first element that is at or below the container's top edge.
    let topVisible = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top >= scrollSourceRect.top) {
        topVisible = el;
        break;
      }
    }

    if (topVisible) {
      const detectedId = topVisible.id;

      // The query is specific, but we double-check for a numerical ID.
      if (/^\d+(\.\d+)?$/.test(detectedId)) {
        const scrollData = { elementId: detectedId };
        const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
        const stringifiedData = JSON.stringify(scrollData);

        // Only write to storage if the position has actually changed.
        const existingData = sessionStorage.getItem(storageKey);
        if (existingData !== stringifiedData) {
          sessionStorage.setItem(storageKey, stringifiedData);
          localStorage.setItem(storageKey, stringifiedData);
        }
      }
    }
  };

  // Guarded wrapper for the scroll event listener to use during manual scrolling.
  instance.saveScrollPosition = () => {
    // During user scrolling, respect the lock to prevent saving during navigation.
    if (instance.scrollLocked) {
      return;
    }
    forceSavePosition();
  };

  document.dispatchEvent(new Event("pageReady"));

  // 🚀 PERFORMANCE: Attach the throttled, guarded listener for regular user scrolling.
  // Using passive: true for better scroll performance (we never preventDefault)
  if (instance.scrollableParent === window) {
    window.addEventListener("scroll", throttle(instance.saveScrollPosition, 250), { passive: true });
  } else {
    instance.scrollableParent.addEventListener("scroll", throttle(instance.saveScrollPosition, 250), { passive: true });
  }

  instance.restoreScrollPositionAfterResize = async () => {
    // Check if user is currently scrolling
    if (shouldSkipScrollRestoration("instance restoreScrollPositionAfterResize")) {
      return;
    }
    
    const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
    const storedData =
      sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (!storedData) {
      return;
    }
    let scrollData;
    try {
      scrollData = JSON.parse(storedData);
    } catch (e) {
      console.error("Error parsing scroll data:", e);
      return;
    }
    // Ensure we have an elementId stored. In your case this corresponds to startLine.
    if (!(scrollData && scrollData.elementId)) return;

    // First, try to find the element in the already loaded DOM.
    // Use CSS.escape to properly escape the ID:
    // *** FIX 1: Use instance.container ***
    let targetElement = instance.container.querySelector(`#${CSS.escape(scrollData.elementId)}`);
    if (targetElement) {
      // *** FIX 2: Use scrollElementIntoMainContent ***
      scrollElementIntoMainContent(targetElement, instance.container, 50); // Pass instance.container
    } else {
      try {
        // Get the node chunks from IndexedDB.
        const nodesData = await instance.getNodeChunks();
        if (!nodesData || nodesData.length === 0) {
          return;
        }
        // Look for the chunk where startLine matches the saved element id.
        // Note: saved element id is a string; if needed, parse it as an integer.
        const savedStartLine = parseFloat(scrollData.elementId);
        const matchingChunk = nodesData.find((chunk) => {
          // Assuming each chunk object contains a startLine property.
          return parseFloat(chunk.startLine, 10) === savedStartLine;
        });

        if (matchingChunk) {
          // Load this chunk. If loadChunkInternal() is used, you might load with direction "down".
          await loadChunkInternal(
            matchingChunk.chunk_id,
            "down",
            instance,
            // *** FIX 3: ensure attachMarkers is passed correctly ***
            attachMarkers // Assuming attachMarkers is in scope for createLazyLoader
          );
          // Allow some time for the chunk to be rendered.
          setTimeout(() => {
            // *** FIX 4: Use instance.container ***
            let newTarget = instance.container.querySelector(`#${scrollData.elementId}`);
            if (newTarget) {
              // *** FIX 5: Use scrollElementIntoMainContent ***
              scrollElementIntoMainContent(newTarget, instance.container, 50); // Pass instance.container
            }
          }, 100);
        }
      } catch (error) {
        console.error("Error retrieving node chunks from IndexedDB:", error);
      }
    }
  };


  // Add this method to the instance object
  // In your lazyLoaderFactory.js file, replace the existing function with this one.
  instance.updateAndRenderFromPaste = async (
    newAndUpdatedNodes,
    beforeNodeId
  ) => {
    try {
      // 1. GET THE TRUTH: The data in IndexedDB is now correct.
      //    Fetch the complete, fresh list of all node chunks.
      instance.nodes = await instance.getNodeChunks();
      if (!instance.nodes || instance.nodes.length === 0) {
        console.error("❌ Aborting render: Failed to fetch any nodes from nodes object store in IndexedDB.");
        return;
      }

      // 2. CLEAN SLATE: Remove all previously rendered chunks of nodes from the DOM.
      instance.container
        .querySelectorAll("[data-chunk-id]")
        .forEach((el) => el.remove());

      // 3. RESET TRACKING: Clear the set of loaded chunks.
      instance.currentlyLoadedChunks.clear();

      // 4. FIND THE STARTING POINT: Determine which chunk of nodes to load first.
      //    We want to load the chunk of nodes containing the first piece of new content.
      const firstNewNode = newAndUpdatedNodes[0];
      const chunkToLoadId = firstNewNode.chunk_id;

      // 5. RENDER: Load the target chunk. The lazy loader will handle the rest.
      await loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);

      // 6. RESTORE FOCUS: Immediately after chunk loads, scroll to first pasted element
      // Use requestAnimationFrame to ensure DOM is painted, then scroll immediately
      requestAnimationFrame(() => {
        const firstNewElementId = firstNewNode.startLine;
        const targetElement = document.getElementById(firstNewElementId);

        if (targetElement) {
          // Scroll element to TOP of viewport for clear visibility after paste
          const scrollParent = instance.scrollableParent === window
            ? document.documentElement
            : instance.scrollableParent;

          const targetRect = targetElement.getBoundingClientRect();
          const containerRect = instance.container.getBoundingClientRect();
          const offset = 100; // Large top offset so element is clearly visible

          if (instance.scrollableParent === window) {
            window.scrollTo({
              top: window.scrollY + targetRect.top - offset,
              behavior: 'instant' // No animation - instant jump to pasted content
            });
          } else {
            scrollParent.scrollTop = targetRect.top - containerRect.top + scrollParent.scrollTop - offset;
          }

          // Set focus for contenteditable
          targetElement.focus();

          // Place cursor at the end of the newly pasted content
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetElement);
          range.collapse(false); // false = collapse to the end
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });
    } catch (error) {
      console.error("❌ Error in updateAndRenderFromPaste:", error);
      // Consider a full page refresh or error message as a fallback
      throw error;
    }
  };

  // Smart resize handler that ignores DevTools opening/closing
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // Only restore if viewport width changed significantly (not just DevTools)
      const currentWidth = window.innerWidth;
      if (!instance.lastViewportWidth) {
        instance.lastViewportWidth = currentWidth;
        return; // Skip first measurement
      }
      
      if (Math.abs(currentWidth - instance.lastViewportWidth) > 100) {
        instance.lastViewportWidth = currentWidth;

        // Check if user is currently scrolling before restoring
        if (!shouldSkipScrollRestoration("viewport resize")) {
          instance.restoreScrollPositionAfterResize();
        }
      }
    }, 300); // Longer delay to avoid DevTools flicker
  });
  // --- END SCROLL POSITION LOGIC ---

  // Create top and bottom sentinel elements.
  const topSentinel = document.createElement("div");
  topSentinel.id = `${uniqueId}-top-sentinel`;
  topSentinel.classList.add("sentinel");
  topSentinel.contentEditable = "false"; // Prevent cursor from entering sentinel
  topSentinel.style.userSelect = "none"; // Prevent text selection
  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.classList.add("sentinel");
  bottomSentinel.contentEditable = "false"; // Prevent cursor from entering sentinel
  bottomSentinel.style.userSelect = "none"; // Prevent text selection
  container.prepend(topSentinel);
  container.appendChild(bottomSentinel);
  verbose.init(`Sentinels inserted: ${topSentinel.id}, ${bottomSentinel.id}`, 'lazyLoaderFactory.js');

  // Attach marker listeners immediately.
  attachMarkers(container);

  // Set up IntersectionObserver options.
  const observerOptions = {
    root: instance.scrollableParent === window ? null : instance.scrollableParent, // null means viewport
    rootMargin: "150px",
    threshold: 0
  };

  // Helper: get last chunk element in the container.
  function getLastChunkElement() {
    const chunks = container.querySelectorAll("[data-chunk-id]");
    return chunks.length ? chunks[chunks.length - 1] : null;
  }

  // Create the IntersectionObserver.
  const observer = new IntersectionObserver((entries) => {
    verbose.content(`Observer triggered (${entries.length} entries)`, 'lazyLoaderFactory.js');

    // 🔒 CHECK SCROLL LOCK: Don't trigger lazy loading during navigation or chunk deletion
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      return;
    }

    // ✅ Don't load chunks if deletions are in progress
    if (isChunkLoadingInProgress()) {
      console.log('🔒 Skipping lazy load - chunk deletion in progress');
      return;
    }

    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      if (entry.target.id === topSentinel.id) {
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseFloat(firstChunkEl.getAttribute("data-chunk-id"));
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            loadPreviousChunkFixed(firstChunkId, instance);
          }
        }
      }
      if (entry.target.id === bottomSentinel.id) {
        console.log('🔍 Bottom sentinel intersecting - attempting to load next chunk');
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseFloat(lastChunkEl.getAttribute("data-chunk-id"), 10);
          console.log(`🔍 Last chunk in DOM: ${lastChunkId}, loading next chunk...`);
          loadNextChunkFixed(lastChunkId, instance);
        } else {
          console.warn('⚠️ Bottom sentinel intersecting but no chunks found in DOM');
        }
      }
    });
  }, observerOptions);

  observer.observe(topSentinel);
  observer.observe(bottomSentinel);
  verbose.init("Observer attached to sentinels", 'lazyLoaderFactory.js');

  attachMarkers(container);

  instance.observer = observer;
  instance.topSentinel = topSentinel;
  instance.bottomSentinel = bottomSentinel;

  instance.disconnect = () => {
    observer.disconnect();

    // 🔗 Remove the centralized link handler
    if (instance.globalLinkHandler) {
      document.removeEventListener('click', instance.globalLinkHandler);
    }
  };

  instance.repositionSentinels = () =>
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  instance.loadChunk = async (chunkId, direction = "down") =>
    await loadChunkInternal(chunkId, direction, instance, attachMarkers);

  // NEW: Scroll lock methods
  instance.lockScroll = (reason = 'navigation') => {
    instance.scrollLocked = true;
    instance.scrollLockReason = reason;
  };

  instance.unlockScroll = () => {
    // 🔒 Don't unlock during refresh - refresh will handle its own unlock
    if (instance.refreshInProgress) {
      return;
    }
    const wasLocked = instance.scrollLocked;
    instance.scrollLocked = false;
    instance.scrollLockReason = null;
    if (wasLocked) {
      // After a navigation lock is released, force a save of the final position.
      // Use a timeout to ensure the scroll has settled after any animations.
      setTimeout(() => {
        forceSavePosition();
      }, 250);
    }
  };


    // In lazyLoaderFactory.js, inside the createLazyLoader function...

  instance.refresh = async (targetElementId = null) => {
    // 🔒 Lock scroll during refresh to prevent premature scroll saves
    instance.refreshInProgress = true;
    instance.scrollLocked = true;
    instance.scrollLockReason = 'refresh';

    // 🛡️ Safety timeout - guarantee locks are cleared even if something goes wrong
    const safetyTimeout = setTimeout(() => {
      if (instance.refreshInProgress) {
        console.warn('⚠️ refresh() safety timeout triggered - clearing stuck locks');
        instance.refreshInProgress = false;
        instance.scrollLocked = false;
        instance.scrollLockReason = null;
      }
    }, 5000); // 5 second max

    try {
      // Preserve current scroll position if no target specified
      if (!targetElementId) {
        // Priority 1: Use pending navigation target if navigation is in progress
        if (instance.isNavigatingToInternalId && instance.pendingNavigationTarget) {
          targetElementId = instance.pendingNavigationTarget;
        } else {
          // Priority 2: Fall back to saved scroll position
          const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
          const storedData = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
          if (storedData) {
            try {
              const scrollData = JSON.parse(storedData);
              targetElementId = scrollData.elementId;
            } catch (e) { /* ignore parse errors */ }
          }
        }
      }

      // 1. Re-read the fresh nodes from IndexedDB (from your original)
      instance.nodes = await instance.getNodeChunks();

      // 2. Remove all rendered chunk-DIVs (from your original)
      instance.container
        .querySelectorAll("[data-chunk-id]")
        .forEach(el => el.remove());

      // 3. Reset our "which chunks are in the DOM" set (from your original)
      instance.currentlyLoadedChunks.clear();

      // 4. Ensure sentinels are in place (from your original)
      if (!instance.container.contains(instance.topSentinel)) {
        instance.container.prepend(instance.topSentinel);
      }
      if (!instance.container.contains(instance.bottomSentinel)) {
        instance.container.appendChild(instance.bottomSentinel);
      }

      // 5. ✅ KEPT: Re-observe the sentinels for robustness (from your original)
      instance.observer.observe(instance.topSentinel);
      instance.observer.observe(instance.bottomSentinel);

      // 6. ✅ NEW: Determine which chunk to load first
      const allChunkIds = [...new Set(instance.nodes.map(n => n.chunk_id))].sort((a, b) => a - b);
      let chunkToLoadId = allChunkIds.length > 0 ? allChunkIds[0] : null;

      if (targetElementId) {
        const targetChunk = instance.nodes.find(c => c.startLine == targetElementId);
        if (targetChunk) {
          chunkToLoadId = targetChunk.chunk_id;
        }
      }

      // 7. Load the determined chunk
      if (chunkToLoadId !== null) {
        await loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);
      }

      // 8. ✅ NEW: Scroll to and focus the target element after rendering
      setTimeout(() => {
        let elementToFocus = targetElementId ? document.getElementById(targetElementId) : null;

        // Fallback if the target element isn't found
        if (!elementToFocus) {
          elementToFocus = instance.container.querySelector('p, h1, h2, h3, blockquote, pre');
        }

        if (elementToFocus) {
          // Scroll the element into view first
          scrollElementIntoMainContent(elementToFocus, instance.container, 50);

          // Then set focus for contenteditable
          elementToFocus.focus();

          // Place the cursor at the end of the element
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(elementToFocus);
          range.collapse(false); // false means collapse to the end
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // 🔓 Unlock scroll after refresh scroll completes, then force save correct position
        setTimeout(() => {
          clearTimeout(safetyTimeout); // Cancel safety timeout - normal completion
          instance.refreshInProgress = false;
          instance.scrollLocked = false;
          instance.scrollLockReason = null;
          forceSavePosition(true); // bypassLock=true since we just unlocked
        }, 100);
      }, 150); // Slightly longer delay to ensure scrolling completes

    } catch (error) {
      // 🛡️ Ensure locks are cleared on error
      clearTimeout(safetyTimeout);
      instance.refreshInProgress = false;
      instance.scrollLocked = false;
      instance.scrollLockReason = null;
      console.error('❌ refresh() failed:', error);
      throw error; // Re-throw so caller knows it failed
    }
  };

  
  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
// Keep createChunkElement function signature unchanged
export function createChunkElement(nodes, instance) {
  // <-- Correct, simple signature
  verbose.content(`createChunkElement: ${nodes.length} nodes, chunk ${nodes.length > 0 ? nodes[0].chunk_id : 'unknown'}`, 'lazyLoaderFactory.js');

  if (!nodes || nodes.length === 0) {
    return null;
  }

  const chunkId = nodes[0].chunk_id;
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");

  nodes.forEach((node, nodeIndex) => {
    // ✅ Server handles migration - node_id should already exist
    // If not, log warning but continue (should not happen after migration)
    if (!node.node_id) {
      console.error(`⚠️ Node ${node.startLine} missing node_id after server migration!`);
    }

    // Note: Footnote migration is now handled server-side in DatabaseToIndexedDBController.php
    // nodes.footnotes is populated before data reaches the client

    let html = renderBlockToHtml(node);

    if (node.hyperlights && node.hyperlights.length > 0) {
      html = applyHighlights(html, node.hyperlights, instance.bookId);
    }

    if (node.hypercites && node.hypercites.length > 0) {
      html = applyHypercites(html, node.hypercites);
    }

    const temp = document.createElement("div");
    // SECURITY: Sanitize HTML to prevent stored XSS from malicious EPUB uploads
    temp.innerHTML = sanitizeHtml(html);

    // 🧹 CLEANUP: Strip navigation classes that shouldn't persist from database
    // Target: <a>, <u>, and arrow icons (<sup>, <span> with .open-icon)
    const navigationClasses = ['arrow-target', 'hypercite-target', 'hypercite-dimmed'];
    const elementsWithNavClasses = temp.querySelectorAll('a, u, .open-icon, sup, span');
    elementsWithNavClasses.forEach(el => {
      navigationClasses.forEach(className => {
        el.classList.remove(className);
      });
    });

    // 📝 DYNAMIC FOOTNOTE NUMBERING: Apply display numbers from FootnoteNumberingService
    // This replaces the old static fn-count-id with dynamically calculated numbers
    applyDynamicFootnoteNumbers(temp);

    // Find the first Element child (skip text nodes)
    let firstElement = temp.firstChild;
    while (firstElement && firstElement.nodeType !== Node.ELEMENT_NODE) {
      firstElement = firstElement.nextSibling;
    }

    if (firstElement) {
      // ✅ data-node-id should already be in HTML from server
      // But ensure numerical id is set
      firstElement.setAttribute('id', node.startLine);
      chunkWrapper.appendChild(firstElement);
    } else {
      console.error(`⚠️ Node ${nodeIndex + 1} (line ${node.startLine}) produced no Element content. HTML: ${html.substring(0, 100)}`);
    }
  });

  verbose.content(`createChunkElement completed for chunk #${chunkId}`, 'lazyLoaderFactory.js');
  return chunkWrapper;
}


  
export function applyHypercites(html, hypercites) {
  if (!hypercites || hypercites.length === 0) return html;

  const segments = createHyperciteSegments(hypercites);
  
  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;
  
  segments.sort((a, b) => b.charStart - a.charStart);

  for (const segment of segments) {
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);

    if (positions) {
      const underlineElement = document.createElement("u");

      // Handle single vs multiple hypercites in segment
      if (segment.hyperciteIDs.length === 1) {
        underlineElement.id = segment.hyperciteIDs[0];
        const actualStatus = segment.statuses[0];
        underlineElement.className = actualStatus || 'single';

        // Set hypercite intensity for single hypercite (start dim)
        if (actualStatus === 'couple' || actualStatus === 'poly') {
          underlineElement.style.cssText = '--hypercite-intensity: 0.4';
        }
      } else {
        // Multiple hypercites overlapping
        underlineElement.id = "hypercite_overlapping";

        let finalStatus = 'single';
        const coupleCount = segment.statuses.filter(status => status === 'couple').length;

        if (segment.statuses.includes('poly')) {
          finalStatus = 'poly';
        } else if (coupleCount >= 2) {
          finalStatus = 'poly';
        } else if (segment.statuses.includes('couple')) {
          finalStatus = 'couple';
        }

        underlineElement.className = finalStatus;
        underlineElement.setAttribute("data-overlapping", segment.hyperciteIDs.join(","));

        // Set hypercite intensity for overlapping hypercites (more overlaps = brighter)
        if (finalStatus === 'couple' || finalStatus === 'poly') {
          const overlappingCount = segment.hyperciteIDs.length;
          const intensity = Math.min(1.0, 0.4 + (overlappingCount - 1) * 0.2);
          underlineElement.style.cssText = `--hypercite-intensity: ${intensity}`;
        }
      }
      
      try {
        wrapRangeWithElement(
          positions.startNode,
          positions.startOffset,
          positions.endNode,
          positions.endOffset,
          underlineElement
        );
      } catch (error) {
        console.error("❌ Highlight wrapping failed completely", error);
      }
    }
  }

  return tempElement.innerHTML;
}

function createHyperciteSegments(hypercites) {
  // Collect all boundary points
  const boundaries = new Set();
  
  hypercites.forEach(hypercite => {
    boundaries.add(hypercite.charStart);
    boundaries.add(hypercite.charEnd);
  });
  
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
  const segments = [];
  
  // Create segments between each pair of boundaries
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const segmentStart = sortedBoundaries[i];
    const segmentEnd = sortedBoundaries[i + 1];
    
    // Find which hypercites cover this segment
    const coveringHypercites = hypercites.filter(hypercite => 
      hypercite.charStart <= segmentStart && hypercite.charEnd >= segmentEnd
    );
    
    if (coveringHypercites.length > 0) {
      segments.push({
        charStart: segmentStart,
        charEnd: segmentEnd,
        hyperciteIDs: coveringHypercites.map(h => h.hyperciteId),
        statuses: coveringHypercites.map(h => h.relationshipStatus || 'single')
      });
    }
  }
  
  return segments;
}



// Update the applyHighlights function to use server-provided is_user_highlight flag
export function applyHighlights(html, highlights, bookId) {
  if (!highlights || highlights.length === 0) {
    return html;
  }

  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;

  const segments = createHighlightSegments(highlights);

  // Keep reverse order but recalculate positions each time
  segments.sort((a, b) => b.charStart - a.charStart);

  for (const segment of segments) {
    // Recalculate positions based on current DOM state
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);

    if (positions) {
      const markElement = document.createElement("mark");

      // Always set data-highlight-count and intensity
      markElement.setAttribute("data-highlight-count", segment.highlightIDs.length);
      const intensity = Math.min(segment.highlightIDs.length / 5, 1); // Cap at 5 highlights
      // Use cssText so it serializes properly when we get innerHTML
      markElement.style.cssText = `--highlight-intensity: ${intensity}`;

      // Check if any highlight in this segment belongs to current user using server flag OR is newly created
      const hasUserHighlight = segment.highlightIDs.some(id => {
        const highlight = highlights.find(h => (h.hyperlight_id || h.highlightID) === id);
        const isNewlyCreated = isNewlyCreatedHighlight(id);
        return highlight ? highlight.is_user_highlight : isNewlyCreated;
      });

      if (segment.highlightIDs.length === 1) {
        markElement.id = segment.highlightIDs[0];
        markElement.className = segment.highlightIDs[0];
      } else {
        markElement.id = "HL_overlap";
        markElement.className = segment.highlightIDs.join(" ");
      }

      // Add user-specific class for styling
      if (hasUserHighlight) {
        markElement.classList.add('user-highlight');
      }

      // Use surroundContents instead of extractContents
      wrapRangeWithElement(
        positions.startNode,
        positions.startOffset,
        positions.endNode,
        positions.endOffset,
        markElement
      );
    }
  }

  return tempElement.innerHTML;
}


function createHighlightSegments(highlights) {
  // Collect all boundary points
  const boundaries = new Set();

  highlights.forEach(highlight => {
    boundaries.add(highlight.charStart);
    boundaries.add(highlight.charEnd);
  });

  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
  const segments = [];

  // Create segments between each pair of boundaries
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const segmentStart = sortedBoundaries[i];
    const segmentEnd = sortedBoundaries[i + 1];

    // Find which highlights cover this segment
    const coveringHighlights = highlights.filter(highlight => {
      return highlight.charStart <= segmentStart && highlight.charEnd >= segmentEnd;
    });
    
    if (coveringHighlights.length > 0) {
      segments.push({
        charStart: segmentStart,
        charEnd: segmentEnd,
        highlightIDs: coveringHighlights.map(h => h.hyperlight_id || h.highlightID)
      });
    }
  }
  
  return segments;
}



function findPositionsInDOM(rootElement, startChar, endChar) {
  const textNodes = getTextNodes(rootElement);
  let currentIndex = 0;
  let startNode = null,
    startOffset = 0;
  let endNode = null,
    endOffset = 0;

  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= startChar && currentIndex + nodeLength > startChar) {
      startNode = node;
      startOffset = startChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  currentIndex = 0;
  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= endChar && currentIndex + nodeLength >= endChar) {
      endNode = node;
      endOffset = endChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  if (startNode && endNode) {
    return { startNode, startOffset, endNode, endOffset };
  }

  return null;
}

function wrapRangeWithElement(startNode, startOffset, endNode, endOffset, wrapElement) {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    // 🛡️ GUARD: Check if the range ends at offset 0 inside a <sup> or <a> element
    // This would cause extractContents() to split the element and duplicate content
    // Instead, extend the range to include the entire sup/a element
    if (endOffset === 0 && endNode.parentElement) {
      const parent = endNode.parentElement;
      if (parent.tagName === 'SUP' || parent.tagName === 'A') {
        // Extend range to AFTER the entire sup/a element
        range.setEndAfter(parent.tagName === 'A' ? parent.closest('sup') || parent : parent);
      }
    }

    // Similarly, if range starts at end of text inside sup/a, adjust to start after it
    if (startOffset === startNode.textContent.length && startNode.parentElement) {
      const parent = startNode.parentElement;
      if (parent.tagName === 'SUP' || parent.tagName === 'A') {
        range.setStartAfter(parent.tagName === 'A' ? parent.closest('sup') || parent : parent);
      }
    }

    // ✅ Do the tolerant extract/insert directly
    const contents = range.extractContents();
    wrapElement.appendChild(contents);
    range.insertNode(wrapElement);
  } catch (error) {
    console.error("❌ Fallback wrapping failed completely:", error);
  }
}

function getTextNodes(element) {
  let textNodes = [];
  for (let node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      textNodes.push(...getTextNodes(node));
    }
  }
  return textNodes;
}


// Update loadNextChunkFixed
export async function loadNextChunkFixed(currentLastChunkId, instance) {
  // ✅ Refresh cache before searching if dirty
  if (isCacheDirty()) {
    console.log('🔄 Cache dirty, refreshing from IndexedDB before searching for next chunk...');
    instance.nodes = await getNodeChunksFromIndexedDB(instance.bookId);
    clearCacheDirtyFlag();
  }

  const currentId = parseFloat(currentLastChunkId);
  console.log(`🔍 loadNextChunkFixed called with currentLastChunkId: ${currentId}`);

  let nextChunkId = null;
  let nextNodes = [];

  for (const node of instance.nodes) {
    const nodeChunkId = parseFloat(node.chunk_id);

    if (nodeChunkId > currentId && (nextChunkId === null || nodeChunkId < nextChunkId)) {
      nextChunkId = nodeChunkId;
    }
  }

  console.log(`🔍 Found next chunk ID: ${nextChunkId} (searched ${instance.nodes.length} nodes)`);

  if (nextChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
      return;
    }

    nextNodes = instance.nodes.filter(node => parseFloat(node.chunk_id) === nextChunkId);

    if (nextNodes.length === 0) {
      return;
    }
    
    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(nextChunkId);
    scheduleAutoClear(nextChunkId, 1000); // Auto-clear after 1 second
    
    const container = instance.container;
      const chunkElement = createChunkElement(nextNodes, instance);
      container.appendChild(chunkElement);
      instance.currentlyLoadedChunks.add(nextChunkId);

      // 🆕 Ensure no-delete-id marker exists for this book (async, fire-and-forget)
      ensureNoDeleteMarkerForBook(chunkElement, instance.nodes).catch(err =>
        console.error('Failed to ensure no-delete-id marker:', err)
      );

      // ✅ Attach listeners only to this chunk
      attachMarkListeners(chunkElement);
      attachUnderlineClickListeners(chunkElement);
      
      if (instance.bottomSentinel) {
        instance.bottomSentinel.remove();
        container.appendChild(instance.bottomSentinel);
      }
    
    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    // Use a small delay to ensure all mutations are processed
    setTimeout(() => {
      clearChunkLoadingInProgress(nextChunkId);
    }, 100);
  }
}

// Update loadPreviousChunkFixed similarly
export async function loadPreviousChunkFixed(currentFirstChunkId, instance) {
  // ✅ Refresh cache before searching if dirty
  if (isCacheDirty()) {
    console.log('🔄 Cache dirty, refreshing from IndexedDB before searching for previous chunk...');
    instance.nodes = await getNodeChunksFromIndexedDB(instance.bookId);
    clearCacheDirtyFlag();
  }

  const currentId = parseFloat(currentFirstChunkId);

  let prevChunkId = null;
  let prevNodes = [];

  for (const node of instance.nodes) {
    const nodeChunkId = parseFloat(node.chunk_id);

    if (nodeChunkId < currentId && (prevChunkId === null || nodeChunkId > prevChunkId)) {
      prevChunkId = nodeChunkId;
    }
  }

  if (prevChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${prevChunkId}"]`)) {
      return;
    }

    prevNodes = instance.nodes.filter(node => parseFloat(node.chunk_id) === prevChunkId);

    if (prevNodes.length === 0) {
      return;
    }
    
    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(prevChunkId);
    scheduleAutoClear(prevChunkId, 1000);
    
    const container = instance.container;
    const prevScrollTop = instance.scrollableParent.scrollTop;
    const chunkElement = createChunkElement(prevNodes, instance, instance.config?.onFirstChunkLoaded);
    container.insertBefore(chunkElement, container.firstElementChild);
    instance.currentlyLoadedChunks.add(prevChunkId);

    // 🆕 Ensure no-delete-id marker exists for this book (async, fire-and-forget)
    ensureNoDeleteMarkerForBook(chunkElement, instance.nodes).catch(err =>
      console.error('Failed to ensure no-delete-id marker:', err)
    );

    const newHeight = chunkElement.getBoundingClientRect().height;
    

    // 🚨 SCROLL LOCK PROTECTION: Don't adjust scroll if locked or navigation is in progress
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      // Skip scroll adjustment during navigation
    } else {
      instance.scrollableParent.scrollTop = prevScrollTop + newHeight; // <<< Use scrollableParent
    }
    
    if (instance.topSentinel) {
      instance.topSentinel.remove();
      container.prepend(instance.topSentinel);
    }
    
    attachMarkListeners(chunkElement);
    attachUnderlineClickListeners(chunkElement);
    
    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    setTimeout(() => {
      clearChunkLoadingInProgress(prevChunkId);
    }, 100);
  }
}

async function loadChunkInternal(chunkId, direction, instance, attachMarkers) {
  // ✅ Check if cache is dirty and refresh if needed
  if (isCacheDirty()) {
    console.log('🔄 Cache dirty, refreshing from IndexedDB before loading chunk...');
    instance.nodes = await getNodeChunksFromIndexedDB(instance.bookId);
    clearCacheDirtyFlag();
  }

  if (instance.currentlyLoadedChunks.has(chunkId)) {
    return;
  }

  const nextNodes = instance.nodes.filter(
    (node) => node.chunk_id === chunkId
  );

  if (!nextNodes || nextNodes.length === 0) {
    return;
  }

  setChunkLoadingInProgress(chunkId);
  scheduleAutoClear(chunkId, 1000);

  // createChunkElement is called with its simple, correct signature.
   const chunkElement = createChunkElement(nextNodes, instance);

  if (direction === "up") {
    instance.container.insertBefore(chunkElement, instance.container.firstChild);
  } else {
    instance.container.appendChild(chunkElement);
  }

  instance.currentlyLoadedChunks.add(chunkId);

  // 🆕 Ensure no-delete-id marker exists for this book (async, fire-and-forget)
  ensureNoDeleteMarkerForBook(chunkElement, instance.nodes).catch(err =>
    console.error('Failed to ensure no-delete-id marker:', err)
  );

  // ✅ Attach listeners only to this chunk
  attachMarkListeners(chunkElement);
  attachUnderlineClickListeners(chunkElement);

  if (chunkId === 0) {
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  }

  // ✅ THIS IS THE CORRECT LOGIC AND LOCATION
  // After the element is on the page, check for the stored callback.
  if (typeof instance.onFirstChunkLoadedCallback === "function") {
    instance.onFirstChunkLoadedCallback(); // Call the stored callback
    instance.onFirstChunkLoadedCallback = null; // Set it to null so it only fires once.
  }


  setTimeout(() => {
    clearChunkLoadingInProgress(chunkId);
  }, 100);

  if (chunkId === 0) {
    const nodeCount = instance.nodes.find(c => c.chunk_id === 0)?.nodes?.length || 50;
    log.content(`First chunk rendered (${nodeCount} nodes)`, 'lazyLoaderFactory.js');
  }
  verbose.content(`Chunk #${chunkId} loaded into DOM`, 'lazyLoaderFactory.js');
  return chunkElement; // ✅ return DOM element
}


/**
 * Repositions the sentinels around loaded chunks.
 */
function repositionFixedSentinelsForBlockInternal(instance, attachMarkers) {
  verbose.content("Repositioning sentinels", 'lazyLoaderFactory.js');
  const container = instance.container;
  const allChunks = Array.from(container.querySelectorAll("[data-chunk-id]"));
  if (allChunks.length === 0) {
    return;
  }
  allChunks.sort(
  (a, b) =>
    parseFloat(a.getAttribute("data-chunk-id")) -
    parseFloat(b.getAttribute("data-chunk-id"))
);
  if (instance.observer) instance.observer.disconnect();
  if (instance.topSentinel) instance.topSentinel.remove();
  if (instance.bottomSentinel) instance.bottomSentinel.remove();
  const uniqueId = container.id || Math.random().toString(36).substr(2, 5);
  const topSentinel = document.createElement("div");
  topSentinel.id = `${uniqueId}-top-sentinel`;
  topSentinel.className = "sentinel";
  topSentinel.contentEditable = "false"; // Prevent cursor from entering sentinel
  topSentinel.style.userSelect = "none"; // Prevent text selection
  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.className = "sentinel";
  bottomSentinel.contentEditable = "false"; // Prevent cursor from entering sentinel
  bottomSentinel.style.userSelect = "none"; // Prevent text selection
  container.insertBefore(topSentinel, allChunks[0]);
  allChunks[allChunks.length - 1].after(bottomSentinel);
  instance.topSentinel = topSentinel;
  instance.bottomSentinel = bottomSentinel;
  if (instance.observer) {
    instance.observer.observe(topSentinel);
    instance.observer.observe(bottomSentinel);
    verbose.content("Sentinels repositioned and observer reattached", 'lazyLoaderFactory.js');
  }
  instance.currentlyLoadedChunks = new Set(
    allChunks.map((chunk) => parseFloat(chunk.getAttribute("data-chunk-id"), 10))
  );
}

/**
 * Inserts a chunk into the container in order.
 */
function insertChunkInOrderInternal(newChunk, instance) {
  const container = instance.container;
  const existingChunks = Array.from(container.querySelectorAll("[data-chunk-id]"));
  let inserted = false;
  const newChunkId = parseFloat(newChunk.getAttribute("data-chunk-id"));

  for (let i = 0; i < existingChunks.length; i++) {
    const existingId = parseFloat(existingChunks[i].getAttribute("data-chunk-id"));
    if (newChunkId < existingId) {
      container.insertBefore(newChunk, existingChunks[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) container.appendChild(newChunk);
}

/**
 * Utility to retrieve the last loaded chunk's id.
 */
export function getLastChunkId(instance) {
  const chunks = instance.container.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return parseFloat(chunks[chunks.length - 1].getAttribute("data-chunk-id"));
}

export { repositionFixedSentinelsForBlockInternal as repositionSentinels };
