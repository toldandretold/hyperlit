/**
 * Guard test for `queueNodeForSave` (resources/js/divEditor/index.js).
 *
 * Only numeric (or decimal) startLine ids are real content nodes / DB rows.
 * Inline markers — footnote-refs (`Fn…`), hypercites (`hypercite_…`) — and DOM-only
 * scroll sentinels (`…-sentinel`) live INSIDE a parent node's HTML (or aren't persisted
 * at all) and must never be enqueued by their own id. When one slipped through (e.g. an
 * attribute mutation on a `<sup class="footnote-ref">` while typing), batch.ts rejected it
 * and escalated to a scary `batch-invalid-id` integrity report despite nothing being wrong.
 *
 * The guard drops non-numeric ids at the single enqueue chokepoint. We assert it here via
 * an observable seam that needs no editor/IndexedDB setup: the guard runs BEFORE the
 * `if (!saveQueue)` check, so with `saveQueue` uninitialised a *valid* id falls through to
 * the "SaveQueue not initialized" warning, while a *rejected* id returns silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queueNodeForSave } from '../../../resources/js/divEditor/index.js';

const NOT_INITIALISED = '⚠️ SaveQueue not initialized, cannot queue node';

function passedGuard(warnSpy) {
  // Reaching the not-initialised warn means the id cleared the numeric guard.
  return warnSpy.mock.calls.some(args => String(args[0]).includes(NOT_INITIALISED));
}

describe('queueNodeForSave numeric-id guard', () => {
  let warnSpy;

  beforeEach(() => {
    // saveQueue is null until startObserving() runs, which is exactly the state we want:
    // a passed-guard id then trips the not-initialised warning, a dropped id stays silent.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each([
    ['integer startLine', '3100'],
    ['decimal startLine', '6498.1'],
  ])('lets a real content node through the guard (%s)', (_label, id) => {
    queueNodeForSave(id, 'update');
    expect(passedGuard(warnSpy)).toBe(true);
  });

  it.each([
    ['footnote-ref marker', 'Fn1779059881509_8gp0'],
    ['hypercite marker', 'hypercite_12345'],
    ['scroll sentinel', 'book_1769036890566-top-sentinel'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('drops a non-content id silently (%s)', (_label, id) => {
    queueNodeForSave(id, 'update');
    // Never reaches the not-initialised branch — it returned at the guard.
    expect(passedGuard(warnSpy)).toBe(false);
  });
});
