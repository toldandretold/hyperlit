/**
 * Scroll-save lifecycle — guards the reading-position-corruption fix:
 *   1. createLazyLoader stores its scroll + beforeunload handlers, and disconnect() REMOVES them
 *      (so a previously-visited book's listener can't leak onto the shared scroll container and
 *      fire during the next book's navigation).
 *   2. Only the ACTIVE loader (instance === currentLazyLoader) may save — a stale instance writes
 *      nothing, so it can't overwrite the wrong book's saved position from the shared DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { content: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), debug: vi.fn(), content: vi.fn(), nav: vi.fn() },
}));
vi.mock('../../../resources/js/SPA/navigation/NavigationCompletionBarrier', () => ({
  NavigationCompletionBarrier: { registerProcess: vi.fn(), completeProcess: vi.fn(), getNavigationTarget: vi.fn(() => null) },
  NavigationProcess: { CONTENT_REFRESH: 'CONTENT_REFRESH' },
}));
// Per-book storage key so the two books are distinguishable.
vi.mock('../../../resources/js/indexedDB/index', () => ({
  getNodesFromIndexedDB: vi.fn(async () => []),
  getLocalStorageKey: vi.fn((prefix, bookId) => `${prefix}_${bookId}`),
  getHyperciteFromIndexedDB: vi.fn(async () => null),
}));
vi.mock('../../../resources/js/scrolling/index', () => ({
  setupUserScrollDetection: vi.fn(), shouldSkipScrollRestoration: vi.fn(() => false),
  isActivelyScrollingForLinkBlock: vi.fn(() => false), setNavigatingState: vi.fn(),
  getCascadeOriginId: vi.fn(() => null), scrollElementIntoMainContent: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/linkClickRegistry', () => ({ handleContentLinkClick: vi.fn() }));
vi.mock('../../../resources/js/utilities/scrollAnchor', () => ({ restoreScrollAnchor: vi.fn(), captureScrollAnchor: vi.fn(() => null) }));
vi.mock('../../../resources/js/lazyLoader/utilities/cacheState', () => ({ isCacheDirty: vi.fn(() => false), clearCacheDirtyFlag: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({
  setChunkLoadingInProgress: vi.fn(), clearChunkLoadingInProgress: vi.fn(), isChunkLoadingInProgress: vi.fn(() => false), scheduleAutoClear: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  createChunkElement: vi.fn(() => document.createElement('div')),
  ensureNoDeleteMarkerForBook: vi.fn().mockResolvedValue(undefined),
  throttle: (fn) => fn, // identity so the listener fires synchronously
  renderMathElements: vi.fn(), normalizeHyperciteElements: vi.fn(), applyHypercites: vi.fn(), applyHighlights: vi.fn(),
}));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(), isProgrammaticUpdateInProgress: vi.fn(() => false),
  chunkOverflowInProgress: false, userDeletionInProgress: false,
}));
vi.mock('../../../resources/js/scrolling/selectionAutoScroll', () => ({ isSelectionDragActive: vi.fn(() => false) }));
vi.mock('../../../resources/js/utilities/chunkState', () => ({ getCurrentChunk: vi.fn(() => null) }));
vi.mock('../../../resources/js/paste/pasteState', () => ({ isPasteOperationActive: vi.fn(() => false) }));
vi.mock('../../../resources/js/divEditor/index', () => ({ getPendingSaveNodeIds: vi.fn(() => new Set()) }));
// readingPosition is dynamically imported by forceSavePosition for the server save — stub it.
vi.mock('../../../resources/js/scrolling/readingPosition', () => ({ debouncedServerSave: vi.fn(), sendBeaconSave: vi.fn() }));

import { createLazyLoader } from '../../../resources/js/lazyLoader/index';
import { setCurrentLazyLoader } from '../../../resources/js/pageLoad/currentLazyLoaderState';

function makeLoader(bookId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-content-wrapper';
  const container = document.createElement('div');
  container.id = bookId;
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
  const inst = createLazyLoader({
    // non-empty nodes (createLazyLoader returns null for []); scrollableParent explicit for the test env
    nodes: [{ book: bookId, chunk_id: 0, startLine: 100, node_id: 'n1', content: 'x', footnotes: [], hyperlights: [], hypercites: [], raw_json: {} }],
    chunkManifest: null,
    loadNextChunk: vi.fn(), loadPreviousChunk: vi.fn(),
    attachMarkListeners: vi.fn(), attachUnderlineClickListeners: vi.fn(),
    bookId, onFirstChunkLoaded: vi.fn(), containerElement: container, scrollableParent: wrapper,
  });
  return { inst, container, wrapper };
}

// Stub a numeric top-visible paragraph so forceSavePosition has something to detect.
function seedTopNode(inst, container, id) {
  const p = document.createElement('p');
  p.id = String(id);
  p.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: 0 });
  container.appendChild(p);
  inst.scrollableParent.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800, x: 0, y: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  sessionStorage.clear();
  localStorage.clear();
  setCurrentLazyLoader(null);
});

describe('scroll-save listener lifecycle', () => {
  it('disconnect() removes the scroll + beforeunload listeners (no leak)', () => {
    const { inst } = makeLoader('bookA');
    expect(typeof inst._scrollSaveHandler).toBe('function');
    expect(typeof inst._beforeUnloadHandler).toBe('function');

    const scrollSpy = vi.spyOn(inst._scrollSaveTarget, 'removeEventListener');
    const winSpy = vi.spyOn(window, 'removeEventListener');

    inst.disconnect();

    expect(scrollSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(winSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(inst._scrollSaveHandler).toBeNull();
    expect(inst._beforeUnloadHandler).toBeNull();
  });
});

describe('only the active loader may save', () => {
  it('the ACTIVE loader saves its position', () => {
    const { inst, container } = makeLoader('bookA');
    seedTopNode(inst, container, 500);
    setCurrentLazyLoader(inst); // active

    inst.saveScrollPosition();

    // The saved shape is { elementId, offset, savedAt } — savedAt is a wall-clock stamp
    // (the "position last moved" time for the resume-vs-jump logic), so assert the stable
    // identity fields and that savedAt is present as a number rather than pinning its value.
    const saved = JSON.parse(sessionStorage.getItem('scrollPosition_bookA'));
    expect(saved).toMatchObject({ elementId: '500', offset: 0 });
    expect(typeof saved.savedAt).toBe('number');
  });

  it('a STALE loader (instance !== currentLazyLoader) writes NOTHING', () => {
    const a = makeLoader('bookA');
    seedTopNode(a.inst, a.container, 500);
    const b = makeLoader('bookB');
    setCurrentLazyLoader(b.inst); // book B is now active; A is stale

    // A's leftover listener fires while B is active and A's DOM shows node 500.
    a.inst.saveScrollPosition();

    // A must NOT have written — no cross-book contamination.
    expect(sessionStorage.getItem('scrollPosition_bookA')).toBeNull();
  });
});
