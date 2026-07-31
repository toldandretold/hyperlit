/**
 * The audio trace ring (resources/js/components/audioPlayer/audioTrace.ts) is
 * the post-mortem for an intermittent stall, so the properties that matter are:
 * it never grows without bound, it reads back in the order things happened, and
 * it is reachable from the console / a Playwright evaluate.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  traceAudio, getAudioTrace, clearAudioTrace, audioTraceCap, installAudioTraceGlobal,
} from '../../../resources/js/components/audioPlayer/audioTrace';

function entry(event, i = 0) {
  return {
    t: i,
    event,
    index: i,
    nodeId: `node-${i}`,
    state: 'playing',
    readyState: 4,
    networkState: 1,
    paused: false,
    currentTime: i,
    playbackRate: 1,
    errorCode: null,
  };
}

beforeEach(() => {
  clearAudioTrace();
});

describe('audio trace ring', () => {
  it('reads back chronologically', () => {
    traceAudio(entry('node-start', 0));
    traceAudio(entry('playing', 1));
    traceAudio(entry('ended', 2));

    expect(getAudioTrace().map((e) => e.event)).toEqual(['node-start', 'playing', 'ended']);
  });

  it('is bounded — it drops the oldest instead of growing forever', () => {
    for (let i = 0; i < audioTraceCap + 50; i++) traceAudio(entry('tick', i));

    const trace = getAudioTrace();
    expect(trace).toHaveLength(audioTraceCap);
    // The 50 oldest fell off the front, and the order still holds.
    expect(trace[0].index).toBe(50);
    expect(trace.at(-1).index).toBe(audioTraceCap + 49);
  });

  it('stays chronological across several wraps', () => {
    for (let i = 0; i < audioTraceCap * 3 + 7; i++) traceAudio(entry('tick', i));

    const indices = getAudioTrace().map((e) => e.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('clears', () => {
    traceAudio(entry('playing', 1));
    clearAudioTrace();

    expect(getAudioTrace()).toEqual([]);
  });

  it('exposes an idempotent window handle for the console and e2e specs', () => {
    installAudioTraceGlobal();
    installAudioTraceGlobal();

    traceAudio(entry('watchdog', 3));

    expect(typeof window.__audioTrace.get).toBe('function');
    expect(window.__audioTrace.cap).toBe(audioTraceCap);
    expect(window.__audioTrace.get().map((e) => e.event)).toEqual(['watchdog']);

    window.__audioTrace.clear();
    expect(window.__audioTrace.get()).toEqual([]);
  });
});
