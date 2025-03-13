import { renderBlockToHtml } from "./convert-markdown.js";
import { attachMarkListeners } from "./hyper-lights-cites.js";
import { injectFootnotesForChunk } from "./footnotes.js";
// Import caching functions from your cache-indexedDB module
import {
  saveNodeChunksToIndexedDB,
  getNodeChunksFromIndexedDB,
  saveFootnotesToIndexedDB,
  getFootnotesFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";



/**
 * Factory function for lazy loading.
 *
 * Creates a lazy loader instance for a given container and JSON data (nodeChunks).
 * No global state is used; all state is tracked on the instance. This allows for having
 * multiple containers (each with its own JSON file) on the same page.
 *
 * @param {Object} config
 * @param {HTMLElement} config.container - The scroll container.
 * @param {Array} config.nodeChunks - The data for the chunks.
 * @param {Function} config.loadNextChunk - Function to load the next chunk.
 *          It receives (currentLastChunkId, instance) as arguments.
 * @param {Function} config.loadPreviousChunk - Function to load the previous chunk.
 *          It receives (currentFirstChunkId, instance) as arguments.
 * @param {Function} config.attachMarkListeners - Function to reattach marker listeners.
 *          Should accept the container element.
 * @param {boolean} [config.isRestoringFromCache=false] - Optional flag.
 * @param {boolean} [config.isNavigatingToInternalId=false] - Optional flag.
 * @param {boolean} [config.isUpdatingJsonContent=false] - Optional flag.
 * @param {string} [config.bookId='latest'] - Identifier for the {book}/citation.
 *
 * @returns {Object|null} A lazy loader instance.
 */


// A simple throttle helper so we don’t fire scroll events too often.
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

export function createLazyLoader(config) {
  // Destructure config and add bookId to the configuration.
  const {
    container,
    nodeChunks,
    loadNextChunk,
    loadPreviousChunk,
    attachMarkListeners: attachMarkers,
    isRestoringFromCache = false,
    isNavigatingToInternalId = false,
    isUpdatingJsonContent = false,
    bookId = "latest", // <-- New property for book ID
  } = config;

  if (!container) {
    console.error("Container not provided.");
    return null;
  }
  if (!nodeChunks || nodeChunks.length === 0) {
    console.error("nodeChunks is empty. Aborting lazy loader.");
    return null;
  }

  // Create an instance object to hold all state.
  const instance = {
    container,
    nodeChunks,
    currentlyLoadedChunks: new Set(),
    observer: null,
    topSentinel: null,
    bottomSentinel: null,
    isRestoringFromCache,
    isNavigatingToInternalId,
    isUpdatingJsonContent,
    bookId, // store the book id on the instance
  };

  if (instance.isRestoringFromCache) {
    console.log("Skipping lazy loading due to cache restoration.");
    attachMarkers(container);
    return instance;
  }

  // Remove any existing sentinels in this container.
  container.querySelectorAll(".sentinel").forEach((sentinel) => {
    console.log("Removing sentinel with id:", sentinel.id);
    sentinel.remove();
  });
  console.log("Removed existing sentinels.");

  // Create a unique ID based on the container (or generate one)
  const uniqueId = container.id
    ? container.id
    : Math.random().toString(36).substr(2, 5);
  console.log("Unique ID for sentinels:", uniqueId);

  // Save the container id as part of the instance (for the composite key)
  instance.containerId = uniqueId;

  // Now, add factory-wrapped caching methods.
  // These methods automatically pass the containerId & bookId
  instance.saveNodeChunks = (chunks) => {
    return saveNodeChunksToIndexedDB(chunks, instance.containerId, instance.bookId);
  };

  instance.getNodeChunks = () => {
    return getNodeChunksFromIndexedDB(instance.containerId, instance.bookId);
  };

  instance.saveFootnotes = (footnotesData) => {
    return saveFootnotesToIndexedDB(footnotesData, instance.containerId, instance.bookId);
  };

  instance.getFootnotes = () => {
    return getFootnotesFromIndexedDB(instance.containerId, instance.bookId);
  };


    // --- SCROLL POSITION SAVING LOGIC ---
  // Add a function that finds the topmost visible data-chunk element,
  // then saves its id using a composite key (using containerId and bookId).
  instance.saveScrollPosition = () => {
    
    // Find all chunk elements
    const chunkElements = Array.from(container.querySelectorAll("[data-block-id]"));
    if (chunkElements.length === 0) return;

    // Find the element whose bounding rect is closest to the container's top.
    const topVisible = chunkElements.find((el) => {
      const rect = el.getBoundingClientRect();
      // Adjust the threshold as needed
      return rect.top >= 0;
    });

    if (topVisible) {
      const scrollId = topVisible.getAttribute("data-block-id");
      // Build a composite key for scroll position
      const storageKey = getLocalStorageKey("lastVisibleElement", instance.containerId, instance.bookId);
      sessionStorage.setItem(storageKey, scrollId);
      localStorage.setItem(storageKey, scrollId);
      console.log("📜 Saved scroll position:", scrollId, "under key:", storageKey);
    }
  };

  // Attach a throttled scroll listener to save the scroll position.
  container.addEventListener("scroll", throttle(instance.saveScrollPosition, 200));
  // --- END SCROLL POSITION LOGIC ---
// NEW: Restore scroll position on window resize.
  // This function retrieves the last saved scroll position
  // (using the composite storage key) and attempts to locate the
  // element with the matching data-block-id in the container.
  // If found, it scrolls that element into view.
  instance.restoreScrollPosition = () => {
    const storageKey = getLocalStorageKey(
      "lastVisibleElement",
      instance.containerId,
      instance.bookId
    );
    const savedScrollId =
      sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (!savedScrollId) {
      console.warn("No saved scroll position found for storageKey:", storageKey);
      return;
    }
    // Find the target element with the data-block-id attribute.
    const targetElement = container.querySelector(
      `[data-block-id="${savedScrollId}"]`
    );
    if (targetElement) {
      console.log("Restoring scroll position to:", savedScrollId);
      targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      console.warn(
        "Element with data-block-id not found. It may not be loaded yet:",
        savedScrollId
      );
    }
  };

  // Attach the window resize event listener to restore scroll position
  window.addEventListener("resize", throttle(instance.restoreScrollPosition, 200));
  // *********************************************


  // Create top and bottom sentinel elements.
  const topSentinel = document.createElement("div");
  topSentinel.id = `${uniqueId}-top-sentinel`;
  topSentinel.classList.add("sentinel");
  console.log("Created top sentinel with id:", topSentinel.id);

  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.classList.add("sentinel");
  console.log("Created bottom sentinel with id:", bottomSentinel.id);

  // Insert the sentinels into the container.
  container.prepend(topSentinel);
  container.appendChild(bottomSentinel);
  console.log("Inserted new sentinels into container.");

  // Attach marker listeners after adding sentinels.
  attachMarkers(container);

  // Set up IntersectionObserver options.
  const observerOptions = {
    root: container,
    rootMargin: "150px",
    threshold: 0,
  };

  // Helper function to get the last chunk element within the container.
  function getLastChunkElement() {
    const chunks = container.querySelectorAll("[data-chunk-id]");
    console.log("Inside getLastChunkElement: found", chunks.length, "chunk elements.");
    return chunks.length ? chunks[chunks.length - 1] : null;
  }

  // Create the IntersectionObserver.
  const observer = new IntersectionObserver((entries) => {
    console.log("Intersection Observer triggered with", entries.length, "entries.");
    entries.forEach((entry) => {
      console.log(
        "Observer entry: target id =",
        entry.target.id,
        ", isIntersecting =",
        entry.isIntersecting
      );
      if (!entry.isIntersecting) return;

      // Top sentinel branch:
      if (entry.target.id === topSentinel.id) {
        const firstChunkEl = container.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseInt(firstChunkEl.getAttribute("data-chunk-id"), 10);
          if (firstChunkId > 0 && !instance.currentlyLoadedChunks.has(firstChunkId - 1)) {
            console.log(`Top sentinel triggered; loading previous chunk ${firstChunkId - 1}`);
            loadPreviousChunk
              ? loadPreviousChunk(firstChunkId, instance)
              : console.warn("loadPreviousChunk function not provided.");
          } else {
            console.log("Top sentinel condition not met (either firstChunkId is 0 or previous chunk already loaded).");
          }
        }
      }

      // Bottom sentinel branch:
      if (entry.target.id === bottomSentinel.id) {
        const chunks = container.querySelectorAll("[data-chunk-id]");
        console.log("Found", chunks.length, "chunk elements in container.");
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseInt(lastChunkEl.getAttribute("data-chunk-id"), 10);
          console.log(`Bottom sentinel triggered, last chunk ID: ${lastChunkId}`);
          loadNextChunk
            ? loadNextChunk(lastChunkId, instance)
            : console.warn("loadNextChunk function not provided.");
        } else {
          console.warn("No last chunk element found.");
        }
      }
    });
  }, observerOptions);

  // Start observing both sentinels.
  observer.observe(topSentinel);
  observer.observe(bottomSentinel);
  console.log("Observer attached to top sentinel:", topSentinel.id);
  console.log("Observer attached to bottom sentinel:", bottomSentinel.id);

  attachMarkers(container);

  // Save the observer and sentinel elements on the instance.
  instance.observer = observer;
  instance.topSentinel = topSentinel;
  instance.bottomSentinel = bottomSentinel;

  console.log("Lazy loader initialized with options:", observerOptions);

  // Public methods for this instance.
  instance.disconnect = () => {
    observer.disconnect();
    console.log("Lazy loader observer disconnected for container:", container);
  };

  instance.repositionSentinels = () =>
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);

  instance.loadChunk = (chunkId, direction = "down") =>
    loadChunkInternal(chunkId, direction, instance, attachMarkers);

  // Return the instance so that each container has its own state.
  return instance;
}

