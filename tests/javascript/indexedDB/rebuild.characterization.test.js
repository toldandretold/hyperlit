/**
 * Characterization of the hydration direction: normalized tables → rebuilt
 * node arrays (hydration/rebuild.js). This is the read-side counterpart of
 * batchUpdate.characterization.test.js and also pins the dual-book node_id
 * gotcha that the fresh-node filter in master.js exists to compensate for.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne, waitFor } from './idbHarness.js';
import {
  rebuildNodeArrays,
  getNodesByDataNodeIDs,
} from '../../../resources/js/indexedDB/hydration/rebuild';

describe('hydration/rebuild.js (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  it('rebuilds hyperlights/hypercites arrays from the normalized tables and updates the node cache', async () => {
    await seedStore('nodes', [{
      book: 'bookA',
      startLine: 100,
      chunk_id: 0,
      node_id: 'n-100',
      content: '<p id="100" data-node-id="n-100"><a href="#bookA_Fn3">1</a> text here</p>',
      hyperlights: [],
      hypercites: [],
      footnotes: [],
    }]);
    await seedStore('hyperlights', [{
      book: 'bookA',
      hyperlight_id: 'HL_1',
      node_id: ['n-100'],
      charData: { 'n-100': { charStart: 0, charEnd: 4 } },
      annotation: 'a note',
      hidden: false,
      time_since: 123,
    }]);
    await seedStore('hypercites', [{
      book: 'bookA',
      hyperciteId: 'hypercite_1',
      node_id: ['n-100'],
      charData: { 'n-100': { charStart: 5, charEnd: 9 } },
      relationshipStatus: 'single',
      citedIN: [],
      time_since: 456,
    }]);

    const nodes = await getNodesByDataNodeIDs(['n-100']);
    expect(nodes).toHaveLength(1);

    await rebuildNodeArrays(nodes);

    // In-memory arrays rebuilt in the renderer's expected shape
    expect(nodes[0].hyperlights).toEqual([{
      highlightID: 'HL_1',
      charStart: 0,
      charEnd: 4,
      annotation: 'a note',
      hidden: false,
      time_since: 123,
    }]);
    expect(nodes[0].hypercites).toEqual([{
      hyperciteId: 'hypercite_1',
      charStart: 5,
      charEnd: 9,
      relationshipStatus: 'single',
      citedIN: [],
      time_since: 456,
      // creator/is_user_hypercite ride along for the gate's ownership bypass
      // (rebuild.ts ~L225); unset here → null / undefined-dropped.
      creator: null,
    }]);
    // Footnotes are re-extracted from the HTML content (href="#..Fn..")
    expect(nodes[0].footnotes).toEqual(['bookA_Fn3']);

    // The cache write-back is fire-and-forget in prod — poll for it
    await waitFor(async () => {
      const cached = await readOne('nodes', ['bookA', 100]);
      return cached.hyperlights.length === 1;
    });
    const cached = await readOne('nodes', ['bookA', 100]);
    expect(cached.hyperlights[0].highlightID).toBe('HL_1');
    expect(cached.hypercites[0].hyperciteId).toBe('hypercite_1');
  });

  it('excludes records whose charData lacks an entry for the node', async () => {
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, chunk_id: 0, node_id: 'n-100',
      content: '<p>x</p>', hyperlights: [], hypercites: [], footnotes: [],
    }]);
    // Highlight indexed against the node but with charData for a DIFFERENT node
    await seedStore('hyperlights', [{
      book: 'bookA',
      hyperlight_id: 'HL_broken',
      node_id: ['n-100'],
      charData: { 'n-999': { charStart: 0, charEnd: 4 } },
    }]);

    const nodes = await getNodesByDataNodeIDs(['n-100']);
    await rebuildNodeArrays(nodes, { skipWrite: true });

    expect(nodes[0].hyperlights).toEqual([]);
  });

  it('GOTCHA (pinned): getNodesByDataNodeIDs returns only ONE record per node_id — the alphabetically-first book wins', async () => {
    // Same node_id in two books (parent + sub-book share node_id prefixes).
    // index.get() returns the record with the lowest primary key, i.e. the
    // alphabetically-first book — this is WHY master.js needs filterFreshNodesForBook.
    await seedStore('nodes', [
      { book: 'a_book', startLine: 100, chunk_id: 0, node_id: 'shared-id', content: '<p>a</p>' },
      { book: 'z_book', startLine: 100, chunk_id: 0, node_id: 'shared-id', content: '<p>z</p>' },
    ]);

    const nodes = await getNodesByDataNodeIDs(['shared-id']);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].book).toBe('a_book');
  });
});
