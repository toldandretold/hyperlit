/**
 * Background downloads are BOOK-SCOPED.
 *
 * The user page loads its own aggregate book (`{username}All`) and that
 * download regularly outlives the SPA nav into a reader. With a single global
 * in-progress flag that produced three failures, all pinned here:
 *   1. The reader's own download was skipped by the double-download guard.
 *   2. `waitForBackgroundDownload()` parked on the OTHER book's download — the
 *      grand tour's user→reader lap clicked #editButton and edit mode took ~6s
 *      to engage (spa-grand-tour "back-button replay to start", 2026-09-09).
 *   3. A download finishing after the nav ran the global/DOM swap
 *      (`window.nodes`, rebuildAndRenumber over the LIVE DOM) for a book that
 *      was no longer on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { loadNodesToIndexedDB, rebuildAndRenumber, reconvertSyncActive } = vi.hoisted(() => ({
  loadNodesToIndexedDB: vi.fn().mockResolvedValue(undefined),
  rebuildAndRenumber: vi.fn().mockResolvedValue(undefined),
  reconvertSyncActive: vi.fn().mockReturnValue(false),
}));

// The rendered book — mutable through a getter so a test can simulate SPA nav
// exactly as setCurrentBook() does (app.ts exports a live `let` binding).
let renderedBook = 'book_A';
vi.mock('../../../resources/js/app', () => ({
  get book() { return renderedBook; },
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  loadNodesToIndexedDB,
  loadBibliographyToIndexedDB: vi.fn().mockResolvedValue(undefined),
  loadHyperlightsToIndexedDB: vi.fn().mockResolvedValue(undefined),
  loadHypercitesToIndexedDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/footnotes/FootnoteNumberingService', () => ({ rebuildAndRenumber }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({ appendGateParam: (u) => u }));
vi.mock('../../../resources/js/utilities/reconvertHandoff', () => ({ reconvertSyncActive }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { content: vi.fn() },
}));

import {
  backgroundDownloadRemainingChunks,
  waitForBackgroundDownload,
  isBackgroundDownloadInProgress,
  supersedeBackgroundDownload,
} from '../../../resources/js/pageLoad/backgroundDownload';

/** A lazyLoader stub with a one-chunk manifest (one batch request). */
function fakeLoader() {
  return { chunkManifest: [{ chunk_id: 0 }], nodes: [], isFullyLoaded: false };
}

