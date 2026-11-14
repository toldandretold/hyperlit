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
  mountFootnoteSources,
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
// The click handler does dynamic import()s (referenceVerify + prompt) before rendering. A FIXED
// tick count races module-load latency under full-suite CPU contention (the one-in-N-runs flake:
// "dedupes the same work" failed when 8 ticks weren't enough on a loaded worker). Wait for the
// expected DOM instead — generous budget, exits as soon as the condition holds; a never-true
// condition falls through to the test's own assertion for a clear failure.
const flush = async (until = null, ticks = 400) => {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (until ? until() : i >= 7) return;
  }
};

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

  it('matched + a held Hyperlit version: title links to it', async () => {
    // Regression: the title url was the root-relative "/book_…", which the formatter rejected as
    // non-http, so a verified reference we HOLD rendered with no link anywhere.
    resolveBibliographyTarget.mockResolvedValue({ type: 'library', book: 'book_999', has_nodes: true, metadata: { ...COX_META, doi: '10.1177/0305829819873030' } });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c-1', reference_match_method: 'auto' })]);

    const dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    const titleLink = dom.querySelector('blockquote a');
    expect(titleLink.getAttribute('href')).toBe('/book_999');
    expect(titleLink.hasAttribute('target')).toBe(false); // in-app: same tab

    // A version with a slug links by it, not by its raw id.
    resolveBibliographyTarget.mockResolvedValue({ type: 'library', book: 'b75d82b6-dc45-48ad-8e7f-b5295cffb3ec', slug: 'imperial-dialectics-2019', has_nodes: true, metadata: COX_META });
    const slugged = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(slugged.querySelector('blockquote a').getAttribute('href')).toBe('/imperial-dialectics-2019');
  });

  it('matched, no held version: title links to the DOI', async () => {
    resolveBibliographyTarget.mockResolvedValue({ type: 'citation-card', metadata: { ...COX_META, doi: '10.1177/0305829819873030' } });
    await seedStore('bibliography', [bib('Ref1', { canonical_source_id: 'c-1', reference_match_method: 'auto' })]);

    const dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(dom.querySelector('blockquote a').getAttribute('href')).toBe('https://doi.org/10.1177/0305829819873030');
  });

  it('matched to a WEB page (no canonical): imported text kept, plus a link to the original page', async () => {
    // Prod 2026-11-14: a scanned book's first references were reports/web pages and showed nothing.
    await seedStore('bibliography', [bib('Ref1', {
      source_id: 'web_abc', source_is_web_stub: true, source_has_nodes: false,
      source_external_url: 'https://www.resilience.org/stories/2021-10-28/global-climate-wall/',
    })]);

    const dom = parse(await buildCitationContent({ referenceId: 'Ref1' }));
    expect(dom.textContent).toContain('Imported ref text.');
    const link = dom.querySelector('.citation-web-source a');
    expect(link.getAttribute('href')).toBe('https://www.resilience.org/stories/2021-10-28/global-climate-wall/');
    expect(link.textContent).toContain('resilience.org');
    expect(dom.querySelector('.source-cat-pill')).toBeNull(); // a web page is not a bibliographic match
    expect(dom.querySelector('.citation-source-link')).toBeNull(); // never the private stub itself
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
    await flush(() => container.querySelector('.source-match-select'));
    const pick = container.querySelector('.source-match-select');
    expect(pick).toBeTruthy();
    pick.click();
    await flush(() => container.querySelector('.source-cat-pill[data-cat="verified"]'));

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
    await flush(() => container.querySelector('.source-match-select'));
    expect(container.querySelectorAll('.source-match-select').length).toBe(1);
  });
  describe('footnote sources — the matched card under a citation footnote', () => {
    const section = () => {
      document.body.innerHTML = '<div class="footnotes-section"><div class="footnote-content"></div><hr></div>';
      return document.querySelector('.footnotes-section');
    };

    it('mounts one card per matched work before the rule: held → our version, else DOI; no Check source', async () => {
      resolveBibliographyTarget.mockImplementation(async ({ canonical_source_id }) => canonical_source_id === 'c-held'
        ? { type: 'library', book: 'uuid-1', slug: 'held-work-2019', has_nodes: true, metadata: COX_META }
        : { type: 'citation-card', metadata: { ...COX_META, title: 'Other Work', doi: '10.1177/0305829819873030' } });
      const el = section();

      // Both shapes: the object form, and the bare-id form a browser may still hold. Plus a cited web page.
      await mountFootnoteSources(el, [
        { canonical_source_id: 'c-held' }, 'c-doi', 'c-held',
        { url: 'https://www.colorlines.com/article/x/', title: 'The color of violence <b>' },
        { url: 'javascript:alert(1)', title: 'nope' },
      ], 'Fn1', 'bookA');

      const links = [...el.querySelectorAll('.footnote-sources blockquote a')].map((a) => a.getAttribute('href'));
      expect(links).toEqual(['/held-work-2019', 'https://doi.org/10.1177/0305829819873030', 'https://www.colorlines.com/article/x/']); // deduped, unsafe url dropped
      const web = el.querySelector('.footnote-source[data-kind="web"]');
      expect(web.querySelector('a').textContent).toBe('The color of violence <b>'); // escaped, not parsed
      expect(web.textContent).toContain('colorlines.com');
      expect(web.querySelector('.source-cat-pill')).toBeNull(); // a web page is not a 'verified' match
      expect(el.querySelector('.footnote-sources h3').textContent).toBe('Sources');
      expect(el.querySelectorAll('.source-cat-pill').length).toBe(2);
      expect(el.querySelector('.ref-check-source')).toBeNull();
      expect(el.lastElementChild.tagName).toBe('HR'); // inserted BEFORE the closing rule
      expect(el.querySelector('.footnote-sources').getAttribute('contenteditable')).toBe('false');

      // The pill expands its explanation.
      const pill = el.querySelector('.source-cat-pill');
      pill.click();
      expect(pill.getAttribute('aria-expanded')).toBe('true');

      // Idempotent.
      await mountFootnoteSources(el, ['c-held'], 'Fn1', 'bookA');
      expect(el.querySelectorAll('.footnote-sources').length).toBe(1);
    });

    it('leaves the footnote untouched when nothing resolves or there are no sources', async () => {
      resolveBibliographyTarget.mockResolvedValue(null);
      const el = section();
      await mountFootnoteSources(el, ['c-gone'], 'Fn1', 'bookA');
      await mountFootnoteSources(el, [], 'Fn1', 'bookA');
      await mountFootnoteSources(el, null, 'Fn1', 'bookA');
      expect(el.querySelector('.footnote-sources')).toBeNull();
    });
  });
});
