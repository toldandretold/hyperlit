import { book, bookSlug, OpenHyperlightID, OpenFootnoteID } from '../app';
import { asBookId, type BookId } from '../indexedDB/types';
import { log, verbose } from '../utilities/logger';
import type { ReadingPosition } from '../scrolling/readingPosition';
import { maybePaginatorReveal } from '../scrolling/paginator';
import { NavigationCompletionBarrier, NavigationProcess } from '../SPA/navigation/NavigationCompletionBarrier';

import {
  getNodesFromIndexedDB,
  saveAllNodesToIndexedDB,
  saveAllFootnotesToIndexedDB,
  saveAllReferencesToIndexedDB,
  getLocalStorageKey,
  openDatabase,
} from "../indexedDB/index.js";

import { parseMarkdownIntoChunksInitial } from "../utilities/convertMarkdown";

import { syncBookDataFromDatabase, syncIndexedDBtoPostgreSQL, syncAnnotationsOnly } from "../indexedDB/serverSync/index";
import { fetchInitialChunk, resolveBootstrapTarget } from "./initialChunk";
import { loadChunkForTarget } from "../SPA/navigation/chunkLoadRouter.js";
import { updateLocalAnnotationsTimestamp, buildLibraryUrl } from "../indexedDB/core/library.js";
import { registerBookOpen } from "../utilities/BroadcastListener";

import { buildFootnoteMap, hasOldFormatFootnotes, migrateOldFormatFootnotes } from '../footnotes/FootnoteNumberingService';

import { resolveFirstChunkPromise, resetFirstChunkPromise, getFirstChunkLoadedResolver } from './firstChunkPromise';
import { setupOnlineSyncListener } from './onlineRetry';
import { primeImageDims } from '../lazyLoader/imageDims';
import { rootBookId } from '../e2ee/registry';
import { currentLazyLoader, initializeLazyLoader } from './lazyLoaderRegistry';
import { isReconvertHandoff } from '../utilities/reconvertHandoff';
// Zero-import leaf — flag-gated forensics (see scrolling/scrollTrace).
import { recordNavDecision } from '../scrolling/scrollTrace';

