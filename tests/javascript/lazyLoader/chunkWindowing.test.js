/**
 * Chunk-lifecycle INVARIANTS — the load-bearing DOM guarantees the lazy loader (and the coming
 * "chunk windowing / cleanup on scroll" feature) rest on:
 *
 *   ALWAYS one contiguous, numerically-ordered block of `.chunk[data-chunk-id]` divs, framed by the
 *   top + bottom sentinels (top = firstElementChild, bottom = lastElementChild). NEVER two islands,
 *   never a chunk outside the sentinels, never out of order.
 *
 * The observer's "load next/prev" math reads the FIRST/LAST `[data-chunk-id]` in the DOM, so a
 * second island or a stray chunk breaks everything. Phase 1 pins the CURRENT behaviour (no prod
 * changes) so the upcoming removal feature can't silently violate it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mock seam as createLazyLoader.test.js — instantiate the factory in happy-dom.
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
vi.mock('../../../resources/js/utilities/scrollAnchor', () => ({ restoreScrollAnchor: vi.fn(), captureScrollAnchor: vi.fn(() => null) }));
vi.mock('../../../resources/js/lazyLoader/utilities/cacheState', () => ({ isCacheDirty: vi.fn(() => false), clearCacheDirtyFlag: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({
  setChunkLoadingInProgress: vi.fn(), clearChunkLoadingInProgress: vi.fn(), isChunkLoadingInProgress: vi.fn(() => false), scheduleAutoClear: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
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
  throttle: (fn) => fn,
  renderMathElements: vi.fn(),
  normalizeHyperciteElements: vi.fn(),
  applyHypercites: vi.fn(),
  applyHighlights: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
// windowChunks' safety seams: editor-save suppression flag + the operation gates.
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
  isProgrammaticUpdateInProgress: vi.fn(() => false),
  chunkOverflowInProgress: false,
  userDeletionInProgress: false,
}));
vi.mock('../../../resources/js/scrolling/selectionAutoScroll', () => ({ isSelectionDragActive: vi.fn(() => false) }));
vi.mock('../../../resources/js/utilities/chunkState', () => ({ getCurrentChunk: vi.fn(() => null) }));
vi.mock('../../../resources/js/paste/pasteState', () => ({ isPasteOperationActive: vi.fn(() => false) }));
vi.mock('../../../resources/js/divEditor/index', () => ({ getPendingSaveNodeIds: vi.fn(() => new Set()) }));

import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed, repositionSentinels } from '../../../resources/js/lazyLoader/index';
import { MAX_LOADED_CHUNKS, trimWindow } from '../../../resources/js/lazyLoader/utilities/windowChunks';
import { fillViewport } from '../../../resources/js/lazyLoader/utilities/fillViewport';
import { isCacheDirty } from '../../../resources/js/lazyLoader/utilities/cacheState';
import { setProgrammaticUpdateInProgress } from '../../../resources/js/utilities/operationState';
import { isSelectionDragActive } from '../../../resources/js/scrolling/selectionAutoScroll';
import { captureScrollAnchor, restoreScrollAnchor } from '../../../resources/js/utilities/scrollAnchor';
import { getCurrentChunk } from '../../../resources/js/utilities/chunkState';
import { isPasteOperationActive } from '../../../resources/js/paste/pasteState';
import { getPendingSaveNodeIds } from '../../../resources/js/divEditor/index';

const flush = () => new Promise((r) => setTimeout(r, 0));

const node = (chunkId, startLine, id) => ({
  book: 'bookA', chunk_id: chunkId, startLine, node_id: id,
  content: `c${startLine}`, plainText: `c${startLine}`, type: null,
  footnotes: [], hyperlights: [], hypercites: [],
});
// Five chunks (0..4), 2 nodes each — fully loaded (no manifest), so loads come from instance.nodes.
const NODES = [];
for (let ch = 0; ch <= 4; ch++) { NODES.push(node(ch, ch * 2, `N${ch}a`), node(ch, ch * 2 + 1, `N${ch}b`)); }
// 10 chunks (0..9) — enough to exceed MAX_LOADED_CHUNKS (7) and trigger windowing.
const BIG_NODES = [];
for (let ch = 0; ch <= 9; ch++) { BIG_NODES.push(node(ch, ch * 2, `B${ch}a`), node(ch, ch * 2 + 1, `B${ch}b`)); }

let observerCb;

function makeLoader({ nodes = NODES, prerenderChunkId = null } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-content-wrapper'; // so scrollableParent is a real element (has scrollTop)
  const container = document.createElement('div');
  container.id = 'bookA';
  // Optionally inject a server-prerendered chunk before the loader takes over (adoption test).
  if (prerenderChunkId !== null) {
    const pre = document.createElement('div');
    pre.className = 'chunk';
    pre.setAttribute('data-chunk-id', String(prerenderChunkId));
    pre.setAttribute('data-prerendered', 'true');
    for (const n of nodes.filter((x) => x.chunk_id === prerenderChunkId)) {
      const p = document.createElement('p'); p.id = String(n.startLine); p.setAttribute('data-node-id', n.node_id); pre.appendChild(p);
    }
    container.appendChild(pre);
  }
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
  const inst = createLazyLoader({
    nodes, chunkManifest: null,
    loadNextChunk: vi.fn(), loadPreviousChunk: vi.fn(),
    attachMarkListeners: vi.fn(), attachUnderlineClickListeners: vi.fn(),
    bookId: 'bookA', onFirstChunkLoaded: vi.fn(), containerElement: container,
  });
  return { inst, container };
}

/** THE invariant: top/bottom sentinels frame ONE contiguous block of chunks in strict ascending order. */
function assertSingleOrderedBlock(inst) {
  const c = inst.container;
  expect(c.firstElementChild).toBe(inst.topSentinel);
  expect(c.lastElementChild).toBe(inst.bottomSentinel);
  const middle = Array.from(c.children).slice(1, -1);
  expect(middle.length).toBeGreaterThan(0);
  const ids = middle.map((el) => {
    expect(el.classList.contains('chunk')).toBe(true);     // no non-chunk element between sentinels
    expect(el.hasAttribute('data-chunk-id')).toBe(true);
    return parseFloat(el.getAttribute('data-chunk-id'));
  });
  for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]); // strictly ascending
  // DOM block matches the Set bookkeeping
  expect(new Set(ids)).toEqual(new Set([...inst.currentlyLoadedChunks]));
  return ids;
}

