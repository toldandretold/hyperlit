/**
 * Scrolled-away hash markers (sessionStorage-backed).
 *
 * Guards the fix for: stripping a deep-link hash from the URL on scroll-away corrupted
 * back/forward (the entry lost its target → landed at the top). We no longer mutate the URL;
 * instead we persist a "scrolled away from this hash" marker so a REFRESH resumes the reading
 * position while the hash stays in the URL for history navigation. These are the persisted
 * markers restoreScrollPosition consults.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  markHashScrolledAway,
  unmarkHashScrolledAway,
  hasScrolledAwayFromHash,
} from '../../../resources/js/scrolling/navState';

beforeEach(() => {
  sessionStorage.clear();
});

describe('scrolled-away hash markers', () => {
  it('marks and reads a hash', () => {
    expect(hasScrolledAwayFromHash('hypercite_abc')).toBe(false);
    markHashScrolledAway('hypercite_abc');
    expect(hasScrolledAwayFromHash('hypercite_abc')).toBe(true);
  });

  it('marking is idempotent and keeps other entries', () => {
    markHashScrolledAway('HL_1');
    markHashScrolledAway('HL_1');
    markHashScrolledAway('HL_2');
    expect(hasScrolledAwayFromHash('HL_1')).toBe(true);
    expect(hasScrolledAwayFromHash('HL_2')).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('hyperlit_scrolled_away_hashes'))).toEqual(['HL_1', 'HL_2']);
  });

  it('unmark removes only that hash (re-navigating resets it)', () => {
    markHashScrolledAway('hypercite_x');
    markHashScrolledAway('hypercite_y');
    unmarkHashScrolledAway('hypercite_x');
    expect(hasScrolledAwayFromHash('hypercite_x')).toBe(false);
    expect(hasScrolledAwayFromHash('hypercite_y')).toBe(true);
  });

  it('unmark of an absent hash is a no-op', () => {
    unmarkHashScrolledAway('nope');
    expect(hasScrolledAwayFromHash('nope')).toBe(false);
  });

  it('persists across reads (survives a same-tab refresh — sessionStorage)', () => {
    markHashScrolledAway('hypercite_persist');
    // A "refresh" re-reads sessionStorage; the marker is still there.
    expect(hasScrolledAwayFromHash('hypercite_persist')).toBe(true);
  });
});
