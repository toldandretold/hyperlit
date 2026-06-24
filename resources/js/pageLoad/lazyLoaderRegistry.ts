import { asBookId, LATEST, type BookId } from "../indexedDB/types";
import { book } from '../app';
import { verbose } from '../utilities/logger';
import { navigateToInternalId } from '../scrolling/index';

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "../lazyLoader/index";

import {
  openDatabase,
  getNodesFromIndexedDB,
} from "../indexedDB/index.js";

// hyperlights/hypercites are reader-only lazy chunks. These render callbacks are passed into
// createLazyLoader; wrap them as lazy importers so this EAGER module doesn't statically pull those
// folders into the eager bundle. First call triggers the import (reader-only at runtime; cached after).
const attachMarkListeners = (...a: any[]) => import("../hyperlights/index").then((m) => (m.attachMarkListeners as any)(...a));
const attachUnderlineClickListeners = (...a: any[]) => import("../hypercites/index").then((m) => (m.attachUnderlineClickListeners as any)(...a));

import { syncBookDataFromDatabase } from "../indexedDB/serverSync/index";

import { getFirstChunkLoadedResolver } from './firstChunkPromise';
// Static (downward) now that the cycles are broken: nodeGen is a low-import util, and containerChain
// reads currentLazyLoader from the leaf (not this module) — so neither closes a ring.
import { generateNodesFromMarkdown } from './nodeGen';
import { openContainerChain } from './containerChain';

// Store multiple lazy loaders by bookId
export const lazyLoaders: any = {};

// The active lazy loader lives in a zero-import leaf so any layer can read it via a STATIC
// downward import (no cycle, no dynamic-import breaker). This module is its only writer.
import { currentLazyLoader, setCurrentLazyLoader } from './currentLazyLoaderState';
export { currentLazyLoader } from './currentLazyLoaderState';

export let pendingContainerRestorePromise: any = null;

