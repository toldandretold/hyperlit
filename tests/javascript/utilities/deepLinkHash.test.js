/**
 * isDeepLinkHash — decides whether a URL #hash is a content deep-link (hypercite / hyperlight /
 * footnote / node startLine). On a full page load the browser strips the hash from the request, so
 * the server prerenders the WRONG (lowest) chunk; the blade's inline mirror of this predicate hides
 * that prerender pre-paint when the hash is a deep-link. This pins the truth table both use.
 */
import { describe, it, expect } from 'vitest';
import { isDeepLinkHash } from '../../../resources/js/utilities/deepLinkHash';

describe('isDeepLinkHash', () => {
  it('TRUE for content targets (with or without the leading #)', () => {
    expect(isDeepLinkHash('#hypercite_ftx8pxb')).toBe(true);
    expect(isDeepLinkHash('hypercite_ftx8pxb')).toBe(true);
    expect(isDeepLinkHash('#HL_1781699071351')).toBe(true);
    expect(isDeepLinkHash('#book_x_Fn1779605476532001')).toBe(true); // _Fn<digit> footnote
    expect(isDeepLinkHash('#Fn1779605476532001')).toBe(true);
    expect(isDeepLinkHash('#22400')).toBe(true);   // numeric startLine
    expect(isDeepLinkHash('#22400.5')).toBe(true);  // decimal startLine
  });

  it('FALSE for empty / bare-hash / non-target fragments', () => {
    expect(isDeepLinkHash('')).toBe(false);
    expect(isDeepLinkHash('#')).toBe(false);
    expect(isDeepLinkHash(null)).toBe(false);
    expect(isDeepLinkHash(undefined)).toBe(false);
    expect(isDeepLinkHash('#section-introduction')).toBe(false); // a plain anchor, not a target
    expect(isDeepLinkHash('#Fn')).toBe(false);                   // Fn without a digit
  });
});
