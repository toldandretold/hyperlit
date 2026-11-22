import { describe, it, expect } from 'vitest';
import {
  articleLint, detectorDeltas, detectorLabel, lintTotals, summarize, withNewFindings, worstFirst,
} from '../../../resources/js/workbenches/journalImport/lintView.ts';

const found = (score, extra = {}) => ({
  score, counts: {}, findings: [], findings_total: score > 0 ? 1 : 0, new: 0, ...extra,
});
const article = (...lanes) => ({ lanes: lanes.map(([book, is_version = false]) => ({ book, is_version })) });

describe('journal-import conversion lint view', () => {
  it('summarises worst kind first, in plain words', () => {
    expect(summarize({ colon_heading: 3, fragment_blockquote: 2, orphan_definition: 1 }))
      .toBe('false blockquote ×2, footnote nobody points to ×1, heading ends in a colon ×3');
  });

  it('still shows a detector the page has never heard of', () => {
    // A detector added server-side must not vanish from the console until someone labels it.
    expect(detectorLabel('brand_new_detector')).toBe('brand_new_detector');
    expect(summarize({ brand_new_detector: 2, split_sentence: 1 }))
      .toBe('split sentence ×1, brand_new_detector ×2');
  });

  it('judges an article by its PROMOTED lane, not its worst one', () => {
    // The losing sibling's problems are why it lost — they are not what readers get.
    const lint = new Map([['pdf', found(2)], ['html', found(40)]]);
    expect(articleLint(article(['pdf', true], ['html']), lint).score).toBe(2);
  });

  it('falls back to the worst lane when the promoted one has no lint', () => {
    const lint = new Map([['html', found(7)], ['other', found(3)]]);
    // promoted lane still converting (absent from the payload)
    expect(articleLint(article(['pdf', true], ['html'], ['other']), lint).score).toBe(7);
    expect(articleLint(article(['pdf', true]), lint)).toBeNull();
  });

  it('ranks worst first, drops clean articles, and keeps the list order on ties', () => {
    const a = article(['a', true]);
    const b = article(['b', true]);
    const c = article(['c', true]);
    const clean = article(['clean', true]);
    const unimported = article();
    const lint = new Map([['a', found(5)], ['b', found(9)], ['c', found(5)], ['clean', found(0)]]);

    expect(worstFirst([a, clean, b, unimported, c], lint)).toEqual([b, a, c]);
  });

  it('puts an article a reconvert made WORSE above one that has merely always been messy', () => {
    const messy = article(['messy', true]);
    const regressed = article(['regressed', true]);
    const lint = new Map([['messy', found(60)], ['regressed', found(1, { new: 1 })]]);

    expect(worstFirst([messy, regressed], lint)).toEqual([regressed, messy]);
    expect(withNewFindings([messy, regressed], lint)).toEqual([regressed]);
  });

  it('lists only the detectors that moved, regressions first', () => {
    const deltas = detectorDeltas({
      detectors: {
        fragment_blockquote: [6, 0],
        colon_heading: [13, 13],
        orphan_definition: [8, 9],
      },
    });
    expect(deltas.map((d) => [d.detector, d.before, d.after, d.direction])).toEqual([
      ['orphan_definition', 8, 9, 'up'],
      ['fragment_blockquote', 6, 0, 'down'],
    ]);
  });

  it('totals count every finding, not just the ones the server sent', () => {
    const lint = new Map([
      ['a', found(5, { findings_total: 498 })],   // capped list, real total
      ['b', found(0)],
      ['c', found(2, { findings_total: 2 })],
    ]);
    expect(lintTotals(lint)).toEqual({ findings: 500, books: 2 });
  });
});
