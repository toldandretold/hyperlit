/**
 * Characterization tests for hyperlitContainer/utils.formatRelativeTime — pins the
 * relative-time buckets before the JS→TS conversion. (fetchLibraryFromServer /
 * scrollFocusedElementIntoView are network/DOM-effectful and covered elsewhere.)
 */
import { describe, it, expect } from 'vitest';

import { formatRelativeTime } from '../../../resources/js/hyperlitContainer/utils';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('formatRelativeTime', () => {
  it('returns "prehistoric" for a falsy timestamp', () => {
    expect(formatRelativeTime(0)).toBe('prehistoric');
    expect(formatRelativeTime(undefined)).toBe('prehistoric');
  });

  it('returns "now" for under a minute', () => {
    expect(formatRelativeTime(nowSec() - 30)).toBe('now');
  });

  it('returns minutes under an hour', () => {
    expect(formatRelativeTime(nowSec() - 5 * 60)).toBe('5min');
  });

  it('returns hours under a day', () => {
    expect(formatRelativeTime(nowSec() - 3 * 3600)).toBe('3hr');
  });

  it('returns days under a week', () => {
    expect(formatRelativeTime(nowSec() - 3 * 86400)).toBe('3d');
  });

  it('returns weeks under a month', () => {
    expect(formatRelativeTime(nowSec() - 2 * 7 * 86400)).toBe('2w');
  });

  it('returns months under a year', () => {
    expect(formatRelativeTime(nowSec() - 90 * 86400)).toBe('3m');
  });

  it('returns years past a year', () => {
    expect(formatRelativeTime(nowSec() - 800 * 86400)).toBe('2y');
  });
});