// Fire a sentinel intersection through the captured observer callback.
const fireBottom = (inst) => observerCb([{ target: inst.bottomSentinel, isIntersecting: true }]);
const fireTop = (inst) => observerCb([{ target: inst.topSentinel, isIntersecting: true }]);

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  observerCb = null;
  global.IntersectionObserver = vi.fn(function (cb) {
    observerCb = cb;
    this.observe = vi.fn();
    this.unobserve = vi.fn();
    this.disconnect = vi.fn();
  });
  // Re-establish defaults for the mocks tests toggle (clearAllMocks doesn't reset implementations).
  isSelectionDragActive.mockReturnValue(false);
  captureScrollAnchor.mockReturnValue(null);
  getCurrentChunk.mockReturnValue(null);
  isPasteOperationActive.mockReturnValue(false);
  getPendingSaveNodeIds.mockReturnValue(new Set());
  delete window.editMode;
});

// happy-dom has no layout — stub element rects so the off-screen guard has geometry to read.
function stubRect(el, top, bottom) {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top });
}
// Viewport = scrollableParent spans 0..800; mark every loaded chunk on/off-screen.
function setGeometry(inst, { offscreen }) {
  stubRect(inst.scrollableParent, 0, 800);
  inst.container.querySelectorAll('.chunk').forEach((c) =>
    offscreen ? stubRect(c, -1000, -900) : stubRect(c, 100, 300),
  );
}
// Load chunks 0..n WITHOUT triggering trimWindow (loadChunk → loadChunkInternal, no trim).
async function loadChunks(inst, n) { for (let i = 0; i <= n; i++) { await inst.loadChunk(i, 'down'); } }
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

