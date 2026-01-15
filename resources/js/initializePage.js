import { book, OpenHyperlightID, OpenFootnoteID } from './app.js';
import { log, verbose } from './utilities/logger.js';
import { navigateToInternalId } from './scrolling.js';

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "./lazyLoaderFactory.js";

import {
  openDatabase,
  getNodeChunksFromIndexedDB,
  saveAllNodeChunksToIndexedDB,
  saveFootnotesToIndexedDB,
  updateHistoryLog,
  executeSyncPayload,
  saveAllFootnotesToIndexedDB,
  saveAllReferencesToIndexedDB
} from "./indexedDB/index.js";

import {
  attachMarkListeners,
} from "./hyperlights/index.js";

import { parseMarkdownIntoChunksInitial } from "./utilities/convertMarkdown.js";

import { syncBookDataFromDatabase, syncIndexedDBtoPostgreSQL, syncAnnotationsOnly } from "./postgreSQL.js";
import { updateLocalAnnotationsTimestamp } from "./indexedDB/core/library.js";
// Add to your imports at the top

import { undoLastBatch, redoLastBatch } from './historyManager.js';
import { buildFootnoteMap, hasOldFormatFootnotes, migrateOldFormatFootnotes } from './footnotes/FootnoteNumberingService.js';

let isRetrying = false; // Prevents multiple retries at once


export let pendingFirstChunkLoadedPromise;
let firstChunkLoadedResolver;

export function resolveFirstChunkPromise() {
  if (firstChunkLoadedResolver && typeof firstChunkLoadedResolver === 'function') {
    firstChunkLoadedResolver();
    firstChunkLoadedResolver = null; // Clear it after use
  } else {
    // Set a flag to resolve it immediately when the promise is created
    window._resolveFirstChunkWhenReady = true;
  }
}

function resetFirstChunkPromise() {
    pendingFirstChunkLoadedPromise = new Promise(resolve => {
        firstChunkLoadedResolver = resolve;

        // ✅ If we were asked to resolve immediately, do it now
        if (window._resolveFirstChunkWhenReady) {
            resolve();
            window._resolveFirstChunkWhenReady = false;
        }
    });
}

async function retryFailedBatches() {
  if (isRetrying || !navigator.onLine) {
    return;
  }
  isRetrying = true;

  try {
    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    // Get both "failed" and "pending" batches (pending = saved while offline)
    const [failedLogs, pendingLogs] = await Promise.all([
      new Promise((resolve, reject) => {
        const request = index.getAll("failed");
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }),
      new Promise((resolve, reject) => {
        const request = index.getAll("pending");
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      })
    ]);

    const logsToRetry = [...failedLogs, ...pendingLogs];

    if (logsToRetry.length === 0) {
      isRetrying = false;
      return;
    }

    verbose.content(`Retrying ${logsToRetry.length} pending sync batches (${failedLogs.length} failed, ${pendingLogs.length} pending)`, 'initializePage.js');

    let successCount = 0;
    for (const log of logsToRetry) {
      try {
        // --- START: Build a clean payload for syncing ---
        const historyPayload = log.payload;
        const syncPayload = {
          book: historyPayload.book,
          updates: {
            nodes: historyPayload.updates.nodes || [],
            hypercites: historyPayload.updates.hypercites || [],
            hyperlights: historyPayload.updates.hyperlights || [],
            footnotes: historyPayload.updates.footnotes || [],
            library: historyPayload.updates.library || null,
          },
          deletions: {
            // For syncing, we only want TRUE deletions.
            // A true deletion is an item in `deletions` that does NOT have a corresponding `update`.
            nodes: (historyPayload.deletions.nodes || []).filter(
              d => !(historyPayload.updates.nodes || []).some(u => u.startLine === d.startLine)
            ),
            hypercites: (historyPayload.deletions.hypercites || []).filter(
              d => !(historyPayload.updates.hypercites || []).some(u => u.hyperciteId === d.hyperciteId)
            ),
            hyperlights: (historyPayload.deletions.hyperlights || []).filter(
              d => !(historyPayload.updates.hyperlights || []).some(u => u.hyperlight_id === d.hyperlight_id)
            ),
            // Library deletions are not handled this way, so it remains empty for sync.
          }
        };
        // --- END: Build a clean payload for syncing ---

        await executeSyncPayload(syncPayload); // <-- Pass the clean syncPayload

        log.status = "synced";
        await updateHistoryLog(log);
        successCount++;
      } catch (error) {
        verbose.content(`Retry for batch ${log.id} failed`, 'initializePage.js', error);
        break;
      }
    }

    // 📡 Show green glow if we successfully synced any batches
    if (successCount > 0) {
      console.log(`✅ Successfully synced ${successCount} pending batches after coming online`);
      try {
        const { glowCloudSyncSuccess } = await import('./components/editIndicator.js');
        glowCloudSyncSuccess();
      } catch (e) {
        // Edit indicator might not be loaded if user hasn't edited
      }
    }
  } catch (error) {
    log.error('Critical error during retry process', 'initializePage.js', error);
  } finally {
    isRetrying = false;
  }
}

