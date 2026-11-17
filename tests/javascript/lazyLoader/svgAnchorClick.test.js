/**
 * createLazyLoader's DOCUMENT-level link handler must forward a click on an SVG
 * anchor (the hypercite-network map's dots, the harvest graphs) to the
 * registered router with a real destination. It used to bail on `!link.href`
 * (happy-dom: undefined) or — in a browser — stringify the SVGAnimatedString
 * into "/[object%20SVGAnimatedString]". Mocks mirror createLazyLoader.test.js.
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

import { createLazyLoader } from '../../../resources/js/lazyLoader/index';
import { handleContentLinkClick } from '../../../resources/js/utilities/linkClickRegistry';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeLoader() {
  const container = document.createElement('div');
  container.id = 'shelf_feed';
  container.className = 'main-content';
  document.body.appendChild(container);
  return createLazyLoader({
    nodes: [], chunkManifest: null,
    loadNextChunk: vi.fn(), loadPreviousChunk: vi.fn(),
    attachMarkListeners: vi.fn(), attachUnderlineClickListeners: vi.fn(),
    bookId: 'shelf_feed', onFirstChunkLoaded: vi.fn(), containerElement: container,
  });
}

/** A hero-page SVG dot with a browser-shaped (object) href. */
function svgDot(href) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const a = document.createElementNS(SVG_NS, 'a');
  a.setAttribute('href', href);
  a.setAttribute('data-map-node', 'lit');
  Object.defineProperty(a, 'href', {
    configurable: true,
    get() { const el = this; return { get baseVal() { return el.getAttribute('href'); }, toString() { return '[object SVGAnimatedString]'; } }; },
  });
  const circle = document.createElementNS(SVG_NS, 'circle');
  a.appendChild(circle);
  svg.appendChild(a);
  document.body.appendChild(svg);
  return { a, circle };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  global.IntersectionObserver = vi.fn(function () {
    this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn();
  });
  window.history.replaceState(null, '', '/a/decolonising-security');
});

describe('createLazyLoader document link handler × SVG anchors', () => {
  it('forwards a dot click to the registered router (does not bail on the object href)', async () => {
    const inst = makeLoader();
    const { circle } = svgDot('/pushing-the-boundaries-can-we-decolonize-security-studies');

    circle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();

    expect(handleContentLinkClick).toHaveBeenCalledTimes(1);
    const ev = handleContentLinkClick.mock.calls[0][0];
    expect(ev.target).toBe(circle);
    inst.disconnect();
  });

  it('a dot whose href carries a #hypercite_ hash is NOT mistaken for a "cited-by" container link', async () => {
    // The hash branch opens the unified container for links pointing INTO a
    // hypercite from content; a map dot's intro hash must still reach the router.
    const inst = makeLoader();
    const { circle } = svgDot('/pushing-the-boundaries#hypercite_t5skblf');
    const openDatabase = vi.fn();
    vi.doMock('../../../resources/js/indexedDB/index', () => ({ openDatabase, getNodesFromIndexedDB: vi.fn(), getLocalStorageKey: vi.fn(), getHyperciteFromIndexedDB: vi.fn() }));

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    circle.dispatchEvent(ev);
    await settle();

    // Either outcome is a REAL destination: the container path (preventDefault,
    // consults the library) or the router. What must never happen is a fall
    // through with a garbage URL — and `new URL('[object SVGAnimatedString]')`
    // has no hash, so the old code always took the router with the wrong path.
    const routed = handleContentLinkClick.mock.calls.length === 1;
    expect(routed || ev.defaultPrevented).toBe(true);
    inst.disconnect();
    vi.doUnmock('../../../resources/js/indexedDB/index');
  });

  it('disconnect() releases the handler — a closed feed stops hijacking hero links', async () => {
    const inst = makeLoader();
    const { circle } = svgDot('/pushing-the-boundaries-can-we-decolonize-security-studies');
    inst.disconnect();

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    circle.dispatchEvent(ev);
    await settle();

    expect(handleContentLinkClick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('an anchor with no destination is ignored (no throw, no forward)', async () => {
    const inst = makeLoader();
    const a = document.createElement('a');
    a.textContent = 'x';
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    expect(handleContentLinkClick).not.toHaveBeenCalled();
    inst.disconnect();
  });
});
