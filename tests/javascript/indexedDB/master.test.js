import { describe, it, expect } from 'vitest';
import { filterFreshNodesForBook } from '../../../resources/js/indexedDB/syncQueue/freshNodeFilter.js';

describe('filterFreshNodesForBook', () => {
  it('keeps only nodes whose book matches the target bookId', () => {
    const fresh = [
      { node_id: 'a', book: 'parent_book' },
      { node_id: 'b', book: 'book_parent_book/Fn7' },
      { node_id: 'c', book: 'parent_book' },
    ];
    const fallback = [{ node_id: 'fallback', book: 'parent_book' }];

    const result = filterFreshNodesForBook(fresh, fallback, 'parent_book');

    expect(result).toEqual([
      { node_id: 'a', book: 'parent_book' },
      { node_id: 'c', book: 'parent_book' },
    ]);
  });

  // REGRESSION: when getNodesByDataNodeIDs returns rows from a different book (because the
  // same node_id exists in parent and sub-book), the filter would produce an empty array
  // and wipe out the in-flight sync payload. Falling back to the original payload prevents
  // a sync-loss bug.
  it('falls back to the original payload when no fresh nodes match the book', () => {
    const fresh = [
      { node_id: 'a', book: 'parent_book' },
      { node_id: 'b', book: 'parent_book' },
    ];
    const fallback = [{ node_id: 'queued', book: 'book_parent_book/Fn7' }];

    const result = filterFreshNodesForBook(fresh, fallback, 'book_parent_book/Fn7');

    expect(result).toBe(fallback); // identity preserved — same reference
  });

  it('returns the fallback when fresh is empty', () => {
    const fallback = [{ node_id: 'queued', book: 'parent_book' }];

    const result = filterFreshNodesForBook([], fallback, 'parent_book');

    expect(result).toBe(fallback);
  });

  it('returns an empty fresh result (not the fallback) when at least one fresh node matches', () => {
    const fresh = [{ node_id: 'a', book: 'parent_book' }];
    const fallback = [{ node_id: 'queued', book: 'parent_book' }];

    const result = filterFreshNodesForBook(fresh, fallback, 'parent_book');

    expect(result).toEqual([{ node_id: 'a', book: 'parent_book' }]);
    expect(result).not.toBe(fallback);
  });

  it('treats different sub-book ids as distinct books', () => {
    const fresh = [
      { node_id: 'a', book: 'book_parent_book/Fn7' },
      { node_id: 'b', book: 'book_parent_book/Fn8' },
    ];
    const fallback = [];

    const result = filterFreshNodesForBook(fresh, fallback, 'book_parent_book/Fn7');

    expect(result).toEqual([{ node_id: 'a', book: 'book_parent_book/Fn7' }]);
  });
});
