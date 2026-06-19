/**
 * Characterization of resources/js/hypercites/deletion.js — the
 * delink/ghost-marking write paths. Pinned before .js → .ts.
 *
 * markHyperciteAsGhost is the cleanly-testable IDB-write path; delinkHypercite
 * is a long multi-store workflow exercised by the e2e grand tour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';

const { updateBookTimestamp, queueForSync, getNodesByDataNodeIDs, rebuildNodeArrays, flush } = vi.hoisted(() => ({
  updateBookTimestamp: vi.fn().mockResolvedValue(undefined),
  queueForSync: vi.fn(),
  getNodesByDataNodeIDs: vi.fn().mockResolvedValue([]),
  rebuildNodeArrays: vi.fn().mockResolvedValue(undefined),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/hyperlitContainer/utilities/activeContext', () => ({ getActiveBook: () => 'bookA' }));
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  const util = await import('../../../resources/js/indexedDB/core/utilities');
  return {
    openDatabase: conn.openDatabase,
    parseNodeId: util.parseNodeId,
    createNodeKey: util.createNodeKey,
    updateBookTimestamp, queueForSync, getNodesByDataNodeIDs, rebuildNodeArrays,
    debouncedMasterSync: { flush },
    getHyperciteFromIndexedDB: vi.fn(),
    syncHyperciteWithNodeImmediately: vi.fn(),
  };
});

import { markHyperciteAsGhost } from '../../../resources/js/hypercites/deletion';

beforeEach(() => {
  installFreshIndexedDB();
  vi.clearAllMocks();
});

describe('markHyperciteAsGhost', () => {
  it('flips relationshipStatus to ghost, queues sync, bumps timestamp, flushes', async () => {
    await seedStore('hypercites', [{ book: 'bookA', hyperciteId: 'hc1', relationshipStatus: 'couple', node_id: [], citedIN: ['/x#y'] }]);

    const ok = await markHyperciteAsGhost('hc1');

    expect(ok).toBe(true);
    expect((await readOne('hypercites', ['bookA', 'hc1'])).relationshipStatus).toBe('ghost');
    expect(updateBookTimestamp).toHaveBeenCalledWith('bookA');
    expect(queueForSync).toHaveBeenCalledWith('hypercites', 'hc1', 'update', expect.objectContaining({ relationshipStatus: 'ghost' }));
    expect(flush).toHaveBeenCalled();
  });

  it('returns false when the hypercite does not exist', async () => {
    expect(await markHyperciteAsGhost('nope')).toBe(false);
    expect(queueForSync).not.toHaveBeenCalled();
  });
});
