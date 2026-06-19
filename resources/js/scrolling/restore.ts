/**
 * scrolling/restore — restoreScrollPosition(): the main page-load entry point.
 * Resolves a target from URL hash / ?scroll= / saved position, then either loads
 * chunk 0 or delegates to navigateToInternalId.
 *
 * currentLazyLoader is dynamically imported (it lives in the page-load layer,
 * which imports scrolling back) to keep this folder's static graph acyclic.
 */
import { verbose } from '../utilities/logger';
import { book, OpenHyperlightID, OpenFootnoteID } from '../app';
import { getNodeChunksFromIndexedDB, getLocalStorageKey } from '../indexedDB/index.js';
import { parseChunkId } from '../indexedDB/types';
import { parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown';
import { shouldSkipScrollRestoration as shouldSkipScrollRestorationGlobal, setSkipScrollRestoration } from '../utilities/operationState';
import { isSearchToolbarOpen } from '../search/inTextSearch/searchToolbar';
import { navigatedHashes } from './navState';
import { shouldSkipScrollRestoration } from './userScrollDetection';
import { showNavigationLoading } from './navOverlay';
import { navigateToInternalId } from './internalNav';
// Static, downward import of the lazy-loader singleton from its zero-import leaf (no cycle —
// the leaf imports nothing). This is the real fix; no dynamic-import cycle-breaker needed.
import { currentLazyLoader } from '../pageLoad/currentLazyLoaderState';

export async function restoreScrollPosition(): Promise<void> {
  // Convert ?scroll= query param to hash (used by Word doc links to avoid # → %23 encoding)
  const scrollParam = new URLSearchParams(window.location.search).get('scroll');
  if (scrollParam) {
    const cleanUrl = window.location.origin + window.location.pathname;
    history.replaceState(history.state, '', cleanUrl + '#' + scrollParam);
  }

  // 🔍 DIAGNOSTIC: Entry point logging
  verbose.nav('restoreScrollPosition() ENTRY', 'scrolling/restore');
  verbose.nav(`URL = ${window.location.href}`, 'scrolling/restore');
  verbose.nav(`URL hash = ${window.location.hash}`, 'scrolling/restore');

  // Skip if content doesn't overflow (nothing to scroll)
  const wrapper = document.querySelector('.home-content-wrapper') ||
                  document.querySelector('.user-content-wrapper') ||
                  document.querySelector('.reader-content-wrapper');

  // 🔍 DIAGNOSTIC: Log current scroll state BEFORE any logic
  if (wrapper) {
    verbose.nav(`Current scrollTop = ${wrapper.scrollTop}`, 'scrolling/restore');
    verbose.nav(`scrollHeight = ${wrapper.scrollHeight}, clientHeight = ${wrapper.clientHeight}`, 'scrolling/restore');
    const existingChunks = wrapper.querySelectorAll('[data-chunk-id]');
    verbose.nav(`Existing chunks in DOM = ${existingChunks.length}`, 'scrolling/restore');
    if (existingChunks.length > 0) {
      const chunkIds = Array.from(existingChunks).map(c => c.getAttribute('data-chunk-id'));
      verbose.nav(`Chunk IDs = ${chunkIds.join(', ')}`, 'scrolling/restore');
    }
  }

  // Only bail early if actual content is loaded but doesn't overflow.
  // When no chunks are in the DOM yet we still need to proceed to load them.
  const hasChunksInDom = wrapper && wrapper.querySelectorAll('[data-chunk-id]').length > 0;
  if (hasChunksInDom && wrapper.scrollHeight <= wrapper.clientHeight && !window.location.hash) {
    verbose.nav('EARLY EXIT - content doesnt overflow and no hash target', 'scrolling/restore');
    return;
  }

  // Check if user is currently scrolling
  if (shouldSkipScrollRestoration("restoreScrollPosition")) {
    return;
  }

  // Skip if search toolbar is blocking navigation
  if ((window as any).searchToolbarBlockingNavigation) {
    verbose.nav('RESTORE SCROLL: Search toolbar blocking navigation, skipping restoration', 'scrolling/restore');
    return;
  }

  // Skip if search toolbar is open - don't interfere with search UX
  if (isSearchToolbarOpen()) {
    verbose.nav('RESTORE SCROLL: Search toolbar is open, skipping restoration', 'scrolling/restore');
    return;
  }

  if (!currentLazyLoader) {
    console.error("Lazy loader instance not available!");
    return;
  }

  // 🚀 FIX: Skip if we're already navigating to a target
  // This prevents race conditions with BookToBookTransition and other navigation pathways
  if (currentLazyLoader.isNavigatingToInternalId) {
    return;
  }

  // 🚀 FIX: Check global flag to skip scroll restoration (set by BookToBookTransition for hash navigation)
  if (shouldSkipScrollRestorationGlobal()) {
    verbose.nav('RESTORE SCROLL: Skip flag is set, clearing and returning', 'scrolling/restore');
    setSkipScrollRestoration(false); // Clear the flag for next time
    return;
  }

  // 🚀 FIX: Check if we're on a hyperlight URL path (like /book/HL_xxxxx)
  // If so, skip scroll restoration - BookToBookTransition will handle navigation
  const pathSegments = window.location.pathname.split('/').filter(Boolean);
  const isHyperlightPath = pathSegments.length >= 2 && pathSegments[1]?.startsWith('HL_');
  const isFootnotePath = pathSegments.length >= 2 && (pathSegments[1]?.includes('_Fn') || pathSegments[1]?.startsWith('Fn'));
  if (isHyperlightPath) {
    verbose.nav(`RESTORE SCROLL: Hyperlight path detected (${pathSegments[1]}), skipping`, 'scrolling/restore');
    return;
  }
  if (isFootnotePath) {
    verbose.nav(`RESTORE SCROLL: Footnote path detected (${pathSegments[1]}), skipping`, 'scrolling/restore');
    return;
  }

  // If we're navigating to an internal ID (like a highlight or footnote), prioritize that
  const targetInternalId = OpenHyperlightID || OpenFootnoteID;
  if (currentLazyLoader.isNavigatingToInternalId && targetInternalId) {
    verbose.nav(`Prioritizing navigation to internal ID: ${targetInternalId}`, 'scrolling/restore');
    navigateToInternalId(targetInternalId, currentLazyLoader, false);
    return; // Exit early, don't proceed with normal scroll restoration
  }

  // Read target id from URL hash first.
  let targetId = window.location.hash.substring(1);

  // Check if we've already navigated to this hash during THIS page session.
  // Uses module-level Set (not history.state) so it resets on page reload,
  // ensuring fresh page loads always navigate to the URL hash target.
  const alreadyNavigatedToHash = navigatedHashes.has(targetId);
  const hasExplicitTarget = !!targetId && !alreadyNavigatedToHash;

  verbose.nav(`RESTORE SCROLL: URL hash: "${targetId}", alreadyNavigated: ${alreadyNavigatedToHash}, explicit: ${hasExplicitTarget}`, 'scrolling/restore');

  // Show overlay for external navigation targets
  let overlayShown = false;
  const existingOverlay = document.getElementById('initial-navigation-overlay');
  const overlayAlreadyVisible = existingOverlay && (
    existingOverlay.style.display !== 'none' &&
    existingOverlay.style.display !== ''
  );

  const isInternalNavigation = hasExplicitTarget && (
    targetId.startsWith('hypercite_') ||
    targetId.startsWith('HL_') ||
    /^\d+$/.test(targetId)
  );

  if (hasExplicitTarget && !overlayAlreadyVisible && !isInternalNavigation) {
    showNavigationLoading(targetId);
    overlayShown = true;
  } else if (overlayAlreadyVisible) {
    overlayShown = true;
  }

  // Only use saved scroll position if there's no explicit target in URL
  // AND we're not currently navigating to an internal ID
  if (!hasExplicitTarget && !currentLazyLoader.isNavigatingToInternalId) {
    verbose.nav('RESTORE SCROLL: No explicit target, checking saved positions...', 'scrolling/restore');
    try {
      const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
      verbose.nav(`Storage key = ${scrollKey}`, 'scrolling/restore');

      // Try session storage first
      const sessionData = sessionStorage.getItem(scrollKey);
      verbose.nav(`Raw sessionStorage data = ${sessionData}`, 'scrolling/restore');
      if (sessionData && sessionData !== "0") {
        const parsed = JSON.parse(sessionData);
        verbose.nav(`Parsed session data = ${JSON.stringify(parsed)}`, 'scrolling/restore');
        if (parsed?.elementId) {
          targetId = parsed.elementId;
          verbose.nav(`Using saved session position: ${targetId}`, 'scrolling/restore');
        }
      }

      // Fallback to localStorage
      if (!targetId) {
        const localData = localStorage.getItem(scrollKey);
        verbose.nav(`Raw localStorage data = ${localData}`, 'scrolling/restore');
        if (localData && localData !== "0") {
          const parsed = JSON.parse(localData);
          verbose.nav(`Parsed local data = ${JSON.stringify(parsed)}`, 'scrolling/restore');
          if (parsed?.elementId) {
            targetId = parsed.elementId;
            verbose.nav(`Using saved local position: ${targetId}`, 'scrolling/restore');
          }
        }
      }
    } catch (e) {
      console.warn("Error reading saved scroll position", e);
    }
  } else if (currentLazyLoader.isNavigatingToInternalId) {
    verbose.nav('RESTORE SCROLL: Internal navigation in progress, IGNORING saved scroll positions', 'scrolling/restore');
  } else {
    verbose.nav('RESTORE SCROLL: Explicit target found, IGNORING any saved scroll positions', 'scrolling/restore');
  }

  verbose.nav(`Final targetId after storage check = ${targetId || '(empty)'}`, 'scrolling/restore');

  if (!targetId) {
    // 🔍 DIAGNOSTIC: This is the problematic path
    verbose.nav('NO targetId - entering chunk 0 loading path', 'scrolling/restore');
    verbose.nav('WHY? Check if storage data was null/empty above', 'scrolling/restore');

    // Load first chunk when no saved position
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(currentLazyLoader.bookId);
      verbose.nav(`Got cachedNodeChunks from IndexedDB, count = ${cachedNodeChunks?.length || 0}`, 'scrolling/restore');

      if (cachedNodeChunks?.length > 0) {
        // 🛡️ FIX: Check if content already exists in DOM (e.g., from bfcache)
        // If so, preserve it and let browser's scroll restoration work
        const existingChunks = currentLazyLoader.container.querySelectorAll('[data-chunk-id]');
        verbose.nav(`Existing chunks in DOM = ${existingChunks.length}`, 'scrolling/restore');

        if (existingChunks.length > 0) {
          verbose.nav('Content exists in DOM - preserving instead of clearing', 'scrolling/restore');
          verbose.nav(`Current scrollTop = ${currentLazyLoader.scrollableParent?.scrollTop}`, 'scrolling/restore');

          // Sync lazy loader state with existing DOM
          existingChunks.forEach((chunk: any) => {
            const chunkId = parseChunkId(chunk.getAttribute('data-chunk-id'));
            currentLazyLoader.currentlyLoadedChunks.add(chunkId);
          });
          currentLazyLoader.nodes = cachedNodeChunks;

          // Save current scroll position for future restores
          if (currentLazyLoader.saveScrollPosition) {
            setTimeout(() => currentLazyLoader.saveScrollPosition(), 100);
          }

          return; // Exit - browser's restored position will be preserved
        }

        // No existing content - safe to clear and load chunk 0
        verbose.nav('No existing content, loading chunk 0', 'scrolling/restore');
        currentLazyLoader.nodes = cachedNodeChunks;
        // ⚠️ DIAGNOSTIC: Log when container is cleared
        const childCount2 = currentLazyLoader.container.children.length;
        if (childCount2 > 0) {
          console.warn(`⚠️ CONTAINER CLEAR (scroll restore): ${childCount2} children removed`, {
            stack: new Error().stack,
            timestamp: Date.now()
          });
        }
        currentLazyLoader.container.innerHTML = "";
        // Load chunk 0 if available, otherwise load the lowest available chunk
        const chunk0Nodes = currentLazyLoader.nodes.filter((node: any) => node.chunk_id === 0);
        let loadedChunkId: number | undefined;
        if (chunk0Nodes.length > 0) {
          loadedChunkId = 0;
          await currentLazyLoader.loadChunk(0, "down");
        } else if (currentLazyLoader.nodes.length > 0) {
          // Chunked lazy loading: initial chunk may not be chunk 0
          loadedChunkId = currentLazyLoader.nodes
            .reduce((min: number, n: any) => Math.min(min, n.chunk_id), Infinity);
          await currentLazyLoader.loadChunk(loadedChunkId, "down");
        }

        // If the loaded chunk has fewer than 20 nodes, load the next chunk too
        if (loadedChunkId !== undefined) {
          const loadedNodeCount = currentLazyLoader.container.querySelectorAll('[data-node-id]').length;
          if (loadedNodeCount < 20) {
            const allChunkIds = currentLazyLoader.chunkManifest
              ? currentLazyLoader.chunkManifest.map((m: any) => m.chunk_id)
              : [...new Set(currentLazyLoader.nodes.map((n: any) => n.chunk_id))].sort((a: any, b: any) => a - b);
            const pos = allChunkIds.indexOf(loadedChunkId);
            let nextPos = pos + 1;
            while (nextPos < allChunkIds.length && currentLazyLoader.container.querySelectorAll('[data-node-id]').length < 20) {
              const nextId = allChunkIds[nextPos];
              const hasNodes = currentLazyLoader.nodes.some((n: any) => n.chunk_id === nextId);
              if (!hasNodes) break;
              await currentLazyLoader.loadChunk(nextId, "down");
              nextPos++;
            }
          }
        }
        return;
      }

      // Fallback to markdown fetch
      const response = await fetch(`/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodes = parseMarkdownIntoChunksInitial(markdown);
      currentLazyLoader.nodes
        .filter((node: any) => node.chunk_id === 0)
        .forEach((node: any) => currentLazyLoader.loadChunk(node.chunk_id, "down"));
    } catch (error) {
      console.error("Error loading content:", error);
      currentLazyLoader.container.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  // Navigate to the target position
  navigateToInternalId(targetId, currentLazyLoader, !overlayShown);
}
