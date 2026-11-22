/**
 * A non-empty local copy is not necessarily the WHOLE book.
 *
 * Prod 2026-11-22 (`john2005restorative`): the browser held 400 of 3,062 nodes — a
 * first-chunk fragment whose background download never finished — and `loadHyperText`
 * treated it as the book on every later visit (`if (cached && cached.length)`): no
 * manifest, no backfill, a ToC / search / export built from 13% of the text. Nothing
 * could notice, because the owner's own saves kept the library timestamps level, so the
 * freshness check always read "current".
 *
 * Two doors now close it, both pinned here through the REAL loadHyperText:
 *   1. a copy MARKED partial goes back to the server path (manifest + download);
 *   2. an UNMARKED short copy is caught by the freshness check comparing node COUNTS.
 * Plus the positive controls — a whole cache still renders from cache with no fetch,
 * and an unreachable server still falls back to the fragment rather than a blank page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cached: [],
  lazyLoader: null,
  localLibrary: { book: 'book_L', timestamp: 500, annotations_updated_at: 7 },
  getNodesFromIndexedDB: vi.fn(),
  fetchInitialChunk: vi.fn(),
  loadChunkForTarget: vi.fn(),
  initializeLazyLoader: vi.fn(),
  backgroundDownloadRemainingChunks: vi.fn(),
  supersedeBackgroundDownload: vi.fn(() => false),
  shouldRepairShortLocalCopy: vi.fn(),
  isPendingNewBook: vi.fn(() => false),
  syncBookDataFromDatabase: vi.fn(),
}));

vi.mock('../../../resources/js/app', () => ({
  book: 'book_L', bookSlug: null, OpenHyperlightID: null, OpenFootnoteID: null,
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), content: vi.fn(), init: vi.fn(), nav: vi.fn(), user: vi.fn() },
  verbose: { content: vi.fn(), init: vi.fn(), nav: vi.fn(), user: vi.fn() },
}));
vi.mock('../../../resources/js/utilities/pendingNewBook', () => ({ isPendingNewBook: h.isPendingNewBook }));
vi.mock('../../../resources/js/indexedDB/serverSync/countReconcile', () => ({
  shouldRepairShortLocalCopy: h.shouldRepairShortLocalCopy,
}));
vi.mock('../../../resources/js/scrolling/paginator', () => ({ maybePaginatorReveal: vi.fn(() => false) }));
vi.mock('../../../resources/js/SPA/navigation/NavigationCompletionBarrier', () => ({
  NavigationCompletionBarrier: {
    getNavigationTarget: vi.fn(() => null), registerProcess: vi.fn(), completeProcess: vi.fn(),
  },
  NavigationProcess: { CONTENT_REFRESH: 'content-refresh' },
}));
vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  getNodesFromIndexedDB: h.getNodesFromIndexedDB,
  saveAllNodesToIndexedDB: vi.fn(),
  saveAllFootnotesToIndexedDB: vi.fn(),
  saveAllReferencesToIndexedDB: vi.fn(),
  getLocalStorageKey: (k, b) => `${k}_${b}`,
  // Just enough IDB for getLibraryRecordFromIndexedDB's single get().
  openDatabase: vi.fn(async () => ({
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request = {};
          queueMicrotask(() => { request.result = h.localLibrary; request.onsuccess?.(); });
          return request;
        },
      }),
    }),
  })),
}));
vi.mock('../../../resources/js/utilities/convertMarkdown', () => ({ parseMarkdownIntoChunksInitial: vi.fn() }));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  syncBookDataFromDatabase: h.syncBookDataFromDatabase,
  syncIndexedDBtoPostgreSQL: vi.fn(),
  syncAnnotationsOnly: vi.fn(),
}));
vi.mock('../../../resources/js/pageLoad/initialChunk', () => ({
  fetchInitialChunk: h.fetchInitialChunk,
  resolveBootstrapTarget: () => ({ target: window._pendingChunkTarget ?? null, fallbackTarget: null }),
}));
vi.mock('../../../resources/js/SPA/navigation/chunkLoadRouter.js', () => ({ loadChunkForTarget: h.loadChunkForTarget }));
vi.mock('../../../resources/js/indexedDB/core/library.js', () => ({
  updateLocalAnnotationsTimestamp: vi.fn(),
  buildLibraryUrl: (b) => `/api/database-to-indexeddb/books/${b}/library`,
}));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({ registerBookOpen: vi.fn() }));
vi.mock('../../../resources/js/footnotes/FootnoteNumberingService', () => ({
  buildFootnoteMap: vi.fn(), hasOldFormatFootnotes: vi.fn(() => false), migrateOldFormatFootnotes: vi.fn(),
}));
vi.mock('../../../resources/js/pageLoad/backgroundDownload', () => ({
  supersedeBackgroundDownload: h.supersedeBackgroundDownload,
  backgroundDownloadRemainingChunks: h.backgroundDownloadRemainingChunks,
}));
vi.mock('../../../resources/js/pageLoad/firstChunkPromise', () => ({
  resolveFirstChunkPromise: vi.fn(), resetFirstChunkPromise: vi.fn(), getFirstChunkLoadedResolver: vi.fn(() => null),
}));
vi.mock('../../../resources/js/pageLoad/onlineRetry', () => ({ setupOnlineSyncListener: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageDims', () => ({ primeImageDims: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/e2ee/registry', () => ({ rootBookId: (b) => String(b).split('/')[0] }));
vi.mock('../../../resources/js/e2ee/lifecycle', () => ({ ensureUnlockedForBook: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/pageLoad/lazyLoaderRegistry', () => ({
  get currentLazyLoader() { return h.lazyLoader; },
  initializeLazyLoader: h.initializeLazyLoader,
}));
vi.mock('../../../resources/js/utilities/reconvertHandoff', () => ({ isReconvertHandoff: vi.fn(() => false) }));
vi.mock('../../../resources/js/scrolling/scrollTrace', () => ({ recordNavDecision: vi.fn() }));
vi.mock('../../../resources/js/utilities/perfMarks', () => ({ perfMark: vi.fn() }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({ hydrateBookGateDefaults: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/indexedDB/hydration/rebuild', () => ({
  rebuildNodeArrays: vi.fn(async () => {}), getNodesByDataNodeIDs: vi.fn(async () => []),
}));
vi.mock('../../../resources/js/lazyLoader/utilities/cacheState', () => ({ clearCacheDirtyFlag: vi.fn() }));
vi.mock('../../../resources/js/SPA/navigation/resolveTargetChunk.js', () => ({
  resolveTargetChunkId: vi.fn(async () => ({ resolved: false })),
}));
vi.mock('../../../resources/js/scrolling/userScrollDetection', () => ({ isUserCurrentlyScrolling: () => false }));
vi.mock('../../../resources/js/hyperlights/deletion', () => ({ reprocessHighlightsForNodes: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/components/toast/toast', () => ({ showTargetNotFoundToast: vi.fn() }));

import { loadHyperText } from '../../../resources/js/pageLoad/loadHyperText';
import { markLocalCopyPartial } from '../../../resources/js/utilities/localCopyCompleteness';

const BOOK = 'book_L';
const node = (startLine, chunk_id) => ({ book: BOOK, startLine, chunk_id, node_id: `${BOOK}_${startLine}`, content: `<p>${startLine}</p>` });
const FRAGMENT = [node(100, 0), node(200, 0), node(300, 0), node(400, 0)];
const MANIFEST = [{ chunk_id: 0, node_count: 100 }, { chunk_id: 1, node_count: 100 }, { chunk_id: 2, node_count: 100 }];
const serverChunk = () => ({ success: true, nodes: [node(100, 0)], chunkManifest: MANIFEST, targetChunkId: 0, targetResolved: true });

/** The /library freshness fetch: timestamps LEVEL with the local record unless told otherwise. */
function stubLibraryFetch({ timestamp = 500, nodeCount = null } = {}) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      library: { book: BOOK, timestamp, annotations_updated_at: 7 },
      ...(nodeCount === null ? {} : { node_count: nodeCount }),
    }),
  }));
}

