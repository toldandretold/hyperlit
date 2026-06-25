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
import { navigatedHashes, navTimers } from './navState';
import { showNavigationLoading, hideNavigationLoading, NavigationProgressIndicator } from './navOverlay';
import { scrollElementWithConsistentMethod, scrollElementIntoMainContent } from './scrollHelpers';
import { shouldSkipScrollRestoration } from './userScrollDetection';
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

      const bottomSentinel = lazyLoader.container.querySelector(`#${lazyLoader.bookId}-bottom-sentinel`);
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
      scrollElementIntoMainContent(targetElement, 50);
      return;
    }
  }

  // Fallback to top of page
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

export function navigateToInternalId(targetId: string, lazyLoader: any, showOverlay = true): Promise<any> {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return Promise.reject(new Error("Lazy loader instance not provided"));
  }
  verbose.nav(`Initiating navigation to internal ID: ${targetId}`, 'scrolling/internalNav');

  // 🚀 Return a Promise that resolves when navigation is truly complete
  // This fixes iOS Safari race condition where scroll restoration interferes
  return new Promise((resolve, reject) => {
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

    _navigateToInternalId(targetId, lazyLoader, progressIndicator);
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

async function _navigateToInternalId(targetId: string, lazyLoader: any, progressIndicator: NavigationProgressIndicator | null = null): Promise<void> {
  // Check if the target element is already present and fully rendered (e.g. a server-prerendered +
  // adopted chunk). If so, the resolver + clear+re-render block below is SKIPPED — we scroll straight
  // to it (no deep-link flash). Covers hypercite / highlight / footnote / node targets.
  let existingElement = findRenderedTarget(lazyLoader.container, targetId);

  // Update progress - DOM check
  if (progressIndicator) {
    progressIndicator.updateProgress(20, "Checking if element is in DOM...");
  }

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

    verbose.nav(
      `Resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
      'scrolling/internalNav'
    );

    // If the resolver couldn't find the target and the book isn't fully loaded,
    // wait for the background download to complete and retry with the full dataset.
    if (!resolution.resolved && !lazyLoader.isFullyLoaded) {
      verbose.nav(`Target "${targetId}" not found in partial data — waiting for background download...`, 'scrolling/internalNav');
      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Loading remaining book data...");
      }

      const { waitForBackgroundDownload } = await import('../pageLoad/backgroundDownload');
      await waitForBackgroundDownload();

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

      verbose.nav(
        `Retry resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
        'scrolling/internalNav'
      );
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
        // Show contextual toast
        import('../components/toast/toast').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
        });
        return;
      }

      // Show contextual toast after scroll completes (deferred to avoid layout shift)
      setTimeout(() => {
        import('../components/toast/toast').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
        });
      }, 500);
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
          maxWaitTime: 5000, // 5 second max wait
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
        console.warn(`❌ Could not locate target element: ${targetId}`);
        hideNavigationLoading();
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
  if (elementsReady && targetElement) {
    if (progressIndicator) {
      progressIndicator.updateProgress(80, "Waiting for layout to stabilize...");
    }

    // 🚀 LAYOUT FIX: Wait for layout to complete before scrolling
    verbose.nav(`Waiting for layout completion before scrolling to: ${targetId}`, 'scrolling/internalNav');

    try {
      await pendingFirstChunkLoadedPromise;
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

    // Element is truly visible if it's both in viewport AND container
    const isAlreadyVisible = isInViewport && isInContainer;
    const isReasonablyPositioned = currentPosition >= 0 && currentPosition <= 300; // Within first 300px of container

    verbose.nav(`Element visibility: inViewport=${isInViewport}, inContainer=${isInContainer}, visible=${isAlreadyVisible}, position=${currentPosition}px`, 'scrolling/internalNav');

    // Only scroll if element is not visible or poorly positioned
    if (!isAlreadyVisible || !isReasonablyPositioned) {
      if (scrollableParent && scrollableParent !== window) {
        verbose.nav(`Using consistent scroll for container: ${scrollableParent.className}`, 'scrolling/internalNav');
        scrollElementWithConsistentMethod(targetElement, scrollableParent, 192);
      } else {
        verbose.nav('Using scrollIntoView for window scrolling', 'scrolling/internalNav');
        targetElement.scrollIntoView({
          behavior: "smooth",
          block: "start",
          inline: "nearest"
        });
      }
    } else {
      verbose.nav('Element already visible and well-positioned - skipping scroll', 'scrolling/internalNav');
    }

    // For highlights, open the container (cascade-origin is applied there)
    if (targetId.startsWith('HL_')) {
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
    const targetPosition = 192; // header offset

    const isAlreadyPerfectlyPositioned = Math.abs(currentPosition - targetPosition) < 20; // 20px tolerance
    const cleanupDelay = isAlreadyPerfectlyPositioned ? 0 : 500; // No delay if perfect, 500ms if corrections might fire

    verbose.nav(`SMART CLEANUP: Element at ${currentPosition}px, target ${targetPosition}px, diff ${Math.abs(currentPosition - targetPosition)}px, delay ${cleanupDelay}ms`, 'scrolling/internalNav');

    // Clear any existing cleanup timer and store the new one
    if (navTimers.pendingNavigationCleanupTimer) {
      clearTimeout(navTimers.pendingNavigationCleanupTimer);
    }

    // If scroll correction is needed, register it with the barrier
    if (!isAlreadyPerfectlyPositioned) {
      NavigationCompletionBarrier.registerProcess(NavigationProcess.SCROLL_CORRECTION);
    }

    navTimers.pendingNavigationCleanupTimer = setTimeout(async () => {
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

      // Mark this hash as "navigated to" for this page session.
      // Uses module-level Set so it resets on page reload (fresh loads re-navigate).
      if (window.location.hash.substring(1) === targetId) {
        navigatedHashes.add(targetId);
        verbose.nav(`Marked hash ${targetId} as navigated (session-level)`, 'scrolling/internalNav');
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
