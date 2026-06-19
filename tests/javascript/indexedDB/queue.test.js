/**
 * Pins syncQueue/queue.js behavior ahead of its TS conversion:
 * key format, originalData preservation across re-queues (the undo guarantee),
 * and per-book clearing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// operationState.js (real) imports the editIndicator DOM component — stub it.
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));

import {
  queueForSync,
  pendingSyncs,
  clearPendingSyncsForBook,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

describe('queueForSync', () => {
  let masterSync;

  beforeEach(() => {
    pendingSyncs.clear();
    masterSync = vi.fn();
    initSyncQueueDependencies({ debouncedMasterSync: masterSync });
  });

  it('queues under `${store}-${book}-${id}` and kicks the debounced master sync', () => {
    queueForSync('nodes', 100, 'update', { book: 'bookA', content: 'x' }, null);

    expect(pendingSyncs.get('nodes-bookA-100')).toEqual({
      store: 'nodes',
      id: 100,
      type: 'update',
      data: { book: 'bookA', content: 'x' },
      originalData: null,
    });
    expect(masterSync).toHaveBeenCalledTimes(1);
  });

  it('uses an empty book segment when data has no book', () => {
    queueForSync('nodes', 100, 'update', { content: 'x' }, null);
    expect(pendingSyncs.has('nodes--100')).toBe(true);
  });

  it('ignores an update without data', () => {
    queueForSync('nodes', 100, 'update', null, null);
    expect(pendingSyncs.size).toBe(0);
    expect(masterSync).not.toHaveBeenCalled();
  });

  it('preserves the FIRST originalData across re-queues of the same key (true undo state)', () => {
    queueForSync('nodes', 100, 'update', { book: 'bookA', content: 'v1' }, { book: 'bookA', content: 'v0' });
    // Second edit before the sync fires — e.g. footnote renumbering touching the same node
    queueForSync('nodes', 100, 'update', { book: 'bookA', content: 'v2' }, { book: 'bookA', content: 'v1' });

    const queued = pendingSyncs.get('nodes-bookA-100');
    expect(queued.data.content).toBe('v2');
    expect(queued.originalData.content).toBe('v0');
  });

  it('clearPendingSyncsForBook removes only that book and returns the count', () => {
    queueForSync('nodes', 100, 'update', { book: 'bookA' }, null);
    queueForSync('nodes', 200, 'update', { book: 'bookA' }, null);
    queueForSync('nodes', 100, 'update', { book: 'bookB' }, null);

    const cleared = clearPendingSyncsForBook('bookA');

    expect(cleared).toBe(2);
    expect(pendingSyncs.size).toBe(1);
    expect(pendingSyncs.has('nodes-bookB-100')).toBe(true);
  });
});
