import { log, verbose } from '../utilities/logger';
// NOTE: attachMarkListeners / attachUnderlineClickListeners are deliberately NOT imported here.
// The render engine is a LEAF: both attachers are INJECTED via createLazyLoader's config and held
// on `instance` (instance.attachMarkListeners / instance.attachUnderlineClickListeners). Importing
// them upward from hyperlights/hypercites would re-close the render↔feature static-import cycle
// that crashed prod with a TDZ.
import { NavigationCompletionBarrier, NavigationProcess } from '../SPA/navigation/NavigationCompletionBarrier.js';
import {
  //saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  getLocalStorageKey,
  getHyperciteFromIndexedDB
} from "../indexedDB/index.js";
import type { NodeRecord, ChunkId } from '../indexedDB/types';
import { asChunkId, parseChunkId } from '../indexedDB/types';
import {
  setChunkLoadingInProgress,
  clearChunkLoadingInProgress,
  isChunkLoadingInProgress,
  scheduleAutoClear
} from "./utilities/chunkLoadingState";
import { setupUserScrollDetection, shouldSkipScrollRestoration, isActivelyScrollingForLinkBlock, setNavigatingState, getCascadeOriginId } from '../scrolling/index';
import { scrollElementIntoMainContent } from "../scrolling/index";
import { handleContentLinkClick } from '../utilities/linkClickRegistry';
import { isCacheDirty, clearCacheDirtyFlag } from './utilities/cacheState';
import { selectNextChunkId, selectPrevChunkId } from './utilities/chunkSelection';
import { restoreScrollAnchor } from '../utilities/scrollAnchor';
import {
  createChunkElement,
  ensureNoDeleteMarkerForBook,
  throttle,
} from './chunkRender';

// Re-export the public rendering surface so external importers resolve to the folder
export {
  renderMathElements,
  normalizeHyperciteElements,
  createChunkElement,
  applyHypercites,
  applyHighlights,
} from './chunkRender';

/**
 * Factory function for lazy loading.
 *
 * IMPORTANT: The config object must include a property "bookId" which also
 * corresponds to the id of the container DIV in the DOM. For example, if bookId
 * is "book1", then the container is expected to be:
 *    <div id="book1" class="main-content"></div>
 */
