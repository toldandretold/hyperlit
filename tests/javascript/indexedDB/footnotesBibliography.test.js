/**
 * Pins footnotes/index.js + bibliography/index.js ahead of TS conversion:
 * the bulk save+sync paths, sync-failure swallowing, and the schema-orphaned
 * legacy singular footnote functions (broken since the v21 key change).
 * resolveBibliographyTarget is already covered by bibliographyResolver.test.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, readAll } from './idbHarness.js';
import {
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  saveAllFootnotesToIndexedDB,
  initFootnotesDependencies,
} from '../../../resources/js/indexedDB/footnotes/index';
import {
  saveAllReferencesToIndexedDB,
  initReferencesDependencies,
} from '../../../resources/js/indexedDB/bibliography/index';

describe('footnotes + bibliography domain (characterization)', () => {
  let updateBookTimestamp;
  let fetchMock;

  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    updateBookTimestamp = vi.fn().mockResolvedValue(true);
    initFootnotesDependencies({ updateBookTimestamp, withPending: (fn) => fn() });
    initReferencesDependencies({ withPending: (fn) => fn() });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('saveAllFootnotesToIndexedDB stamps book, writes per-footnote records, then syncs to PG', async () => {
    await saveAllFootnotesToIndexedDB([
      { footnoteId: 'Fn1', content: 'first' },
      { footnoteId: 'Fn2', content: 'second' },
    ], 'bookA');

    const all = await readAll('footnotes');
    expect(all.map(f => [f.book, f.footnoteId])).toEqual([['bookA', 'Fn1'], ['bookA', 'Fn2']]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/footnotes/upsert');
  });

  it('saveAllFootnotesToIndexedDB swallows a PG sync failure (local save still resolves)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
    await expect(
      saveAllFootnotesToIndexedDB([{ footnoteId: 'Fn1', content: 'x' }], 'bookA'),
    ).resolves.toBeUndefined();
    expect(await readAll('footnotes')).toHaveLength(1);
  });

  it('saveAllReferencesToIndexedDB stamps book, writes records, syncs; empty input is a no-op', async () => {
    expect(await saveAllReferencesToIndexedDB([], 'bookA')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    await saveAllReferencesToIndexedDB([{ referenceId: 'Ref1', title: 'T' }], 'bookA');
    expect((await readAll('bibliography'))[0]).toMatchObject({ book: 'bookA', referenceId: 'Ref1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/references/upsert');
  });

  it('LEGACY (pinned broken): the singular footnote functions are schema-orphaned since v21', async () => {
    // get(bookId) uses a single-string key against the composite [book, footnoteId]
    // store — it can never match, so this always resolves null.
    await saveAllFootnotesToIndexedDB([{ footnoteId: 'Fn1', content: 'x' }], 'bookA');
    expect(await getFootnotesFromIndexedDB('bookA')).toBeNull();

    // put({book, data}) lacks the footnoteId key part → DataError → rejects.
    // Live callers: NONE (initializePage imports it unused; convertMarkdown's
    // import is commented out). TODO(legacy-footnote-singular): delete both.
    await expect(saveFootnotesToIndexedDB({ some: 'data' }, 'bookA')).rejects.toBeTruthy();
  });
});
