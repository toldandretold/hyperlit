// In scrolling.js

import { book } from "./app.js";
import {
  getNodeChunksFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";
import { parseMarkdownIntoChunks } from "./convert-markdown.js";
import { injectFootnotesForChunk } from "./footnotes.js";
import { currentLazyLoader } from "./initializePage.js";
import { repositionSentinels } from "./lazyLoaderFactory.js"; // if exported

// ========= Scrolling Helper Functions =========

function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  const container = document.getElementById(book);
  if (!container) {
    console.error(`Container with id ${book} not found!`);
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
  if (
    !el.id ||
    el.id.includes("sentinel") ||
    el.id.startsWith("toc-") ||
    el.id === "ref-overlay"
  ) {
    console.log(`Skipping non-tracked element: ${el.id}`);
    return false;
  }
  return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(
    el.tagName
  );
}

export async function restoreScrollPosition() {
  console.log("restoring scroll position...");
  if (!currentLazyLoader) {
    console.error("Lazy loader instance not available!");
    return;
  }
  console.log(
    "📌 Attempting to restore scroll position for container:",
    currentLazyLoader.bookId
  );

  // Read saved target id from storage
  const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
  let targetId = window.location.hash.substring(1);
  
  try {
    const sessionSavedId = sessionStorage.getItem(scrollKey);
    if (sessionSavedId && sessionSavedId !== "0") {
      const parsed = JSON.parse(sessionSavedId);
      if (parsed && parsed.elementId) {
        targetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.log("⚠️ sessionStorage not available or parse error", e);
  }
  
  try {
    const localSavedId = localStorage.getItem(scrollKey);
    if (localSavedId && localSavedId !== "0") {
      const parsed = JSON.parse(localSavedId);
      if (parsed && parsed.elementId) {
        targetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.log("⚠️ localStorage not available or parse error", e);
  }

  if (!targetId) {
    // No saved scroll position: load first chunk.
    console.log("🟢 No saved position found. Loading first chunk...");
    let cachedNodeChunks = await getNodeChunksFromIndexedDB(
      currentLazyLoader.bookId
    );
    if (cachedNodeChunks && cachedNodeChunks.length > 0) {
      console.log("✅ Found nodeChunks in IndexedDB. Loading first chunk...");
      currentLazyLoader.nodeChunks = cachedNodeChunks;
      currentLazyLoader.container.innerHTML = "";
      currentLazyLoader.nodeChunks
        .filter(node => node.chunk_id === 0)
        .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
      return;
    }
    // Fallback: fetch markdown and parse.
    console.log("⚠️ No cached chunks found. Fetching from main-text.md...");
    try {
      const response = await fetch(`/markdown/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodeChunks = parseMarkdownIntoChunks(markdown);
      currentLazyLoader.nodeChunks
        .filter(node => node.chunk_id === 0)
        .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
    } catch (error) {
      console.error("❌ Error loading main-text.md:", error);
      currentLazyLoader.container.innerHTML =
        "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  console.log(`🎯 Found target position: ${targetId}. Navigating...`);

  // Delegate to the navigation function.
  navigateToInternalId(targetId, currentLazyLoader);
}


function scrollElementIntoContainer(targetElement, container, headerOffset = 0) {
  if (!container) {
    console.error(
      "Container not available, falling back to default scrollIntoView"
    );
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

export function navigateToInternalId(targetId, lazyLoader) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return;
  }
  console.log("Initiating navigation to internal ID:", targetId);
  _navigateToInternalId(targetId, lazyLoader);
}

function _navigateToInternalId(targetId, lazyLoader) {
  // Check if the target element is already present.
  let existingElement = lazyLoader.container.querySelector(
    `#${CSS.escape(targetId)}`
  );
  if (existingElement) {
    // Already available: scroll and highlight.
    scrollElementIntoContainer(existingElement, lazyLoader.container, 50);
    existingElement.classList.add("active");
    setTimeout(() => {
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
    }, 400);
    return;
  }

  // Otherwise, determine which chunk should contain the target.
  let targetChunkIndex = -1;
  if (/^\d+$/.test(targetId)) {
    // Compare targetId (which is startLine) to node.startLine.
    targetChunkIndex = lazyLoader.nodeChunks.findIndex(
      node => node.startLine.toString() === targetId
    );
  } else {
    // Use custom logic for non-numeric IDs.
    const targetLine = findLineForCustomId(targetId, lazyLoader.nodeChunks);
    if (targetLine === null) {
      console.warn(`No block found for target ID "${targetId}"`);
      lazyLoader.isNavigatingToInternalId = false;
      return;
    }
    targetChunkIndex = lazyLoader.nodeChunks.findIndex(
      node => targetLine === node.startLine
    );
  }

  if (targetChunkIndex === -1) {
    console.warn(`No chunk found for target ID "${targetId}"`);
    lazyLoader.isNavigatingToInternalId = false;
    return;
  }

  // Clear the container and load the chunk (plus adjacent chunks).
  lazyLoader.container.innerHTML = "";
  lazyLoader.currentlyLoadedChunks.clear();
  const startIndex = Math.max(0, targetChunkIndex - 1);
  const endIndex = Math.min(
    lazyLoader.nodeChunks.length - 1,
    targetChunkIndex + 1
  );
  console.log(`Loading chunks ${startIndex} to ${endIndex}`);

  const loadedChunksPromises = Array.from(
    { length: endIndex - startIndex + 1 },
    (_, i) => {
      const node = lazyLoader.nodeChunks[startIndex + i];
      return new Promise(resolve => {
        lazyLoader.loadChunk(node.chunk_id, "down");
        resolve();
      });
    }
  );

  Promise.all(loadedChunksPromises)
    .then(() => {
      // Optionally inject footnotes for each node.
      for (let i = startIndex; i <= endIndex; i++) {
        const node = lazyLoader.nodeChunks[i];
        injectFootnotesForChunk(node.chunk_id);
      }
      lazyLoader.repositionSentinels();
      // Delay a bit to let DOM updates settle.
      setTimeout(() => {
        let finalTarget = lazyLoader.container.querySelector(
          `#${CSS.escape(targetId)}`
        );
        if (finalTarget) {
          scrollElementIntoContainer(finalTarget, lazyLoader.container, 50);
          finalTarget.classList.add("active");
        } else {
          console.warn(
            `Target element ${targetId} not found after loading chunks.`
          );
        }
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
      }, 400);
    })
    .catch(error => {
      console.error("Error while loading chunks:", error);
      lazyLoader.isNavigatingToInternalId = false;
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
  setTimeout(
    () => waitForElementAndScroll(targetId, maxAttempts, attempt + 1),
    200
  );
}

// Utility: find the line for a custom id in raw markdown.
function findLineForCustomId(targetId, nodeChunks) {
  // for (let chunk of nodeChunks) {
  //   for (let block of chunk.blocks) {
  //     const regex = new RegExp(`id=['"]${targetId}['"]`, "i");
  //     if (regex.test(block.content)) {
  //       return block.startLine;
  //     }
  //   }
  // }
  //Update for Individual Nodes:
  for (let node of nodeChunks) {
    const regex = new RegExp(`id=['"]${targetId}['"]`, "i");
    if (regex.test(node.content)) {
      return node.startLine;
    }
  }
  return null;
}

