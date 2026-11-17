// Closing a hero feed must release the feed's lazy loader. createLazyLoader
// attaches a DOCUMENT-level click handler; the feed's DOM was removed but the
// handler stayed, so every later click on the hero's own anchors — the
// hypercite-network map's SVG dots — was SPA-routed instead of left to the
// browser (and, before anchorHref, routed to "[object SVGAnimatedString]").
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resetCurrentLazyLoader = vi.hoisted(() => vi.fn());
const loaderState = vi.hoisted(() => ({ currentLazyLoader: null }));

vi.mock('../../../resources/js/pageLoad/index', () => ({
  resetCurrentLazyLoader,
  loadHyperText: vi.fn(),
}));
vi.mock('../../../resources/js/pageLoad/currentLazyLoaderState', () => ({
  get currentLazyLoader() { return loaderState.currentLazyLoader; },
  setCurrentLazyLoader: vi.fn((v) => { loaderState.currentLazyLoader = v; }),
}));
vi.mock('../../../resources/js/app', () => ({ setCurrentBook: vi.fn(), book: 'a', bookSlug: null }));
vi.mock('../../../resources/js/scrolling/index', () => ({
  showNavigationLoading: vi.fn(), hideNavigationLoading: vi.fn(), restoreScrollPosition: vi.fn(),
}));
vi.mock('../../../resources/js/SPA/navigation/historyTraversal', () => ({ isHistoryTraversal: vi.fn(() => false) }));
vi.mock('../../../resources/js/indexedDB/index', () => ({ getAllOfflineAvailableBooks: vi.fn(async () => []) }));
vi.mock('../../../resources/js/utilities/authorList', () => ({ formatAuthorsForReference: vi.fn(() => '') }));
vi.mock('../../../resources/js/components/archivePage/archiveTitleEditor', () => ({ readArchiveEditSeed: vi.fn(() => null) }));

import { closeFeedContent } from '../../../resources/js/components/homepage/homepageDisplayUnit';

// The release goes through a dynamic import (pageLoad/index is a cycle-breaker there).
const settle = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  resetCurrentLazyLoader.mockClear();
  loaderState.currentLazyLoader = null;
  document.body.innerHTML = '<div class="home-content-wrapper"><main class="main-content" id="shelf_feed"></main></div>';
});

describe('closeFeedContent releases the feed lazy loader', () => {
  it('removes the feed DOM and resets the active loader', async () => {
    loaderState.currentLazyLoader = { disconnect: vi.fn() };
    expect(closeFeedContent()).toBe(true);
    expect(document.querySelector('.main-content')).toBeNull();
    await settle();
    expect(resetCurrentLazyLoader).toHaveBeenCalledTimes(1);
  });

  it('with no loader alive there is nothing to reset', async () => {
    closeFeedContent();
    await settle();
    expect(resetCurrentLazyLoader).not.toHaveBeenCalled();
  });

  it('a NEW feed opened meanwhile keeps its loader — the release is identity-guarded', async () => {
    const stale = { disconnect: vi.fn() };
    loaderState.currentLazyLoader = stale;
    closeFeedContent();
    // Before the dynamic import settles, the next feed open minted a fresh loader.
    loaderState.currentLazyLoader = { disconnect: vi.fn() };
    await settle();
    expect(resetCurrentLazyLoader).not.toHaveBeenCalled();
  });
});
