/**
 * The generation poll's stall watchdog
 * (resources/js/components/audioPlayer/generation.ts).
 *
 * The reported bug: press Listen, the pill says "Generating audio…", and it
 * stays that way forever with nothing running. The poll only ever stopped on a
 * terminal status, and a job killed without its failed() handler leaves a
 * progress file frozen on `generating` — so no terminal status was ever coming.
 *
 * The server now detects a cold heartbeat too; this is the client-side
 * backstop for "progress keeps being served but never advances".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({ ensureCsrfToken: vi.fn(async () => 't') }));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => undefined),
}));

const progressQueue = [];
vi.mock('../../../resources/js/components/audioPlayer/manifest', () => ({
  fetchAudioProgress: vi.fn(async () => (progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0])),
  fetchAudioStatus: vi.fn(async () => null),
}));

const { pollGenerationProgress, stopProgressPolling } = await import(
  '../../../resources/js/components/audioPlayer/generation'
);

const POLL_MS = 2000;
/** Must match STALL_BEATS in generation.ts. */
const STALL_BEATS = 90;

function beat(overrides = {}) {
  return {
    status: 'generating',
    stage: 'narrating',
    done_nodes: 3,
    total_nodes: 100,
    updated_at: '2026-07-31T00:00:00+00:00',
    ...overrides,
  };
}

let onBeat;
let onDone;

beforeEach(async () => {
  vi.useFakeTimers();
  progressQueue.length = 0;
  onBeat = vi.fn();
  onDone = vi.fn();
  // Restore the queue-driven default: a test that swaps in its own
  // implementation would otherwise leak it into every test after it.
  const { fetchAudioProgress } = await import('../../../resources/js/components/audioPlayer/manifest');
  fetchAudioProgress.mockImplementation(async () => (
    progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0]
  ));
});

afterEach(() => {
  stopProgressPolling();
  vi.useRealTimers();
});

async function advanceBeats(n) {
  await vi.advanceTimersByTimeAsync(n * POLL_MS + 10);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('stall watchdog', () => {
  it('gives up on a run whose heartbeat never moves, instead of polling forever', async () => {
    progressQueue.push(beat()); // identical every single time — a corpse
    pollGenerationProgress('book_1', onBeat, onDone);

    await advanceBeats(STALL_BEATS - 2);
    expect(onDone, 'still patient before the threshold').not.toHaveBeenCalled();

    await advanceBeats(4);

    expect(onDone).toHaveBeenCalledTimes(1);
    const reported = onDone.mock.calls[0][0];
    expect(reported.status).toBe('failed');
    expect(reported.error).toContain('Press Listen');
  });

  it('stops polling once it has given up', async () => {
    progressQueue.push(beat());
    pollGenerationProgress('book_1', onBeat, onDone);
    await advanceBeats(STALL_BEATS + 2);
    const beatsAtGiveUp = onBeat.mock.calls.length;

    await advanceBeats(30);

    expect(onBeat.mock.calls.length).toBe(beatsAtGiveUp);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('never fires while the heartbeat is advancing, however long the book', async () => {
    // A genuinely long run must not be mistaken for a dead one.
    let tick = 0;
    progressQueue.push(beat());
    const { fetchAudioProgress } = await import('../../../resources/js/components/audioPlayer/manifest');
    fetchAudioProgress.mockImplementation(async () => beat({
      done_nodes: ++tick,
      updated_at: new Date(1785000000000 + tick * 1000).toISOString(),
    }));

    pollGenerationProgress('book_1', onBeat, onDone);
    await advanceBeats(STALL_BEATS * 3);

    expect(onDone).not.toHaveBeenCalled();
    expect(onBeat.mock.calls.length).toBeGreaterThan(STALL_BEATS);
  });

  it('resets its patience when progress resumes after a pause', async () => {
    const { fetchAudioProgress } = await import('../../../resources/js/components/audioPlayer/manifest');
    let calls = 0;
    fetchAudioProgress.mockImplementation(async () => {
      calls++;
      // Long quiet stretch, then movement, then quiet again — neither stretch
      // alone reaches the threshold, so it must never give up.
      const moved = calls > STALL_BEATS - 10 ? 1 : 0;

      return beat({ done_nodes: moved, updated_at: `2026-07-31T00:00:0${moved}+00:00` });
    });

    pollGenerationProgress('book_1', onBeat, onDone);
    await advanceBeats(STALL_BEATS + 5);

    expect(onDone).not.toHaveBeenCalled();
  });

  it('still reports a real terminal status immediately', async () => {
    progressQueue.push(beat(), beat({ status: 'done' }));
    pollGenerationProgress('book_1', onBeat, onDone);

    await advanceBeats(3);

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0].status).toBe('done');
  });

  it('passes a continuation hand-off straight through as ongoing progress', async () => {
    // A long book's job hands off to a fresh one mid-run; the user should see
    // one continuous run, not a failure.
    progressQueue.push(beat({ stage: 'continuing', done_nodes: 40, updated_at: '2026-07-31T00:01:00+00:00' }));
    pollGenerationProgress('book_1', onBeat, onDone);

    await advanceBeats(3);

    expect(onDone).not.toHaveBeenCalled();
    expect(onBeat).toHaveBeenCalled();
    expect(onBeat.mock.calls.at(-1)[0].stage).toBe('continuing');
  });
});
