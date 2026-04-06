import { book, OpenHyperlightID, OpenFootnoteID } from './app.js';
import { log, verbose } from './utilities/logger.js';
import { navigateToInternalId } from './scrolling.js';
import { NavigationCompletionBarrier, NavigationProcess } from './navigation/NavigationCompletionBarrier.js';

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
  saveAllReferencesToIndexedDB,
  getLocalStorageKey,
} from "./indexedDB/index.js";

import {
  attachMarkListeners,
} from "./hyperlights/index.js";

import { parseMarkdownIntoChunksInitial } from "./utilities/convertMarkdown.js";

import { syncBookDataFromDatabase, syncIndexedDBtoPostgreSQL, syncAnnotationsOnly } from "./postgreSQL.js";
import { fetchInitialChunk } from "./initialChunkLoader.js";
import { updateLocalAnnotationsTimestamp } from "./indexedDB/core/library.js";
import { checkForDuplicateTabs, registerBookOpen } from "./utilities/BroadcastListener.js";

import { undoLastBatch, redoLastBatch } from './historyManager.js';
import { buildFootnoteMap, hasOldFormatFootnotes, migrateOldFormatFootnotes } from './footnotes/FootnoteNumberingService.js';
import { parseSubBookId, buildSubBookId } from './utilities/subBookIdHelper.js';

let isRetrying = false; // Prevents multiple retries at once


