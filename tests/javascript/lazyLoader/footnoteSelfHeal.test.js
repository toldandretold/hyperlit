/**
 * footnoteSelfHeal — render-time write-back convergence guards.
 *
 * The 2026-07 save loop: the heal persists from the LIVE DOM, so when that DOM
 * carries the same stale fn-count-id (or the node isn't rendered), the write is
 * a no-op and every re-render of the chunk re-queued it — an endless stream of
 * full saves that starved the debounced server sync (cloudRef stuck orange).
 * Locks:
 *   1. a mutated node queues exactly ONE write-back per session, even when the
 *      same stale content renders again
 *   2. an empty node context (offscreen measurement copies) never queues at all
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyDynamicFootnoteNumbers } from '../../../resources/js/lazyLoader/footnoteSelfHeal';
import { batchUpdateIndexedDBRecords } from '../../../resources/js/indexedDB/nodes/batch';

vi.mock('../../../resources/js/indexedDB/nodes/batch', () => ({
  batchUpdateIndexedDBRecords: vi.fn(async () => {}),
}));

vi.mock('../../../resources/js/footnotes/FootnoteNumberingService', () => ({
  // Dynamic map always disagrees with the stored value below → every render mutates
  getDisplayNumber: vi.fn(() => 7),
}));

function staleNodeElement() {
  const el = document.createElement('div');
  el.innerHTML = '<p><sup fn-count-id="3"><a class="footnote-ref" href="#fn1">3</a></sup></p>';
  return el;
}

async function flushHealTimer() {
  // The flush is a setTimeout(0) + dynamic import — a couple of macrotask turns
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('applyDynamicFootnoteNumbers self-heal queueing', () => {
  beforeEach(() => {
    vi.mocked(batchUpdateIndexedDBRecords).mockClear();
  });

  it('rewrites the number and queues one write-back for a live render', async () => {
    const el = staleNodeElement();
    applyDynamicFootnoteNumbers(el, { startLine: 100, bookId: 'bookA' });

    // The rendered copy is corrected regardless of queueing
    expect(el.querySelector('sup').getAttribute('fn-count-id')).toBe('7');
    expect(el.querySelector('a').textContent).toBe('7');

    await flushHealTimer();
    expect(batchUpdateIndexedDBRecords).toHaveBeenCalledTimes(1);
    expect(batchUpdateIndexedDBRecords).toHaveBeenCalledWith(
      [{ id: '100' }],
      { bookId: 'bookA', skipFootnoteRenumber: true },
    );
  });

  it('does NOT re-queue the same node when stale content renders again (no save loop)', async () => {
    applyDynamicFootnoteNumbers(staleNodeElement(), { startLine: 200, bookId: 'bookB' });
    await flushHealTimer();
    expect(batchUpdateIndexedDBRecords).toHaveBeenCalledTimes(1);

    // Same node renders again, still stale (the heal didn't converge) — one
    // attempt per session, no second save.
    applyDynamicFootnoteNumbers(staleNodeElement(), { startLine: 200, bookId: 'bookB' });
    await flushHealTimer();
    expect(batchUpdateIndexedDBRecords).toHaveBeenCalledTimes(1);
  });

  it('never queues without a node context (offscreen measurement copies)', async () => {
    const el = staleNodeElement();
    applyDynamicFootnoteNumbers(el, {});

    // Numbers still corrected — measurement needs the real glyphs
    expect(el.querySelector('sup').getAttribute('fn-count-id')).toBe('7');

    await flushHealTimer();
    expect(batchUpdateIndexedDBRecords).not.toHaveBeenCalled();
  });
});
