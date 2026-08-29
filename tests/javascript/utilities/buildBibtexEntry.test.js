/**
 * buildBibtexEntry — the synthesised BibTeX written onto a library row (at book
 * creation, and regenerated whenever a title changes).
 *
 * It used to stamp `new Date().getFullYear()` unconditionally, which is not a
 * fallback but a fabrication: every consumer formats that field as the work's
 * PUBLICATION date. A 2024 article imported in 2026 therefore rendered as
 * "(2026)" in its hypercite ↗ panel (which formats library.bibtex) while the
 * citing book's own bibliography entry — reading canonical_source — correctly
 * said "(2024)". These lock the year to the record, and lock the omission.
 */
import { describe, it, expect } from 'vitest';
import { buildBibtexEntry } from '../../../resources/js/utilities/bibtexProcessor';

describe('buildBibtexEntry', () => {
  it("uses the record's year", () => {
    const bib = buildBibtexEntry({ book: 'book_1', title: 'Governing the Commons', author: 'Ostrom', year: '1990' });
    expect(bib).toContain('year   = {1990}');
    expect(bib).toContain('title  = {Governing the Commons}');
    expect(bib).toContain('author = {Ostrom}');
    expect(bib.startsWith('@book{book_1,')).toBe(true);
  });

  it('accepts a numeric year and trims a padded one', () => {
    expect(buildBibtexEntry({ book: 'b', title: 't', author: 'a', year: 2024 })).toContain('year   = {2024}');
    expect(buildBibtexEntry({ book: 'b', title: 't', author: 'a', year: ' 2024 ' })).toContain('year   = {2024}');
  });

  it('omits the year entirely rather than inventing the current one', () => {
    const thisYear = String(new Date().getFullYear());
    for (const year of [undefined, null, '']) {
      const bib = buildBibtexEntry({ book: 'b', title: 't', author: 'a', year });
      expect(bib).not.toContain('year');
      expect(bib).not.toContain(thisYear);
    }
  });

  it('stays valid BibTeX with the year dropped', () => {
    const bib = buildBibtexEntry({ book: 'b', title: 't', author: 'a' });
    expect(bib).toBe('@book{b,\n  author = {a},\n  title  = {t},\n}');
  });
});
