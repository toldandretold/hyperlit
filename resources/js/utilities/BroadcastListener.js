// BroadcastListener.js

import { book } from "../app.js"; // current book identifier
import { applyHypercites, applyHighlights } from "../lazyLoaderFactory.js"; // adjust path as needed
import { attachUnderlineClickListeners } from "../hypercites/index.js";
import { setProgrammaticUpdateInProgress } from "./operationState.js";

// Track recent broadcasts from THIS tab to skip self-processing
// This prevents the re-render loop where our own broadcast triggers mutation observers
const locallyBroadcastedUpdates = new Set();

// Unique ID for this tab instance
const TAB_ID = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

  // Listen for queries from other tabs
  tabCoordinationChannel.addEventListener('message', (event) => {
    if (event.data.type === 'BOOK_OPEN_CHECK' &&
        event.data.book === bookId &&
        event.data.tabId !== TAB_ID) {
      // Another tab is asking if we have this book open - respond yes
      tabCoordinationChannel.postMessage({
        type: 'BOOK_OPEN_RESPONSE',
        book: bookId,
        tabId: TAB_ID
      });
    }
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
function getNodeChunkByKey(book, startLine) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodes";
    const request = indexedDB.open(dbName);

    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction([storeName], "readonly");
      const objectStore = transaction.objectStore(storeName);
      const key = [book, startLine];
      const getRequest = objectStore.get(key);

      getRequest.onerror = (event) => {
        console.error("Error getting record:", event.target.error);
        resolve(null);
      };

      getRequest.onsuccess = (event) => {
        resolve(event.target.result);
      };

      transaction.oncomplete = () => {
        db.close();
      };
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
