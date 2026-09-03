/**
 * Regression tests for "playback randomly stops; you have to press prev/next to
 * get it going again" (resources/js/components/audioPlayer/playbackController.ts).
 *
 * That wasn't one bug — the engine had no failure handling at all. Only `ended`
 * was listened for, so any of these left the player silent while the pill still
 * claimed to be playing:
 *   1. a media `error` after play() had already resolved — nothing listened;
 *   2. an IndexedDB rejection inside next()'s playlist refresh, unhandled
 *      because the caller is `void this.next()`;
 *   3. a transient short IDB read shrinking the playlist, so relocate() clamped
 *      the index to the end and the next advance called stop() mid-book;
 *   4. an `ended` advance racing a user tap into AbortError, which the old catch
 *      misread as a bad node and silently SKIPPED a paragraph.
 * Plus the watchdog for stall shapes nobody enumerated.
 *
 * One test per cause. Fake timers throughout because the retry backoff and the
 * watchdog are both timer-driven.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { FakeAudio, installFakeAudio, currentAudio, domException } from './fakeAudio.js';
import {
  makeNodes, makeManifest, seedDom, makeCallbacks, useIdbNodes, useIdbHook, resetIdb,
  traceEvents,
} from './harness.js';

// Reads the globals directly rather than importing a helper: a dynamic import
// inside the factory doesn't settle under fake timers, which silently wedges
// every advance.
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
const { getAudioTrace, clearAudioTrace } = await import('../../../resources/js/components/audioPlayer/audioTrace');

const NODE_COUNT = 8;

let uninstall;
let controller;
let callbacks;
let nodes;
let manifest;

/** Drain the microtask queue. The advance path is a chain of awaited async
 *  calls (refreshPlaylist → IDB read → playCurrent → play), and each link needs
 *  its own checkpoint, so one `await` is nowhere near enough. */
async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Advance fake time AND drain the promise chains it releases. */
async function adv(ms = 0) {
  await flush();
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearAudioTrace();
  uninstall = installFakeAudio();
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
  nodes = makeNodes(NODE_COUNT);
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
  vi.useRealTimers();
});

async function endCurrentNode() {
  currentAudio()._end();
  await adv(); // the `ended` handler is fire-and-forget
}

describe('cause 1 — a media error after playback started', () => {
  it('retries the same paragraph from where it died instead of going silent', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio._tick(3); // three seconds in

    audio._error(2); // network died mid-download
    await adv(700); // past the 600ms backoff

    expect(audio.srcHistory.at(-1)).toContain('n0.mp3');
    expect(audio.currentTime).toBeCloseTo(2.5, 5); // resumed just before the gap
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    expect(traceEvents(getAudioTrace(), 'retry')).toHaveLength(1);
    expect(traceEvents(getAudioTrace(), 'skip')).toHaveLength(0);
  });

  it('skips to the next paragraph when the retry fails too', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio._error(2);
    await adv(700);

    audio._error(2); // the retry died as well
    await adv(50);

    expect(audio.srcHistory.at(-1)).toContain('n1.mp3');
    expect(traceEvents(getAudioTrace(), 'skip')).toHaveLength(1);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('counts a doubly-signalled load failure as ONE failure, so the retry survives', async () => {
    // Found by the e2e trace ring: a 404 makes the element fire `error` AND
    // reject play(). Both funnel into recoverFrom, and the second call used to
    // land mid-backoff, see the retry already spent, and skip immediately — so
    // "retry once, then skip" never retried anything.
    await controller.start(manifest);
    const broken = nodes[1].node_id;
    // Count per NODE: once this paragraph is given up on, playback moves to the
    // next one, which is broken too — the invariant is one retry each, not one
    // retry in the whole run.
    const forBroken = (event) => getAudioTrace().filter((e) => e.event === event && e.nodeId === broken);

    currentAudio()._failSource(4);
    await controller.next(); // node 1's source is broken
    await adv(100); // still inside the 600ms backoff

    expect(forBroken('retry'), 'exactly one retry was started').toHaveLength(1);
    expect(forBroken('skip'), 'and it has not skipped yet — the backoff is still running').toHaveLength(0);

    await adv(700); // let the retry run and fail the same way

    expect(forBroken('retry'), 'still just the one retry for that paragraph').toHaveLength(1);
    expect(forBroken('skip'), 'then it moved on').toHaveLength(1);
  });

  it('stops once after a run of unplayable paragraphs rather than racing to the end', async () => {
    // The element exists from the constructor, so the failure is armed before
    // the very first play() — every paragraph in the book is unplayable.
    currentAudio().playBehaviour = async () => { throw new TypeError('network down'); };

    const started = controller.start(manifest);
    await adv(6000); // 6 paragraphs × the 600ms retry backoff
    await started;

    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('idle');
    expect(traceEvents(getAudioTrace(), 'skip')).toHaveLength(6); // bounded at 5 + the stopping one
  });
});

