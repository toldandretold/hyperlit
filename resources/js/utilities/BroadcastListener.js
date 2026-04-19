// BroadcastListener.js

import { book } from "../app.js"; // current book identifier
import { applyHypercites, applyHighlights } from "../lazyLoaderFactory.js"; // adjust path as needed
import { attachUnderlineClickListeners } from "../hypercites/index.js";
import { setProgrammaticUpdateInProgress } from "./operationState.js";
import { openDatabase } from "../indexedDB/core/connection.js";

// Track recent broadcasts from THIS tab to skip self-processing
// This prevents the re-render loop where our own broadcast triggers mutation observers
const locallyBroadcastedUpdates = new Set();

// Unique ID for this tab instance
export const TAB_ID = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Channel for tab coordination (separate from node-updates)
let tabCoordinationChannel = null;

/**
 * Check if the same book is already open in another tab
 * Returns a promise that resolves to true if duplicate found
 */
export function checkForDuplicateTabs(bookId) {
  return new Promise((resolve) => {
    if (!tabCoordinationChannel) {
      tabCoordinationChannel = new BroadcastChannel("hyperlit-tab-coordination");
    }

    let duplicateFound = false;

    const handler = (event) => {
      if (event.data.type === 'BOOK_OPEN_RESPONSE' &&
          event.data.book === bookId &&
          event.data.tabId !== TAB_ID) {
        duplicateFound = true;
      }
    };

    tabCoordinationChannel.addEventListener('message', handler);
    tabCoordinationChannel.postMessage({
      type: 'BOOK_OPEN_CHECK',
      book: bookId,
      tabId: TAB_ID
    });

    // Wait briefly for responses from other tabs
    setTimeout(() => {
      tabCoordinationChannel.removeEventListener('message', handler);
      resolve(duplicateFound);
    }, 150);
  });
}

/**
 * Register this tab as having a book open
 * Other tabs can query this
 */
export function registerBookOpen(bookId) {
  if (!tabCoordinationChannel) {
    tabCoordinationChannel = new BroadcastChannel("hyperlit-tab-coordination");
  }

  // Listen for queries and edit broadcasts from other tabs
  tabCoordinationChannel.addEventListener('message', (event) => {
    // Skip own messages
    if (event.data.tabId === TAB_ID) return;

    if (event.data.type === 'BOOK_OPEN_CHECK' && event.data.book === bookId) {
      // Another tab is asking if we have this book open - respond yes
      tabCoordinationChannel.postMessage({
        type: 'BOOK_OPEN_RESPONSE',
        book: bookId,
        tabId: TAB_ID
      });
    }

    if (event.data.type === 'BOOK_EDITED') {
      // Check if the edit is for our book (handle sub-books too)
      const incomingRoot = event.data.book?.split('/')[0];
      const currentRoot = bookId?.split('/')[0];
      if (incomingRoot === currentRoot) {
        showStaleTabOverlay();
      }
    }
  });
}

/**
 * Show a blocking overlay when the book was edited in another tab.
 * Cannot be dismissed — the only action is to reload the page.
 */
function showStaleTabOverlay() {
  if (document.getElementById('stale-tab-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'stale-tab-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 99999;
  `;

  overlay.innerHTML = `
    <div style="background: #2a2a2a; padding: 40px; border-radius: 12px; max-width: 460px; text-align: center; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#EF8D34" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px;">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600;">Edited in another tab</h2>
      <p style="margin: 0 0 24px 0; color: #aaa; line-height: 1.5; font-size: 14px;">This book was modified in a different tab. Refresh to load the latest version.</p>
      <button id="stale-tab-refresh" style="
        background: #EF8D34;
        color: #fff;
        border: none;
        padding: 12px 32px;
        border-radius: 6px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      ">Refresh</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById('stale-tab-refresh').addEventListener('click', () => {
    window.location.reload();
  });
}

export function initializeBroadcastListener() {
  const channel = new BroadcastChannel("node-updates");

  channel.addEventListener("message", (event) => {
    // Destructure with alias to avoid naming collisions.
    const { book: incomingBook, startLine } = event.data;

    // Skip updates that originated from THIS tab (self-broadcasts)
    const updateKey = `${incomingBook}_${startLine}`;
    if (locallyBroadcastedUpdates.has(updateKey)) {
      console.log(`⏭️ Skipping self-broadcast for ${updateKey}`);
      locallyBroadcastedUpdates.delete(updateKey);
      return;
    }

    if (incomingBook === book) {
      console.log(`Received update for node with startLine: ${startLine}`);
      updateDomNode(startLine);
    }
  });
}

