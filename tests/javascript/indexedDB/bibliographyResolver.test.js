/**
 * resolveBibliographyTarget — the click-time resolver used by the citation
 * container to pick the right navigation target for a bibliography record.
 *
 * Locks the contract:
 *   - canonical_source_id present + server has version → { type: 'library', book }
 *   - canonical_source_id present + server has no version → { type: 'citation-card', metadata }
 *   - canonical_source_id present + server errors → fall back to source_id
 *   - canonical_source_id missing + source_id present → { type: 'library', book: source_id }
 *   - both absent → null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveBibliographyTarget } from '../../../resources/js/indexedDB/bibliography/index';

describe('resolveBibliographyTarget', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for null/empty input', async () => {
    expect(await resolveBibliographyTarget(null)).toBeNull();
    expect(await resolveBibliographyTarget({})).toBeNull();
  });

  it('falls back to source_id when no canonical_source_id', async () => {
    const result = await resolveBibliographyTarget({
      source_id: 'book_abc_123',
      source_has_nodes: true,
    });

    expect(result).toEqual({
      type: 'library',
      book: 'book_abc_123',
      has_nodes: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('respects source_has_nodes=false on source_id fallback', async () => {
    const result = await resolveBibliographyTarget({
      source_id: 'book_abc_123',
      source_has_nodes: false,
    });

    expect(result.has_nodes).toBe(false);
  });

  it('treats missing source_has_nodes as true (backward compat)', async () => {
    const result = await resolveBibliographyTarget({
      source_id: 'book_legacy',
    });

    expect(result.has_nodes).toBe(true);
  });

  it('resolves canonical to library when server has version', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        book: 'book_canonical_winner',
        has_version: true,
        metadata: { title: 'Test' },
      }),
    });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '11111111-1111-1111-1111-111111111111',
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/canonical/11111111-1111-1111-1111-111111111111/best-version',
      expect.objectContaining({ credentials: 'same-origin' })
    );
    expect(result).toEqual({
      type: 'library',
      book: 'book_canonical_winner',
      has_nodes: true,
      metadata: { title: 'Test' },
    });
  });

  it('returns citation-card when canonical has no version', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        book: null,
        has_version: false,
        metadata: { title: 'Only a citation', doi: '10.x/y' },
      }),
    });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '22222222-2222-2222-2222-222222222222',
    });

    expect(result).toEqual({
      type: 'citation-card',
      canonical_source_id: '22222222-2222-2222-2222-222222222222',
      metadata: { title: 'Only a citation', doi: '10.x/y' },
    });
  });

  it('surfaces source_url metadata for a web-only canonical (stub excluded → citation-card)', async () => {
    // With web stubs suppressed server-side, a web-only canonical returns book:null + a source_url
    // to link OUT to the original (e.g. progressive.international).
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        book: null,
        has_version: false,
        metadata: { title: 'Havana Declaration', source_url: 'https://progressive.international/havana' },
      }),
    });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '33333333-3333-3333-3333-333333333333',
    });

    expect(result.type).toBe('citation-card');
    expect(result.metadata.source_url).toBe('https://progressive.international/havana');
  });

  it('falls back to source_id when canonical lookup returns 404', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '33333333-3333-3333-3333-333333333333',
      source_id: 'book_fallback',
      source_has_nodes: true,
    });

    expect(result).toEqual({
      type: 'library',
      book: 'book_fallback',
      has_nodes: true,
    });
  });

  it('falls back to source_id when fetch throws (network error)', async () => {
    fetch.mockRejectedValueOnce(new Error('network down'));

    const result = await resolveBibliographyTarget({
      canonical_source_id: '44444444-4444-4444-4444-444444444444',
      source_id: 'book_offline_fallback',
    });

    expect(result.type).toBe('library');
    expect(result.book).toBe('book_offline_fallback');
  });

  it('returns null when canonical resolution fails and no source_id', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '55555555-5555-5555-5555-555555555555',
    });

    expect(result).toBeNull();
  });

  it('canonical-source-id always wins over source_id when both present', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ book: 'book_from_canonical', has_version: true, metadata: {} }),
    });

    const result = await resolveBibliographyTarget({
      canonical_source_id: '66666666-6666-6666-6666-666666666666',
      source_id: 'book_legacy_pointer',
    });

    expect(result.book).toBe('book_from_canonical');
  });
});
