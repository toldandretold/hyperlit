/**
 * Resume-vs-jump for an internal-nav hash — the durable causal rule.
 *
 * The URL can carry a `#hypercite_/#HL_/#<node>` hash for two very different reasons: a DELIBERATE
 * deep-link (pasted / typed / shared / clicked link) that must JUMP to the target, or a RESIDUAL
 * hash the reader's own annotate-then-close left behind that they have since read past, which must
 * RESUME the reading position (the "returns later, yanked back to the highlight" bug).
 *
 * The discriminator is a single durable causal test: did the saved reading position move AFTER we
 * last deliberately navigated to THIS target? `savedAt` (in the scrollPosition payload) and
 * `navigatedAt` (scrolling/navStamp, per-target) both live in localStorage, so the decision holds
 * across a session close and a later return — unlike the retired ephemeral navigatedHashes/
 * scrolledAway pair. Back/forward is unaffected: it re-navigates via the popstate handler and never
 * reaches restoreScrollPosition.
 *
 * This test drives the REAL restoreScrollPosition() with the REAL navStamp store and asserts the
 * actual navigation target handed to navigateToInternalId.
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
import { recordNavigatedAt, getNavigatedAt } from '../../../resources/js/scrolling/navStamp';
import { setCurrentLazyLoader } from '../../../resources/js/pageLoad/currentLazyLoaderState';

const HASH = 'hypercite_target';
const BOOK = 'book_test';

/** Seed a saved reading position (elementId + savedAt ms) for BOOK. */
function seedSavedPosition(elementId, savedAt) {
  sessionStorage.setItem(`scrollPosition_${BOOK}`, JSON.stringify({ elementId, offset: 0, savedAt }));
}

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
  // Land on a hypercite deep-link URL (no HL_/Fn cascade path segments).
  window.history.pushState({}, '', `/${BOOK}#${HASH}`);
  makeWrapperAndLoader();
});

describe('resume-vs-jump: the durable causal rule', () => {
  it('DELIBERATE deep-link (no navigatedAt for this target): JUMPs to the hash', async () => {
    // A cold pasted/typed/shared URL — this device never deliberately navigated to the target, so
    // there is no navStamp. Even a lone saved position must not steal a genuine deep-link.
    seedSavedPosition('999', Date.now());

    await restoreScrollPosition();

    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe(HASH);
  });

  it('READ PAST the target (savedAt > navigatedAt): RESUMEs the saved reading position', async () => {
    // We navigated to the target, then the reader scrolled on — the saved position moved AFTER.
    recordNavigatedAt(BOOK, HASH);
    const navAt = getNavigatedAt(BOOK, HASH);
    seedSavedPosition('999', navAt + 10_000); // saved AFTER we navigated → read past it

    await restoreScrollPosition();

    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe('999'); // resume
    expect(navigateToInternalId.mock.calls[0][0]).not.toBe(HASH);
  });

  it('NAVIGATED here but NOT moved (savedAt <= navigatedAt): JUMPs to the hash', async () => {
    // Clicked the hypercite and are looking at it; a refresh should keep us on it.
    recordNavigatedAt(BOOK, HASH);
    const navAt = getNavigatedAt(BOOK, HASH);
    seedSavedPosition('999', navAt - 10_000); // saved BEFORE we navigated → haven't read past

    await restoreScrollPosition();

    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe(HASH);
  });

  it('no saved position at all: JUMPs to the hash', async () => {
    // Fresh book, deep-link followed — nothing to resume to.
    await restoreScrollPosition();

    expect(navigateToInternalId).toHaveBeenCalledTimes(1);
    expect(navigateToInternalId.mock.calls[0][0]).toBe(HASH);
  });
});
