// Slug/id parity on the SPA side — a vanity-slug book renders
// `<main id="book_123…" data-slug="welcome">` while the address bar shows
// `/welcome`, so BOTH spellings name the SAME book. Getting this wrong is the
// slug-vs-mainid cross-book bug (fixed 2026-07): closing a highlight on a slug
// URL (overlay → history.back() → /welcome) misread as cross-book navigation
// and FULL-RELOADED the book the user was already reading. The comparison now
// lives in ONE place — LinkNavigationHandler.urlNamesRenderedBook — shared by
// domMatchesUrl (the popstate convergence loop) and the popstate cross-book
// decision (differsFromRendered), and this file pins both.

import { describe, test, expect } from 'vitest';
import { getPageStructure } from '../../../../resources/js/SPA/navigation/utils/structureDetection';
import { LinkNavigationHandler } from '../../../../resources/js/SPA/navigation/LinkNavigationHandler';

const RAW_ID = 'book_1790169425053';
const SLUG = 'welcome-to-the-parity-test';

function renderReader({ slug = SLUG } = {}) {
  document.body.innerHTML =
    '<div class="reader-content-wrapper">'
    + `<main class="main-content" id="${RAW_ID}"${slug ? ` data-slug="${slug}"` : ''}></main>`
    + '</div>';
}

describe('urlNamesRenderedBook — the ONE slug-aware same-book test', () => {
  test('raw id and vanity slug BOTH name the rendered book; anything else does not', () => {
    expect(LinkNavigationHandler.urlNamesRenderedBook(RAW_ID, RAW_ID, SLUG)).toBe(true);
    expect(LinkNavigationHandler.urlNamesRenderedBook(SLUG, RAW_ID, SLUG)).toBe(true);
    expect(LinkNavigationHandler.urlNamesRenderedBook('some-other-book', RAW_ID, SLUG)).toBe(false);
  });

  test('a slug-less book answers only to its raw id', () => {
    expect(LinkNavigationHandler.urlNamesRenderedBook(RAW_ID, RAW_ID, null)).toBe(true);
    expect(LinkNavigationHandler.urlNamesRenderedBook('welcome', RAW_ID, null)).toBe(false);
  });

  test('null inputs never match (no rendered book / no URL book = not the same book)', () => {
    expect(LinkNavigationHandler.urlNamesRenderedBook(null, RAW_ID, SLUG)).toBe(false);
    expect(LinkNavigationHandler.urlNamesRenderedBook(RAW_ID, null, null)).toBe(false);
    // A rendered book with NO slug must not match a null/empty URL segment.
    expect(LinkNavigationHandler.urlNamesRenderedBook('', RAW_ID, SLUG)).toBe(false);
  });
});

describe('domMatchesUrl on a vanity-slug reader', () => {
  test('the slug URL and the raw-id URL both match the rendered book', () => {
    renderReader();
    expect(getPageStructure()).toBe('reader');

    window.history.replaceState(null, '', `/${SLUG}`);
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(true);

    window.history.replaceState(null, '', `/${RAW_ID}`);
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(true);
  });

  test('a DIFFERENT book URL over the same reader does not match (reconcile fires)', () => {
    renderReader();
    window.history.replaceState(null, '', '/some-other-book');
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(false);
  });

  test('a slug-less reader matches its id URL and nothing else', () => {
    renderReader({ slug: null });
    window.history.replaceState(null, '', `/${RAW_ID}`);
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(true);
    window.history.replaceState(null, '', `/${SLUG}`);
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(false);
  });
});