export async function loadFromJSONFiles(bookId: BookId) {
  try {
    // Right after a reconvert, bypass the browser/SW/CDN cache so we can't re-populate IDB from a
    // STALE copy of these static files (a scripted reload otherwise reuses the cached response —
    // only a user-initiated refresh revalidates). `cache:'reload'` forces a fresh network fetch.
    const opts: RequestInit = isReconvertHandoff(bookId as string) ? { cache: 'reload' } : {};
    // Fetch all three files concurrently for maximum speed
    const [
      nodesResponse,
      footnotesResponse,
      referencesResponse,
    ] = await Promise.all([
      fetch(`/${bookId}/nodes.json`, opts),
      fetch(`/${bookId}/footnotes.json`, opts),
      fetch(`/${bookId}/references.json`, opts),
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
      saveAllNodesToIndexedDB(nodes, bookId),
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

export async function loadHyperText(bookId: BookId, progressCallback: any = null) {
  resetFirstChunkPromise();
  const currentBook = bookId || book;
  verbose.content(`Book data loaded: ${currentBook}`, 'initializePage.js');
  setupOnlineSyncListener();
  // Warm the per-book image-dimension map in parallel with the content fetch
  // so the first chunk render can stamp width/height synchronously (imageDims
  // self-primes per src on a miss — this is just the race win).
  void primeImageDims(rootBookId(String(currentBook)));

  // E2EE open-gate, cached case (docs/e2ee.md): when the library record is
  // already local and marks the book encrypted, require the vault BEFORE any
  // render/sync work. (Fresh-device case is gated inside fetchInitialChunk,
  // where the library row first arrives.) Resolves instantly for plaintext
  // books and unlocked vaults.
  try {
    const { ensureUnlockedForBook } = await import('../e2ee/lifecycle');
    await ensureUnlockedForBook(String(currentBook));
  } catch {
    window.location.href = '/'; // unlock dismissed — leave the book
    return;
  }
  const openHyperlightID = OpenHyperlightID || null;
  const openFootnoteID = OpenFootnoteID || null;

  // Import progress functions or use provided callback
  let updatePageLoadProgress: any, hidePageLoadProgress: any;
  if (progressCallback) {
    updatePageLoadProgress = progressCallback;
    hidePageLoadProgress = () => {}; // SPA handles hiding separately
  } else {
    try {
      const progressModule = await import('./progress');
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

    // 1. Check for nodes in IndexedDB (No change)
    updatePageLoadProgress(10, "Checking local cache...");
    const cached: any = await getNodesFromIndexedDB(currentBook);
    if (cached && cached.length) {
      updatePageLoadProgress(30, "Loading from cache...");
      verbose.content(`Found ${cached.length} nodes in IndexedDB`, 'initializePage.js');

      // Populate the gate filter's book-defaults cache from the local library
      // record BEFORE first render — the server-pull loader that normally sets it
      // never runs on a cache hit, and without it the client gate filters the
      // book's annotations by the GLOBAL defaults instead of the creator's.
      const { hydrateBookGateDefaults } = await import('../components/utilities/gateFilter');
      await hydrateBookGateDefaults(currentBook);

      // Capture any pending SPA navigation target before clearing it — we need to
      // resolve it against the cache so initializeLazyLoader renders the correct chunk.
      const spaTarget = (window as any)._pendingChunkTarget || null;
      (window as any)._pendingChunkTarget = null;
      (window as any)._targetResolved = undefined;

      // Migrate old-format footnotes if needed (display numbers → footnote IDs)
      if (hasOldFormatFootnotes(cached)) {
        await migrateOldFormatFootnotes(currentBook, cached);
        // Save migrated nodes back to IndexedDB (lazy migration)
        await saveAllNodesToIndexedDB(cached, currentBook);
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

      // If the INITIAL fetch didn't resolve the target, notify — but do NOT strip the hash from
      // the URL. The target may still exist in a LATER chunk (a deep hypercite in a big book) and
      // resolve after the background download; navigateToInternalId waits for that and retries.
      // Stripping the hash here CORRUPTS the history entry — back/forward to it then lose the
      // target and fall back to a stale saved scroll position (the user-reported "forward goes to
      // a position that doesn't exist → 5s hang"). Keep the hash; let resolution catch up.
      if (!initialResult.targetResolved && window.location.hash) {
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
      // The server bookmark IS the user_reading_positions row (ReadingPosition); seed it into
      // sessionStorage so restoreScrollPosition resumes there. This is the read-back arm of the
      // reading-position lineage: PG → fetchInitialChunk → here → sessionStorage → scroll.
      const bookmark: ReadingPosition | null = initialResult.bookmark ?? null;
      if (bookmark?.element_id && !openHyperlightID && !openFootnoteID) {
        const storageKey = getLocalStorageKey("scrollPosition", currentBook);
        // Carry the server row's updated_at (epoch ms) as `savedAt`. This is what makes
        // cross-device RESUME work: a phone with an empty local navigatedAt store compares this
        // server savedAt against "no navAt" and resumes the bookmark rather than a stale hash.
        const scrollData = JSON.stringify({ elementId: bookmark.element_id, savedAt: bookmark.updated_at ?? Date.now() });
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
        const dbChunks: any = await getNodesFromIndexedDB(currentBook);
        if (dbChunks && dbChunks.length) {
          verbose.content(`Loaded ${dbChunks.length} nodes from PostgreSQL (full sync fallback)`, 'initializePage.js');

          if (hasOldFormatFootnotes(dbChunks)) {
            await migrateOldFormatFootnotes(currentBook, dbChunks);
            await saveAllNodesToIndexedDB(dbChunks, currentBook);
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
      log.error(`Book "${currentBook}" not found in database`, '/pageLoad/loadHyperText.ts');
      updatePageLoadProgress(0, "Book not found");
      throw new Error(`Book "${currentBook}" not found. It may not have been imported yet.`);
    }
  } catch (err: any) {
    log.error('Critical error during content loading', '/pageLoad/loadHyperText.ts', err);
    const firstChunkLoadedResolver = getFirstChunkLoadedResolver();
    if (firstChunkLoadedResolver) {
      firstChunkLoadedResolver();
    }
  }
}


// Note: initializeInteractiveFeatures function removed as it duplicates viewManager.js functionality

// generateNodesFromMarkdown (+ its fetch/url helpers) moved to ./nodeGen so lazyLoaderRegistry
// can import it statically without the old lazyLoaderRegistry↔loadHyperText dynamic cycle-breaker.

// Your existing function - unchanged
function navigateToElement(elementId: string) {
  const element = document.getElementById(elementId);
  if (element) {
    verbose.content(`Navigating to element: ${elementId}`, '/pageLoad/loadHyperText.ts');
    // Paginated mode: flip to the element's page (a native scrollIntoView
    // would scroll the overflow:hidden wrapper and corrupt page geometry).
    if (!maybePaginatorReveal(element)) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else {
    verbose.content(`Element not found: ${elementId}, will try loading more content`, '/pageLoad/loadHyperText.ts');
  }
}

async function checkAndUpdateIfNeeded(bookId: BookId, lazyLoader: any) {
  // 🎯 CRITICAL: Capture any active navigation target at the START of this check.
  // The check runs async and may complete after navigation flags are cleared.
  // By capturing now, we ensure refresh() can find the target even if the barrier cleans up.
  //
  // The URL #hash is only a valid target for THIS book if the URL actually points at it.
  // During a book-to-book SPA transition the URL still shows the PREVIOUS book (it's
  // rewritten only AFTER init), so its #hash belongs to that other book. Adopting it makes
  // refresh() hunt for a foreign element (e.g. another book's hypercite) in this book's DOM,
  // time out after ~560ms, log an error AND show a "target not found" toast — even though the
  // nav itself succeeded (the "stale target searched in the wrong book" bug). Gate the hash
  // fallback on a book-identity match (first path segment, so parent/sub-books of the same
  // book still match; slug-aware via bookSlug). The explicit per-book sources above are
  // always trusted.
  const urlFirstSeg = decodeURIComponent(window.location.pathname).split('/').filter(Boolean)[0] || '';
  const bookFirstSeg = String(bookId).split('/')[0];
  const slugFirstSeg = (bookSlug || '').split('/')[0];
  const urlPointsAtThisBook = urlFirstSeg === bookFirstSeg || (!!slugFirstSeg && urlFirstSeg === slugFirstSeg);
  const hashTargetForThisBook = (urlPointsAtThisBook && window.location.hash)
    ? window.location.hash.substring(1)
    : null;
  const capturedNavigationTarget = lazyLoader?.pendingNavigationTarget ||
                                   NavigationCompletionBarrier.getNavigationTarget() ||
                                   hashTargetForThisBook;


  // Skip server timestamp check when offline - use cached data
  if (!navigator.onLine) {
    verbose.content(`📡 Offline: skipping server check for ${bookId}`, '/pageLoad/loadHyperText.ts');
    return;
  }

  // Skip if background download is in progress (it will bring fresh data)
  if ((window as any)._backgroundDownloadInProgress) {
    verbose.content(`⏳ Background download in progress, skipping timestamp check for ${bookId}`, '/pageLoad/loadHyperText.ts');
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
        verbose.content(`✅ Skipping server timestamp check for newly created book "${bookId}" that is pending sync to bankend.`, '/pageLoad/loadHyperText.ts');
        // ...then we know it doesn't exist on the server yet.
        // There's nothing to compare, so we exit the function early.
        return;
      }
    } catch (e) {
      log.error('Could not parse pending_new_book_sync from sessionStorage', '/pageLoad/loadHyperText.ts', e);
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
    verbose.content(`Async timestamp check for: ${bookId}`, '/pageLoad/loadHyperText.ts');

    // Get both records in parallel
    const [serverRecord, localRecord] = await Promise.all([
      getLibraryRecordFromServer(bookId),
      getLibraryRecordFromIndexedDB(bookId),
    ]);

    // Handle case where server request failed
    if (!serverRecord) {
      log.error(`⚠️ Could not fetch server data for ${bookId}. Skipping timestamp check.`, '/pageLoad/loadHyperText.ts');
      return;
    }

    if (!localRecord) {
      verbose.content(`⚠️ No local data found for ${bookId}. Skipping timestamp check.`, '/pageLoad/loadHyperText.ts');
      return;
    }

    const serverTimestamp = serverRecord.timestamp || 0;
    const localTimestamp = localRecord.timestamp || 0;
    const serverAnnotationsTs = serverRecord.annotations_updated_at || 0;
    const localAnnotationsTs = localRecord.annotations_updated_at || 0;


    // Check if book content changed (nodes)
    if (serverTimestamp > localTimestamp) {
      verbose.content(`🔥 Book content changed for ${bookId}. Surgical refresh for current target...`, '/pageLoad/loadHyperText.ts');

      // Preserve target priority: explicit nav target (deep link in flight) > LIVE anchor.
      // Without a target the fetch below resolves the SERVER resume bookmark — which lags
      // this device by the debounced position save (or doesn't exist yet) — so the refreshed
      // node set misses the reader's position entirely and the book lands at the top.
      let preserveTarget = capturedNavigationTarget;
      if (!preserveTarget && lazyLoader) {
        try {
          lazyLoader.forceSaveScrollPosition?.();
          const live = lazyLoader._scrollAnchor;
          if (live?.element && /^\d+(\.\d+)?$/.test(String(live.element.id))) {
            preserveTarget = String(live.element.id);
          }
        } catch { /* anchor unavailable — fall through untargeted */ }
      }

      // Fetch fresh chunk for the current navigation target (stores all annotations
      // + target chunk to IndexedDB via put semantics — no wipe needed)
      const freshResult = await fetchInitialChunk(bookId, preserveTarget ?? null);

      if (freshResult?.success) {
        // Snapshot the records the reader is CURRENTLY looking at before they
        // are replaced — the visible-change comparison below runs against them.
        const prevNodes = Array.isArray(lazyLoader?.nodes) ? lazyLoader.nodes : null;

        // Update lazyLoader with fresh data for the target chunk
        lazyLoader.nodes = freshResult.nodes;
        (window as any).nodes = freshResult.nodes;
        if (freshResult.chunkManifest) {
          (window as any).chunkManifest = freshResult.chunkManifest;
          lazyLoader.chunkManifest = freshResult.chunkManifest;
        }

        notifyContentUpdated();

        // refresh() is a full teardown+rebuild of every rendered chunk — a
        // visible jolt SECONDS after the reader settled (this check is
        // un-awaited). Only pay that when a node in a currently-rendered chunk
        // actually changed. refresh() re-renders FROM lazyLoader.nodes and the
        // fetch only brought the target chunk's records, so comparing exactly
        // the fetched records against their predecessors is as strong as
        // anything the teardown could display: identical records ⇒ an
        // identical rebuild ⇒ pure jitter. A change elsewhere in the book
        // lands in IndexedDB (put semantics above + the backfill below) and
        // renders fresh when scrolled to.
        const visibleChange = findRenderedContentChange(prevNodes, freshResult.nodes, lazyLoader?.container ?? null);
        recordNavDecision({
          phase: 'timestamp-refresh',
          visibleChange,
          prevCount: prevNodes?.length ?? null,
          freshCount: freshResult.nodes?.length ?? null,
        });
        if (visibleChange === null) {
          verbose.content(`⏭️ Timestamp newer but rendered chunks identical — skipping visible refresh for ${bookId}`, '/pageLoad/loadHyperText.ts');
          // Annotations may still have moved server-side — re-apply them to
          // the visible nodes non-destructively (same path as the
          // annotations-only branch below).
          await reapplyAnnotationsToVisibleNodes(bookId);
        } else {
          if (capturedNavigationTarget) {
            verbose.content(`🎯 Passing captured target to refresh(): ${capturedNavigationTarget}`, '/pageLoad/loadHyperText.ts');
          }

          // Never tear the DOM down under an active gesture: refresh() rips
          // out every chunk (the scroller collapses under the reader's
          // finger) and re-lands — mid-scroll that is unrecoverable jank.
          // Wait for scroll-idle (capped — freshness eventually wins), then
          // re-anchor to wherever the reader ENDED UP, not where they were
          // when the check fired.
          await waitForScrollIdle(15_000);
          if (!capturedNavigationTarget && lazyLoader) {
            try {
              lazyLoader.forceSaveScrollPosition?.();
              const live = lazyLoader._scrollAnchor;
              if (live?.element && /^\d+(\.\d+)?$/.test(String(live.element.id))) {
                preserveTarget = String(live.element.id);
              }
            } catch { /* keep the earlier target */ }
          }

          // 🚦 Register CONTENT_REFRESH before calling refresh() (if barrier is active)
          NavigationCompletionBarrier.registerProcess(NavigationProcess.CONTENT_REFRESH);
          await lazyLoader.refresh(preserveTarget ?? capturedNavigationTarget);
          // 🚦 Signal CONTENT_REFRESH complete
          NavigationCompletionBarrier.completeProcess(NavigationProcess.CONTENT_REFRESH, true);
        }

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
        await lazyLoader.refresh(preserveTarget ?? capturedNavigationTarget);
        NavigationCompletionBarrier.completeProcess(NavigationProcess.CONTENT_REFRESH, true);
      }
      return; // Refresh includes annotations, no need to check further
    }

    // Check if only annotations changed (highlights/hypercites)
    if (serverAnnotationsTs > localAnnotationsTs) {
      verbose.content(
      `Annotations changed for ${bookId}. Syncing annotations only...`, '/pageLoad/loadHyperText.ts'
      );

      // 1. Download latest annotations from backend to IndexedDB
      await syncAnnotationsOnly(bookId);
      await updateLocalAnnotationsTimestamp(bookId, serverAnnotationsTs);

      await reapplyAnnotationsToVisibleNodes(bookId);
    } else {
    }
  } catch (err) {
    log.error("❌ Error during background timestamp check:", '/pageLoad/loadHyperText.ts', err);
  }
}

/**
 * Resolve once the user has been scroll-idle for the detector's window
 * (isUserCurrentlyScrolling: no scroll activity for ~2s), or after maxWaitMs —
 * a destructive refresh deferred forever would mean never-fresh content.
 */
async function waitForScrollIdle(maxWaitMs: number): Promise<void> {
  const { isUserCurrentlyScrolling } = await import('../scrolling/userScrollDetection');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!isUserCurrentlyScrolling()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Non-destructive annotation refresh for the nodes currently in the DOM:
 * rebuild their node arrays from the (already-synced) IndexedDB stores and
 * reprocess highlights in place — no chunk teardown, no scroll movement.
 * Shared by the annotations-only branch and the skip-refresh branch of the
 * timestamp check.
 */
async function reapplyAnnotationsToVisibleNodes(bookId: BookId): Promise<void> {
  const visibleNodeIds = Array.from(
    document.querySelectorAll('[id]:not([data-chunk-id]):not(.sentinel)')
  )
    .filter(el => /^\d+$/.test(el.id)) // Only numeric IDs (node IDs)
    .map(el => el.id);

  if (visibleNodeIds.length === 0) return;

  // Rebuild node arrays from the new standalone tables
  const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../indexedDB/hydration/rebuild');
  const { getNodesFromIndexedDB } = await import('../indexedDB/index');

  // Get nodes to find node_ids for visible startLines
  const allNodes: any = await getNodesFromIndexedDB(bookId);
  const visibleDataNodeIDs = allNodes
    .filter((n: any) => visibleNodeIds.includes(String(n.startLine)))
    .map((n: any) => n.node_id)
    .filter(Boolean);

  if (visibleDataNodeIDs.length > 0) {
    const allNodesToRebuild: any = await getNodesByDataNodeIDs(visibleDataNodeIDs);
    // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
    // node when the same node_id exists in both parent and sub-book.
    const nodesToRebuild = allNodesToRebuild.filter((n: any) => n.book === bookId);
    await rebuildNodeArrays(nodesToRebuild);
  }

  const { reprocessHighlightsForNodes } = await import('../hyperlights/deletion');
  await reprocessHighlightsForNodes(bookId, visibleNodeIds);
}

/**
 * null when every fetched node that belongs to a currently-RENDERED chunk is
 * identical (identity + content) to the record the reader is already looking
 * at — i.e. a refresh() teardown would rebuild pixel-identical chunks. A
 * string names the FIRST difference found (the caller records it into the
 * scroll trace, so forensics dumps show why a visible refresh ran).
 * Annotation views are deliberately NOT compared: annotation-only movement is
 * re-applied in place by reapplyAnnotationsToVisibleNodes. Sub-book chunks are
 * excluded (their chunk ids belong to other books and collide numerically).
 * Any doubt — fresh set covers no rendered chunk, missing container, empty
 * inputs — reports a difference (refresh; correctness over stillness).
 */
function findRenderedContentChange(
  prevNodes: any[] | null,
  freshNodes: any[] | null,
  container: Element | null
): string | null {
  if (!container) return 'no-container';
  if (!prevNodes?.length) return 'no-prev-nodes';
  if (!freshNodes?.length) return 'no-fresh-nodes';

  const rendered = new Set<number>();
  container.querySelectorAll('.chunk[data-chunk-id]').forEach((el) => {
    if (el.closest('.sub-book-content')) return;
    const id = parseFloat((el as HTMLElement).dataset.chunkId ?? '');
    if (!Number.isNaN(id)) rendered.add(id);
  });
  if (rendered.size === 0) return 'no-rendered-chunks';

  // no-delete-id is the RETIRED last-node marker — nothing stamps it anymore
  // (the invariant is a runtime check now: keydownGuards/lastNodeGuard), but
  // it still lives inside STORED content: books not yet swept by
  // `content:strip-no-delete-markers`, and E2EE books forever (their content
  // is ciphertext, unsweepable server-side). One side of a compare can carry
  // it while the other doesn't, and left in it defeats this skip on EVERY
  // timestamp check (the refresh-storm forensics diff@120). Keep this
  // normalization for as long as any stored content can carry the attribute.
  const normalize = (html: string) => html.replace(/\s*no-delete-id="please"/g, '');
  const sig = (n: any) => `${n.startLine}\u0001${n.node_id ?? ''}\u0001${normalize(n.content ?? '')}`;
  const byChunk = (nodes: any[]) => {
    const m = new Map<number, string[]>();
    for (const n of nodes) {
      const c = Number(n.chunk_id);
      if (!rendered.has(c)) continue;
      let arr = m.get(c);
      if (!arr) { arr = []; m.set(c, arr); }
      arr.push(sig(n));
    }
    return m;
  };
  const prev = byChunk(prevNodes);
  const fresh = byChunk(freshNodes);
  if (fresh.size === 0) {
    const freshChunks = [...new Set(freshNodes.map((n: any) => Number(n.chunk_id)))].join('/');
    return `fresh-covers-no-rendered-chunk(rendered=${[...rendered].join('/')} fresh=${freshChunks})`;
  }

  for (const [chunkId, freshSigs] of fresh) {
    const prevSigs = prev.get(chunkId);
    if (!prevSigs) return `chunk-${chunkId}-missing-in-prev`;
    if (prevSigs.length !== freshSigs.length) {
      return `chunk-${chunkId}-count(${prevSigs.length}->${freshSigs.length})`;
    }
    const a = [...prevSigs].sort();
    const b = [...freshSigs].sort();
    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? '';
      const bv = b[i] ?? '';
      if (av !== bv) {
        // Report the WINDOW around the first divergent character — the head of
        // a node sig is usually identical (id + node_id + tag opening), and a
        // truncated head reads as "identical" in the forensics dump.
        let d = 0;
        while (d < av.length && d < bv.length && av[d] === bv[d]) d++;
        const from = Math.max(0, d - 40);
        return `chunk-${chunkId}-node-diff@${d}(prev="…${av.slice(from, d + 80)}" fresh="…${bv.slice(from, d + 80)}")`;
      }
    }
  }
  return null;
}

// Helper function to get library record from server
async function getLibraryRecordFromServer(bookId: BookId): Promise<any> {
  try {
    const response = await fetch(buildLibraryUrl(bookId), {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    const data = await response.json();

    return data.success ? data.library : null;
  } catch (err) {
    // Best-effort freshness check only — the caller handles a null return by
    // skipping the timestamp comparison and using cached IndexedDB data, so a
    // failure here never breaks loading. A bare fetch() also rejects with
    // "TypeError: Failed to fetch" when SPA navigation cancels it mid-flight
    // (e.g. rapid back/forward), which is benign. Warn, don't error.
    console.warn("⚠️ Could not fetch library record from server (using cached data):", err);
    return null;
  }
}

// Helper function to get library record from IndexedDB
async function getLibraryRecordFromIndexedDB(bookId: BookId): Promise<any> {
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
    log.error("❌ Error accessing library record in IndexedDB:", '/pageLoad/loadHyperText.ts', err);
    return null;
  }
}

// Optional: Function to notify UI that content was updated
function notifyContentUpdated() {
  // Example: dispatch custom event
  window.dispatchEvent(new CustomEvent('contentUpdated', {
    detail: { bookId: book }
  }));
}
