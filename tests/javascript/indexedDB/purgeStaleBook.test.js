/**
 * Pins purgeStaleBookFromIndexedDB: the aggressive per-book wipe used for stale
 * recovery. Unlike clearBookDataFromIndexedDB it MUST also clear `historyLog`
 * (the replay source of the 409 loop) and `bibliography`, while leaving every
 * OTHER book's data untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';
import { purgeStaleBookFromIndexedDB } from '../../../resources/js/indexedDB/serverSync/clear';

const STALE = 'book_stale';
const KEEP = 'book_keep';

describe('purgeStaleBookFromIndexedDB', () => {
  beforeEach(async () => {
    installFreshIndexedDB();
    await seedStore('nodes', [
      { book: STALE, startLine: '1', node_id: 'n1', content: '<p>stale</p>' },
      { book: KEEP, startLine: '1', node_id: 'k1', content: '<p>keep</p>' },
    ]);
    await seedStore('bibliography', [
      { book: STALE, referenceId: 'r1' },
      { book: KEEP, referenceId: 'r1' },
    ]);
    await seedStore('hyperlights', [
      { book: STALE, hyperlight_id: 'h1', node_id: 'n1' },
      { book: KEEP, hyperlight_id: 'h2', node_id: 'k1' },
    ]);
    await seedStore('library', [
      { book: STALE, timestamp: 111 },
      { book: KEEP, timestamp: 222 },
    ]);
    await seedStore('historyLog', [
      { bookId: STALE, status: 'failed', timestamp: 1, payload: { book: STALE, updates: { nodes: [] }, deletions: { nodes: [] } } },
      { bookId: KEEP, status: 'pending', timestamp: 2, payload: { book: KEEP, updates: { nodes: [] }, deletions: { nodes: [] } } },
    ]);
  });

  it('wipes the stale book across ALL stores including historyLog + bibliography', async () => {
    const db = await openDatabase();
    await purgeStaleBookFromIndexedDB(db, STALE);

    const books = async (store) => (await readAll(store)).map((r) => r.book ?? r.bookId);

    expect(await books('nodes')).toEqual([KEEP]);
    expect(await books('bibliography')).toEqual([KEEP]);
    expect(await books('hyperlights')).toEqual([KEEP]);
    expect(await readOne('library', STALE)).toBeUndefined();
    expect(await readOne('library', KEEP)).toBeTruthy();
    // The critical one: the doomed batch is gone, so retryFailedBatches can't replay it.
    expect(await books('historyLog')).toEqual([KEEP]);
  });
});