describe('cause 2 — an IndexedDB rejection during the advance', () => {
  it('keeps advancing on the cached playlist instead of dying silently', async () => {
    await controller.start(manifest);
    useIdbHook(() => { throw new Error('IDB closed during SPA nav'); });

    await endCurrentNode();

    expect(currentAudio().srcHistory.at(-1)).toContain('n1.mp3');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('playing');
  });
});

describe('cause 3 — a short or empty playlist re-read', () => {
  it('ignores an empty re-read rather than letting the playlist collapse', async () => {
    await controller.start(manifest);
    useIdbHook(async () => []);

    await endCurrentNode();

    expect(traceEvents(getAudioTrace(), 'refresh-rejected')).toHaveLength(1);
    expect(currentAudio().srcHistory.at(-1)).toContain('n1.mp3');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('ignores a re-read that lost the paragraph currently playing', async () => {
    await controller.start(manifest);
    await endCurrentNode(); // on node 1
    useIdbHook(async () => nodes.filter((n) => n.node_id !== nodes[1].node_id));

    await endCurrentNode();

    expect(traceEvents(getAudioTrace(), 'refresh-rejected')).toHaveLength(1);
    expect(currentAudio().srcHistory.at(-1)).toContain('n2.mp3');
  });

  it('accepts the re-read after three rejections, so a genuinely shortened book is not frozen', async () => {
    await controller.start(manifest);
    useIdbHook(async () => []);

    await endCurrentNode(); // rejected 1
    await endCurrentNode(); // rejected 2
    await endCurrentNode(); // rejected 3
    expect(traceEvents(getAudioTrace(), 'refresh-rejected')).toHaveLength(3);

    await endCurrentNode(); // accepted — the book really is empty now

    expect(traceEvents(getAudioTrace(), 'refresh-rejected')).toHaveLength(3);
    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
  });

  it('relocates positionally when the current paragraph vanishes, not to the end of the book', async () => {
    await controller.start(manifest);
    await endCurrentNode();
    await endCurrentNode(); // playing node 2

    const trimmed = { voice: null, nodes: { ...manifest.nodes } };
    delete trimmed.nodes[nodes[2].node_id];
    controller.updatePlaylist(trimmed);

    await controller.next();

    // Old behaviour clamped the index, which skipped ahead (or, on a bigger
    // shrink, ran off the end and called stop()). It should resume with the
    // paragraph immediately after the one that vanished.
    expect(currentAudio().srcHistory.at(-1)).toContain('n3.mp3');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });
});

describe('cause 4 — an advance racing a transport tap', () => {
  it('treats AbortError as superseded, never as a bad paragraph', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio.playBehaviour = async () => { throw domException('AbortError'); };

    await controller.next();
    await adv(50);

    expect(traceEvents(getAudioTrace(), 'play-aborted')).toHaveLength(1);
    expect(traceEvents(getAudioTrace(), 'skip')).toHaveLength(0);
    expect(traceEvents(getAudioTrace(), 'retry')).toHaveLength(0);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('lands on exactly one paragraph when an ended-advance and a tap overlap', async () => {
    await controller.start(manifest);
    const audio = currentAudio();

    let rejectHungPlay;
    audio.playBehaviour = () => new Promise((_resolve, reject) => { rejectHungPlay = reject; });

    audio._end();      // ended → next() → playCurrent(node 1) hangs inside play()
    await adv(5);

    audio.playBehaviour = async () => {}; // the tap's load will succeed
    const tapped = controller.next();     // user hits next while node 1 is still loading
    await adv(5);

    rejectHungPlay(domException('AbortError')); // the superseded load gives up
    await tapped;
    await adv(50);

    expect(audio.srcHistory.at(-1)).toContain('n2.mp3');
    expect(traceEvents(getAudioTrace(), 'skip')).toHaveLength(0);
    expect(controller.getState()).toBe('playing');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });
});

describe('the watchdog', () => {
  it('recovers a paragraph whose playback froze with no event at all', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio.duration = 100;
    audio.currentTime = 5; // mid-paragraph, then nothing ever moves again

    await adv(7000);

    expect(traceEvents(getAudioTrace(), 'watchdog').length).toBeGreaterThanOrEqual(1);
    expect(traceEvents(getAudioTrace(), 'retry')).toHaveLength(1);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('advances when a paragraph finished but `ended` never fired', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio.duration = 10;
    audio.currentTime = 9.9;

    await adv(7000);

    expect(traceEvents(getAudioTrace(), 'watchdog-ended')).toHaveLength(1);
    expect(audio.srcHistory.at(-1)).toContain('n1.mp3');
  });

  it('advances when the `ended` event is lost entirely and the element sits paused at the end', async () => {
    // Spec ordering: at end-of-media the element sets ended/paused FIRST, then
    // fires `pause` and `ended`. The pause listener sees ended=true and defers
    // to the `ended` handler — so if the browser loses that event, the element
    // is paused (the watchdog's old early-return) with state still 'playing':
    // playback died with no event, no trace, and no recovery. The watchdog must
    // own this shape.
    await controller.start(manifest);
    const audio = currentAudio();
    audio.duration = 10;
    audio._endWithoutEndedEvent();
    await adv(0);

    expect(controller.getState(), 'the swallowed pause must not surface as paused').toBe('playing');

    await adv(7000);

    expect(traceEvents(getAudioTrace(), 'watchdog-ended')).toHaveLength(1);
    expect(audio.srcHistory.at(-1)).toContain('n1.mp3');
    expect(controller.getState()).toBe('playing');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('gives genuine buffering much longer before intervening', async () => {
    await controller.start(manifest);
    const audio = currentAudio();
    audio.duration = 100;
    audio.readyState = 2; // HAVE_CURRENT_DATA — still filling the buffer

    await adv(10_000);
    expect(traceEvents(getAudioTrace(), 'watchdog')).toHaveLength(0);

    await adv(7000);
    expect(traceEvents(getAudioTrace(), 'watchdog').length).toBeGreaterThanOrEqual(1);
  });

  it('stops running once playback is not playing', async () => {
    await controller.start(manifest);
    currentAudio().duration = 100;
    controller.pause();

    await adv(30_000);

    expect(traceEvents(getAudioTrace(), 'watchdog')).toHaveLength(0);
  });
});

describe('teardown and external pauses', () => {
  it('does not mistake its own stop() teardown for a failure', async () => {
    await controller.start(manifest);
    controller.stop();

    currentAudio()._error(2); // Chrome fires this while the source is torn down
    await adv(1000);

    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('idle');
    expect(traceEvents(getAudioTrace(), 'error-quiescent')).toHaveLength(1);
    expect(traceEvents(getAudioTrace(), 'retry')).toHaveLength(0);
  });

  it('surfaces an OS/tab pause so the pill offers Play instead of lying', async () => {
    await controller.start(manifest);
    callbacks.onStateChange.mockClear();

    currentAudio()._osPause();

    expect(callbacks.onStateChange).toHaveBeenCalledWith('paused');
    expect(controller.getState()).toBe('paused');
    expect(traceEvents(getAudioTrace(), 'pause')).toHaveLength(1);
  });

  it('stays quiet when the pause was our own', async () => {
    await controller.start(manifest);

    controller.pause();

    expect(controller.getState()).toBe('paused');
    expect(traceEvents(getAudioTrace(), 'pause')).toHaveLength(0);
  });

  it('fingerprints every public pause/resume in the trace ring', async () => {
    // pause() is reachable with NO gesture on the page — the mediaSession
    // 'pause' action fires for hardware media keys, AirPods ear-detection, and
    // screen lock. It used to be the one state change the ring could not see:
    // an e2e run stalled mid-book with a trace that just went silent
    // (2026-09-03 post-mortem). The ring must record the request itself.
    await controller.start(manifest);

    controller.pause();
    await controller.resume();

    expect(traceEvents(getAudioTrace(), 'pause-requested')).toHaveLength(1);
    expect(traceEvents(getAudioTrace(), 'resume-requested')).toHaveLength(1);
  });

  it('does not leave expectPause armed to swallow the next real one', async () => {
    await controller.start(manifest);
    controller.pause();      // arms and consumes the flag
    await controller.resume();

    currentAudio()._osPause(); // a genuine external pause, right after

    expect(traceEvents(getAudioTrace(), 'pause')).toHaveLength(1);
  });
});
