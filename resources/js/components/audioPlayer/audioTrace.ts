// Bounded in-memory ring of audio-player events. Exists because "playback
// randomly stops" is intermittent and invisible after the fact: by the time a
// user notices, the media element's state tells you nothing about HOW it got
// there (a dead element looks identical whether it errored, was superseded by a
// racing load, or lost its playlist).
//
// Cheap enough to leave on in production — one object literal per event, no
// strings, no logging — and exposed on `window.__audioTrace` so both the e2e
// specs and a real user's console can read back the last few minutes of player
// history. The e2e specs NEED it: the <audio> element is detached (never in the
// DOM), so a Playwright locator can't reach it and this ring is the only probe.

export interface AudioTraceEntry {
  /** ms since page load. */
  t: number;
  /** 'node-start' | 'playing' | 'ended' | 'error' | 'watchdog' | … */
  event: string;
  index: number;
  nodeId: string | null;
  state: string;
  readyState: number;
  networkState: number;
  paused: boolean;
  currentTime: number;
  playbackRate: number;
  /** MediaError.code when there is one. */
  errorCode: number | null;
}

const CAP = 300;

const ring: (AudioTraceEntry | undefined)[] = new Array<AudioTraceEntry | undefined>(CAP);
let cursor = 0;
let total = 0;

export function traceAudio(entry: AudioTraceEntry): void {
  ring[cursor] = entry;
  cursor = (cursor + 1) % CAP;
  total++;
}

/** Chronological, oldest first. */
export function getAudioTrace(): AudioTraceEntry[] {
  const out: AudioTraceEntry[] = [];
  const start = total < CAP ? 0 : cursor;
  const count = Math.min(total, CAP);
  for (let i = 0; i < count; i++) {
    const entry = ring[(start + i) % CAP];
    if (entry) out.push(entry);
  }

  return out;
}

export function clearAudioTrace(): void {
  ring.fill(undefined);
  cursor = 0;
  total = 0;
}

/** How many entries the ring holds before it wraps. */
export const audioTraceCap = CAP;

/**
 * Idempotent. Called from initAudioPlayer. Deliberately NOT dev-gated — the
 * whole point is diagnosing a stall that only reproduces in production. It's an
 * inert data accessor with no listeners, so it has no SPA lifecycle hazard and
 * is never removed.
 */
export function installAudioTraceGlobal(): void {
  (window as unknown as Record<string, unknown>).__audioTrace = {
    get: getAudioTrace,
    clear: clearAudioTrace,
    cap: CAP,
  };
}
