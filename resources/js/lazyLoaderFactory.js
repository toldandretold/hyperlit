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
import { getUserHighlightCache } from "./userCache.js";
import { scrollElementIntoMainContent } from "./scrolling.js";

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
    console.error("nodeChunks is empty. Aborting lazy loader.");
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
  };

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
 instance.saveScrollPosition = () => {
    // 🚨 SCROLL LOCK PROTECTION: Don't save scroll position during navigation or when locked
    if (instance.scrollLocked || instance.isNavigatingToInternalId) {
      const reason = instance.scrollLocked ? `scroll locked (${instance.scrollLockReason})` : 'navigation in progress';
      console.log(`🔧 SAVE SCROLL: ${reason}, SKIPPING scroll position save`);
      return;
    }
    
    // 🔄 NEW: Don't save scroll position during post-navigation cooldown
    if (instance.scrollSaveCooldown) {
      console.log(`🔧 SAVE SCROLL: cooldown period active, SKIPPING scroll position save`);
      return;
    }
    
    console.log("🔧 SAVE SCROLL: Running saveScrollPosition");
    
    // Query for all elements having an id attribute.
    // Use instance.container here:
    const elements = Array.from(instance.container.querySelectorAll("[id]")); 
    if (elements.length === 0) return;
    
    let scrollSourceElement = instance.scrollableParent;
    let scrollSourceRect;

    if (scrollSourceElement === window) {
      scrollSourceElement = document.documentElement;
      scrollSourceRect = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
    } else {
      // Use instance.scrollableParent for getBoundingClientRect:
      scrollSourceRect = instance.scrollableParent.getBoundingClientRect(); 
    }
    
    const topVisible = elements.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= scrollSourceRect.top;
    });

    if (topVisible) {
      const detectedId = topVisible.id;
      if (/^\d+(\.\d+)?$/.test(detectedId)) {
        const scrollData = { elementId: detectedId };
        const storageKey = getLocalStorageKey("scrollPosition", instance.bookId);
        const stringifiedData = JSON.stringify(scrollData);
        sessionStorage.setItem(storageKey, stringifiedData);
        localStorage.setItem(storageKey, stringifiedData);
        console.log("🔧 SAVE SCROLL: Saved scroll data:", scrollData);
      } else {
        console.log(
          `🔧 SAVE SCROLL: Element id "${detectedId}" is not numerical. Skip saving scroll data.`
        );
      }
    }
  };

  document.dispatchEvent(new Event("pageReady"));
  
   if (instance.scrollableParent === window) {
    window.addEventListener("scroll", throttle(instance.saveScrollPosition, 200));
  } else {
    instance.scrollableParent.addEventListener("scroll", throttle(instance.saveScrollPosition, 200));
  }