// Track if online listener is attached
let onlineListenerAttached = false;

// ✅ STEP 3: A setup function to attach the event listeners
export function setupOnlineSyncListener() {
  // Immediately check for failed batches when the app loads
  retryFailedBatches();

  // Only add listener if not already attached
  if (!onlineListenerAttached) {
    window.addEventListener("online", retryFailedBatches);
    onlineListenerAttached = true;
  }
}

// Cleanup function to remove online listener
export function cleanupOnlineSyncListener() {
  if (onlineListenerAttached) {
    window.removeEventListener("online", retryFailedBatches);
    onlineListenerAttached = false;
  }
}




// ✅ MODIFIED: This function now loads all three JSON files.
export async function loadFromJSONFiles(bookId) {
  try {
    // Fetch all three files concurrently for maximum speed
    const [
      nodesResponse,
      footnotesResponse,
      referencesResponse,
    ] = await Promise.all([
      fetch(`/${bookId}/nodes.json`),
      fetch(`/${bookId}/footnotes.json`),
      fetch(`/${bookId}/references.json`),
    ]);

    // Check if all requests were successful
    if (
      !nodesResponse.ok ||
      !footnotesResponse.ok ||
      !referencesResponse.ok
    ) {
      throw new Error("One or more required JSON files not found (404).");
    }

    // Parse all JSON responses concurrently
    const [
      nodes,
      footnotes,
      references,
    ] = await Promise.all([
      nodesResponse.json(),
      footnotesResponse.json(),
      referencesResponse.json(),
    ]);

    verbose.content(`Loaded ${nodes.length} nodes, ${footnotes.length} footnotes, ${references.length} refs from JSON`, 'initializePage.js');

    // Save all the fetched data to IndexedDB concurrently
    await Promise.all([
      saveAllNodeChunksToIndexedDB(nodes, bookId),
      saveAllFootnotesToIndexedDB(footnotes, bookId),
      saveAllReferencesToIndexedDB(references, bookId),
    ]);

    // Return the nodes to be used immediately for rendering the page
    return nodes;
  } catch (error) {
    verbose.content(`Could not load from JSON files: ${error.message}`, 'initializePage.js');
    throw error; // Re-throw to trigger the fallback
  }
}

