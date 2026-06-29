/**
 * sourceVerify module — the HTTP contract of the [check source] engine. lookupSource and
 * verifySource POST to the source-verification endpoints; verifySource sends only the identifier
 * (the server re-resolves) and, on success, mirrors the returned fields into IndexedDB.
 * The IDB write is exercised lightly (openDatabase mocked) — its merge is simple put logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// openDatabase is mocked to reject so the (non-fatal, try/caught) IDB merge is skipped —
// these tests assert the HTTP contract, not the IndexedDB schema.
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: () => Promise.reject(new Error('no idb in test')),
}));

import { lookupSource } from '../../../resources/js/sourceVerify/lookup';
import { verifySource, identifierOf } from '../../../resources/js/sourceVerify/verify';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lookupSource', () => {
  it('POSTs to the lookup endpoint and returns the parsed preview', async () => {
    const preview = {
      success: true, status: 'linked_new', method: 'openalex_doi', score: 0.9,
      candidate: { title: 'Found', openalex_id: 'W1' }, alternates: [], alreadyLinked: false, current: null,
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => preview });
    vi.stubGlobal('fetch', fetchMock);

    const res = await lookupSource('book-1');

    expect(res.success).toBe(true);
    expect(res.candidate.title).toBe('Found');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/book-1/source/lookup',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('returns an error result on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) }));
    const res = await lookupSource('book-1');
    expect(res.success).toBe(false);
    expect(res.candidate).toBeNull();
    expect(res.message).toBe('Forbidden');
  });
});

describe('identifierOf', () => {
  it('extracts only the present identifier fields', () => {
    expect(identifierOf({ openalex_id: 'W1', doi: '10.1/x', title: 'ignored' }))
      .toEqual({ openalex_id: 'W1', doi: '10.1/x' });
    expect(identifierOf({ open_library_key: '/works/OL1W' })).toEqual({ open_library_key: '/works/OL1W' });
  });
});

describe('verifySource', () => {
  it('sends only the identifier and returns the verify result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: true, canonical_source_id: 'c1', library: { title: 'Found' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await verifySource('book-1', { openalex_id: 'W1', doi: '10.1/x', title: 'Found' });

    expect(res.success).toBe(true);
    expect(res.canonical_source_id).toBe('c1');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.identifier).toEqual({ openalex_id: 'W1', doi: '10.1/x' });
  });

  it('returns an error result on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: 'Could not re-resolve' }) }));
    const res = await verifySource('book-1', { openalex_id: 'W1' });
    expect(res.success).toBe(false);
    expect(res.message).toBe('Could not re-resolve');
  });
});
