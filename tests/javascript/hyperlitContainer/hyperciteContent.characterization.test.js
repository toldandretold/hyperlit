/**
 * Characterization net for buildHyperciteContent (the "Cited By" panel) — pinned BEFORE the
 * displayHypercites.ts → displayHypercites/ folder split so the refactor is provably
 * behaviour-preserving. Imports via the stable barrel specifier `…/contentBuilders/displayHypercites`
 * (resolves to the monolith file now, the folder index.ts after) so this file never changes.
 *
 * Pins: single/not-found states; the Cited-By section + per-citation blockquote/.citation-link
 * with data-content-id; the .hypercite-management-buttons placeholder data-* (which implicitly
 * pins citedIN-link parsing → bookID/contentType/contentItemId/subBookId); the private-book lock
 * icon + data-private; and the bibtex-missing fallback text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));

vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await vi.importActual('../../../resources/js/indexedDB/core/connection');
  return {
    openDatabase: conn.openDatabase,
    queueForSync: vi.fn(),
    debouncedMasterSync: { flush: vi.fn().mockResolvedValue(undefined) },
    updateBookTimestamp: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('dompurify', () => ({ default: { sanitize: (s) => s } }));
vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({
  formatBibtexToCitation: vi.fn(async (b) => b),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({ canUserEditBook: vi.fn() }));
vi.mock('../../../resources/js/components/toast/toast', () => ({ showTargetNotFoundToast: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/utils', () => ({
  fetchLibraryFromServer: vi.fn().mockResolvedValue(null),
}));

import { buildHyperciteContent } from '../../../resources/js/hyperlitContainer/contentBuilders/displayHypercites';
import { showTargetNotFoundToast } from '../../../resources/js/components/toast/toast';
import { fetchLibraryFromServer } from '../../../resources/js/hyperlitContainer/utils';

function parse(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('buildHyperciteContent (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    fetchLibraryFromServer.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it('relationshipStatus "single" → the not-cited-elsewhere section, no DB query', async () => {
    const html = await buildHyperciteContent({ hyperciteId: 'hypercite_1', relationshipStatus: 'single' });
    expect(html).toContain('hypercites-section');
    expect(html).toContain('single hypercite');
  });

  it('no hypercite data found → error section + showTargetNotFoundToast', async () => {
    const html = await buildHyperciteContent({ hyperciteIds: ['hypercite_missing'], relationshipStatus: 'couple' });
    expect(html).toContain('Hypercite data not found');
    expect(showTargetNotFoundToast).toHaveBeenCalled();
  });

  it('cited-by with bibtex (public) → Cited By section, citation-link, management placeholder data-*', async () => {
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_1', hypercitedText: 't',
      citedIN: ['/craftingbook#hypercite_x'], relationshipStatus: 'couple', node_id: [],
    }]);
    await seedStore('library', [{ book: 'craftingbook', bibtex: 'BIBTEX_CRAFT', visibility: 'public' }]);

    const html = await buildHyperciteContent({ hyperciteId: 'hypercite_1', hyperciteIds: ['hypercite_1'], relationshipStatus: 'couple' });
    const dom = parse(html);

    expect(html).toContain('Cited By');
    expect(html).toContain('BIBTEX_CRAFT'); // formatBibtexToCitation passthrough

    const link = dom.querySelector('.citation-link');
    expect(link).toBeTruthy();
    expect(link.getAttribute('data-content-id')).toBe('hypercite_1');

    const mgmt = dom.querySelector('.hypercite-management-buttons');
    expect(mgmt).toBeTruthy();
    expect(mgmt.getAttribute('data-book-id')).toBe('craftingbook');
    expect(mgmt.getAttribute('data-content-type')).toBe('node');
    expect(mgmt.getAttribute('data-hypercite-id')).toBe('hypercite_x');
    expect(mgmt.getAttribute('data-source-hypercite-id')).toBe('hypercite_1');
  });

  it('footnote/hyperlight citedIN URL → parsed contentType + contentItemId + subBookId on the placeholder', async () => {
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_1', hypercitedText: 't',
      citedIN: ['/craftingbook/Fn12_ab/HL_zz#hypercite_y'], relationshipStatus: 'couple', node_id: [],
    }]);
    await seedStore('library', [{ book: 'craftingbook', bibtex: 'B', visibility: 'public' }]);

    const html = await buildHyperciteContent({ hyperciteId: 'hypercite_1', hyperciteIds: ['hypercite_1'], relationshipStatus: 'couple' });
    const mgmt = parse(html).querySelector('.hypercite-management-buttons');

    expect(mgmt.getAttribute('data-book-id')).toBe('craftingbook');
    expect(mgmt.getAttribute('data-content-type')).toBe('hyperlight');
    expect(mgmt.getAttribute('data-content-item-id')).toBe('HL_zz');
    expect(mgmt.getAttribute('data-sub-book-id')).toBe('craftingbook/Fn12_ab/HL_zz');
  });

  it('private source book → red lock icon + data-private/data-book-id on the link', async () => {
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_1', hypercitedText: 't',
      citedIN: ['/secretbook#hypercite_x'], relationshipStatus: 'couple', node_id: [],
    }]);
    await seedStore('library', [{ book: 'secretbook', bibtex: 'B', visibility: 'private' }]);

    const html = await buildHyperciteContent({ hyperciteId: 'hypercite_1', hyperciteIds: ['hypercite_1'], relationshipStatus: 'couple' });
    const dom = parse(html);

    expect(dom.querySelector('.private-lock-icon')).toBeTruthy();
    const link = dom.querySelector('.citation-link');
    expect(link.getAttribute('data-private')).toBe('true');
    expect(link.getAttribute('data-book-id')).toBe('secretbook');
  });

  it('bibtex missing (no local library, server null) → graceful fallback shows the bookID', async () => {
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_1', hypercitedText: 't',
      citedIN: ['/ghostbook#hypercite_z'], relationshipStatus: 'couple', node_id: [],
    }]);
    fetchLibraryFromServer.mockResolvedValue(null);

    const html = await buildHyperciteContent({ hyperciteId: 'hypercite_1', hyperciteIds: ['hypercite_1'], relationshipStatus: 'couple' });
    const dom = parse(html);

    expect(html).toContain('ghostbook');
    expect(dom.querySelector('.citation-link')).toBeTruthy();
  });
});