export function createLazyLoader(config: any) {
  const {
    nodes,
    chunkManifest = null,
    loadNextChunk,
    loadPreviousChunk,
    attachMarkListeners: attachMarkers,
    attachUnderlineClickListeners: attachUnderliners,
    isRestoringFromCache = false,
    isNavigatingToInternalId = false,
    isUpdatingJsonContent = false,
    bookId = "latest",
    onFirstChunkLoaded,
    containerElement,                           // NEW: skip getElementById (for sub-books)
    scrollableParent: scrollableParentOverride, // NEW: bypass auto-detection (for sub-books)
  } = config;

  if (!nodes || nodes.length === 0) {
    log.error('No nodes available for lazy loader', 'lazyLoaderFactory.js');
    return null;
  }

  // --- MOVE THIS BLOCK UP! ---
  const container = containerElement || document.getElementById(bookId); // <<< DEFINE CONTAINER FIRST
  if (!container) {
    log.error(`Container element with id "${bookId}" not found in the DOM`, 'lazyLoaderFactory.js');
    return null;
  }
  // --- END MOVED BLOCK ---

  // Now, container is defined, so you can safely use it:
  let scrollableParent: any;
  if (scrollableParentOverride) {
    scrollableParent = scrollableParentOverride;
  } else {
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
  }

  // Create the instance to track lazy-loader state.
  // Type just the `nodes` bag as NodeRecord[] (the data lineage) while leaving the
  // rest of the orchestrator instance loose — so the type flows getNodeChunks() →
  // instance.nodes → filter → createChunkElement without a full instance interface.
  const instance: { nodes: NodeRecord[]; [key: string]: any } = {
    nodes, // Array of chunk objects
    // Injected render hooks (DI — keeps lazyLoader a leaf; see import note at top of file)
    attachMarkListeners: attachMarkers,
    attachUnderlineClickListeners: attachUnderliners,
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
    chunkManifest: chunkManifest || null, // Chunked lazy loading: manifest of all chunks
    isFullyLoaded: !chunkManifest,        // false when only initial chunk is loaded
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
  const globalLinkHandler = async (event: any) => {
    if (event.defaultPrevented) return; // Already handled by another lazy loader's handler
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
    // 1. Inside the .hypercites-section ("Cited By" — should navigate directly)
    // 2. Have the "see-in-source-btn" class (action button from container)
    try {
      const url = new URL(link.href, window.location.origin);
      const hash = url.hash;

      if (hash && hash.startsWith('#hypercite_') && !link.classList.contains('see-in-source-btn') && !link.closest('.hypercites-section')) {
        // Prevent default navigation immediately
        event.preventDefault();
        event.stopPropagation();

        // Extract target book ID from URL
        const targetBookId = url.pathname.replace('/', '');

        // Check if target book is private and if user has access
        try {
          const { openDatabase }: any = await import('../indexedDB/index');
          const db = await openDatabase();
          const tx = db.transaction('library', 'readonly');
          const libraryStore = tx.objectStore('library');
          const libraryData = await new Promise<any>((resolve) => {
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
            const { canUserEditBook }: any = await import('../utilities/auth/index');
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

        // Check if hypercite link is inside a highlight mark
        let parentMark = link.closest('mark') || event.target.closest('mark');
        if (!parentMark && link.previousElementSibling?.tagName === 'MARK') {
          parentMark = link.previousElementSibling;
        }
        let highlightIds: any = null;
        if (parentMark) {
          const hlClasses = Array.from(parentMark.classList).filter((cls: any) => cls.startsWith('HL_'));
          if (hlClasses.length > 0) highlightIds = hlClasses;
        }

        // Import and call unified container handler
        const { handleUnifiedContentClick }: any = await import('../hyperlitContainer/index');
        await handleUnifiedContentClick(link, highlightIds);
        return;
      }
    } catch (error) {
      console.error('🔗 LazyLoader: Error checking for hypercite citation:', error);
      // Continue to normal link handling
    }

    try {
      // Delegate to the registered LinkNavigationHandler via the DI leaf
      const handled: any = await handleContentLinkClick(event);

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
  container.querySelectorAll(".sentinel").forEach((sentinel: any) => sentinel.remove());
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
      // Cache anchor for resize handler
      instance._scrollAnchor = {
        element: topVisible,
        offsetFromContainer: topVisible.getBoundingClientRect().top - scrollSourceRect.top,
      };

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

          // Save to server (debounced) for cross-device resume
          const chunkEl = topVisible.closest('[data-chunk-id]');
          // parseFloat, NOT parseInt: chunk_id can be a decimal, and this value
          // decides which chunk to load on resume — truncating lands on the wrong chunk.
          const chunkId = chunkEl ? parseChunkId(chunkEl.getAttribute('data-chunk-id')!) : asChunkId(0);
          import('../scrolling/readingPosition').then(({ debouncedServerSave }) => {
            debouncedServerSave(instance.bookId, detectedId, chunkId);
          }).catch(() => {}); // Best-effort
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

  instance.forceSaveScrollPosition = () => forceSavePosition(true);

  document.dispatchEvent(new Event("pageReady"));

  // 🚀 PERFORMANCE: Attach the throttled, guarded listener for regular user scrolling.
  // Using passive: true for better scroll performance (we never preventDefault)
  if (instance.scrollableParent === window) {
    window.addEventListener("scroll", throttle(instance.saveScrollPosition, 250), { passive: true });
  } else {
    instance.scrollableParent.addEventListener("scroll", throttle(instance.saveScrollPosition, 250), { passive: true });
  }

  // Save reading position to server on page unload (cross-device resume)
  window.addEventListener('beforeunload', () => {
    const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
    const storedData = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (storedData) {
      try {
        const scrollData = JSON.parse(storedData);
        if (scrollData?.elementId) {
          // Find chunk_id from DOM
          const el = document.getElementById(scrollData.elementId);
          const chunkEl = el?.closest('[data-chunk-id]');
          // parseFloat, NOT parseInt: chunk_id can be a decimal, and this value
          // decides which chunk to load on resume — truncating lands on the wrong chunk.
          const chunkId = chunkEl ? parseChunkId(chunkEl.getAttribute('data-chunk-id')!) : asChunkId(0);
          import('../scrolling/readingPosition').then(({ sendBeaconSave }) => {
            sendBeaconSave(instance.bookId, scrollData.elementId, chunkId);
          }).catch(() => {});
        }
      } catch (e) { /* best-effort */ }
    }
  });

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
      (scrollElementIntoMainContent as any)(targetElement, instance.container, 50); // Pass instance.container
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
        const matchingChunk = nodesData.find((chunk: any) => {
          // Assuming each chunk object contains a startLine property.
          return (parseFloat as any)(chunk.startLine, 10) === savedStartLine;
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
              (scrollElementIntoMainContent as any)(newTarget, instance.container, 50); // Pass instance.container
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
    newAndUpdatedNodes: any,
    beforeNodeId: any
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
        .forEach((el: any) => el.remove());

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
              behavior: 'instant' as any // No animation - instant jump to pasted content
            });
          } else {
            scrollParent.scrollTop = targetRect.top - containerRect.top + scrollParent.scrollTop - offset;
          }

          // Set focus for contenteditable
          targetElement.focus();

          // Place cursor at the end of the newly pasted content
          const selection = window.getSelection()!;
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

  // Resize handler — uses cached scroll anchor for instant correction
  let resizeTimeout: any;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (instance._scrollAnchor?.element?.isConnected) {
        restoreScrollAnchor(instance.scrollableParent, instance._scrollAnchor);
      }
    }, 50); // Short debounce — fast enough to feel instant
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
    verbose.content(`Observer triggered (${entries.length} entries) for book: ${instance.bookId}`, 'lazyLoaderFactory.js');

    // 🔒 CHECK SCROLL LOCK: Don't trigger lazy loading during navigation or chunk deletion
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      verbose.debug(`Observer blocked: scrollLocked=${instance.scrollLocked}, isNavigating=${instance.isNavigatingToInternalId}`, 'lazyLoaderFactory.js');
      return;
    }

    // ✅ Don't load chunks if deletions are in progress
    if (isChunkLoadingInProgress()) {
      verbose.debug('Skipping lazy load - chunk deletion in progress', 'lazyLoaderFactory.js');
      return;
    }

    entries.forEach((entry) => {
      verbose.debug(`Entry: ${entry.target.id}, isIntersecting: ${entry.isIntersecting}, ratio: ${entry.intersectionRatio}`, 'lazyLoaderFactory.js');

      if (!entry.isIntersecting) {
        return;
      }

      if (entry.target.id === instance.topSentinel?.id) {
        verbose.debug('TOP sentinel intersecting - attempting to load previous chunk', 'lazyLoaderFactory.js');
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseChunkId(firstChunkEl.getAttribute("data-chunk-id")!);
          verbose.debug(`First chunk in DOM: ${firstChunkId}, checking if can load previous...`, 'lazyLoaderFactory.js');
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            verbose.debug(`Loading previous chunk: ${firstChunkId - 1}`, 'lazyLoaderFactory.js');
            loadPreviousChunkFixed(firstChunkId, instance);
          } else {
            verbose.debug(`Cannot load previous: firstChunkId=${firstChunkId}, alreadyLoaded=${instance.currentlyLoadedChunks.has(firstChunkId - 1)}`, 'lazyLoaderFactory.js');
          }
        } else {
          verbose.debug('Top sentinel intersecting but no chunks found in DOM', 'lazyLoaderFactory.js');
        }
      }
      if (entry.target.id === instance.bottomSentinel?.id) {
        verbose.debug('Bottom sentinel intersecting - attempting to load next chunk', 'lazyLoaderFactory.js');
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseChunkId(lastChunkEl.getAttribute("data-chunk-id")!);
          verbose.debug(`Last chunk in DOM: ${lastChunkId}, loading next chunk...`, 'lazyLoaderFactory.js');
          loadNextChunkFixed(lastChunkId, instance);
        } else {
          verbose.debug('Bottom sentinel intersecting but no chunks found in DOM', 'lazyLoaderFactory.js');
        }
      }
    });
  }, observerOptions);

  observer.observe(topSentinel);
  observer.observe(bottomSentinel);
  verbose.init(`Observer attached to sentinels for book: ${instance.bookId}`, 'lazyLoaderFactory.js');
  verbose.debug(`Root: ${observerOptions.root?.id || observerOptions.root?.className || 'viewport'}, Top: ${topSentinel.id}, Bottom: ${bottomSentinel.id}`, 'lazyLoaderFactory.js');

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
  instance.loadChunk = async (chunkId: any, direction = "down") =>
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

  instance.refresh = async (targetElementId: any = null) => {
    // 🔒 Lock scroll during refresh to prevent premature scroll saves
    instance.refreshInProgress = true;
    instance.scrollLocked = true;
    instance.scrollLockReason = 'refresh';

    // 🔒 Mark as navigating to prevent scroll events from being detected as user scrolls
    setNavigatingState(true);

    // 🛡️ Safety timeout - guarantee locks are cleared even if something goes wrong
    const safetyTimeout = setTimeout(() => {
      if (instance.refreshInProgress) {
        console.warn('⚠️ refresh() safety timeout triggered - clearing stuck locks');
        instance.refreshInProgress = false;
        instance.scrollLocked = false;
        instance.scrollLockReason = null;
        setNavigatingState(false);
      }
    }, 5000); // 5 second max

    try {
      // Preserve current scroll position if no target specified
      if (!targetElementId) {
        // 🚦 Priority 0: Use NavigationCompletionBarrier target (most authoritative)
        // This ensures refresh triggered by timestamp check uses the correct navigation target
        if (NavigationCompletionBarrier.isNavigating()) {
          const barrierTarget = NavigationCompletionBarrier.getNavigationTarget();
          if (barrierTarget) {
            console.log(`🚦 refresh(): Using NavigationCompletionBarrier target: ${barrierTarget}`);
            targetElementId = barrierTarget;
          }
        }
        // Priority 1: Use pending navigation target if navigation is in progress
        else if (instance.isNavigatingToInternalId && instance.pendingNavigationTarget) {
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

        // Priority 3: Use URL hash as fallback (e.g., #hypercite_pa7ymke)
        // This handles cases where navigation just completed but scroll cache was cleared
        if (!targetElementId && window.location.hash) {
          const hashTarget = window.location.hash.substring(1);
          if (hashTarget) {
            console.log(`🔗 refresh(): Using URL hash as scroll target: ${hashTarget}`);
            targetElementId = hashTarget;
          }
        }
      }

      // 1. Re-read the fresh nodes from IndexedDB (from your original)
      instance.nodes = await instance.getNodeChunks();

      // Hydrate with highlights from standalone stores
      const { rebuildNodeArrays }: any = await import('../indexedDB/hydration/rebuild');
      await rebuildNodeArrays(instance.nodes);

      // Clear stale dirty flag — we just hydrated from source of truth
      clearCacheDirtyFlag();

      // 2. Remove all rendered chunk-DIVs (from your original)
      // ⚠️ DIAGNOSTIC: Log when chunks are removed during refresh
      const chunksToRemove = instance.container.querySelectorAll("[data-chunk-id]");
      if (chunksToRemove.length > 0) {
        console.warn(`⚠️ LAZY LOADER REFRESH: Removing ${chunksToRemove.length} chunks`, {
          stack: new Error().stack,
          timestamp: Date.now()
        });
      }
      chunksToRemove.forEach((el: any) => el.remove());

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

      // 6. ✅ Determine which chunks to load (target + adjacent)
      const allChunkIds = instance.chunkManifest
        ? instance.chunkManifest.map((m: any) => m.chunk_id)
        : [...new Set(instance.nodes.map((n: any) => n.chunk_id))].sort((a: any, b: any) => a - b);
      let targetChunkId = allChunkIds.length > 0 ? allChunkIds[0] : null;

      if (targetElementId) {
        // Try direct match first (for numeric node IDs)
        let targetChunk = instance.nodes.find((c: any) => c.startLine == targetElementId);

        // If not found and target is non-numeric, search in content/hypercites/hyperlights
        if (!targetChunk && !/^\d+$/.test(targetElementId)) {
          const normalizedTarget = targetElementId.toLowerCase();
          const regex = new RegExp(`id=['"]${targetElementId}['"]`, 'i');

          for (const node of instance.nodes) {
            // Check if the content has an element with the target id
            if (node.content && regex.test(node.content)) {
              targetChunk = node;
              console.log(`🔗 refresh(): Found target ${targetElementId} in node content at startLine ${node.startLine}`);
              break;
            }

            // Check in hypercites array
            if (Array.isArray(node.hypercites)) {
              const found = node.hypercites.some(
                (cite: any) => cite.hyperciteId && cite.hyperciteId.toLowerCase() === normalizedTarget
              );
              if (found) {
                targetChunk = node;
                console.log(`🔗 refresh(): Found hypercite ${targetElementId} in node at startLine ${node.startLine}`);
                break;
              }
            }

            // Check in hyperlights array
            if (Array.isArray(node.hyperlights)) {
              const found = node.hyperlights.some(
                (light: any) => light.highlightID && light.highlightID.toLowerCase() === normalizedTarget
              );
              if (found) {
                targetChunk = node;
                console.log(`🔗 refresh(): Found hyperlight ${targetElementId} in node at startLine ${node.startLine}`);
                break;
              }
            }
          }
        }

        if (targetChunk) {
          targetChunkId = targetChunk.chunk_id;
        }
      }

      // 7. Load the target chunk (lazy loader will handle adjacent chunks via sentinels)
      if (targetChunkId !== null) {
        verbose.debug(`refresh() loading target chunk: ${targetChunkId}`, 'lazyLoaderFactory.js');
        await loadChunkInternal(targetChunkId, "down", instance, attachMarkers);

        // Fix sentinel positions - chunk gets appended AFTER bottomSentinel, need to reorder
        instance.repositionSentinels();

        // DEBUG: Log DOM structure after chunk load (verbose mode only)
        const children = Array.from(instance.container.children).map((el: any) => {
          if (el.classList.contains('sentinel')) return `SENTINEL:${el.id}`;
          if (el.hasAttribute('data-chunk-id')) return `CHUNK:${el.getAttribute('data-chunk-id')}`;
          return `OTHER:${el.tagName}`;
        });
        verbose.debug(`DOM order after chunk load: ${children.join(', ')}`, 'lazyLoaderFactory.js');
        verbose.debug(`topSentinel in DOM: ${instance.container.contains(instance.topSentinel)}`, 'lazyLoaderFactory.js');
        verbose.debug(`bottomSentinel in DOM: ${instance.container.contains(instance.bottomSentinel)}`, 'lazyLoaderFactory.js');
        verbose.debug(`currentlyLoadedChunks: [${[...instance.currentlyLoadedChunks].join(', ')}]`, 'lazyLoaderFactory.js');
      }

      // 8. ✅ NEW: Scroll to and focus the target element after rendering
      setTimeout(() => {
        let elementToFocus = targetElementId ? document.getElementById(targetElementId) : null;

        // For hypercites, also check if it's part of an overlapping segment
        if (!elementToFocus && targetElementId && targetElementId.startsWith('hypercite_')) {
          const overlappingElements = instance.container.querySelectorAll('u[data-overlapping]');
          for (const element of overlappingElements) {
            const overlappingIds = element.getAttribute('data-overlapping');
            if (overlappingIds && overlappingIds.split(',').map((id: any) => id.trim()).includes(targetElementId)) {
              console.log(`🔗 refresh(): Found hypercite ${targetElementId} in overlapping element`);
              elementToFocus = element;
              break;
            }
          }
        }

        // Fallback if the target element isn't found
        if (!elementToFocus) {
          elementToFocus = instance.container.querySelector('p, h1, h2, h3, blockquote, pre');
        }

        if (elementToFocus) {
          // Scroll the element into view first
          (scrollElementIntoMainContent as any)(elementToFocus, instance.container, 50);

          // Then set focus for contenteditable
          elementToFocus.focus();

          // Place the cursor at the end of the element
          const selection = window.getSelection()!;
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
          // Explicitly clear chunk loading state to prevent timeout warnings
          if (targetChunkId !== null) {
            clearChunkLoadingInProgress(targetChunkId);
          }
          setNavigatingState(false);
          forceSavePosition(true); // bypassLock=true since we just unlocked
          verbose.debug('refresh() complete, scroll unlocked', 'lazyLoaderFactory.js');
        }, 100);
      }, 150); // Slightly longer delay to ensure scrolling completes

    } catch (error) {
      // 🛡️ Ensure locks are cleared on error
      clearTimeout(safetyTimeout);
      instance.refreshInProgress = false;
      instance.scrollLocked = false;
      instance.scrollLockReason = null;
      setNavigatingState(false);
      console.error('❌ refresh() failed:', error);
      throw error; // Re-throw so caller knows it failed
    }
  };


  return instance;
}