instance.restoreScrollPosition = async () => {
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
      console.log("🔄 Fetching complete and fresh node list from IndexedDB...");
      instance.nodeChunks = await instance.getNodeChunks();
      if (!instance.nodeChunks || instance.nodeChunks.length === 0) {
        console.error("❌ Aborting render: Failed to fetch any node chunks.");
        return;
      }

      // 2. CLEAN SLATE: Remove all previously rendered chunks from the DOM.
      console.log("🔄 Clearing existing rendered chunks from the DOM.");
      instance.container
        .querySelectorAll("[data-chunk-id]")
        .forEach((el) => el.remove());

      // 3. RESET TRACKING: Clear the set of loaded chunks.
      instance.currentlyLoadedChunks.clear();

      // 4. FIND THE STARTING POINT: Determine which chunk to load first.
      //    We want to load the chunk containing the first piece of new content.
      const firstNewNode = newAndUpdatedNodes[0];
      const chunkToLoadId = firstNewNode.chunk_id;
      console.log(`🔄 Determined initial chunk to load: ${chunkToLoadId}`);

      // 5. RENDER: Load the target chunk. The lazy loader will handle the rest.
      loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);

      // 6. RESTORE FOCUS: After a brief delay for rendering, find the first
      //    newly pasted element and place the cursor at the end of it.
      setTimeout(() => {
        const firstNewElementId = firstNewNode.startLine;
        const targetElement = document.getElementById(firstNewElementId);

        if (targetElement) {
          console.log(`✨ Setting focus to new element: ${firstNewElementId}`);
          targetElement.focus(); // Set focus for contenteditable

          // Place cursor at the end of the newly pasted content
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetElement);
          range.collapse(false); // false = collapse to the end
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          console.warn(
            `Could not find element ${firstNewElementId} to set focus.`
          );
        }
      }, 150); // A slightly longer timeout to be safe.
    } catch (error) {
      console.error("❌ Error in updateAndRenderFromPaste:", error);
      // Consider a full page refresh or error message as a fallback
      throw error;
    }
  };

  window.addEventListener("resize", throttle(instance.restoreScrollPosition, 200));
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
      console.log(`🔍 OBSERVER: ${reason}, SKIPPING lazy loading`);
      return;
    }
    
    entries.forEach((entry) => {
      console.log(`🔍 Observer entry: target=${entry.target.id}, isIntersecting=${entry.isIntersecting}`);
      if (!entry.isIntersecting) return;
      
      if (entry.target.id === topSentinel.id) {
        console.log("🔍 TOP SENTINEL triggered");
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseFloat(firstChunkEl.getAttribute("data-chunk-id"));
          console.log(`🔍 First chunk ID: ${firstChunkId}, checking if we should load chunk ${firstChunkId - 1}`);
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            console.log(
              `🚨 OBSERVER: Top sentinel triggered; loading previous chunk ${firstChunkId - 1} - THIS WILL ADJUST SCROLL!`
            );
            loadPreviousChunkFixed(firstChunkId, instance);
          } else {
            console.log("🔍 Top sentinel: either at first chunk or already loaded.");
          }
        }
      }
      if (entry.target.id === bottomSentinel.id) {
        console.log("🔍 BOTTOM SENTINEL triggered");
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseFloat(lastChunkEl.getAttribute("data-chunk-id"), 10);
          console.log(`🚨 OBSERVER: Bottom sentinel triggered, loading next chunk after ${lastChunkId}`);
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
      
      // 🔄 NEW: Add cooldown period for scroll position saving after navigation
      instance.scrollSaveCooldown = true;
      setTimeout(() => {
        instance.scrollSaveCooldown = false;
        console.log(`🔄 Scroll position saving cooldown ended`);
      }, 1000); // 1 second cooldown
      
      // Simple unlock notification
      const currentScrollTop = instance.scrollableParent.scrollTop;
      console.log(`📍 Scroll position at unlock: ${currentScrollTop}px - user has full control`);
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
        console.log(`🎯 Found target chunk ${chunkToLoadId} for element ${targetElementId}`);
      }
    }

    // 7. Load the determined chunk
    if (chunkToLoadId !== null) {
      console.log(`🔄 Refresh loading initial chunk: ${chunkToLoadId}`);
      loadChunkInternal(chunkToLoadId, "down", instance, attachMarkers);
    }

    // 8. ✅ NEW: Set focus after a short delay to allow for rendering
    setTimeout(() => {
      let elementToFocus = targetElementId ? document.getElementById(targetElementId) : null;

      // Fallback if the target element isn't found
      if (!elementToFocus) {
        elementToFocus = instance.container.querySelector('p, h1, h2, h3, blockquote, pre');
        console.log("...target element not found, falling back to first block element.");
      }

      if (elementToFocus) {
        console.log(`✨ Setting focus to element:`, elementToFocus);
        elementToFocus.focus(); // Essential for contenteditable

        // Place the cursor at the end of the element
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(elementToFocus);
        range.collapse(false); // false means collapse to the end
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }, 100);
  };

  
  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
