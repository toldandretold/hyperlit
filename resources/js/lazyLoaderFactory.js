import { renderBlockToHtml } from "./convert-markdown.js";
import { attachMarkListeners } from "./hyperLights.js";
import {
  //saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  getLocalStorageKey,
  getHyperciteFromIndexedDB
} from "./cache-indexedDB.js";
import { attachUnderlineClickListeners } from "./hyperCites.js";
import {
  setChunkLoadingInProgress,
  clearChunkLoadingInProgress,
  scheduleAutoClear
} from './chunkLoadingState.js';
import { setupUserScrollDetection, shouldSkipScrollRestoration } from './scrolling.js';
import { scrollElementIntoMainContent } from "./scrolling.js";
import { isNewlyCreatedHighlight } from './operationState.js';

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
 * Factory function for lazy loading.
 *
 * IMPORTANT: The config object must include a property "bookId" which also
 * corresponds to the id of the container DIV in the DOM. For example, if bookId
 * is "book1", then the container is expected to be:
 *    <div id="book1" class="main-content"></div>
 */
export function createLazyLoader(config) {
  const {
    nodeChunks,
    loadNextChunk,
    loadPreviousChunk,
    attachMarkListeners: attachMarkers,
    isRestoringFromCache = false,
    isNavigatingToInternalId = false,
    isUpdatingJsonContent = false,
    bookId = "latest",
    onFirstChunkLoaded,
  } = config;

  if (!nodeChunks || nodeChunks.length === 0) {
    console.error("No nodes available for lazy loader. Aborting lazy loader.");
    return null;
  }

  // --- MOVE THIS BLOCK UP! ---
  const container = document.getElementById(bookId); // <<< DEFINE CONTAINER FIRST
  if (!container) {
    console.error(
      `Container element with id "${bookId}" not found in the DOM.`
    );
    return null;
  }
  // --- END MOVED BLOCK ---

  // Now, container is defined, so you can safely use it:
  let scrollableParent;
  const readerWrapper = container.closest(".reader-content-wrapper");
  const homeWrapper = container.closest(".home-content-wrapper");

  if (readerWrapper) {
      scrollableParent = readerWrapper;
  } else if (homeWrapper) {
      scrollableParent = homeWrapper;
  } else {
      scrollableParent = window;
      console.warn("No specific .reader-content-wrapper or .home-content-wrapper found. Using window as scrollable parent.");
  }
  
  // Create the instance to track lazy-loader state.
  const instance = {
    nodeChunks, // Array of chunk objects
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
    lastViewportWidth: null, // Track viewport width for smart resize handling
  };

  // Set up user scroll detection to prevent restoration interference
  if (scrollableParent && scrollableParent !== window) {
    console.log("🔧 Setting up user scroll detection for scrollable container");
    setupUserScrollDetection(scrollableParent);
  } else {
    console.log("🔧 Setting up user scroll detection for window");
    setupUserScrollDetection(document.documentElement);
  }

  // 🔗 CENTRALIZED LINK HANDLING - scoped to this lazy loader instance
  const globalLinkHandler = async (event) => {
    const link = event.target.closest('a');
    if (!link || !link.href) return;

    console.log('🔗 LazyLoader: Global link clicked:', {
      href: link.href,
      bookId: instance.bookId
    });

    try {
      // Import and delegate to LinkNavigationHandler for processing
      const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
      const handled = await LinkNavigationHandler.handleLinkClick(event);
      
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      } else if (handled === false) {
        // LinkNavigationHandler explicitly said not to handle this (e.g., homepage navigation)
        // Let the default browser behavior occur for proper history management
        console.log('🔗 LazyLoader: Delegating to browser default navigation');
      }
    } catch (error) {
      console.error('🔗 LazyLoader: Link handling failed:', error);
    }
  };

  // Add the centralized link handler
  document.addEventListener('click', globalLinkHandler);
  instance.globalLinkHandler = globalLinkHandler; // Store for cleanup

  if (instance.isRestoringFromCache) {
    console.log("Skipping lazy loading due to cache restoration.");
    attachMarkers(container);
    return instance;
  }

  // Remove any existing sentinels.
  container.querySelectorAll(".sentinel").forEach((sentinel) => sentinel.remove());
  console.log("Removed any existing sentinels.");

  // Here, the container's id is assumed to equal the book id. Use that as a unique id.
  const uniqueId = container.id || Math.random().toString(36).substr(2, 5);
  console.log("Unique ID for this container:", uniqueId);

  // Wrap caching methods so the instance passes only bookId.
  //instance.saveNodeChunks = (chunks) => {
    //return saveNodeChunksToIndexedDB(chunks, instance.bookId);
  //};
  instance.getNodeChunks = () => {
    return getNodeChunksFromIndexedDB(instance.bookId);
  };

  // --- SCROLL POSITION SAVING LOGIC ---

  // Core saving logic. Can be called directly when a save is required.
  const forceSavePosition = () => {
    // More efficient query for valid, trackable elements.
    const elements = instance.container.querySelectorAll("p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
    if (elements.length === 0) return;

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
        if (sessionStorage.getItem(storageKey) !== stringifiedData) {
          sessionStorage.setItem(storageKey, stringifiedData);
          localStorage.setItem(storageKey, stringifiedData);
          console.log("🔧 SAVE SCROLL: Saved scroll position to element:", detectedId);
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

  // Attach the throttled, guarded listener for regular user scrolling.
  if (instance.scrollableParent === window) {
    window.addEventListener("scroll", throttle(instance.saveScrollPosition, 250));
  } else {
    instance.scrollableParent.addEventListener("scroll", throttle(instance.saveScrollPosition, 250));
  }

  instance.restoreScrollPosition = async () => {
    // Check if user is currently scrolling
    if (shouldSkipScrollRestoration("instance restoreScrollPosition")) {
      return;
    }
    
    const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
    const storedData =
      sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (!storedData) {
      console.warn("No saved scroll data found.");
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
      console.log(
        "Restoring scroll position to already loaded element:",
        scrollData.elementId
      );
      // *** FIX 2: Use scrollElementIntoMainContent ***
      scrollElementIntoMainContent(targetElement, instance.container, 50); // Pass instance.container
    } else {
      console.log(
        "Element not in DOM; looking it up in IndexedDB based on startLine:",
        scrollData.elementId
      );
      try {
        // Get the node chunks from IndexedDB.
        const nodeChunksData = await instance.getNodeChunks();
        if (!nodeChunksData || nodeChunksData.length === 0) {
          console.warn("No node chunks found in IndexedDB.");
          return;
        }
        // Look for the chunk where startLine matches the saved element id.
        // Note: saved element id is a string; if needed, parse it as an integer.
        const savedStartLine = parseFloat(scrollData.elementId);
        const matchingChunk = nodeChunksData.find((chunk) => {
          // Assuming each chunk object contains a startLine property.
          return parseFloat(chunk.startLine, 10) === savedStartLine;
        });

        if (matchingChunk) {
          console.log(
            "Found matching chunk from IndexedDB for startLine:",
            savedStartLine,
            "chunk:",
            matchingChunk
          );
          // Load this chunk. If loadChunkInternal() is used, you might load with direction "down".
          loadChunkInternal(
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
              console.log(
                "Restoring scroll position after loading chunk, element:",
                scrollData.elementId
              );
              // *** FIX 5: Use scrollElementIntoMainContent ***
              scrollElementIntoMainContent(newTarget, instance.container, 50); // Pass instance.container
            } else {
              console.warn(
                "After loading, element still not found:",
                scrollData.elementId
              );
            }
          }, 100);
        } else {
          console.warn(
            "No matching chunk (startLine:",
            scrollData.elementId,
            ") found in IndexedDB."
          );
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
    console.log(
      `🔄 [CORRECTED] updateAndRenderFromPaste called with ${newAndUpdatedNodes.length} nodes.`
    );

    try {
      // 1. GET THE TRUTH: The data in IndexedDB is now correct.
      //    Fetch the complete, fresh list of all node chunks.
      console.log("🔄 Fetching complete and fresh node list from nodeChunks object store in IndexedDB...");
      instance.nodeChunks = await instance.getNodeChunks();
      if (!instance.nodeChunks || instance.nodeChunks.length === 0) {
        console.error("❌ Aborting render: Failed to fetch any nodes from nodeChunks object store in IndexedDB.");
        return;
      }

      // 2. CLEAN SLATE: Remove all previously rendered chunks of nodes from the DOM.
      console.log("🔄 Clearing existing rendered chunks of nodes from the DOM.");
      instance.container
        .querySelectorAll("[data-chunk-id]")
        .forEach((el) => el.remove());

      // 3. RESET TRACKING: Clear the set of loaded chunks.
      instance.currentlyLoadedChunks.clear();

      // 4. FIND THE STARTING POINT: Determine which chunk of nodes to load first.
      //    We want to load the chunk of nodes containing the first piece of new content.
      const firstNewNode = newAndUpdatedNodes[0];
      const chunkToLoadId = firstNewNode.chunk_id;
      console.log(`🔄 Determined initial chunk of nodes to load: ${chunkToLoadId}`);

      // 5. RENDER: Load the target chunk. The lazy loader will handle the rest.
      loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);

      // 6. RESTORE FOCUS: Immediately after chunk loads, scroll to first pasted element
      // Use requestAnimationFrame to ensure DOM is painted, then scroll immediately
      requestAnimationFrame(() => {
        const firstNewElementId = firstNewNode.startLine;
        const targetElement = document.getElementById(firstNewElementId);

        if (targetElement) {
          console.log(`✨ Scrolling to and focusing pasted element: ${firstNewElementId}`);

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

          console.log(`📍 Scrolled to pasted element at offset: ${offset}px from top`);

          // Set focus for contenteditable
          targetElement.focus();

          // Place cursor at the end of the newly pasted content
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetElement);
          range.collapse(false); // false = collapse to the end
          selection.removeAllRanges();
          selection.addRange(range);

          console.log('🔍 PASTE DIAGNOSTICS - Lazy Loader State:', {
            scrollLocked: instance.scrollLocked,
            scrollLockReason: instance.scrollLockReason,
            isNavigatingToInternalId: instance.isNavigatingToInternalId,
            currentlyLoadedChunks: Array.from(instance.currentlyLoadedChunks),
            observerActive: !!instance.observer,
            topSentinelInDOM: document.contains(instance.topSentinel),
            bottomSentinelInDOM: document.contains(instance.bottomSentinel)
          });
        } else {
          console.warn(
            `Could not find element ${firstNewElementId} to set focus.`
          );
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
        console.log("🔧 VIEWPORT: Significant width change, checking if safe to restore scroll position");
        
        // Check if user is currently scrolling before restoring
        if (!shouldSkipScrollRestoration("viewport resize")) {
          console.log("🔧 VIEWPORT: Safe to restore scroll position");
          instance.restoreScrollPosition();
        } else {
          console.log("🔧 VIEWPORT: User is scrolling, skipping restoration");
        }
      } else {
        console.log("🔧 VIEWPORT: Minor resize (likely DevTools), skipping restore");
      }
    }, 300); // Longer delay to avoid DevTools flicker
  });
  // --- END SCROLL POSITION LOGIC ---

  // Create top and bottom sentinel elements.
  const topSentinel = document.createElement("div");
  topSentinel.id = `${uniqueId}-top-sentinel`;
  topSentinel.classList.add("sentinel");
  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.classList.add("sentinel");
  container.prepend(topSentinel);
  container.appendChild(bottomSentinel);
  console.log("Inserted sentinels:", topSentinel.id, bottomSentinel.id);

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
    console.log("🔍 Observer triggered, entries:", entries.length);

    // 🔒 CHECK SCROLL LOCK: Don't trigger lazy loading during navigation
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      const reason = instance.scrollLocked ? `scroll locked (${instance.scrollLockReason})` : 'navigation in progress';
      console.log(`🔍 OBSERVER BLOCKED: ${reason}`, {
        scrollLocked: instance.scrollLocked,
        scrollLockReason: instance.scrollLockReason,
        isNavigatingToInternalId: instance.isNavigatingToInternalId,
        entries: entries.map(e => ({ target: e.target.id, isIntersecting: e.isIntersecting })),
        timestamp: Date.now()
      });
      return;
    }
    
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      if (entry.target.id === topSentinel.id) {
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseFloat(firstChunkEl.getAttribute("data-chunk-id"));
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            console.log(`🔍 OBSERVER ACTIVE: Loading previous chunk of nodes #${firstChunkId - 1}`);
            loadPreviousChunkFixed(firstChunkId, instance);
          }
        }
      }
      if (entry.target.id === bottomSentinel.id) {
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseFloat(lastChunkEl.getAttribute("data-chunk-id"), 10);
          console.log(`🔍 OBSERVER ACTIVE: Loading next chunk of nodes after #${lastChunkId}`);
          loadNextChunkFixed(lastChunkId, instance);
        }
      }
    });
  }, observerOptions);

  observer.observe(topSentinel);
  observer.observe(bottomSentinel);
  console.log("Observer attached to sentinels.");

  attachMarkers(container);

  instance.observer = observer;
  instance.topSentinel = topSentinel;
  instance.bottomSentinel = bottomSentinel;

  instance.disconnect = () => {
    observer.disconnect();
    
    // 🔗 Remove the centralized link handler
    if (instance.globalLinkHandler) {
      document.removeEventListener('click', instance.globalLinkHandler);
      console.log("🔗 LazyLoader: Global link handler removed");
    }
    
    console.log("Observer disconnected.");
  };

  instance.repositionSentinels = () =>
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  instance.loadChunk = (chunkId, direction = "down") =>
    loadChunkInternal(chunkId, direction, instance, attachMarkers);

  // NEW: Scroll lock methods
  instance.lockScroll = (reason = 'navigation') => {
    instance.scrollLocked = true;
    instance.scrollLockReason = reason;
    console.log(`🔒 Scroll locked: ${reason}`);
  };
  
  instance.unlockScroll = () => {
    const wasLocked = instance.scrollLocked;
    const reason = instance.scrollLockReason;
    instance.scrollLocked = false;
    instance.scrollLockReason = null;
    if (wasLocked) {
      console.log(`🔓 Scroll unlocked (was: ${reason})`);

      // After a navigation lock is released, force a save of the final position.
      // Use a timeout to ensure the scroll has settled after any animations.
      setTimeout(() => {
        console.log(`🎯 Forcing scroll position save after navigation.`);
        forceSavePosition();
      }, 250);
    }
  };


    // In lazyLoaderFactory.js, inside the createLazyLoader function...

  instance.refresh = async (targetElementId = null) => {
    console.log(`🔄 Lazy-loader refresh starting. Target ID: ${targetElementId}`);
    
    // 1. Re-read the fresh nodeChunks from IndexedDB (from your original)
    instance.nodeChunks = await instance.getNodeChunks();
    
    // 2. Remove all rendered chunk-DIVs (from your original)
    instance.container
      .querySelectorAll("[data-chunk-id]")
      .forEach(el => el.remove());
    
    // 3. Reset our “which chunks are in the DOM” set (from your original)
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
    const allChunkIds = [...new Set(instance.nodeChunks.map(n => n.chunk_id))].sort((a, b) => a - b);
    let chunkToLoadId = allChunkIds.length > 0 ? allChunkIds[0] : null;

    if (targetElementId) {
      const targetChunk = instance.nodeChunks.find(c => c.startLine == targetElementId);
      if (targetChunk) {
        chunkToLoadId = targetChunk.chunk_id;
        console.log(`🎯 Found target chunk of nodes #${chunkToLoadId} for element ${targetElementId}`);
      }
    }

    // 7. Load the determined chunk
    if (chunkToLoadId !== null) {
      console.log(`🔄 Refresh loading initial chunk of nodes #${chunkToLoadId}`);
      loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);
    }

    // 8. ✅ NEW: Scroll to and focus the target element after rendering
    setTimeout(() => {
      let elementToFocus = targetElementId ? document.getElementById(targetElementId) : null;

      // Fallback if the target element isn't found
      if (!elementToFocus) {
        elementToFocus = instance.container.querySelector('p, h1, h2, h3, blockquote, pre');
        console.log("...target element not found, falling back to first block element.");
      }

      if (elementToFocus) {
        console.log(`✨ Scrolling to and focusing element:`, elementToFocus);

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

      // 🔍 DIAGNOSTICS: Log lazy loader state after refresh
      console.log('🔍 REFRESH DIAGNOSTICS - Lazy Loader State:', {
        scrollLocked: instance.scrollLocked,
        scrollLockReason: instance.scrollLockReason,
        isNavigatingToInternalId: instance.isNavigatingToInternalId,
        currentlyLoadedChunks: Array.from(instance.currentlyLoadedChunks),
        observerActive: !!instance.observer,
        topSentinelInDOM: document.contains(instance.topSentinel),
        bottomSentinelInDOM: document.contains(instance.bottomSentinel)
      });
    }, 150); // Slightly longer delay to ensure scrolling completes
  };

  
  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