// ✅ MODIFIED: Your main loading function now calls the new loader.
export async function loadHyperText(bookId, progressCallback = null) {
  resetFirstChunkPromise();
  const currentBook = bookId || book;
  log.content(`Book data loaded: ${currentBook}`, 'initializePage.js');
  setupOnlineSyncListener();
  const openHyperlightID = OpenHyperlightID || null;
  const openFootnoteID = OpenFootnoteID || null;

  // Import progress functions or use provided callback
  let updatePageLoadProgress, hidePageLoadProgress;
  if (progressCallback) {
    updatePageLoadProgress = progressCallback;
    hidePageLoadProgress = () => {}; // SPA handles hiding separately
  } else {
    try {
      const progressModule = await import('./readerDOMContentLoaded.js');
      updatePageLoadProgress = progressModule.updatePageLoadProgress;
      hidePageLoadProgress = progressModule.hidePageLoadProgress;
    } catch (e) {
      log.error('Could not import progress functions', 'initializePage.js', e);
      // Create dummy functions if import fails
      updatePageLoadProgress = () => {};
      hidePageLoadProgress = () => {};
    }
  }


  try {
    // 1. Check for node chunks in IndexedDB (No change)
    updatePageLoadProgress(10, "Checking local cache...");
    const cached = await getNodeChunksFromIndexedDB(currentBook);
    if (cached && cached.length) {
      updatePageLoadProgress(30, "Loading from cache...");
      verbose.content(`Found ${cached.length} nodes in IndexedDB`, 'initializePage.js');

      // Migrate old-format footnotes if needed (display numbers → footnote IDs)
      if (hasOldFormatFootnotes(cached)) {
        await migrateOldFormatFootnotes(currentBook, cached);
        // Save migrated nodes back to IndexedDB (lazy migration)
        await saveAllNodeChunksToIndexedDB(cached, currentBook);
      }

      window.nodes = cached;

      // Build footnote numbering map for dynamic renumbering
      buildFootnoteMap(currentBook, cached);

      // Add small delays to make progress visible
      await new Promise(resolve => setTimeout(resolve, 100));
      updatePageLoadProgress(90, "Initializing interface...");
      initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);

      // Note: Interactive features initialization handled by viewManager.js

      checkAndUpdateIfNeeded(currentBook, currentLazyLoader);
      return;
    }

    // 2. Try Database Sync
    updatePageLoadProgress(20, "Connecting to database...");
    const dbResult = await syncBookDataFromDatabase(currentBook);
    if (dbResult && dbResult.success) {
      updatePageLoadProgress(50, "Loading from database...");
      const dbChunks = await getNodeChunksFromIndexedDB(currentBook);
      if (dbChunks && dbChunks.length) {
        verbose.content(`Loaded ${dbChunks.length} nodes from PostgreSQL`, 'initializePage.js');

        // Migrate old-format footnotes if needed (display numbers → footnote IDs)
        if (hasOldFormatFootnotes(dbChunks)) {
          await migrateOldFormatFootnotes(currentBook, dbChunks);
          // Save migrated nodes back to IndexedDB (lazy migration)
          await saveAllNodeChunksToIndexedDB(dbChunks, currentBook);
        }

        window.nodes = dbChunks;

        // Build footnote numbering map for dynamic renumbering
        buildFootnoteMap(currentBook, dbChunks);

        updatePageLoadProgress(90, "Initializing interface...");
        initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);

        // Note: Interactive features initialization handled by viewManager.js

        return;
      }
    }

    // ✅ CRITICAL FIX: Only use file fallbacks if database says "book not found" (404)
    // Do NOT use fallbacks on network/server errors to prevent data loss
    if (dbResult && dbResult.reason === 'sync_error') {
      log.error(`Database sync failed for ${currentBook}`, 'initializePage.js', dbResult.error);
      updatePageLoadProgress(0, "Database connection failed");
      alert(`Cannot load book: Database connection failed.\n\nError: ${dbResult.error}\n\nPlease check your internet connection and try again.`);
      throw new Error(`Database sync failed: ${dbResult.error}`);
    }

    // 3. Book not found in database - show error
    // NOTE: File-based fallbacks (JSON and markdown) removed to prevent loading stale data.
    // During import, ImportBookTransition.js loads fresh JSON files directly.
    if (!dbResult || dbResult.reason === 'book_not_found') {
      log.error(`Book "${currentBook}" not found in database`, 'initializePage.js');
      updatePageLoadProgress(0, "Book not found");
      throw new Error(`Book "${currentBook}" not found. It may not have been imported yet.`);
    }
  } catch (err) {
    log.error('Critical error during content loading', 'initializePage.js', err);
    if (firstChunkLoadedResolver) {
      firstChunkLoadedResolver();
    }
  }
}


