/**
 * Paste-time canonical footnote numbering.
 *
 * Paste bakes the SOURCE footnote label into each `<sup fn-count-id>` (footnote-linker.ts), but the
 * app numbers footnotes by DOCUMENT ORDER (buildFootnoteMap sorts by startLine). When the source
 * labels don't match reading order — any orphan/missing/duplicate ref offsets them — the stored
 * numbers are wrong from the moment of paste, and only get fixed by the FIRST full-book load's
 * rebuildAndRenumber (a ~890-node write-on-read storm).
 *
 * The fix runs the canonical pass at paste (paste/index.ts:syncPasteToPostgreSQL):
 *   buildFootnoteMap(bookId, allNodes)  →  for each node: applyFootnoteMapToStoredHTML(content)
 * This test pins that pass: source labels → document-order numbers, idempotent (so the later
 * first-load renumber is a no-op), and non-numeric markers (†) preserved.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFootnoteMap,
  applyFootnoteMapToStoredHTML,
} from '../../../resources/js/footnotes/FootnoteNumberingService';

// Source labels are OFFSET from reading order: a missing ref means labels run 1,3,4 while the
// document positions (startLine order) are 1,2,3. Plus a node with a non-numeric marker (†).
function pastedNodes() {
  return [
    { book: 'bookA', startLine: 100, footnotes: [{ id: 'Fn1001', marker: '1' }],
      content: '<p>alpha<sup id="Fn1001" fn-count-id="1">1</sup></p>' },
    { book: 'bookA', startLine: 200, footnotes: [{ id: 'Fn1002', marker: '3' }],
      content: '<p>beta<sup id="Fn1002" fn-count-id="3">3</sup></p>' },   // source 3 → canonical 2
    { book: 'bookA', startLine: 300, footnotes: [{ id: 'Fn1003', marker: '4' }],
      content: '<p>gamma<sup id="Fn1003" fn-count-id="4">4</sup></p>' },  // source 4 → canonical 3
    { book: 'bookA', startLine: 400, footnotes: [{ id: 'Fn1004', marker: '†' }],
      content: '<p>delta<sup id="Fn1004" fn-count-id="†">†</sup></p>' },  // non-numeric → preserved
  ];
}

// Mirror the paste pass: build the doc-order map, then reconcile each node's stored content.
function runCanonicalPass(nodes) {
  buildFootnoteMap('bookA', nodes);
  const corrected = [];
  for (const n of nodes) {
    const { changed, newContent } = applyFootnoteMapToStoredHTML(n.content);
    if (changed) { n.content = newContent; corrected.push(n.startLine); }
  }
  return corrected;
}

const supCount = (html, id) => {
  const d = document.createElement('div'); d.innerHTML = html;
  return d.querySelector(`sup#${id}`)?.getAttribute('fn-count-id');
};

describe('paste-time canonical footnote numbering', () => {
  it('rewrites source labels to document-order numbers (and preserves non-numeric markers)', () => {
    const nodes = pastedNodes();
    const corrected = runCanonicalPass(nodes);

    // Only the two offset nodes changed (200 source 3→2, 300 source 4→3); 100 and 400 were already right.
    expect(corrected.sort((a, b) => a - b)).toEqual([200, 300]);
    expect(supCount(nodes[0].content, 'Fn1001')).toBe('1'); // unchanged, already canonical
    expect(supCount(nodes[1].content, 'Fn1002')).toBe('2'); // 3 → 2  (the bug being fixed)
    expect(supCount(nodes[2].content, 'Fn1003')).toBe('3'); // 4 → 3
    expect(supCount(nodes[3].content, 'Fn1004')).toBe('†'); // non-numeric marker untouched
  });

  it('is idempotent — a second pass changes nothing (first full-book load renumber is a no-op)', () => {
    const nodes = pastedNodes();
    runCanonicalPass(nodes);                 // converge

    buildFootnoteMap('bookA', nodes);
    for (const n of nodes) {
      expect(applyFootnoteMapToStoredHTML(n.content).changed).toBe(false);
    }
  });
});