describe('chunk DOM invariants — current behaviour', () => {
  it('initial load = [top, chunk0, bottom]', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    expect(assertSingleOrderedBlock(inst)).toEqual([0]);
  });

  it('scroll DOWN appends higher chunks in order, bottom sentinel stays last', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    await fireBottom(inst); await flush();
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1]);
    await fireBottom(inst); await flush();
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2]);
  });

  it('scroll UP prepends lower chunks, top sentinel stays first, ids ascending top→bottom', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(2, 'down');
    await fireTop(inst); await flush();
    expect(assertSingleOrderedBlock(inst)).toEqual([1, 2]);
    await fireTop(inst); await flush();
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2]);
  });

  it('mixed up/down keeps one ordered block within the sentinels', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(2, 'down');
    await fireBottom(inst); await flush();   // 2,3
    await fireTop(inst); await flush();      // 1,2,3
    await fireBottom(inst); await flush();   // 1,2,3,4
    await fireTop(inst); await flush();      // 0,1,2,3,4
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2, 3, 4]);
  });

  it('boundaries: no chunk below 0 on scroll-up, none past the last on scroll-down', async () => {
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    await fireTop(inst); await flush();      // chunk -1 doesn't exist
    expect(assertSingleOrderedBlock(inst)).toEqual([0]);

    await inst.loadChunk(4, 'down');         // now [0, 4] — load the top end
    await fireBottom(inst); await flush();   // nothing after chunk 4
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 4]);
  });

  it('prerendered chunk is rendered IN PLACE within the sentinels and lazy-loads its neighbour', async () => {
    const { inst, container } = makeLoader({ prerenderChunkId: 0 }); // server injected chunk 0
    // createLazyLoader framed it with sentinels; the normal load path sees the placeholder
    // already in the DOM and swaps the canonical chunk in place — no duplicate, no special path.
    await inst.loadChunk(0, 'down');
    expect(container.querySelectorAll('.chunk[data-chunk-id="0"]').length).toBe(1); // replaced, not duplicated
    expect(container.querySelector('.chunk[data-chunk-id="0"]').hasAttribute('data-prerendered')).toBe(false);
    expect(inst.currentlyLoadedChunks.has(0)).toBe(true);
    expect(assertSingleOrderedBlock(inst)).toEqual([0]);   // the single block

    await fireBottom(inst); await flush();                 // scroll down → next chunk after it
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1]);
  });

  it('re-firing a sentinel for an already-loaded neighbour does NOT duplicate or create a second island', async () => {
    const { inst, container } = makeLoader();
    await inst.loadChunk(0, 'down');
    await fireBottom(inst); await flush();   // loads 1
    // A stale "next after 0" fire while 1 is already present → guarded, no duplicate.
    await loadNextChunkFixed(0, inst); await flush();
    expect(container.querySelectorAll('.chunk[data-chunk-id="1"]').length).toBe(1);
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1]);
  });

  it('out-of-order arrival still resolves to a single ascending block (repositionSentinels)', async () => {
    const { inst } = makeLoader();
    // Load 2 then 0 then 1 via direct loads (simulating odd arrival), then let reposition sort.
    await inst.loadChunk(2, 'down');
    await loadPreviousChunkFixed(2, inst); await flush(); // 1,2
    await loadPreviousChunkFixed(1, inst); await flush(); // 0,1,2
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2]);
  });

  // ── Regression: the back-nav scramble (chunk1, bottom-sentinel, top-sentinel, chunk0) ──
  // Repro: server prerenders the saved-position chunk (1); the client adopts it, then eager-loads
  // chunk 0 with direction "down". Before the fix, "down" inserted chunk 0 BELOW chunk 1 and
  // repositionSentinels wrapped the mis-ordered chunks, stranding the sentinels in the middle.
  it('adopting a higher-id resume chunk, then loadChunk(0,"down"), stays ordered (scramble repro)', async () => {
    const { inst } = makeLoader({ prerenderChunkId: 1 }); // saved-position chunk prerendered = 1
    await inst.loadChunk(1, 'down');                      // adopt in place → [top, 1, bottom]
    expect(assertSingleOrderedBlock(inst)).toEqual([1]);

    await inst.loadChunk(0, 'down');                      // lower-id chunk, requested "down"
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1]); // NOT [1,0] with stranded sentinels
  });

  it('repositionSentinels HEALS a hand-scrambled DOM into ascending order', async () => {
    const { inst, container } = makeLoader();
    await inst.loadChunk(0, 'down');
    await inst.loadChunk(1, 'down');                      // [top, 0, 1, bottom]
    const c0 = container.querySelector('.chunk[data-chunk-id="0"]');
    const c1 = container.querySelector('.chunk[data-chunk-id="1"]');
    // Force the exact reported bug shape: chunk1, bottom-sentinel, top-sentinel, chunk0.
    container.innerHTML = '';
    container.append(c1, inst.bottomSentinel, inst.topSentinel, c0);

    repositionSentinels(inst);                            // must reorder the CHUNKS, not just sentinels

    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1]);
  });
});

