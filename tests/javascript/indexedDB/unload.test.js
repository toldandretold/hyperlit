/**
 * Pins syncQueue/unload.js ahead of its TS conversion: the pagehide beacon
 * flush — per-book payload grouping, the delete mapping, queue clearing, and
 * the run-once guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth', () => ({
  refreshCsrfToken: vi.fn(),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
// visibilitychange flush targets (dynamic imports) — not under test here
vi.mock('../../../resources/js/divEditor/index.js', () => ({
  flushInputDebounce: vi.fn(),
  flushAllPendingSaves: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/footnotes/footnoteAnnotations', () => ({
  flushPendingFootnoteSaves: vi.fn(),
}));

import {
  setupUnloadSync,
  initUnloadSyncDependencies,
  __resetUnloadOnceGuardForTests,
} from '../../../resources/js/indexedDB/syncQueue/unload';
import {
  queueForSync,
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';
import {
  hasSentSyncToken,
  __clearSentSyncTokensForTests,
} from '../../../resources/js/indexedDB/syncQueue/sentSyncTokens';

describe('syncOnUnload via pagehide (characterization)', () => {
  let sendBeacon;

  beforeEach(() => {
    pendingSyncs.clear();
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    initSyncQueueDependencies({ debouncedMasterSync: vi.fn() });
    initUnloadSyncDependencies({ book: 'bookA' });
    sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
  });

  it('groups pending items by book, beacons each payload, and clears the queue (once only)', async () => {
    setupUnloadSync();
    queueForSync('nodes', 100, 'update', { book: 'bookA', startLine: 100, content: '<p>a</p>' }, null);
    queueForSync('nodes', 200, 'delete', { book: 'bookA', startLine: 200 }, null);
    queueForSync('hyperlights', 'HL_1', 'update', { book: 'book_bookA/Fn1', hyperlight_id: 'HL_1' }, null);

    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).toHaveBeenCalledTimes(2); // one beacon per book
    const payloads = await Promise.all(
      sendBeacon.mock.calls.map(async ([url, blob]) => {
        expect(url).toBe('/api/db/sync/beacon');
        return JSON.parse(await blob.text());
      }),
    );

    const bookAPayload = payloads.find(p => p.book === 'bookA');
    expect(bookAPayload.updates.nodes).toEqual([{ book: 'bookA', startLine: 100, content: '<p>a</p>' }]);
    // Deletes are rebuilt from the queue id, not the queued record
    expect(bookAPayload.deletions.nodes).toEqual([{ book: 'bookA', startLine: 200, _action: 'delete' }]);

    const subPayload = payloads.find(p => p.book === 'book_bookA/Fn1');
    expect(subPayload.updates.hyperlights).toEqual([{ book: 'book_bookA/Fn1', hyperlight_id: 'HL_1' }]);

    expect(pendingSyncs.size).toBe(0);

    // Run-once guard: a second pagehide (e.g. beforeunload already fired) is a no-op
    queueForSync('nodes', 300, 'update', { book: 'bookA', startLine: 300 }, null);
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it('stamps a ledgered sync_token on library-bearing beacons only', async () => {
    // A beacon never sees its response, so the base can't advance from it. When it
    // carries a library record (the only thing that moves the server's staleness
    // clock), it must be stamped with a write id kept in the localStorage ledger —
    // that's how the NEXT session's 409 recognizes the beacon write as its own.
    __clearSentSyncTokensForTests();
    __resetUnloadOnceGuardForTests(); // the once-per-page guard latched in the prior test
    setupUnloadSync();
    queueForSync('library', 'lib', 'update', { book: 'bookA', title: 'T', timestamp: 4000, base_timestamp: 1000 }, null);
    queueForSync('nodes', 100, 'update', { book: 'bookB', startLine: 100, content: '<p>b</p>' }, null);

    window.dispatchEvent(new Event('pagehide'));

    const payloads = await Promise.all(
      sendBeacon.mock.calls.map(async ([, blob]) => JSON.parse(await blob.text())),
    );
    const withLibrary = payloads.find(p => p.updates.library);
    expect(typeof withLibrary.sync_token).toBe('string');
    expect(hasSentSyncToken(withLibrary.sync_token)).toBe(true);
    // No library → nothing can move the staleness clock → no token.
    const withoutLibrary = payloads.find(p => !p.updates.library);
    expect(withoutLibrary.sync_token).toBeUndefined();
  });
});
