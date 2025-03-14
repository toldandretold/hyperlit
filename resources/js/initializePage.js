import {
    mainContentDiv,
    book,
    markdownContent
} from './app.js';

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

import { parseMarkdownIntoChunks /* and renderBlockToHtml if needed */ } from "./convert-markdown.js";
import { injectFootnotesForChunk, loadFootnotes } from "./footnotes.js";

//
// 1. Helper function: Cache buster remains unchanged (if used elsewhere)
//
function buildUrl(path, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

async function fetchMainTextMarkdown(forceReload = false) {
  // Use your buildUrl helper to append a cache buster if needed.
  const response = await fetch(buildUrl(`/markdown/${book}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error("Failed to fetch main-text.md");
  }
  return response.text();
}

//
// 2. Replace fetchNodeChunksJson – no longer needed
//    (We now generate nodeChunks from markdown using our new parser)
//

// ---------------------------------------------------------------------
// 3. Fallback: Process main-text.md to generate new nodeChunk records.
// ---------------------------------------------------------------------
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
  // Use the updated parser – which now returns a per-node data structure.
  const nodeChunks = parseMarkdownIntoChunks(markdown);
  console.log("Saving nodeChunks with containerId:", containerId, "and bookId:", bookId);
  await saveNodeChunksToIndexedDB(nodeChunks, containerId, bookId);
  return nodeChunks;
}

//
// 4. Reloading Strategies
//
// handleRawReload: This function is similar to your existing one,
// but now uses the new parser to generate nodeChunks.
// ---------------------------------------------------------------------
async function handleRawReload() {
  console.log("🔄 Performing raw reload from main-text.md...");
  try {
    const response = await fetch(buildUrl(`/markdown/${book}/main-text.md`, true));
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
          "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]').content,
        },
      });
      if (!backendResponse.ok) {
        throw new Error(`Failed to trigger backend update: ${backendResponse.statusText}`);
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
    await saveNodeChunksToIndexedDB(nodeChunks, containerId, bookId);
    window.nodeChunks = nodeChunks;
    // Trigger footnotes reload (force reload)
    window.jsonPath = buildUrl(`/markdown/${book}/main-text-footnotes.json`, true);
    await loadFootnotes();
    const currentTimestamp = Date.now().toString();
    localStorage.setItem("markdownLastModified", currentTimestamp);
    window.savedChunks = {
      timestamp: currentTimestamp,
      chunks: [],
    };
    localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));
    console.log("✅ Raw reload complete. Files generated and cached.");
    const footnotes = await loadFootnotes();
    await sendGeneratedDataToBackend(nodeChunks, footnotes);
    return true;
  } catch (error) {
    console.error("❌ Error during raw reload:", error);
    return false;
  }
}

// ---------------------------------------------------------------------
// Full Reload: Clear caches and load fresh data.
// ---------------------------------------------------------------------
async function handleFullReload(serverTimestamp) {
  localStorage.setItem("markdownLastModified", serverTimestamp);
  localStorage.removeItem("savedChunks");
  await clearIndexedDB();
  window.jsonPath = buildUrl(`/markdown/${book}/main-text-footnotes.json`, true);
  await loadFootnotes();
  // Instead of fetching nodeChunks.json, generate nodeChunks via markdown parsing.
  window.nodeChunks = await parseMainTextMarkdown(true);
  window.savedChunks = {
    timestamp: serverTimestamp,
    chunks: [],
  };
  localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));
}

// ---------------------------------------------------------------------
// 5. Cached Load: Look up Nodes in IndexedDB using the new structure.
// ---------------------------------------------------------------------

// Use the id of mainContentDiv as the container id.
const containerId = mainContentDiv.id; // "main-content"
const bookId = book; // e.g., "nicholls2019moment"

async function handleCachedLoad() {
  console.log("✅ Timestamps match! Using IndexedDB cache...");
  let cachedNodeChunks = await getNodeChunksFromIndexedDB(containerId, bookId);
  console.log("Retrieved nodeChunks:", cachedNodeChunks);
  if (cachedNodeChunks && cachedNodeChunks.length > 0) {
    console.log("✅ Using cached nodeChunks from IndexedDB.");
    window.nodeChunks = cachedNodeChunks;
  } else {
    console.log("⚠️ No valid nodeChunks found in IndexedDB. Generating from Markdown...");
    const markdown = await fetchMainTextMarkdown(); // Ensure this is defined.
    const nodeChunks = parseMarkdownIntoChunks(markdown);
    console.log("Parsed nodeChunks:", nodeChunks);
    await saveNodeChunksToIndexedDB(nodeChunks, containerId, bookId);
    window.nodeChunks = nodeChunks;
  }
  await loadFootnotes();
}

//
// 6. sendGeneratedDataToBackend remains unchanged.
//
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

//
// 7. Lazy Loader Initialization: Mostly unchanged.
// ---------------------------------------------------------------------
export let currentLazyLoader = null;
export function initializeMainLazyLoader() {
  if (currentLazyLoader) {
    console.log("✅ Lazy loader already initialized. Skipping reinitialization.");
    return currentLazyLoader;
  }
  currentLazyLoader = createLazyLoader({
    container: mainContentDiv,
    nodeChunks: window.nodeChunks,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: "myMainBook", // Optional book id
  });
  return currentLazyLoader;
}

//
// 8. Background Update: remains mostly unchanged.
// ---------------------------------------------------------------------
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
    currentLazyLoader = null;
    initializeMainLazyLoader();
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

//
// 9. Main Entry Point 
// ---------------------------------------------------------------------
export async function loadMarkdownFile() {
  console.log("🚀 ENTERING loadMarkdownFile()...");
  let cachedServerTimestamp = localStorage.getItem("markdownLastModified") || "null";
  console.log("📂 Cached Server Timestamp BEFORE request:", cachedServerTimestamp);
  try {
    const updateInfo = await fetchLatestUpdateInfo(book);
    if (!updateInfo) {
      console.log("⚠️ No latest_update.json found. Initiating raw reload...");
      const success = await handleRawReload();
      if (!success) {
        console.error("❌ Raw reload failed. Cannot proceed.");
        return;
      }
    } else {
      const serverTimestamp = updateInfo.updated_at.toString();
      console.log("✅ Server reported Markdown last updated at:", serverTimestamp);
      const needsReload = await handleTimestampComparison(serverTimestamp, cachedServerTimestamp);
      if (needsReload) {
        console.log("❌ TIMESTAMPS DIFFER: Performing Full Reload...");
        await handleFullReload(serverTimestamp);
        currentLazyLoader = null;
      } else {
        console.log("✅ Timestamps match! Using IndexedDB cache...");
        await handleCachedLoad();
      }
    }
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
      console.error("❌ nodeChunks is empty. Aborting lazy loading.");
      return;
    }
    if (!currentLazyLoader) {
      console.log("✅ Initializing lazy loader...");
      initializeMainLazyLoader();
    } else {
      console.log("✅ Lazy loader already initialized, continuing to listen for scroll events.");
    }
  } catch (error) {
    console.error("❌ Error loading Markdown:", error);
  }
}

//
// 10. Navigation functions (loadContentAroundLine, loadContentAroundId)
// remain largely unchanged.
// ---------------------------------------------------------------------


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
