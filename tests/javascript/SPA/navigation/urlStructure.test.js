// URL structure classification for prefix pages: /j/{slug} and /a/{slug} are
// journal-structure hero pages, /u/{username} is a user page, and the prefix
// letter is NEVER a book id. nonBookPrefixStructure is the single shared
// classifier — every nav site (detectStructureFromUrl, domMatchesUrl,
// extractBookSlugFromPath, getBookIdFromUrl, the container-close URL rewrite)
// consults it. Pinned because the archive pages shipped WITHOUT this: the
// popstate convergence loop classified /a/nam-archive as "a book named 'a'",
// re-inited the page as a reader, and replaceState'd the history entry to /a
// — the back-button-lands-on-the-index bug.

import { describe, test, expect } from 'vitest';
import {
  nonBookPrefixStructure,
  getBookIdFromUrl,
  getPageStructure,
} from '../../../../resources/js/SPA/navigation/utils/structureDetection';
import { NavigationManager } from '../../../../resources/js/SPA/navigation/NavigationManager';
import { LinkNavigationHandler } from '../../../../resources/js/SPA/navigation/LinkNavigationHandler';

describe('nonBookPrefixStructure', () => {
  test('classifies prefix pages and leaves book-URL space alone', () => {
    expect(nonBookPrefixStructure('/j/global-social-challenges-journal')).toBe('journal');
    expect(nonBookPrefixStructure('/a/nam-archive')).toBe('journal');
    expect(nonBookPrefixStructure('/u/toldandretold')).toBe('user');
    // Bare indexes are standalone blades, not SPA structures.
    expect(nonBookPrefixStructure('/j')).toBeNull();
    expect(nonBookPrefixStructure('/a')).toBeNull();
    // Book-URL space: single segment, and books that merely START with a/j/u.
    expect(nonBookPrefixStructure('/some-book')).toBeNull();
    expect(nonBookPrefixStructure('/accumulation/AIreview')).toBeNull();
    expect(nonBookPrefixStructure('/')).toBeNull();
  });
});

describe('book-id extraction refuses prefix letters', () => {
  test('getBookIdFromUrl returns null for /j/{slug} and /a/{slug}', () => {
    expect(getBookIdFromUrl('https://hyperlit.test/a/nam-archive')).toBeNull();
    expect(getBookIdFromUrl('https://hyperlit.test/j/some-journal')).toBeNull();
    // Book URLs still resolve.
    expect(getBookIdFromUrl('https://hyperlit.test/some-book')).toBe('some-book');
    expect(getBookIdFromUrl('https://hyperlit.test/u/someone')).toBe('someone');
  });

  test('extractBookSlugFromPath returns null for prefix pages', () => {
    expect(LinkNavigationHandler.extractBookSlugFromPath('/a/nam-archive')).toBeNull();
    expect(LinkNavigationHandler.extractBookSlugFromPath('/j/some-journal')).toBeNull();
    expect(LinkNavigationHandler.extractBookSlugFromPath('/some-book')).toBe('some-book');
    expect(LinkNavigationHandler.extractBookSlugFromPath('/u/someone')).toBe('someone');
  });
});

describe('detectStructureFromUrl', () => {
  test('archive and journal slugs are journal structure, not reader', async () => {
    expect(await NavigationManager.detectStructureFromUrl('/a/nam-archive')).toBe('journal');
    expect(await NavigationManager.detectStructureFromUrl('/j/some-journal')).toBe('journal');
    expect(await NavigationManager.detectStructureFromUrl('/u/someone')).toBe('user');
    expect(await NavigationManager.detectStructureFromUrl('/some-book')).toBe('reader');
    expect(await NavigationManager.detectStructureFromUrl('/')).toBe('home');
  });
});

describe('domMatchesUrl on an archive page', () => {
  test('journal DOM at /a/{slug} matches; reader DOM does not', () => {
    window.history.replaceState(null, '', '/a/nam-archive');

    document.body.innerHTML = '<div class="journal-content-wrapper"></div>';
    expect(getPageStructure()).toBe('journal');
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(true);

    // A reader wrongly initialized over the archive URL must be reconciled.
    document.body.innerHTML = '<div class="reader-content-wrapper"></div>';
    expect(LinkNavigationHandler.domMatchesUrl()).toBe(false);
  });
});
