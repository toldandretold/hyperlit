/**
 * utilities/newBookEstablished — the ONE "does the server have this book yet"
 * signal. Its three contract properties are the whole reason it exists, and each
 * one is a bug that shipped:
 *
 *   1. never rejects  — a raw rejected promise killed masterSync's drain, which
 *                       awaited it BEFORE clearing the queue, so one failed
 *                       create stopped all syncing for the tab, silently.
 *   2. always settles — a hung handshake must not park a consumer forever.
 *   3. retires itself — a settled handshake must never gate a later push (the
 *                       SPA create path never cleared the old holder).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  trackNewBookEstablishment,
  whenNewBookEstablished,
  getEstablishingBookId,
  getLastEstablishment,
  __resetNewBookEstablishmentForTests,
} from '../../../resources/js/utilities/newBookEstablished';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Watch a promise without awaiting it (see flushDurability.test.js for why race() can't do this). */
function watch(promise) {
  const state = { settled: false, value: undefined };
  promise.then((value) => { state.settled = true; state.value = value; });
  return state;
}

describe('newBookEstablished', () => {
  beforeEach(() => {
    __resetNewBookEstablishmentForTests();
    vi.useRealTimers();
  });

  it('resolves immediately with reason "none" when no book is being created', async () => {
    await expect(whenNewBookEstablished()).resolves.toEqual({
      bookId: null, established: false, reason: 'none',
    });
  });

  it('resolves "established" once the handshake lands, and reports the book meanwhile', async () => {
    let land;
    const handshake = new Promise((resolve) => { land = resolve; });
    const tracked = trackNewBookEstablishment('book_1', handshake);

    expect(getEstablishingBookId()).toBe('book_1');
    const waiter = watch(whenNewBookEstablished(5_000));
    await tick(20);
    expect(waiter.settled).toBe(false);

    land();
    await expect(tracked).resolves.toEqual({
      bookId: 'book_1', established: true, reason: 'established',
    });
  });

  it('NEVER rejects — a failed handshake becomes a result, not a throw', async () => {
    const boom = new Error('bulk-create failed');
    const tracked = trackNewBookEstablishment('book_2', Promise.reject(boom));

    // Both the tracker and a waiter resolve; neither throws.
    await expect(tracked).resolves.toEqual({
      bookId: 'book_2', established: false, reason: 'failed', error: boom,
    });
    await expect(whenNewBookEstablished()).resolves.toEqual({
      bookId: null, established: false, reason: 'none',
    });
  });

  it('RETIRES itself on settle, so a finished handshake can never gate a later push', async () => {
    const tracked = trackNewBookEstablishment('book_3', Promise.resolve('ok'));
    await tracked;

    expect(getEstablishingBookId()).toBeNull();
    await expect(whenNewBookEstablished()).resolves.toMatchObject({ reason: 'none' });
    expect(getLastEstablishment()).toMatchObject({ bookId: 'book_3', established: true });
  });

  it('ALWAYS settles — a handshake that never lands times out instead of hanging the caller', async () => {
    trackNewBookEstablishment('book_4', new Promise(() => {}));

    const waiter = watch(whenNewBookEstablished(80));
    await tick(20);
    expect(waiter.settled).toBe(false);

    await tick(120);
    expect(waiter.value).toEqual({ bookId: 'book_4', established: false, reason: 'timeout' });

    // A timeout does NOT retire it — it may still land, so the next caller waits again.
    expect(getEstablishingBookId()).toBe('book_4');
  });

  it('a second create replaces the first as the tracked handshake', async () => {
    trackNewBookEstablishment('book_5', new Promise(() => {}));
    const second = trackNewBookEstablishment('book_6', Promise.resolve('ok'));

    expect(getEstablishingBookId()).toBe('book_6');
    await second;
    expect(getEstablishingBookId()).toBeNull();
  });
});
