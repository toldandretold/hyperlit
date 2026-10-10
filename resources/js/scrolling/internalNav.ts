/**
 * scrolling/internalNav — navigate to an internal id (highlight / hypercite /
 * footnote / paragraph): resolve which chunk holds it, load that chunk, wait for
 * DOM readiness, then scroll. Includes the default-content + fallback paths.
 *
 * Back-edges to hyperlights / hypercites / lazyLoaderFactory / initializePage are
 * dynamic imports so this folder has no static import cycle with them.
 */
import { verbose } from '../utilities/logger';
import { NavigationCompletionBarrier, NavigationProcess } from '../SPA/navigation/NavigationCompletionBarrier.js';
import { getNodesFromIndexedDB, getLocalStorageKey } from '../indexedDB/index.js';
import { parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown';
import { waitForNavigationTarget, waitForElementReady } from '../SPA/domReadiness';
import { navTimers, userScrollState } from './navState';
import { recordNavigatedAt } from './navStamp';
import { showNavigationLoading, hideNavigationLoading, NavigationProgressIndicator } from './navOverlay';
import { scrollElementWithConsistentMethod, scrollElementIntoMainContent } from './scrollHelpers';
import { isPaginatorEngaged } from './paginator';
import { shouldSkipScrollRestoration } from './userScrollDetection';
import { nextScrollReason, recordScrollWrite, recordNavDecision } from './scrollTrace';
// Static, downward import from a zero-import leaf (no cycle). pendingFirstChunkLoadedPromise is a
// live binding (reset per load) — read at await time.
import { pendingFirstChunkLoadedPromise } from '../pageLoad/firstChunkPromise';
// Feature actions via the DI registry leaf (registered at bootstrap) — no upward import into
// hyperlights / hyperlitContainer, no dynamic-import cycle-breaker.
import { openHighlightById, handleUnifiedContentClick } from '../hyperlitContainer/containerActions';

// Adjusted helper: load default content if container is empty.
export async function loadDefaultContent(lazyLoader: any): Promise<void> {
  verbose.nav("Loading default content (first chunk)...", 'scrolling/internalNav');

  // Check if we already have nodes
  if (!lazyLoader.nodes || lazyLoader.nodes.length === 0) {
    verbose.nav("No nodes in memory, trying to fetch from IndexedDB...", 'scrolling/internalNav');
    try {
      let cachedNodes = await getNodesFromIndexedDB(lazyLoader.bookId);
      if (cachedNodes && cachedNodes.length > 0) {
        verbose.nav(`Found ${cachedNodes.length} chunks in IndexedDB`, 'scrolling/internalNav');
        lazyLoader.nodes = cachedNodes;
      } else {
        // Fallback: fetch markdown and parse
        verbose.nav("No cached chunks found. Fetching main-text.md...", 'scrolling/internalNav');
        const response = await fetch(`/${lazyLoader.bookId}/main-text.md`);
        if (!response.ok) {
          throw new Error(`Failed to fetch markdown: ${response.status}`);
        }
        const markdown = await response.text();
        lazyLoader.nodes = parseMarkdownIntoChunksInitial(markdown);
        verbose.nav(`Parsed ${lazyLoader.nodes.length} chunks from markdown`, 'scrolling/internalNav');
      }
    } catch (error) {
      console.error("Error loading content:", error);
      throw error; // Re-throw to handle in the calling function
    }
  }

  // Clear container and load first chunk
  // ⚠️ DIAGNOSTIC: Log when container is cleared
  const childCount = lazyLoader.container.children.length;
  if (childCount > 0) {
    console.warn(`⚠️ CONTAINER CLEAR (loadDefaultContent): ${childCount} children removed`, {
      stack: new Error().stack,
      timestamp: Date.now()
    });
  }
  lazyLoader.container.innerHTML = "";

  // Find chunks with chunk_id === 0
  const firstChunks = lazyLoader.nodes.filter((node: any) => node.chunk_id === 0);
  if (firstChunks.length === 0) {
    console.warn("No chunks with ID 0 found! Loading first available chunk instead.");
    if (lazyLoader.nodes.length > 0) {
      lazyLoader.loadChunk(lazyLoader.nodes[0].chunk_id, "down");
    } else {
      throw new Error("No chunks available to load");
    }
  } else {
    verbose.nav(`Loading ${firstChunks.length} chunks with ID 0`, 'scrolling/internalNav');
    firstChunks.forEach((node: any) => {
      lazyLoader.loadChunk(node.chunk_id, "down");
    });
  }

  // Ensure sentinels are properly positioned. The lazy loader always exposes this as an instance
  // method (see createLazyLoader), so we call it directly — no import of lazyLoader needed (which
  // would be an upward edge: lazyLoader already imports scrolling).
  if (typeof lazyLoader.repositionSentinels === "function") {
    lazyLoader.repositionSentinels();
  }

  // Verify content was loaded
  if (lazyLoader.container.children.length === 0) {
    console.error("Failed to load any content into container!");
    throw new Error("No content loaded");
  }

  verbose.nav("Default content loaded successfully", 'scrolling/internalNav');
}

/**
 * Fallback function that tries to load a saved scroll position or scrolls to top
 */
export async function fallbackScrollPosition(lazyLoader: any): Promise<void> {
  if (shouldSkipScrollRestoration("fallbackScrollPosition")) {
    return;
  }

  const chunkElements = Array.from(lazyLoader.container.children).filter(
    (el: any) => el.classList.contains("chunk")
  );

  // If no chunks, load default content
  if (chunkElements.length === 0) {
    try {
      await loadDefaultContent(lazyLoader);
    } catch (error) {
      console.error("Failed to load default content:", error);
      const errorDiv = document.createElement('div');
      errorDiv.className = "chunk";
      errorDiv.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";

      // Attribute selector, not `#${id}`: a two-segment sub-book id (e.g. `book_X/AIreview`)
      // contains a `/`, which is an invalid CSS id selector and would throw a SyntaxError.
      const bottomSentinel = lazyLoader.container.querySelector(`[id="${lazyLoader.bookId}-bottom-sentinel"]`);
      if (bottomSentinel) {
        lazyLoader.container.insertBefore(errorDiv, bottomSentinel);
      } else {
        lazyLoader.container.appendChild(errorDiv);
      }
      return;
    }
  }

  // Try to find a saved scroll position
  const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
  let savedTargetId: string | null = null;

  // Check session storage first, then local storage
  try {
    const sessionData = sessionStorage.getItem(scrollKey);
    if (sessionData && sessionData !== "0") {
      const parsed = JSON.parse(sessionData);
      if (parsed?.elementId) savedTargetId = parsed.elementId;
    }

    if (!savedTargetId) {
      const localData = localStorage.getItem(scrollKey);
      if (localData && localData !== "0") {
        const parsed = JSON.parse(localData);
        if (parsed?.elementId) savedTargetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.warn("Error reading saved scroll position", e);
  }

  // Scroll to saved target if it exists
  if (savedTargetId) {
    const targetElement = lazyLoader.container.querySelector(`#${CSS.escape(savedTargetId)}`);
    if (targetElement) {
      nextScrollReason('fallback-saved-target');
      scrollElementIntoMainContent(targetElement, 50);
      return;
    }
  }

  // Fallback to top of page (ORIGINAL behaviour — left intact while we diagnose; the trace tag
  // makes this jump attributable so a real failure shows whether this is the line that fired).
  nextScrollReason('fallback-TOP');
  lazyLoader.container.scrollTo({ top: 0, behavior: "smooth" });
}

// Define helper function OUTSIDE the main function
function calculateScrollDelay(element: any, container: any, targetId: string): number {
  let delay = 100; // Default short delay

  if (element) {
    // Check if element is in viewport
    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const isVisible = (
      rect.top >= containerRect.top &&
      rect.bottom <= containerRect.bottom &&
      rect.left >= containerRect.left &&
      rect.right <= containerRect.right
    );

    if (!isVisible) {
      // Element exists but not visible - needs scrolling
      delay = 400;
      verbose.nav(`Element ${targetId} needs scrolling, using ${delay}ms delay`, 'scrolling/internalNav');
    } else {
      // Element is already visible - minimal delay
      delay = 100;
      verbose.nav(`Element ${targetId} already visible, using ${delay}ms delay`, 'scrolling/internalNav');
    }
  } else {
    // Element doesn't exist yet - will need loading and scrolling
    delay = 800;
    verbose.nav(`Element ${targetId} not loaded yet, using ${delay}ms delay`, 'scrolling/internalNav');
  }

  return delay;
}

/**
 * `citation_<refId>` is a URL-hash namespace for the reference panel (history.ts determineSingleContentHash),
 * NOT a DOM id — the in-text citation marker is `<a id="<refId>">` (bare). Every other content type's hash
 * prefix matches its element id (`hypercite_…`, `HL_…`); citation is the lone exception. Strip the prefix so
 * we resolve/scroll to the real anchor instead of spinning 12 attempts on a nonexistent `citation_<refId>`.
 */
function toScrollTargetId(id: string): string {
  return id.startsWith('citation_') ? id.slice('citation_'.length) : id;
}

/**
 * A citation reference id (`Ref<digits>_<rand>`, the `<a id="Ref…" class="citation-ref">` in-text
 * marker). It is a SOFT scroll target: the reference panel is its real destination, and the in-text
 * marker only exists in the CITING book. A stale citation target replayed onto a DIFFERENT book
 * (e.g. after "Open source" hops to the source book) will never resolve there — so we bail quietly
 * rather than loading a fallback chunk, spinning waitForNavigationTarget, and toasting "start of book".
 */
function isCitationRefTarget(id: string): boolean {
  return /^Ref\d/.test(id);
}

/**
 * Is this annotation target NAMED by the address bar — i.e. did the user ask for it?
 *
 * The same leak the `Ref…` soft-target guard above describes is not confined to citation refs:
 * an `HL_`/`hypercite_` id captured in book A gets replayed after a book change and arrives here
 * against book B's lazyLoader. B has never heard of it, so it falls through to "no block found →
 * load a fallback chunk → scroll to the top → toast". Measured on the AI-review round trip: the
 * reader sat on the `/AIreview` report and got "Couldn't find 'HL_4002887421' — showing start of
 * book", HL_4002887421 being a highlight in the PARENT book. The report has no such mark, so the
 * screen showed an open container over text with nothing highlighted in it — and because none of
 * that throws, the e2e phase covering this round trip passed through it for every loop.
 *
 * The discriminator is intent. A target the URL names is a deep link the user followed, and
 * "couldn't find it, here's the start" is the right answer. A target the URL does NOT name is
 * internal machinery replaying stale state — answering it by throwing away the reader's position
 * and toasting is wrong twice over, and the correct response is to do nothing at all.
 *
 * Deliberately generous about what counts as "named": the hash can carry the id bare (`#HL_1`),
 * prefixed (`#citation_Ref1`) or alongside a container-stack param, and sub-book paths carry it
 * as a segment (`/book_x/Fn12`). Generosity errs toward today's behaviour — the quiet bail only
 * fires when the id appears NOWHERE in the URL.
 */
function isTargetNamedByUrl(targetId: string): boolean {
  try {
    const { pathname, hash } = window.location;
    return `${pathname}${hash}`.includes(targetId);
  } catch {
    return true; // can't tell → behave as before
  }
}

export function navigateToInternalId(targetId: string, lazyLoader: any, showOverlay = true, scrollOffset: number | null = null, opts: { suppressContainerOpen?: boolean } = {}): Promise<any> {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return Promise.reject(new Error("Lazy loader instance not provided"));
  }
  targetId = toScrollTargetId(targetId);
  // A caller that already owns an open hyperlit container (the prev/next arrow
  // swap in hyperlitContainer/highlightNav) scrolls WITHOUT the auto-open below
  // — otherwise the 200ms open would stack a second container over the swap.
  (lazyLoader as any)._suppressContainerOpenFor = opts.suppressContainerOpen ? targetId : null;
  // Pin deep-link targets: the pinned set exempts them from the client gate and rides
  // every bulk fetch as `pinned=` / `pinned_hl=` so later re-syncs can't strip the
  // record either. (Harmless for ungated targets; essential for gated/'single' ones —
  // a shared #HL_ link is explicit intent to see that highlight, whatever the gate says.)
  if (targetId.startsWith('hypercite_') || targetId.startsWith('HL_')) {
    void import('../components/utilities/gateFilter')
      .then(m => targetId.startsWith('hypercite_') ? m.pinHypercite(targetId) : m.pinHyperlight(targetId))
      .catch(() => { /* non-fatal — fetch-on-demand still pins later */ });
  }
  // Where to land the target's top, in px from the scroll container's top edge. Deep-link targets
  // (hypercite / highlight / footnote) use the 192px header offset so they clear the sticky header.
  // A reading-position RESUME passes the saved sub-node offset so refresh lands on the exact pixel
  // the reader was at (see restoreScrollPosition + forceSavePosition). null → default header offset.
  const landingOffset = (scrollOffset === null || Number.isNaN(scrollOffset)) ? 192 : scrollOffset;
  (lazyLoader as any)._pendingLandingOffset = landingOffset;
  // Paginated-mode resume: the saved offset is a PAGE count into a multi-page
  // node (forceSavePosition's pages branch), not a pixel offset. A deep-link
  // JUMP (scrollOffset null) carries no page offset — target its first page.
  (lazyLoader as any)._pendingPageOffset =
    (scrollOffset !== null && Number.isFinite(scrollOffset)) ? scrollOffset : 0;
  verbose.nav(`Initiating navigation to internal ID: ${targetId}`, 'scrolling/internalNav');

  // 🔢 Supersede epoch: a NEW navigation on this loader invalidates any nav
  // still in flight. The shared slots below (_navigationResolve, the flags,
  // the cleanup timer) hold ONE navigation's state — before this epoch, two
  // interleaved navs (e.g. the resume restore vs the curtain's go-to-top)
  // both kept running: the stale one repositioned sentinels, scheduled the
  // cleanup timer over the new nav's, and its fillViewport prepend-shoved the
  // viewport off the new landing (forensics: 0 → 13523px). _navigateToInternalId
  // checks the epoch after each await cluster and silently stops when stale.
  lazyLoader._navEpoch = (lazyLoader._navEpoch || 0) + 1;
  const myNavEpoch = lazyLoader._navEpoch;

  // 🚀 Return a Promise that resolves when navigation is truly complete
  // This fixes iOS Safari race condition where scroll restoration interferes
  return new Promise((resolve, reject) => {
    // A superseded nav's promise must still settle — its caller may be awaiting
    // it (RevealGate, chain opens). Resolve it as a non-success before the slot
    // is overwritten, so the stale nav can never resolve the NEW nav's promise.
    if (lazyLoader._navigationResolve) {
      lazyLoader._navigationResolve({ success: false, targetId: lazyLoader.pendingNavigationTarget, superseded: true });
      lazyLoader._navigationResolve = null;
      lazyLoader._navigationReject = null;
    }

    // Store resolve/reject on lazyLoader so _navigateToInternalId can call them
    lazyLoader._navigationResolve = resolve;
    lazyLoader._navigationReject = reject;

    // 🚀 CRITICAL: Set flag IMMEDIATELY to prevent race conditions
    // This prevents restoreScrollPosition() from interfering
    lazyLoader.isNavigatingToInternalId = true;
    lazyLoader.pendingNavigationTarget = targetId; // Store target for refresh() to use
    verbose.nav(`Set isNavigatingToInternalId = true for ${targetId}`, 'scrolling/internalNav');

    // 🚦 Start the NavigationCompletionBarrier to coordinate async processes
    // This ensures flags persist until scroll completes. If a timestamp check triggers
    // a refresh, the captured navigation target is passed directly to refresh().
    NavigationCompletionBarrier.startNavigation(targetId, lazyLoader);
    NavigationCompletionBarrier.registerProcess(NavigationProcess.SCROLL_COMPLETE);

    // 🎯 Show loading indicator with progress tracking (only if requested)
    const progressIndicator: NavigationProgressIndicator = showOverlay ? showNavigationLoading(targetId) : { updateProgress: () => {}, setMessage: () => {} };

    // 🔒 NEW: Lock scroll position during navigation
    if (lazyLoader.lockScroll) {
      lazyLoader.lockScroll(`navigation to ${targetId}`);

      // 🔄 NEW: Detect user scroll and unlock immediately
      let userScrollDetected = false;
      const detectUserScroll = (event?: any) => {
        if (!userScrollDetected && lazyLoader.scrollLocked) {
          verbose.nav('User scroll detected during navigation, unlocking immediately', 'scrolling/internalNav');
          userScrollDetected = true;
          lazyLoader.unlockScroll();

          // 🚦 Abort the navigation barrier - user is taking control
          NavigationCompletionBarrier.abort();

          // Remove the listener once we've detected user scroll
          lazyLoader.scrollableParent.removeEventListener('wheel', detectUserScroll);
          lazyLoader.scrollableParent.removeEventListener('touchstart', detectUserScroll);
          lazyLoader.scrollableParent.removeEventListener('keydown', detectUserScroll);
        }
      };

      // Listen for user scroll inputs (mouse wheel, touch, keyboard)
      lazyLoader.scrollableParent.addEventListener('wheel', detectUserScroll, { passive: true });
      lazyLoader.scrollableParent.addEventListener('touchstart', detectUserScroll, { passive: true });
      lazyLoader.scrollableParent.addEventListener('keydown', detectUserScroll, { passive: true });

      // Clean up listeners after navigation timeout
      setTimeout(() => {
        lazyLoader.scrollableParent.removeEventListener('wheel', detectUserScroll);
        lazyLoader.scrollableParent.removeEventListener('touchstart', detectUserScroll);
        lazyLoader.scrollableParent.removeEventListener('keydown', detectUserScroll);
      }, 2000);
    }

    // 🚀 FIX: Clear session storage when explicitly navigating to prevent cached position interference
    if (targetId && targetId.trim() !== '') {
      const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
      verbose.nav(`Clearing session scroll cache for explicit navigation to: ${targetId}`, 'scrolling/internalNav');
      sessionStorage.removeItem(scrollKey);
    }

    _navigateToInternalId(targetId, lazyLoader, progressIndicator, myNavEpoch);
  });
}

/**
 * Find the deep-link target element if it is ALREADY rendered in `container` — a hypercite `<u id>`
 * (incl. overlapping `u[data-overlapping]`), a highlight `<mark id|class>`, or any element by id
 * (footnote sup / node). Returns the element or null.
 *
 * This is what makes a deep-link FLASH-free: when the target is already in the DOM (e.g. a server
 * prerendered + adopted chunk), navigation scrolls straight to it instead of clearing `<main>` and
 * re-rendering the chunk. Mirrors the post-clear fallback selectors below — keep them in sync.
 */
export function findRenderedTarget(container: any, targetId: string): any {
  if (!container || !targetId) return null;
  const direct = container.querySelector(`#${CSS.escape(targetId)}`);
  if (direct) return direct;
  if (targetId.startsWith('hypercite_')) {
    for (const u of container.querySelectorAll('u[data-overlapping]')) {
      const ids = u.getAttribute('data-overlapping');
      if (ids && ids.split(',').map((id: string) => id.trim()).includes(targetId)) return u;
    }
  }
  if (targetId.startsWith('HL_')) {
    const mark = container.querySelector(`mark.${CSS.escape(targetId)}`);
    if (mark) return mark;
  }
  return null;
}

async function _navigateToInternalId(targetId: string, lazyLoader: any, progressIndicator: NavigationProgressIndicator | null = null, myNavEpoch: number = 0): Promise<void> {
  // Gesture stamp at navigation start: the resolver/render waits below can take
  // SECONDS (held images, slow network), and if the reader gestures during that
  // wait they have taken over — the eventual landing write would yank the page
  // out from under them (prepend-forensics: landing at t≈5.5s mid scroll-up).
  // Checked right before the final positioning scroll.
  const gestureStampAtNavStart = userScrollState.lastGestureScrollTime;

  // Superseded by a NEWER navigateToInternalId call on this loader? Then every
  // shared slot (flags, promise, cleanup timer, barrier) now belongs to that
  // nav — this one must stop SILENTLY: no state writes, no scroll, no cleanup
  // scheduling. Its promise was already resolved {superseded:true} at the
  // moment of the takeover. Checked after each await cluster below.
  const isSuperseded = () => lazyLoader._navEpoch !== myNavEpoch;
  const bailIfSuperseded = (where: string): boolean => {
    if (!isSuperseded()) return false;
    verbose.nav(`Navigation to ${targetId} superseded (${where}) — stopping silently`, 'scrolling/internalNav');
    recordNavDecision({ phase: 'nav-superseded', targetId, where });
    return true;
  };

  // Check if the target element is already present and fully rendered (e.g. a server-prerendered +
  // adopted chunk). If so, the resolver + clear+re-render block below is SKIPPED — we scroll straight
  // to it (no deep-link flash). Covers hypercite / highlight / footnote / node targets.
  let existingElement = findRenderedTarget(lazyLoader.container, targetId);

  // Update progress - DOM check
  if (progressIndicator) {
    progressIndicator.updateProgress(20, "Checking if element is in DOM...");
  }

  // 🔍 Make the navigation legible: was the target ALREADY rendered (scroll-straight, no resolver)?
  recordNavDecision({ phase: 'nav-target', targetId, alreadyRendered: !!existingElement });

  let targetElement = existingElement;
  let elementsReady = false;

  if (existingElement) {
    try {
      // 🚀 Verify the element is actually ready before proceeding
      verbose.nav(`Found existing element ${targetId}, verifying readiness...`, 'scrolling/internalNav');

      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Verifying element readiness...");
      }

      targetElement = await waitForElementReady(targetId, {
        maxAttempts: 5, // Quick check since element exists
        checkInterval: 20,
        container: lazyLoader.container
      });

      verbose.nav(`Existing element ${targetId} confirmed ready`, 'scrolling/internalNav');
      elementsReady = true;

    } catch (error: any) {
      console.warn(`⚠️ Existing element ${targetId} not fully ready: ${error.message}. Proceeding with chunk loading...`);
      // Continue to chunk loading logic below
      targetElement = null;
    }
  }

  // If element not ready, determine which chunk should contain the target
  if (!elementsReady) {
    if (progressIndicator) {
      progressIndicator.updateProgress(30, "Looking up target in content chunks...");
    }

    // Unified resolver: queries IndexedDB stores (hypercites, hyperlights,
    // footnotes, nodes) to find which chunk contains the target.
    const { resolveTargetChunkId } = await import('../SPA/navigation/resolveTargetChunk.js');
    let resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
      chunkManifest: lazyLoader.chunkManifest,
      nodes: lazyLoader.nodes,
    });

    // 🔍 The decisive fact: did THIS book resolve the id to a chunk, and how? `resolved:false` with
    // reason 'saved_position'/'lowest_chunk' = "couldn't find the id, falling back" — the failure.
    recordNavDecision({ phase: 'nav-resolve', targetId, resolved: resolution.resolved, reason: resolution.reason, chunkId: resolution.chunkId, fullyLoaded: !!lazyLoader.isFullyLoaded });

    verbose.nav(
      `Resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
      'scrolling/internalNav'
    );

    // 🩹 Soft-target guard: a citation ref that didn't resolve against THIS book's node store is a
    // stale/foreign target (the in-text marker lives in the citing book, not here). The content-scan
    // resolver reads the full nodes store, so a real in-text marker in this book WOULD resolve — an
    // unresolved one means it isn't here. Bail quietly: no background-download wait, no fallback
    // chunk, no 12-attempt spin, no "showing start of book" toast. The stack names who replayed the
    // stale target across the book change (it shouldn't have leaked — see the open root-cause note).
    if (!resolution.resolved && isCitationRefTarget(targetId)) {
      console.warn(`⚠️ Citation ref "${targetId}" not in book ${lazyLoader.bookId} — skipping main-text scroll (soft target). Replayed by:`, new Error().stack);
      hideNavigationLoading();
      NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      if (lazyLoader.unlockScroll) lazyLoader.unlockScroll();
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: false, targetId, fallback: true, soft: true });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }
      return;
    }

    // If the resolver couldn't find the target and the book isn't fully loaded,
    // wait for the background download to complete and retry with the full dataset.
    //
    // `isFullyLoaded` is derived as `!chunkManifest` (lazyLoader/index.ts), and loadHyperText
    // nulls the manifest on the local-cache path — so a book that is still DOWNLOADING reports
    // itself fully loaded and this retry is skipped. The target then "can't be found", the reader
    // is thrown to the top of the book and toasted, purely because the chunk holding it hadn't
    // arrived yet. Caught by the suite-wide target-not-found gate as `Couldn't find '1500' —
    // showing start of book` on a freshly created book, where 1500 was simply a node in a chunk
    // still in flight. Ask the download itself (book-scoped — see the background-download review
    // gate) rather than trusting the derived flag.
    // A third way to be "not loaded yet" that neither flag reports: the navigation ran before the
    // book's data arrived at all. The reader initialises with the server's instant-paint chunk, so
    // `nodes` holds a single node, the manifest is null (→ isFullyLoaded true) and the background
    // download has not STARTED (→ not in flight). The resolver then searches a one-node dataset,
    // finds nothing, and answers a perfectly valid deep link with "showing start of book". Caught
    // by the suite-wide gate on a back/forward to `/book_x#hypercite_…` whose target existed the
    // whole time. Re-read the store once before believing a miss on a dataset this small.
    if (!resolution.resolved && (lazyLoader.nodes?.length ?? 0) <= 1) {
      const freshNodes = await getNodesFromIndexedDB(lazyLoader.bookId);
      if (freshNodes && freshNodes.length > (lazyLoader.nodes?.length ?? 0)) {
        lazyLoader.nodes = freshNodes;
        (window as any).nodes = freshNodes;
        resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
          chunkManifest: lazyLoader.chunkManifest,
          nodes: lazyLoader.nodes,
        });
        recordNavDecision({ phase: 'nav-resolve-cold', targetId, resolved: resolution.resolved, reason: resolution.reason, chunkId: resolution.chunkId });
        verbose.nav(
          `Cold-dataset retry for "${targetId}": resolved=${resolution.resolved}, chunk=${resolution.chunkId} (nodes ${freshNodes.length})`,
          'scrolling/internalNav'
        );
      }
    }

    // NOTE: `isFullyLoaded` is derived as `!chunkManifest`, which loadHyperText nulls on the
    // local-cache path — so a still-downloading book can report itself complete and skip this
    // retry. Gating on `isBackgroundDownloadInProgress(bookId)` as well was tried and REVERTED:
    // it makes navigation block on the whole background download far more often, and the grand
    // tour's lap phases started timing out at 15s (a different phase each run). The cold-dataset
    // retry above covers the case that motivated it at a fraction of the cost.
    if (!resolution.resolved && !lazyLoader.isFullyLoaded) {
      verbose.nav(`Target "${targetId}" not found in partial data — waiting for background download...`, 'scrolling/internalNav');
      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Loading remaining book data...");
      }

      const { waitForBackgroundDownload } = await import('../pageLoad/backgroundDownload');
      await waitForBackgroundDownload(lazyLoader.bookId);
      if (bailIfSuperseded('background-download')) return;

      // Refresh nodes from IndexedDB now that all chunks are downloaded
      const freshNodes = await getNodesFromIndexedDB(lazyLoader.bookId);
      if (freshNodes && freshNodes.length > 0) {
        lazyLoader.nodes = freshNodes;
        lazyLoader.chunkManifest = null;
        (window as any).nodes = freshNodes;
      }

      // Retry the resolver with the complete dataset
      resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
        chunkManifest: lazyLoader.chunkManifest,
        nodes: lazyLoader.nodes,
      });

      recordNavDecision({ phase: 'nav-resolve-retry', targetId, resolved: resolution.resolved, reason: resolution.reason, chunkId: resolution.chunkId });
      verbose.nav(
        `Retry resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
        'scrolling/internalNav'
      );
    }

    // 🔗 Fetch-on-demand: a hypercite/hyperlight target absent from the bulk sync
    // (gate-filtered, or a foreign 'single' — e.g. an externally-pasted link that hasn't
    // been cited yet) is not in IDB at all. Pull just that record, pin it, rebuild its
    // nodes' embedded arrays, and re-resolve so the normal render/scroll/glow path runs.
    // A truly-deleted target still falls through to the existing toast fallback below.
    if (!resolution.resolved && (targetId.startsWith('hypercite_') || targetId.startsWith('HL_'))) {
      if (progressIndicator) {
        progressIndicator.updateProgress(45, targetId.startsWith('HL_') ? "Fetching highlight target..." : "Fetching citation target...");
      }
      let fetched: any = null;
      if (targetId.startsWith('hypercite_')) {
        const { fetchAndPinHypercite } = await import('../indexedDB/hypercites/helpers');
        fetched = await fetchAndPinHypercite(lazyLoader.bookId, targetId);
      } else {
        const { fetchAndPinHyperlight } = await import('../indexedDB/highlights/helpers');
        fetched = await fetchAndPinHyperlight(lazyLoader.bookId, targetId);
      }
      if (fetched) {
        const freshNodes = await getNodesFromIndexedDB(lazyLoader.bookId);
        if (freshNodes && freshNodes.length > 0) {
          lazyLoader.nodes = freshNodes;
          (window as any).nodes = freshNodes;
        }
        resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
          chunkManifest: lazyLoader.chunkManifest,
          nodes: lazyLoader.nodes,
        });
        // The containing chunk may already be rendered WITHOUT the cite (it arrived before
        // the record did) — evict it so the loader re-renders with the fresh embedded array.
        if (resolution.resolved && lazyLoader.currentlyLoadedChunks?.has?.(resolution.chunkId) && !findRenderedTarget(lazyLoader.container, targetId)) {
          lazyLoader.container.querySelector(`[data-chunk-id="${resolution.chunkId}"]`)?.remove();
          lazyLoader.currentlyLoadedChunks.delete(resolution.chunkId);
        }
        recordNavDecision({ phase: 'nav-fetch-on-demand', targetId, resolved: resolution.resolved, reason: resolution.reason, chunkId: resolution.chunkId });
        verbose.nav(
          `Fetch-on-demand for "${targetId}": resolved=${resolution.resolved}, chunk=${resolution.chunkId}`,
          'scrolling/internalNav'
        );
      }
    }

    if (bailIfSuperseded('post-resolve')) return;

    // A target that belongs to a DIFFERENT book, replayed here by internal machinery rather than
    // followed by the user (see isTargetNamedByUrl). It has now survived the background-download
    // retry AND fetch-on-demand, so it isn't this book's — and since the URL never named it,
    // nobody is waiting to be shown it. Bail where the citation-ref guard bails: no fallback
    // chunk, no scroll to the top, no toast. Taking the reader's position away over a target they
    // never asked for is a worse answer than doing nothing.
    //
    // Applies to EVERY id shape, not just annotations. The suite-wide gate caught the numeric
    // flavour immediately: a one-node book (startLine 100) freshly created by the user→reader
    // cycle was told to navigate to line 1500 — a node from the previous book, still held in
    // memory — and answered by toasting and jumping the reader to the top of a book they had
    // just opened. Nothing in localStorage pointed there; it was purely a carried-over target.
    //
    // ONLY when the reader already has content on screen. The fallback below does double duty:
    // it scrolls somewhere AND it loads a chunk, so bailing before it on a book with nothing
    // rendered leaves a BLANK reader — which is how a first cut of this guard broke the grand
    // tour's three-lap and forward-replay phases (the next step timed out waiting for a page
    // that never finished painting). With content already up, the fallback is pure hijack and
    // skipping it is the whole point.
    const hasRenderedContent = !!lazyLoader.container?.querySelector?.('[data-chunk-id]');
    if (!resolution.resolved && !isTargetNamedByUrl(targetId) && hasRenderedContent) {
      verbose.nav(`Stale target "${targetId}" replayed onto book ${lazyLoader.bookId} (URL does not name it) — bailing quietly`, 'scrolling/internalNav');
      hideNavigationLoading();
      NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      if (lazyLoader.unlockScroll) lazyLoader.unlockScroll();
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: false, targetId, fallback: true, soft: true });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }
      return;
    }

    // If the primary target couldn't be resolved, show fallback UI
    if (!resolution.resolved) {
      console.warn(
        `No block found for target ID "${targetId}" (reason: ${resolution.reason}). ` +
          `Fallback: loading chunk ${resolution.chunkId}.`
      );

      // If we have no valid fallback chunk either, do the old fallback
      if (resolution.reason === 'lowest_chunk' && resolution.chunkId === 0 && !lazyLoader.nodes.some((n: any) => n.chunk_id === 0)) {
        hideNavigationLoading();
        fallbackScrollPosition(lazyLoader);
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
        lazyLoader.pendingNavigationTarget = null;
        if (lazyLoader._navigationResolve) {
          lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
          lazyLoader._navigationResolve = null;
          lazyLoader._navigationReject = null;
        }
        // Show contextual toast — but only for a target the user actually asked for. An internal
        // replay the URL never named (see isTargetNamedByUrl) still needs the chunk loaded above,
        // yet telling the reader "couldn't find X" about an id they never typed is noise about
        // our own plumbing.
        if (isTargetNamedByUrl(targetId)) {
          import('../components/toast/toast').then(({ showTargetNotFoundToast }) => {
            showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
          });
        }
        return;
      }

      // Show contextual toast after scroll completes (deferred to avoid layout shift)
      if (isTargetNamedByUrl(targetId)) {
        setTimeout(() => {
          import('../components/toast/toast').then(({ showTargetNotFoundToast }) => {
            showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
          });
        }, 500);
      }
    }

    // Map resolved chunk_id to an index in lazyLoader.nodes
    const targetChunkId = resolution.chunkId;
    let targetChunkIndex = lazyLoader.nodes.findIndex((n: any) => n.chunk_id === targetChunkId);

    // If chunk not in lazyLoader.nodes (partial load), try to load it
    if (targetChunkIndex === -1) {
      // Refresh lazyLoader nodes from IndexedDB in case they were updated
      const freshNodes = await getNodesFromIndexedDB(lazyLoader.bookId);
      if (freshNodes && freshNodes.length > 0) {
        lazyLoader.nodes = freshNodes;
        lazyLoader.chunkManifest = null;
        (window as any).nodes = freshNodes;
        targetChunkIndex = freshNodes.findIndex((n: any) => n.chunk_id === targetChunkId);
      }
    }

    if (targetChunkIndex === -1) {
      console.warn(`Resolved chunk ${targetChunkId} not found in lazyLoader nodes. Falling back.`);
      hideNavigationLoading();
      fallbackScrollPosition(lazyLoader);
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }
      return;
    }

    // Get all unique chunk_ids — use manifest when available (partial load)
    const allChunkIds = lazyLoader.chunkManifest
      ? lazyLoader.chunkManifest.map((m: any) => m.chunk_id)
      : [...new Set(lazyLoader.nodes.map((n: any) => n.chunk_id))].sort((a: any, b: any) => a - b);
    const targetChunkPosition = allChunkIds.indexOf(targetChunkId);

    if (lazyLoader.currentlyLoadedChunks?.has?.(targetChunkId)) {
      // 🚀 FAST-PATH: the target chunk is ALREADY rendered — server-prerendered + adopted, or already
      // lazy-loaded. Do NOT clear + re-render: that discards the adopted DOM (the deep-link flash) and
      // pointlessly rebuilds a chunk already on screen. Just ensure the neighbour chunks are present for
      // scroll context (loadChunk early-exits for already-loaded ids), then fall through to the
      // wait-for-element + scroll below — which finds the existing target without a reload.
      verbose.nav(`Fast-path: chunk ${targetChunkId} already loaded — scrolling without clearing`, 'scrolling/internalNav');
      const fills: Promise<any>[] = [];
      if (targetChunkPosition > 0) {
        fills.push(lazyLoader.loadChunk(allChunkIds[targetChunkPosition - 1], "up"));
      }
      if (targetChunkPosition >= 0 && targetChunkPosition < allChunkIds.length - 1) {
        fills.push(lazyLoader.loadChunk(allChunkIds[targetChunkPosition + 1], "down"));
      }
      // AWAIT the neighbour loads before repositioning — else reposition sorts a half-built DOM
      // (concurrent inserts) and the sentinels end up scrambled.
      await Promise.all(fills);
      if (bailIfSuperseded('fast-path-fills')) return;
      lazyLoader.repositionSentinels();
    } else {
      // Clear the container and load the chunk (plus adjacent chunks).
      if (progressIndicator) {
        progressIndicator.updateProgress(50, "Clearing container and preparing to load chunks...");
      }

      // ⚠️ DIAGNOSTIC: Log when container is cleared during navigation
      const childCount3 = lazyLoader.container.children.length;
      if (childCount3 > 0) {
        console.warn(`⚠️ CONTAINER CLEAR (navigation): ${childCount3} children removed`, {
          stack: new Error().stack,
          targetId,
          timestamp: Date.now()
        });
      }
      lazyLoader.container.innerHTML = "";
      lazyLoader.currentlyLoadedChunks.clear();

      // Load target chunk plus adjacent chunks
      const startChunkIndex = Math.max(0, targetChunkPosition - 1);
      const endChunkIndex = Math.min(allChunkIds.length - 1, targetChunkPosition + 1);
      const chunksToLoad = allChunkIds.slice(startChunkIndex, endChunkIndex + 1);

      verbose.nav(`Target element "${targetId}" is in chunk_id: ${targetChunkId}`, 'scrolling/internalNav');
      verbose.nav(`Loading chunks: ${chunksToLoad.join(', ')} (target chunk position: ${targetChunkPosition})`, 'scrolling/internalNav');

      if (progressIndicator) {
        progressIndicator.updateProgress(60, `Loading ${chunksToLoad.length} chunks...`);
      }

      // AWAIT all chunk loads before repositioning — repositionSentinels sorts the live DOM, so it
      // must run AFTER every insert completes, not while concurrent loads are still mutating it.
      await Promise.all(chunksToLoad.map((chunkId: any) => lazyLoader.loadChunk(chunkId, "down")));

      if (bailIfSuperseded('chunk-loads')) return;
      lazyLoader.repositionSentinels();
    }

    if (progressIndicator) {
      progressIndicator.updateProgress(70, "Waiting for content to be ready...");
    }

    try {
      // 🚀 Use DOM readiness detection instead of fixed timeout
      verbose.nav(`Waiting for navigation target to be ready: ${targetId}`, 'scrolling/internalNav');

      targetElement = await waitForNavigationTarget(
        targetId,
        lazyLoader.container,
        targetChunkId, // Now we know the exact chunk ID!
        {
          // The resolver already told us whether the target maps to a real chunk. If it did NOT
          // (resolution.resolved === false — e.g. a STALE saved scroll position pointing at a node
          // that was renumbered/deleted, like the cross-contaminated "300"), the element will never
          // appear — so fail FAST (≈0.6s) instead of spinning 100 attempts / 5s and leaving the
          // reader stuck. A genuinely-resolved target still gets the full wait.
          maxWaitTime: resolution.resolved ? 5000 : 600, // 5 second max wait
          requireVisible: false
        }
      );

      verbose.nav(`Navigation target ready: ${targetId}`, 'scrolling/internalNav');
      elementsReady = true;

    } catch (error: any) {
      console.warn(`❌ Failed to wait for target element ${targetId}: ${error.message}. Trying fallback...`);

      // Fallback: try once more with querySelector in case it's there but not detected
      let fallbackTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);

      // For highlights, check by class (overlapping highlights use id="HL_overlap")
      if (!fallbackTarget && targetId.startsWith('HL_')) {
        fallbackTarget = lazyLoader.container.querySelector(`mark.${CSS.escape(targetId)}`);
      }

      // For hypercites, also check overlapping elements in fallback
      if (!fallbackTarget && targetId.startsWith('hypercite_')) {
        const overlappingElements = lazyLoader.container.querySelectorAll('u[data-overlapping]');
        for (const element of overlappingElements) {
          const overlappingIds = element.getAttribute('data-overlapping');
          if (overlappingIds && overlappingIds.split(',').map((id: string) => id.trim()).includes(targetId)) {
            verbose.nav(`Found hypercite ${targetId} in overlapping element (fallback)`, 'scrolling/internalNav');
            fallbackTarget = element;
            break;
          }
        }
      }

      if (fallbackTarget) {
        verbose.nav(`Found target on fallback attempt: ${targetId}`, 'scrolling/internalNav');
        targetElement = fallbackTarget;
        elementsReady = true;
      } else {
        if (bailIfSuperseded('target-wait-failed')) return;
        console.warn(`❌ Could not locate target element: ${targetId}`);
        hideNavigationLoading();
        // 🩹 Self-heal: a NUMERIC target that can't be located is a stale saved scroll position
        // (a node that was renumbered/deleted — e.g. a corrupted "300"). Clear it from session +
        // local storage so it stops resurrecting (and hanging) on every visit to this book.
        if (/^\d+(\.\d+)?$/.test(targetId)) {
          try {
            const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
            sessionStorage.removeItem(scrollKey);
            localStorage.removeItem(scrollKey);
            verbose.nav(`Cleared stale saved scroll position "${targetId}" for ${lazyLoader.bookId}`, 'scrolling/internalNav');
          } catch { /* best-effort */ }
        }
        // Complete the barrier so it doesn't leak for 10 seconds
        NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);
        fallbackScrollPosition(lazyLoader);
        lazyLoader.isNavigatingToInternalId = false;
        lazyLoader.pendingNavigationTarget = null;
        if (lazyLoader.unlockScroll) {
          lazyLoader.unlockScroll();
        }
        // Resolve with fallback flag so callers know we didn't reach target
        if (lazyLoader._navigationResolve) {
          lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
          lazyLoader._navigationResolve = null;
          lazyLoader._navigationReject = null;
        }
        return;
      }
    }
  }

  // ========= UNIFIED FINAL SCROLL SECTION =========
  // At this point, we have a confirmed ready targetElement
  if (bailIfSuperseded('pre-final-scroll')) return;
  if (elementsReady && targetElement) {
    if (progressIndicator) {
      progressIndicator.updateProgress(80, "Waiting for layout to stabilize...");
    }

    // 🚀 LAYOUT FIX: Wait for layout to complete before scrolling
    verbose.nav(`Waiting for layout completion before scrolling to: ${targetId}`, 'scrolling/internalNav');

    try {
      // BOUNDED wait: pendingFirstChunkLoadedPromise can be left unsettled
      // forever (a book/sub-book load resets it and bails before resolving).
      // Awaiting it bare hangs this ladder between updateProgress(80) and
      // (90) — the progress overlay freezes at "Loading... 80%" and its
      // hide() below never runs (the stuck-overlay healthCheck failure).
      // Layout stabilization is an optimization, not a correctness gate, so
      // cap the wait and proceed.
      await Promise.race([
        pendingFirstChunkLoadedPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('first-chunk layout wait timed out (3s)')), 3000)
        ),
      ]);
      verbose.nav('Layout complete, proceeding with scroll', 'scrolling/internalNav');
    } catch (error: any) {
      console.warn(`⚠️ Layout promise failed, proceeding anyway: ${error.message}`);
    }

    if (progressIndicator) {
      progressIndicator.updateProgress(90, "Scrolling to target...");
    }

    // 🎯 FINAL SCROLL - Check if element is already visible before scrolling
    verbose.nav(`FINAL SCROLL: Navigating to confirmed ready element: ${targetId}`, 'scrolling/internalNav');
    const scrollableParent = lazyLoader.scrollableParent;

    // Check if element is actually visible in the viewport
    const elementRect = targetElement.getBoundingClientRect();
    const containerRect = scrollableParent.getBoundingClientRect();
    const currentPosition = elementRect.top - containerRect.top;

    // Check visibility in the actual viewport (not just container bounds)
    const isInViewport = elementRect.top >= 0 &&
                        elementRect.bottom <= window.innerHeight &&
                        elementRect.left >= 0 &&
                        elementRect.right <= window.innerWidth;

    // Also check if it's within the container bounds
    const isInContainer = elementRect.top >= containerRect.top &&
                         elementRect.bottom <= containerRect.bottom;

    // Element is truly visible if it's both in viewport AND container.
    // PAGINATED MODE: this check is vertical-only and lies — an element on a
    // DIFFERENT page can pass it (same vertical band, off-screen horizontally
    // via the column layout's union rects), which would skip the scroll and
    // strand the reader on the wrong page. Always delegate when paginated:
    // scrollElementWithConsistentMethod hands off to the paginator, whose
    // goToElement is idempotent (already on the right page = no-op).
    const isPaginated = isPaginatorEngaged()
      && scrollableParent !== window
      && scrollableParent?.classList?.contains('paginated-active');
    const isAlreadyVisible = !isPaginated && isInViewport && isInContainer;
    const isReasonablyPositioned = currentPosition >= 0 && currentPosition <= 300; // Within first 300px of container

    verbose.nav(`Element visibility: inViewport=${isInViewport}, inContainer=${isInContainer}, visible=${isAlreadyVisible}, paginated=${isPaginated}, position=${currentPosition}px`, 'scrolling/internalNav');

    // Paginated mode: pin the paginator's sticky anchor to the EXACT target id
    // (e.g. the hypercite marker), NOT the containing node. A node longer than
    // a page has its first line pages before a mid-paragraph marker — scrolling
    // the node lands on the wrong page. The id is pinned even if the marker
    // renders a beat later (fetch-on-demand for a gate-filtered hypercite): the
    // paginator's remeasure re-resolves it and snaps to its page on render.
    if (isPaginated) {
      const { setPaginatorNavTarget } = await import('./paginator');
      setPaginatorNavTarget(targetId, (lazyLoader as any)._pendingPageOffset || 0);
    } else if (userScrollState.lastGestureScrollTime > gestureStampAtNavStart) {
      // The reader gestured while the target was resolving/rendering — they
      // took over. Landing now would yank the page out from under them (the
      // late second-pass landing that re-anchored a scrolled-away reader in
      // the prepend forensics). Their position wins; the nav still resolves.
      verbose.nav('User gestured during navigation wait — skipping landing scroll', 'scrolling/internalNav');
      recordNavDecision({ phase: 'nav-land', targetId, skipped: 'user-gesture-during-wait' });
    } else if (!isAlreadyVisible || !isReasonablyPositioned) {
      // Only scroll if element is not visible or poorly positioned
      if (scrollableParent && scrollableParent !== window) {
        verbose.nav(`Using consistent scroll for container: ${scrollableParent.className}`, 'scrolling/internalNav');
        scrollElementWithConsistentMethod(targetElement, scrollableParent, (lazyLoader as any)._pendingLandingOffset ?? 192);
      } else {
        verbose.nav('Using scrollIntoView for window scrolling', 'scrolling/internalNav');
        nextScrollReason('internalNav-scrollIntoView');
        recordScrollWrite({ via: 'scrollIntoView', newTop: null });
        targetElement.scrollIntoView({
          behavior: "smooth",
          block: "start",
          inline: "nearest"
        });
      }
    } else {
      verbose.nav('Element already visible and well-positioned - skipping scroll', 'scrolling/internalNav');
    }

    // For highlights, open the container (cascade-origin is applied there) —
    // unless the caller suppressed it (arrow-nav swap already owns the container).
    const suppressOpen = (lazyLoader as any)._suppressContainerOpenFor === targetId;
    (lazyLoader as any)._suppressContainerOpenFor = null;
    if (targetId.startsWith('HL_') && !suppressOpen) {
      setTimeout(() => {
        verbose.nav(`Opening highlight after navigation: ${targetId}`, 'scrolling/internalNav');
        openHighlightById(targetId);
      }, 200);
    }

    // For footnotes, play arrow-pulse animation for navigation emphasis
    if (targetId.includes('_Fn') || targetId.startsWith('Fn')) {
      const fnEl = document.getElementById(targetId);
      if (fnEl) {
        fnEl.classList.add('arrow-target');
        const handleEnd = (e: any) => {
          if (e.target === fnEl) {
            fnEl.classList.remove('arrow-target');
            fnEl.removeEventListener('animationend', handleEnd);
          }
        };
        fnEl.addEventListener('animationend', handleEnd);
      }
      setTimeout(() => {
        verbose.nav(`Opening footnote after navigation: ${targetId}`, 'scrolling/internalNav');
        const footnoteElement = document.getElementById(targetId);
        if (footnoteElement) {
          handleUnifiedContentClick(footnoteElement);
        }
      }, 200);
    }

    // Clean up navigation state
    if (typeof lazyLoader.attachMarkListeners === "function") {
      lazyLoader.attachMarkListeners(lazyLoader.container);
    }

    if (progressIndicator) {
      progressIndicator.updateProgress(100, "Navigation complete!");
    }

    // 🚨 SMART CLEANUP: Check if element is perfectly positioned to decide on delay
    // Reuse the elementRect and containerRect from above
    const targetPosition = (lazyLoader as any)._pendingLandingOffset ?? 192; // landing offset (header offset for deep links, saved sub-node offset for resume)

    const isAlreadyPerfectlyPositioned = Math.abs(currentPosition - targetPosition) < 20; // 20px tolerance
    const cleanupDelay = isAlreadyPerfectlyPositioned ? 0 : 500; // No delay if perfect, 500ms if corrections might fire

    verbose.nav(`SMART CLEANUP: Element at ${currentPosition}px, target ${targetPosition}px, diff ${Math.abs(currentPosition - targetPosition)}px, delay ${cleanupDelay}ms`, 'scrolling/internalNav');

    // Superseded while scrolling? The newer nav owns the (single-slot) cleanup
    // timer and the barrier — clearing/re-scheduling here would hijack them,
    // and this timer's fillViewport would fill the viewport around the WRONG
    // landing (the abandoned-restore prepend-shove, forensics 0 → 13523px).
    if (bailIfSuperseded('pre-cleanup-schedule')) return;

    // Clear any existing cleanup timer and store the new one
    if (navTimers.pendingNavigationCleanupTimer) {
      clearTimeout(navTimers.pendingNavigationCleanupTimer);
    }

    // If scroll correction is needed, register it with the barrier
    if (!isAlreadyPerfectlyPositioned) {
      NavigationCompletionBarrier.registerProcess(NavigationProcess.SCROLL_CORRECTION);
    }

    navTimers.pendingNavigationCleanupTimer = setTimeout(async () => {
      // A nav superseded AFTER scheduling: skip the whole cleanup — barrier
      // signals, fillViewport, and the promise slot all belong to the newer nav.
      if (bailIfSuperseded('cleanup-timer')) {
        navTimers.pendingNavigationCleanupTimer = null;
        return;
      }
      verbose.nav(`Navigation scroll complete for ${targetId}`, 'scrolling/internalNav');
      navTimers.pendingNavigationCleanupTimer = null; // Clear the reference

      // 🚦 Signal scroll completion to the barrier (DON'T clear flags directly - barrier handles that)
      NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, true);

      // If scroll correction was registered, signal it too
      if (!isAlreadyPerfectlyPositioned) {
        NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_CORRECTION, true);
      }

      // 🪟 Ensure there's content to scroll INTO above/below the landing. If the target sat at a
      // chunk EDGE (or the chunks are short), the observer won't re-fire without a scroll transition
      // — so the user couldn't scroll on without a scroll-up-then-down. fillViewport loads neighbours
      // until the sentinels are past the viewport. Fire-and-forget (self-guarded); don't block nav.
      import('../lazyLoader/utilities/fillViewport').then(({ fillViewport }) => fillViewport(lazyLoader));

      // 🎯 Hide loading indicator, then trigger hypercite glow
      await hideNavigationLoading();

      if (targetId.startsWith('hypercite_')) {
        const { revealGhostIfTombstone } = await import('../hypercites/animations.js');
        const { highlightTargetHypercite } = await import('../hypercites/animations.js');
        if (!revealGhostIfTombstone(targetId)) {
          highlightTargetHypercite(targetId);
        }
      }

      // Record "we deliberately navigated to this target at T" for the durable resume-vs-jump
      // decision (scrolling/navStamp → restore.ts). The URL hash keeps its `citation_` namespace
      // prefix while `targetId` is the bare element id (see toScrollTargetId) — normalize the hash
      // the same way so the citation case keys navigatedAt off the actual URL hash.
      const urlHashId = window.location.hash.substring(1);
      if (toScrollTargetId(urlHashId) === targetId) {
        recordNavigatedAt(lazyLoader.bookId, urlHashId);
        verbose.nav(`Recorded navigatedAt for ${urlHashId}`, 'scrolling/internalNav');
      }

      // 🚀 iOS Safari fix: Resolve navigation Promise so callers know we're truly done
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: true, targetId, element: targetElement });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }

    }, cleanupDelay);
  } else {
    console.error(`❌ Navigation failed - no ready target element found for: ${targetId}`);
    hideNavigationLoading();

    // 🚦 Signal failure to the barrier (it will handle flag cleanup)
    NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);

    // 🚀 iOS Safari fix: Reject navigation Promise so callers know navigation failed
    if (lazyLoader._navigationReject) {
      lazyLoader._navigationReject(new Error(`Navigation failed - element not found: ${targetId}`));
      lazyLoader._navigationResolve = null;
      lazyLoader._navigationReject = null;
    }
  }
}