export let pendingFirstChunkLoadedPromise;
export let pendingContainerRestorePromise = null;
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
    // 0. Check if this book is already open in another tab (only on actual book pages)
    // Skip for homepage content IDs and non-reader page types
    const pageType = document.body.getAttribute('data-page');
    const homepageContentIds = ['most-recent', 'most-connected', 'most-lit'];
    const isActualBook = pageType === 'reader' && !homepageContentIds.includes(currentBook);

    if (isActualBook) {
      const isDuplicate = await checkForDuplicateTabs(currentBook);
      if (isDuplicate) {
        showDuplicateTabWarning(currentBook);
      }
      // Register this tab as having the book open (for future checks)
      registerBookOpen(currentBook);
    }

    // 1. Check for node chunks in IndexedDB (No change)
    updatePageLoadProgress(10, "Checking local cache...");
    const cached = await getNodeChunksFromIndexedDB(currentBook);
    if (cached && cached.length) {
      updatePageLoadProgress(30, "Loading from cache...");
      verbose.content(`Found ${cached.length} nodes in IndexedDB`, 'initializePage.js');

      // Clear any pending SPA navigation target — it was set for fetchInitialChunk
      // which we're skipping (cache hit). Without this it leaks to the next navigation.
      window._pendingChunkTarget = null;

      // Migrate old-format footnotes if needed (display numbers → footnote IDs)
      if (hasOldFormatFootnotes(cached)) {
        await migrateOldFormatFootnotes(currentBook, cached);
        // Save migrated nodes back to IndexedDB (lazy migration)
        await saveAllNodeChunksToIndexedDB(cached, currentBook);
      }

      window.nodes = cached;

      // Hydrate nodes with highlights/hypercites from standalone stores
      // Editor saves may have cleared embedded arrays — rebuild from source of truth
      const { rebuildNodeArrays } = await import('./indexedDB/hydration/rebuild.js');
      await rebuildNodeArrays(cached);

      // Clear stale dirty flag — we just hydrated from source of truth
      const { clearCacheDirtyFlag } = await import('./utilities/cacheState.js');
      clearCacheDirtyFlag();

      // Build footnote numbering map for dynamic renumbering
      buildFootnoteMap(currentBook, cached);

      // Add small delays to make progress visible
      await new Promise(resolve => setTimeout(resolve, 100));
      updatePageLoadProgress(90, "Initializing interface...");
      initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);

      // Note: Interactive features initialization handled by viewManager.js

      // Skip server timestamp check for virtual book IDs (e.g. timemachine)
      // — no server-side library record exists, so the fetch would 404
      if (!currentBook.endsWith('/timemachine')) {
        checkAndUpdateIfNeeded(currentBook, currentLazyLoader);
      }
      return;
    }

    // 2. Try chunked initial load (fast: fetches only one chunk first)
    updatePageLoadProgress(20, "Connecting to database...");
    const initialResult = await fetchInitialChunk(currentBook);
    if (initialResult?.success) {
      updatePageLoadProgress(50, "Loading initial content...");
      verbose.content(
        `Initial chunk loaded: ${initialResult.nodes.length} nodes (chunk ${initialResult.targetChunkId})`,
        'initializePage.js'
      );

      window.nodes = initialResult.nodes;
      window.chunkManifest = initialResult.chunkManifest;

      // Seed sessionStorage with server bookmark so restoreScrollPosition finds it.
      // On a fresh device/browser there's no localStorage — the server bookmark is
      // the only source of truth for where to resume. Without this, scroll restoration
      // defaults to chunk 0 which may not be in the initial download.
      if (initialResult.bookmark?.element_id && !openHyperlightID && !openFootnoteID) {
        const storageKey = getLocalStorageKey("scrollPosition", currentBook);
        const scrollData = JSON.stringify({ elementId: initialResult.bookmark.element_id });
        sessionStorage.setItem(storageKey, scrollData);
      }

      // Build footnote numbering map for dynamic renumbering
      buildFootnoteMap(currentBook, initialResult.nodes);

      updatePageLoadProgress(90, "Initializing interface...");
      initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);

      // Background download remaining chunks (Phase 3)
      setTimeout(() => {
        import('./backgroundDownloader.js').then(({ backgroundDownloadRemainingChunks }) => {
          backgroundDownloadRemainingChunks(currentBook, currentLazyLoader);
        }).catch(err => {
          console.warn('Background download module not available, falling back:', err);
        });
      }, 100);

      return;
    }

    // 2b. Fall back to full sync if initial chunk failed with a retryable error
    if (initialResult && initialResult.reason === 'sync_error') {
      verbose.content('Initial chunk failed, trying full sync fallback...', 'initializePage.js');
      const dbResult = await syncBookDataFromDatabase(currentBook);
      if (dbResult && dbResult.success) {
        updatePageLoadProgress(50, "Loading from database...");
        const dbChunks = await getNodeChunksFromIndexedDB(currentBook);
        if (dbChunks && dbChunks.length) {
          verbose.content(`Loaded ${dbChunks.length} nodes from PostgreSQL (full sync fallback)`, 'initializePage.js');

          if (hasOldFormatFootnotes(dbChunks)) {
            await migrateOldFormatFootnotes(currentBook, dbChunks);
            await saveAllNodeChunksToIndexedDB(dbChunks, currentBook);
          }

          window.nodes = dbChunks;
          buildFootnoteMap(currentBook, dbChunks);

          updatePageLoadProgress(90, "Initializing interface...");
          initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);
          return;
        }
      }

      if (dbResult && dbResult.reason === 'sync_error') {
        log.error(`Database sync failed for ${currentBook}`, 'initializePage.js', dbResult.error);
        updatePageLoadProgress(0, "Database connection failed");
        alert(`Cannot load book: Database connection failed.\n\nError: ${dbResult.error}\n\nPlease check your internet connection and try again.`);
        throw new Error(`Database sync failed: ${dbResult.error}`);
      }
    }

    // 3. Book not found in database - show error
    if (!initialResult || initialResult.reason === 'book_not_found') {
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
      chunkManifest: window.chunkManifest || null,
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

    // Auto-open chain for deep nested sub-book URLs (e.g. /book/2/Fn.../HL_...)
    if (window.autoOpenChain && window.autoOpenChain.length > 0) {
      openContainerChain(window.autoOpenChain, currentLazyLoader);
      window.autoOpenChain = null; // Prevent re-triggering
    }

    // Container stack restoration — if history.state has a serialized stack,
    // restore all layers from it (handles back-nav, refresh, and SPA transitions).
    // Only restore if the stack belongs to the current book — prevents stale
    // state from book A leaking into book B during SPA transitions.
    else if (history.state?.containerStack?.length > 0
             && (!history.state.containerStackBookId || history.state.containerStackBookId === book)) {
      pendingContainerRestorePromise = import('./hyperlitContainer/history.js').then(({ restoreContainerStack }) => {
        return restoreContainerStack(history.state.containerStack);
      });
    }

    // Legacy fallback: restore container from history.state.hyperlitContainer
    // Only if URL confirms something should be open (prevents stale state from reopening).
    else if (history.state?.hyperlitContainer) {
      const loc = window.location;
      const segs = loc.pathname.split('/').filter(Boolean);
      const urlHasCascade = segs.slice(1).some(s =>
        s.startsWith('HL_') || s.includes('_Fn') || /^Fn\d/.test(s)
      );
      const urlHasHash = loc.hash && (
        loc.hash.startsWith('#HL_') || loc.hash.startsWith('#hypercite_') ||
        loc.hash.startsWith('#footnote_') || loc.hash.startsWith('#citation_')
      );
      const urlHasCs = new URLSearchParams(loc.search).has('cs');

      if (urlHasCascade || urlHasHash || urlHasCs) {
        import('./hyperlitContainer/index.js').then(({ restoreHyperlitContainerFromHistory }) => {
          restoreHyperlitContainerFromHistory();
        });
      } else {
        // URL is clean — clear stale history state
        const s = history.state || {};
        history.replaceState({ ...s, hyperlitContainer: null }, '');
      }
    }
  }
}

