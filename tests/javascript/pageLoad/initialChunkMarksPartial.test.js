/**
 * fetchInitialChunk is where a local copy BECOMES a fragment: it clears the book's rows
 * and stores one chunk. So it is the one place that must say so — otherwise a tab that
 * dies before the background download finishes leaves a fragment the next visit renders
 * as the whole book (prod 2026-11-22, 400 of 3,062 nodes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clearBookDataFromIndexedDB: vi.fn(),
  loadNodesToIndexedDB: vi.fn(),
  partialAtClear: null,
}));

vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: vi.fn(async () => ({})) }));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  loadNodesToIndexedDB: h.loadNodesToIndexedDB,
  loadLibraryToIndexedDB: vi.fn(async () => {}),
  loadBibliographyToIndexedDB: vi.fn(async () => {}),
  loadHyperlightsToIndexedDB: vi.fn(async () => {}),
  loadHypercitesToIndexedDB: vi.fn(async () => {}),
  clearBookDataFromIndexedDB: h.clearBookDataFromIndexedDB,
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() }, verbose: { content: vi.fn() },
}));
vi.mock('../../../resources/js/app', () => ({ OpenHyperlightID: null, OpenFootnoteID: null }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({
  gateQueryParam: () => '', getPinnedHyperciteIds: () => [], getPinnedHyperlightIds: () => [],
  pinHypercite: vi.fn(), pinHyperlight: vi.fn(),
}));

import { fetchInitialChunk, initialChunkIsWholeBook } from '../../../resources/js/pageLoad/initialChunk';
import { isLocalCopyPartial, markLocalCopyPartial } from '../../../resources/js/utilities/localCopyCompleteness';

const nodes = (n) => Array.from({ length: n }, (_, i) => ({ book: 'b', startLine: (i + 1) * 100, chunk_id: 0 }));

function respondWith(body, { ok = true, status = 200 } = {}) {
  global.fetch = vi.fn(async () => ({ ok, status, statusText: 'x', json: async () => body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  delete window._pendingChunkTarget;
  h.partialAtClear = null;
  h.loadNodesToIndexedDB.mockImplementation(async (_db, rows) => rows);
});

describe('initialChunkIsWholeBook', () => {
  it('true only when the response carries every node the manifest counts', () => {
    expect(initialChunkIsWholeBook([{ chunk_id: 0, node_count: 3 }], nodes(3))).toBe(true);
    // The server bundles an adjacent chunk into a short first one — still the whole book.
    expect(initialChunkIsWholeBook([{ chunk_id: 0, node_count: 5 }, { chunk_id: 1, node_count: 4 }], nodes(9))).toBe(true);
    expect(initialChunkIsWholeBook([{ chunk_id: 0, node_count: 100 }, { chunk_id: 1, node_count: 100 }], nodes(100))).toBe(false);
  });

  it('never assumes: a manifest row without a count, or no manifest, is not "whole"', () => {
    expect(initialChunkIsWholeBook([{ chunk_id: 0 }], nodes(3))).toBe(false);
    expect(initialChunkIsWholeBook([], nodes(3))).toBe(false);
    expect(initialChunkIsWholeBook(undefined, nodes(3))).toBe(false);
    expect(initialChunkIsWholeBook([{ chunk_id: 0, node_count: 3 }], undefined)).toBe(false);
  });
});

describe('fetchInitialChunk marks the local copy', () => {
  it('a multi-chunk book is PARTIAL after the first chunk — and already was when the rows were cleared', async () => {
    h.clearBookDataFromIndexedDB.mockImplementation(async (_db, book) => {
      h.partialAtClear = isLocalCopyPartial(book);
    });
    respondWith({
      initial_chunk: nodes(100),
      chunk_manifest: [{ chunk_id: 0, node_count: 100 }, { chunk_id: 1, node_count: 100 }],
      target_chunk_id: 0,
    });

    const result = await fetchInitialChunk('book_multi');

    expect(result.success).toBe(true);
    expect(h.partialAtClear, 'marked BEFORE the clear, so a tab dying mid-load is still known-partial').toBe(true);
    expect(isLocalCopyPartial('book_multi')).toBe(true);
  });

  it('a book that arrives whole in the first response is not left marked partial', async () => {
    respondWith({
      initial_chunk: nodes(12),
      chunk_manifest: [{ chunk_id: 0, node_count: 12 }],
      target_chunk_id: 0,
    });

    await fetchInitialChunk('book_small');

    expect(isLocalCopyPartial('book_small')).toBe(false);
  });

  it('a whole-book response whose node WRITE failed stays partial', async () => {
    h.loadNodesToIndexedDB.mockRejectedValueOnce(new Error('connection is closing'));
    respondWith({
      initial_chunk: nodes(12),
      chunk_manifest: [{ chunk_id: 0, node_count: 12 }],
      target_chunk_id: 0,
    });

    await fetchInitialChunk('book_small_failed');

    expect(isLocalCopyPartial('book_small_failed')).toBe(true);
  });

  it('a failed fetch touches neither the local rows nor the marker', async () => {
    respondWith({}, { ok: false, status: 404 });

    const result = await fetchInitialChunk('book_gone');

    expect(result).toMatchObject({ success: false, reason: 'book_not_found' });
    expect(h.clearBookDataFromIndexedDB).not.toHaveBeenCalled();
    expect(isLocalCopyPartial('book_gone')).toBe(false);

    // …and an existing mark survives a failed attempt to repair it.
    markLocalCopyPartial('book_gone');
    await fetchInitialChunk('book_gone');
    expect(isLocalCopyPartial('book_gone')).toBe(true);
  });
});