/**
 * Helper: Creates a chunk element given chunk data.
 */
function createChunkElement(chunk) {
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunk.chunk_id);
  chunkWrapper.classList.add("chunk");

  console.log("Created chunk element with id:", chunkWrapper.getAttribute("data-chunk-id"));

  chunk.blocks.forEach((block) => {
    const html = renderBlockToHtml(block);
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;
    chunkWrapper.appendChild(tempDiv);
  });
  return chunkWrapper;
}

/**
 * Loads the previous chunk into the instance’s container and repositions
 * the top sentinel.
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

  const prevChunk = instance.nodeChunks.find(
    (chunk) => chunk.chunk_id === previousChunkId
  );
  if (!prevChunk) {
    console.warn(`No data found for chunk ${previousChunkId}.`);
    return;
  }

  console.log(`Loading previous chunk: ${previousChunkId}`);
  const container = instance.container;
  const prevScrollTop = container.scrollTop;
  const chunkWrapper = createChunkElement(prevChunk);
  container.insertBefore(chunkWrapper, container.firstElementChild);
  instance.currentlyLoadedChunks.add(previousChunkId);
  const newChunkHeight = chunkWrapper.getBoundingClientRect().height;
  container.scrollTop = prevScrollTop + newChunkHeight;

  if (instance.topSentinel) {
    instance.topSentinel.remove();
    container.prepend(instance.topSentinel);
  }
  
  // Inject footnotes for the newly loaded chunk.
  injectFootnotesForChunk(previousChunkId);
}


/**
 * Loads the next chunk into the instance’s container and repositions
 * the bottom sentinel.
 */
