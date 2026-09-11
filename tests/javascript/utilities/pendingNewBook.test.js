/**
 * utilities/pendingNewBook — the one parse, the one clear.
 *
 * Nine call sites used to do their own `JSON.parse(sessionStorage.getItem(...))`
 * in their own try/catch. What this pins is the behaviour those sites now rely
 * on: a malformed marker reads as "nothing pending" instead of throwing into a
 * sync path, `isPendingNewBook` answers about ONE book (a second create
 * overwrites the marker), and a clear scoped to a book id refuses to clear
 * someone else's — a wrong clear means the book silently regains the
 * optimistic-concurrency check it isn't ready for, a right-but-missed clear
 * means it never does.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  PENDING_NEW_BOOK_KEY,
  getPendingNewBook,
  isPendingNewBook,
  setPendingNewBook,
  clearPendingNewBook,
} from '../../../resources/js/utilities/pendingNewBook';

const PAYLOAD = {
  bookId: 'book_1',
  isNewBook: true,
  libraryRecord: { book: 'book_1', title: 'Untitled' },
  nodes: [{ book: 'book_1', startLine: 100 }],
};

describe('pendingNewBook', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips the whole create payload (it is a reload-recovery record, not a flag)', () => {
    setPendingNewBook(PAYLOAD);

    expect(getPendingNewBook()).toEqual(PAYLOAD);
    expect(JSON.parse(sessionStorage.getItem(PENDING_NEW_BOOK_KEY)).nodes).toHaveLength(1);
  });

  it('reads as "nothing pending" when absent', () => {
    expect(getPendingNewBook()).toBeNull();
    expect(isPendingNewBook('book_1')).toBe(false);
  });

  it('reads as "nothing pending" when malformed, instead of throwing into a sync path', () => {
    sessionStorage.setItem(PENDING_NEW_BOOK_KEY, '{not json');
    expect(getPendingNewBook()).toBeNull();
    expect(isPendingNewBook('book_1')).toBe(false);

    sessionStorage.setItem(PENDING_NEW_BOOK_KEY, '{"no":"bookId"}');
    expect(getPendingNewBook()).toBeNull();
  });

  it('answers about ONE book', () => {
    setPendingNewBook(PAYLOAD);

    expect(isPendingNewBook('book_1')).toBe(true);
    expect(isPendingNewBook('book_2')).toBe(false);
    expect(isPendingNewBook(null)).toBe(false);
    expect(isPendingNewBook(undefined)).toBe(false);
  });

  it('a second create replaces the marker (the first is no longer pending)', () => {
    setPendingNewBook(PAYLOAD);
    setPendingNewBook({ bookId: 'book_2', isNewBook: true });

    expect(isPendingNewBook('book_1')).toBe(false);
    expect(isPendingNewBook('book_2')).toBe(true);
  });

  it('a book-scoped clear refuses to clear a DIFFERENT book\'s marker', () => {
    setPendingNewBook({ bookId: 'book_2', isNewBook: true });

    clearPendingNewBook('book_1'); // book_1 settled late; book_2 is now pending
    expect(isPendingNewBook('book_2')).toBe(true);

    clearPendingNewBook('book_2');
    expect(getPendingNewBook()).toBeNull();
  });

  it('an unscoped clear always clears (the error paths that can\'t name the book)', () => {
    setPendingNewBook(PAYLOAD);
    clearPendingNewBook();
    expect(getPendingNewBook()).toBeNull();
  });

  it('survives sessionStorage being unavailable — creation must not break', () => {
    // Replace the GLOBAL (happy-dom's storage isn't driven through
    // Storage.prototype, so spying the prototype silently does nothing).
    const throwing = () => { throw new Error('storage denied'); };
    vi.stubGlobal('sessionStorage', {
      getItem: throwing, setItem: throwing, removeItem: throwing, clear: throwing,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {}); // log.error emits through console.error

    expect(() => setPendingNewBook(PAYLOAD)).not.toThrow();
    expect(getPendingNewBook()).toBeNull();
    expect(isPendingNewBook('book_1')).toBe(false);
    expect(() => clearPendingNewBook('book_1')).not.toThrow();
    expect(() => clearPendingNewBook()).not.toThrow();

    vi.unstubAllGlobals();
  });
});
