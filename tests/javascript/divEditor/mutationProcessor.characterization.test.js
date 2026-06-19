/**
 * Characterization of resources/js/divEditor/mutationProcessor.js — the
 * RAF-batched mutation queue. Pinned before .js → .ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ paste: false }));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  isPasteInProgress: () => state.paste,
  isProgrammaticUpdateInProgress: () => false,
  hypercitePasteInProgress: false,
  keyboardLayoutInProgress: false,
}));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({
  isChunkLoadingInProgress: () => false, getLoadingChunkId: () => null,
}));
vi.mock('../../../resources/js/editToolbar', () => ({ getEditToolbar: () => null }));

import { MutationProcessor } from '../../../resources/js/divEditor/mutationProcessor.js';

beforeEach(() => { state.paste = false; });

describe('MutationProcessor', () => {
  it('batches enqueued mutations and runs processMutations with the filtered set', async () => {
    const processMutations = vi.fn();
    const mp = new MutationProcessor({ processMutations });
    mp.enqueue(['a', 'b']);
    mp.enqueue(['c']);
    await mp.process();
    expect(processMutations).toHaveBeenCalledTimes(1);
    expect(processMutations).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('applies filterMutations before processing', async () => {
    const processMutations = vi.fn();
    const mp = new MutationProcessor({ processMutations, filterMutations: (m) => m.filter(x => x !== 'skip') });
    mp.enqueue(['keep', 'skip', 'keep2']);
    await mp.process();
    expect(processMutations).toHaveBeenCalledWith(['keep', 'keep2']);
  });

  it('does not process while a guard is active (paste) or shouldSkipMutation says so', async () => {
    const processMutations = vi.fn();

    state.paste = true;
    const mp1 = new MutationProcessor({ processMutations });
    mp1.enqueue(['x']);
    await mp1.process();
    expect(processMutations).not.toHaveBeenCalled();

    state.paste = false;
    const mp2 = new MutationProcessor({ processMutations, shouldSkipMutation: () => true });
    mp2.enqueue(['x']);
    await mp2.process();
    expect(processMutations).not.toHaveBeenCalled();
  });

  it('cancel() clears the queue and pending state', () => {
    const mp = new MutationProcessor({ processMutations: vi.fn() });
    mp.enqueue(['a', 'b']);
    expect(mp.hasPending).toBe(true);
    mp.cancel();
    expect(mp.hasPending).toBe(false);
    expect(mp.queue).toEqual([]);
  });
});
