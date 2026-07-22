/**
 * measure — offscreen sweep loop-prevention regression.
 *
 * The 2026-07 "repeating highlights / cloudRef stuck orange" loop: a chunk
 * whose nodes yield no measurement (zero heights) qualified as "unmeasured" on
 * every restarted sweep, so it was re-rendered forever, and each render's
 * footnote self-heal fired a full save that starved the debounced server sync.
 * These tests lock the two sweep-side guarantees:
 *   1. offscreen renders are marked `offscreen: true` (render side effects off)
 *   2. an attempted chunk is never re-rendered by a later sweep, and a
 *      zero-gain slice reports no progress (no rebuild→sweep ping-pong)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startIdleSweep,
  clearMeasurements,
} from '../../../resources/js/components/customScrollbar/measure';
import { createChunkElement } from '../../../resources/js/lazyLoader/chunkRender';

vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  createChunkElement: vi.fn(() => {
    const div = document.createElement('div');
    div.setAttribute('data-chunk-id', '0');
    // happy-dom rects are all zeros, so every span height computes to 0 and
    // nothing gets cached — exactly the "unmeasurable chunk" loop bait.
    const p = document.createElement('p');
    p.id = '100';
    div.appendChild(p);
    return div;
  }),
}));

function sweepOpts(overrides = {}) {
  return {
    nodes: [
      {
        book: 'test-book',
        startLine: 100,
        chunk_id: 0,
        node_id: 'test-book_1',
        content: '<p>hello world</p>',
        hyperlights: [],
        hypercites: [],
        footnotes: [],
      },
    ],
    chunkIdsSorted: [0],
    currentChunkId: 0,
    bookId: 'test-book',
    containerWidth: 600,
    widthKey: '600x180',
    onProgress: vi.fn(),
    ...overrides,
  };
}

async function runSweep(opts) {
  await startIdleSweep(opts);
  await vi.runAllTimersAsync();
}

describe('startIdleSweep loop prevention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Force the deterministic setTimeout fallback inside idle()
    // (happy-dom may or may not provide requestIdleCallback).
    window.requestIdleCallback = undefined;
    clearMeasurements();
    vi.mocked(createChunkElement).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders offscreen copies with offscreen: true so the render stays side-effect-free', async () => {
    await runSweep(sweepOpts());

    expect(createChunkElement).toHaveBeenCalled();
    const [, instance] = vi.mocked(createChunkElement).mock.calls[0];
    expect(instance.offscreen).toBe(true);
  });

  it('never re-renders an attempted chunk, and a zero-gain slice reports no progress', async () => {
    const first = sweepOpts();
    await runSweep(first);

    expect(createChunkElement).toHaveBeenCalledTimes(1);
    // Zero heights measured → no progress callback → no rebuild→sweep ping-pong
    expect(first.onProgress).not.toHaveBeenCalled();

    // A restarted sweep (same layout) must skip the attempted chunk entirely,
    // even though its node is still unmeasured.
    const second = sweepOpts();
    await runSweep(second);

    expect(createChunkElement).toHaveBeenCalledTimes(1);
    expect(second.onProgress).not.toHaveBeenCalled();
  });

  it('clearMeasurements resets the attempted-chunk memory (layout change re-measures)', async () => {
    await runSweep(sweepOpts());
    expect(createChunkElement).toHaveBeenCalledTimes(1);

    clearMeasurements();
    await runSweep(sweepOpts());
    expect(createChunkElement).toHaveBeenCalledTimes(2);
  });
});