/**
 * updateDomNode:
 * Retrieves the latest record from IndexedDB, runs it through the content
 * processing functions, and then updates the corresponding DOM node.
 */
// This function needs to be async now to handle the potential async nature
// of getting the record (though your example uses .then, which is fine).
// For clarity and modern JavaScript, making it async/await is better.
async function updateDomNode(startLine) {
  console.group(`updateDomNode(${startLine})`);
  console.log(`Starting update for node ID: ${startLine}`);
  
  setProgrammaticUpdateInProgress(true);

  try {
    const record = await getNodeChunkByKey(book, startLine);
    if (!record) {
      console.warn(`⚠️ No record for key [${book}, ${startLine}]`);
      return;
    }

    const node = document.getElementById(startLine);
    if (!node) {
      console.warn(`⚠️ No DOM element with id=${startLine}`);
      return;
    }

    // ✅ THE FIX: Sanitize and unwrap the content first.
    // 1. Create a temporary container.
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = record.content;

    // 2. Extract the INNER content of the first child element (the h1 or p).
    const innerContent = tempDiv.firstElementChild ? tempDiv.firstElementChild.innerHTML : "";
    
    // 3. Start the processing pipeline with the CLEAN, UNWRAPPED content.
    let processedContent = innerContent;

    // 4. Run it through the rendering pipeline.
    if (record.hyperlights && record.hyperlights.length > 0) {
      processedContent = applyHighlights(processedContent, record.hyperlights);
    }
    if (record.hypercites && record.hypercites.length > 0) {
      processedContent = applyHypercites(processedContent, record.hypercites);
    }

    // 5. Replace the innerHTML of the target node with the processed INNER content.
    // This prevents the nesting bug.
    node.innerHTML = processedContent;
    console.log(`✅ Node ${startLine} re-rendered from scratch.`);
    console.log(`Node HTML after update:`, node.outerHTML);

    attachUnderlineClickListeners();
    console.log(`Attached underline click listeners`);

  } catch (error) {
    console.error("❌ Error updating DOM node:", error);
  } finally {
    // Use RAF to delay clearing the flag - this ensures mutations triggered by
    // the innerHTML update are processed BEFORE the flag is cleared.
    // MutationProcessor also uses RAF, so this ensures proper ordering.
    requestAnimationFrame(() => {
      console.log("Clearing programmatic update flag.");
      setProgrammaticUpdateInProgress(false);
    });
    console.groupEnd();
  }
}





function sanitizeContent(html) {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;
  // Remove the outer h1 if it exists.
  const h1 = tempDiv.querySelector("h1");
  if (h1 && h1.innerHTML) {
    return h1.innerHTML;
  }
  return html;
}
/**
 * getNodeChunkByKey:
 * Returns a Promise that resolves to the nodeChunk record for the given book
 * and startLine from IndexedDB.
 */
async function getNodeChunkByKey(book, startLine) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("nodes", "readonly");
    const objectStore = transaction.objectStore("nodes");
    const getRequest = objectStore.get([book, startLine]);

    getRequest.onerror = (event) => {
      console.error("Error getting record:", event.target.error);
      resolve(null);
    };

    getRequest.onsuccess = (event) => {
      resolve(event.target.result);
    };
  });
}

export function broadcastToOpenTabs(booka, startLine) {
  const channel = new BroadcastChannel("node-updates");
  const updateKey = `${booka}_${startLine}`;

  // Mark this update so we skip it when we receive our own broadcast
  // This prevents the self-broadcast loop that causes hypercite removal
  locallyBroadcastedUpdates.add(updateKey);

  // Clear after a short delay (in case message doesn't arrive or is delayed)
  setTimeout(() => locallyBroadcastedUpdates.delete(updateKey), 200);

  console.log(
    `Broadcasting update: book=${booka}, startLine=${startLine}`
  );
  channel.postMessage({
    book: booka,
    startLine,
  });
}
