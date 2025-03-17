import { renderBlockToHtml } from "./convert-markdown.js";
import { attachMarkListeners } from "./hyper-lights-cites.js";
import { injectFootnotesForChunk } from "./footnotes.js";
import {
  saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  saveFootnotesToIndexedDB,
  getFootnotesFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";

// --- A simple throttle helper to limit scroll firing
function throttle(fn, delay) {
  let timer = null;
  return function(...args) {
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
 */
export function createLazyLoader(config) {
  const {
    container,
    nodeChunks,
    loadNextChunk,
    loadPreviousChunk,
    attachMarkListeners: attachMarkers,
    isRestoringFromCache = false,
    isNavigatingToInternalId = false,
    isUpdatingJsonContent = false,
    bookId = "latest"
  } = config;

  if (!container) {
    console.error("Container not provided.");
    return null;
  }
  if (!nodeChunks || nodeChunks.length === 0) {
    console.error("nodeChunks is empty. Aborting lazy loader.");
    return null;
  }

  // Create the instance to track lazy-loader state.
  const instance = {
    container,
    nodeChunks, // Array of chunk objects
    currentlyLoadedChunks: new Set(),
    observer: null,
    topSentinel: null,
    bottomSentinel: null,
    isRestoringFromCache,
    isNavigatingToInternalId,
    isUpdatingJsonContent,
    bookId
  };

  if (instance.isRestoringFromCache) {
    console.log("Skipping lazy loading due to cache restoration.");
    attachMarkers(container);
    return instance;
  }

  // Remove any existing sentinels.
  container
    .querySelectorAll(".sentinel")
    .forEach(sentinel => sentinel.remove());
  console.log("Removed any existing sentinels.");

  // Use container's id or generate a random unique id.
  const uniqueId = container.id || Math.random().toString(36).substr(2, 5);
  instance.containerId = uniqueId;
  console.log("Unique ID for this container:", uniqueId);

  // Wrap caching methods so the instance passes containerId & bookId.
  instance.saveNodeChunks = chunks => {
    return saveNodeChunksToIndexedDB(
      chunks,
      instance.containerId,
      instance.bookId
    );
  };
  instance.getNodeChunks = () => {
    return getNodeChunksFromIndexedDB(instance.containerId, instance.bookId);
  };
  instance.saveFootnotes = footnotesData => {
    return saveFootnotesToIndexedDB(
      footnotesData,
      instance.containerId,
      instance.bookId
    );
  };
  instance.getFootnotes = () => {
    return getFootnotesFromIndexedDB(instance.containerId, instance.bookId);
  };

  // --- SCROLL POSITION SAVING LOGIC ---
  instance.saveScrollPosition = () => {
    const chunkElements = Array.from(
      container.querySelectorAll("[data-chunk-id]")
    );
    if (chunkElements.length === 0) return;
    const topVisible = chunkElements.find(el => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0;
    });
    if (topVisible) {
      const scrollId = topVisible.getAttribute("data-chunk-id");
      const storageKey = getLocalStorageKey(
        "lastVisibleElement",
        instance.containerId,
        instance.bookId
      );
      sessionStorage.setItem(storageKey, scrollId);
      localStorage.setItem(storageKey, scrollId);
      console.log("Saved scroll position:", scrollId);
    }
  };
  container.addEventListener(
    "scroll",
    throttle(instance.saveScrollPosition, 200)
  );

  instance.restoreScrollPosition = () => {
    const storageKey = getLocalStorageKey(
      "lastVisibleElement",
      instance.containerId,
      instance.bookId
    );
    const savedScrollId =
      sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (!savedScrollId) {
      console.warn("No saved scroll position found.");
      return;
    }
    const targetElement = container.querySelector(
      `[data-chunk-id="${savedScrollId}"]`
    );
    if (targetElement) {
      console.log("Restoring scroll position to chunk:", savedScrollId);
      targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      console.warn(
        "Element with saved scroll position not found:",
        savedScrollId
      );
    }
  };
  window.addEventListener(
    "resize",
    throttle(instance.restoreScrollPosition, 200)
  );
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
  const observer = new IntersectionObserver(entries => {
    console.log("Observer triggered, entries:", entries.length);
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      if (entry.target.id === topSentinel.id) {
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseInt(
            firstChunkEl.getAttribute("data-chunk-id"),
            10
          );
          if (
            firstChunkId > 0 &&
            !instance.currentlyLoadedChunks.has(firstChunkId - 1)
          ) {
            console.log(
              `Top sentinel triggered; loading previous chunk ${firstChunkId -
                1}`
            );
            loadPreviousChunkFixed(firstChunkId, instance);
          } else {
            console.log(
              "Top sentinel: either at first chunk or already loaded."
            );
          }
        }
      }
      if (entry.target.id === bottomSentinel.id) {
        const chunks = container.querySelectorAll("[data-chunk-id]");
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseInt(
            lastChunkEl.getAttribute("data-chunk-id"),
            10
          );
          console.log(
            `Bottom sentinel triggered, last chunk ID: ${lastChunkId}`
          );
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

  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
function createChunkElement(nodes) {
  if (!nodes || nodes.length === 0) {
    console.warn("No nodes provided to createChunkElement.");
    return null;
  }

  const chunkId = nodes[0].chunk_id; // All nodes should have the same chunk_id
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");
  console.log("Created chunk element, id:", chunkId);

  // Render each block in the chunk.
  nodes.forEach(node => {
    let html = renderBlockToHtml(node);

    // Apply highlights
    if (node.hyperlights && node.hyperlights.length > 0) {
      html = applyHighlights(html, node.hyperlights); //  Apply
      // mark tag for each highlight.
    }

    const temp = document.createElement("div");
    temp.innerHTML = html;
    chunkWrapper.appendChild(temp.firstChild);
  });

  return chunkWrapper;
}

/**
 * Utility: Apply highlight marks.
 */
function applyHighlights(html, highlights) {
  if (!highlights || highlights.length === 0) return html;
  
  // Sort highlights by charStart to ensure correct insertion order
  // For overlapping highlights, process the longer ones first to handle nesting properly
  highlights.sort((a, b) => {
    // If start positions are the same, process the longer highlight first
    if (a.charStart === b.charStart) {
      return (b.charEnd - b.charStart) - (a.charEnd - a.charStart);
    }
    // Otherwise sort by start position (in reverse since we process from end to start)
    return b.charStart - a.charStart;
  });

  // Create a temporary DOM element to work with
  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;

  // Process highlights in reverse order to avoid position shifts
  for (const { highlightID, charStart, charEnd } of highlights) {
    // Find the positions for the highlight
    const positions = findPositionsInDOM(tempElement, charStart, charEnd);
    
    if (positions) {
      // Create the mark element
      const markElement = document.createElement("mark");
      markElement.id = highlightID;
      markElement.className = highlightID;
      
      // Apply the highlight by wrapping the content with the mark element
      wrapRangeWithElement(positions.startNode, positions.startOffset, 
                          positions.endNode, positions.endOffset, markElement);
    }
  }

  return tempElement.innerHTML;
}

// Helper function to find the exact DOM positions for a character range
function findPositionsInDOM(rootElement, startChar, endChar) {
  const textNodes = getTextNodes(rootElement);
  let currentIndex = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;
  
  // Find start position
  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= startChar && currentIndex + nodeLength > startChar) {
      startNode = node;
      startOffset = startChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }
  
  // Reset for end position search
  currentIndex = 0;
  
  // Find end position
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

// Helper function to wrap a range of text with an element
function wrapRangeWithElement(startNode, startOffset, endNode, endOffset, wrapElement) {
  try {
    // Create a range
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    
    // Extract the contents and wrap them
    const contents = range.extractContents();
    wrapElement.appendChild(contents);
    
    // Insert the wrapped content
    range.insertNode(wrapElement);
  } catch (error) {
    console.error("Error wrapping range with element:", error);
  }
}


/**
 * Utility: Get Text Nodes
 */
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


/**
 * Loads the previous chunk into the container.
 */
export function loadPreviousChunkFixed(currentFirstChunkId, instance) {
  const previousChunkId = currentFirstChunkId - 1;
  if (previousChunkId < 0) {
    console.warn("No previous chunks to load.");
    return;
  }
  if (
    instance.container.querySelector(`[data-chunk-id="${previousChunkId}"]`)
  ) {
    console.log(`Previous chunk ${previousChunkId} already loaded.`);
    return;
  }

  const prevNodes = instance.nodeChunks.filter(
    (node, index) => node.chunk_id === previousChunkId
  );
  if (!prevNodes || prevNodes.length === 0) {
    console.warn(`No data found for chunk ${previousChunkId}.`);
    return;
  }
  console.log(`Loading previous chunk: ${previousChunkId}`);
  const container = instance.container;
  const prevScrollTop = container.scrollTop;

  const chunkElement = createChunkElement(prevNodes);
  container.insertBefore(chunkElement, container.firstElementChild);
  instance.currentlyLoadedChunks.add(previousChunkId);

  const newHeight = chunkElement.getBoundingClientRect().height;
  container.scrollTop = prevScrollTop + newHeight;

  // Reposition top sentinel.
  if (instance.topSentinel) {
    instance.topSentinel.remove();
    container.prepend(instance.topSentinel);
  }
  injectFootnotesForChunk(previousChunkId);
}

/**
 * Loads the next chunk into the container.
 */
export function loadNextChunkFixed(currentLastChunkId, instance) {
  const nextChunkId = currentLastChunkId + 1;
  if (instance.container.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
    console.log(`Next chunk ${nextChunkId} already loaded.`);
    return;
  }

  const nextNodes = instance.nodeChunks.filter(
    (node, index) => node.chunk_id === nextChunkId
  );
  if (!nextNodes || nextNodes.length === 0) {
    console.warn(`No data found for chunk ${nextChunkId}.`);
    return;
  }

  console.log(`Loading next chunk: ${nextChunkId}`);
  const container = instance.container;

  const chunkElement = createChunkElement(nextNodes);
  container.appendChild(chunkElement);
  instance.currentlyLoadedChunks.add(nextChunkId);

  if (instance.bottomSentinel) {
    instance.bottomSentinel.remove();
    container.appendChild(instance.bottomSentinel);
  }
  injectFootnotesForChunk(nextChunkId);
}

/**
 * Loads a chunk based on its chunk id, in a given direction.
 */
function loadChunkInternal(chunkId, direction, instance, attachMarkers) {
  console.log(`Loading chunk ${chunkId} in direction: ${direction}`);
  if (instance.currentlyLoadedChunks.has(chunkId)) {
    console.log(`Chunk ${chunkId} already loaded; skipping.`);
    return;
  }

  const nextNodes = instance.nodeChunks.filter(
    (node, index) => node.chunk_id === chunkId
  );
  if (!nextNodes || nextNodes.length === 0) {
    console.warn(`No data found for chunk ${chunkId}.`);
    return;
  }

  const element = createChunkElement(nextNodes);
  if (direction === "up") {
    instance.container.insertBefore(element, instance.container.firstChild);
  } else {
    instance.container.appendChild(element);
  }
  instance.currentlyLoadedChunks.add(chunkId);
  attachMarkers(instance.container);
  // If this is the very first chunk, reposition sentinels.
  if (chunkId === 0) {
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  }
  injectFootnotesForChunk(chunkId);
  console.log(`Chunk ${chunkId} loaded.`);
}

/**
 * Repositions the sentinels around the loaded chunks within the container.
 */
function repositionFixedSentinelsForBlockInternal(instance, attachMarkers) {
  console.log("Repositioning sentinels...");
  const container = instance.container;
  const allChunks = Array.from(
    container.querySelectorAll("[data-chunk-id]")
  );
  if (allChunks.length === 0) {
    console.warn("No chunks available to reposition sentinels.");
    return;
  }
  allChunks.sort((a, b) =>
    parseInt(a.getAttribute("data-chunk-id"), 10) -
    parseInt(b.getAttribute("data-chunk-id"), 10)
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
    allChunks.map(chunk => parseInt(chunk.getAttribute("data-chunk-id"), 10))
  );
}

/**
 * Inserts a chunk into the container in order.
 */
function insertChunkInOrderInternal(newChunk, instance) {
  const container = instance.container;
  const existingChunks = Array.from(
    container.querySelectorAll("[data-chunk-id]")
  );
  let inserted = false;
  const newChunkId = parseInt(newChunk.getAttribute("data-chunk-id"), 10);

  for (let i = 0; i < existingChunks.length; i++) {
    const existingId = parseInt(
      existingChunks[i].getAttribute("data-chunk-id"),
      10
    );
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
  return parseInt(
    chunks[chunks.length - 1].getAttribute("data-chunk-id"),
    10
  );
}

export { repositionFixedSentinelsForBlockInternal as repositionSentinels };
