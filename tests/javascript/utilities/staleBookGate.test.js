/**
 * Cross-tab BOOK_EDITED must not block a READ-ONLY tab.
 *
 * A user often keeps the same book open in two windows — editing in one,
 * reading in the other (e.g. to see further down the page). The reading tab
 * has no edits to lose, so the blocking "Book out of date" overlay must NOT
 * fire there. Instead the book is marked stale-for-edit (write entry points
 * force a refresh first) and the lazy-loader cache is dirtied so an SPA
 * re-entry re-reads the shared IndexedDB. Only a tab that is ITSELF editing
 * that book gets the immediate blocking overlay.
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

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.listeners = [];
    FakeBroadcastChannel.instances.push(this);
  }
  addEventListener(type, fn) {
    if (type === 'message') this.listeners.push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
  postMessage() {}
  close() {}
}
FakeBroadcastChannel.instances = [];
vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);

import { registerBookOpen } from '../../../resources/js/utilities/BroadcastListener';
import { isBookStaleForEdit } from '../../../resources/js/utilities/staleBookGate';
import { isCacheDirty, clearCacheDirtyFlag } from '../../../resources/js/lazyLoader/utilities/cacheState';

// Deliver a message as if it came from ANOTHER tab (tabId differs from ours).
function receiveFromOtherTab(data) {
  const channel = FakeBroadcastChannel.instances.find(
    (c) => c.name === 'hyperlit-tab-coordination',
  );
  channel.listeners.forEach((fn) => fn({ data }));
}

describe('BOOK_EDITED cross-tab handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.__hyperlitStaleForEdit;
    delete window.__hyperlitLocalEdits;
    window.isEditing = false;
    clearCacheDirtyFlag();
  });

  it('read-only tab: no blocking overlay — book marked stale + cache dirtied', () => {
    registerBookOpen('book_999');

    receiveFromOtherTab({ type: 'BOOK_EDITED', book: 'book_999', tabId: 'other-tab' });

    expect(document.getElementById('stale-tab-overlay')).toBeNull();
    expect(isBookStaleForEdit('book_999')).toBe(true);
    // Sub-books share the root's fate.
    expect(isBookStaleForEdit('book_999/Fn12')).toBe(true);
    expect(isCacheDirty()).toBe(true);
  });

  it('re-opening the book (fresh render from shared IndexedDB) clears the stale mark', () => {
    registerBookOpen('book_999');
    receiveFromOtherTab({ type: 'BOOK_EDITED', book: 'book_999', tabId: 'other-tab' });
    expect(isBookStaleForEdit('book_999')).toBe(true);

    registerBookOpen('book_999');
    expect(isBookStaleForEdit('book_999')).toBe(false);
  });

  it('tab editing the SAME book: blocking overlay fires immediately', () => {
    registerBookOpen('latest'); // matches the mocked current book
    window.isEditing = true;

    receiveFromOtherTab({ type: 'BOOK_EDITED', book: 'latest', tabId: 'other-tab' });

    expect(document.getElementById('stale-tab-overlay')).toBeTruthy();
  });

  it('tab editing a DIFFERENT book: no overlay — the edited book is just marked stale', () => {
    registerBookOpen('book_999');
    window.isEditing = true; // editing 'latest', not 'book_999'

    receiveFromOtherTab({ type: 'BOOK_EDITED', book: 'book_999', tabId: 'other-tab' });

    expect(document.getElementById('stale-tab-overlay')).toBeNull();
    expect(isBookStaleForEdit('book_999')).toBe(true);
  });
});