/** fetch stub whose response for each book is released by the test. */
function heldFetch() {
  const releases = new Map();
  const fn = vi.fn((url) => {
    const bookId = String(url).match(/books\/([^/]+)\//)?.[1] ?? 'unknown';
    return new Promise((resolve) => {
      releases.set(bookId, () => resolve({
        ok: true,
        json: async () => ({ nodes: [{ startLine: 100, chunk_id: 0, content: `<p>${bookId}</p>` }] }),
      }));
    });
  });
  return { fn, release: (b) => releases.get(b)?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('background download is book-scoped', () => {
  let fetchStub;

  beforeEach(() => {
    renderedBook = 'book_A';
    delete window.nodes;
    loadNodesToIndexedDB.mockClear();
    rebuildAndRenumber.mockClear();
    fetchStub = heldFetch();
    global.fetch = fetchStub.fn;
  });

  afterEach(() => { vi.useRealTimers(); });

  it("another book's in-flight download does not suppress this book's", async () => {
    const a = backgroundDownloadRemainingChunks('book_A', fakeLoader());
    await tick();
    expect(isBackgroundDownloadInProgress('book_A')).toBe(true);

    renderedBook = 'book_B'; // SPA nav
    const b = backgroundDownloadRemainingChunks('book_B', fakeLoader());
    await tick();
    expect(isBackgroundDownloadInProgress('book_B')).toBe(true);
    expect(fetchStub.fn).toHaveBeenCalledTimes(2);

    fetchStub.release('book_A');
    fetchStub.release('book_B');
    await Promise.all([a, b]);
    expect(isBackgroundDownloadInProgress()).toBe(false);
  });

  it('waiting on book B ignores book A completing', async () => {
    const a = backgroundDownloadRemainingChunks('book_A', fakeLoader());
    renderedBook = 'book_B';
    const b = backgroundDownloadRemainingChunks('book_B', fakeLoader());
    await tick();

    let resolved = false;
    const waiter = waitForBackgroundDownload('book_B').then(() => { resolved = true; });

    fetchStub.release('book_A');
    await a;
    await tick();
    expect(resolved, 'book_A completing must not release a book_B waiter').toBe(false);

    fetchStub.release('book_B');
    await b;
    await waiter;
    expect(resolved).toBe(true);
  });

  it('a download that outlived its nav updates IDB but not the global/DOM state', async () => {
    const a = backgroundDownloadRemainingChunks('book_A', fakeLoader());
    await tick();
    renderedBook = 'book_B'; // navigated away mid-download
    fetchStub.release('book_A');
    await a;

    expect(loadNodesToIndexedDB).toHaveBeenCalled();       // IDB is book-keyed: safe
    expect(rebuildAndRenumber).not.toHaveBeenCalled();     // walks the LIVE DOM: not safe
    expect(window.nodes).toBeUndefined();
  });

  it('still runs the global swap when the book is (still) the rendered one', async () => {
    const a = backgroundDownloadRemainingChunks('book_A', fakeLoader());
    await tick();
    fetchStub.release('book_A');
    await a;

    expect(rebuildAndRenumber).toHaveBeenCalledWith('book_A', expect.any(Array));
    expect(window.nodes).toHaveLength(1);
  });

  it('treats a sub-book download as belonging to its parent reader', async () => {
    renderedBook = 'book_A';
    const sub = backgroundDownloadRemainingChunks('book_A/Fn3', fakeLoader());
    await tick();
    fetchStub.release('book_A');   // sub-book URLs carry the parent segment
    await sub;

    expect(rebuildAndRenumber).toHaveBeenCalled();
  });

  /*
   * Supersession: the timestamp check used to WAIT for an in-flight download
   * of the same book before comparing — 10s+ on the user page's ~120-chunk
   * aggregate book, during which a renamed card kept its old title
   * (library-home-sync.spec.js). It now compares at once and, when stale,
   * retires the download so its as-of-start data cannot land over the refresh.
   */
  describe('supersession', () => {
    it('a superseded download writes nothing and fires no completion', async () => {
      const done = vi.fn();
      window.addEventListener('backgroundDownloadComplete', done);
      const a = backgroundDownloadRemainingChunks('book_A', fakeLoader());
      await tick();

      expect(supersedeBackgroundDownload('book_A')).toBe(true);
      expect(isBackgroundDownloadInProgress('book_A')).toBe(false);

      fetchStub.release('book_A'); // the stale batch arrives after all
      await a;
      window.removeEventListener('backgroundDownloadComplete', done);

      expect(loadNodesToIndexedDB).not.toHaveBeenCalled();
      expect(rebuildAndRenumber).not.toHaveBeenCalled();
      expect(window.nodes).toBeUndefined();
      expect(done).not.toHaveBeenCalled();
    });

    it('lets a replacement start at once, and the stale run cannot clear its flag', async () => {
      const stale = backgroundDownloadRemainingChunks('book_A', fakeLoader());
      await tick();
      supersedeBackgroundDownload('book_A');

      // The replacement is NOT swallowed by the double-download guard.
      let releaseFresh;
      global.fetch = vi.fn(() => new Promise((resolve) => {
        releaseFresh = () => resolve({ ok: true, json: async () => ({ nodes: [{ startLine: 100, chunk_id: 0, content: '<p>fresh</p>' }] }) });
      }));
      const fresh = backgroundDownloadRemainingChunks('book_A', fakeLoader());
      await tick();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(isBackgroundDownloadInProgress('book_A')).toBe(true);

      // A waiter parked on book_A is released by the REPLACEMENT, not the stale run.
      let resolved = false;
      const waiter = waitForBackgroundDownload('book_A').then(() => { resolved = true; });
      fetchStub.release('book_A');
      await stale;
      await tick();
      expect(isBackgroundDownloadInProgress('book_A'), 'stale run must not clear the replacement').toBe(true);
      expect(resolved).toBe(false);

      releaseFresh();
      await fresh;
      await waiter;
      expect(resolved).toBe(true);
      expect(loadNodesToIndexedDB).toHaveBeenCalledTimes(1);
      expect(window.nodes[0].content).toBe('<p>fresh</p>');
    });

    it('is a no-op when nothing is downloading', () => {
      expect(supersedeBackgroundDownload('book_none')).toBe(false);
    });
  });
});
