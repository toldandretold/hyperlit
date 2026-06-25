/**
 * The popstate handler MUST clear the hash-suppression markers, so back/forward honours the hash.
 *
 * This is the production half of the contract proved by backForwardHonoursHash.test.js: a real
 * back/forward fires popstate → LinkNavigationHandler._handlePopstateInner must clear BOTH the
 * navigatedHashes set AND the scrolled-away marker for the current hash. A refresh fires no
 * popstate, so the markers persist and the reading position is resumed instead.
 *
 * We drive the REAL _handlePopstateInner (not a simulation) and assert the marker is gone. The
 * destination is a DIFFERENT book so the handler routes through NavigationManager (mocked no-op)
 * and returns right after the marker-clearing block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const navigateByStructure = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../../resources/js/SPA/navigation/NavigationManager.js', () => ({
  NavigationManager: { navigateByStructure },
}));
vi.mock('../../../resources/js/SPA/navigation/navigationRegistry', () => ({ registerNavActions: vi.fn() }));
vi.mock('../../../resources/js/SPA/navigation/pathways/BookToBookTransition.js', () => ({ BookToBookTransition: {} }));
vi.mock('../../../resources/js/SPA/navigation/utils/structureDetection.js', () => ({
  getPageStructure: vi.fn(), areStructuresCompatible: vi.fn(), getSubdomain: vi.fn(), getBookIdFromUrl: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/logger', () => ({ log: { nav: vi.fn() }, verbose: { nav: vi.fn() } }));
vi.mock('../../../resources/js/scrolling/index', () => ({
  hideNavigationLoading: vi.fn(), navigateToInternalId: vi.fn(),
  // Real semantics: clearing navigatedHashes is the in-memory half; keep it a spy here.
  clearNavigatedHashes: vi.fn(),
}));
vi.mock('../../../resources/js/app', () => ({ book: 'current_book', bookSlug: 'current_book' }));
vi.mock('../../../resources/js/SPA/navigation/ProgressOverlayConductor.js', () => ({ ProgressOverlayConductor: {} }));
vi.mock('../../../resources/js/pageLoad/index', () => ({
  currentLazyLoader: null, openContainerChain: vi.fn(), buildChainFromUrl: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ getLocalStorageKey: (p, b) => `${p}_${b}` }));
vi.mock('../../../resources/js/hyperlitContainer/index', () => ({ closeHyperlitContainer: vi.fn() }));
vi.mock('../../../resources/js/utilities/linkClickRegistry', () => ({ registerLinkClickHandler: vi.fn() }));

// navState is REAL — we assert on its actual marker state.
import { markHashScrolledAway, hasScrolledAwayFromHash } from '../../../resources/js/scrolling/navState';
import { LinkNavigationHandler } from '../../../resources/js/SPA/navigation/LinkNavigationHandler';

const HASH = 'hypercite_target';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('_handlePopstateInner clears the scrolled-away marker for the current hash', () => {
  it('a back/forward to a hypercite (different book) unmarks that hash', async () => {
    // User had scrolled away from this hypercite (so a refresh would resume position)...
    markHashScrolledAway(HASH);
    expect(hasScrolledAwayFromHash(HASH)).toBe(true);

    // ...now they press back/forward into a DIFFERENT book at that hypercite.
    window.history.pushState({}, '', `/other_book#${HASH}`);
    await LinkNavigationHandler._handlePopstateInner({ state: {} });

    // The handler must have routed (different book) and cleared the marker so the hash wins.
    expect(navigateByStructure).toHaveBeenCalledTimes(1);
    expect(hasScrolledAwayFromHash(HASH)).toBe(false);
  });

  it('a popstate with NO hash leaves other markers intact (only hash navs reset suppression)', async () => {
    markHashScrolledAway(HASH);
    window.history.pushState({}, '', `/other_book`); // no hash
    await LinkNavigationHandler._handlePopstateInner({ state: {} });
    expect(hasScrolledAwayFromHash(HASH)).toBe(true);
  });
});
