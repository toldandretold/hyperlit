import { describe, it, expect, beforeEach } from 'vitest';
import { resolveBookIdForBatch } from '../../../resources/js/indexedDB/nodes/bookIdResolver.js';

describe('resolveBookIdForBatch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses options.bookId when explicitly provided, ignoring DOM', () => {
    document.body.innerHTML = `
      <div class="main-content" id="parent_book">
        <div data-book-id="book_parent_book/Fn7">
          <p id="node_42">x</p>
        </div>
      </div>
    `;
    const firstRecordEl = document.getElementById('node_42');
    const mainContent = document.querySelector('.main-content');

    const result = resolveBookIdForBatch({
      optionsBookId: 'explicit_override',
      firstRecordEl,
      mainContent,
      globalBook: 'global_book',
    });

    expect(result).toBe('explicit_override');
  });

  it('returns the sub-book id when the node is inside a [data-book-id] container', () => {
    document.body.innerHTML = `
      <div class="main-content" id="parent_book">
        <div data-book-id="book_parent_book/Fn7">
          <p id="node_42">x</p>
        </div>
      </div>
    `;
    const firstRecordEl = document.getElementById('node_42');
    const mainContent = document.querySelector('.main-content');

    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl,
      mainContent,
      globalBook: 'parent_book',
    });

    expect(result).toBe('book_parent_book/Fn7');
  });

  it('falls back to mainContent.id when the node is NOT inside a sub-book container', () => {
    document.body.innerHTML = `
      <div class="main-content" id="parent_book">
        <p id="node_42">x</p>
      </div>
    `;
    const firstRecordEl = document.getElementById('node_42');
    const mainContent = document.querySelector('.main-content');

    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl,
      mainContent,
      globalBook: 'global_book',
    });

    expect(result).toBe('parent_book');
  });

  it('falls back to globalBook when there is no firstRecordEl and no mainContent id', () => {
    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl: null,
      mainContent: null,
      globalBook: 'global_book',
    });

    expect(result).toBe('global_book');
  });

  it('falls back to "latest" when nothing is provided', () => {
    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl: null,
      mainContent: null,
      globalBook: null,
    });

    expect(result).toBe('latest');
  });

  it('handles a firstRecordEl that is the [data-book-id] element itself', () => {
    document.body.innerHTML = `
      <div data-book-id="book_parent_book/Fn7" id="self_node"></div>
    `;
    const firstRecordEl = document.getElementById('self_node');

    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl,
      mainContent: null,
      globalBook: null,
    });

    // closest() returns the element itself when it matches the selector
    expect(result).toBe('book_parent_book/Fn7');
  });

  // REGRESSION: bug fixed in batch.js where sub-book saves were attributed to the parent book
  // because the code fell straight to mainContent?.id without first walking up to the sub-book.
  it('regression: sub-book id wins over mainContent.id even when both exist', () => {
    document.body.innerHTML = `
      <div class="main-content" id="parent_book">
        <div data-book-id="book_parent_book/Fn7">
          <div data-book-id="book_parent_book/Fn7/Fn3">
            <p id="deep_node">x</p>
          </div>
        </div>
      </div>
    `;
    const firstRecordEl = document.getElementById('deep_node');
    const mainContent = document.querySelector('.main-content');

    const result = resolveBookIdForBatch({
      optionsBookId: undefined,
      firstRecordEl,
      mainContent,
      globalBook: 'parent_book',
    });

    // closest() walks up and returns the *nearest* match, not mainContent.id
    expect(result).toBe('book_parent_book/Fn7/Fn3');
  });
});
