/**
 * @vitest-environment jsdom
 *
 * Regression tests for the "enclosing-cite creation corrupts a nested cite" bug.
 *
 * Bug: when a new hypercite's selection ENCLOSES an existing nested cite whose end
 * coincides with the new cite's end, range.extractContents() splits that nested cite —
 * the text moves into the new wrapper and an EMPTY, duplicate-id <u id="hypercite_…"></u>
 * residue is left behind at the boundary. The node-save position walk
 * (processNodeContentHighlightsAndCites) then measured that residue as charStart === charEnd
 * (zero width) and, being written last, overwrote the real cite's range — so the cite never
 * rendered and could not be navigated to.
 *
 * Fix layers exercised here (the save-time guard, extracted to positionCollector.js):
 *   - skip any <u>/<mark> whose textContent is empty (length 0) — never persist zero-width
 *   - de-dupe by id, keeping the wider span rather than letting DOM order decide
 *
 * We import the pure leaf module (not batch.js, which drags in editor/saveQueue side
 * effects). jsdom is used because the walk relies on document.createTreeWalker / Node
 * constants, which jsdom implements spec-completely.
 */

import { describe, it, expect } from 'vitest';
import { collectMarkAndCitePositions } from '../../../resources/js/indexedDB/nodes/positionCollector.js';

/** Build a <p> node from an HTML string, as it would exist in the editor at save time. */
function makeNode(innerHTML) {
  const p = document.createElement('p');
  p.id = '1600';
  p.setAttribute('data-node-id', 'book_test_node1');
  p.innerHTML = innerHTML;
  document.body.appendChild(p);
  return p;
}

const citeOf = (result, id) => result.hypercites.filter(hc => hc.hyperciteId === id);

describe('processNodeContentHighlightsAndCites — zero-width residue guard', () => {
  it('does NOT persist an empty (zero-width) hypercite residue, and keeps the real cite span', () => {
    // Reproduces the exact corruption: an enclosing cite (rl6hno5) wrapping two nested cites,
    // where the end-coinciding one (end) has an EMPTY duplicate-id residue left after it.
    const node = makeNode(
      'Intro text. ' +
        '<u id="hypercite_big">In 1964 ' +
        '<u id="hypercite_mid">middle cite</u>' +
        ' and then ' +
        '<u id="hypercite_end">the end cite.</u>' +
        '</u>' +
        '<u id="hypercite_end"></u>' // ← empty split residue (the bug)
    );

    const result = collectMarkAndCitePositions(node, []);

    const endEntries = citeOf(result, 'hypercite_end');
    // Exactly one record for the cite — the empty residue must be dropped, not duplicated.
    expect(endEntries).toHaveLength(1);
    // And it must keep the REAL, non-zero span (text "the end cite." === 13 chars).
    const end = endEntries[0];
    expect(end.charEnd - end.charStart).toBe('the end cite.'.length);
    expect(end.charStart).not.toBe(end.charEnd); // never the corrupt zero-width 679/679

    // The other two cites are unaffected and have correct non-zero spans.
    const big = citeOf(result, 'hypercite_big')[0];
    const mid = citeOf(result, 'hypercite_mid')[0];
    expect(big.charEnd - big.charStart).toBeGreaterThan(0);
    expect(mid.charEnd - mid.charStart).toBe('middle cite'.length);
    // The enclosing cite spans both nested ones.
    expect(big.charStart).toBeLessThan(mid.charStart);
    expect(big.charEnd).toBeGreaterThanOrEqual(end.charEnd);
  });

  it('de-dupes a repeated id by keeping the WIDER span, regardless of DOM order', () => {
    // Two non-empty <u> with the same id but different spans; the narrow one appears LAST.
    // Without the guard, document order would let the narrow one win.
    const node = makeNode(
      'A <u id="hypercite_dup">a longer span of text</u> B ' +
        '<u id="hypercite_dup">short</u> C'
    );

    const result = collectMarkAndCitePositions(node, []);
    const dups = citeOf(result, 'hypercite_dup');

    expect(dups).toHaveLength(1);
    expect(dups[0].charEnd - dups[0].charStart).toBe('a longer span of text'.length);
  });

  it('skips an empty hyperlight (<mark>) residue too', () => {
    const node = makeNode(
      'X <mark class="HL_111" id="HL_111">real highlight</mark> Y ' +
        '<mark class="HL_111" id="HL_111"></mark>' // empty residue
    );

    const result = collectMarkAndCitePositions(node, []);
    const hl = result.hyperlights.filter(h => h.highlightID === 'HL_111');

    expect(hl).toHaveLength(1);
    expect(hl[0].charEnd - hl[0].charStart).toBe('real highlight'.length);
  });

  it('preserves merge data (relationshipStatus / citedIN) for the surviving cite', () => {
    const node = makeNode(
      'Z <u id="hypercite_keep">kept text</u><u id="hypercite_keep"></u>'
    );
    const existing = [{
      hyperciteId: 'hypercite_keep',
      relationshipStatus: 'couple',
      citedIN: ['/bookX#hypercite_other'],
      time_since: 123,
    }];

    const result = collectMarkAndCitePositions(node, existing);
    const keep = citeOf(result, 'hypercite_keep');

    expect(keep).toHaveLength(1);
    expect(keep[0].relationshipStatus).toBe('couple');
    expect(keep[0].citedIN).toEqual(['/bookX#hypercite_other']);
    expect(keep[0].charEnd - keep[0].charStart).toBe('kept text'.length);
  });
});