// Update loadNextChunkFixed
export async function loadNextChunkFixed(currentLastChunkId: any, instance: any) {
  // ✅ Refresh cache before searching if dirty
  if (isCacheDirty()) {
    verbose.debug('Cache dirty, refreshing from IndexedDB before searching for next chunk...', 'lazyLoaderFactory.js');
    const freshNodes = await getNodeChunksFromIndexedDB(instance.bookId);
    if (freshNodes?.length) {
      instance.nodes = freshNodes;
    }
    clearCacheDirtyFlag();
  }

  const currentId = asChunkId(parseFloat(String(currentLastChunkId)));
  verbose.debug(`loadNextChunkFixed called with currentLastChunkId: ${currentId}`, 'lazyLoaderFactory.js');

  // Decimal-aware: next = next manifest entry, or smallest chunk_id > current.
  // See lazyLoader/utilities/chunkSelection (pinned by chunkSelection.test.js).
  let nextNodes = [];
  const nextChunkId = selectNextChunkId(instance.chunkManifest, instance.nodes, currentId);

  verbose.debug(`Found next chunk ID: ${nextChunkId} (searched ${instance.nodes.length} nodes)`, 'lazyLoaderFactory.js');

  if (nextChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
      return;
    }

    nextNodes = instance.nodes.filter((node: any) => parseFloat(node.chunk_id) === nextChunkId);

    // Server fallback: chunk not yet downloaded
    if (nextNodes.length === 0 && !instance.isFullyLoaded) {
      try {
        const { fetchSingleChunkFromServer, storeSingleChunkToIndexedDB }: any = await import('./chunkFetcher');
        nextNodes = await fetchSingleChunkFromServer(instance.bookId, nextChunkId);
        if (nextNodes.length > 0) {
          await storeSingleChunkToIndexedDB(nextNodes);
          instance.nodes.push(...nextNodes);
        }
      } catch (err) {
        console.error('Server fallback for next chunk failed:', err);
      }
    }

    if (nextNodes.length === 0) {
      return;
    }

    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(nextChunkId);
    scheduleAutoClear(nextChunkId, 1000); // Auto-clear after 1 second

    const container = instance.container;
      const chunkElement: any = createChunkElement(nextNodes, instance);
      container.appendChild(chunkElement);
      instance.currentlyLoadedChunks.add(nextChunkId);

      // 🆕 Ensure no-delete-id marker exists for this book (async, fire-and-forget)
      ensureNoDeleteMarkerForBook(chunkElement, instance.nodes, instance.isFullyLoaded).catch(err =>
        console.error('Failed to ensure no-delete-id marker:', err)
      );

      // ✅ Attach listeners only to this chunk
      instance.attachMarkListeners?.(chunkElement);
      instance.attachUnderlineClickListeners?.(chunkElement);

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
export async function loadPreviousChunkFixed(currentFirstChunkId: any, instance: any) {
  // ✅ Refresh cache before searching if dirty
  if (isCacheDirty()) {
    verbose.debug('Cache dirty, refreshing from IndexedDB before searching for previous chunk...', 'lazyLoaderFactory.js');
    const freshNodes = await getNodeChunksFromIndexedDB(instance.bookId);
    if (freshNodes?.length) {
      instance.nodes = freshNodes;
    }
    clearCacheDirtyFlag();
  }

  const currentId = asChunkId(parseFloat(String(currentFirstChunkId)));

  // Decimal-aware: prev = previous manifest entry, or largest chunk_id < current.
  // See lazyLoader/utilities/chunkSelection (pinned by chunkSelection.test.js).
  let prevNodes = [];
  const prevChunkId = selectPrevChunkId(instance.chunkManifest, instance.nodes, currentId);

  if (prevChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${prevChunkId}"]`)) {
      return;
    }

    prevNodes = instance.nodes.filter((node: any) => parseFloat(node.chunk_id) === prevChunkId);

    // Server fallback: chunk not yet downloaded
    if (prevNodes.length === 0 && !instance.isFullyLoaded) {
      try {
        const { fetchSingleChunkFromServer, storeSingleChunkToIndexedDB }: any = await import('./chunkFetcher');
        prevNodes = await fetchSingleChunkFromServer(instance.bookId, prevChunkId);
        if (prevNodes.length > 0) {
          await storeSingleChunkToIndexedDB(prevNodes);
          instance.nodes.push(...prevNodes);
        }
      } catch (err) {
        console.error('Server fallback for previous chunk failed:', err);
      }
    }

    if (prevNodes.length === 0) {
      return;
    }

    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(prevChunkId);
    scheduleAutoClear(prevChunkId, 1000);

    const container = instance.container;
    const prevScrollTop = instance.scrollableParent.scrollTop;
    const chunkElement: any = (createChunkElement as any)(prevNodes, instance, instance.config?.onFirstChunkLoaded);
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

    instance.attachMarkListeners?.(chunkElement);
    instance.attachUnderlineClickListeners?.(chunkElement);

    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    setTimeout(() => {
      clearChunkLoadingInProgress(prevChunkId);
    }, 100);
  }
}

