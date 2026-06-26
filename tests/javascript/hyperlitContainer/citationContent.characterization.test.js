/**
 * Characterization net for displayCitations.ts — pinned BEFORE the displayCitations.ts →
 * displayCitations/ folder split, so the refactor is provably behaviour-preserving. Imports via
 * the stable barrel specifier `…/contentBuilders/displayCitations` (resolves to the monolith file
 * now, the folder index.ts after) so this file never changes across the split.
 *
 * Covers all four exports: buildCitationContent (plain reference cards) + resolveCitationButtonStatus,
 * and buildHyperciteCitationContent (inbound hypercite citations) + resolveButtonStatus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const actual = await vi.importActual('../../../resources/js/indexedDB/index');
  return { ...actual };
});
vi.mock('../../../resources/js/indexedDB/bibliography/index', () => ({ resolveBibliographyTarget: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../resources/js/indexedDB/hypercites/index', () => ({ getHyperciteFromIndexedDB: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({ formatBibtexToCitation: vi.fn(async (b) => `CITE(${b})`) }));
vi.mock('../../../resources/js/utilities/auth/index', () => ({ canUserEditBook: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/utils', () => ({ fetchLibraryFromServer: vi.fn().mockResolvedValue(null) }));

import {
  buildCitationContent,
  buildHyperciteCitationContent,
  resolveButtonStatus,
  resolveCitationButtonStatus,
} from '../../../resources/js/hyperlitContainer/contentBuilders/displayCitations';
import { getHyperciteFromIndexedDB } from '../../../resources/js/indexedDB/hypercites/index';
import { canUserEditBook } from '../../../resources/js/utilities/auth/index';
import { fetchLibraryFromServer } from '../../../resources/js/hyperlitContainer/utils';

function parse(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}
const bib = (referenceId, extra = {}) => ({ book: 'bookA', referenceId, content: 'Ref text.', ...extra });

describe('displayCitations (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    document.body.innerHTML = '';
    getHyperciteFromIndexedDB.mockResolvedValue(null);
    fetchLibraryFromServer.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  // ---- buildCitationContent (plain reference cards) ----

  it('no referenceId → empty string', async () => {
    expect(await buildCitationContent({})).toBe('');
  });

  it('reference not found → "Reference not found" error section', async () => {
    const html = await buildCitationContent({ referenceId: 'RefMissing' });
    expect(html).toContain('Reference not found');
  });

  it('source_id + PUBLIC library → enabled "Open source" button (no pending check)', async () => {
    await seedStore('bibliography', [bib('Ref1', { source_id: 'srcbook' })]);
    await seedStore('library', [{ book: 'srcbook', visibility: 'public' }]);

    const html = await buildCitationContent({ referenceId: 'Ref1' });
    const link = parse(html).querySelector('.citation-source-link');
    expect(link).toBeTruthy();
    expect(link.getAttribute('data-needs-citation-check')).toBeNull();
    expect(html).toContain('Open source');
  });

  it('source_id + PRIVATE local library → muted pending button with data-visibility="private"', async () => {
    await seedStore('bibliography', [bib('Ref1', { source_id: 'srcbook' })]);
    await seedStore('library', [{ book: 'srcbook', visibility: 'private' }]);

    const link = parse(await buildCitationContent({ referenceId: 'Ref1' })).querySelector('.citation-source-link');
    expect(link.getAttribute('data-needs-citation-check')).toBe('true');
    expect(link.getAttribute('data-visibility')).toBe('private');
    expect(link.getAttribute('data-book-id')).toBe('srcbook');
  });

  it('source_id external (no local library) → muted pending button, visibility resolved post-open', async () => {
    await seedStore('bibliography', [bib('Ref1', { source_id: 'externalbook' })]);

    const link = parse(await buildCitationContent({ referenceId: 'Ref1' })).querySelector('.citation-source-link');
    expect(link.getAttribute('data-needs-citation-check')).toBe('true');
    expect(link.getAttribute('data-book-id')).toBe('externalbook');
    expect(link.getAttribute('data-visibility')).toBeNull(); // unknown → resolver fetches
  });

  it('source_id + DELETED library → "Source deleted", trash icon by the citation, click-blocked', async () => {
    await seedStore('bibliography', [bib('Ref1', { source_id: 'srcbook' })]);
    await seedStore('library', [{ book: 'srcbook', visibility: 'deleted' }]);

    const html = await buildCitationContent({ referenceId: 'Ref1' });
    const dom = parse(html);
    expect(html).toContain('Source deleted');
    expect(dom.querySelector('blockquote .deleted-icon')).toBeTruthy();
    const link = dom.querySelector('.citation-source-link');
    expect(link.getAttribute('style')).toContain('pointer-events: none');
  });

  // ---- resolveCitationButtonStatus (post-open) ----

  it('resolveCitationButtonStatus: private + no access → locks button + lock icon by citation', async () => {
    canUserEditBook.mockResolvedValue(false);
    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <div class="citations-section">
          <blockquote>Ref text.</blockquote>
          <div class="citation-navigation">
            <a class="citation-source-link" data-needs-citation-check="true" data-book-id="srcbook" data-visibility="private"
               style="opacity: 0.5; pointer-events: none;">Open source<span class="btn-spinner"></span></a>
          </div>
        </div>
      </div>`;
    const container = document.getElementById('hyperlit-container');

    await resolveCitationButtonStatus({}, null, container);

    const link = container.querySelector('.citation-source-link');
    expect(link.getAttribute('data-access')).toBe('denied');
    expect(link.querySelector('.btn-spinner')).toBeNull();
    expect(container.querySelector('.citations-section blockquote .private-lock-icon')).toBeTruthy();
  });

  it('resolveCitationButtonStatus: public → enables the button', async () => {
    fetchLibraryFromServer.mockResolvedValue({ visibility: 'public' });
    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <div class="citations-section">
          <blockquote>Ref text.</blockquote>
          <div class="citation-navigation">
            <a class="citation-source-link" data-needs-citation-check="true" data-book-id="externalbook"
               style="opacity: 0.5; pointer-events: none;">Open source<span class="btn-spinner"></span></a>
          </div>
        </div>
      </div>`;
    const container = document.getElementById('hyperlit-container');

    await resolveCitationButtonStatus({}, null, container);

    const link = container.querySelector('.citation-source-link');
    expect(link.hasAttribute('data-needs-citation-check')).toBe(false);
    expect(link.querySelector('.btn-spinner')).toBeNull();
    expect(link.getAttribute('data-access')).toBeNull(); // not denied
  });

  // ---- buildHyperciteCitationContent (inbound hypercite citations) ----

  it('hypercite-citation public with bibtex → "See in source text" + formatted citation', async () => {
    await seedStore('library', [{ book: 'targetbook', visibility: 'public', bibtex: 'BIB' }]);
    const html = await buildHyperciteCitationContent({ targetBook: 'targetbook', targetHyperciteId: 'hypercite_1', targetUrl: '/targetbook#hypercite_1' });
    expect(html).toContain('See in source text');
    expect(html).toContain('CITE(BIB)');
    expect(parse(html).querySelector('.see-in-source-btn')).toBeTruthy();
  });

  it('hypercite-citation PRIVATE → lock icon + muted see-in-source-btn pending access check', async () => {
    await seedStore('library', [{ book: 'targetbook', visibility: 'private', bibtex: 'BIB' }]);
    const html = await buildHyperciteCitationContent({ targetBook: 'targetbook', targetHyperciteId: 'hypercite_1', targetUrl: '/x' });
    const dom = parse(html);
    expect(dom.querySelector('.private-lock-icon')).toBeTruthy();
    const btn = dom.querySelector('.see-in-source-btn');
    expect(btn.getAttribute('data-needs-access-check')).toBe('true');
    expect(btn.getAttribute('data-private')).toBe('true');
  });

  it('hypercite-citation DELETED → "source deleted" + trash icon', async () => {
    await seedStore('library', [{ book: 'targetbook', visibility: 'deleted', bibtex: 'BIB' }]);
    const html = await buildHyperciteCitationContent({ targetBook: 'targetbook', targetHyperciteId: 'hypercite_1', targetUrl: '/x' });
    expect(html).toContain('source deleted');
    expect(parse(html).querySelector('.deleted-icon')).toBeTruthy();
  });

  it('hypercite-citation GHOST → "View ghost in source" + cited-text-deleted notice', async () => {
    await seedStore('library', [{ book: 'targetbook', visibility: 'public', bibtex: 'BIB' }]);
    getHyperciteFromIndexedDB.mockResolvedValue({ relationshipStatus: 'ghost', hypercitedText: 'gone' });
    const html = await buildHyperciteCitationContent({ targetBook: 'targetbook', targetHyperciteId: 'hypercite_1', targetUrl: '/x' });
    expect(html).toContain('View ghost in source');
    expect(html).toContain('Cited text deleted');
  });

  // ---- resolveButtonStatus (post-open, hypercite-citation) ----

  it('resolveButtonStatus: has access → enables; no access → denied text', async () => {
    canUserEditBook.mockResolvedValue(true);
    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <a class="see-in-source-btn" data-private="true" data-book-id="targetbook" data-needs-access-check="true"
           style="opacity: 0.5; pointer-events: none;">See in source text<span class="btn-spinner"></span></a>
      </div>`;
    let container = document.getElementById('hyperlit-container');
    await resolveButtonStatus({ targetBook: 'targetbook', targetHyperciteId: 'h' }, null, container);
    let btn = container.querySelector('.see-in-source-btn');
    expect(btn.hasAttribute('data-needs-access-check')).toBe(false);
    expect(btn.querySelector('.btn-spinner')).toBeNull();

    canUserEditBook.mockResolvedValue(false);
    document.body.innerHTML = `
      <div id="hyperlit-container" class="open">
        <a class="see-in-source-btn" data-private="true" data-book-id="targetbook" data-needs-access-check="true"
           style="opacity: 0.5; pointer-events: none;">See in source text<span class="btn-spinner"></span></a>
      </div>`;
    container = document.getElementById('hyperlit-container');
    await resolveButtonStatus({ targetBook: 'targetbook', targetHyperciteId: 'h' }, null, container);
    btn = container.querySelector('.see-in-source-btn');
    expect(btn.getAttribute('data-access')).toBe('denied');
    expect(btn.textContent).toContain('source text private');
  });
});
