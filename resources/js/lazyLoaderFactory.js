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

  return instance;
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
function createChunkElement(nodes) {
  console.log("createChunkElement called with nodes:", nodes.length);
  if (!nodes || nodes.length === 0) {
    console.warn("No nodes provided to createChunkElement.");
    return null;
  }

  const chunkId = nodes[0].chunk_id; // Assuming all nodes share the same chunk_id.
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", chunkId);
  chunkWrapper.classList.add("chunk");
  console.log("Created chunk element, id:", chunkId);

  // Render each block in the chunk.
  nodes.forEach((node) => {
    let html = renderBlockToHtml(node);

    // Apply highlights (if available) exactly as before.
    if (node.hyperlights && node.hyperlights.length > 0) {
      console.log(
        `Node ${node.id || node.startLine} hyperlights:`,
        node.hyperlights
      );
      html = applyHighlights(html, node.hyperlights);
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
    // Append the first child (converted block) into the chunk wrapper.
    if (temp.firstChild) {
      chunkWrapper.appendChild(temp.firstChild);
    }
  });

  return chunkWrapper;
}

export function applyHypercites(html, hypercites) {
  if (!hypercites || hypercites.length === 0) return html;
  
  console.log("Applying hypercites:", hypercites);
  
  // Extract the text content without any HTML tags
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const plainText = tempDiv.textContent;
  
  console.log("Plain text content:", plainText);
  console.log("Plain text length:", plainText.length);
  
  // Create an array of markers for where we need to insert tags
  const markers = [];
  
  for (const hypercite of hypercites) {
    const id = hypercite.hyperciteId;
    const start = hypercite.charStart;
    const end = hypercite.charEnd;
    const status = hypercite.relationshipStatus || 'single';
    
    console.log(`Adding markers for hypercite ${id} from ${start} to ${end}`);
    
    // Verify the text being hypercited
    const hypercitedText = plainText.substring(start, end);
    console.log(`Text to be hypercited: "${hypercitedText}"`);
    
    // Add opening and closing markers
    markers.push({
      position: start,
      isOpening: true,
      id: id,
      status: status,
      priority: 1 // Opening tags have higher priority
    });
    
    markers.push({
      position: end,
      isOpening: false,
      id: id,
      status: status,
      priority: 0 // Closing tags have lower priority
    });
  }
  
  // Sort markers by position and priority
  // This ensures that at the same position, closing tags come before opening tags
  markers.sort((a, b) => {
    if (a.position === b.position) {
      return a.priority - b.priority;
    }
    return a.position - b.position;
  });
  
  console.log("Sorted markers:", markers);
  
  // Now rebuild the HTML by walking through the original HTML and inserting tags at marker positions
  let result = '';
  let textIndex = 0;
  let htmlIndex = 0;
  
  while (htmlIndex < html.length) {
    // Check if we're at a tag in the original HTML
    if (html[htmlIndex] === '<') {
      // Skip over the tag
      const tagEndIndex = html.indexOf('>', htmlIndex);
      if (tagEndIndex === -1) break; // Malformed HTML
      
      result += html.substring(htmlIndex, tagEndIndex + 1);
      htmlIndex = tagEndIndex + 1;
      
      // If this was a closing tag that affects text index, update textIndex
      const isClosingTag = html.substring(htmlIndex - 2, htmlIndex) === '/>';
      if (isClosingTag) {
        // We need to find what tag this was and adjust textIndex accordingly
        // This is complex and depends on your HTML structure
      }
      
      continue;
    }
    
    // Check if we're at a marker position in the text
    const currentMarkers = markers.filter(m => m.position === textIndex);
    
    for (const marker of currentMarkers) {
      if (marker.isOpening) {
        result += `<u id="${marker.id}" class="${marker.status}">`;
      } else {
        result += `</u>`;
      }
    }
    
    // Add the current character
    result += html[htmlIndex];
    htmlIndex++;
    textIndex++;
  }
  
  return result;
}




/**
 * Utility: Apply highlight marks.
 */
/**
 * Utility: Apply highlight marks.
 */
export function applyHighlights(html, highlights) {
  if (!highlights || highlights.length === 0) return html;

  // Debug the actual structure of the highlights data
  console.log("Highlight data structure:", JSON.stringify(highlights[0]));
  console.log("Applying highlights:", highlights);

  // Sort highlights so that longer ones or ones with the same start are processed first.
  highlights.sort((a, b) => {
    if (a.charStart === b.charStart) {
      return (b.charEnd - b.charStart) - (a.charEnd - a.charStart);
    }
    return b.charStart - a.charStart;
  });



  const tempElement = document.createElement("div");
  tempElement.innerHTML = html;
  
  // Debug the text content of the element
  console.log("Text content of element:", tempElement.textContent);
  console.log("Text content length:", tempElement.textContent.length);
  
  // Log character by character to see where counting might be off
  const textContent = tempElement.textContent;
  console.log("Character by character:");
  for (let i = 0; i < Math.min(textContent.length, 100); i++) { // Limit to first 100 chars
    console.log(`Position ${i}: "${textContent[i]}" (charCode: ${textContent.charCodeAt(i)})`);
  }

  for (const highlight of highlights) {
    // Make sure we have the correct property names
    const highlightID = highlight.highlightID;
    const charStart = highlight.charStart;
    const charEnd = highlight.charEnd;
    
    if (!highlightID || charStart === undefined || charEnd === undefined) {
      console.warn("Invalid highlight data:", highlight);
      continue;
    }

    console.log(`Applying highlight ${highlightID} from ${charStart} to ${charEnd}`);
    console.log(`Characters at these positions: "${textContent.substring(charStart, charEnd)}"`);
    
    const positions = findPositionsInDOM(tempElement, charStart, charEnd);
    
    // Debug the positions returned
    console.log("Positions found:", positions);
    
    if (positions) {
      const markElement = document.createElement("mark");
      markElement.id = highlightID;
      markElement.className = highlightID;
      wrapRangeWithElement(
        positions.startNode,
        positions.startOffset,
        positions.endNode,
        positions.endOffset,
        markElement
      );
    } else {
      console.warn(`Could not find positions for highlight ${highlightID}`);
    }
  }

  return tempElement.innerHTML;
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
    const contents = range.extractContents();
    wrapElement.appendChild(contents);
    range.insertNode(wrapElement);
  } catch (error) {
    console.error("Error wrapping range with element:", error);
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
    const chunkElement = createChunkElement(nextNodes);
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
    const chunkElement = createChunkElement(prevNodes);
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
  
  const element = createChunkElement(nextNodes);
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
