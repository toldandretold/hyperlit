/**
 * Regression test for "set 1.5×, the next paragraph plays at 1× but the pill
 * still says 1.5×" (resources/js/components/audioPlayer/playbackController.ts).
 *
 * The bug: playCurrent() set `playbackRate` and THEN assigned `.src`. Assigning
 * src runs the HTML media load algorithm, which resets playbackRate to
 * defaultPlaybackRate — and defaultPlaybackRate was never set, so it stayed 1.
 * The chosen speed therefore survived exactly one paragraph.
 *
 * FakeAudio's src setter reproduces that reset faithfully (see fakeAudio.js), so
 * these tests fail against the old code rather than passing vacuously.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { FakeAudio, installFakeAudio, currentAudio } from './fakeAudio.js';
import {
  makeNodes, makeManifest, seedDom, makeCallbacks, useIdbNodes, resetIdb,
  readNodesForTest, settle,
} from './harness.js';

vi.mock('../../../resources/js/indexedDB/nodes/read', () => ({
  getNodesFromIndexedDB: vi.fn(async () => {
    if (globalThis.__idbHook) return globalThis.__idbHook();

    return globalThis.__idbNodes ?? [];
  }),
}));
vi.mock('../../../resources/js/scrolling/readingAnchor', () => ({ getFreshAnchor: () => null }));
vi.mock('../../../resources/js/scrolling/internalNav', () => ({ navigateToInternalId: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/pageLoad/currentLazyLoaderState', () => ({ currentLazyLoader: null }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));

const { PlaybackController } = await import('../../../resources/js/components/audioPlayer/playbackController');

let uninstall;
let controller;
let callbacks;
let nodes;
let manifest;

beforeEach(() => {
  localStorage.clear();
  uninstall = installFakeAudio();
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
  nodes = makeNodes(5);
  manifest = makeManifest(nodes);
  seedDom(nodes);
  useIdbNodes(nodes);
  callbacks = makeCallbacks();
  controller = new PlaybackController('book_1', callbacks);
});

afterEach(() => {
  controller.destroy();
  uninstall();
  resetIdb();
  FakeAudio.instances.length = 0;
});

/** The 'ended' handler is fire-and-forget, so give the advance time to land. */
async function advanceByEnding() {
  currentAudio()._end();
  await settle();
}

describe('playback speed continuity', () => {
  it('carries the chosen speed into the next paragraph', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    expect(audio.playbackRate).toBe(1);

    expect(controller.cycleSpeed()).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);

    await advanceByEnding();

    expect(audio.srcHistory.at(-1)).toContain('n1.mp3');
    expect(audio.playbackRate).toBe(1.25);
  });

  it('holds the speed across several paragraph boundaries', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    controller.cycleSpeed();
    controller.cycleSpeed(); // 1.5

    await advanceByEnding();
    await advanceByEnding();
    await advanceByEnding();

    expect(audio.srcHistory.at(-1)).toContain('n3.mp3');
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.defaultPlaybackRate).toBe(1.5);
  });

  it('walks the whole 1 / 1.25 / 1.5 / 1.75 / 2 ladder and wraps', async () => {
    await controller.start(manifest);
    expect(controller.cycleSpeed()).toBe(1.25);
    expect(controller.cycleSpeed()).toBe(1.5);
    expect(controller.cycleSpeed()).toBe(1.75);
    expect(controller.cycleSpeed()).toBe(2);
    expect(controller.cycleSpeed()).toBe(1);
  });

  it('applies a speed chosen while paused to the next paragraph', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    controller.pause();

    controller.cycleSpeed();
    controller.cycleSpeed(); // 1.5 while paused

    await controller.next();

    expect(audio.srcHistory.at(-1)).toContain('n1.mp3');
    expect(audio.playbackRate).toBe(1.5);
  });

  it('applies a speed chosen while idle to the first paragraph of the next run', async () => {
    await controller.start(manifest);
    controller.stop();

    controller.cycleSpeed(); // 1.25 with no source loaded at all

    await controller.start(manifest);

    expect(currentAudio().playbackRate).toBe(1.25);
  });

  it('keeps defaultPlaybackRate and playbackRate in lockstep after every advance', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    controller.cycleSpeed(); // 1.25

    for (let i = 0; i < 3; i++) {
      await advanceByEnding();
      expect(audio.defaultPlaybackRate).toBe(audio.playbackRate);
      expect(audio.playbackRate).toBe(1.25);
    }
  });

  it('persists the speed so a new controller starts at it', async () => {
    await controller.start(manifest);
    controller.cycleSpeed();
    controller.cycleSpeed();
    controller.cycleSpeed(); // 1.75
    controller.destroy();

    const revived = new PlaybackController('book_1', makeCallbacks());
    await revived.start(manifest);
    expect(revived.getSpeed()).toBe(1.75);
    expect(currentAudio().playbackRate).toBe(1.75);
    revived.destroy();
  });

  it('exposes the engine speed to the pill on every entry change', async () => {
    await controller.start(manifest);
    controller.cycleSpeed(); // 1.25
    callbacks.onEntryChange.mockClear();

    await advanceByEnding();

    // index.ts reads getSpeed() inside onEntryChange, which is what stops the
    // pill's label drifting away from what is actually playing.
    expect(callbacks.onEntryChange).toHaveBeenCalledTimes(1);
    expect(controller.getSpeed()).toBe(1.25);
  });
});