async function loadChunkInternal(chunkId: any, direction: any, instance: any, attachMarkers: any) {
  // ✅ Check if cache is dirty and refresh if needed
  if (isCacheDirty()) {
    verbose.debug('Cache dirty, refreshing from IndexedDB before loading chunk...', 'lazyLoaderFactory.js');
    const freshNodes = await getNodeChunksFromIndexedDB(instance.bookId);
    if (freshNodes?.length) {
      instance.nodes = freshNodes;
    }
    clearCacheDirtyFlag();
  }

  if (instance.currentlyLoadedChunks.has(chunkId)) {
    return;
  }

  const nextNodes = instance.nodes.filter(
    (node: any) => node.chunk_id === chunkId
  );

  if (!nextNodes || nextNodes.length === 0) {
    return;
  }

  setChunkLoadingInProgress(chunkId);
  scheduleAutoClear(chunkId, 1000);

  // createChunkElement is called with its simple, correct signature.
   const chunkElement: any = createChunkElement(nextNodes, instance);

  if (direction === "up") {
    instance.container.insertBefore(chunkElement, instance.container.firstChild);
  } else {
    // Insert before the bottom sentinel so chunks stay above it
    const bottomSentinel = instance.bottomSentinel;
    if (bottomSentinel && bottomSentinel.parentNode === instance.container) {
      instance.container.insertBefore(chunkElement, bottomSentinel);
    } else {
      instance.container.appendChild(chunkElement);
    }
  }

  instance.currentlyLoadedChunks.add(chunkId);

  // 🆕 Ensure no-delete-id marker exists for this book (async, fire-and-forget)
  ensureNoDeleteMarkerForBook(chunkElement, instance.nodes).catch(err =>
    console.error('Failed to ensure no-delete-id marker:', err)
  );

  // ✅ Attach listeners only to this chunk
  instance.attachMarkListeners?.(chunkElement);
  instance.attachUnderlineClickListeners?.(chunkElement);

  // Re-apply cascade-origin glow if this chunk contains the target highlight
  // (ALL segments — a highlight renders as multiple marks split by overlaps/sups)
  const cascadeId = getCascadeOriginId();
  if (cascadeId) {
    chunkElement.querySelectorAll(`mark.${CSS.escape(cascadeId)}`).forEach((markEl: any) => {
      markEl.classList.add('cascade-origin');
    });
  }

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
    const nodeCount = instance.nodes.find((c: any) => c.chunk_id === 0)?.nodes?.length || 50;
    log.content(`First chunk rendered (${nodeCount} nodes)`, 'lazyLoaderFactory.js');
  }
  verbose.content(`Chunk #${chunkId} loaded into DOM`, 'lazyLoaderFactory.js');
  return chunkElement; // ✅ return DOM element
}