// Note: initializeInteractiveFeatures function removed as it duplicates viewManager.js functionality

// Helper to add cache-busting parameter when needed
function buildUrl(path, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

// Updated to accept bookId parameter
async function fetchMainTextMarkdown(bookId, forceReload = false) {
  const response = await fetch(buildUrl(`/${bookId}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error(`Failed to fetch main-text.md for ${bookId}`);
  }
  return response.text();
}

// Updated to accept bookId parameter
async function generateNodeChunksFromMarkdown(bookId, forceReload = false) {
  const markdown = await fetchMainTextMarkdown(bookId);

  // Parse markdown into nodes
  const nodes = parseMarkdownIntoChunksInitial(markdown);
  verbose.content(`Generated ${nodes.length} nodes from markdown`, 'initializePage.js');

  // Pass the callback to the save function
  await saveAllNodeChunksToIndexedDB(nodes, bookId);
  return nodes;
}

// Store multiple lazy loaders by bookId
export const lazyLoaders = {};

// Keep your existing single lazy loader for backward compatibility
export let currentLazyLoader = null;

// Function to reset the current lazy loader for homepage transitions
export function resetCurrentLazyLoader() {
  if (currentLazyLoader) {
    // Properly disconnect the old lazy loader to remove its event listeners
    if (typeof currentLazyLoader.disconnect === 'function') {
      currentLazyLoader.disconnect();
    }

    currentLazyLoader = null;
  }
}

// Your existing function - unchanged for backward compatibility
export function initializeMainLazyLoader() {
  if (currentLazyLoader) {
    console.log("✅ Lazy loader already initialized. Skipping reinitialization.");
    return currentLazyLoader;
  }
  
  // Debug the book variable
  console.log(`Book variable value: ${book}, type: ${typeof book}`);
  
  // If book is undefined or not what you expect, set a default or log an error
  if (!book) {
    console.error("Book variable is undefined or empty!");
  }
  
  console.log(`Initializing lazy loader for book: ${book}`);
  currentLazyLoader = createLazyLoader({
    nodes: window.nodes,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: book,
  });
  
  return currentLazyLoader;
}


// Function for homepage multi-book support - always creates fresh content
export async function initializeLazyLoaderForContainer(bookId) {
  console.log(`🔄 Creating fresh lazy loader for book: ${bookId}`);
  
  // Clean up any existing lazy loader for this book
  if (lazyLoaders[bookId]) {
    console.log(`🧹 Removing existing lazy loader for fresh ${bookId} content`);
    delete lazyLoaders[bookId];
  }
  
  try {
    // Load book data using the same priority as regular books:
    // 1. IndexedDB cache -> 2. Database sync -> 3. Generate from markdown
    let nodes = await getNodeChunksFromIndexedDB(bookId);
    
    if (!nodes || !nodes.length) {
      console.log(`🔍 Loading ${bookId} from database...`);
      const dbResult = await syncBookDataFromDatabase(bookId);
      if (dbResult && dbResult.success) {
        nodes = await getNodeChunksFromIndexedDB(bookId);
      }
    }
    
    if (!nodes || !nodes.length) {
      console.log(`🆕 Generating ${bookId} from markdown`);
      nodes = await generateNodeChunksFromMarkdown(bookId, true);
    }
    
    if (!nodes || !nodes.length) {
      console.error(`❌ No nodes available in nodes object store in IndexedDB for ${bookId}`);
      return null;
    }
    
    // Create fresh lazy loader instance
    lazyLoaders[bookId] = createLazyLoader({
      nodes: nodes,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: bookId
    });
    
    // Load the first chunk of nodes to initialize content
    const firstChunk = nodes.find(chunk => chunk.chunk_id === 0) || nodes[0];
    if (firstChunk && lazyLoaders[bookId]) {
      verbose.content(`Loading initial chunk #${firstChunk.chunk_id} for ${bookId}`, 'initializePage.js');
      lazyLoaders[bookId].loadChunk(firstChunk.chunk_id, "down");
    }

    verbose.content(`Fresh lazy loader created for ${bookId}`, 'initializePage.js');
    return lazyLoaders[bookId];
    
  } catch (error) {
    console.error(`❌ Error creating fresh lazy loader for ${bookId}:`, error);
    return null;
  }
}



// Your existing helper function - updated to handle both hyperlights and footnotes
function initializeLazyLoader(openHyperlightID, bookId, openFootnoteID = null) {
  if (!currentLazyLoader) {
    // Determine which ID to navigate to (hyperlight or footnote)
    const targetId = openHyperlightID || openFootnoteID;

    currentLazyLoader = createLazyLoader({
      nodes: window.nodes,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: bookId,
      isNavigatingToInternalId: !!targetId,
      onFirstChunkLoaded: firstChunkLoadedResolver
    });

    // Only manually load first chunk of nodes for homepage/user page contexts
    // Regular reader pages will trigger via intersection observer
    const isHomepageContext = document.querySelector('.home-content-wrapper') ||
                              document.querySelector('.user-content-wrapper');
    if (isHomepageContext) {
      const firstChunk = window.nodes.find(chunk => chunk.chunk_id === 0) || window.nodes[0];
      if (firstChunk && currentLazyLoader) {
        verbose.content(`Loading initial chunk #${firstChunk.chunk_id} (homepage context)`, 'initializePage.js');
        currentLazyLoader.loadChunk(firstChunk.chunk_id, "down");
      }
    }

    // Navigate to hyperlight or footnote if specified in URL
    if (targetId) {
      setTimeout(() => {
        navigateToInternalId(targetId, currentLazyLoader, false);
      }, 300);
    }
  }
}

// Your existing function - unchanged
function navigateToElement(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    console.log(`Navigating to element: ${elementId}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.log(`Element not found: ${elementId}, will try loading more content`);
  }
}

async function checkAndUpdateIfNeeded(bookId, lazyLoader) {
  // Skip server timestamp check when offline - use cached data
  if (!navigator.onLine) {
    console.log(`📡 Offline: skipping server check for ${bookId}`);
    return;
  }

  // ===================== THE FIX =====================
  // First, check if this is the brand-new book we just created.
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  if (pendingSyncJSON) {
    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      // If the pending sync is for the book we are currently loading...
      if (pendingSync.bookId === bookId) {
        console.log(
          `✅ Skipping server timestamp check for new book "${bookId}" that is pending sync.`
        );
        // ...then we know it doesn't exist on the server yet.
        // There's nothing to compare, so we exit the function early.
        return;
      }
    } catch (e) {
      console.error(
        "Could not parse pending_new_book_sync from sessionStorage",
        e
      );
    }
  }

  // This part only runs for EXISTING books.
  if (!lazyLoader) {
    console.warn(
      "⚠️ Timestamp check skipped: lazyLoader instance not provided."
    );
    return;
  }

  // ===================================================

  try {
    // The log message is now more accurate, as it only runs for existing books.
    verbose.content(`Async timestamp check for: ${bookId}`, 'initializePage.js');

    // Get both records in parallel
    const [serverRecord, localRecord] = await Promise.all([
      getLibraryRecordFromServer(bookId),
      getLibraryRecordFromIndexedDB(bookId),
    ]);

    // Handle case where server request failed
    if (!serverRecord) {
      console.log(`⚠️ Could not fetch server data for ${bookId}. Skipping timestamp check.`);
      return;
    }
    
    if (!localRecord) {
      console.log(`⚠️ No local data found for ${bookId}. Skipping timestamp check.`);
      return;
    }

    const serverTimestamp = serverRecord.timestamp || 0;
    const localTimestamp = localRecord.timestamp || 0;
    const serverAnnotationsTs = serverRecord.annotations_updated_at || 0;
    const localAnnotationsTs = localRecord.annotations_updated_at || 0;

    // 🔍 DIAGNOSTIC: Log exact timestamp values being compared
    console.log('🔍 TIMESTAMP CHECK:', {
      bookId,
      serverTimestamp,
      localTimestamp,
      diff: serverTimestamp - localTimestamp,
      serverNewer: serverTimestamp > localTimestamp,
      serverAnnotationsTs,
      localAnnotationsTs,
      annotationsDiff: serverAnnotationsTs - localAnnotationsTs,
      serverAnnotationsNewer: serverAnnotationsTs > localAnnotationsTs
    });

    // Check if book content changed (nodes)
    if (serverTimestamp > localTimestamp) {
      console.log(
        `🔥 Book content changed for ${bookId}. Full sync...`
      );
      await syncBookDataFromDatabase(bookId, true); // Download new data (includes annotations)
      notifyContentUpdated();

      // Tell the already-rendered page to refresh itself with the new data.
      console.log(
        `🔄 Triggering lazyLoader.refresh() to display updated content.`
      );
      await lazyLoader.refresh();
      return; // Full sync includes annotations, no need to check further
    }

    // Check if only annotations changed (highlights/hypercites)
    if (serverAnnotationsTs > localAnnotationsTs) {
      console.log(
        `📝 Annotations changed for ${bookId}. Syncing annotations only...`
      );

      // 1. Download latest annotations from backend to IndexedDB
      await syncAnnotationsOnly(bookId);
      await updateLocalAnnotationsTimestamp(bookId, serverAnnotationsTs);

      // 2. Get all visible node IDs from DOM
      const visibleNodeIds = Array.from(
        document.querySelectorAll('[id]:not([data-chunk-id]):not(.sentinel)')
      )
        .filter(el => /^\d+$/.test(el.id)) // Only numeric IDs (node IDs)
        .map(el => el.id);

      console.log(`🔄 Found ${visibleNodeIds.length} visible nodes to update`);

      if (visibleNodeIds.length > 0) {
        // 3. Rebuild node arrays from the new standalone tables
        const { rebuildNodeArrays, getNodesByUUIDs } = await import('./indexedDB/hydration/rebuild.js');
        const { getNodeChunksFromIndexedDB } = await import('./indexedDB/index.js');

        // Get node chunks to find node_ids for visible startLines
        const allNodes = await getNodeChunksFromIndexedDB(bookId);
        const visibleNodeUUIDs = allNodes
          .filter(n => visibleNodeIds.includes(String(n.startLine)))
          .map(n => n.node_id)
          .filter(Boolean);

        console.log(`🔄 Rebuilding arrays for ${visibleNodeUUIDs.length} nodes...`);

        if (visibleNodeUUIDs.length > 0) {
          const nodesToRebuild = await getNodesByUUIDs(visibleNodeUUIDs);
          await rebuildNodeArrays(nodesToRebuild);
          console.log(`✅ Rebuilt node arrays with new annotations`);
        }

        // 4. Reprocess highlights on visible nodes WITHOUT destroying DOM
        console.log(`🔄 Reprocessing highlights on visible nodes...`);
        const { reprocessHighlightsForNodes } = await import('./hyperlights/deletion.js');
        await reprocessHighlightsForNodes(bookId, visibleNodeIds);
      }
    } else {
      verbose.content(`Local content is up-to-date for: ${bookId}`, 'initializePage.js');
    }
  } catch (err) {
    console.error("❌ Error during background timestamp check:", err);
  }
}

// Helper function to get library record from server
async function getLibraryRecordFromServer(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    const data = await response.json();
    verbose.content(`Server response for ${bookId}`, 'initializePage.js');
    
    return data.success ? data.library : null;
  } catch (err) {
    console.error("❌ Error fetching library record from server:", err);
    return null;
  }
}

// Helper function to get library record from IndexedDB
async function getLibraryRecordFromIndexedDB(bookId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readonly");
    const store = tx.objectStore("library");
    
    return new Promise((resolve, reject) => {
      const request = store.get(bookId);
      
      request.onsuccess = () => {
        resolve(request.result || null);
      };
      
      request.onerror = () => {
        reject("❌ Error loading library record from IndexedDB");
      };
    });
  } catch (err) {
    console.error("❌ Error accessing library record in IndexedDB:", err);
    return null;
  }
}

// Optional: Function to notify UI that content was updated
function notifyContentUpdated() {
  // You could dispatch a custom event, show a toast notification, etc.
  console.log("📢 Content has been updated in the background");

  // Example: dispatch custom event
  window.dispatchEvent(new CustomEvent('contentUpdated', {
    detail: { bookId: book }
  }));
}

/**
 * 🔒 Handle access denied to private book
 * Shows appropriate UI based on login status
 */
export async function handlePrivateBookAccessDenied(bookId) {
  console.log(`🔒 handlePrivateBookAccessDenied called for book: ${bookId}`);

  const { getCurrentUser } = await import('./utilities/auth.js');
  const user = await getCurrentUser();

  if (!user) {
    // Not logged in - show login prompt
    showPrivateBookLoginPrompt(bookId);
  } else {
    // Logged in but not authorized - show access denied message
    showPrivateBookAccessDenied(bookId, user);
  }
}

/**
 * 🔒 Show login prompt for private book access
 * Pattern from editButton.js
 */
function showPrivateBookLoginPrompt(bookId) {
  console.log(`🔑 Showing login prompt for private book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #EF8D34;">Private Book</h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">This is a private book. Please log in to access it.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonLogin" class="alert-button secondary" style="padding: 10px 20px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 4px; cursor: pointer;">Go to Home</button>
        <button type="button" id="showLoginButton" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Log In</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button clicks
  alertBox.addEventListener("click", async (e) => {
    const targetId = e.target.id;

    if (targetId === "goHomeButtonLogin") {
      window.location.href = "/";
    } else if (targetId === "showLoginButton") {
      // Dynamically import userContainer to avoid circular dependency
      const { initializeUserContainer } = await import('./components/userContainer.js');

      // Initialize userManager singleton if not already initialized
      const userManager = initializeUserContainer();

      if (!userManager) {
        console.error("❌ userManager could not be initialized (userButton not found in DOM)");
        alert("Login form could not be loaded. Please refresh the page and try again.");
        return;
      }

      // Set post-login action to reload the page
      userManager.setPostLoginAction(() => {
        console.log("✅ User logged in, reloading page to check access");
        window.location.reload();
      });

      // Get login form HTML
      const formHTML = userManager.getLoginFormHTML();

      // Replace alert content with login form
      alertBox.innerHTML = formHTML;

      // Add cancel button
      const buttonContainer = alertBox.querySelector(".alert-buttons");
      if (buttonContainer) {
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.id = "cancelLoginButton";
        cancelButton.className = "alert-button secondary";
        cancelButton.textContent = "Cancel";
        cancelButton.style.cssText = "padding: 10px 20px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 4px; cursor: pointer;";
        buttonContainer.appendChild(cancelButton);

        cancelButton.addEventListener("click", () => {
          document.body.removeChild(overlay);
        });
      }
    }
  });
}

/**
 * 🔒 Show access denied message for logged-in user without permission
 */
function showPrivateBookAccessDenied(bookId, user) {
  console.log(`🔒 Showing access denied for user ${user.name} to book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #EF8D34;">Access Denied</h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">You don't have permission to access this private book.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonDenied" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Go to Home</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button click
  document.getElementById("goHomeButtonDenied").addEventListener("click", () => {
    window.location.href = "/";
  });
}

/**
 * 🗑️ Handle access to deleted book
 * Shows a message that the book has been deleted
 */
export async function handleDeletedBookAccess(bookId) {
  console.log(`🗑️ handleDeletedBookAccess called for book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #d73a49;">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 8px;"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Book Deleted
      </h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">This book has been deleted and is no longer available.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonDeleted" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Go to Home</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button click
  document.getElementById("goHomeButtonDeleted").addEventListener("click", () => {
    window.location.href = "/";
  });
}


