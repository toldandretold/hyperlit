/**
 * formatMetadataToCitation — the shared citation formatter behind formatBibtexToCitation, used to
 * render a canonical_source's clean citation in the citation card. Locks the per-type formatting
 * (book / article / chapter) and that external-type strings (journal-article/book-chapter) map right.
 */
import { describe, it, expect } from 'vitest';
import { formatMetadataToCitation, doiToUrl } from '../../../resources/js/utilities/bibtexProcessor';

describe('formatMetadataToCitation', () => {
  it('book: italic title + (publisher, year)', () => {
    const c = formatMetadataToCitation({ title: 'Darker Nations', author: 'Prashad, Vijay', year: 2007, publisher: 'The New Press', type: 'book' });
    expect(c).toBe('Prashad, Vijay, <i>Darker Nations</i> (The New Press, 2007).');
  });

  it('journal-article (external type): quoted title + journal + (year)', () => {
    const c = formatMetadataToCitation({ title: 'On Value', author: 'A. Author', year: 2010, journal: 'Review', type: 'journal-article' });
    expect(c).toBe('A. Author, "On Value", Review (2010).');
  });

  it('book-chapter (external type): quoted title in <i>booktitle</i>', () => {
    const c = formatMetadataToCitation({ title: 'A Chapter', author: 'B. Writer', booktitle: 'The Book', publisher: 'Pub', year: 2015, type: 'book-chapter' });
    expect(c).toContain('"A Chapter" in <i>The Book</i>');
    expect(c).toContain('(Pub, 2015)');
  });

  it('missing year is simply omitted (not "Unknown Year")', () => {
    const c = formatMetadataToCitation({ title: 'No Year', author: 'C. Person', publisher: 'Pub', type: 'book' });
    expect(c).toBe('C. Person, <i>No Year</i> (Pub).');
    expect(c).not.toContain('Unknown');
  });

  it('defaults author/title when absent', () => {
    const c = formatMetadataToCitation({});
    expect(c).toContain('Unknown Author');
    expect(c).toContain('<i>Untitled</i>');
  });

  // The link. A harvested row carries `doi` but no `url`, and the copy the harvester found
  // (oa_url/pdf_url) is often a publisher deep link that 403s — so the DOI is the fallback link,
  // and a bare DOI must never be emitted as an href.
  it('links the title to the DOI when no url is supplied', () => {
    const c = formatMetadataToCitation({ title: 'Polycrisis', author: 'K. Jayasuriya', year: 2023, journal: 'GSCJ', type: 'article', doi: '10.1332/knjy6381' });
    expect(c).toContain('<a href="https://doi.org/10.1332/knjy6381" target="_blank">"Polycrisis"</a>');
  });

  it('an explicit url still wins over the DOI', () => {
    const c = formatMetadataToCitation({ title: 'Polycrisis', author: 'K. Jayasuriya', type: 'article', url: 'https://example.org/full-text', doi: '10.1332/knjy6381' });
    expect(c).toContain('href="https://example.org/full-text"');
    expect(c).not.toContain('doi.org');
  });

  it('a bare DOI is never rendered as an href', () => {
    const c = formatMetadataToCitation({ title: 'Polycrisis', author: 'K. Jayasuriya', type: 'article', url: '10.1332/knjy6381' });
    expect(c).not.toContain('<a href');
  });
});

describe('doiToUrl', () => {
  it('resolves bare, doi:-prefixed and already-resolved DOIs', () => {
    expect(doiToUrl('10.1332/knjy6381')).toBe('https://doi.org/10.1332/knjy6381');
    expect(doiToUrl('doi: 10.1332/knjy6381')).toBe('https://doi.org/10.1332/knjy6381');
    expect(doiToUrl('https://doi.org/10.1332/knjy6381')).toBe('https://doi.org/10.1332/knjy6381');
    expect(doiToUrl('https://dx.doi.org/10.1332/knjy6381')).toBe('https://doi.org/10.1332/knjy6381');
  });

  it('rejects non-DOIs', () => {
    expect(doiToUrl(null)).toBeNull();
    expect(doiToUrl('')).toBeNull();
    expect(doiToUrl('https://example.org/paper.pdf')).toBeNull();
    expect(doiToUrl('10.1332')).toBeNull();
  });
});
