/**
 * Pins the stale overlay's lost-edit preview: it must render the text the user is
 * about to lose (safely, as text — never executing their HTML) inside a scrollable
 * area, with the Download + Refresh buttons present and pinned in a footer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// BroadcastListener pulls heavy reader-only siblings at import — stub them.
vi.mock('../../../resources/js/app', () => ({ book: 'latest' }));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  applyHypercites: (s) => s,
  applyHighlights: (s) => s,
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/core/connection.js', () => ({
  openDatabase: vi.fn(),
}));

import { showStaleTabOverlay } from '../../../resources/js/utilities/BroadcastListener';

describe('showStaleTabOverlay — lost-edit preview', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the discarded text and both buttons when lostNodes are given', () => {
    showStaleTabOverlay('msg', 'book_1', [
      { id: '1', content: '<p>Hello <b>world</b> — my lost sentence.</p>' },
    ]);

    const overlay = document.getElementById('stale-tab-overlay');
    expect(overlay).toBeTruthy();
    // The user's text is shown (collapsed to plain text), so they can read it.
    expect(overlay.textContent).toContain('Hello world — my lost sentence.');
    expect(document.getElementById('stale-tab-download')).toBeTruthy();
    expect(document.getElementById('stale-tab-refresh')).toBeTruthy();
  });

  it('does NOT execute the lost HTML (renders it as inert text)', () => {
    let fired = false;
    window.__xssProbe = () => { fired = true; };
    showStaleTabOverlay('msg', 'book_1', [
      { id: '1', content: '<img src=x onerror="window.__xssProbe()"><p>safe text</p>' },
    ]);

    const overlay = document.getElementById('stale-tab-overlay');
    // No live <img> from the user's content was inserted, and nothing executed.
    expect(overlay.querySelector('img')).toBeNull();
    expect(fired).toBe(false);
    expect(overlay.textContent).toContain('safe text');
    delete window.__xssProbe;
  });

  it('omits the download button when there is no lost edit', () => {
    showStaleTabOverlay('msg', 'book_1');
    expect(document.getElementById('stale-tab-download')).toBeNull();
    expect(document.getElementById('stale-tab-refresh')).toBeTruthy();
  });
});