/**
 * Wait for a DOM element to appear (by highlight class or footnote ID).
 * Uses MutationObserver with a timeout fallback.
 */
function waitForElement(itemId, container, timeout = 8000) {
  return new Promise((resolve) => {
    const selector = itemId.startsWith('HL_')
      ? `mark.${CSS.escape(itemId)}`
      : `#${CSS.escape(itemId)}`;

    const searchRoot = container || document;
    const existing = searchRoot.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = searchRoot.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(container || document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

/**
 * Frontend equivalent of TextController::walkChainToRoot.
 * Given a leaf sub-book ID, walk backwards to the root book,
 * building the full chain of {itemId, subBookId} pairs.
 */
async function walkChainToRoot(rootBook, leafSubBookId) {
  const chain = [];
  let currentSubBookId = leafSubBookId;

  for (let i = 0; i < 20; i++) {
    const parsed = parseSubBookId(currentSubBookId);
    if (!parsed.itemId) return null;

    chain.unshift({ itemId: parsed.itemId, subBookId: currentSubBookId });

    const parentBook = await findParentBook(currentSubBookId, parsed.itemId);
    if (!parentBook) return null;

    // Root reached when parentBook has no slashes
    if (!parentBook.includes('/')) {
      return (parentBook === rootBook) ? chain : null;
    }

    currentSubBookId = parentBook;
  }

  return null; // Safety limit
}

/**
 * Find the parent book of a sub-book by querying IndexedDB.
 * Mirrors TextController::findParentBook — checks footnotes then hyperlights.
 */
async function findParentBook(subBookId, itemId) {
  const db = await openDatabase();

  // Try footnotes
  if (itemId.includes('_Fn') || /^Fn\d/.test(itemId)) {
    const tx = db.transaction('footnotes', 'readonly');
    const index = tx.objectStore('footnotes').index('footnoteId');
    const results = await new Promise((resolve, reject) => {
      const req = index.getAll(itemId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const fn of results) {
      if (buildSubBookId(fn.book, itemId) === subBookId) {
        return fn.book;
      }
    }
  }

  // Try hyperlights
  if (itemId.startsWith('HL_')) {
    const tx = db.transaction('hyperlights', 'readonly');
    const index = tx.objectStore('hyperlights').index('hyperlight_id');
    const results = await new Promise((resolve, reject) => {
      const req = index.getAll(itemId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const hl of results) {
      if (buildSubBookId(hl.book, itemId) === subBookId) {
        return hl.book;
      }
    }
  }

  return null;
}

/**
 * Build the full container chain from URL path segments.
 * For level 1-2, all items are in the URL.
 * For level 3+, walks up via IndexedDB to find missing intermediate items.
 */
export async function buildChainFromUrl(bookId, pathSegments) {
  const afterBook = pathSegments.slice(1); // Everything after book ID
  if (afterBook.length === 0) return [];

  const firstAfterBook = afterBook[0];
  const isNested = /^\d+$/.test(firstAfterBook); // Level number present?
  const level = isNested ? parseInt(firstAfterBook, 10) : 1;

  // Extract visible Fn/HL segments from URL
  const visibleItems = afterBook.filter(seg =>
    seg.startsWith('HL_') || seg.includes('_Fn') || /^Fn\d/.test(seg)
  );

  if (visibleItems.length === 0) return [];

  // Level 1-2: all chain items are in the URL
  if (level <= visibleItems.length) {
    return visibleItems.map(seg => ({ itemId: seg, subBookId: null }));
  }

  // Level 3+: missing intermediate items, resolve via IndexedDB
  const rest = afterBook.join('/');
  const leafSubBookId = `${bookId}/${rest}`;
  const resolvedChain = await walkChainToRoot(bookId, leafSubBookId);

  if (resolvedChain) return resolvedChain;

  // Server-side fallback when IndexedDB doesn't have intermediate sub-book data
  try {
    console.log(`🔗 buildChainFromUrl: IndexedDB resolution failed, trying server...`);
    const response = await fetch(`/api/resolve-chain/${bookId}/${rest}`);
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.chain?.length > 0) {
        console.log(`🔗 buildChainFromUrl: Server resolved chain with ${data.chain.length} items`);
        return data.chain;
      }
    }
  } catch (err) {
    console.warn(`🔗 buildChainFromUrl: Server resolution failed:`, err);
  }

  // Fallback: use what we have from URL
  console.warn(`Could not resolve full chain for ${leafSubBookId}, using partial chain`);
  return visibleItems.map(seg => ({ itemId: seg, subBookId: null }));
}

/**
 * Open a chain of containers sequentially.
 * Closes any existing containers first, then opens each chain item
 * by finding its element and calling handleUnifiedContentClick.
 */
export async function openContainerChain(chain, lazyLoader, finalHash = null) {
  if (!chain || chain.length === 0) return;

  // Close any existing containers to start from clean state
  const isContainerCurrentlyOpen = document.body.classList.contains('hyperlit-container-open');
  if (isContainerCurrentlyOpen) {
    try {
      const { closeHyperlitContainer } = await import('./hyperlitContainer/index.js');
      await closeHyperlitContainer(true);
    } catch (e) { /* ignore */ }
  }

  // Support both old string[] format and new {itemId, subBookId}[] format
  const normalized = chain.map(item =>
    typeof item === 'string' ? { itemId: item, subBookId: null } : item
  );

  // Pre-sync ALL sub-book data in parallel so containers open instantly
  const subBookIds = normalized.map(i => i.subBookId).filter(Boolean);
  if (subBookIds.length > 0) {
    console.log(`Pre-syncing ${subBookIds.length} sub-books...`);
    await Promise.allSettled(
      subBookIds.map(id => syncBookDataFromDatabase(id))
    );
  }

  // Open all containers in the chain — continueChainOpening handles both the
  // first item (searching document.body) and subsequent items (searching inside
  // the current container scroller), using the correct selector for HL_ marks.
  await continueChainOpening(normalized);

  // After chain is fully opened, scroll to final hash target (e.g. hypercite)
  if (finalHash) {
    await new Promise(r => setTimeout(r, 500));
    const { getCurrentContainer } = await import('./hyperlitContainer/stack.js');
    const container = getCurrentContainer();
    if (container) {
      const target = container.querySelector(`#${CSS.escape(finalHash)}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const { highlightTargetHypercite } = await import('./hypercites/animations.js');
        highlightTargetHypercite(finalHash, 500);
      }
    }
  }
}

/**
 * Continue opening stacked layers for each chain item.
 * Each iteration searches inside the current container's scroller
 * (or document.body if no container is open yet), then triggers
 * handleUnifiedContentClick which auto-stacks.
 */
async function continueChainOpening(chain) {
  for (const chainItem of chain) {
    const itemId = typeof chainItem === 'string' ? chainItem : chainItem.itemId;

    // Search inside the current container scroller if one is open,
    // otherwise search document.body (for the first chain item)
    const { getCurrentScroller } = await import('./hyperlitContainer/stack.js');
    const isContainerOpen = document.body.classList.contains('hyperlit-container-open');
    const scroller = isContainerOpen ? getCurrentScroller() : null;

    let element = await waitForElement(itemId, scroller || document.body, 8000);

    // If not found, the item may be beyond the 5-node preview.
    // Try expanding the sub-book via the "[read more]" button.
    if (!element && scroller) {
      const readMoreBtn = scroller.querySelector('.expand-sub-book');
      if (readMoreBtn) {
        console.log(`Expanding sub-book to find chain item ${itemId}...`);
        readMoreBtn.click();
        await new Promise(r => setTimeout(r, 2000));
        element = await waitForElement(itemId, scroller, 5000);
      }
    }

    if (!element) {
      console.warn(`Chain item ${itemId} not found, stopping chain.`);
      break;
    }

    // Wait for any in-flight click processing to finish before opening next layer
    const { handleUnifiedContentClick, isClickProcessing } = await import('./hyperlitContainer/index.js');
    let waitAttempts = 0;
    while (isClickProcessing() && waitAttempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      waitAttempts++;
    }

    // Re-query element in current scope — the original reference may be stale
    // if the sub-book DOM was rebuilt during hydration
    const { getCurrentScroller: getLatestScroller } = await import('./hyperlitContainer/stack.js');
    const containerNowOpen = document.body.classList.contains('hyperlit-container-open');
    const latestScroller = containerNowOpen ? getLatestScroller() : null;
    const selector = itemId.startsWith('HL_')
      ? `mark.${CSS.escape(itemId)}`
      : `#${CSS.escape(itemId)}`;
    const freshElement = (latestScroller || document.body).querySelector(selector);
    if (freshElement) element = freshElement;

    await handleUnifiedContentClick(element);

    // Brief pause for stacked layer DOM render
    await new Promise(r => setTimeout(r, 500));
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
  // 🎯 CRITICAL: Capture any active navigation target at the START of this check.
  // The check runs async and may complete after navigation flags are cleared.
  // By capturing now, we ensure refresh() can find the target even if the barrier cleans up.
  const capturedNavigationTarget = lazyLoader?.pendingNavigationTarget ||
                                   NavigationCompletionBarrier.getNavigationTarget() ||
                                   (window.location.hash ? window.location.hash.substring(1) : null);

  if (capturedNavigationTarget) {
    console.log(`🎯 Timestamp check: captured navigation target at start: ${capturedNavigationTarget}`);
  }

  // Skip server timestamp check when offline - use cached data
  if (!navigator.onLine) {
    console.log(`📡 Offline: skipping server check for ${bookId}`);
    return;
  }

  // Skip if background download is in progress (it will bring fresh data)
  if (window._backgroundDownloadInProgress) {
    console.log(`⏳ Background download in progress, skipping timestamp check for ${bookId}`);
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
      // 🎯 Pass captured navigation target directly to refresh() - this is the most reliable
      // way to preserve the target, since it was captured at the start of this async check
      if (capturedNavigationTarget) {
        console.log(`🎯 Passing captured target to refresh(): ${capturedNavigationTarget}`);
      }
      // 🚦 Register CONTENT_REFRESH before calling refresh() (if barrier is active)
      NavigationCompletionBarrier.registerProcess(NavigationProcess.CONTENT_REFRESH);
      await lazyLoader.refresh(capturedNavigationTarget);
      // 🚦 Signal CONTENT_REFRESH complete
      NavigationCompletionBarrier.completeProcess(NavigationProcess.CONTENT_REFRESH, true);
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
        const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('./indexedDB/hydration/rebuild.js');
        const { getNodeChunksFromIndexedDB } = await import('./indexedDB/index.js');

        // Get node chunks to find node_ids for visible startLines
        const allNodes = await getNodeChunksFromIndexedDB(bookId);
        const visibleDataNodeIDs = allNodes
          .filter(n => visibleNodeIds.includes(String(n.startLine)))
          .map(n => n.node_id)
          .filter(Boolean);

        console.log(`🔄 Rebuilding arrays for ${visibleDataNodeIDs.length} nodes...`);

        if (visibleDataNodeIDs.length > 0) {
          const nodesToRebuild = await getNodesByDataNodeIDs(visibleDataNodeIDs);
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

/**
 * Show warning when book is already open in another tab
 * Warns about potential sync conflicts but allows user to continue
 */
function showDuplicateTabWarning(bookId) {
  console.warn(`⚠️ Book "${bookId}" is already open in another tab`);

  // Create a dismissible banner at the top of the page
  const banner = document.createElement("div");
  banner.id = "duplicate-tab-warning";
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(90deg, #d97706, #b45309);
    color: white;
    padding: 12px 20px;
    z-index: 10001;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;

  banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span><strong>Warning:</strong> This book is open in another tab. Editing in multiple tabs may cause sync conflicts.</span>
    </div>
    <button id="dismiss-duplicate-warning" style="
      background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.4);
      color: white;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    ">Dismiss</button>
  `;

  document.body.appendChild(banner);

  // Handle dismiss
  document.getElementById("dismiss-duplicate-warning").addEventListener("click", () => {
    banner.remove();
  });

  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (document.getElementById("duplicate-tab-warning")) {
      banner.style.transition = "opacity 0.5s";
      banner.style.opacity = "0";
      setTimeout(() => banner.remove(), 500);
    }
  }, 10000);
}


