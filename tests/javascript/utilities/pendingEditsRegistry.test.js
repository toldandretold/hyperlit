/**
 * Unit tests for the pendingEditsRegistry leaf — the DI seam that lets the
 * orchestrator/sync layer flush the editor + footnote buffers on close/unload WITHOUT
 * importing those feature modules (replacing the dynamic-import cycle-breakers).
 *
 * The registry is a module singleton (the flusher Set persists across tests), so each
 * test registers its OWN spies and asserts on those — accumulation-tolerant.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  registerPendingEditFlush,
  flushPendingEdits,
} from '../../../resources/js/utilities/pendingEditsRegistry';

describe('pendingEditsRegistry', () => {
  it('calls every registered flush, awaiting async ones', async () => {
    const sync = vi.fn();
    let asyncDone = false;
    const asyncFlush = vi.fn(async () => {
      await Promise.resolve();
      asyncDone = true;
    });
    registerPendingEditFlush(sync);
    registerPendingEditFlush(asyncFlush);

    await flushPendingEdits();

    expect(sync).toHaveBeenCalledOnce();
    expect(asyncFlush).toHaveBeenCalledOnce();
    expect(asyncDone).toBe(true); // proves it awaited the async flush
  });

  it('runs flushes in registration order', async () => {
    const order = [];
    registerPendingEditFlush(() => order.push('first'));
    registerPendingEditFlush(() => order.push('second'));

    await flushPendingEdits();

    const i = order.indexOf('first');
    const j = order.indexOf('second');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBe(i + 1); // consecutively registered → consecutive, in order
  });

  it('a throwing flush does not stop the others', async () => {
    const after = vi.fn();
    registerPendingEditFlush(() => { throw new Error('boom'); });
    registerPendingEditFlush(after);

    await expect(flushPendingEdits()).resolves.toBeUndefined(); // does not reject
    expect(after).toHaveBeenCalledOnce();
  });
});
