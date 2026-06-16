import { book, OpenHyperlightID, OpenFootnoteID } from '../app.js';
import { log, verbose } from '../utilities/logger';
import { NavigationCompletionBarrier, NavigationProcess } from '../SPA/navigation/NavigationCompletionBarrier.js';

import {
  getNodeChunksFromIndexedDB,
  saveAllNodeChunksToIndexedDB,
  saveAllFootnotesToIndexedDB,
  saveAllReferencesToIndexedDB,
  getLocalStorageKey,
  openDatabase,
} from "../indexedDB/index.js";

import { parseMarkdownIntoChunksInitial } from "../utilities/convertMarkdown";

import { syncBookDataFromDatabase, syncIndexedDBtoPostgreSQL, syncAnnotationsOnly } from "../indexedDB/serverSync/index";
import { fetchInitialChunk, resolveBootstrapTarget } from "./initialChunk";
import { loadChunkForTarget } from "../SPA/navigation/chunkLoadRouter.js";
import { updateLocalAnnotationsTimestamp } from "../indexedDB/core/library.js";
import { registerBookOpen } from "../utilities/BroadcastListener";

import { buildFootnoteMap, hasOldFormatFootnotes, migrateOldFormatFootnotes } from '../footnotes/FootnoteNumberingService';

import { resolveFirstChunkPromise, resetFirstChunkPromise, getFirstChunkLoadedResolver } from './firstChunkPromise';
import { setupOnlineSyncListener } from './onlineRetry';
import { currentLazyLoader, initializeLazyLoader } from './lazyLoaderRegistry';

// ✅ MODIFIED: This function now loads all three JSON files.
export async function loadFromJSONFiles(bookId: string) {
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
  } catch (error: any) {
    verbose.content(`Could not load from JSON files: ${error.message}`, 'initializePage.js');
    throw error; // Re-throw to trigger the fallback
  }
}

