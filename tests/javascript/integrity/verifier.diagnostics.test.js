// @vitest-environment happy-dom
/**
 * Integrity verifier — Defect-2 diagnostics + the startLine contract Defect-1 relies on.
 *
 * Reproduces the real "(Grohmann Barbosa 2025)" riddle: the live DOM has a real
 * space, the stored content has a zero-width WORD JOINER (⁠) in its place.
 * normaliseText strips ⁠ + collapses whitespace, so the normalised diff can
 * only say "a space went missing" — it can't show WHAT is stored at the seam.
 * The new codesAroundDiff / rawIdbHtml fields expose the joiner so the next real
 * report is diagnosable.
 *
 * Also pins NodeMismatch.startLine === the numeric DOM id (not the data-node-id):
 * the paste self-heal re-queues by that field via queueNodeForSave, which rejects
 * non-numeric ids — passing nodeId there made self-heal a silent no-op (Defect 1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';
import { verifyNodesIntegrity } from '../../../resources/js/integrity/verifier';

const WORD_JOINER = '⁠';

describe('verifier diagnostics — hidden word-joiner seam', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '';
  });

  it('captures the raw seam (codes + html) and exposes startLine for a joiner-vs-space mismatch', async () => {
    const bookId = 'bookA';

    // DOM: a REAL space between the two author names.
    document.body.innerHTML = `
      <div data-book-id="${bookId}">
        <p id="6200" data-node-id="nodeX">monopoly capital (Grohmann Barbosa 2025).</p>
      </div>`;

    // IDB: stored content has a WORD JOINER where the DOM has a space.
    await seedStore('nodes', [{
      book: bookId,
      startLine: 6200,
      node_id: 'nodeX',
      content: `<p id="6200" data-node-id="nodeX">monopoly capital (Grohmann${WORD_JOINER}Barbosa 2025).</p>`,
    }]);

    const result = await verifyNodesIntegrity(bookId, ['6200']);

    expect(result.ok).toHaveLength(0);
    expect(result.mismatches).toHaveLength(1);
    const m = result.mismatches[0];

    // Defect-1 contract: self-heal re-queues by this field — must be the numeric id.
    expect(m.startLine).toBe('6200');
    expect(m.nodeId).toBe('nodeX');

    // Defect-2: the raw seam reveals the joiner the normalised diff hid.
    expect(m.codesAroundDiff).toBeTruthy();
    expect(m.codesAroundDiff.idbCodes).toContain(0x2060); // word joiner in IDB
    expect(m.codesAroundDiff.domCodes).toContain(0x20);   // real space in DOM
    expect(m.rawIdbHtml).toContain(WORD_JOINER);
    expect(m.rawDomHtml).toContain('Grohmann Barbosa');
  });

  it('reports OK (no mismatch) when DOM and IDB agree', async () => {
    const bookId = 'bookA';
    document.body.innerHTML = `
      <div data-book-id="${bookId}">
        <p id="6200" data-node-id="nodeX">monopoly capital (Grohmann Barbosa 2025).</p>
      </div>`;
    await seedStore('nodes', [{
      book: bookId,
      startLine: 6200,
      node_id: 'nodeX',
      content: `<p id="6200" data-node-id="nodeX">monopoly capital (Grohmann Barbosa 2025).</p>`,
    }]);

    const result = await verifyNodesIntegrity(bookId, ['6200']);
    expect(result.mismatches).toHaveLength(0);
    expect(result.ok).toEqual(['6200']);
  });
});
