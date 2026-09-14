/**
 * First real unit coverage of delinkHypercite — the citing-side removal
 * (resources/js/hypercites/deletion.ts). Its doc-comment used to claim e2e
 * grand-tour coverage, but the tour contains no deletion step; the cut/repaste
 * duplicate-citedIN bug shipped through that gap.
 *
 * Uses the real IDB connection/schema via idbHarness (fake-indexeddb), with the
 * barrel's side-effectful members mocked — same harness as
 * deletion.characterization.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';

const { mocks, state } = vi.hoisted(() => ({
  mocks: {
    updateBookTimestamp: vi.fn().mockResolvedValue(undefined),
    queueForSync: vi.fn(),
    getNodesByDataNodeIDs: vi.fn().mockResolvedValue([]),
    rebuildNodeArrays: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    getHyperciteFromIndexedDB: vi.fn().mockResolvedValue(null),
    syncHyperciteWithNodeImmediately: vi.fn().mockResolvedValue(undefined),
    broadcastToOpenTabs: vi.fn(),
  },
  state: { activeBook: 'bookA' },
}));
vi.mock('../../../resources/js/hyperlitContainer/utilities/activeContext', () => ({
  getActiveBook: () => state.activeBook,
}));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({
  broadcastToOpenTabs: mocks.broadcastToOpenTabs,
}));
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  const util = await import('../../../resources/js/indexedDB/core/utilities');
  return {
    openDatabase: conn.openDatabase,
    parseNodeId: util.parseNodeId,
    createNodeKey: util.createNodeKey,
    updateBookTimestamp: mocks.updateBookTimestamp,
    queueForSync: mocks.queueForSync,
    getNodesByDataNodeIDs: mocks.getNodesByDataNodeIDs,
    rebuildNodeArrays: mocks.rebuildNodeArrays,
    debouncedMasterSync: { flush: mocks.flush },
    getHyperciteFromIndexedDB: mocks.getHyperciteFromIndexedDB,
    syncHyperciteWithNodeImmediately: mocks.syncHyperciteWithNodeImmediately,
  };
});

import { delinkHypercite } from '../../../resources/js/hypercites/deletion';

const SRC = 'hypercite_src1';
const seedSource = (overrides = {}) => seedStore('hypercites', [{
  book: 'bookA',
  hyperciteId: SRC,
  relationshipStatus: 'poly',
  node_id: ['dn1'],
  citedIN: ['/bookb#hypercite_c1', '/bookc#hypercite_c2'],
  ...overrides,
}]);

beforeEach(() => {
  installFreshIndexedDB();
  vi.clearAllMocks();
  state.activeBook = 'bookA';
  document.body.innerHTML = '';
});

describe('delinkHypercite', () => {
  it('removes the matching citedIN entry, demotes poly→couple, and patches the DOM class', async () => {
    await seedSource();
    document.body.innerHTML = `<u id="${SRC}" class="poly">cited text</u>`;

    await delinkHypercite('hypercite_c1', `/bookb#${SRC}`);

    const record = await readOne('hypercites', ['bookA', SRC]);
    expect(record.citedIN).toEqual(['/bookc#hypercite_c2']);
    expect(record.relationshipStatus).toBe('couple');
    const u = document.getElementById(SRC);
    expect(u.classList.contains('couple')).toBe(true);
    expect(u.classList.contains('poly')).toBe(false);
  });

  it('demotes couple→single when the last citation is removed', async () => {
    await seedSource({ relationshipStatus: 'couple', citedIN: ['/bookb#hypercite_c1'] });

    await delinkHypercite('hypercite_c1', `/bookb#${SRC}`);

    const record = await readOne('hypercites', ['bookA', SRC]);
    expect(record.citedIN).toEqual([]);
    expect(record.relationshipStatus).toBe('single');
  });

  it('is a SILENT NO-OP when the entry is not in citedIN (the idempotency every retry layer relies on)', async () => {
    await seedSource({ citedIN: ['/bookc#hypercite_c2'], relationshipStatus: 'couple' });

    await delinkHypercite('hypercite_absent', `/bookb#${SRC}`);

    const record = await readOne('hypercites', ['bookA', SRC]);
    expect(record.citedIN).toEqual(['/bookc#hypercite_c2']);
    expect(record.relationshipStatus).toBe('couple');
    expect(mocks.updateBookTimestamp).not.toHaveBeenCalled();
    expect(mocks.syncHyperciteWithNodeImmediately).not.toHaveBeenCalled();
  });

  it('updates the owning node\'s embedded hypercites[] and syncs hypercite+node together, broadcasting', async () => {
    await seedSource();
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, content: '<p>x</p>',
      hypercites: [{ hyperciteId: SRC, citedIN: ['/bookb#hypercite_c1', '/bookc#hypercite_c2'], relationshipStatus: 'poly' }],
    }]);
    mocks.getHyperciteFromIndexedDB.mockResolvedValue({ hyperciteId: SRC, citedIN: ['/bookc#hypercite_c2'] });

    await delinkHypercite('hypercite_c1', `/bookb#${SRC}`);

    const node = await readOne('nodes', ['bookA', 100]);
    expect(node.hypercites[0].citedIN).toEqual(['/bookc#hypercite_c2']);
    expect(node.hypercites[0].relationshipStatus).toBe('couple');
    expect(mocks.syncHyperciteWithNodeImmediately).toHaveBeenCalledWith(
      'bookA',
      expect.objectContaining({ hyperciteId: SRC }),
      expect.objectContaining({ startLine: 100 }),
    );
    expect(mocks.broadcastToOpenTabs).toHaveBeenCalledWith('bookA', 100);
  });

  it('bumps BOTH books\' timestamps when the deletion happened in another book', async () => {
    await seedSource();
    state.activeBook = 'bookB';

    await delinkHypercite('hypercite_c1', `/bookb#${SRC}`);

    expect(mocks.updateBookTimestamp).toHaveBeenCalledWith('bookA');
    expect(mocks.updateBookTimestamp).toHaveBeenCalledWith('bookB');
  });

  it('does nothing for an href without a hypercite hash', async () => {
    await seedSource();

    await delinkHypercite('hypercite_c1', '/bookb#not_a_cite');

    const record = await readOne('hypercites', ['bookA', SRC]);
    expect(record.citedIN).toHaveLength(2);
    expect(mocks.updateBookTimestamp).not.toHaveBeenCalled();
  });

  it('does not throw when the target record does not exist', async () => {
    await expect(delinkHypercite('hypercite_c1', '/bookb#hypercite_ghosty')).resolves.toBeUndefined();
    expect(mocks.updateBookTimestamp).not.toHaveBeenCalled();
  });
});
