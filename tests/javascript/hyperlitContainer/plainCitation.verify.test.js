/**
 * plainCitation — the clean source-container-style citation card:
 *   • matched → title-linked citation in the blockquote + a "Citation verified" pill that expands an
 *     explanation (method + "view on OpenAlex ↗"). Owner also gets a subtle Check source.
 *   • unmatched → imported text; owner gets Check source, reader gets nothing.
 *   • Check source → lookup → renderSourceMatchList → owner pick → approve → re-render to matched.
 * resolveBibliographyTarget (canonical metadata) + the referenceVerify client are mocked; the pill
 * expand (wireSourceStatus) and the shortlist renderer (renderSourceMatchList) are REAL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/indexedDB/bibliography/index', () => ({ resolveBibliographyTarget: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../resources/js/utilities/auth/index', () => ({ canUserEditBook: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/utils', () => ({ fetchLibraryFromServer: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../resources/js/sourceVerify/referenceVerify', () => ({
  lookupReference: vi.fn(),
  approveReference: vi.fn(),
  candidateExternalUrl: (c) => (c?.oa_url || (c?.openalex_id ? `https://openalex.org/${c.openalex_id}` : null)),
}));

import {
  buildCitationContent,
  wireReferenceVerifyButtons,
} from '../../../resources/js/hyperlitContainer/contentBuilders/displayCitations';
import { resolveBibliographyTarget } from '../../../resources/js/indexedDB/bibliography/index';
import { canUserEditBook } from '../../../resources/js/utilities/auth/index';
import { lookupReference, approveReference } from '../../../resources/js/sourceVerify/referenceVerify';

function parse(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}
const bib = (referenceId, extra = {}) => ({ book: 'bookA', referenceId, content: 'Imported ref text.', ...extra });
// Several ticks — the click handler does dynamic import()s (referenceVerify + prompt) before rendering.
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

const COX_META = {
  title: "'Real Socialism' in Historical Perspective", author: 'Robert W. Cox', year: 1991,
  journal: 'Socialist Register', oa_url: 'https://socialistregister.com/download/5594/2492', openalex_id: 'W123',
};

describe('plainCitation — clean source-container-style card', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    document.body.innerHTML = '';
    canUserEditBook.mockResolvedValue(false);
    resolveBibliographyTarget.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it('unmatched: owner gets Check source, reader does not (imported text kept)', async () => {
    await seedStore('bibliography', [bib('Ref1')]);

    canUserEditBook.mockResolvedValue(true);
    let dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(dom.querySelector('.ref-check-source')).toBeTruthy();
    expect(dom.textContent).toContain('Imported ref text.');

    canUserEditBook.mockResolvedValue(false);
    dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(dom.querySelector('.ref-check-source')).toBeNull();
    expect(dom.textContent).toContain('Imported ref text.');
  });

  it('matched: title-linked citation + "Citation verified" pill; title → readable full-text', async () => {
    canUserEditBook.mockResolvedValue(true);
    resolveBibliographyTarget.mockResolvedValue({ type: 'citation-card', metadata: COX_META });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c1' })]); // auto match

    const dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    // Title is a hyperlink to the readable full-text (oa_url), not the imported text.
    const titleLink = dom.querySelector('blockquote a');
    expect(titleLink.getAttribute('href')).toBe('https://socialistregister.com/download/5594/2492');
    expect(dom.textContent).not.toContain('Imported ref text.');
    // Provenance pill + owner Check source.
    expect(dom.querySelector('.source-cat-pill[data-cat="verified"]').textContent).toContain('Citation verified');
    expect(dom.querySelector('.ref-check-source')).toBeTruthy();
    // The explanation (hidden) names the method + the provenance record link.
    const detail = dom.querySelector('.source-cat-detail[data-cat="verified"]');
    expect(detail.getAttribute('style')).toContain('display: none');
    expect(detail.textContent).toContain('Matched automatically');
    expect(detail.innerHTML).toContain('https://openalex.org/W123');
  });

  it('matched + user_verified → explanation says confirmed by the author', async () => {
    canUserEditBook.mockResolvedValue(true);
    resolveBibliographyTarget.mockResolvedValue({ type: 'citation-card', metadata: COX_META });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c1', reference_match_method: 'user_verified' })]);

    const detail = parse(await buildCitationContent({ referenceId: 'Ref1' })).querySelector('.source-cat-detail');
    expect(detail.textContent).toContain("Confirmed by the book's author");
  });

  it('reader sees the matched citation + pill but NO Check source', async () => {
    canUserEditBook.mockResolvedValue(false);
    resolveBibliographyTarget.mockResolvedValue({ type: 'citation-card', metadata: COX_META });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c1' })]);

    const dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(dom.querySelector('.source-cat-pill')).toBeTruthy();
    expect(dom.querySelector('.ref-check-source')).toBeNull();
  });

  it('clicking the pill expands its explanation (reused wireSourceStatus)', async () => {
    canUserEditBook.mockResolvedValue(false);
    resolveBibliographyTarget.mockResolvedValue({ type: 'citation-card', metadata: COX_META });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c1' })]);

    document.body.innerHTML = `<div id="hyperlit-container" class="open">${await buildCitationContent({ referenceId: 'Ref1' })}</div>`;
    const container = document.getElementById('hyperlit-container');
    wireReferenceVerifyButtons(container);

    const pill = container.querySelector('.source-cat-pill[data-cat="verified"]');
    const detail = container.querySelector('.source-cat-detail[data-cat="verified"]');
    expect(detail.style.display).toBe('none');
    pill.click();
    expect(detail.style.display).toBe('block');
    expect(pill.getAttribute('aria-expanded')).toBe('true');
  });

  it('Check source (owner) → lookup → pick → re-renders to a matched title-linked citation', async () => {
    lookupReference.mockResolvedValue({ success: true, status: 'linked_new', method: 'x', score: 0.9,
      candidate: { title: "'Real Socialism' in Historical Perspective", author: 'Robert W. Cox', year: 1991, oa_url: 'https://socialistregister.com/download/5594/2492', openalex_id: 'W123', type: 'journal-article' },
      alternates: [], alreadyLinked: false, current: null });
    approveReference.mockResolvedValue({ success: true, canonical_source_id: 'c1', reference_match_method: 'user_verified' });

    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <div class="citations-section">
          <blockquote>Imported ref text.</blockquote>
          <div class="ref-source-status" data-ref-id="Ref1" data-book="bookA" data-canonical="" data-owner="1">
            <button type="button" class="ref-check-source">Check source</button>
            <div class="ref-source-mount"></div>
          </div>
        </div>
      </div>`;
    const container = document.getElementById('hyperlit-container');
    wireReferenceVerifyButtons(container);

    container.querySelector('.ref-check-source').click();
    await flush();
    const pick = container.querySelector('.source-match-select');
    expect(pick).toBeTruthy();
    pick.click();
    await flush();

    expect(approveReference).toHaveBeenCalledWith('bookA', 'Ref1', expect.objectContaining({ openalex_id: 'W123' }));
    // Blockquote now shows the title-linked canonical citation + a "Citation verified" pill.
    expect(container.querySelector('blockquote a').getAttribute('href')).toBe('https://socialistregister.com/download/5594/2492');
    expect(container.querySelector('.source-cat-pill[data-cat="verified"]')).toBeTruthy();
  });

  it('dedupes the same work surfaced by two providers into one row', async () => {
    lookupReference.mockResolvedValue({ success: true, status: 'linked_new', method: 'x', score: 0.89,
      candidate: { title: 'The Darker Nations', year: 2007, openalex_id: 'W1', match_score: 0.89 },
      alternates: [{ title: 'The Darker Nations', year: 2007, open_library_key: '/works/OL1W', match_score: 0.89 }],
      alreadyLinked: false, current: null });

    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <div class="citations-section"><blockquote>x</blockquote>
          <div class="ref-source-status" data-ref-id="Ref1" data-book="bookA" data-canonical="" data-owner="1">
            <button type="button" class="ref-check-source">Check source</button>
            <div class="ref-source-mount"></div>
          </div>
        </div>
      </div>`;
    const container = document.getElementById('hyperlit-container');
    wireReferenceVerifyButtons(container);
    container.querySelector('.ref-check-source').click();
    await flush();
    expect(container.querySelectorAll('.source-match-select').length).toBe(1);
  });
});