/** Let the un-awaited freshness check and the idle-scheduled download run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 30));
};

let online;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  document.body.dataset.page = 'reader';
  delete window._pendingChunkTarget;
  delete window._pendingChunkFallbackTarget;
  delete window.nodes;
  delete window.chunkManifest;
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });

  h.lazyLoader = { nodes: FRAGMENT, container: null, refresh: vi.fn(async () => {}) };
  h.getNodesFromIndexedDB.mockResolvedValue(FRAGMENT);
  h.fetchInitialChunk.mockResolvedValue(serverChunk());
  h.initializeLazyLoader.mockResolvedValue(undefined);
  h.shouldRepairShortLocalCopy.mockResolvedValue(false);
  h.isPendingNewBook.mockReturnValue(false);
  stubLibraryFetch();
});

afterEach(() => { vi.useRealTimers(); });

describe('a local copy MARKED partial is not rendered as the whole book', () => {
  it('goes to the server path: manifest in hand and the background download restarted', async () => {
    markLocalCopyPartial(BOOK);

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk).toHaveBeenCalledWith(BOOK);
    expect(window.chunkManifest, 'the reader knows the other chunks exist').toEqual(MANIFEST);
    expect(h.backgroundDownloadRemainingChunks).toHaveBeenCalledWith(BOOK, h.lazyLoader);
    expect(h.loadChunkForTarget, 'the repair result is used — no second fetch').not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: an unmarked cache still renders from cache with no chunk fetch', async () => {
    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk).not.toHaveBeenCalled();
    expect(h.loadChunkForTarget).not.toHaveBeenCalled();
    expect(window.nodes).toBe(FRAGMENT);
    expect(window.chunkManifest).toBeNull();
    expect(h.initializeLazyLoader).toHaveBeenCalledTimes(1);
  });

  it('offline: the fragment still beats a blank page', async () => {
    markLocalCopyPartial(BOOK);
    online = false;

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk).not.toHaveBeenCalled();
    expect(window.nodes).toBe(FRAGMENT);
  });

  it('server unreachable: falls back to the fragment and hands the SPA target back', async () => {
    markLocalCopyPartial(BOOK);
    window._pendingChunkTarget = 'hypercite_abc';
    h.fetchInitialChunk.mockImplementationOnce(async () => {
      window._pendingChunkTarget = null; // the real fetch consumes it while building its params
      return { success: false, reason: 'sync_error', error: 'Failed to fetch' };
    });
    const { resolveTargetChunkId } = await import('../../../resources/js/SPA/navigation/resolveTargetChunk.js');

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(window.nodes).toBe(FRAGMENT);
    expect(h.initializeLazyLoader).toHaveBeenCalledTimes(1);
    expect(resolveTargetChunkId, 'the deep-link target reached the cache branch').toHaveBeenCalledWith(
      BOOK, 'hypercite_abc', expect.anything(),
    );
    expect(h.syncBookDataFromDatabase, 'no "cannot load book" full-sync alert path').not.toHaveBeenCalled();
  });

  it('a terminal server answer (private / deleted) is NOT papered over with the cached fragment', async () => {
    markLocalCopyPartial(BOOK);
    h.fetchInitialChunk.mockResolvedValueOnce({ success: false, reason: 'access_denied' });

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.initializeLazyLoader).not.toHaveBeenCalled();
    expect(window.nodes).toBeUndefined();
  });

  it('a book the server has not heard of yet is never sent to the server path', async () => {
    markLocalCopyPartial(BOOK);
    h.isPendingNewBook.mockReturnValue(true);

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk, 'that path clears the local rows first').not.toHaveBeenCalled();
    expect(window.nodes).toBe(FRAGMENT);
  });
});

describe('an UNMARKED short copy is caught by the freshness check (counts, not just timestamps)', () => {
  it('asks the server for its node count and hands it to the short-copy check', async () => {
    stubLibraryFetch({ nodeCount: 3062 });

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(String(global.fetch.mock.calls[0][0])).toMatch(/\/library\?node_count=1$/);
    expect(h.shouldRepairShortLocalCopy).toHaveBeenCalledWith(BOOK, 3062);
  });

  it('timestamps level + local copy short → re-fetch with a manifest and backfill', async () => {
    stubLibraryFetch({ nodeCount: 3062 });
    h.shouldRepairShortLocalCopy.mockResolvedValue(true);

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk).toHaveBeenCalledTimes(1);
    expect(h.lazyLoader.chunkManifest).toEqual(MANIFEST);
    expect(h.backgroundDownloadRemainingChunks).toHaveBeenCalledWith(BOOK, h.lazyLoader);
  });

  it('POSITIVE CONTROL: timestamps level + copy whole → nothing is fetched or torn down', async () => {
    stubLibraryFetch({ nodeCount: 4 });

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.fetchInitialChunk).not.toHaveBeenCalled();
    expect(h.backgroundDownloadRemainingChunks).not.toHaveBeenCalled();
    expect(h.lazyLoader.refresh).not.toHaveBeenCalled();
  });

  it('a server that is simply NEWER takes the refresh path without consulting the count check', async () => {
    stubLibraryFetch({ timestamp: 900, nodeCount: 3062 });

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.shouldRepairShortLocalCopy).not.toHaveBeenCalled();
    expect(h.fetchInitialChunk).toHaveBeenCalledTimes(1);
  });

  it('a server that sends no count (older deploy) changes nothing', async () => {
    stubLibraryFetch({ nodeCount: null });

    await loadHyperText(BOOK, vi.fn());
    await settle();

    expect(h.shouldRepairShortLocalCopy).toHaveBeenCalledWith(BOOK, null);
    expect(h.fetchInitialChunk).not.toHaveBeenCalled();
  });
});
