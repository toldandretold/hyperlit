/**
 * Pins the four legacy per-entity sync endpoint modules ahead of their TS
 * conversion: URL, headers, {book, data} body shape, empty-input short-circuit,
 * and error behavior (return-object vs throw — they differ!).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { syncNodesToPostgreSQL } from '../../../resources/js/indexedDB/nodes/syncNodesToPostgreSQL';
import { syncFootnotesToPostgreSQL } from '../../../resources/js/indexedDB/footnotes/syncFootnotesToPostgreSQL';
import { syncReferencesToPostgreSQL } from '../../../resources/js/indexedDB/bibliography/syncReferencesToPostgreSQL';
import {
  syncHyperlightToPostgreSQL,
  syncHyperlightDeletionsToPostgreSQL,
} from '../../../resources/js/indexedDB/highlights/syncHighlightsToPostgreSQL';

describe('legacy sync endpoints (characterization)', () => {
  let fetchMock;

  beforeEach(() => {
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('nodes: POSTs {book, data} to targeted-upsert; empty input skips fetch; !ok returns failure object', async () => {
    expect(await syncNodesToPostgreSQL('bookA', [])).toEqual({ success: true });
    expect(fetchMock).not.toHaveBeenCalled();

    await syncNodesToPostgreSQL('bookA', [{ book: 'bookA', startLine: 100 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/db/nodes/targeted-upsert');
    expect(init.headers['X-CSRF-TOKEN']).toBe('test-csrf');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ book: 'bookA', data: [{ book: 'bookA', startLine: 100 }] });

    // Unlike the others, node sync reports failure as a value, not a throw
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'nope' });
    expect(await syncNodesToPostgreSQL('bookA', [{ book: 'bookA', startLine: 100 }]))
      .toEqual({ success: false, message: 'nope' });
  });

  it('footnotes: POSTs to /api/db/footnotes/upsert and THROWS on !ok', async () => {
    expect(await syncFootnotesToPostgreSQL('bookA', [])).toBeUndefined();
    await syncFootnotesToPostgreSQL('bookA', [{ book: 'bookA', footnoteId: 'Fn1' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/footnotes/upsert');

    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(syncFootnotesToPostgreSQL('bookA', [{ book: 'bookA', footnoteId: 'Fn1' }]))
      .rejects.toThrow('Footnotes sync failed: boom');
  });

  it('references: POSTs to /api/db/references/upsert and THROWS on !ok', async () => {
    await syncReferencesToPostgreSQL('bookA', [{ book: 'bookA', referenceId: 'Ref1' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/references/upsert');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      book: 'bookA', data: [{ book: 'bookA', referenceId: 'Ref1' }],
    });

    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => 'bad' });
    await expect(syncReferencesToPostgreSQL('bookA', [{ book: 'bookA', referenceId: 'Ref1' }]))
      .rejects.toThrow('References sync failed: bad');
  });

  it('hyperlights: upsert takes the book from the FIRST record; deletions split delete/hide endpoints', async () => {
    await syncHyperlightToPostgreSQL([{ book: 'bookX', hyperlight_id: 'HL_1' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/hyperlights/upsert');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).book).toBe('bookX');

    fetchMock.mockClear();
    await syncHyperlightDeletionsToPostgreSQL([
      { book: 'bookX', hyperlight_id: 'HL_del', _action: 'delete', extra: 'stripped' },
      { book: 'bookX', hyperlight_id: 'HL_hide', _action: 'hide' },
    ]);

    const urls = fetchMock.mock.calls.map(c => c[0]);
    expect(urls).toEqual(['/api/db/hyperlights/delete', '/api/db/hyperlights/hide']);
    // Deletion payloads carry ONLY {book, hyperlight_id}
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).data)
      .toEqual([{ book: 'bookX', hyperlight_id: 'HL_del' }]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).data)
      .toEqual([{ book: 'bookX', hyperlight_id: 'HL_hide' }]);
  });
});
