/**
 * runPool — the bounded-concurrency + retry runner behind the lock/publish tree
 * pull+push (docs/e2ee.md). The old sequential + throw-on-first version left a
 * footnote-heavy book (hundreds of `book/Fn…` sub-books) falsely flagged
 * encrypted when one part failed; this proves the resilient replacement.
 */
import { describe, it, expect, vi } from 'vitest';
import { runPool } from '../../../resources/js/e2ee/pool';

describe('runPool', () => {
  it('processes every item', async () => {
    const seen = [];
    const failures = await runPool([1, 2, 3, 4, 5], async (n) => { seen.push(n); }, { concurrency: 2 });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(failures).toEqual([]);
  });

  it('retries a transient failure and succeeds (no failure reported)', async () => {
    let attempts = 0;
    const failures = await runPool(['flaky'], async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
    }, { retries: 2 });
    expect(attempts).toBe(3);
    expect(failures).toEqual([]);
  });

  it('collects items that STILL fail after all retries, without aborting the rest', async () => {
    const done = [];
    const failures = await runPool(['ok1', 'bad', 'ok2'], async (item) => {
      if (item === 'bad') throw new Error('always');
      done.push(item);
    }, { retries: 1, concurrency: 1 });
    // The good items still completed — one failure does NOT abort the pool
    expect(done.sort()).toEqual(['ok1', 'ok2']);
    expect(failures).toEqual(['bad']);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(Array.from({ length: 20 }, (_, i) => i), async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }, { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('reports progress per completed item', async () => {
    const progress = [];
    await runPool([1, 2, 3], async () => {}, { concurrency: 1, onProgress: (d, t) => progress.push([d, t]) });
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('handles an empty list', async () => {
    expect(await runPool([], async () => {})).toEqual([]);
  });
});
