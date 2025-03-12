import { mainContentDiv, book } from './reader-DOMContentLoaded.js';
import { getNodeChunksFromIndexedDB, getLocalStorageKey } from './cache-indexedDB.js';
import { parseMarkdownIntoChunks } from './convert-markdown.js';
import { injectFootnotesForChunk } from './footnotes.js';
import { currentLazyLoader } from './initializePage.js';


// ========= Scrolling Helper Functions =========

function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  const container = document.getElementById("main-content");
  if (!container) {
    console.error('Container with id "main-content" not found!');
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Container current scrollTop:", container.scrollTop);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
}

function lockScrollToTarget(targetElement, headerOffset = 50, attempts = 3) {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) clearInterval(interval);
  }, 300);
}

export function isValidContentElement(el) {
  // Exclude sentinels & non-content elements:
  if (!el.id || el.id.includes("sentinel") || el.id.startsWith("toc-") || el.id === "ref-overlay") {
    console.log(`Skipping non-tracked element: ${el.id}`);
    return false;
  }
  return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(el.tagName);
}


export async function restoreScrollPosition() {
  if (!currentLazyLoader) {
    console.error("Lazy loader instance not available!");
    return;
  }
  console.log("📌 Attempting to restore scroll position for container:", currentLazyLoader.container.id);

  // Determine navigation type.
  const navEntry = performance.getEntriesByType("navigation")[0] || {};
  const navType = navEntry.type || "navigate";
  // Only show a bookmark marker if the user arrived via a reload or back/forward.
  const shouldInsertMarker = (navType === "reload" || navType === "back_forward");

  const hash = window.location.hash.substring(1);
  let targetId = hash;
  const scrollKey = getLocalStorageKey("lastVisibleElement", currentLazyLoader.containerId, currentLazyLoader.bookId);

  try {
    if (sessionStorage) {
      const sessionSavedId = sessionStorage.getItem(scrollKey);
      if (!targetId && sessionSavedId) targetId = sessionSavedId;
    }
  } catch (e) {
    console.log("⚠️ sessionStorage not available", e);
  }
  try {
    if (localStorage) {
      const localSavedId = localStorage.getItem(scrollKey);
      if (!targetId && localSavedId) targetId = localSavedId;
    }
  } catch (e) {
    console.log("⚠️ localStorage not available", e);
  }

  if (!targetId) {
    console.log("🟢 No saved position found. Loading first chunk...");
    let cachedNodeChunks = await getNodeChunksFromIndexedDB(currentLazyLoader.containerId, currentLazyLoader.bookId);
    if (cachedNodeChunks && cachedNodeChunks.length > 0) {
      console.log("✅ Found nodeChunks in IndexedDB. Loading first chunk...");
      currentLazyLoader.nodeChunks = cachedNodeChunks;
      currentLazyLoader.container.innerHTML = "";
      currentLazyLoader.loadChunk(0, "down");
      return;
    }
    console.log("⚠️ No cached chunks found. Fetching from main-text.md...");
    try {
      const response = await fetch(`/markdown/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodeChunks = parseMarkdownIntoChunks(markdown);
      currentLazyLoader.loadChunk(0, "down");
    } catch (error) {
      console.error("❌ Error loading main-text.md:", error);
      currentLazyLoader.container.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  console.log(`🎯 Found target position: ${targetId}. Navigating...`);
  console.log("Lazy loader container:", currentLazyLoader.container);
  if (!currentLazyLoader.container || !currentLazyLoader.container.querySelector) {
    console.error("Invalid container in currentLazyLoader!");
    return;
  }
  // Pass the flag to navigateToInternalId
  navigateToInternalId(targetId, currentLazyLoader, shouldInsertMarker);
}

function scrollElementIntoContainer(targetElement, container, headerOffset = 0) {
  if (!container) {
    console.error("Container not available, falling back to default scrollIntoView");
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Scrolling container:", container.id);
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
}


export function navigateToInternalId(targetId, lazyLoader, showBookmark = false) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return;
  }
  console.log("LAZZZZY!!!!!")
  _navigateToInternalId(targetId, lazyLoader, showBookmark);
}


// This helper function receives the lazy loader instance as a parameter.
function _navigateToInternalId(targetId, lazyLoader, showBookmark) {
   if (!lazyLoader.container || 
      typeof lazyLoader.container.querySelector !== "function") {
    console.error("Invalid lazyLoader.container:", lazyLoader.container);
    lazyLoader.isNavigatingToInternalId = false;
    return;
  }
  if (lazyLoader.isNavigatingToInternalId) {
    console.log("Navigation already in progress, skipping duplicate call.");
    return;
  }
  lazyLoader.isNavigatingToInternalId = true;
  console.log(`🟢 Navigating to internal ID: ${targetId}`);

  if (!lazyLoader.currentlyLoadedChunks) {
    lazyLoader.currentlyLoadedChunks = new Set();
  }

  let existingElement = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
  if (existingElement) {
    scrollElementIntoContainer(existingElement, lazyLoader.container, 50);
    setTimeout(() => {
      scrollElementIntoContainer(existingElement, lazyLoader.container, 50);
      lazyLoader.isNavigatingToInternalId = false;
    }, 600);
    return;
  }

  let targetChunkIndex;
  // Numeric IDs: you compare against block.startLine (or however your JSON is structured)
  if (/^\d+$/.test(targetId)) {
    targetChunkIndex = lazyLoader.nodeChunks.findIndex(chunk =>
      chunk.blocks.some(block => block.startLine.toString() === targetId)
    );
  } else {
    const targetLine = findLineForCustomId(targetId, lazyLoader.nodeChunks);
    if (targetLine === null) {
      console.warn(`❌ No block found for target ID "${targetId}"`);
      lazyLoader.isNavigatingToInternalId = false;
      return;
    }
    targetChunkIndex = lazyLoader.nodeChunks.findIndex(chunk =>
      targetLine >= chunk.start_line && targetLine <= chunk.end_line
    );
  }

  if (targetChunkIndex === -1) {
    console.warn(`❌ No chunk found for target ID "${targetId}"`);
    lazyLoader.isNavigatingToInternalId = false;
    return;
  }

  // Clear previously loaded chunks if needed.
  lazyLoader.container.innerHTML = '';
  lazyLoader.currentlyLoadedChunks.clear();

  const startIndex = Math.max(0, targetChunkIndex - 1);
  const endIndex = Math.min(lazyLoader.nodeChunks.length - 1, targetChunkIndex + 1);
  console.log(`Loading chunks ${startIndex} to ${endIndex}`);

  const loadedChunkIds = [];
  const loadChunksPromise = Promise.all(
    Array.from({ length: endIndex - startIndex + 1 }, (_, i) => {
      const chunkId = lazyLoader.nodeChunks[startIndex + i].chunk_id;
      return new Promise(resolve => {
        lazyLoader.loadChunk(chunkId, "down");
        loadedChunkIds.push(chunkId);
        resolve();
      });
    })
  );

  loadChunksPromise.then(() => {
    console.log("All chunks loaded, injecting footnotes...");
    loadedChunkIds.forEach(chunkId => {
      console.log(`Injecting footnotes for chunk ${chunkId}`);
      injectFootnotesForChunk(chunkId);
    });
    lazyLoader.repositionSentinels();

    setTimeout(() => {
      waitForElementAndScroll(targetId);
      setTimeout(() => {
        let finalTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
        if (finalTarget) {
          scrollElementIntoContainer(finalTarget, lazyLoader.container, 50);
        }
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
      }, 400);
    }, 800);
  });
}



// Utility: wait for an element and then scroll to it.
function waitForElementAndScroll(targetId, maxAttempts = 10, attempt = 0) {
  const targetElement = document.getElementById(targetId);
  if (targetElement) {
    console.log(`✅ Target ID "${targetId}" found! Scrolling...`);
    setTimeout(() => {
      scrollElementIntoMainContent(targetElement, 50);
    }, 150);
    return;
  }
  if (attempt >= maxAttempts) {
    console.warn(`❌ Gave up waiting for "${targetId}".`);
    return;
  }
  setTimeout(() => waitForElementAndScroll(targetId, maxAttempts, attempt + 1), 200);
}

// Utility: find the line for a custom id in raw markdown.
function findLineForCustomId(targetId, nodeChunks) {
  for (let chunk of nodeChunks) {
    for (let block of chunk.blocks) {
      const regex = new RegExp(`id=['"]${targetId}['"]`, "i");
      if (regex.test(block.content)) {
        return block.startLine;
      }
    }
  }
  return null;
}