/**
 * Repositions the sentinels around loaded chunks.
 */
function repositionFixedSentinelsForBlockInternal(instance: any, attachMarkers: any) {
  verbose.content(`Repositioning sentinels for book: ${instance.bookId}`, 'lazyLoaderFactory.js');
  const container = instance.container;
  const allChunks = Array.from(container.querySelectorAll("[data-chunk-id]")) as any[];
  verbose.debug(`Found ${allChunks.length} chunks for reposition`, 'lazyLoaderFactory.js');
  if (allChunks.length === 0) {
    verbose.debug('No chunks, aborting reposition', 'lazyLoaderFactory.js');
    return;
  }
  allChunks.sort(
  (a, b) =>
    parseChunkId(a.getAttribute("data-chunk-id")) -
    parseChunkId(b.getAttribute("data-chunk-id"))
);
  verbose.debug(`Sorted chunk IDs: ${allChunks.map(c => c.getAttribute('data-chunk-id')).join(', ')}`, 'lazyLoaderFactory.js');
  if (instance.observer) {
    instance.observer.disconnect();
  }
  if (instance.topSentinel) {
    instance.topSentinel.remove();
  }
  if (instance.bottomSentinel) {
    instance.bottomSentinel.remove();
  }
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
  verbose.debug(`New sentinels - top: ${topSentinel.id}, bottom: ${bottomSentinel.id}`, 'lazyLoaderFactory.js');
  if (instance.observer) {
    instance.observer.observe(topSentinel);
    instance.observer.observe(bottomSentinel);
    verbose.content("Sentinels repositioned and observer reattached", 'lazyLoaderFactory.js');
  }
  instance.currentlyLoadedChunks = new Set(
    allChunks.map((chunk) => parseChunkId(chunk.getAttribute("data-chunk-id")))
  );
}

/**
 * Inserts a chunk into the container in order.
 */
function insertChunkInOrderInternal(newChunk: any, instance: any) {
  const container = instance.container;
  const existingChunks = Array.from(container.querySelectorAll("[data-chunk-id]")) as any[];
  let inserted = false;
  const newChunkId = parseChunkId(newChunk.getAttribute("data-chunk-id"));

  for (let i = 0; i < existingChunks.length; i++) {
    const existingId = parseChunkId(existingChunks[i].getAttribute("data-chunk-id"));
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
export function getLastChunkId(instance: any): ChunkId | null {
  const chunks = instance.container.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return parseChunkId(chunks[chunks.length - 1].getAttribute("data-chunk-id"));
}

export { repositionFixedSentinelsForBlockInternal as repositionSentinels };
