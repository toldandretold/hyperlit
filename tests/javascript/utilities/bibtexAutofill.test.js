/**
 * bibtexAutofillValues — what a pasted/dropped BibTeX entry puts into the
 * new-book cite form and the source panel's pencil form.
 *
 * WHY THIS EXISTS, in one real case. `tests/fixtures/bibtex/ojs-weizenbaum-abstractnote.bib`
 * is an unedited OJS "Download citation" export (the Weizenbaum Journal article
 * imported to prod 2026-09-24). Both forms used to read their fields with a
 * block of per-field regexes like `/note\s*=\s*[{"]([^}"]+)[}"]/i`, unanchored
 * and delimiter-naive. Dropping that one file in therefore:
 *
 *  - matched `abstractNote={…}` on its TAIL and filled the Note field with a
 *    1210-char abstract. `generateBibtexFromForm` baked it into `library.bibtex`
 *    as `note = {…}`, and LibraryCardGenerator::generateHtmlCitation appends
 *    `note` to the end of the citation — so the whole abstract rendered inside
 *    the citation on every server-generated library card (home feeds, user page,
 *    shelves, journal). Double-escaped, because OJS exports its abstract HTML
 *    entity-escaped twice.
 *  - dropped `DOI={10.34669/wi.wjds/6.3.3}` entirely (no pattern for it).
 *
 * The other two failure modes of that regex block are pinned below: a value is
 * cut short at any ASCII apostrophe, and `booktitle`/`bookauthor` satisfy the
 * `title`/`author` patterns when they appear first in the entry.
 */
import { describe, it, expect } from 'vitest';
// The fixture is the file as the publisher served it — imported raw so nobody can
// "tidy" the double-escaped abstract out of it while editing a test.
import OJS_EXPORT from '../../fixtures/bibtex/ojs-weizenbaum-abstractnote.bib?raw';
import { bibtexAutofillValues, bibtexEntryKey, parseBibtexFields } from '../../../resources/js/utilities/bibtexProcessor';

describe('bibtexAutofillValues — the real OJS export', () => {
  it('does NOT read abstractNote as the note', () => {
    const values = bibtexAutofillValues(OJS_EXPORT);

    expect(values.note).toBeUndefined();
    // Belt and braces: no field may carry the abstract, whatever its name.
    for (const [field, value] of Object.entries(values)) {
      expect(value, `${field} carries the abstract`).not.toContain('This article argues');
    }
  });

  it('fills the citation fields it can, and only those', () => {
    const values = bibtexAutofillValues(OJS_EXPORT);

    expect(values).toEqual({
      title: 'Digitalization and New Situations of Dependency: Technological Development and Political Conflicts',
      author: 'Gretschischkin, Felipe',
      journal: 'Weizenbaum Journal of the Digital Society',
      year: '2026',
      volume: '6',
      issue: '3',
      url: 'https://ojs.weizenbaum-institut.de/index.php/wjds/article/view/6_3_3',
    });
  });

  it('keeps the whole title — the old regex stopped at the first closing brace', () => {
    // The fixture's title is long and colon-bearing; a truncated autofill is the
    // failure that is easiest to ship unnoticed (the field just looks filled).
    expect(bibtexAutofillValues(OJS_EXPORT).title).toMatch(/Political Conflicts$/);
  });

  it('offers the entry key as the book id', () => {
    expect(bibtexEntryKey(OJS_EXPORT)).toBe('Gretschischkin_2026');
  });

  it('still parses the dropped fields — they have nowhere to go, they are not unreadable', () => {
    // If/when the forms gain an abstract + doi input (library.abstract feeds the
    // book page's meta description and JSON-LD), the data is right here.
    const fields = parseBibtexFields(OJS_EXPORT);
    expect(fields.doi).toBe('10.34669/wi.wjds/6.3.3');
    expect(fields.abstractnote).toContain('This article argues');
    expect(fields.note).toBeUndefined();
  });
});

describe('bibtexAutofillValues — the rest of the key-tail bug class', () => {
  it('never lets a compound key satisfy its suffix', () => {
    const entry = [
      '@incollection{x,',
      '  booktitle={The Big Anthology},',
      '  bookauthor={Editor, Ann},',
      '  shorttitle={Short},',
      '  abstractNote={An abstract.},',
      '  title={My Chapter},',
      '  author={Real, Author},',
      '}',
    ].join('\n');

    const values = bibtexAutofillValues(entry);
    expect(values.title).toBe('My Chapter');
    expect(values.author).toBe('Real, Author');
    expect(values.booktitle).toBe('The Big Anthology');
    expect(values.note).toBeUndefined();
  });

  it('keeps a value containing an apostrophe whole', () => {
    // `title={Marx's Capital}` autofilled as "Marx" — the old value class was
    // [^}"']+, so the apostrophe terminated it.
    const values = bibtexAutofillValues("@book{x, title={Marx's Capital}, author={Marx, Karl} }");
    expect(values.title).toBe("Marx's Capital");
  });

  it('keeps a protected name whole', () => {
    const values = bibtexAutofillValues('@book{x, author={{World Health Organization}}, title={Report} }');
    expect(values.author).toBe('{World Health Organization}');
  });

  it('reads a quoted value and a bare one', () => {
    const values = bibtexAutofillValues('@article{x, title = "A Quoted Title", year = 2026, volume = 12 }');
    expect(values.title).toBe('A Quoted Title');
    expect(values.year).toBe('2026');
    expect(values.volume).toBe('12');
  });

  it('takes the 4-digit year out of a messier date, and drops a yearless one', () => {
    expect(bibtexAutofillValues('@article{x, year={Sep. 2026} }').year).toBe('2026');
    expect(bibtexAutofillValues('@article{x, year={in press} }').year).toBeUndefined();
  });

  it('maps number to the form issue field', () => {
    expect(bibtexAutofillValues('@article{x, number={3} }')).toEqual({ issue: '3' });
  });

  it('omits absent and empty fields rather than blanking what the user typed', () => {
    expect(bibtexAutofillValues('@article{x, title={T}, journal={} }')).toEqual({ title: 'T' });
    expect(bibtexAutofillValues('')).toEqual({});
    expect(bibtexAutofillValues('not a bibtex entry at all')).toEqual({});
  });
});
