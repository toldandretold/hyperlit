import { book, mainContentDiv } from "./reader-DOMContentLoaded.js";

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "./lazyLoaderFactory.js";

import {
  fetchLatestUpdateInfo,
  handleTimestampComparison,
} from "./updateCheck.js";

import {
  openDatabase,
  DB_VERSION,
  checkIndexedDBSize,
  getNodeChunksFromIndexedDB,
  saveNodeChunksToIndexedDB,
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  clearIndexedDB,
} from "./cache-indexedDB.js";

import {
  attachMarkListeners,
  handleMarkClick,
  handleMarkHover,
  handleMarkHoverOut,
} from "./hyper-lights-cites.js";

import { parseMarkdownIntoChunks, renderBlockToHtml } from "./convert-markdown.js";

import { injectFootnotesForChunk, loadFootnotes } from "./footnotes.js";

// ---------------------------------------------------------------------
// 1. Helper Function: Conditional Cache Busting
// ---------------------------------------------------------------------
// This function appends a cache-buster only when forceReload is true.
function buildUrl(path, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

// ---------------------------------------------------------------------
// 2. Node Chunks & Lazy-Load Handling
// ---------------------------------------------------------------------
// We assume that a generated lazy-load JSON (nodeChunks.json)
// has a "timestamp" property. If it’s older than the main-text.md’s
// timestamp (stored in localStorage under "markdownLastModified"),
// it will be ignored.
async function fetchNodeChunksJson(forceReload = false) {
  try {
    console.log(
      "🔍 Checking if /markdown/" + book + "/nodeChunks.json is available..."
    );
    let chunksResponse = await fetch(
      buildUrl(`/markdown/${book}/nodeChunks.json`, forceReload)
    );
    if (chunksResponse.ok) {
      let nodeChunksData = await chunksResponse.json();
      const markdownTimestamp = localStorage.getItem("markdownLastModified");
      if (
        nodeChunksData.timestamp &&
        markdownTimestamp &&
        Number(nodeChunksData.timestamp) < Number(markdownTimestamp)
      ) {
        console.warn(
          "⚠️ Lazy-load JSON is outdated relative to main-text.md."
        );
        return null;
      }
      await saveNodeChunksToIndexedDB(nodeChunksData);
      return nodeChunksData;
    }
    console.warn("⚠️ nodeChunks.json not found or not accessible.");
    return null;
  } catch (e) {
    console.error("❌ Error fetching nodeChunks.json:", e);
    return null;
  }
}

// Fallback: Process main-text.md to generate the lazy-load data.
// This function saves the parsed chunks to IndexedDB.
async function parseMainTextMarkdown(forceReload = false) {
  console.log("🚦 Fallback: Fetching and parsing main-text.md locally...");
  const response = await fetch(
    buildUrl(`/markdown/${book}/main-text.md`, forceReload)
  );
  if (!response.ok) {
    throw new Error("Failed to fetch main-text.md");
  }
  const markdown = await response.text();
  // Save the markdown globally (needed when resolving internal links)
  window.markdownContent = markdown;
  const nodeChunks = parseMarkdownIntoChunks(markdown);
  await saveNodeChunksToIndexedDB(nodeChunks);
  return nodeChunks;
}

// ---------------------------------------------------------------------
// 3. Reloading Strategies
// ---------------------------------------------------------------------
// If there’s a mismatch in timestamps or no update info, we need to
// reload everything “raw” – from the main markdown file. This routine
// also triggers a backend update and sends generated data.
async function handleRawReload() {
  console.log("🔄 Performing raw reload from main-text.md...");
  try {
    // Use forced cache busting here.
    const response = await fetch(
      buildUrl(`/markdown/${book}/main-text.md`, true)
    );
    if (!response.ok) {
      throw new Error("Failed to fetch main-text.md");
    }
    const markdown = await response.text();
    window.markdownContent = markdown;
    console.log("📑 Generating nodeChunks from markdown...");
    const nodeChunks = parseMarkdownIntoChunks(markdown);
    console.log("📝 Triggering backend update...");
    try {
      const backendResponse = await fetch(`/update-markdown/${book}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            .content,
        },
      });
      if (!backendResponse.ok) {
        throw new Error(
          `Failed to trigger backend update: ${backendResponse.statusText}`
        );
      }
      const result = await backendResponse.json();
      if (result.success) {
        console.log("✅ Backend update successful:", result.message);
      } else {
        console.error("❌ Backend update failed:", result.message);
      }
    } catch (error) {
      console.error("❌ Error during backend update:", error);
    }
    await saveNodeChunksToIndexedDB(nodeChunks);
    window.nodeChunks = nodeChunks;
    // Force cache busting for footnotes as well.
    window.jsonPath = buildUrl(
      `/markdown/${book}/main-text-footnotes.json`,
      true
    );
    // Save or update footnotes.
    await loadFootnotes();
    const currentTimestamp = Date.now().toString();
    localStorage.setItem("markdownLastModified", currentTimestamp);
    window.savedChunks = {
      timestamp: currentTimestamp,
      chunks: [],
    };
    localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));
    console.log("✅ Raw reload complete. Files generated and cached.");
    // Capture footnotes and send data to backend.
    const footnotes = await loadFootnotes();
    await sendGeneratedDataToBackend(nodeChunks, footnotes);
    return true;
  } catch (error) {
    console.error("❌ Error during raw reload:", error);
    return false;
  }
}

// Full reload: we clear caches, update localStorage, and load either the
// lazy-load JSON (if it’s up-to-date) or else the main text.
async function handleFullReload(serverTimestamp) {
  localStorage.setItem("markdownLastModified", serverTimestamp);
  localStorage.removeItem("savedChunks");
  await clearIndexedDB();

  // Refresh footnotes (force reload)
  window.jsonPath = buildUrl(
    `/markdown/${book}/main-text-footnotes.json`,
    true
  );
  await loadFootnotes();

  // Try to fetch the pre-generated lazy-load JSON (force reload), and if
  // missing or out-of-date, parse main-text.md.
  window.nodeChunks =
    (await fetchNodeChunksJson(true)) || (await parseMainTextMarkdown(true));

  window.savedChunks = {
    timestamp: serverTimestamp,
    chunks: [],
  };
  localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));
}

// If timestamps match, load from IndexedDB.
async function handleCachedLoad() {
  console.log("✅ Timestamps match! Using IndexedDB cache...");
  let cachedNodeChunks = await getNodeChunksFromIndexedDB();
  if (cachedNodeChunks.length > 0) {
    console.log("✅ Using cached nodeChunks from IndexedDB.");
    window.nodeChunks = cachedNodeChunks;
  } else {
    console.log("⚠️ No valid nodeChunks found in IndexedDB. Must fetch Markdown.");
    window.nodeChunks = await parseMainTextMarkdown();
  }
  await loadFootnotes();
}

// Send generated data to the backend.
async function sendGeneratedDataToBackend(nodeChunks, footnotes) {
  try {
    const response = await fetch(`/api/${book}/generate-files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nodeChunks,
        footnotes,
        timestamp: Date.now(),
      }),
    });
    if (!response.ok) {
      throw new Error("Failed to send generated data to backend");
    }
    console.log("✅ Successfully sent generated data to backend");
  } catch (error) {
    console.error("❌ Error sending generated data to backend:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------
// 4. Lazy Loader Initialization & Background Update
// ---------------------------------------------------------------------
// Export a variable so that the lazy loader instance can be re-used.
export let currentLazyLoader = null;

export function initializeMainLazyLoader() {
  currentLazyLoader = createLazyLoader({
    container: mainContentDiv,
    nodeChunks: window.nodeChunks, // previously generated lazy-load data
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: "myMainBook", // Optional use of a specific book id
  });
  return currentLazyLoader;
}

// Check for updates quietly when the page becomes visible.
async function updateIfNecessary() {
  const updateInfo = await fetchLatestUpdateInfo(book);
  if (!updateInfo) {
    console.log("⚠️ No update info available.");
    return;
  }
  const serverTimestamp = updateInfo.updated_at.toString();
  const cachedTimestamp = localStorage.getItem("markdownLastModified") || "null";
  if (cachedTimestamp !== serverTimestamp) {
    console.log("❌ Timestamps differ — performing full reload in background.");
    await handleFullReload(serverTimestamp);
    initializeMainLazyLoader(); // Reinitialize lazy loader after updating
  } else {
    console.log("✅ Timestamps match — no update necessary.");
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    console.log("Page is visible. Checking for background updates...");
    updateIfNecessary();
  }
});

// ---------------------------------------------------------------------
// 5. Main Entry Point for Markdown Loading
// ---------------------------------------------------------------------
export async function loadMarkdownFile() {
  console.log("🚀 ENTERING loadMarkdownFile()...");

  let cachedServerTimestamp =
    localStorage.getItem("markdownLastModified") || "null";
  console.log(
    "📂 Cached Server Timestamp BEFORE request:",
    cachedServerTimestamp
  );

  try {
    const updateInfo = await fetchLatestUpdateInfo(book);
    if (!updateInfo) {
      console.log(
        "⚠️ No latest_update.json found. Initiating raw reload..."
      );
      const success = await handleRawReload();
      if (!success) {
        console.error("❌ Raw reload failed. Cannot proceed.");
        return;
      }
    } else {
      const serverTimestamp = updateInfo.updated_at.toString();
      console.log(
        "✅ Server reported Markdown last updated at:",
        serverTimestamp
      );
      const needsReload = await handleTimestampComparison(
        serverTimestamp,
        cachedServerTimestamp
      );
      if (needsReload) {
        console.log("❌ TIMESTAMPS DIFFER: Performing Full Reload...");
        await handleFullReload(serverTimestamp);
      } else {
        console.log("✅ Timestamps match! Using IndexedDB cache...");
        await handleCachedLoad();
      }
    }

    if (!window.nodeChunks || window.nodeChunks.length === 0) {
      console.error("❌ nodeChunks is empty. Aborting lazy loading.");
      return;
    }

    // Initialize the lazy loader for the first chunk, insert sentinels,
    // and start lazy loading based on scrolling.
    console.log("✅ Initializing lazy loader...");
    initializeMainLazyLoader();
  } catch (error) {
    console.error("❌ Error loading Markdown:", error);
  }
}

// ---------------------------------------------------------------------
// 6. Content Around a Specific Line or Element (Navigation)
// ---------------------------------------------------------------------
function loadContentAroundLine(lineNumber) {
  console.log(`🟢 Loading content around line: ${lineNumber}`);
  const targetChunk = window.nodeChunks.find(
    (chunk) => lineNumber >= chunk.start_line && lineNumber <= chunk.end_line
  );
  if (!targetChunk) {
    console.warn(`❌ No chunk found for line ${lineNumber}.`);
    return;
  }
  console.log(`✅ Line ${lineNumber} is in chunk ${targetChunk.chunk_id}.`);
  const chunksToLoad = new Set([targetChunk.chunk_id]);
  if (lineNumber - targetChunk.start_line < 5) {
    const prevChunkId = targetChunk.chunk_id - 1;
    if (prevChunkId >= 0) chunksToLoad.add(prevChunkId);
  }
  if (targetChunk.end_line - lineNumber < 5) {
    const nextChunkId = targetChunk.chunk_id + 1;
    if (nextChunkId < window.nodeChunks.length) chunksToLoad.add(nextChunkId);
  }
  const loadPromises = Array.from(chunksToLoad).map((chunkId) => {
    return new Promise((resolve) => {
      if (!window.currentlyLoadedChunks.has(chunkId)) {
        loadChunk(chunkId, chunkId < targetChunk.chunk_id ? "up" : "down");
      }
      resolve();
    });
  });
  Promise.all(loadPromises).then(() => {
    repositionFixedSentinelsForBlock();
    attachMarkListeners();
    setTimeout(() => {
      const targetElement = document.getElementById(lineNumber.toString());
      if (targetElement) {
        console.log(`✅ Scrolling to line: ${lineNumber}`);
        scrollElementIntoMainContent(targetElement, 50);
      } else {
        console.error(`❌ Line "${lineNumber}" not found after loading.`);
      }
    }, 100);
  });
}

function loadContentAroundId(targetId) {
  console.log(`🟢 Loading content around ID: ${targetId}`);
  const targetLine = findLineForId(window.markdownContent, targetId);
  if (targetLine === null) {
    console.warn(`❌ Target ID "${targetId}" not found in Markdown.`);
    return;
  }
  console.log(`✅ Found ID "${targetId}" at line ${targetLine}`);
  loadContentAroundLine(targetLine);
  setTimeout(() => {
    const newTargetElement = document.getElementById(targetId);
    if (newTargetElement) {
      console.log(`✅ Scrolling to target ID: ${targetId}`);
      newTargetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      console.error(`❌ ID "${targetId}" still not found after loading.`);
    }
  }, 200);
}