// Keep createChunkElement function signature unchanged
export function createChunkElement(nodes, instance) {
  // <-- Correct, simple signature
  console.log("🏗️ createChunkElement called", {
    nodes_count: nodes.length,
    chunk_id: nodes.length > 0 ? nodes[0].chunk_id : 'unknown',
    bookId: instance.bookId
  });
  
  if (!nodes || nodes.length === 0) {
    console.warn("❌ createChunkElement: No nodes provided");
    return null;
  }

  const chunkId = nodes[0].chunk_id;
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");

  console.log(`🏗️ Processing ${nodes.length} nodes for chunk of nodes #${chunkId}`);

  nodes.forEach((node, nodeIndex) => {
    // ✅ Server handles migration - node_id should already exist
    // If not, log warning but continue (should not happen after migration)
    if (!node.node_id) {
      console.warn(`⚠️ Node ${node.startLine} missing node_id after server migration!`);
    }

    let html = renderBlockToHtml(node);

    if (node.hyperlights && node.hyperlights.length > 0) {
      html = applyHighlights(html, node.hyperlights, instance.bookId);
    }

    if (node.hypercites && node.hypercites.length > 0) {
      html = applyHypercites(html, node.hypercites);
    }

    const temp = document.createElement("div");
    temp.innerHTML = html;
    if (temp.firstChild) {
      // ✅ data-node-id should already be in HTML from server
      // But ensure numerical id is set
      temp.firstChild.setAttribute('id', node.startLine);
      chunkWrapper.appendChild(temp.firstChild);
    } else {
      console.warn(`⚠️ Node ${nodeIndex + 1} produced no DOM content`);
    }
  });

  console.log(`✅ createChunkElement completed for chunk of nodes #${chunkId}`);
  return chunkWrapper;
}


  
export function applyHypercites(html, hypercites) {
  if (!hypercites || hypercites.length === 0) return html;

  // 🔍 ADD THIS DEBUG LINE HERE
  console.log("🔍 Raw hypercites data:", JSON.stringify(hypercites, null, 2));
  
  console.log("Applying hypercites:", hypercites);
  
  // 🔍 DEBUG: Let's see what we're working with
  hypercites.forEach(h => {
    console.log(`🔍 Hypercite ${h.hyperciteId}: relationshipStatus = "${h.relationshipStatus}"`);
  });
  
  const segments = createHyperciteSegments(hypercites);
  
  // 🔍 DEBUG: Check what segments were created
  console.log("🔍 Created segments:", segments);
  
  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;
  
  segments.sort((a, b) => b.charStart - a.charStart);

  for (const segment of segments) {
    console.log(`Applying hypercite segment from ${segment.charStart} to ${segment.charEnd}`, segment);
    
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);
    
    if (positions) {
      const underlineElement = document.createElement("u");
      
      // Handle single vs multiple hypercites in segment
      if (segment.hyperciteIDs.length === 1) {
        underlineElement.id = segment.hyperciteIDs[0];
        
        // 🔧 FIX: Don't default to 'single', use the actual status
        const actualStatus = segment.statuses[0];
        console.log(`🔍 Single hypercite ${segment.hyperciteIDs[0]} status: "${actualStatus}"`);
        
        underlineElement.className = actualStatus || 'single';
        
        // Set hypercite intensity for single hypercite (start dim)
        if (actualStatus === 'couple' || actualStatus === 'poly') {
          underlineElement.style.setProperty('--hypercite-intensity', '0.4');
        }
      } else {
        // Multiple hypercites overlapping
        underlineElement.id = "hypercite_overlapping";
        
        console.log("🔍 Overlapping segment debug:");
        console.log("Hypercite IDs:", segment.hyperciteIDs);
        console.log("Statuses array:", segment.statuses);
        
        let finalStatus = 'single';
        const coupleCount = segment.statuses.filter(status => status === 'couple').length;
        
        console.log("Couple count:", coupleCount);
        
        if (segment.statuses.includes('poly')) {
          finalStatus = 'poly';
          console.log("Set to poly because includes poly");
        } else if (coupleCount >= 2) {
          finalStatus = 'poly';
          console.log("Set to poly because multiple couples:", coupleCount);
        } else if (segment.statuses.includes('couple')) {
          finalStatus = 'couple';
          console.log("Set to couple because single couple");
        }
        
        console.log("Final status:", finalStatus);
        
        underlineElement.className = finalStatus;
        underlineElement.setAttribute("data-overlapping", segment.hyperciteIDs.join(","));
        
        // Set hypercite intensity for overlapping hypercites (more overlaps = brighter)
        if (finalStatus === 'couple' || finalStatus === 'poly') {
          const overlappingCount = segment.hyperciteIDs.length;
          // Increase intensity based on overlapping count - more overlaps = brighter
          const intensity = Math.min(1.0, 0.4 + (overlappingCount - 1) * 0.2);
          underlineElement.style.setProperty('--hypercite-intensity', intensity.toString());
          console.log(`Set hypercite intensity for ${overlappingCount} overlapping hypercites: ${intensity}`);
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
  console.log('🎨 applyHighlights called', {
    bookId,
    highlights_count: highlights ? highlights.length : 0,
    highlights_sample: highlights && highlights.length > 0 ? highlights[0] : null,
    html_length: html.length
  });

  if (!highlights || highlights.length === 0) {
    console.log('🎨 applyHighlights: No highlights to apply');
    return html;
  }

  // Enhanced logging for each highlight
  console.log('🎨 Detailed highlight analysis:');
  highlights.forEach((highlight, index) => {
    console.log(`  Highlight ${index + 1}:`, {
      id: highlight.hyperlight_id || highlight.highlightID,
      is_user_highlight: highlight.is_user_highlight,
      has_is_user_highlight_property: 'is_user_highlight' in highlight,
      creator: highlight.creator,
      creator_token: highlight.creator_token,
      startChar: highlight.startChar || highlight.charStart,
      endChar: highlight.endChar || highlight.charEnd,
      text_length: (highlight.endChar || highlight.charEnd) - (highlight.startChar || highlight.charStart),
      full_highlight_object: highlight
    });
  });

  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;
  console.log('🎨 Created temp element, original text length:', tempElement.textContent.length);
  
  const segments = createHighlightSegments(highlights);
  console.log('🎨 applyHighlights: Created segments', {
    segments_count: segments.length,
    segments: segments.map(s => ({
      charStart: s.charStart,
      charEnd: s.charEnd,
      length: s.charEnd - s.charStart,
      highlightIDs: s.highlightIDs
    }))
  });
  
  // Keep reverse order but recalculate positions each time
  segments.sort((a, b) => b.charStart - a.charStart);
  console.log('🎨 Processing segments in reverse order (last to first)');

  for (const [segmentIndex, segment] of segments.entries()) {
    console.log(`🎨 Processing segment ${segmentIndex + 1}/${segments.length} from ${segment.charStart} to ${segment.charEnd}`, {
      segment_length: segment.charEnd - segment.charStart,
      highlightIDs: segment.highlightIDs
    });
    
    // Recalculate positions based on current DOM state
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);
    
    if (positions) {
      console.log(`🎨 Found DOM positions for segment ${segmentIndex + 1}:`, {
        startNode_type: positions.startNode.nodeType,
        startNode_content: positions.startNode.textContent.substring(0, 50) + '...',
        startOffset: positions.startOffset,
        endNode_type: positions.endNode.nodeType,
        endOffset: positions.endOffset
      });
      
      const markElement = document.createElement("mark");
      
      // Always set data-highlight-count and intensity
      markElement.setAttribute("data-highlight-count", segment.highlightIDs.length);
      const intensity = Math.min(segment.highlightIDs.length / 5, 1); // Cap at 5 highlights
      markElement.style.setProperty('--highlight-intensity', intensity);
      
      // Check if any highlight in this segment belongs to current user using server flag OR is newly created
      const userHighlightDetails = segment.highlightIDs.map(id => {
        const highlight = highlights.find(h => (h.hyperlight_id || h.highlightID) === id);
        
        // Check if this is a newly created highlight (before backend processing)
        const isNewlyCreated = isNewlyCreatedHighlight(id);
        
        console.log(`🔍 Looking for highlight ${id}:`, {
          found: !!highlight,
          highlight_data: highlight,
          has_is_user_highlight_flag: highlight ? ('is_user_highlight' in highlight) : false,
          is_user_highlight_value: highlight ? highlight.is_user_highlight : 'N/A',
          is_newly_created: isNewlyCreated
        });
        
        return {
          id,
          highlight_found: !!highlight,
          is_user_highlight: highlight ? highlight.is_user_highlight : isNewlyCreated,
          creator: highlight ? highlight.creator : null,
          creator_token: highlight ? highlight.creator_token : null,
          is_newly_created: isNewlyCreated
        };
      });
      
      console.log(`🎨 User highlight analysis for segment ${segmentIndex + 1}:`, userHighlightDetails);
      
      const hasUserHighlight = userHighlightDetails.some(detail => detail.is_user_highlight);
      console.log(`🎨 Final hasUserHighlight decision for segment ${segmentIndex + 1}:`, hasUserHighlight);
      
      if (segment.highlightIDs.length === 1) {
        markElement.id = segment.highlightIDs[0];
        markElement.className = segment.highlightIDs[0];
        console.log(`🎨 Single highlight segment: id=${markElement.id}, class=${markElement.className}`);
      } else {
        markElement.id = "HL_overlap";
        markElement.className = segment.highlightIDs.join(" ");
        console.log(`🎨 Overlapping highlights segment: id=${markElement.id}, classes=${markElement.className}`);
      }
      
      // Add user-specific class for styling
      if (hasUserHighlight) {
        markElement.classList.add('user-highlight');
        console.log(`✅ Added user-highlight class to segment ${segmentIndex + 1} with IDs: ${segment.highlightIDs.join(', ')}`);
      } else {
        console.log(`❌ No user-highlight class for segment ${segmentIndex + 1} - not user's highlight`);
      }
      
      console.log(`🎨 Final mark element for segment ${segmentIndex + 1}:`, {
        id: markElement.id,
        className: markElement.className,
        hasUserHighlight,
        intensity
      });
      
      // Use surroundContents instead of extractContents
      wrapRangeWithElement(
      positions.startNode,
      positions.startOffset,
      positions.endNode,
      positions.endOffset,
      markElement
    );
    console.log(`✅ Applied highlight to segment ${segmentIndex + 1} using tolerant wrapper`);
    } else {
      console.warn(`⚠️ Could not find DOM positions for segment ${segmentIndex + 1} (${segment.charStart}-${segment.charEnd})`);
    }
  }

  const finalHtml = tempElement.innerHTML;
  console.log(`✅ applyHighlights completed`, {
    original_length: html.length,
    final_length: finalHtml.length,
    segments_processed: segments.length,
    user_highlight_segments: segments.filter(s => s.highlightIDs.some(id => {
      const highlight = highlights.find(h => (h.hyperlight_id || h.highlightID) === id);
      return highlight && highlight.is_user_highlight;
    })).length
  });
  
  return finalHtml;
}


function createHighlightSegments(highlights) {
  // Collect all boundary points
  const boundaries = new Set();
  
  highlights.forEach(highlight => {
    boundaries.add(highlight.startChar || highlight.charStart);
    boundaries.add(highlight.endChar || highlight.charEnd);
  });
  
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
  const segments = [];
  
  // Create segments between each pair of boundaries
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const segmentStart = sortedBoundaries[i];
    const segmentEnd = sortedBoundaries[i + 1];
    
    // Find which highlights cover this segment
    const coveringHighlights = highlights.filter(highlight => {
      const startChar = highlight.startChar || highlight.charStart;
      const endChar = highlight.endChar || highlight.charEnd;
      return startChar <= segmentStart && endChar >= segmentEnd;
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

  console.warn(`Could not find positions for highlight range: ${startChar}-${endChar}`);
  return null;
}

function wrapRangeWithElement(startNode, startOffset, endNode, endOffset, wrapElement) {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

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
export function loadNextChunkFixed(currentLastChunkId, instance) {
  const currentId = parseFloat(currentLastChunkId);
  
  let nextChunkId = null;
  let nextNodes = [];
  
  for (const node of instance.nodeChunks) {
    const nodeChunkId = parseFloat(node.chunk_id);
    
    if (nodeChunkId > currentId && (nextChunkId === null || nodeChunkId < nextChunkId)) {
      nextChunkId = nodeChunkId;
    }
  }
  
  if (nextChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
      console.log(`Next chunk of nodes #${nextChunkId} already loaded.`);
      return;
    }
    
    nextNodes = instance.nodeChunks.filter(node => parseFloat(node.chunk_id) === nextChunkId);

    if (nextNodes.length === 0) {
      console.warn(`No data found for chunk of nodes #${nextChunkId}.`);
      return;
    }

    console.log(`Loading next chunk of nodes #${nextChunkId}`);
    
    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(nextChunkId);
    scheduleAutoClear(nextChunkId, 1000); // Auto-clear after 1 second
    
    const container = instance.container;
      const chunkElement = createChunkElement(nextNodes, instance);
      container.appendChild(chunkElement);
      instance.currentlyLoadedChunks.add(nextChunkId);
      
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

  } else {
    console.log("No next chunk of nodes available.");
  }
}

// Update loadPreviousChunkFixed similarly
export function loadPreviousChunkFixed(currentFirstChunkId, instance) {
  const currentId = parseFloat(currentFirstChunkId);
  
  let prevChunkId = null;
  let prevNodes = [];
  
  for (const node of instance.nodeChunks) {
    const nodeChunkId = parseFloat(node.chunk_id);
    
    if (nodeChunkId < currentId && (prevChunkId === null || nodeChunkId > prevChunkId)) {
      prevChunkId = nodeChunkId;
    }
  }
  
  if (prevChunkId !== null) {
    if (instance.container.querySelector(`[data-chunk-id="${prevChunkId}"]`)) {
      console.log(`Previous chunk of nodes #${prevChunkId} already loaded.`);
      return;
    }

    prevNodes = instance.nodeChunks.filter(node => parseFloat(node.chunk_id) === prevChunkId);

    if (prevNodes.length === 0) {
      console.warn(`No data found for chunk of nodes #${prevChunkId}.`);
      return;
    }

    console.log(`Loading previous chunk of nodes #${prevChunkId}`);
    
    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(prevChunkId);
    scheduleAutoClear(prevChunkId, 1000);
    
    const container = instance.container;
    const prevScrollTop = instance.scrollableParent.scrollTop;
    const chunkElement = createChunkElement(prevNodes, instance, instance.config?.onFirstChunkLoaded);
    container.insertBefore(chunkElement, container.firstElementChild);
    instance.currentlyLoadedChunks.add(prevChunkId);
    const newHeight = chunkElement.getBoundingClientRect().height;
    

    // 🚨 SCROLL LOCK PROTECTION: Don't adjust scroll if locked or navigation is in progress
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      const reason = instance.scrollLocked ? `scroll locked (${instance.scrollLockReason})` : 'navigation in progress';
      console.log(`🔧 LAZY LOADER: ${reason}, SKIPPING scroll adjustment (would have been +${newHeight}px)`);
    } else {
      // 🚨 DEBUG: Log before adjusting scroll position
      console.log(`🔧 LAZY LOADER: About to adjust scroll position by ${newHeight}px (from ${prevScrollTop} to ${prevScrollTop + newHeight})`);
      console.trace("Lazy loader scroll adjustment source:");
      
      instance.scrollableParent.scrollTop = prevScrollTop + newHeight; // <<< Use scrollableParent
      console.log(`🔧 LAZY LOADER: Adjusted scroll top of scrollableParent by ${newHeight}. New scrollTop: ${instance.scrollableParent.scrollTop}`); // NEW DEBUG
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


  } else {
    console.log("No previous chunk of nodes available.");
  }
}

function loadChunkInternal(chunkId, direction, instance, attachMarkers) {
  // console.log(`Loading chunk of nodes #${chunkId} in direction: ${direction}`);

  if (instance.currentlyLoadedChunks.has(chunkId)) {
    //console.log(`Chunk of nodes #${chunkId} already loaded; skipping.`);
    return;
  }

  const nextNodes = instance.nodeChunks.filter(
    (node) => node.chunk_id === chunkId
  );

  if (!nextNodes || nextNodes.length === 0) {
    console.warn(`No data found for chunk of nodes #${chunkId}.`);
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

  // ✅ Attach listeners only to this chunk
  attachMarkListeners(chunkElement);
  attachUnderlineClickListeners(chunkElement);

  if (chunkId === 0) {
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  }

  // ✅ THIS IS THE CORRECT LOGIC AND LOCATION
  // After the element is on the page, check for the stored callback.
  if (typeof instance.onFirstChunkLoadedCallback === "function") {
    console.log(
      "✅ First chunk rendered. Resolving pendingFirstChunkLoadedPromise."
    );
    instance.onFirstChunkLoadedCallback(); // Call the stored callback
    instance.onFirstChunkLoadedCallback = null; // Set it to null so it only fires once.
  }


  setTimeout(() => {
    clearChunkLoadingInProgress(chunkId);
  }, 100);

  console.log(`Chunk of nodes #${chunkId} loaded into DOM.`);
  return chunkElement; // ✅ return DOM element
}


/**
 * Repositions the sentinels around loaded chunks.
 */
function repositionFixedSentinelsForBlockInternal(instance, attachMarkers) {
  console.log("Repositioning sentinels...");
  const container = instance.container;
  const allChunks = Array.from(container.querySelectorAll("[data-chunk-id]"));
  if (allChunks.length === 0) {
    console.warn("No chunks available to reposition sentinels.");
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
  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.className = "sentinel";
  container.insertBefore(topSentinel, allChunks[0]);
  allChunks[allChunks.length - 1].after(bottomSentinel);
  instance.topSentinel = topSentinel;
  instance.bottomSentinel = bottomSentinel;
  if (instance.observer) {
    instance.observer.observe(topSentinel);
    instance.observer.observe(bottomSentinel);
    console.log("Sentinels repositioned and observer reattached.");
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
  console.log(`Inserted chunk of nodes #${newChunkId} into DOM in order.`);
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