// ✅ MODIFIED: Your main loading function now calls the new loader.
export async function loadHyperText(bookId: string, progressCallback: any = null) {
  resetFirstChunkPromise();
  const currentBook = bookId || book;
  log.content(`Book data loaded: ${currentBook}`, 'initializePage.js');
  setupOnlineSyncListener();
  const openHyperlightID = OpenHyperlightID || null;
  const openFootnoteID = OpenFootnoteID || null;

  // Import progress functions or use provided callback
  let updatePageLoadProgress: any, hidePageLoadProgress: any;
  if (progressCallback) {
    updatePageLoadProgress = progressCallback;
    hidePageLoadProgress = () => {}; // SPA handles hiding separately
  } else {
    try {
      const progressModule = await import('./readerEntry');
      updatePageLoadProgress = progressModule.updatePageLoadProgress;
      hidePageLoadProgress = progressModule.hidePageLoadProgress;
    } catch (e: any) {
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
      // Register this tab so other tabs can detect edits via BOOK_EDITED broadcasts
      registerBookOpen(currentBook);
    }

    // 1. Check for node chunks in IndexedDB (No change)
    updatePageLoadProgress(10, "Checking local cache...");
    const cached: any = await getNodeChunksFromIndexedDB(currentBook);
    if (cached && cached.length) {
      updatePageLoadProgress(30, "Loading from cache...");
      verbose.content(`Found ${cached.length} nodes in IndexedDB`, 'initializePage.js');

      // Capture any pending SPA navigation target before clearing it — we need to
      // resolve it against the cache so initializeLazyLoader renders the correct chunk.
      const spaTarget = (window as any)._pendingChunkTarget || null;
      (window as any)._pendingChunkTarget = null;
      (window as any)._targetResolved = undefined;

      // Migrate old-format footnotes if needed (display numbers → footnote IDs)
      if (hasOldFormatFootnotes(cached)) {
        await migrateOldFormatFootnotes(currentBook, cached);
        // Save migrated nodes back to IndexedDB (lazy migration)
        await saveAllNodeChunksToIndexedDB(cached, currentBook);
      }

      // 1. Resolve target chunk BEFORE hydration (lightweight IDB query)
      //    so we know which chunk to hydrate and render first
      let resolvedTargetChunkId = null;
      if (spaTarget) {
        const { resolveTargetChunkId: resolve } = await import('../SPA/navigation/resolveTargetChunk.js');
        const resolution = await resolve(currentBook, spaTarget, { nodes: cached });
        if (resolution.resolved) {
          resolvedTargetChunkId = resolution.chunkId;
          verbose.content(`SPA target "${spaTarget}" resolved to chunk ${resolvedTargetChunkId}`, 'initializePage.js');
        }
      }

      // 2. Hydrate ONLY the target chunk's nodes for fast first render
      //    (~100 nodes instead of potentially 26856)
      const firstChunkId = resolvedTargetChunkId !== null ? resolvedTargetChunkId : 0;
      const targetChunkNodes = cached.filter((n: any) => n.chunk_id === firstChunkId);
      const { rebuildNodeArrays } = await import('../indexedDB/hydration/rebuild');
      await rebuildNodeArrays(targetChunkNodes);

      // Set window.nodes (full set needed for lazy loader's chunk lookup)
      (window as any).nodes = cached;
      (window as any).chunkManifest = null; // Clear stale manifest — full dataset from cache, no manifest needed

      // 3. Skip artificial delay for SPA transitions — progress overlay already showing
      if (!progressCallback) {
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
      updatePageLoadProgress(90, "Initializing interface...");
      await initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID, resolvedTargetChunkId);

      // Signal that content is loaded — without this, anything awaiting
      // pendingFirstChunkLoadedPromise (e.g. handleHashNavigation) hangs forever
      resolveFirstChunkPromise();

      // 4. Dim edit button while background hydration is pending — edit mode
      //    needs the full hydrated dataset to work correctly
      const editBtn = document.getElementById('editButton');
      const needsBackgroundHydration = targetChunkNodes.length < cached.length;
      if (editBtn && needsBackgroundHydration) {
        editBtn.style.opacity = '0.3';
        editBtn.style.pointerEvents = 'none';
      }

      // 5. Background: hydrate remaining nodes + build footnote map + clear dirty flag
      const completeBackgroundHydration = async () => {
        try {
          const remaining = cached.filter((n: any) => n.chunk_id !== firstChunkId);
          if (remaining.length > 0) {
            await rebuildNodeArrays(remaining);
          }
          // Build footnote numbering map (needs all nodes with footnotes extracted)
          buildFootnoteMap(currentBook, cached);
          // Clear stale dirty flag — we just hydrated from source of truth
          const { clearCacheDirtyFlag } = await import('../lazyLoader/utilities/cacheState');
          clearCacheDirtyFlag();
        } catch (err) {
          console.error('Background hydration failed:', err);
        } finally {
          // Re-enable edit button now that all nodes are hydrated
          if (editBtn) {
            editBtn.style.opacity = '';
            editBtn.style.pointerEvents = '';
          }
        }
      };

      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => completeBackgroundHydration(), { timeout: 2000 });
      } else {
        setTimeout(() => completeBackgroundHydration(), 50);
      }

      // Note: Interactive features initialization handled by viewManager.js

      // Skip server timestamp check for virtual book IDs (e.g. timemachine)
      // — no server-side library record exists, so the fetch would 404
      if (!currentBook.endsWith('/timemachine')) {
        checkAndUpdateIfNeeded(currentBook, currentLazyLoader);
      }
      return;
    }

    // 2. Try chunked initial load (fast: fetches only one chunk first)
    //    Routes between local IndexedDB cache and server based on freshness
    updatePageLoadProgress(20, "Connecting to database...");
    const { target: bootstrapTarget, fallbackTarget: bootstrapFallback } = resolveBootstrapTarget();
    const initialResult: any = await loadChunkForTarget(currentBook, bootstrapTarget, {
      fallbackTarget: bootstrapFallback,
    });
    if (initialResult?.success) {
      updatePageLoadProgress(50, "Loading initial content...");
      verbose.content(
        `Initial chunk loaded: ${initialResult.nodes.length} nodes (chunk ${initialResult.targetChunkId})`,
        'initializePage.js'
      );

      (window as any).nodes = initialResult.nodes;
      (window as any).chunkManifest = initialResult.chunkManifest;

      // Store resolution status so BookToBookTransition can check it
      (window as any)._targetResolved = initialResult.targetResolved;

      // Fresh page load: if target wasn't resolved and there's a hash, clean it and notify
      if (!initialResult.targetResolved && window.location.hash) {
        history.replaceState(null, '', window.location.pathname);
        import('../components/toast/toast').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast({
            target: bootstrapTarget,
            fallbackUsed: initialResult.targetFallbackUsed,
          });
        });
      }

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
      await initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);

      // Dim the edit button while background download is pending — edit mode
      // needs the full dataset, so the user shouldn't enter it yet.
      const editBtn = document.getElementById('editButton');
      if (editBtn) {
        editBtn.style.opacity = '0.3';
        editBtn.style.pointerEvents = 'none';

        const enableEdit = () => {
          editBtn.style.opacity = '';
          editBtn.style.pointerEvents = '';
          editBtn.title = '';
        };

        window.addEventListener('backgroundDownloadComplete', enableEdit, { once: true });

        window.addEventListener('backgroundDownloadFailed', () => {
          editBtn.title = 'Download incomplete \u2014 tap to retry';
          editBtn.style.opacity = '0.3';
          editBtn.style.pointerEvents = '';  // Make clickable for retry
          editBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            editBtn.style.pointerEvents = 'none';
            editBtn.title = 'Retrying download\u2026';
            // Re-listen for success on retry
            window.addEventListener('backgroundDownloadComplete', enableEdit, { once: true });
            const { backgroundDownloadRemainingChunks } = await import('./backgroundDownload');
            backgroundDownloadRemainingChunks(currentBook, currentLazyLoader);
          }, { once: true });
        }, { once: true });
      }

      // Background download remaining chunks (Phase 3)
      // Use requestIdleCallback to start when the browser is actually idle,
      // preventing contention with user interactions right after first render.
      const startBackgroundDownload = () => {
        import('./backgroundDownload').then(({ backgroundDownloadRemainingChunks }) => {
          backgroundDownloadRemainingChunks(currentBook, currentLazyLoader);
        }).catch(err => {
          console.warn('Background download module not available, falling back:', err);
        });
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(startBackgroundDownload, { timeout: 2000 });
      } else {
        setTimeout(startBackgroundDownload, 100);
      }

      return;
    }

    // 2b. Fall back to full sync if initial chunk failed with a retryable error
    if (initialResult && initialResult.reason === 'sync_error') {
      verbose.content('Initial chunk failed, trying full sync fallback...', 'initializePage.js');
      const dbResult = await syncBookDataFromDatabase(currentBook);
      if (dbResult && dbResult.success) {
        updatePageLoadProgress(50, "Loading from database...");
        const dbChunks: any = await getNodeChunksFromIndexedDB(currentBook);
        if (dbChunks && dbChunks.length) {
          verbose.content(`Loaded ${dbChunks.length} nodes from PostgreSQL (full sync fallback)`, 'initializePage.js');

          if (hasOldFormatFootnotes(dbChunks)) {
            await migrateOldFormatFootnotes(currentBook, dbChunks);
            await saveAllNodeChunksToIndexedDB(dbChunks, currentBook);
          }

          (window as any).nodes = dbChunks;
          buildFootnoteMap(currentBook, dbChunks);

          updatePageLoadProgress(90, "Initializing interface...");
          await initializeLazyLoader(openHyperlightID, currentBook, openFootnoteID);
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
  } catch (err: any) {
    log.error('Critical error during content loading', 'initializePage.js', err);
    const firstChunkLoadedResolver = getFirstChunkLoadedResolver();
    if (firstChunkLoadedResolver) {
      firstChunkLoadedResolver();
    }
  }
}


// Note: initializeInteractiveFeatures function removed as it duplicates viewManager.js functionality

// generateNodeChunksFromMarkdown (+ its fetch/url helpers) moved to ./nodeGen so lazyLoaderRegistry
// can import it statically without the old lazyLoaderRegistry↔loadHyperText dynamic cycle-breaker.

// Your existing function - unchanged
function navigateToElement(elementId: string) {
  const element = document.getElementById(elementId);
  if (element) {
    console.log(`Navigating to element: ${elementId}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.log(`Element not found: ${elementId}, will try loading more content`);
  }
}

async function checkAndUpdateIfNeeded(bookId: string, lazyLoader: any) {
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
  if ((window as any)._backgroundDownloadInProgress) {
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
        `🔥 Book content changed for ${bookId}. Surgical refresh for current target...`
      );

      // Fetch fresh chunk for the current navigation target (stores all annotations
      // + target chunk to IndexedDB via put semantics — no wipe needed)
      const freshResult = await fetchInitialChunk(bookId);

      if (freshResult?.success) {
        // Update lazyLoader with fresh data for the target chunk
        lazyLoader.nodes = freshResult.nodes;
        (window as any).nodes = freshResult.nodes;
        if (freshResult.chunkManifest) {
          (window as any).chunkManifest = freshResult.chunkManifest;
          lazyLoader.chunkManifest = freshResult.chunkManifest;
        }

        notifyContentUpdated();

        if (capturedNavigationTarget) {
          console.log(`🎯 Passing captured target to refresh(): ${capturedNavigationTarget}`);
        }

        // 🚦 Register CONTENT_REFRESH before calling refresh() (if barrier is active)
        NavigationCompletionBarrier.registerProcess(NavigationProcess.CONTENT_REFRESH);
        await lazyLoader.refresh(capturedNavigationTarget);
        // 🚦 Signal CONTENT_REFRESH complete
        NavigationCompletionBarrier.completeProcess(NavigationProcess.CONTENT_REFRESH, true);

        // Kick off background backfill of remaining chunks (non-blocking)
        import('./backgroundDownload').then(({ backgroundDownloadRemainingChunks }) => {
          backgroundDownloadRemainingChunks(bookId, lazyLoader);
        }).catch(err => {
          console.warn('Background download module not available:', err);
        });
      } else {
        // Fall back to full sync if initial chunk fetch failed
        console.log(`⚠️ Surgical refresh failed, falling back to full sync for ${bookId}`);
        await (syncBookDataFromDatabase as any)(bookId, true);
        notifyContentUpdated();

        NavigationCompletionBarrier.registerProcess(NavigationProcess.CONTENT_REFRESH);
        await lazyLoader.refresh(capturedNavigationTarget);
        NavigationCompletionBarrier.completeProcess(NavigationProcess.CONTENT_REFRESH, true);
      }
      return; // Refresh includes annotations, no need to check further
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
        const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../indexedDB/hydration/rebuild');
        const { getNodeChunksFromIndexedDB } = await import('../indexedDB/index');

        // Get node chunks to find node_ids for visible startLines
        const allNodes: any = await getNodeChunksFromIndexedDB(bookId);
        const visibleDataNodeIDs = allNodes
          .filter((n: any) => visibleNodeIds.includes(String(n.startLine)))
          .map((n: any) => n.node_id)
          .filter(Boolean);

        console.log(`🔄 Rebuilding arrays for ${visibleDataNodeIDs.length} nodes...`);

        if (visibleDataNodeIDs.length > 0) {
          const allNodesToRebuild: any = await getNodesByDataNodeIDs(visibleDataNodeIDs);
          // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
          // node when the same node_id exists in both parent and sub-book.
          const nodesToRebuild = allNodesToRebuild.filter((n: any) => n.book === bookId);
          await rebuildNodeArrays(nodesToRebuild);
          console.log(`✅ Rebuilt node arrays with new annotations`);
        }

        // 4. Reprocess highlights on visible nodes WITHOUT destroying DOM
        console.log(`🔄 Reprocessing highlights on visible nodes...`);
        const { reprocessHighlightsForNodes } = await import('../hyperlights/deletion');
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
async function getLibraryRecordFromServer(bookId: string): Promise<any> {
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
async function getLibraryRecordFromIndexedDB(bookId: string): Promise<any> {
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
