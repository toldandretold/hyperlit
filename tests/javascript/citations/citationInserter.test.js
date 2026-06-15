/**
 * citationInserter — verifies the new picked-object shape that PR5 introduced
 * is correctly translated into IDB bibliography records with both source_id
 * and canonical_source_id pointers.
 *
 * parseAuthorYear and generateReferenceId stay pure-function tested.
 * insertCitationAtCursor is tested end-to-end with mocked openDatabase/queueForSync,
 * asserting the record shape that gets persisted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks need to be hoisted before the SUT import. Use vi.mock with factories.
const putSpy = vi.fn();
const queueSpy = vi.fn();

vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn(async () => ({
    transaction: () => {
      const tx = { oncomplete: null, onerror: null };
      const store = {
        put: (record) => {
          putSpy(record);
          const req = {};
          // Fire req.onsuccess on first microtask. The SUT awaits that promise,
          // THEN sets tx.oncomplete in a separate new Promise. So we have to
          // poll for tx.oncomplete on a later tick — setTimeout(0) puts us
          // squarely on the macrotask queue, after the SUT's promise chain.
          queueMicrotask(() => req.onsuccess && req.onsuccess());
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
          return req;
        },
      };
      tx.objectStore = () => store;
      return tx;
    },
  })),
  queueForSync: (...args) => queueSpy(...args),
}));

vi.mock('../../../resources/js/utilities/bibtexProcessor.js', () => ({
  formatBibtexToCitation: vi.fn(async (bibtex) => `[FORMATTED] ${bibtex}`),
}));

import {
  generateReferenceId,
  parseAuthorYear,
  insertCitationAtCursor,
} from '../../../resources/js/citations/citationInserter';

beforeEach(() => {
  putSpy.mockClear();
  queueSpy.mockClear();
  document.body.innerHTML = '';
});

describe('generateReferenceId', () => {
  it('produces a Ref-prefixed id', () => {
    const id = generateReferenceId();
    expect(id).toMatch(/^Ref\d+_[a-z0-9]{4}$/);
  });

  it('produces distinct ids on consecutive calls', () => {
    const a = generateReferenceId();
    const b = generateReferenceId();
    expect(a).not.toBe(b);
  });
});

describe('parseAuthorYear', () => {
  it('extracts last name from "First Last" single author', () => {
    expect(parseAuthorYear('@misc{x, author = {Karl Marx}, year = {1867}}'))
      .toEqual({ author: 'Marx', year: '1867' });
  });

  it('extracts last name from "Last, First" single author', () => {
    expect(parseAuthorYear('@misc{x, author = {Marx, Karl}, year = {1867}}'))
      .toEqual({ author: 'Marx', year: '1867' });
  });

  it('joins two authors with ampersand', () => {
    expect(parseAuthorYear('@misc{x, author = {Karl Marx and Friedrich Engels}, year = {1848}}'))
      .toEqual({ author: 'Marx & Engels', year: '1848' });
  });

  it('uses "et al" for three+ authors', () => {
    expect(parseAuthorYear('@misc{x, author = {A One and B Two and C Three}, year = {2000}}'))
      .toEqual({ author: 'One et al.', year: '2000' });
  });

  it('falls back to "Unknown" / "n.d." when fields missing', () => {
    expect(parseAuthorYear('@misc{x, title = {Anonymous}}'))
      .toEqual({ author: 'Unknown', year: 'n.d.' });
  });
});

describe('insertCitationAtCursor — new picked-object shape', () => {
  function makeRangeFor(node) {
    const range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    return range;
  }

  it('writes bibliography record with both source_id and canonical_source_id', async () => {
    const paragraph = document.createElement('p');
    paragraph.id = '1';
    paragraph.textContent = 'Some text';
    document.body.appendChild(paragraph);
    const range = makeRangeFor(paragraph.firstChild);

    const picked = {
      book: 'book_resolved_version',
      canonical_source_id: '11111111-1111-1111-1111-111111111111',
      bibtex: '@misc{x, author = {Karl Marx}, year = {1867}, title = {Capital}}',
      has_nodes: true,
    };

    await insertCitationAtCursor(range, 'book_current', picked, vi.fn());

    expect(putSpy).toHaveBeenCalledOnce();
    const record = putSpy.mock.calls[0][0];
    expect(record.source_id).toBe('book_resolved_version');
    expect(record.canonical_source_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(record.source_has_nodes).toBe(true);
  });

  it('writes only canonical_source_id for canonical-only pick (book empty)', async () => {
    const paragraph = document.createElement('p');
    paragraph.id = '1';
    paragraph.textContent = 'x';
    document.body.appendChild(paragraph);
    const range = makeRangeFor(paragraph.firstChild);

    const picked = {
      book: '',
      canonical_source_id: '22222222-2222-2222-2222-222222222222',
      bibtex: '@misc{y, author = {A B}, year = {2024}, title = {T}}',
      has_nodes: false,
    };

    await insertCitationAtCursor(range, 'book_current', picked, vi.fn());

    const record = putSpy.mock.calls[0][0];
    expect(record.source_id).toBe('');
    expect(record.canonical_source_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(record.source_has_nodes).toBe(false);
  });

  it('throws when neither book nor canonical_source_id provided', async () => {
    const paragraph = document.createElement('p');
    paragraph.id = '1';
    paragraph.textContent = 'x';
    document.body.appendChild(paragraph);
    const range = makeRangeFor(paragraph.firstChild);

    const picked = { book: '', canonical_source_id: null, bibtex: '', has_nodes: false };

    await expect(insertCitationAtCursor(range, 'book_current', picked, vi.fn()))
      .rejects.toThrow(/either book or canonical_source_id/);
  });
});

describe('insertCitationAtCursor — legacy positional signature', () => {
  it('still works with (range, bookId, citedBookId, bibtex, saveCallback, sourceHasNodes)', async () => {
    const paragraph = document.createElement('p');
    paragraph.id = '1';
    paragraph.textContent = 'x';
    document.body.appendChild(paragraph);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.collapse(true);

    await insertCitationAtCursor(
      range,
      'book_current',
      'book_legacy_target',
      '@misc{x, author = {Foo}, year = {2020}, title = {T}}',
      vi.fn(),
      true,
    );

    const record = putSpy.mock.calls[0][0];
    expect(record.source_id).toBe('book_legacy_target');
    expect(record.canonical_source_id).toBeNull();
  });
});
