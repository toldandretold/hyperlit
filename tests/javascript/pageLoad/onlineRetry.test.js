/**
 * Pins the loop-breaker: when a replayed historyLog batch is rejected as 409
 * STALE_DATA, retryFailedBatches must mark it 'stale' (terminal) — NOT leave it
 * 'failed'/'pending' — so it stops re-POSTing → 409 on every page load. This is
 * the bug where the homepage threw the stale overlay forever.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted so these exist when the hoisted vi.mock factory runs (onlineRetry
// STATICALLY imports them at module top, so the factory fires during import).
const { openDatabase, updateHistoryLog, executeSyncPayload } = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  updateHistoryLog: vi.fn().mockResolvedValue(undefined),
  executeSyncPayload: vi.fn(),
}));

vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  openDatabase,
  updateHistoryLog,
  executeSyncPayload,
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn(), content: vi.fn() },
  verbose: { content: vi.fn() },
}));

import { retryFailedBatches } from '../../../resources/js/pageLoad/onlineRetry';

// Minimal IDBRequest stand-in: fires onsuccess on the next microtask so the
// Promise wrapper in onlineRetry (which assigns onsuccess synchronously) resolves.
function fakeReq(result) {
  const req = { onsuccess: null, onerror: null, result };
  queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req }));
  return req;
}

function fakeDbWith(failedBatches) {
  return {
    transaction: () => ({
      objectStore: () => ({
        index: () => ({
          getAll: (key) => fakeReq(key === 'failed' ? failedBatches : []),
        }),
      }),
    }),
  };
}

describe('retryFailedBatches — stale batch handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a 409 STALE_DATA batch as 'stale' so it is never replayed again", async () => {
    const batch = {
      id: 7,
      status: 'failed',
      bookId: 'book_1',
      payload: {
        book: 'book_1',
        updates: { nodes: [{ startLine: '100', content: '<p>my sentence</p>' }], hypercites: [], hyperlights: [], footnotes: [], library: null },
        deletions: { nodes: [], hypercites: [], hyperlights: [] },
      },
    };
    openDatabase.mockResolvedValue(fakeDbWith([batch]));

    const staleError = Object.assign(new Error('Book is out of date'), { code: 'STALE_DATA', status: 409 });
    executeSyncPayload.mockRejectedValueOnce(staleError);

    await retryFailedBatches();

    expect(executeSyncPayload).toHaveBeenCalledTimes(1);
    // The batch must be parked terminal, not left retryable.
    expect(updateHistoryLog).toHaveBeenCalledTimes(1);
    expect(updateHistoryLog.mock.calls[0][0]).toMatchObject({ id: 7, status: 'stale' });
  });

  it("keeps a non-stale failure retryable (does NOT mark it stale)", async () => {
    const batch = {
      id: 9,
      status: 'failed',
      bookId: 'book_1',
      payload: {
        book: 'book_1',
        updates: { nodes: [{ startLine: '1', content: '<p>x</p>' }], hypercites: [], hyperlights: [], footnotes: [], library: null },
        deletions: { nodes: [], hypercites: [], hyperlights: [] },
      },
    };
    openDatabase.mockResolvedValue(fakeDbWith([batch]));

    // A transient 500 — should break the run and NOT terminally park the batch.
    executeSyncPayload.mockRejectedValueOnce(Object.assign(new Error('server'), { status: 500 }));

    await retryFailedBatches();

    expect(updateHistoryLog).not.toHaveBeenCalled();
  });
});
