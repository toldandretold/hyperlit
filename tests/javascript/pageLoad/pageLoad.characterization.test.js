/**
 * Characterization tests for the page-load / bootstrap layer
 * (currently resources/js/{initialChunkLoader,initializePage,backgroundDownloader}.js,
 * migrating to resources/js/pageLoad/).
 *
 * This layer is otherwise only exercised by the MANUAL e2e grand tour, so these
 * pin the deterministic, unit-testable pieces of the backend→DOM bootstrap before
 * the JS→TS move + decomposition:
 *   - resolveBootstrapTarget  (which target the first chunk-load aims at)
 *   - buildChainFromUrl       (URL path-segments → container-open chain)
 *   - waitForBackgroundDownload (the in-progress flag / completion-event gate)
 *   - handleDeletedBookAccess (the access-guard modal)
 *
 * Import paths below are repointed to ../pageLoad/* during the migration; the
 * assertions stay identical — that's the point of a characterization gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveBootstrapTarget } from '../../../resources/js/pageLoad';
import { buildChainFromUrl, handleDeletedBookAccess } from '../../../resources/js/pageLoad';
import { waitForBackgroundDownload } from '../../../resources/js/pageLoad';

beforeEach(() => {
  delete window._pendingChunkTarget;
  delete window._pendingChunkFallbackTarget;
  delete window._backgroundDownloadInProgress;
  if (window.location.hash) window.location.hash = '';
});

afterEach(() => {
  document.querySelectorAll('.custom-alert-overlay').forEach((el) => el.remove());
});

describe('resolveBootstrapTarget', () => {
  it('prioritises an SPA navigation target over everything else', () => {
    window._pendingChunkTarget = 'HL_spa';
    window._pendingChunkFallbackTarget = 'fallback_x';
    expect(resolveBootstrapTarget()).toEqual({ target: 'HL_spa', fallbackTarget: 'fallback_x' });
  });

  it('falls back to the URL hash target when no SPA target is set', () => {
    window.location.hash = '#somePara';
    expect(resolveBootstrapTarget()).toEqual({ target: 'somePara', fallbackTarget: null });
  });

  it('returns a null target when nothing is specified', () => {
    // (no SPA target, no hash, no OpenHyperlightID/OpenFootnoteID in the test env)
    expect(resolveBootstrapTarget()).toEqual({ target: null, fallbackTarget: null });
  });
});

describe('buildChainFromUrl', () => {
  it('returns an empty chain when there is nothing after the book id', async () => {
    expect(await buildChainFromUrl('book_1', ['book_1'])).toEqual([]);
  });

  it('maps a single visible item (level 1) straight from the URL', async () => {
    expect(await buildChainFromUrl('book_1', ['book_1', 'HL_abc'])).toEqual([
      { itemId: 'HL_abc', subBookId: null },
    ]);
  });

  it('maps multiple visible items when all are present in the URL', async () => {
    const chain = await buildChainFromUrl('book_1', ['book_1', 'HL_abc', 'Fn3']);
    expect(chain).toEqual([
      { itemId: 'HL_abc', subBookId: null },
      { itemId: 'Fn3', subBookId: null },
    ]);
  });
});

describe('waitForBackgroundDownload', () => {
  it('resolves immediately when no download is in progress', async () => {
    await expect(waitForBackgroundDownload(50)).resolves.toBeUndefined();
  });

  it('resolves when the completion event fires', async () => {
    window._backgroundDownloadInProgress = true;
    const p = waitForBackgroundDownload(5000);
    window.dispatchEvent(new CustomEvent('backgroundDownloadComplete'));
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves anyway after the timeout', async () => {
    window._backgroundDownloadInProgress = true;
    await expect(waitForBackgroundDownload(30)).resolves.toBeUndefined();
  });
});

describe('handleDeletedBookAccess', () => {
  it('renders the "Book Deleted" modal with a go-home button', async () => {
    await handleDeletedBookAccess('book_gone');
    const overlay = document.querySelector('.custom-alert-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Book Deleted');
    expect(overlay.querySelector('#goHomeButtonDeleted')).not.toBeNull();
  });
});
