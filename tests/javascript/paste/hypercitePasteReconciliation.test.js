/**
 * citedIN reconciliation (resources/js/hypercites/reconciliation.ts) — the
 * paste-side half of the cut/repaste duplicate-citation fix: before a paste
 * appends a freshly-minted citation, dead entries for the citing book (anchors
 * that no longer exist anywhere in it) are pruned. Conservative by design:
 * DOM presence, an UN-rendered IDB copy, or a footnote copy all keep an entry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getHyperciteFromIndexedDB: vi.fn(),
  getNodesFromIndexedDB: vi.fn(async () => []),
  updateHyperciteInIndexedDB: vi.fn(async () => true),
  getNodesByDataNodeIDs: vi.fn(async () => []),
  rebuildNodeArrays: vi.fn(async () => {}),
  getAllFootnotesForBook: vi.fn(async () => []),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  getHyperciteFromIndexedDB: mocks.getHyperciteFromIndexedDB,
  getNodesFromIndexedDB: mocks.getNodesFromIndexedDB,
  updateHyperciteInIndexedDB: mocks.updateHyperciteInIndexedDB,
  getNodesByDataNodeIDs: mocks.getNodesByDataNodeIDs,
  rebuildNodeArrays: mocks.rebuildNodeArrays,
}));
vi.mock('../../../resources/js/indexedDB/footnotes/index', () => ({
  getAllFootnotesForBook: mocks.getAllFootnotesForBook,
}));

import { isCitingAnchorAlive, reconcileCitedINForCitingBook } from '../../../resources/js/hypercites/reconciliation';

const sourceRecord = (citedIN, extra = {}) => ({
  book: 'booka',
  hyperciteId: 'hypercite_src',
  relationshipStatus: citedIN.length >= 2 ? 'poly' : citedIN.length === 1 ? 'couple' : 'single',
  node_id: ['dn_src'],
  citedIN,
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.getNodesFromIndexedDB.mockResolvedValue([]);
  mocks.getAllFootnotesForBook.mockResolvedValue([]);
  mocks.getNodesByDataNodeIDs.mockResolvedValue([]);
  mocks.updateHyperciteInIndexedDB.mockResolvedValue(true);
});

describe('isCitingAnchorAlive', () => {
  it('alive when the anchor is in the live DOM', async () => {
    document.body.innerHTML = '<p id="100"><a id="hypercite_c1" href="/booka#hypercite_src">↗</a></p>';
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(true);
  });

  it('alive when an UN-rendered IDB node still contains it (lazy chunk — never punished)', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue([
      { startLine: 500, node_id: 'dn9', content: '<p>x <a id="hypercite_c1" href="/booka#hypercite_src">↗</a></p>' },
    ]);
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(true);
  });

  it('dead when the only IDB copy belongs to a node that IS rendered without the anchor (stale IDB)', async () => {
    document.body.innerHTML = '<p id="500" data-node-id="dn9">anchor was cut from here</p>';
    mocks.getNodesFromIndexedDB.mockResolvedValue([
      { startLine: 500, node_id: 'dn9', content: '<p>x <a id="hypercite_c1" href="/booka#hypercite_src">↗</a></p>' },
    ]);
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(false);
  });

  it('alive when a footnote\'s content contains it', async () => {
    mocks.getAllFootnotesForBook.mockResolvedValue([
      { footnoteId: 'fn1', content: 'note text <a id="hypercite_c1" href="/booka#hypercite_src">↗</a>' },
    ]);
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(true);
  });

  it('dead when found nowhere', async () => {
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(false);
  });

  it('treats a failed scan as alive (conservative)', async () => {
    mocks.getNodesFromIndexedDB.mockRejectedValue(new Error('idb exploded'));
    expect(await isCitingAnchorAlive('bookb', 'hypercite_c1')).toBe(true);
  });
});

describe('reconcileCitedINForCitingBook', () => {
  it('removes the dead entry for the citing book, keeps other books\' entries, demotes status', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(
      sourceRecord(['/bookb#hypercite_dead', '/bookc#hypercite_other']),
    );

    const removed = await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');

    expect(removed).toEqual(['/bookb#hypercite_dead']);
    expect(mocks.updateHyperciteInIndexedDB).toHaveBeenCalledWith('booka', 'hypercite_src', {
      citedIN: ['/bookc#hypercite_other'],
      relationshipStatus: 'couple',
    });
  });

  it('keeps an entry whose anchor is alive in the DOM and writes nothing', async () => {
    document.body.innerHTML = '<p id="100"><a id="hypercite_live" href="/booka#hypercite_src">↗</a></p>';
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(sourceRecord(['/bookb#hypercite_live']));

    const removed = await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');

    expect(removed).toEqual([]);
    expect(mocks.updateHyperciteInIndexedDB).not.toHaveBeenCalled();
  });

  it('never touches entries for OTHER citing books even when their anchors are unfindable', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(
      sourceRecord(['/bookc#hypercite_gone', '/bookd#hypercite_gone2']),
    );

    const removed = await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');

    expect(removed).toEqual([]);
    expect(mocks.updateHyperciteInIndexedDB).not.toHaveBeenCalled();
  });

  it('demotes couple→single when the only citation was dead', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(sourceRecord(['/bookb#hypercite_dead']));

    await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');

    expect(mocks.updateHyperciteInIndexedDB).toHaveBeenCalledWith('booka', 'hypercite_src', {
      citedIN: [],
      relationshipStatus: 'single',
    });
  });

  it('rebuilds the source book\'s embedded node arrays after a prune (book-filtered)', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(sourceRecord(['/bookb#hypercite_dead']));
    const sourceNode = { book: 'booka', startLine: 100, node_id: 'dn_src' };
    mocks.getNodesByDataNodeIDs.mockResolvedValue([sourceNode, { book: 'otherbook', startLine: 100, node_id: 'dn_src' }]);

    await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');

    expect(mocks.getNodesByDataNodeIDs).toHaveBeenCalledWith(['dn_src']);
    expect(mocks.rebuildNodeArrays).toHaveBeenCalledWith([sourceNode]);
  });

  it('returns [] when the source record is missing or has no citations', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(undefined);
    expect(await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb')).toEqual([]);

    mocks.getHyperciteFromIndexedDB.mockResolvedValue(sourceRecord([]));
    expect(await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb')).toEqual([]);
  });
});
