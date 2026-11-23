/**
 * restoreScrollPosition()'s no-saved-position branch must act on the loader it STARTED with.
 *
 * `currentLazyLoader` is a live module binding: a navigation nulls it (resetCurrentLazyLoader) and
 * then points it at the NEXT book's loader. The branch used to re-read it after every await and
 * inside a 100ms timer, so a quick nav away from a freshly-entered reader threw
 * "Cannot read properties of null (reading 'saveScrollPosition')" as an uncaught page error
 * (hypercite-map-links e2e: reader lands → immediate goBack), and with a new loader already in
 * place it would have cleared and refilled ANOTHER book's container with this book's nodes.
 *
 * Drives the REAL restoreScrollPosition().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  verbose: { nav: vi.fn() },
}));
vi.mock('../../../resources/js/app', () => ({
  book: 'book_test',
  OpenHyperlightID: null,
  OpenFootnoteID: null,
}));
vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  getNodesFromIndexedDB,
  getLocalStorageKey: (prefix, bookId) => `${prefix}_${bookId}`,
}));
vi.mock('../../../resources/js/indexedDB/types', () => ({ parseChunkId: (s) => parseFloat(s) }));
vi.mock('../../../resources/js/utilities/convertMarkdown', () => ({ parseMarkdownIntoChunksInitial: vi.fn(() => []) }));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  shouldSkipScrollRestoration: vi.fn(() => false),
  setSkipScrollRestoration: vi.fn(),
}));
vi.mock('../../../resources/js/search/inTextSearch/searchToolbar', () => ({ isSearchToolbarOpen: vi.fn(() => false) }));
vi.mock('../../../resources/js/scrolling/userScrollDetection', () => ({ shouldSkipScrollRestoration: vi.fn(() => false) }));
vi.mock('../../../resources/js/scrolling/navOverlay', () => ({ showNavigationLoading: vi.fn() }));
// Resume-curtain gate: out of scope here (this test asserts restore's TARGET
// decision); the stub also keeps the Enactor/imageState import chain out.
vi.mock('../../../resources/js/SPA/navigation/RevealGate', () => ({
  RevealGate: {
    arm: vi.fn(),
    landed: vi.fn(),
    disarm: vi.fn(),
    releaseIfUnclaimed: vi.fn(),
    completion: vi.fn(() => Promise.resolve()),
  },
}));
// The assertion seam: capture what restore decides to navigate to. vi.hoisted so the spy exists
// before the hoisted vi.mock factory runs.
const { navigateToInternalId, getNodesFromIndexedDB } = vi.hoisted(() => ({
  navigateToInternalId: vi.fn(),
  getNodesFromIndexedDB: vi.fn(),
}));
vi.mock('../../../resources/js/scrolling/internalNav', () => ({ navigateToInternalId }));

import { restoreScrollPosition } from '../../../resources/js/scrolling/restore';
import { setCurrentLazyLoader } from '../../../resources/js/pageLoad/currentLazyLoaderState';

const BOOK = 'book_test';

function makeWrapperAndLoader() {
  document.body.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-content-wrapper';
  // Force overflow so restore doesn't early-exit on "content fits".
  Object.defineProperty(wrapper, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(wrapper, 'clientHeight', { value: 800, configurable: true });
  const container = document.createElement('div');
  container.id = BOOK;
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  const loader = {
    bookId: BOOK,
    container,
    scrollableParent: wrapper,
    isNavigatingToInternalId: false,
    currentlyLoadedChunks: new Set(),
    saveScrollPosition: vi.fn(),
    loadChunk: vi.fn(),
    nodes: [],
    chunkManifest: null,
  };
  setCurrentLazyLoader(loader);
  return loader;
}


const NODES = [{ startLine: '100', chunk_id: 0 }, { startLine: '200', chunk_id: 0 }];

function addExistingChunk(loader) {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', '0');
  loader.container.appendChild(chunk);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  window.history.pushState({}, '', `/${BOOK}`); // no hash, no saved position → the chunk-0 branch
  getNodesFromIndexedDB.mockResolvedValue(NODES);
});

afterEach(() => {
  vi.useRealTimers();
  setCurrentLazyLoader(null);
});

describe('restore: the no-saved-position branch pins its loader', () => {
  it('POSITIVE CONTROL: with the loader still current, the deferred save runs', async () => {
    const loader = makeWrapperAndLoader();
    addExistingChunk(loader);

    await restoreScrollPosition();
    vi.advanceTimersByTime(150);

    expect(loader.saveScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('loader torn down before the deferred save fires: no throw, no save', async () => {
    const loader = makeWrapperAndLoader();
    addExistingChunk(loader);

    await restoreScrollPosition();
    setCurrentLazyLoader(null); // the user navigated away inside the 100ms window

    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(loader.saveScrollPosition).not.toHaveBeenCalled();
  });

  it('loader replaced DURING the IndexedDB read: the new book is left untouched', async () => {
    const oldLoader = makeWrapperAndLoader();
    let release;
    getNodesFromIndexedDB.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = restoreScrollPosition();
    await vi.advanceTimersByTimeAsync(0); // park inside the IDB await

    const nextContainer = document.createElement('div');
    nextContainer.innerHTML = '<p id="1">next book</p>';
    const nextLoader = { ...oldLoader, bookId: 'book_next', container: nextContainer, loadChunk: vi.fn(), nodes: [] };
    setCurrentLazyLoader(nextLoader);

    release(NODES);
    await pending;
    vi.advanceTimersByTime(150);

    expect(nextContainer.innerHTML).toBe('<p id="1">next book</p>');
    expect(nextLoader.nodes).toEqual([]);
    expect(nextLoader.loadChunk).not.toHaveBeenCalled();
    expect(oldLoader.loadChunk).not.toHaveBeenCalled();
  });
});