export function loadNextChunkFixed(currentLastChunkId, instance) {
  const nextChunkId = currentLastChunkId + 1;
  if (
    instance.container.querySelector(`[data-chunk-id="${nextChunkId}"]`)
  ) {
    console.log(`Next chunk ${nextChunkId} already loaded.`);
    return;
  }

  const nextChunk = instance.nodeChunks.find(
    (chunk) => chunk.chunk_id === nextChunkId
  );
  if (!nextChunk) {
    console.warn(`No data found for chunk ${nextChunkId}.`);
    return;
  }

  console.log(`Loading next chunk: ${nextChunkId}`);
  const container = instance.container;
  const chunkWrapper = createChunkElement(nextChunk);
  container.appendChild(chunkWrapper);
  instance.currentlyLoadedChunks.add(nextChunkId);

  if (instance.bottomSentinel) {
    instance.bottomSentinel.remove();
    container.appendChild(instance.bottomSentinel);
  }
  
  // Inject footnotes for the newly loaded chunk.
  injectFootnotesForChunk(nextChunkId);
}


/**
 * Loads a chunk (either up or down) into the instance.
 */
function loadChunkInternal(chunkId, direction, instance, attachMarkers) {
  console.log(`Loading chunk ${chunkId}, direction: ${direction}`);

  if (instance.currentlyLoadedChunks.has(chunkId)) {
    console.log(`Chunk ${chunkId} is already loaded. Skipping.`);
    return;
  }

  const chunk = instance.nodeChunks.find((c) => c.chunk_id === chunkId);
  if (!chunk) {
    console.error(`Chunk ${chunkId} not found!`);
    if (chunkId === 0) {
      instance.container.innerHTML =
        "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  const chunkWrapper = createChunkElement(chunk);
  if (direction === "up") {
    instance.container.insertBefore(chunkWrapper, instance.container.firstChild);
  } else {
    instance.container.appendChild(chunkWrapper);
  }

  instance.currentlyLoadedChunks.add(chunkId);
  attachMarkers(instance.container);

  // If this is the first chunk, reposition sentinels.
  if (chunkId === 0) {
    repositionFixedSentinelsForBlockInternal(instance, attachMarkers);
  }

  injectFootnotesForChunk(chunkId);
  console.log(`Chunk ${chunkId} loaded successfully.`);
}

/**
 * Repositions the sentinels so that they wrap exactly the new contiguous block
 * of chunks inside the instance’s container.
 */
function repositionFixedSentinelsForBlockInternal(instance, attachMarkers) {
  console.log("💅repositionFixedSentinelsForBlockInternal is called");
  const container = instance.container;
  const allChunks = Array.from(container.querySelectorAll("[data-chunk-id]"));
  if (allChunks.length === 0) {
    console.warn("No chunks available to reposition sentinels.");
    return;
  }

  // Sort the chunks to ensure proper ordering.
  allChunks.sort(
    (a, b) =>
      parseInt(a.getAttribute("data-chunk-id"), 10) -
      parseInt(b.getAttribute("data-chunk-id"), 10)
  );

  if (instance.observer) {
    instance.observer.disconnect();
  }

  if (instance.topSentinel) instance.topSentinel.remove();
  if (instance.bottomSentinel) instance.bottomSentinel.remove();

  const uniqueId = container.id
    ? container.id
    : Math.random().toString(36).substr(2, 5);
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
    console.log("Sentinels repositioned and observation restarted.");
  }

  instance.currentlyLoadedChunks = new Set(
    allChunks.map((chunk) =>
      parseInt(chunk.getAttribute("data-chunk-id"), 10)
    )
  );
}

/**
 * Inserts a chunk into its container in the correct order.
 */
function insertChunkInOrderInternal(newChunk, instance) {
  const container = instance.container;
  const existingChunks = Array.from(container.querySelectorAll("[data-chunk-id]"));
  let inserted = false;
  const newChunkId = parseInt(newChunk.getAttribute("data-chunk-id"), 10);

  for (let i = 0; i < existingChunks.length; i++) {
    const existingChunkId = parseInt(
      existingChunks[i].getAttribute("data-chunk-id"),
      10
    );
    if (newChunkId < existingChunkId) {
      container.insertBefore(newChunk, existingChunks[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    container.appendChild(newChunk);
  }
  console.log(`Inserted chunk ${newChunkId} in order.`);
}

/**
 * Utility to get the last chunk id from the instance.
 */
export function getLastChunkId(instance) {
  const chunks = instance.container.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return parseInt(chunks[chunks.length - 1].getAttribute("data-chunk-id"), 10);
}


export { repositionFixedSentinelsForBlockInternal as repositionSentinels };