// Keep createChunkElement function signature unchanged
function createChunkElement(nodes, instance) {
  // <-- Correct, simple signature
  console.log("createChunkElement called with nodes:", nodes.length);
  if (!nodes || nodes.length === 0) {
    console.warn("No nodes provided to createChunkElement.");
    return null;
  }

  const chunkId = nodes[0].chunk_id;
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");

  nodes.forEach((node) => {
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
      chunkWrapper.appendChild(temp.firstChild);
    }
  });

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
      }
      
      try {
        const range = document.createRange();
        range.setStart(positions.startNode, positions.startOffset);
        range.setEnd(positions.endNode, positions.endOffset);
        range.surroundContents(underlineElement);
      } catch (error) {
        console.error("Error with surroundContents for hypercite:", error);
        wrapRangeWithElement(
          positions.startNode,
          positions.startOffset,
          positions.endNode,
          positions.endOffset,
          underlineElement
        );
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



// Update the applyHighlights function to accept bookId and use the cache
export function applyHighlights(html, highlights, bookId) {
  if (!highlights || highlights.length === 0) return html;

  // Get user's highlight IDs from cache (synchronous since cache is already built)
  const userHighlightIds = getUserHighlightCache(bookId);

  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;
  
  const segments = createHighlightSegments(highlights);
  
  // Keep reverse order but recalculate positions each time
  segments.sort((a, b) => b.charStart - a.charStart);

  for (const segment of segments) {
    console.log(`Applying segment from ${segment.charStart} to ${segment.charEnd}`, segment);
    
    // Recalculate positions based on current DOM state
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);
    
    if (positions) {
      const markElement = document.createElement("mark");
      
      // Always set data-highlight-count and intensity
      markElement.setAttribute("data-highlight-count", segment.highlightIDs.length);
      const intensity = Math.min(segment.highlightIDs.length / 5, 1); // Cap at 5 highlights
      markElement.style.setProperty('--highlight-intensity', intensity);
      
      // Check if any highlight in this segment belongs to current user
      const hasUserHighlight = segment.highlightIDs.some(id => userHighlightIds.has(id));
      
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
        console.log(`🎨 Added user-highlight class to segment with IDs: ${segment.highlightIDs.join(', ')}`);
      }
      
      // Use surroundContents instead of extractContents
      try {
        const range = document.createRange();
        range.setStart(positions.startNode, positions.startOffset);
        range.setEnd(positions.endNode, positions.endOffset);
        range.surroundContents(markElement);
      } catch (error) {
        console.error("Error with surroundContents, falling back:", error);
        wrapRangeWithElement(
          positions.startNode,
          positions.startOffset,
          positions.endNode,
          positions.endOffset,
          markElement
        );
      }
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
    const coveringHighlights = highlights.filter(highlight => 
      highlight.charStart <= segmentStart && highlight.charEnd >= segmentEnd
    );
    
    if (coveringHighlights.length > 0) {
      segments.push({
        charStart: segmentStart,
        charEnd: segmentEnd,
        highlightIDs: coveringHighlights.map(h => h.highlightID)
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
    
    // Instead of extractContents, surround the contents
    range.surroundContents(wrapElement);
  } catch (error) {
    console.error("Error wrapping range with element:", error);
    // Fallback to original method if surroundContents fails
    try {
      const contents = range.extractContents();
      wrapElement.appendChild(contents);
      range.insertNode(wrapElement);
    } catch (fallbackError) {
      console.error("Fallback wrapping also failed:", fallbackError);
    }
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
      console.log(`Next chunk ${nextChunkId} already loaded.`);
      return;
    }
    
    nextNodes = instance.nodeChunks.filter(node => parseFloat(node.chunk_id) === nextChunkId);
    
    if (nextNodes.length === 0) {
      console.warn(`No data found for chunk ${nextChunkId}.`);
      return;
    }
    
    console.log(`Loading next chunk: ${nextChunkId}`);
    
    // 🚨 SET LOADING STATE BEFORE DOM CHANGES
    setChunkLoadingInProgress(nextChunkId);
    scheduleAutoClear(nextChunkId, 1000); // Auto-clear after 1 second
    
    const container = instance.container;
    const chunkElement = createChunkElement(nextNodes, instance, instance.config?.onFirstChunkLoaded);
    container.appendChild(chunkElement);
    instance.currentlyLoadedChunks.add(nextChunkId);
    
    if (instance.bottomSentinel) {
      instance.bottomSentinel.remove();
      container.appendChild(instance.bottomSentinel);
    }
    
    attachUnderlineClickListeners();
    
    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    // Use a small delay to ensure all mutations are processed
    setTimeout(() => {
      clearChunkLoadingInProgress(nextChunkId);
    }, 100);
    
  } else {
    console.log("No next chunk available.");
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
      console.log(`Previous chunk ${prevChunkId} already loaded.`);
      return;
    }
    
    prevNodes = instance.nodeChunks.filter(node => parseFloat(node.chunk_id) === prevChunkId);
    
    if (prevNodes.length === 0) {
      console.warn(`No data found for chunk ${prevChunkId}.`);
      return;
    }
    
    console.log(`Loading previous chunk: ${prevChunkId}`);
    
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
    
    attachUnderlineClickListeners();
    
    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    setTimeout(() => {
      clearChunkLoadingInProgress(prevChunkId);
    }, 100);
    
  } else {
    console.log("No previous chunk available.");
  }
}

function loadChunkInternal(chunkId, direction, instance, attachMarkers) {
  console.log(`Loading chunk ${chunkId} in direction: ${direction}`);

  if (instance.currentlyLoadedChunks.has(chunkId)) {
    console.log(`Chunk ${chunkId} already loaded; skipping.`);
    return;
  }

  const nextNodes = instance.nodeChunks.filter(
    (node) => node.chunk_id === chunkId
  );

  if (!nextNodes || nextNodes.length === 0) {
    console.warn(`No data found for chunk ${chunkId}.`);
    return;
  }

  setChunkLoadingInProgress(chunkId);
  scheduleAutoClear(chunkId, 1000);

  // createChunkElement is called with its simple, correct signature.
  const element = createChunkElement(nextNodes, instance);

  if (direction === "up") {
    instance.container.insertBefore(element, instance.container.firstChild);
  } else {
    instance.container.appendChild(element);
  }

  instance.currentlyLoadedChunks.add(chunkId);
  attachMarkers(instance.container);

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

  attachUnderlineClickListeners();

  setTimeout(() => {
    clearChunkLoadingInProgress(chunkId);
  }, 100);

  console.log(`Chunk ${chunkId} loaded.`);
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
  console.log(`Inserted chunk ${newChunkId} in order.`);
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
