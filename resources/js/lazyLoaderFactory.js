import { renderBlockToHtml } from "./convert-markdown.js";
import { attachMarkListeners } from "./hyperLights.js";
import { injectFootnotesForChunk } from "./footnotes.js";
import {
  //saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  saveFootnotesToIndexedDB,
  getFootnotesFromIndexedDB,
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
    bookId = "latest"
  } = config;

  if (!nodeChunks || nodeChunks.length === 0) {
    console.error("nodeChunks is empty. Aborting lazy loader.");
    return null;
  }

  // Instead of passing a container separately, get it by the bookId.
  const container = document.getElementById(bookId);
  if (!container) {
    console.error(
      `Container element with id "${bookId}" not found in the DOM.`
    );
    return null;
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
    // Save the container element directly in the instance.
    container
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
  instance.saveFootnotes = (footnotesData) => {
    return saveFootnotesToIndexedDB(footnotesData, instance.bookId);
  };
  instance.getFootnotes = () => {
    return getFootnotesFromIndexedDB(instance.bookId);
  };

  // --- SCROLL POSITION SAVING LOGIC ---
instance.saveScrollPosition = () => {
  // Query for all elements having an id attribute.
  const elements = Array.from(container.querySelectorAll("[id]"));
  if (elements.length === 0) return;
  // Find the first element whose top is at or after the viewport top.
  const topVisible = elements.find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0;
  });
  if (topVisible) {
    // Use the element's id
    const detectedId = topVisible.id;
    // Modified regex to accept decimal numbers
    if (/^\d+(\.\d+)?$/.test(detectedId)) {
      const scrollData = {
        elementId: detectedId,
      };
      const storageKey = getLocalStorageKey(
        "scrollPosition",
        instance.bookId
      );
      const stringifiedData = JSON.stringify(scrollData);
      sessionStorage.setItem(storageKey, stringifiedData);
      localStorage.setItem(storageKey, stringifiedData);
      console.log("Saved scroll data:", scrollData);
    } else {
      console.log(
        `Element id "${detectedId}" is not numerical. Skip saving scroll data.`
      );
    }
  }
};

  document.dispatchEvent(new Event("pageReady"));
  
  container.addEventListener("scroll", throttle(instance.saveScrollPosition, 200));

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
    let targetElement = container.querySelector(`#${CSS.escape(scrollData.elementId)}`);
    if (targetElement) {
      console.log(
        "Restoring scroll position to already loaded element:",
        scrollData.elementId
      );
      targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
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
            attachMarkers
          );
          // Allow some time for the chunk to be rendered.
          setTimeout(() => {
            let newTarget = container.querySelector(
              `#${scrollData.elementId}`
            );
            if (newTarget) {
              console.log(
                "Restoring scroll position after loading chunk, element:",
                scrollData.elementId
              );
              newTarget.scrollIntoView({ behavior: "smooth", block: "start" });
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
    root: container,
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
    console.log("Observer triggered, entries:", entries.length);
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      if (entry.target.id === topSentinel.id) {
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseFloat(firstChunkEl.getAttribute("data-chunk-id"));
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            console.log(
              `Top sentinel triggered; loading previous chunk ${firstChunkId - 1}`
            );
            loadPreviousChunkFixed(firstChunkId, instance);
          } else {
            console.log("Top sentinel: either at first chunk or already loaded.");
          }
        }
      }
      if (entry.target.id === bottomSentinel.id) {
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseFloat(lastChunkEl.getAttribute("data-chunk-id"), 10);
          console.log(`Bottom sentinel triggered, last chunk ID: ${lastChunkId}`);
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


    instance.refresh = async () => {
    console.log("🔄 Lazy-loader refresh starting…");
    
    // 1) re-read the fresh nodeChunks from IndexedDB
    instance.nodeChunks = await instance.getNodeChunks();
    
    // 2) remove all rendered chunk-DIVs
    instance.container
      .querySelectorAll("[data-chunk-id]")
      .forEach(el => el.remove());
    
    // 3) reset our “which chunks are in the DOM” set
    instance.currentlyLoadedChunks.clear();
    
    // 4) ensure our sentinels are back in place
    //    (they should already be there, but just in case)
    if (!instance.container.contains(instance.topSentinel)) {
      instance.container.prepend(instance.topSentinel);
    }
    if (!instance.container.contains(instance.bottomSentinel)) {
      instance.container.appendChild(instance.bottomSentinel);
    }
    
    // 5) fire the observer again on your sentinels
    //    (usually they’re already being observed, but this
    //     guarantees one immediate push)
    instance.observer.observe(instance.topSentinel);
    instance.observer.observe(instance.bottomSentinel);

    // 6) load the very first chunk manually
    //    (you could choose the lowest chunk_id, or the chunk
    //     that contains the insertion point, etc.)
    const allIds = Array.from(new Set(
      instance.nodeChunks.map(n => parseFloat(n.chunk_id))
    )).sort((a,b)=>a-b);
    if (allIds.length) {
      const firstId = allIds[0];
      console.log("🔄 Refresh loading first chunk:", firstId);
      loadChunkInternal(firstId, "down", instance, attachMarkers);
    }
  };

  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
// Keep createChunkElement function signature unchanged
function createChunkElement(nodes, instance) { // Pass instance instead of bookId
  console.log("createChunkElement called with nodes:", nodes.length);
  if (!nodes || nodes.length === 0) {
    console.warn("No nodes provided to createChunkElement.");
    return null;
  }

  const chunkId = nodes[0].chunk_id;
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");
  console.log("Created chunk element, id:", chunkId);

  // Render each block in the chunk.
  nodes.forEach((node) => {
    let html = renderBlockToHtml(node);

    // Apply highlights - use instance.bookId
    if (node.hyperlights && node.hyperlights.length > 0) {
      console.log(
        `Node ${node.id || node.startLine} hyperlights:`,
        node.hyperlights
      );
      html = applyHighlights(html, node.hyperlights, instance.bookId); // Use instance.bookId
    }

    // Apply hypercites if available
    if (node.hypercites && node.hypercites.length > 0) {
      console.log(
        `Node ${node.id || node.startLine} hypercites:`,
        node.hypercites
      );
      html = applyHypercites(html, node.hypercites);
    }

    // Convert the modified HTML string back to a DOM node.
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
    console.log(`Hypercite ${h.hyperciteId}: relationshipStatus = "${h.relationshipStatus}"`);
  });
  
  const segments = createHyperciteSegments(hypercites);
  
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
    const chunkElement = createChunkElement(nextNodes, instance);
    container.appendChild(chunkElement);
    instance.currentlyLoadedChunks.add(nextChunkId);
    
    if (instance.bottomSentinel) {
      instance.bottomSentinel.remove();
      container.appendChild(instance.bottomSentinel);
    }
    
    attachUnderlineClickListeners();
    injectFootnotesForChunk(nextChunkId, instance.bookId);
    
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
    const prevScrollTop = container.scrollTop;
    const chunkElement = createChunkElement(prevNodes, instance);
    container.insertBefore(chunkElement, container.firstElementChild);
    instance.currentlyLoadedChunks.add(prevChunkId);
    const newHeight = chunkElement.getBoundingClientRect().height;
    container.scrollTop = prevScrollTop + newHeight;
    
    if (instance.topSentinel) {
      instance.topSentinel.remove();
      container.prepend(instance.topSentinel);
    }
    
    attachUnderlineClickListeners();
    injectFootnotesForChunk(prevChunkId, instance.bookId);
    
    // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
    setTimeout(() => {
      clearChunkLoadingInProgress(prevChunkId);
    }, 100);
    
  } else {
    console.log("No previous chunk available.");
  }
}

// Update loadChunkInternal similarly
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
  
  // 🚨 SET LOADING STATE BEFORE DOM CHANGES
  setChunkLoadingInProgress(chunkId);
  scheduleAutoClear(chunkId, 1000);
  
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
  
  attachUnderlineClickListeners();
  injectFootnotesForChunk(chunkId, instance.bookId);
  
  // 🚨 CLEAR LOADING STATE AFTER DOM CHANGES
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