// Function to reset the current lazy loader for homepage transitions
export function resetCurrentLazyLoader() {
  if (currentLazyLoader) {
    // Properly disconnect the old lazy loader to remove its event listeners
    if (typeof currentLazyLoader.disconnect === 'function') {
      currentLazyLoader.disconnect();
    }

    setCurrentLazyLoader(null);
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
  setCurrentLazyLoader(createLazyLoader({
    nodes: (window as any).nodes,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    attachUnderlineClickListeners,
    bookId: book,
  }));

  return currentLazyLoader;
}


// Function for homepage multi-book support - always creates fresh content
export async function initializeLazyLoaderForContainer(bookId: BookId) {
  console.log(`🔄 Creating fresh lazy loader for book: ${bookId}`);

  // Clean up any existing lazy loader for this book
  if (lazyLoaders[bookId]) {
    console.log(`🧹 Removing existing lazy loader for fresh ${bookId} content`);
    delete lazyLoaders[bookId];
  }

  try {
    // Load book data using the same priority as regular books:
    // 1. IndexedDB cache -> 2. Database sync -> 3. Generate from markdown
    let nodes: any = await getNodesFromIndexedDB(bookId);

    if (!nodes || !nodes.length) {
      console.log(`🔍 Loading ${bookId} from database...`);
      const dbResult = await syncBookDataFromDatabase(bookId);
      if (dbResult && dbResult.success) {
        nodes = await getNodesFromIndexedDB(bookId);
      }
    }

    if (!nodes || !nodes.length) {
      console.log(`🆕 Generating ${bookId} from markdown`);
      nodes = await generateNodesFromMarkdown(bookId, true);
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
      attachUnderlineClickListeners,
      bookId: bookId
    });

    // Load the first chunk of nodes to initialize content
    const firstChunk = nodes.find((chunk: any) => chunk.chunk_id === 0) || nodes[0];
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
export async function initializeLazyLoader(openHyperlightID: any, bookId: BookId, openFootnoteID: any = null, initialChunkId: any = null) {
  if (!currentLazyLoader) {
    // Determine which ID to navigate to (hyperlight or footnote)
    const targetId = openHyperlightID || openFootnoteID;
    const hasNavigationTarget = !!targetId || initialChunkId !== null;

    setCurrentLazyLoader(createLazyLoader({
      nodes: (window as any).nodes,
      chunkManifest: (window as any).chunkManifest || null,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      attachUnderlineClickListeners,
      bookId: bookId,
      isNavigatingToInternalId: !!targetId,
      onFirstChunkLoaded: getFirstChunkLoadedResolver()
    }));

    // Phase 2 — ADOPT the server-rendered first chunk if the reader page injected one.
    // reader.blade.php emits the chunk the server determined we'd load first as the real
    // `.chunk[data-prerendered]` element; adoption registers it as loaded (applying the live
    // annotation/footnote/math passes on top) so the loadChunk(...) calls below early-exit for
    // it and it is NEVER re-rendered. No injection / cold cache → returns null → behaviour is
    // exactly today's. (Sub-book containers never carry data-prerendered, so they're untouched.)
    if (currentLazyLoader) {
      const { adoptPrerenderedChunk } = await import('../lazyLoader/adoptPrerenderedChunk');
      await adoptPrerenderedChunk(currentLazyLoader, bookId);
    }

    // Eagerly load first chunk for homepage/user page contexts AND reader pages
    // with no target navigation, so the DOM has content before editButton resolves
    const isHomepageContext = document.querySelector('.home-content-wrapper') ||
                              document.querySelector('.user-content-wrapper');
    if (isHomepageContext || !hasNavigationTarget) {
      const firstChunk = (window as any).nodes.find((chunk: any) => chunk.chunk_id === 0) || (window as any).nodes[0];
      if (firstChunk && currentLazyLoader) {
        verbose.content(`Loading initial chunk #${firstChunk.chunk_id} (eager load)`, 'initializePage.js');
        await currentLazyLoader.loadChunk(firstChunk.chunk_id, "down");
      }
    } else if (initialChunkId !== null && !targetId) {
      // SPA target resolved to a specific chunk — load it directly instead of chunk 0
      verbose.content(`Loading SPA-resolved chunk #${initialChunkId} (target chunk)`, 'initializePage.js');
      await currentLazyLoader.loadChunk(initialChunkId, "down");
    }

    // Navigate to hyperlight or footnote if specified in URL
    if (targetId) {
      setTimeout(() => {
        navigateToInternalId(targetId, currentLazyLoader, false);
      }, 300);
    }

    // Auto-open chain for deep nested sub-book URLs (e.g. /book/2/Fn.../HL_...)
    if ((window as any).autoOpenChain && (window as any).autoOpenChain.length > 0) {
      const chain = (window as any).autoOpenChain;
      (window as any).autoOpenChain = null; // Prevent re-triggering
      openContainerChain(chain, currentLazyLoader);
    }

    // Container stack restoration — if history.state has a serialized stack,
    // restore all layers from it (handles back-nav, refresh, and SPA transitions).
    //
    // We gate on the actually-rendered reader-main element rather than the
    // `book` global. `book` can be stale during a popstate that crosses
    // from a reader page back to home (the global update lags behind the
    // URL change), which previously let stale stacks restore onto the home
    // page (URL `/`, but `book` still book_X, so the equality check
    // wrongly passed). The reader-page main element is the source of truth
    // for "we are actually rendering this book right now":
    //   - reader.blade.php: <main class="main-content" id="book_X" ...>
    //   - home.blade.php:   <main class="main-content" id="most-recent" ...>
    // Slug-vs-id URL routing doesn't affect main.id, which is always the
    // book's true id (set server-side from $book), so this is URL-agnostic.
    else if (history.state?.containerStack?.length > 0) {
      const readerMain = document.querySelector('main.main-content[id^="book_"]');
      const renderedBookId = readerMain?.id;
      const savedBookId = history.state.containerStackBookId;
      const compatLegacyState = !savedBookId; // older entries didn't stamp the book id
      if (renderedBookId && (compatLegacyState || savedBookId === renderedBookId)) {
        pendingContainerRestorePromise = import('../hyperlitContainer/history').then(({ restoreContainerStack }) => {
          return restoreContainerStack(history.state.containerStack, { callsite: 'initializePage.fresh' });
        });
      } else if (!renderedBookId) {
        console.log('📚 [initializePage.fresh] Skipping container-stack restore — current page is not a reader (main.id is not book_*)');
      } else {
        console.log(`📚 [initializePage.fresh] Skipping container-stack restore — saved bookId "${savedBookId}" does not match rendered "${renderedBookId}"`);
      }
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
        import('../hyperlitContainer/index').then(({ restoreHyperlitContainerFromHistory }) => {
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
