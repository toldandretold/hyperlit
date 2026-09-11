/**
 * authorList — the shared author-list vocabulary (split / surname / in-text /
 * reference-list / bibtex-field). Locks the multi-author citation fix: a
 * semicolon-joined harvest string ("Kevin Munger; Bert N. Bakker; Adam J.
 * Berinsky") must render in-text as "Munger et al.", never as the last word
 * of the whole string ("Berinsky" — the original bug).
 *
 * Also locks parseBibtexFields' brace-awareness: the old first-closing-brace
 * regex truncated protected names ({van Rossum}, Guido) mid-value.
 */
import { describe, it, expect } from 'vitest';
import {
  splitAuthors,
  surnameOf,
  formatInTextAuthors,
  formatAuthorsForReference,
  authorsToBibtexField,
  isUuidAuthor,
  REFERENCE_LIST_MAX,
  REFERENCE_LIST_HEAD,
} from '../../../resources/js/utilities/authorList';
import { parseBibtexFields } from '../../../resources/js/utilities/bibtexProcessor';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const MUNGER = 'Kevin Munger; Bert N. Bakker; Adam J. Berinsky';

describe('splitAuthors', () => {
  it('splits semicolon-joined lists (the harvest convention)', () => {
    expect(splitAuthors(MUNGER)).toEqual(['Kevin Munger', 'Bert N. Bakker', 'Adam J. Berinsky']);
  });

  it('splits " and "-joined lists (the BibTeX convention)', () => {
    expect(splitAuthors('Karl Marx and Friedrich Engels')).toEqual(['Karl Marx', 'Friedrich Engels']);
    expect(splitAuthors('Munger, Kevin and Bakker, Bert N. and Berinsky, Adam J.'))
      .toEqual(['Munger, Kevin', 'Bakker, Bert N.', 'Berinsky, Adam J.']);
  });

  it('prefers ";" when both separators appear (protects corporate names)', () => {
    expect(splitAuthors('Institute for War and Peace Reporting; Jane Doe'))
      .toEqual(['Institute for War and Peace Reporting', 'Jane Doe']);
  });

  it('keeps brace-protected segments atomic (braces preserved for bibtex re-joins)', () => {
    expect(splitAuthors('{World Health Organization} and Smith, Jo'))
      .toEqual(['{World Health Organization}', 'Smith, Jo']);
    expect(splitAuthors('{Institute for War and Peace Reporting}'))
      .toEqual(['{Institute for War and Peace Reporting}']);
  });

  it('treats a UUID (anonymous creator) as a single atomic token', () => {
    expect(splitAuthors(UUID)).toEqual([UUID]);
  });

  it('returns [] for empty input', () => {
    expect(splitAuthors('')).toEqual([]);
    expect(splitAuthors('   ')).toEqual([]);
  });
});

describe('surnameOf', () => {
  it('comma form takes text before the comma', () => {
    expect(surnameOf('Munger, Kevin')).toBe('Munger');
  });

  it('word form takes the last word', () => {
    expect(surnameOf('Kevin Munger')).toBe('Munger');
  });

  it('keeps lowercase particles attached', () => {
    expect(surnameOf('Ludwig van Beethoven')).toBe('van Beethoven');
    expect(surnameOf('Sofia van der Berg')).toBe('van der Berg');
  });

  it('mononyms and braced corporates pass whole', () => {
    expect(surnameOf('Voltaire')).toBe('Voltaire');
    expect(surnameOf('{Open Science Collaboration}')).toBe('Open Science Collaboration');
  });
});