describe('DOM windowing — chunk cleanup on scroll (Phase 2)', () => {
  // Helper: load 10 chunks (no trim), make them all off-screen, then trim down.
  async function loadedOffscreen(inst) {
    await loadChunks(inst, 9);          // chunks 0..9 in DOM, no trimming yet
    setGeometry(inst, { offscreen: true });
  }

  it('trims the window down to the budget, removing the LOWEST off-screen chunks (scroll down)', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loadedOffscreen(inst);

    await trimWindow(inst, 'down');

    const ids = assertSingleOrderedBlock(inst);
    expect(ids).toEqual([3, 4, 5, 6, 7, 8, 9]);            // bounded to 7, lowest removed
    expect(inst.currentlyLoadedChunks.has(0)).toBe(false); // dropped from the Set → re-loadable
    expect(inst.container.querySelector('.chunk[data-chunk-id="0"]')).toBeNull();
  });

  it('scroll UP trims the HIGHEST off-screen chunks', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loadedOffscreen(inst);

    await trimWindow(inst, 'up');

    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2, 3, 4, 5, 6]); // highest removed
  });

  it('preserves scroll position: captures + restores the scroll anchor on removal', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loadedOffscreen(inst);
    captureScrollAnchor.mockReturnValue({ element: inst.container, offsetFromContainer: 0 }); // connected

    await trimWindow(inst, 'down');

    expect(captureScrollAnchor).toHaveBeenCalled();
    expect(restoreScrollAnchor).toHaveBeenCalled();
  });

  it('NEVER trims while a selection is active (long cross-chunk copy/cut is safe)', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loadedOffscreen(inst);
    isSelectionDragActive.mockReturnValue(true);

    await trimWindow(inst, 'down');

    expect(assertSingleOrderedBlock(inst).length).toBe(10); // all kept
  });
});

