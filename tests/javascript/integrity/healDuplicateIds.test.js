// @vitest-environment happy-dom
/**
 * Integrity self-heal for NUMERIC-id duplicates (the phantom-`id="1"` paste bug).
 *
 * The existing healer (healVerbatimDuplicates) only removes same-data-node-id + identical-innerHTML
 * pairs, so two `<p id="1">` with DIFFERENT data-node-ids/content were merely reported, never fixed.
 * healDuplicateIds closes that gap, data-safely:
 *   - keeper = the element whose data-node-id matches the IDB record at that startLine
 *   - a redundant non-keeper (empty / same content / already-persisted node_id) is REMOVED
 *   - a non-keeper with distinct, unsaved content is REASSIGNED a fresh id + queued for save
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';

// Let the REAL idHelpers (isDuplicateId / getNextDecimalForBase, which use `#`+CSS.escape) run.
installDecimalIdSelectorShim();

vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));

// healDuplicateIds dynamically imports divEditor only for queueNodeForSave — stub it + spy.
const queueNodeForSave = vi.fn();
vi.mock('../../../resources/js/divEditor/index', () => ({
  queueNodeForSave: (...args) => queueNodeForSave(...args),
}));

import { healDuplicateIds } from '../../../resources/js/integrity/verifier';

const BOOK = 'bookA';

beforeEach(() => {
  installFreshIndexedDB();
  document.body.innerHTML = '';
  queueNodeForSave.mockClear();
});

describe('healDuplicateIds — numeric-id collisions', () => {
  it('REMOVES a redundant phantom and keeps the canonical node (single #1 remains)', async () => {
    await seedStore('nodes', [
      { book: BOOK, startLine: 1, node_id: 'keeperNode', content: '<p id="1">first node</p>' },
    ]);
    document.body.innerHTML = `
      <div data-book-id="${BOOK}">
        <p id="1" data-node-id="keeperNode">first node</p>
        <p id="1" data-node-id="phantomNode">first node</p>
      </div>`;

    const healed = await healDuplicateIds(BOOK);

    const remaining = document.querySelectorAll('[id="1"]');
    expect(remaining.length).toBe(1);
    expect(remaining[0].getAttribute('data-node-id')).toBe('keeperNode'); // canonical kept
    expect(healed.length).toBe(1);
    expect(queueNodeForSave).not.toHaveBeenCalled(); // pure removal, no save
  });

  it('RESCUES a phantom with distinct unsaved content (reassign + queue save, no data loss)', async () => {
    await seedStore('nodes', [
      { book: BOOK, startLine: 1, node_id: 'keeperNode', content: '<p id="1">genuine first node</p>' },
    ]);
    document.body.innerHTML = `
      <div data-book-id="${BOOK}">
        <p id="1" data-node-id="keeperNode">genuine first node</p>
        <p id="1" data-node-id="phantomNode">freshly pasted unique paragraph</p>
      </div>`;

    const healed = await healDuplicateIds(BOOK);

    // Only the canonical node still owns id="1".
    expect(document.querySelectorAll('[id="1"]').length).toBe(1);

    // The phantom kept its content under a fresh non-colliding id and was queued to save.
    const rescued = Array.from(document.querySelectorAll('[data-node-id="phantomNode"]'))[0];
    expect(rescued).toBeTruthy();
    expect(rescued.id).not.toBe('1');
    expect(rescued.id).toMatch(/^\d+(\.\d+)+$/); // a decimal id under the same base (e.g. "1.1")
    expect(rescued.textContent).toContain('freshly pasted unique paragraph');
    expect(queueNodeForSave).toHaveBeenCalledWith(rescued.id, 'add', BOOK);
    expect(healed.length).toBe(1);
  });

  it('is a no-op when there are no duplicate numeric ids', async () => {
    document.body.innerHTML = `
      <div data-book-id="${BOOK}">
        <p id="1" data-node-id="a">one</p>
        <p id="2" data-node-id="b">two</p>
      </div>`;

    const healed = await healDuplicateIds(BOOK);
    expect(healed).toEqual([]);
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });
});