describe('formatInTextAuthors (APA-ish)', () => {
  it('one author → surname', () => {
    expect(formatInTextAuthors('Karl Marx')).toBe('Marx');
    expect(formatInTextAuthors('Marx, Karl')).toBe('Marx');
  });

  it('two authors → "A & B"', () => {
    expect(formatInTextAuthors('Kevin Munger; Bert N. Bakker')).toBe('Munger & Bakker');
    expect(formatInTextAuthors('Karl Marx and Friedrich Engels')).toBe('Marx & Engels');
  });

  it('three or more → "First et al." — the (Berinsky 2026) bug', () => {
    expect(formatInTextAuthors(MUNGER)).toBe('Munger et al.');
    expect(formatInTextAuthors('A One and B Two and C Three')).toBe('One et al.');
  });

  it('UUID → "Anon"; empty → "Unknown"', () => {
    expect(formatInTextAuthors(UUID)).toBe('Anon');
    expect(formatInTextAuthors('')).toBe('Unknown');
  });
});

describe('formatAuthorsForReference', () => {
  it('single author unchanged', () => {
    expect(formatAuthorsForReference('Prashad, Vijay')).toBe('Prashad, Vijay');
  });

  it('two-to-ten authors listed in full with "&" before the last', () => {
    expect(formatAuthorsForReference(MUNGER))
      .toBe('Kevin Munger, Bert N. Bakker & Adam J. Berinsky');
    const ten = Array.from({ length: REFERENCE_LIST_MAX }, (_, i) => `Author ${i + 1}`).join('; ');
    const formatted = formatAuthorsForReference(ten);
    expect(formatted).toContain(`Author ${REFERENCE_LIST_MAX}`);
    expect(formatted).not.toContain('et al.');
  });

  it('more than ten → first seven + ", et al." (Chicago 17th)', () => {
    const eleven = Array.from({ length: REFERENCE_LIST_MAX + 1 }, (_, i) => `Author ${i + 1}`).join('; ');
    const formatted = formatAuthorsForReference(eleven);
    expect(formatted).toBe(
      Array.from({ length: REFERENCE_LIST_HEAD }, (_, i) => `Author ${i + 1}`).join(', ') + ', et al.',
    );
  });

  it('UUID and anonymity labels pass through untouched', () => {
    expect(formatAuthorsForReference(UUID)).toBe(UUID);
    expect(formatAuthorsForReference('Anon')).toBe('Anon');
    expect(formatAuthorsForReference('Anon (me)')).toBe('Anon (me)');
  });
});

describe('authorsToBibtexField', () => {
  it('converts "; " to " and " for the bibtex author field', () => {
    expect(authorsToBibtexField(MUNGER))
      .toBe('Kevin Munger and Bert N. Bakker and Adam J. Berinsky');
  });

  it('an " and "-joined string with no ";" round-trips unchanged', () => {
    const bibtexForm = 'Munger, Kevin and Bakker, Bert N.';
    expect(authorsToBibtexField(bibtexForm)).toBe(bibtexForm);
  });

  it('UUIDs pass through untouched (anonymisation round-trip)', () => {
    expect(authorsToBibtexField(UUID)).toBe(UUID);
  });
});

describe('isUuidAuthor', () => {
  it('matches user UUIDs and rejects names', () => {
    expect(isUuidAuthor(UUID)).toBe(true);
    expect(isUuidAuthor('Kevin Munger')).toBe(false);
  });
});

describe('parseBibtexFields (brace-aware)', () => {
  it('parses simple fields with lowercased keys', () => {
    const f = parseBibtexFields('@misc{x, Author = {Karl Marx}, YEAR = {1867}}');
    expect(f.author).toBe('Karl Marx');
    expect(f.year).toBe('1867');
  });

  it('survives one level of protective inner braces', () => {
    const f = parseBibtexFields('@misc{x, author = {{van Rossum}, Guido and {World Health Organization}}, year = {2020}}');
    expect(f.author).toBe('{van Rossum}, Guido and {World Health Organization}');
    expect(f.year).toBe('2020');
  });

  it('parses quoted values', () => {
    const f = parseBibtexFields('@misc{x, author = "Jane Doe", title = "T"}');
    expect(f.author).toBe('Jane Doe');
  });
});