describe('DOM windowing — safety guards (Phase 2 hardening A–E)', () => {
  async function loaded(inst) { await loadChunks(inst, 9); }

  it('A. suppression flag is cleared on the NEXT FRAME, not synchronously', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    setGeometry(inst, { offscreen: true });
    setProgrammaticUpdateInProgress.mockClear();

    await trimWindow(inst, 'down');

    // raised during removal, but NOT yet cleared — the editor's async observer must still see it set
    expect(setProgrammaticUpdateInProgress).toHaveBeenCalledWith(true);
    expect(setProgrammaticUpdateInProgress).not.toHaveBeenCalledWith(false);
    await nextFrame();
    expect(setProgrammaticUpdateInProgress).toHaveBeenCalledWith(false);
  });

  it('B. only removes FULLY off-screen chunks — a visible far-end chunk stops the trim', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    setGeometry(inst, { offscreen: false }); // everything on-screen (tiny-chunk catastrophe)

    await trimWindow(inst, 'down');

    expect(assertSingleOrderedBlock(inst).length).toBe(10); // nothing removed — safe, no content vanishes
  });

  it('B. stops at the first visible chunk even if still over budget (partial trim)', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    stubRect(inst.scrollableParent, 0, 800);
    // chunks 0,1 off-screen above; 2..9 visible
    inst.container.querySelectorAll('.chunk').forEach((c) => {
      const id = parseFloat(c.getAttribute('data-chunk-id'));
      id <= 1 ? stubRect(c, -1000, -900) : stubRect(c, 100, 300);
    });

    await trimWindow(inst, 'down');

    expect(assertSingleOrderedBlock(inst)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]); // removed 0,1; stopped at visible 2
  });

  it('C. never removes the chunk holding the caret', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    setGeometry(inst, { offscreen: true });
    getCurrentChunk.mockReturnValue('0'); // caret is in chunk 0 (the would-be victim)

    await trimWindow(inst, 'down');

    expect(inst.currentlyLoadedChunks.has(0)).toBe(true);
    expect(assertSingleOrderedBlock(inst).length).toBe(10);
  });

  it('D. (edit mode) never removes a chunk with pending unsaved edits', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    setGeometry(inst, { offscreen: true });
    window.editMode = true;
    getPendingSaveNodeIds.mockReturnValue(new Set(['0'])); // node '0' lives in chunk 0

    await trimWindow(inst, 'down');

    expect(inst.currentlyLoadedChunks.has(0)).toBe(true);   // chunk 0 kept until its edit flushes
    expect(assertSingleOrderedBlock(inst).length).toBe(10);
  });

  it('E. no-op while a paste is in progress', async () => {
    const { inst } = makeLoader({ nodes: BIG_NODES });
    await loaded(inst);
    setGeometry(inst, { offscreen: true });
    isPasteOperationActive.mockReturnValue(true);

    await trimWindow(inst, 'down');

    expect(assertSingleOrderedBlock(inst).length).toBe(10);
  });
});

