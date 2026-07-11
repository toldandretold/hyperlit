/**
 * referenceVerify — the reference-level (bibliography) confirm/reject POSTs from the citation card.
 * Locks: the endpoint URL shape (owner-gated /library/{book}/reference/{refId}/source/{verify,reject}),
 * the CSRF header, the canonical_source_id stale-guard body on verify, and the local IDB bibliography
 * merge of the persisted decision. The fetch + IDB are the real fake-indexeddb harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';
import { openDatabase } from '../../../resources/js/indexedDB/index';
import { verifyReference, rejectReference, lookupReference, approveReference, candidateExternalUrl } from '../../../resources/js/sourceVerify/referenceVerify';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

async function readBib(book, referenceId) {
  const db = await openDatabase();
  return new Promise((resolve) => {
    const req = db.transaction('bibliography', 'readonly').objectStore('bibliography').get([book, referenceId]);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

describe('referenceVerify', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('verifyReference POSTs to the reference verify endpoint with CSRF + canonical guard, merges IDB', async () => {
    await seedStore('bibliography', [{ book: 'bookA', referenceId: 'Ref1', content: 'x', canonical_source_id: 'c1' }]);
    fetch.mockResolvedValueOnce(okJson({ success: true, reference_match_method: 'user_verified' }));

    const res = await verifyReference('bookA', 'Ref1', 'c1');
    expect(res.success).toBe(true);

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/library/bookA/reference/Ref1/source/verify');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-CSRF-TOKEN']).toBe('test-csrf');
    expect(JSON.parse(opts.body)).toEqual({ canonical_source_id: 'c1' });

    // Persisted decision mirrored into local IDB so a re-open reflects it.
    expect((await readBib('bookA', 'Ref1')).reference_match_method).toBe('user_verified');
  });

  it('rejectReference POSTs to the reject endpoint and stamps user_rejected in IDB', async () => {
    await seedStore('bibliography', [{ book: 'bookA', referenceId: 'Ref1', content: 'x', canonical_source_id: 'c1' }]);
    fetch.mockResolvedValueOnce(okJson({ success: true, reference_match_method: 'user_rejected' }));

    await rejectReference('bookA', 'Ref1');

    expect(fetch.mock.calls[0][0]).toBe('/api/library/bookA/reference/Ref1/source/reject');
    expect((await readBib('bookA', 'Ref1')).reference_match_method).toBe('user_rejected');
  });

  it('does not merge IDB when the server rejects the request', async () => {
    await seedStore('bibliography', [{ book: 'bookA', referenceId: 'Ref1', content: 'x', canonical_source_id: 'c1' }]);
    fetch.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ success: false, message: 'No canonical match to verify' }) });

    const res = await verifyReference('bookA', 'Ref1', 'c1');
    expect(res.success).toBe(false);
    expect((await readBib('bookA', 'Ref1')).reference_match_method).toBeUndefined();
  });

  it('encodes book + refId in the URL path', async () => {
    fetch.mockResolvedValueOnce(okJson({ success: true }));
    await verifyReference('book/A', 'Ref 1', null);
    expect(fetch.mock.calls[0][0]).toBe('/api/library/book%2FA/reference/Ref%201/source/verify');
    // No canonical → empty body (no stale guard).
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
  });

  it('lookupReference POSTs to the read-only lookup endpoint and returns the preview', async () => {
    fetch.mockResolvedValueOnce(okJson({ success: true, status: 'linked_new', candidate: { title: 'X', openalex_id: 'W1' }, alternates: [] }));

    const res = await lookupReference('bookA', 'Ref1');
    expect(fetch.mock.calls[0][0]).toBe('/api/library/bookA/reference/Ref1/source/lookup');
    expect(fetch.mock.calls[0][1].headers['X-CSRF-TOKEN']).toBe('test-csrf');
    expect(res.candidate.openalex_id).toBe('W1');
  });

  it('approveReference sends the candidate identifier, sets canonical_source_id + verified in IDB', async () => {
    await seedStore('bibliography', [{ book: 'bookA', referenceId: 'Ref1', content: 'x' }]); // unmatched
    fetch.mockResolvedValueOnce(okJson({ success: true, canonical_source_id: 'c9', reference_match_method: 'user_verified' }));

    const res = await approveReference('bookA', 'Ref1', { title: 'X', openalex_id: 'W1', doi: '10.1/x' });
    expect(res.success).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('/api/library/bookA/reference/Ref1/source/verify');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ identifier: { openalex_id: 'W1', doi: '10.1/x' } });

    const row = await readBib('bookA', 'Ref1');
    expect(row.reference_match_method).toBe('user_verified');
    expect(row.canonical_source_id).toBe('c9'); // newly linked canonical persisted locally
  });

  it('candidateExternalUrl prefers readable full-text (OA/PDF) → DOI → OpenAlex/OL record', () => {
    // Full-text wins over the metadata record (the socialistregister-download case).
    expect(candidateExternalUrl({ oa_url: 'https://x.org/download/1', openalex_id: 'W1' })).toBe('https://x.org/download/1');
    expect(candidateExternalUrl({ pdf_url: 'https://x.org/a.pdf', openalex_id: 'W1' })).toBe('https://x.org/a.pdf');
    expect(candidateExternalUrl({ doi: '10.1/x', openalex_id: 'W1' })).toBe('https://doi.org/10.1/x');
    expect(candidateExternalUrl({ openalex_id: 'W1' })).toBe('https://openalex.org/W1'); // fallback
    expect(candidateExternalUrl({ open_library_key: '/works/OL1W' })).toBe('https://openlibrary.org/works/OL1W');
    expect(candidateExternalUrl({})).toBeNull();
  });
});
