/**
 * Back/forward to a hypercite MUST navigate to the hypercite — refresh resumes reading position.
 *
 * The bug: "I click a hypercite, scroll away, press back — and it does NOT take me to the
 * hypercite." Two mechanisms exist to make a genuine *page refresh* resume the reading position
 * instead of re-jumping to a deep-link hash:
 *   - the in-memory `navigatedHashes` set, and
 *   - the sessionStorage `scrolled-away` marker (survives refresh).
 * Both were ALSO suppressing the hash on back/forward, which is wrong: a real back/forward is not
 * a refresh and the hash must win.
 *
 * The architecture: a refresh fires NO popstate, so the markers persist → restore resumes the
 * saved position. A real back/forward fires popstate, whose handler clears BOTH markers for the
 * current hash (LinkNavigationHandler._handlePopstateInner) → restore honours the hash.
 *
 * This test drives the REAL restoreScrollPosition() with the REAL navState markers and asserts the
 * actual navigation target handed to navigateToInternalId. No synthetic stand-in for the decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  verbose: { nav: vi.fn() },
}));
vi.mock('../../../resources/js/app', () => ({
  book: 'book_test',
  OpenHyperlightID: null,
  OpenFootnoteID: null,
}));
vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  getNodesFromIndexedDB: vi.fn(async () => []),
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
// The assertion seam: capture what restore decides to navigate to. vi.hoisted so the spy exists
// before the hoisted vi.mock factory runs.
const { navigateToInternalId } = vi.hoisted(() => ({ navigateToInternalId: vi.fn() }));
vi.mock('../../../resources/js/scrolling/internalNav', () => ({ navigateToInternalId }));

import { restoreScrollPosition } from '../../../resources/js/scrolling/restore';
import { markHashScrolledAway, unmarkHashScrolledAway, navigatedHashes } from '../../../resources/js/scrolling/navState';
import { setCurrentLazyLoader } from '../../../resources/js/pageLoad/currentLazyLoaderState';

const HASH = 'hypercite_target';
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

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  navigatedHashes.clear();
  // Land on a hypercite deep-link URL (no HL_/Fn cascade path segments).
  window.history.pushState({}, '', `/${BOOK}#${HASH}`);
  makeWrapperAndLoader();
});

describe('back/forward honours the hypercite hash; refresh resumes position', () => {
  it('BACK/FORWARD (no marker): navigates to the hypercite hash', async () => {
    // Fresh history navigation — nothing marked. Hash must win.
    await restoreScrollPosition();
    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe(HASH);
  });

  it('REFRESH (scrolled-away marker set): resumes the saved reading position, NOT the hash', async () => {
    // A real refresh: the marker survived in sessionStorage and there's a saved position.
    markHashScrolledAway(HASH);
    sessionStorage.setItem(`scrollPosition_${BOOK}`, JSON.stringify({ elementId: '999' }));

    await restoreScrollPosition();

    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe('999'); // saved position
    expect(navigateToInternalId.mock.calls[0][0]).not.toBe(HASH); // NOT the hypercite
  });

  it('BACK/FORWARD AFTER scroll-away: popstate clears the marker, so the hash wins again', async () => {
    // User had scrolled away (marker set) and a saved position exists...
    markHashScrolledAway(HASH);
    sessionStorage.setItem(`scrollPosition_${BOOK}`, JSON.stringify({ elementId: '999' }));

    // ...then presses back. _handlePopstateInner clears navigatedHashes AND unmarks this hash.
    // Reproduce exactly that popstate-side effect:
    navigatedHashes.clear();
    unmarkHashScrolledAway(window.location.hash.substring(1));

    await restoreScrollPosition();

    // The hash must now win — take me to the hypercite, not the stale saved position.
    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe(HASH);
  });

  it('SAME-SESSION re-store after we already jumped (navigatedHashes set): resumes, not re-jump', async () => {
    // Within one page session we already navigated to the hash; an incidental restore re-fire
    // (e.g. a chunk load) must NOT yank us back to the hash.
    navigatedHashes.add(HASH);
    sessionStorage.setItem(`scrollPosition_${BOOK}`, JSON.stringify({ elementId: '999' }));

    await restoreScrollPosition();

    expect(navigateToInternalId.mock.calls[0][0]).toBe('999');
  });
});
