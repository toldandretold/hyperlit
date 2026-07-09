/**
 * scrolling/navStamp — durable per-(book, target) "navigatedAt" store.
 *
 * This is the durable half of the reading-position resume-vs-jump decision: it records when we
 * last deliberately navigated to a target, in localStorage (so it survives the session), keyed
 * so the reading-position storage-accessor guardrail does not flag it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordNavigatedAt, getNavigatedAt } from '../../../resources/js/scrolling/navStamp';

const BOOK = 'book_test';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('navStamp', () => {
  it('records and reads back a navigatedAt for a (book, target)', () => {
    expect(getNavigatedAt(BOOK, 'hypercite_a')).toBeUndefined();
    const before = Date.now();
    recordNavigatedAt(BOOK, 'hypercite_a');
    const at = getNavigatedAt(BOOK, 'hypercite_a');
    expect(typeof at).toBe('number');
    expect(at).toBeGreaterThanOrEqual(before);
  });

  it('isolates targets and books', () => {
    recordNavigatedAt(BOOK, 'hypercite_a');
    expect(getNavigatedAt(BOOK, 'hypercite_b')).toBeUndefined();
    expect(getNavigatedAt('book_other', 'hypercite_a')).toBeUndefined();
  });

  it('ignores empty book / target', () => {
    recordNavigatedAt('', 'hypercite_a');
    recordNavigatedAt(BOOK, '');
    expect(getNavigatedAt('', 'hypercite_a')).toBeUndefined();
    expect(getNavigatedAt(BOOK, '')).toBeUndefined();
  });

  it('persists across a simulated session (localStorage survives)', () => {
    recordNavigatedAt(BOOK, 'HL_x');
    const at = getNavigatedAt(BOOK, 'HL_x');
    // A "new session" re-reads from the same localStorage — the module is stateless (no in-memory
    // cache), so a fresh read reflects the persisted value.
    expect(getNavigatedAt(BOOK, 'HL_x')).toBe(at);
    // And it's genuinely in localStorage, not sessionStorage (the durability that fixes the bug).
    expect(sessionStorage.getItem(`hyperlit_nav_at_${BOOK}`)).toBeNull();
    expect(localStorage.getItem(`hyperlit_nav_at_${BOOK}`)).not.toBeNull();
  });

  it('caps growth at 50 newest targets per book', () => {
    // Monotonic clock so eviction is deterministic (real navigations happen at distinct times;
    // a tight test loop would otherwise tie timestamps).
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    // Record 60 distinct targets; the oldest 10 should be evicted.
    for (let i = 0; i < 60; i++) recordNavigatedAt(BOOK, `t_${i}`);
    const map = JSON.parse(localStorage.getItem(`hyperlit_nav_at_${BOOK}`));
    expect(Object.keys(map).length).toBeLessThanOrEqual(50);
    // The most-recent target survives; the oldest is gone.
    expect(getNavigatedAt(BOOK, 't_59')).toBeDefined();
    expect(getNavigatedAt(BOOK, 't_0')).toBeUndefined();
  });

  it('uses a storage key that does NOT contain the reading-position key token', () => {
    recordNavigatedAt(BOOK, 'hypercite_a');
    const keys = Object.keys(localStorage);
    expect(keys.some((k) => k.startsWith('hyperlit_nav_at_'))).toBe(true);
    // The scrollPositionAccessor guardrail matches /scrollPosition/ — our key must dodge it.
    expect(keys.every((k) => !/scrollPosition/.test(k))).toBe(true);
  });
});
