// A download anchor is not navigation. exportDownload.ts (archive panel) and
// audiobookDownload.ts mint `<a download href="…">`, append it to <body> and
// click it; the synthetic click bubbles to lazyLoader's document-level handler
// → LinkNavigationHandler.handleLinkClick like any content link. Until
// 2026-11-16 nothing in shouldSkipLinkHandling knew about downloads, so the
// vault button's click was preventDefault-ed (killing the native download) and
// `/exports/archive/{slug}/markdown` was run through BookToBookTransition as a
// book called "exports": the archive page reloaded into a broken reader shell
// and froze, and the zip only arrived because the failure fallback set
// window.location.href. This pins the skip.

import { describe, test, expect } from 'vitest';
import { LinkNavigationHandler } from '../../../../resources/js/SPA/navigation/LinkNavigationHandler';

function anchor(href, attrs = {}) {
  const a = document.createElement('a');
  a.href = href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  document.body.appendChild(a);
  return a;
}

function skips(a) {
  const linkUrl = new URL(a.href, window.location.origin);
  const currentUrl = new URL(window.location.href);
  return LinkNavigationHandler.shouldSkipLinkHandling(a, linkUrl, currentUrl);
}

describe('download anchors bypass SPA routing', () => {
  test('the archive panel vault/SQLite download anchor is left to the browser', () => {
    window.history.replaceState(null, '', '/a/decolonising-security');
    const a = anchor('/exports/archive/decolonising-security/markdown', { download: '' });
    expect(skips(a)).toBe(true);
  });

  test('the audiobook .m4b download anchor is left to the browser', () => {
    window.history.replaceState(null, '', '/book_1790169425053');
    const a = anchor('/book_1790169425053/audiobook.m4b', { download: '' });
    expect(skips(a)).toBe(true);
  });

  test('an /exports/ URL is a download whatever element carries it', () => {
    window.history.replaceState(null, '', '/u/someone');
    const a = anchor('/exports/user/someone/sqlite');
    expect(skips(a)).toBe(true);
  });

  test('an ordinary same-origin book link is still SPA-routed', () => {
    window.history.replaceState(null, '', '/a/decolonising-security');
    const a = anchor('/digital-commoning-and-post-capitalist-crypto-economies');
    expect(skips(a)).toBe(false);
  });
});
