// @vitest-environment jsdom
/**
 * Characterization of the core write path: DOM → batchUpdateIndexedDBRecords → IDB.
 *
 * Pins what batch.js ACTUALLY does today (before the TS migration):
 *   - bookId resolution (explicit option → sub-book container → main-content)
 *   - content processing (mark/u/font/span stripping, style stripping)
 *   - hyperlight/hypercite extraction into the normalized stores (charData schema)
 *   - sync queueing (pendingSyncs entries incl. originalData for undo)
 *
 * Heavy app modules are mocked at the import seam ONLY (saveQueue → app.js,
 * postgreSQL.js, editIndicator, integrity reporter) — everything inside
 * resources/js/indexedDB runs for real against fake-indexeddb.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// library.js → postgreSQL.js (legacy sync layer, heavy). Not under test here.
vi.mock('../../../resources/js/postgreSQL.js', () => ({
  syncIndexedDBtoPostgreSQL: vi.fn(),
}));
// operationState.js → editIndicator.js (DOM glow component).
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
vi.mock('../../../resources/js/integrity/reporter.js', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));
// Dynamically imported by batch.js only when footnote counts change; mocked so
// an accidental trigger can't drag in the footnote engine.
vi.mock('../../../resources/js/footnotes/FootnoteNumberingService.js', () => ({
  rebuildAndRenumber: vi.fn(),
}));
// master.js (reachable via the dynamic `import('../index.js')`) imports auth.js,
// which boots the session layer — stub the only name the graph needs.
vi.mock('../../../resources/js/utilities/auth.js', () => ({
  refreshCsrfToken: vi.fn(),
}));

import { installFreshIndexedDB, seedStore, readOne, readAll, waitFor } from './idbHarness.js';
import { reportIntegrityFailure } from '../../../resources/js/integrity/reporter.js';
import {
  batchUpdateIndexedDBRecords,
  initNodeBatchDependencies,
} from '../../../resources/js/indexedDB/nodes/batch';
import {
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

describe('batchUpdateIndexedDBRecords (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '';
    pendingSyncs.clear();
    initSyncQueueDependencies({ debouncedMasterSync: vi.fn() });
    initNodeBatchDependencies({ book: 'bookA' });
  });

  it('writes a new plain node: composite key, chunk_id from DOM, node_id from data-node-id', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="3">
          <p id="200" data-node-id="bookA-n200">Hello <strong>world</strong></p>
        </div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '200' }]);

    const stored = await readOne('nodes', ['bookA', 200]);
    expect(stored).toEqual({
      book: 'bookA',
      startLine: 200,
      chunk_id: 3,
      node_id: 'bookA-n200',
      content: '<p id="200" data-node-id="bookA-n200">Hello <strong>world</strong></p>',
      footnotes: [],
      citations: [],
      hyperlights: [],
      hypercites: [],
    });

    // Queued for server sync, keyed `${store}-${book}-${id}`, no original (new node —
    // queueForSync normalizes the absent original to null via its default param)
    const queued = pendingSyncs.get('nodes-bookA-200');
    expect(queued).toBeDefined();
    expect(queued.type).toBe('update');
    expect(queued.originalData).toBeNull();

    // updateBookTimestamp ran: library record created + queued as a side-effect
    const library = await readOne('library', 'bookA');
    expect(library).toMatchObject({ book: 'bookA', title: 'bookA' });
    expect(pendingSyncs.has('library-bookA-bookA')).toBe(true);
  });

  it('extracts <mark>/<u> into hyperlights/hypercites stores and strips them from stored content', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="0"><p id="300" data-node-id="bookA-n300">alpha <mark id="HL_1" class="HL_1">beta</mark> gamma <u id="hypercite_x1">delta</u> end</p></div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '300' }]);

    // Normalized hyperlight record (old positional schema + new node_id/charData schema)
    const hl = await readOne('hyperlights', ['bookA', 'HL_1']);
    expect(hl).toEqual({
      book: 'bookA',
      hyperlight_id: 'HL_1',
      startChar: 6,
      endChar: 10,
      startLine: 300,
      highlightedText: 'beta',
      highlightedHTML: '<mark id="HL_1" class="HL_1">beta</mark>',
      annotation: '',
      node_id: ['bookA-n300'],
      charData: { 'bookA-n300': { charStart: 6, charEnd: 10 } },
    });

    const hc = await readOne('hypercites', ['bookA', 'hypercite_x1']);
    expect(hc).toEqual({
      book: 'bookA',
      hyperciteId: 'hypercite_x1',
      startChar: 17,
      endChar: 22,
      hypercitedText: 'delta',
      hypercitedHTML: '<u id="hypercite_x1">delta</u>',
      citedIN: [],
      relationshipStatus: 'single',
      time_since: expect.any(Number),
      node_id: ['bookA-n300'],
      charData: { 'bookA-n300': { charStart: 17, charEnd: 22 } },
    });

    // Stored node content has mark/u removed (text preserved)
    const node = await readOne('nodes', ['bookA', 300]);
    expect(node.content).toBe(
      '<p id="300" data-node-id="bookA-n300">alpha beta gamma delta end</p>',
    );

    // The post-commit rebuild (hydration/rebuild.js) re-populates the cached arrays
    // on the node record from the normalized tables — fire-and-forget, so poll.
    await waitFor(async () => {
      const n = await readOne('nodes', ['bookA', 300]);
      return n.hyperlights.length === 1 && n.hypercites.length === 1;
    });
    const rebuilt = await readOne('nodes', ['bookA', 300]);
    expect(rebuilt.hyperlights).toEqual([
      expect.objectContaining({ highlightID: 'HL_1', charStart: 6, charEnd: 10 }),
    ]);
    expect(rebuilt.hypercites).toEqual([
      expect.objectContaining({ hyperciteId: 'hypercite_x1', charStart: 17, charEnd: 22 }),
    ]);

    expect(pendingSyncs.has('hyperlights-bookA-HL_1')).toBe(true);
    expect(pendingSyncs.has('hypercites-bookA-hypercite_x1')).toBe(true);
  });

  it('routes a node inside [data-book-id] to the sub-book, not the parent', async () => {
    initNodeBatchDependencies({ book: 'parent_book' });
    document.body.innerHTML = `
      <div class="main-content" id="parent_book">
        <div data-book-id="book_parent_book/Fn7">
          <div class="chunk" data-chunk-id="0">
            <p id="200" data-node-id="sub-n200">Footnote text</p>
          </div>
        </div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '200' }]);

    const subRecord = await readOne('nodes', ['book_parent_book/Fn7', 200]);
    expect(subRecord).toMatchObject({
      book: 'book_parent_book/Fn7',
      startLine: 200,
      node_id: 'sub-n200',
    });
    expect(await readOne('nodes', ['parent_book', 200])).toBeUndefined();
  });

  it('strips inline styles, <font> wrappers and styled <span>s before storing', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="0"><p id="400" data-node-id="bookA-n400" style="color: red;">x <span style="font-weight: bold;">y</span> <font color="red">z</font></p></div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '400' }]);

    const stored = await readOne('nodes', ['bookA', 400]);
    expect(stored.content).not.toContain('<span');
    expect(stored.content).not.toContain('<font');
    // Root style is stripped too (the strip explicitly includes contentClone,
    // since querySelectorAll('[style]') only matches descendants).
    expect(stored.content).toBe('<p id="400" data-node-id="bookA-n400">x y z</p>');
  });

  it('preserves --*-intensity custom properties when stripping the root style', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="0"><p id="450" data-node-id="bookA-n450" style="color: red; --highlight-intensity: 0.6;">glow</p></div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '450' }]);

    const stored = await readOne('nodes', ['bookA', 450]);
    expect(stored.content).toContain('--highlight-intensity');
    expect(stored.content).not.toContain('color');
  });

  it('updates an existing record: merges unknown fields, queues the true original for undo', async () => {
    await seedStore('nodes', [{
      book: 'bookA',
      startLine: 500,
      chunk_id: 2,
      node_id: 'bookA-n500',
      content: '<p id="500" data-node-id="bookA-n500">old</p>',
      footnotes: [],
      citations: [],
      hyperlights: [],
      hypercites: [],
      someUnknownField: 'preserved',
    }]);
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="2">
          <p id="500" data-node-id="bookA-n500">new text</p>
        </div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '500' }]);

    const stored = await readOne('nodes', ['bookA', 500]);
    expect(stored.content).toBe('<p id="500" data-node-id="bookA-n500">new text</p>');
    // Existing-record path spreads {...existing}: fields it doesn't know survive
    expect(stored.someUnknownField).toBe('preserved');

    const queued = pendingSyncs.get('nodes-bookA-500');
    expect(queued.originalData.content).toBe('<p id="500" data-node-id="bookA-n500">old</p>');
  });

  it('RECOVERS an orphaned highlight on save: clears orphan flags, cleans _deleted_nodes from node_id/charData', async () => {
    // A highlight orphaned by a node deletion, whose mark has reappeared in a
    // (new) node — the save must heal it: drop the orphan flags, purge the
    // dead node from node_id + charData, and register the current node.
    await seedStore('hyperlights', [{
      book: 'bookA', hyperlight_id: 'HL_back', startChar: 0, endChar: 4, startLine: 999,
      highlightedText: 'old', highlightedHTML: '<mark>old</mark>', annotation: 'kept',
      node_id: ['n-gone'],
      charData: { 'n-gone': { charStart: 0, charEnd: 4 } },
      _orphaned_at: 12345,
      _orphaned_from_node: 'n-gone',
      _deleted_nodes: ['n-gone'],
    }]);
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div class="chunk" data-chunk-id="0"><p id="600" data-node-id="bookA-n600"><mark id="HL_back" class="HL_back">back</mark> again</p></div>
      </div>`;

    await batchUpdateIndexedDBRecords([{ id: '600' }]);

    const healed = await readOne('hyperlights', ['bookA', 'HL_back']);
    expect(healed._orphaned_at).toBeUndefined();
    expect(healed._orphaned_from_node).toBeUndefined();
    expect(healed._deleted_nodes).toBeUndefined();
    expect(healed.node_id).toEqual(['bookA-n600']);          // dead node purged, new one added
    expect(healed.charData).toEqual({ 'bookA-n600': { charStart: 0, charEnd: 4 } });
    expect(healed.annotation).toBe('kept');                  // user data survives recovery
    expect(healed.highlightedText).toBe('back');
  });

  it('rejects non-numeric ids: writes nothing, reports an integrity failure', async () => {
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';

    await batchUpdateIndexedDBRecords([{ id: 'not-a-number' }]);

    expect(await readAll('nodes')).toEqual([]);
    expect(pendingSyncs.has('nodes-bookA-0')).toBe(false);
    expect(reportIntegrityFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 'bookA',
        missingFromIDB: ['not-a-number'],
        trigger: 'batch-invalid-id',
      }),
    );
  });
});
