/**
 * formatMetadataToCitation — the shared citation formatter behind formatBibtexToCitation, used to
 * render a canonical_source's clean citation in the citation card. Locks the per-type formatting
 * (book / article / chapter) and that external-type strings (journal-article/book-chapter) map right.
 */
import { describe, it, expect } from 'vitest';
import { formatMetadataToCitation } from '../../../resources/js/utilities/bibtexProcessor';

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
});
