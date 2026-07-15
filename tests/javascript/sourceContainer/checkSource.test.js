/**
 * checkSource — the source panel's provenance display + verify action. Covers the category
 * predicates/pills (Citation Linked, Official source text), the Librarian attribution (human /
 * automated / anonymous), and the click flow (lookup → confirm prompt → verify → re-render).
 * The sourceVerify engine (lookup/verify) and IDB read are mocked; the prompt renderer is real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../resources/js/app', () => ({ book: 'test-book' }));
vi.mock('../../../resources/js/sourceVerify/lookup', () => ({ lookupSource: vi.fn() }));
vi.mock('../../../resources/js/sourceVerify/verify', () => ({ verifySource: vi.fn() }));
// IDB read used to re-render after verify — return a linked record.
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock('../../../resources/js/components/sourceContainer/helpers', () => ({
  getRecord: vi.fn().mockResolvedValue({
    book: 'test-book', creator: 'alice', canonical_source_id: 'c1', canonical_match_method: 'user_verified', doi: '10.1/x',
  }),
}));

import {
  isCitationLinked,
  isOfficialSourceText,
  externalSourceLink,
  librarianHtml,
  sourceStatusSectionHtml,
  handleCheckSource,
  wireSourceStatus,
} from '../../../resources/js/components/sourceContainer/checkSource';
import { lookupSource } from '../../../resources/js/sourceVerify/lookup';
import { verifySource } from '../../../resources/js/sourceVerify/verify';

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('category predicates', () => {
  it('isCitationLinked: true when linked via a linking method', () => {
    expect(isCitationLinked({ canonical_source_id: 'c1', canonical_match_method: 'openalex_doi' })).toBe(true);
    expect(isCitationLinked({ canonical_source_id: 'c1', canonical_match_method: 'user_rejected' })).toBe(false);
    expect(isCitationLinked({ canonical_source_id: null })).toBe(false);
  });

  it('isOfficialSourceText: true when the book IS its canonical auto_version_book', () => {
    expect(isOfficialSourceText({
      book: 'b1', canonical_source_id: 'c1', canonical_match_method: 'auto_version_creation',
      canonical: { id: 'c1', auto_version_book: 'b1' },
    })).toBe(true);
    expect(isOfficialSourceText({
      book: 'b1', canonical_source_id: 'c1', canonical_match_method: 'openalex_doi',
      canonical: { id: 'c1', auto_version_book: 'other-book' },
    })).toBe(false);
    expect(isOfficialSourceText({ canonical_source_id: null })).toBe(false);
  });
});

describe('externalSourceLink', () => {
  it('prefers OpenAlex, then Open Library, then DOI', () => {
    expect(externalSourceLink({ canonical: { id: 'c', openalex_id: 'W1' } })).toEqual({ label: 'OpenAlex', url: 'https://openalex.org/W1' });
    expect(externalSourceLink({ open_library_key: '/works/OL1W' })).toEqual({ label: 'Open Library', url: 'https://openlibrary.org/works/OL1W' });
    expect(externalSourceLink({ doi: '10.1/x' })).toEqual({ label: 'DOI', url: 'https://doi.org/10.1/x' });
    expect(externalSourceLink({})).toBeNull();
  });
});

describe('librarianHtml', () => {
  it('human uploader links to the profile', () => {
    const html = librarianHtml({ book: 'b', creator: 'alice' });
    expect(html).toContain('Uploaded by');
    expect(html).toContain('/u/alice');
  });

  it('automated process links to the provider', () => {
    const html = librarianHtml({ book: 'b', creator: 'canonicalizer_v1', canonical: { id: 'c', openalex_id: 'W1' } });
    expect(html).toContain('Added automatically from');
    expect(html).toContain('https://openalex.org/W1');
    expect(html).toContain('OpenAlex');
  });

  it('anonymous when no creator', () => {
    expect(librarianHtml({ book: 'b', creator: null })).toContain('Uploaded anonymously');
  });

  it('ingest pseudo-librarians (Openlibrary/OpenAlex stubs) link to the provider, never /u/<name>', () => {
    // LibraryStubWriter stamps creator = ucfirst(source) on citation stubs;
    // /u/Openlibrary is a user page that does not exist.
    const ol = librarianHtml({ book: 'b', creator: 'Openlibrary', open_library_key: '/works/OL2647694W' });
    expect(ol).toContain('Added automatically from');
    expect(ol).toContain('https://openlibrary.org/works/OL2647694W');
    expect(ol).toContain('Open Library');
    expect(ol).not.toContain('/u/Openlibrary');

    const oa = librarianHtml({ book: 'b', creator: 'Openalex', canonical: { id: 'c', openalex_id: 'W9' } });
    expect(oa).toContain('https://openalex.org/W9');
    expect(oa).not.toContain('/u/Openalex');

    // No resolvable provider link → generic text, still no profile link.
    const bare = librarianHtml({ book: 'b', creator: 'Semantic_scholar' });
    expect(bare).toContain('Added automatically from');
    expect(bare).not.toContain('/u/');
  });

  it('WebFetch is not a user — links to the original URL, never /u/WebFetch', () => {
    const html = librarianHtml({ book: 'b', creator: 'WebFetch', url: 'https://progressive.international/havana' });
    expect(html).toContain('Fetched automatically from');
    expect(html).toContain('https://progressive.international/havana');
    expect(html).not.toContain('/u/WebFetch');
  });

  it('WebFetch falls back to the canonical source_url when the library url is absent', () => {
    const html = librarianHtml({ book: 'b', creator: 'WebFetch', canonical: { id: 'c', source_url: 'https://example.org/x' } });
    expect(html).toContain('https://example.org/x');
    expect(html).not.toContain('/u/WebFetch');
  });

  it('WebFetch with no URL → generic automated text, no profile link', () => {
    const html = librarianHtml({ book: 'b', creator: 'WebFetch' });
    expect(html).toContain('Fetched automatically from the web');
    expect(html).not.toContain('/u/WebFetch');
  });
});

describe('sourceStatusSectionHtml', () => {
  it('linked book shows the Citation Verified pill + Librarian (no button)', () => {
    const html = sourceStatusSectionHtml(
      { book: 'b', creator: 'alice', canonical_source_id: 'c1', canonical_match_method: 'openalex_doi', doi: '10.1/x' }, true, false,
    );
    expect(html).toContain('Citation Verified');
    expect(html).toContain('Librarian');
    expect(html).not.toContain('check-source-btn');
  });

  it('auto-version book shows Source Text Verified', () => {
    const html = sourceStatusSectionHtml({
      book: 'b1', creator: 'canonicalizer_v1', canonical_source_id: 'c1', canonical_match_method: 'auto_version_creation',
      canonical: { id: 'c1', auto_version_book: 'b1', openalex_id: 'W1' },
    }, false, false);
    // Official-source records render ONLY the official pill (the linked pill is suppressed).
    expect(html).toContain('Source Text Verified');
  });

  it('unlinked + owner shows the check button', () => {
    const html = sourceStatusSectionHtml({ book: 'b', creator: 'alice', canonical_source_id: null }, true, false);
    expect(html).toContain('check-source-btn');
  });

  it('returns nothing when access is denied', () => {
    expect(sourceStatusSectionHtml({ book: 'b', canonical_source_id: 'c1' }, true, true)).toBe('');
  });
});

describe('category pill expand (wireSourceStatus)', () => {
  it('clicking a pill reveals its explanation (with the external link inside)', () => {
    document.body.innerHTML = sourceStatusSectionHtml(
      { book: 'b', creator: 'alice', canonical_source_id: 'c1', canonical_match_method: 'openalex_doi', openalex_id: 'W1' }, true, false,
    );
    const section = document.getElementById('check-source-section');
    wireSourceStatus(section);

    const pill = section.querySelector('.source-cat-pill[data-cat="linked"]');
    const detail = section.querySelector('.source-cat-detail[data-cat="linked"]');
    expect(detail.style.display).toBe('none');

    pill.click();
    expect(detail.style.display).toBe('block');
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(detail.innerHTML).toContain('openalex.org/W1');

    pill.click(); // toggles closed
    expect(detail.style.display).toBe('none');
  });
});

describe('handleCheckSource', () => {
  function setupPanel() {
    document.body.innerHTML = `
      <div id="src">
        <div id="check-source-section">
          <button type="button" id="check-source-btn">Check source</button>
        </div>
      </div>`;
    return { container: document.getElementById('src'), refreshCitationDisplay: vi.fn() };
  }

  it('lookup → prompt → yes → verify → re-renders to Citation Verified', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({
      success: true, status: 'linked_new', method: 'openalex_doi', score: 0.92,
      candidate: { title: 'Hit', openalex_id: 'W1' }, alternates: [], alreadyLinked: false, current: null,
    });
    verifySource.mockResolvedValue({ success: true, canonical_source_id: 'c1', library: { canonical_match_method: 'user_verified' } });

    await handleCheckSource(self);
    expect(self.container.querySelector('.source-match-select')).toBeTruthy();

    self.container.querySelector('.source-match-select').click();
    await flush();

    expect(verifySource).toHaveBeenCalledWith('test-book', expect.objectContaining({ openalex_id: 'W1' }));
    const sectionHtml = self.container.querySelector('#check-source-section').innerHTML;
    expect(sectionHtml).toContain('Citation Verified');
    expect(self.refreshCitationDisplay).toHaveBeenCalled();
  });

  it('confirms an existing auto-link (current) when there is no fresh candidate', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({
      success: true, status: 'already_linked', method: 'openalex_doi', score: 1.0,
      candidate: null, alternates: [], alreadyLinked: true,
      current: { title: 'Auto Linked Work', openalex_id: 'W1' },
    });
    verifySource.mockResolvedValue({ success: true, canonical_source_id: 'c1', library: {} });

    await handleCheckSource(self);
    expect(self.container.textContent).toContain('Auto Linked Work');

    self.container.querySelector('.source-match-select').click();
    await flush();

    expect(verifySource).toHaveBeenCalledWith('test-book', expect.objectContaining({ openalex_id: 'W1' }));
  });

  it('renders a shortlist (candidate + alternates) and verifies the CHOSEN one', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({
      success: true, status: 'linked_new', method: 'openalex_full', score: 0.8,
      candidate: { title: 'Top Hit', openalex_id: 'W1', match_score: 0.8 },
      alternates: [
        { title: 'Second Guess', open_library_key: '/works/OL2W', match_score: 0.5 },
        { title: 'Long Shot', doi: '10.1/ls', match_score: 0.2 },
      ],
      alreadyLinked: false, current: null,
    });
    verifySource.mockResolvedValue({ success: true, canonical_source_id: 'c2', library: {} });

    await handleCheckSource(self);

    const rows = self.container.querySelectorAll('.source-match-select');
    expect(rows.length).toBe(3);                                   // candidate + 2 alternates
    expect(self.container.querySelector('.source-match-none')).toBeTruthy();
    expect(self.container.textContent).toContain('Is it one of these?');
    expect(self.container.textContent).toContain('80% match');     // per-row confidence
    expect(self.container.textContent).toContain('50% match');

    // Pick the SECOND candidate — verify must receive its identifier, not the top one's.
    rows[1].click();
    await flush();
    expect(verifySource).toHaveBeenCalledWith('test-book', expect.objectContaining({ open_library_key: '/works/OL2W' }));
  });

  it('dedupes candidates that share an identifier across title + ISBN hits', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({
      success: true, status: 'linked_new', method: 'open_library_full', score: 0.7,
      candidate: { title: 'Dup Work', open_library_key: '/works/OL9W', match_score: 0.7 },
      alternates: [{ title: 'Dup Work', open_library_key: '/works/OL9W', match_score: 0.7 }],
      alreadyLinked: false, current: null,
    });

    await handleCheckSource(self);
    expect(self.container.querySelectorAll('.source-match-select').length).toBe(1);
  });

  it('None of these closes the prompt and re-enables the button', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({
      success: true, status: 'linked_new', method: 'openalex_full', score: 0.6,
      candidate: { title: 'Maybe', openalex_id: 'W1', match_score: 0.6 }, alternates: [],
      alreadyLinked: false, current: null,
    });

    await handleCheckSource(self);
    expect(self.container.querySelector('#check-source-prompt')).toBeTruthy();

    self.container.querySelector('.source-match-none').click();
    await flush();

    expect(self.container.querySelector('#check-source-prompt')).toBeNull();
    expect(self.container.querySelector('#check-source-btn').disabled).toBe(false);
    expect(verifySource).not.toHaveBeenCalled();
  });

  it('shows a message when no candidate is found', async () => {
    const self = setupPanel();
    lookupSource.mockResolvedValue({ success: true, status: 'no_match', candidate: null, alternates: [], alreadyLinked: false, current: null });

    await handleCheckSource(self);

    expect(self.container.textContent).toContain('No matching source found');
    expect(self.container.querySelector('#check-source-btn').disabled).toBe(false);
  });
});