describe('fillViewport — resilience to small/short chunks + chunk-edge landings', () => {
  // fillViewport drives the instance's own loaders (in prod = loadNextChunkFixed / loadPreviousChunkFixed,
  // injected via createLazyLoader). makeLoader stubs them with vi.fn(), so point them at the real ones.
  // Then stub the SENTINEL rects (fillViewport only measures sentinels) to simulate "in/out of view".
  function realLoaders(inst) {
    inst.loadNextChunk = loadNextChunkFixed;
    inst.loadPreviousChunk = loadPreviousChunkFixed;
  }
  // scrollableParent spans 0..800; a sentinel "in view" sits inside it, "out" sits well below + margin.
  function sentinels(inst, { top, bottom }) {
    stubRect(inst.scrollableParent, 0, 800);
    if (inst.topSentinel) stubRect(inst.topSentinel, top ? 400 : -2000, top ? 400 : -2000);
    if (inst.bottomSentinel) stubRect(inst.bottomSentinel, bottom ? 400 : 2000, bottom ? 400 : 2000);
  }

  it('tiny chunks: keeps loading NEXT until the manifest is exhausted, then terminates (no stranding)', async () => {
    const { inst } = makeLoader();
    realLoaders(inst);
    await inst.loadChunk(0, 'down');           // only chunk 0 rendered
    sentinels(inst, { top: false, bottom: true }); // bottom sentinel stuck in view (short content)

    await fillViewport(inst);

    // Loaded every chunk to the end (0..4) — the bottom sentinel never left view, so it kept filling.
    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2, 3, 4]);
  });

  it('edge landing: fills BOTH directions so there is content above and below the landing', async () => {
    const { inst } = makeLoader();
    realLoaders(inst);
    await inst.loadChunk(2, 'down');           // landed on a middle chunk
    sentinels(inst, { top: true, bottom: true });

    await fillViewport(inst);

    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2, 3, 4]); // neighbours above (1,0) and below (3,4)
  });

  it('terminates at the boundaries — no infinite loop when there is no next/prev to load', async () => {
    const { inst } = makeLoader();
    realLoaders(inst);
    await inst.loadChunk(0, 'down');
    // Top sentinel in view but chunk 0 has no previous; bottom OUT of view so nothing below either.
    sentinels(inst, { top: true, bottom: false });

    await fillViewport(inst);                   // must return promptly, not hang

    expect(assertSingleOrderedBlock(inst)).toEqual([0]); // no-op: no prev (chunk 0), bottom not in view
  });

  it('does not over-load: both sentinels out of view → loads nothing', async () => {
    const { inst } = makeLoader();
    realLoaders(inst);
    await inst.loadChunk(2, 'down');
    sentinels(inst, { top: false, bottom: false }); // viewport already covered

    await fillViewport(inst);

    expect(assertSingleOrderedBlock(inst)).toEqual([2]);
  });

  it('atomic reservation: two CONCURRENT loads of the same chunk insert it ONCE (the deep-link race)', async () => {
    // The deep-link nav fires loadChunk(0,1,2) all at once (+ prerender + eager). Each load has an
    // await between its "already loaded?" check and its DOM insert, so without a synchronous
    // reservation two loads of the SAME chunk both pass the check and both insert → duplicate.
    const { inst, container } = makeLoader();
    isCacheDirty.mockReturnValue(true); // force the await (getNodesFromIndexedDB) between reserve & insert
    try {
      await Promise.all([inst.loadChunk(0, 'down'), inst.loadChunk(0, 'down')]);
      expect(container.querySelectorAll('.chunk[data-chunk-id="0"]').length).toBe(1); // not two
      expect(inst.currentlyLoadedChunks.has(0)).toBe(true);
    } finally {
      isCacheDirty.mockReturnValue(false);
    }
  });

  it('re-arms (re-observes) the sentinels after a load — edge→level, the short-chunk / scroll-up jam fix', async () => {
    // IntersectionObserver is edge-triggered; a short chunk that loads without pushing the sentinel
    // out of view leaves it silent. After a load settles we re-observe both sentinels, which delivers
    // a fresh current-state callback (so the observer can fire again). Here: assert the re-observe wiring.
    const { inst } = makeLoader();
    await inst.loadChunk(0, 'down');
    inst.observer.observe.mockClear();
    inst.observer.unobserve.mockClear();

    await loadNextChunkFixed(0, inst);                 // loads chunk 1, then re-arms in a 100ms timer
    await new Promise((r) => setTimeout(r, 140));

    expect(inst.observer.unobserve).toHaveBeenCalledWith(inst.bottomSentinel);
    expect(inst.observer.observe).toHaveBeenCalledWith(inst.bottomSentinel);
    expect(inst.observer.observe).toHaveBeenCalledWith(inst.topSentinel);   // both re-sampled
  });

  it('re-entrancy guard: a second concurrent fill is a no-op while one is running', async () => {
    const { inst } = makeLoader();
    realLoaders(inst);
    await inst.loadChunk(0, 'down');
    sentinels(inst, { top: false, bottom: true });

    const a = fillViewport(inst);
    const b = fillViewport(inst);   // should early-return (instance._fillingViewport set)
    await Promise.all([a, b]);

    expect(assertSingleOrderedBlock(inst)).toEqual([0, 1, 2, 3, 4]);
  });
});
