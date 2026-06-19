// BroadcastListener.js

import { book } from "../app"; // current book identifier
import { applyHypercites, applyHighlights } from "../lazyLoader/chunkRender";
// attachUnderlineClickListeners loaded lazily at its one call site (cross-tab re-render) so this EAGER
// utility doesn't statically pull the reader-only hypercites chunk into the eager bundle.
import { setProgrammaticUpdateInProgress } from "./operationState";
import { openDatabase } from "../indexedDB/core/connection.js";

// Track recent broadcasts from THIS tab to skip self-processing
// This prevents the re-render loop where our own broadcast triggers mutation observers
const locallyBroadcastedUpdates = new Set();

// Stable per-tab identifier.
// Stored in sessionStorage (per-tab, shared by every script in the tab) so that
// EVERY instance of this module shares ONE id — the main bundle AND the
// lazily-loaded `editor` chunk that owns saveQueue.js. If this were a plain
// module-level const, a code-split / stale-service-worker copy of this module
// would mint a second TAB_ID, and the self-skip in registerBookOpen() would
// fail: the tab would treat its OWN saves as edits "from another tab" and fire
// the stale-tab overlay constantly on a book you just created.
function resolveTabId() {
  try {
    const KEY = "hyperlit_tab_id";
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    // Private mode / storage disabled — fall back to a volatile id.
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Unique ID for this tab instance
export const TAB_ID = resolveTabId();

// Root bookIds this tab has edited very recently, keyed by root id -> timestamp.
// Kept on `window` so it is shared across module instances / code-split chunks.
// An actively-editing tab consults this to ignore BOOK_EDITED echoes for work it
// is doing itself, rather than blocking the user mid-edit. This is a second line
// of defence behind the TAB_ID self-skip: it keys on the actual edit event, so it
// holds even if module identity is ever broken.
const LOCAL_EDIT_TTL_MS = 10000;

function localEditRegistry() {
  if (!(window as any).__hyperlitLocalEdits) (window as any).__hyperlitLocalEdits = {};
  return (window as any).__hyperlitLocalEdits;
}

/**
 * Record that THIS tab just edited `book`. Called from the save path immediately
 * before it broadcasts BOOK_EDITED, so the listener can tell our own work apart
 * from a genuine edit made in a different tab.
 */
export function markBookEditedLocally(book: any) {
  const root = book?.split("/")[0];
  if (!root) return;
  localEditRegistry()[root] = Date.now();
}

function editedLocallyRecently(root: any) {
  const ts = localEditRegistry()[root];
  return ts != null && Date.now() - ts < LOCAL_EDIT_TTL_MS;
}

// Channel for tab coordination (separate from node-updates)
let tabCoordinationChannel: any = null;

/**
 * Check if the same book is already open in another tab
 * Returns a promise that resolves to true if duplicate found
 */
export function checkForDuplicateTabs(bookId: any) {
  return new Promise((resolve) => {
    if (!tabCoordinationChannel) {
      tabCoordinationChannel = new BroadcastChannel("hyperlit-tab-coordination");
    }

    let duplicateFound = false;

    const handler = (event: any) => {
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

// Root bookIds this tab currently has open. SPA navigation adds to this set
// instead of stacking another never-removed channel listener on every page init.
const openBookRoots = new Set();
let tabCoordinationListenerAttached = false;

/**
 * Register this tab as having a book open
 * Other tabs can query this
 */
export function registerBookOpen(bookId: any) {
  if (!tabCoordinationChannel) {
    tabCoordinationChannel = new BroadcastChannel("hyperlit-tab-coordination");
  }

  const root = bookId?.split("/")[0];
  if (root) openBookRoots.add(root);

  // Attach the message listener exactly once for the lifetime of the tab.
  // Previously every initializePage()/SPA navigation added another anonymous
  // listener that was never removed, so the overlay could fire multiple times.
  if (tabCoordinationListenerAttached) return;
  tabCoordinationListenerAttached = true;

  // Listen for queries and edit broadcasts from other tabs
  tabCoordinationChannel.addEventListener('message', (event: any) => {
    // Skip own messages
    if (event.data.tabId === TAB_ID) return;

    const incomingRoot = event.data.book?.split('/')[0];
    if (!incomingRoot || !openBookRoots.has(incomingRoot)) return;

    if (event.data.type === 'BOOK_OPEN_CHECK') {
      // Another tab is asking if we have this book open - respond yes
      tabCoordinationChannel.postMessage({
        type: 'BOOK_OPEN_RESPONSE',
        book: event.data.book,
        tabId: TAB_ID
      });
    }

    if (event.data.type === 'BOOK_EDITED') {
      // Ignore echoes of edits this very tab just made (covers code-split module
      // instances and near-simultaneous self-saves) so we never block the editor
      // on its own work.
      if (editedLocallyRecently(incomingRoot)) return;
      (showStaleTabOverlay as any)();
    }
  });
}

/**
 * Show a blocking overlay when the book is out of date (edited elsewhere).
 * Cannot be dismissed — the only action is to reload the page.
 *
 * Two callers, same "you're stale, reload" situation detected differently:
 *   - same-browser cross-tab edit (BroadcastChannel) — the default message
 *   - cross-device 409 STALE_DATA on sync (UnifiedSyncController) — passes its own message
 *
 * @param {string} [message] Override body copy (the tab vs device wording differs).
 *
 * NOTE (future): this hard-blocks and forces a reload, which DISCARDS the user's
 * unsynced edit. That's the safe-but-blunt option. A nicer future version could
 * 3-way diff the local edit against the server's newer version and auto-merge when
 * the changes don't overlap (only block when they genuinely conflict), so we only
 * throw away work when we absolutely have to. See the 409 path in
 * indexedDB/syncQueue/master.js (executeSyncPayload) for where the conflict is detected.
 */
export function showStaleTabOverlay(message: any) {
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
      <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 600;">Book out of date</h2>
      <p style="margin: 0 0 24px 0; color: #aaa; line-height: 1.5; font-size: 14px;">${message || 'This book was modified in a different tab. Refresh to load the latest version.'}</p>
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
  document.getElementById('stale-tab-refresh')?.addEventListener('click', () => {
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
async function updateDomNode(startLine: any) {
  console.group(`updateDomNode(${startLine})`);
  console.log(`Starting update for node ID: ${startLine}`);
  
  setProgrammaticUpdateInProgress(true);

  try {
    const record = await getNodeByKey(book, startLine);
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
    tempDiv.innerHTML = (record as any).content;

    // 2. Extract the INNER content of the first child element (the h1 or p).
    const innerContent = tempDiv.firstElementChild ? tempDiv.firstElementChild.innerHTML : "";
    
    // 3. Start the processing pipeline with the CLEAN, UNWRAPPED content.
    let processedContent = innerContent;

    // 4. Run it through the rendering pipeline.
    if ((record as any).hyperlights && (record as any).hyperlights.length > 0) {
      processedContent = (applyHighlights as any)(processedContent, (record as any).hyperlights);
    }
    if ((record as any).hypercites && (record as any).hypercites.length > 0) {
      processedContent = applyHypercites(processedContent, (record as any).hypercites);
    }

    // 5. Replace the innerHTML of the target node with the processed INNER content.
    // This prevents the nesting bug.
    node.innerHTML = processedContent;
    console.log(`✅ Node ${startLine} re-rendered from scratch.`);
    console.log(`Node HTML after update:`, node.outerHTML);

    import("../hypercites/index").then((m) => m.attachUnderlineClickListeners());
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





function sanitizeContent(html: any) {
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
 * getNodeByKey:
 * Returns a Promise that resolves to the node record for the given book
 * and startLine from IndexedDB.
 */
async function getNodeByKey(book: any, startLine: any) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("nodes", "readonly");
    const objectStore = transaction.objectStore("nodes");
    const getRequest = objectStore.get([book, startLine]);

    getRequest.onerror = (event) => {
      console.error("Error getting record:", (event.target as any).error);
      resolve(null);
    };

    getRequest.onsuccess = (event) => {
      resolve((event.target as any).result);
    };
  });
}

export function broadcastToOpenTabs(booka: any, startLine: any) {
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
