/**
 * navigateToInternalId — the chunk-level FLASH guard (the deep-link adoption fix).
 *
 * Background: `findRenderedTarget` (tested in findRenderedTarget.test.js) is the FIRST guard — it
 * scrolls straight to the target when it's already a wrapped element in the DOM. But adoption's
 * highlight/cite reprocessing is timing-sensitive: at the instant navigation fires, the
 * server-prerendered + adopted chunk can be in `currentlyLoadedChunks` while the cite is not yet
 * wrapped — so `findRenderedTarget` returns null and we fall through to the resolver.
 *
 * That used to ALWAYS clear `<main>` + re-render the resolved chunk — discarding the adopted DOM
 * (the deep-link FLASH). The fix: a SECOND, chunk-level guard — if the resolved chunk is already in
 * `currentlyLoadedChunks`, skip the clear entirely and scroll to the (already-rendered) target.
 *
 * These tests drive the real navigation through the resolver's deterministic `chunk_<n>` "direct"
 * path (no IndexedDB needed) and pin the branch: chunk already loaded → container preserved (no
 * clear); chunk NOT loaded → container cleared + the resolved window reloaded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Park the final scroll on an unresolved promise so the DOM decision (clear vs no-clear) is the
// observable end-state — we don't need to mock the whole scroll / getBoundingClientRect machinery.
vi.mock('../../../resources/js/SPA/domReadiness', () => ({
  waitForNavigationTarget: vi.fn(() => new Promise(() => {})),
  waitForElementReady: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../../../resources/js/SPA/navigation/NavigationCompletionBarrier.js', () => ({
  NavigationCompletionBarrier: {
    startNavigation: vi.fn(), registerProcess: vi.fn(), completeProcess: vi.fn(), abort: vi.fn(),
  },
  NavigationProcess: { SCROLL_COMPLETE: 'scroll', SCROLL_CORRECTION: 'correction' },
}));

import { navigateToInternalId } from '../../../resources/js/scrolling/internalNav';

let container;
function makeLazyLoader(loadedChunkIds) {
  // A chunk 200 prerendered + adopted, but WITHOUT a wrapped element the first guard would match —
  // so findRenderedTarget misses and we reach the resolver + the chunk-level guard under test.
  container.innerHTML = '<div class="chunk" data-chunk-id="200" data-adopted="1"><p>cite arrow text</p></div>';
  return {
    bookId: 'book1',
    container,
    nodes: [{ chunk_id: 199 }, { chunk_id: 200 }, { chunk_id: 201 }],
    chunkManifest: [{ chunk_id: 199 }, { chunk_id: 200 }, { chunk_id: 201 }],
    currentlyLoadedChunks: new Set(loadedChunkIds),
    isFullyLoaded: true,
    loadChunk: vi.fn(),
    repositionSentinels: vi.fn(),
    attachMarkListeners: vi.fn(),
    // no lockScroll → the scroll-lock listener block is skipped
  };
}

// `chunk_200` hits the resolver's Step-1 "direct" path: { chunkId: 200, resolved: true } with no IDB.
const TARGET = 'chunk_200';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); };

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('navigateToInternalId — chunk-level fast-path (no flash on adopted chunk)', () => {
  it('does NOT clear the container when the resolved chunk is already loaded/adopted', async () => {
    const lazyLoader = makeLazyLoader([200]); // chunk 200 already loaded
    navigateToInternalId(TARGET, lazyLoader, /* showOverlay */ false);
    await flush();

    // The adopted chunk survived — no clear, no re-render.
    expect(container.querySelector('.chunk[data-chunk-id="200"][data-adopted="1"]')).not.toBeNull();
    expect(lazyLoader.currentlyLoadedChunks.has(200)).toBe(true);
    // Neighbours pulled in for scroll context (loadChunk early-exits for already-loaded ids).
    expect(lazyLoader.loadChunk).toHaveBeenCalledWith(199, 'up');
    expect(lazyLoader.loadChunk).toHaveBeenCalledWith(201, 'down');
    expect(lazyLoader.repositionSentinels).toHaveBeenCalled();
  });

  it('DOES clear + reload when the resolved chunk is NOT already loaded (genuine off-screen target)', async () => {
    const lazyLoader = makeLazyLoader([0]); // chunk 200 NOT loaded; only chunk 0 is
    navigateToInternalId(TARGET, lazyLoader, false);
    await flush();

    // The stale DOM was cleared and the resolved window (199/200/201) reloaded.
    expect(container.querySelector('.chunk[data-adopted="1"]')).toBeNull();
    expect(lazyLoader.currentlyLoadedChunks.size).toBe(0); // .clear() ran
    expect(lazyLoader.loadChunk).toHaveBeenCalledWith(199, 'down');
    expect(lazyLoader.loadChunk).toHaveBeenCalledWith(200, 'down');
    expect(lazyLoader.loadChunk).toHaveBeenCalledWith(201, 'down');
  });
});
