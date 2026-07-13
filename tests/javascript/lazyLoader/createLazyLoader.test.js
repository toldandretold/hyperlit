/**
 * createLazyLoader factory characterization — the core render/registration behaviours the reader
 * relies on, and the seam that makes Phase 2 adoption safe ("an already-registered chunk is never
 * re-rendered"). The factory is a DI leaf, so we inject spy attachers + a stub createChunkElement
 * and drive its IntersectionObserver synthetically.
 *
 * Deliberately NOT covered here (see plan Phase C — e2e): full refresh() with real IndexedDB
 * hydration, the document-wide link handler, and resize anchor restoration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the factory's side-effecting / controllable imports so it instantiates in happy-dom ──
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { content: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), debug: vi.fn(), content: vi.fn() },
}));
vi.mock('../../../resources/js/SPA/navigation/NavigationCompletionBarrier', () => ({
  NavigationCompletionBarrier: { registerProcess: vi.fn(), completeProcess: vi.fn(), getNavigationTarget: vi.fn(() => null) },
  NavigationProcess: { CONTENT_REFRESH: 'CONTENT_REFRESH' },
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  getNodesFromIndexedDB: vi.fn(async () => []),
  getLocalStorageKey: vi.fn(() => 'scroll-key'),
  getHyperciteFromIndexedDB: vi.fn(async () => null),
}));
vi.mock('../../../resources/js/scrolling/index', () => ({
  setupUserScrollDetection: vi.fn(),
  shouldSkipScrollRestoration: vi.fn(() => false),
  isActivelyScrollingForLinkBlock: vi.fn(() => false),
  setNavigatingState: vi.fn(),
  getCascadeOriginId: vi.fn(() => null),
  scrollElementIntoMainContent: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/linkClickRegistry', () => ({ handleContentLinkClick: vi.fn() }));
vi.mock('../../../resources/js/utilities/scrollAnchor', () => ({ restoreScrollAnchor: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/utilities/cacheState', () => ({
  isCacheDirty: vi.fn(() => false),
  clearCacheDirtyFlag: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({
  setChunkLoadingInProgress: vi.fn(),
  clearChunkLoadingInProgress: vi.fn(),
  isChunkLoadingInProgress: vi.fn(() => false),
  scheduleAutoClear: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  // Stub render: a real .chunk[data-chunk-id] div with one child <p id=startLine> per node, so
  // DOM queries (getLastChunkElement, parseChunkId, reposition) work against it.
  createChunkElement: vi.fn((nodes) => {
    const div = document.createElement('div');
    div.className = 'chunk';
    div.setAttribute('data-chunk-id', String(nodes[0].chunk_id));
    for (const n of nodes) {
      const p = document.createElement('p');
      p.id = String(n.startLine);
      p.setAttribute('data-node-id', n.node_id);
      div.appendChild(p);
    }
    return div;
  }),
  ensureNoDeleteMarkerForBook: vi.fn().mockResolvedValue(undefined),
  throttle: (fn) => fn, // passthrough so scroll handlers stay direct
  // re-exported by index.ts — present so the re-export resolves
  renderMathElements: vi.fn(),
  normalizeHyperciteElements: vi.fn(),
  applyHypercites: vi.fn(),
  applyHighlights: vi.fn(),
}));

// REAL (pure, decimal-aware): indexedDB/types (asChunkId/parseChunkId) + utilities/chunkSelection.
import { createLazyLoader } from '../../../resources/js/lazyLoader/index';
import { createChunkElement } from '../../../resources/js/lazyLoader/chunkRender';
import { isChunkLoadingInProgress } from '../../../resources/js/lazyLoader/utilities/chunkLoadingState';

const flush = () => new Promise((r) => setTimeout(r, 0));

const node = (chunkId, startLine, id) => ({
  book: 'bookA', chunk_id: chunkId, startLine, node_id: id,
  content: `c${startLine}`, plainText: `c${startLine}`, type: null,
  footnotes: [], hyperlights: [], hypercites: [],
});
// chunk 0 (lines 0,1) + chunk 1 (line 2), fully loaded (no manifest).
const NODES = [node(0, 0, 'N0'), node(0, 1, 'N1'), node(1, 2, 'N2')];

let observerCb;

function makeLoader({ nodes = NODES, chunkManifest = null } = {}) {
  const container = document.createElement('div');
  container.id = 'bookA';
  document.body.appendChild(container);
  const onFirstChunkLoaded = vi.fn();
  const attachMarkListeners = vi.fn();
  const attachUnderlineClickListeners = vi.fn();
  const inst = createLazyLoader({
    nodes, chunkManifest,
    loadNextChunk: vi.fn(), loadPreviousChunk: vi.fn(),
    attachMarkListeners, attachUnderlineClickListeners,
    bookId: 'bookA', onFirstChunkLoaded, containerElement: container,
  });
  return { inst, container, onFirstChunkLoaded, attachMarkListeners, attachUnderlineClickListeners };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  observerCb = null;
  isChunkLoadingInProgress.mockReturnValue(false);
  // Capture the IntersectionObserver callback so tests can fire sentinel intersections.
  // Regular function (NOT arrow) so the factory's `new IntersectionObserver(...)` works.
  global.IntersectionObserver = vi.fn(function (cb) {
    observerCb = cb;
    this.observe = vi.fn();
    this.unobserve = vi.fn();
    this.disconnect = vi.fn();
  });
});

describe('createLazyLoader — render + registration', () => {
  it('loadChunk(0) renders the chunk, registers it, fires the first-chunk callback, attaches listeners', async () => {
    const { inst, container, onFirstChunkLoaded, attachMarkListeners, attachUnderlineClickListeners } = makeLoader();

    await inst.loadChunk(0, 'down');

    expect(createChunkElement).toHaveBeenCalledTimes(1);
    expect(createChunkElement.mock.calls[0][0].map((n) => n.startLine)).toEqual([0, 1]); // chunk 0's nodes
    expect(inst.currentlyLoadedChunks.has(0)).toBe(true);
    expect(onFirstChunkLoaded).toHaveBeenCalledTimes(1);
    const chunkEl = container.querySelector('.chunk[data-chunk-id="0"]');
    expect(chunkEl).toBeTruthy();
    expect(attachMarkListeners).toHaveBeenCalledWith(chunkEl);
    expect(attachUnderlineClickListeners).toHaveBeenCalledWith(chunkEl);
  });

  it('a second loadChunk(0) EARLY-EXITS — no re-render (createChunkElement not called again)', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    createChunkElement.mockClear();

    await inst.loadChunk(0, 'down');

    expect(createChunkElement).not.toHaveBeenCalled();
  });

  it('EARLY-EXIT: an already-loaded chunk is never re-rendered', async () => {
    const { inst, container } = makeLoader();
    // A chunk already in currentlyLoadedChunks (e.g. rendered earlier) must not be rebuilt.
    const pre = document.createElement('div');
    pre.className = 'chunk';
    pre.setAttribute('data-chunk-id', '0');
    container.appendChild(pre);
    inst.currentlyLoadedChunks.add(0);

    await inst.loadChunk(0, 'down');

    expect(createChunkElement).not.toHaveBeenCalled(); // already-loaded chunk NOT re-rendered
  });
});

describe('createLazyLoader — sentinels + observer', () => {
  it('repositionSentinels puts top before the first chunk, bottom after the last, and rebuilds the loaded set', async () => {
    const { inst, container } = makeLoader();
    await inst.loadChunk(0, 'down');
    await inst.loadChunk(1, 'down');

    inst.repositionSentinels();

    const kids = Array.from(container.children);
    expect(kids[0]).toBe(inst.topSentinel);
    expect(kids[kids.length - 1]).toBe(inst.bottomSentinel);
    // top sentinel sits immediately before the first chunk; bottom after the last
    const chunks = Array.from(container.querySelectorAll('.chunk'));
    expect(kids.indexOf(inst.topSentinel)).toBeLessThan(kids.indexOf(chunks[0]));
    expect(kids.indexOf(inst.bottomSentinel)).toBeGreaterThan(kids.indexOf(chunks[chunks.length - 1]));
    expect(inst.currentlyLoadedChunks.has(0)).toBe(true);
    expect(inst.currentlyLoadedChunks.has(1)).toBe(true);
  });

  it('bottom-sentinel intersection loads the NEXT chunk', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    createChunkElement.mockClear();

    await observerCb([{ target: inst.bottomSentinel, isIntersecting: true }]);
    await flush();

    expect(createChunkElement).toHaveBeenCalledTimes(1);
    expect(createChunkElement.mock.calls[0][0].map((n) => n.startLine)).toEqual([2]); // chunk 1
    expect(inst.currentlyLoadedChunks.has(1)).toBe(true);
  });

  it('observer is SUPPRESSED while a chunk load is in progress', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    createChunkElement.mockClear();
    isChunkLoadingInProgress.mockReturnValue(true);

    await observerCb([{ target: inst.bottomSentinel, isIntersecting: true }]);
    await flush();

    expect(createChunkElement).not.toHaveBeenCalled();
  });

  it('observer is SUPPRESSED while scroll is locked', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    createChunkElement.mockClear();
    inst.scrollLocked = true;

    await observerCb([{ target: inst.bottomSentinel, isIntersecting: true }]);
    await flush();

    expect(createChunkElement).not.toHaveBeenCalled();
  });

  it('a non-intersecting entry does nothing', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    createChunkElement.mockClear();

    await observerCb([{ target: inst.bottomSentinel, isIntersecting: false }]);
    await flush();

    expect(createChunkElement).not.toHaveBeenCalled();
  });
});

describe('createLazyLoader — scroll lock + teardown', () => {
  it('lockScroll / unlockScroll toggle the scroll-lock state', () => {
    const { inst } = makeLoader();
    inst.lockScroll('refresh');
    expect(inst.scrollLocked).toBe(true);
    expect(inst.scrollLockReason).toBe('refresh');
    inst.unlockScroll();
    expect(inst.scrollLocked).toBe(false);
  });

  it('disconnect() disconnects the IntersectionObserver', () => {
    const { inst } = makeLoader();
    inst.disconnect();
    expect(inst.observer.disconnect).toHaveBeenCalled();
  });
});
