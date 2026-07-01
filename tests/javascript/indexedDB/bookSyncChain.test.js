import { describe, it, expect } from 'vitest';
import { runSerializedPerKey } from '../../../resources/js/indexedDB/syncQueue/bookSyncChain';

// Deferred promise helper: lets a "task" stay in-flight until we resolve it, so we can observe
// whether a second task for the same key started before the first finished.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('runSerializedPerKey', () => {
  it('runs two tasks for the SAME key serially (second waits for the first)', async () => {
    const chain = new Map();
    const order = [];

    const d1 = deferred();
    const d2 = deferred();

    const p1 = runSerializedPerKey(chain, 'bookA', async () => {
      order.push('start1');
      await d1.promise;
      order.push('end1');
    });
    const p2 = runSerializedPerKey(chain, 'bookA', async () => {
      order.push('start2');
      await d2.promise;
      order.push('end2');
    });

    // Task 2 must NOT have started while task 1 is still in flight.
    await Promise.resolve();
    expect(order).toEqual(['start1']);

    // Finish task 1 → task 2 may now start.
    d1.resolve();
    await p1;
    await Promise.resolve();
    expect(order).toEqual(['start1', 'end1', 'start2']);

    d2.resolve();
    await p2;
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('runs tasks for DIFFERENT keys concurrently', async () => {
    const chain = new Map();
    const order = [];

    const dA = deferred();

    const pA = runSerializedPerKey(chain, 'bookA', async () => {
      order.push('startA');
      await dA.promise;
      order.push('endA');
    });
    const pB = runSerializedPerKey(chain, 'bookB', async () => {
      order.push('startB');
    });

    // bookB is independent — it starts even though bookA is still blocked.
    await pB;
    expect(order).toContain('startB');
    expect(order).not.toContain('endA');

    dA.resolve();
    await pA;
    expect(order).toEqual(['startA', 'startB', 'endA']);
  });

  it('keeps the chain alive after a task rejects (next task still runs)', async () => {
    const chain = new Map();

    const p1 = runSerializedPerKey(chain, 'bookA', async () => { throw new Error('boom'); });
    await expect(p1).rejects.toThrow('boom');

    // A failed task must not poison the key's chain — the next one still runs.
    const result = await runSerializedPerKey(chain, 'bookA', async () => 'ok');
    expect(result).toBe('ok');
  });
});
