/**
 * Characterization tests for FootnoteNumberingService — pins the dynamic
 * numbering behaviour BEFORE the JS→TS + modularization so both steps are
 * verifiable. Focuses on the pure (map-building) and DOM-only (renumber /
 * migrate) logic, which is the bulk of the service and the split target.
 * The IDB-touching paths (rebuildAndRenumber → persist/reconcile) are left to
 * the e2e footnote-integrity spec.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildFootnoteMap,
  getDisplayNumber,
  getFootnoteId,
  getCurrentBookId,
  getCurrentMap,
  getMapSize,
  hasOldFormatFootnotes,
  updateFootnoteNumbersInDOM,
  migrateOldFormatFootnotes,
  clearCache,
} from '../../../resources/js/footnotes/FootnoteNumberingService';

beforeEach(() => {
  clearCache();
  document.body.innerHTML = '';
});

describe('buildFootnoteMap', () => {
  it('numbers footnotes sequentially in startLine (document) order, regardless of node order', () => {
    const nodes = [
      { startLine: 3, footnotes: [{ id: 'b_Fn30' }] },
      { startLine: 1, footnotes: [{ id: 'b_Fn10' }] },
      { startLine: 2, footnotes: [{ id: 'b_Fn20' }] },
    ];
    buildFootnoteMap('bookA', nodes);

    expect(getDisplayNumber('b_Fn10')).toBe(1);
    expect(getDisplayNumber('b_Fn20')).toBe(2);
    expect(getDisplayNumber('b_Fn30')).toBe(3);
  });

  it('supports the old string-form footnotes array', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: ['b_Fn1', 'b_Fn2'] }]);
    expect(getDisplayNumber('b_Fn1')).toBe(1);
    expect(getDisplayNumber('b_Fn2')).toBe(2);
  });

  it('deduplicates a footnote id seen more than once', () => {
    buildFootnoteMap('bookA', [
      { startLine: 1, footnotes: [{ id: 'b_Fn1' }] },
      { startLine: 2, footnotes: [{ id: 'b_Fn1' }, { id: 'b_Fn2' }] },
    ]);
    expect(getDisplayNumber('b_Fn1')).toBe(1);
    expect(getDisplayNumber('b_Fn2')).toBe(2);
    expect(getMapSize()).toBe(2);
  });

  it('preserves intentional non-numeric markers (*, †, 43a) and does NOT sequence them', () => {
    buildFootnoteMap('bookA', [
      { startLine: 1, footnotes: [{ id: 'b_FnStar', marker: '*' }] },
      { startLine: 2, footnotes: [{ id: 'b_Fn1', marker: '1' }] },
      { startLine: 3, footnotes: [{ id: 'b_Fn43a', marker: '43a' }] },
    ]);
    // Preserved markers keep their literal value...
    expect(getDisplayNumber('b_FnStar')).toBe('*');
    expect(getDisplayNumber('b_Fn43a')).toBe('43a');
    // ...and only the numeric-marker footnote consumes a sequential number.
    expect(getDisplayNumber('b_Fn1')).toBe(1);
    // Preserved markers are NOT in the reverse map.
    expect(getFootnoteId(1)).toBe('b_Fn1');
  });

  it('renumbers the "?" placeholder marker (treated as numeric)', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: [{ id: 'b_FnNew', marker: '?' }] }]);
    expect(getDisplayNumber('b_FnNew')).toBe(1);
  });

  it('clears the cache when the book changes', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: ['b_Fn1'] }]);
    expect(getCurrentBookId()).toBe('bookA');
    buildFootnoteMap('bookB', [{ startLine: 1, footnotes: ['b_Fn9'] }]);
    expect(getCurrentBookId()).toBe('bookB');
    expect(getDisplayNumber('b_Fn1')).toBeNull(); // bookA entry gone
    expect(getDisplayNumber('b_Fn9')).toBe(1);
  });

  it('returns null display number for an unknown id', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: ['b_Fn1'] }]);
    expect(getDisplayNumber('nope')).toBeNull();
    expect(getDisplayNumber('')).toBeNull();
  });
});

describe('getCurrentMap / getMapSize', () => {
  it('returns a defensive copy of the map', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: ['b_Fn1'] }]);
    const copy = getCurrentMap();
    copy.set('b_Fn1', 999);
    expect(getDisplayNumber('b_Fn1')).toBe(1); // internal map untouched
  });
});

describe('hasOldFormatFootnotes', () => {
  it('is true when a footnote id is a bare display number', () => {
    expect(hasOldFormatFootnotes([{ footnotes: ['1', '2'] }])).toBe(true);
  });
  it('is false for new _Fn ids (string or object form)', () => {
    expect(hasOldFormatFootnotes([{ footnotes: ['book_Fn123'] }])).toBe(false);
    expect(hasOldFormatFootnotes([{ footnotes: [{ id: 'book_Fn123' }] }])).toBe(false);
  });
  it('is false when there are no footnotes', () => {
    expect(hasOldFormatFootnotes([{ footnotes: [] }, {}])).toBe(false);
  });
});

describe('updateFootnoteNumbersInDOM', () => {
  it('rewrites stale sup numbers to the current map and reports affected startLines', () => {
    document.body.innerHTML =
      '<p id="7"><sup fn-count-id="5" id="b_Fn1" class="footnote-ref">5</sup></p>';
    buildFootnoteMap('bookA', [{ startLine: 7, footnotes: [{ id: 'b_Fn1' }] }]);

    const affected = updateFootnoteNumbersInDOM();

    const sup = document.querySelector('sup');
    expect(sup.getAttribute('fn-count-id')).toBe('1');
    expect(sup.textContent).toBe('1');
    expect(affected.has('7')).toBe(true);
  });

  it('leaves an already-correct sup untouched (no startLine reported)', () => {
    document.body.innerHTML =
      '<p id="7"><sup fn-count-id="1" id="b_Fn1" class="footnote-ref">1</sup></p>';
    buildFootnoteMap('bookA', [{ startLine: 7, footnotes: [{ id: 'b_Fn1' }] }]);
    const affected = updateFootnoteNumbersInDOM();
    expect(affected.size).toBe(0);
  });

  it('preserves an intentional non-numeric marker in the DOM', () => {
    document.body.innerHTML =
      '<p id="7"><sup fn-count-id="*" id="b_FnStar" class="footnote-ref">*</sup></p>';
    buildFootnoteMap('bookA', [{ startLine: 7, footnotes: [{ id: 'b_FnStar', marker: '*' }] }]);
    updateFootnoteNumbersInDOM();
    expect(document.querySelector('sup').getAttribute('fn-count-id')).toBe('*');
  });
});

describe('migrateOldFormatFootnotes', () => {
  it('maps bare display numbers to _Fn ids using the HTML content', async () => {
    const nodes = [
      {
        startLine: 1,
        footnotes: ['2'],
        content: '<p id="1">x<sup fn-count-id="2" id="b_Fn222" class="footnote-ref">2</sup></p>',
      },
    ];
    const out = await migrateOldFormatFootnotes('bookA', nodes);
    expect(out[0].footnotes).toEqual(['b_Fn222']);
  });

  it('is a no-op when already in new format', async () => {
    const nodes = [{ startLine: 1, footnotes: ['b_Fn1'], content: '' }];
    const out = await migrateOldFormatFootnotes('bookA', nodes);
    expect(out[0].footnotes).toEqual(['b_Fn1']);
  });
});

describe('clearCache', () => {
  it('empties the map and resets the current book id', () => {
    buildFootnoteMap('bookA', [{ startLine: 1, footnotes: ['b_Fn1'] }]);
    clearCache();
    expect(getMapSize()).toBe(0);
    expect(getCurrentBookId()).toBeNull();
    expect(getDisplayNumber('b_Fn1')).toBeNull();
  });
});
