/**
 * "Is this brand-new book established on the server yet?" — ONE signal, one owner.
 *
 * A book is created optimistically: `createNewBook` writes the library row and
 * the initial `<h1>` straight into IndexedDB and the reader opens on it, so the
 * user can type into a book the server has never heard of. Everything that
 * pushes to the server during that window (masterSync's drain, the paste sync,
 * the post-create content sync) has to wait for the bulk-create handshake to
 * land, or its writes hit a book that doesn't exist.
 *
 * That condition used to be guarded by four separate mechanisms — a raw promise
 * parked in operationState, a `pending_new_book_sync` sessionStorage marker, a
 * 2-second setTimeout in NewBookTransition, and base_timestamp adoption
 * branches. This module replaces the first and third with a single signal whose
 * contract is the point:
 *
 *   - it ALWAYS settles (a hung handshake resolves as `timeout`, never hangs a
 *     consumer),
 *   - it NEVER rejects (a failed handshake resolves as `failed`, so a consumer
 *     that forgot a try/catch cannot be killed by it),
 *   - it retires itself the moment it settles (a settled handshake can never be
 *     re-awaited by a later caller).
 *
 * All three exist because of one bug: as a bare stored promise that rejected and
 * was never cleared, a single failed create wedged masterSync's drain for the
 * rest of the tab's life — every later drain threw at the gate before cutting a
 * batch, so nothing reached the server again, for any book, silently. See
 * CLAUDE.md §"Flushing before a wipe reports, it doesn't assume".
 *
 * ZERO IMPORTS on purpose: this is shared state read by the data layer, the SPA
 * layer and the page-load layer, so it must be a leaf (see the circular-import
 * TDZ class of bugs). The sessionStorage marker is deliberately NOT folded in —
 * it answers a different question ("was a book created in this tab", surviving a
 * reload) and has its own consumers.
 */

export type EstablishmentReason = 'none' | 'established' | 'failed' | 'timeout';

export interface EstablishmentResult {
  /** The book the handshake was for; null when nothing was in flight. */
  bookId: string | null;
  /** True only when the server confirmed the book exists. */
  established: boolean;
  reason: EstablishmentReason;
  /** Present when `reason === 'failed'`. */
  error?: unknown;
}

const NOTHING_IN_FLIGHT: EstablishmentResult = {
  bookId: null, established: false, reason: 'none',
};

/** Default cap for a consumer that doesn't pass one (the drain passes its own). */
const DEFAULT_WAIT_MS = 10000;

interface Tracked {
  bookId: string;
  /** Never rejects. */
  settled: Promise<EstablishmentResult>;
}

let tracked: Tracked | null = null;
let lastResult: EstablishmentResult | null = null;

/**
 * Install the handshake for a newly created book.
 *
 * @param work  The bulk-create round trip (`fireAndForgetSync`). It MAY reject;
 *              the returned promise will not.
 * @returns a promise that always settles with the outcome — callers that want to
 *          act on the result (retry, glow the cloud) can await THIS instead of
 *          wrapping `work` in their own try/catch.
 */
export function trackNewBookEstablishment(
  bookId: string,
  work: Promise<unknown>,
): Promise<EstablishmentResult> {
  const settled = work.then(
    (): EstablishmentResult => ({ bookId, established: true, reason: 'established' }),
    (error): EstablishmentResult => ({ bookId, established: false, reason: 'failed', error }),
  ).then((result) => {
    // Retire on settle — a finished handshake must never gate a later push.
    if (tracked?.settled === settled) tracked = null;
    lastResult = result;
    return result;
  });

  tracked = { bookId, settled };
  return settled;
}

/**
 * Wait for an in-flight handshake, bounded. Resolves immediately with
 * `reason: 'none'` when nothing is in flight — the overwhelmingly common case,
 * so callers can await this unconditionally on every push.
 *
 * A `timeout` result does NOT retire the handshake: it may still land, and the
 * next caller waits again. Proceeding is the safe branch either way — a push at
 * a book the server doesn't have yet fails recoverably (it parks in historyLog
 * and `retryFailedBatches` replays it), whereas waiting forever is the wedge.
 */
export function whenNewBookEstablished(timeoutMs: number = DEFAULT_WAIT_MS): Promise<EstablishmentResult> {
  const inFlight = tracked;
  if (!inFlight) return Promise.resolve(NOTHING_IN_FLIGHT);

  const { bookId } = inFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<EstablishmentResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ bookId, established: false, reason: 'timeout' }),
      timeoutMs,
    );
  });

  return Promise.race([inFlight.settled, timedOut])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** The book whose handshake is in flight right now, or null. */
export function getEstablishingBookId(): string | null {
  return tracked?.bookId ?? null;
}

/** The outcome of the most recent handshake (survives its retirement), or null. */
export function getLastEstablishment(): EstablishmentResult | null {
  return lastResult;
}

/** Test-only: drop all module state so specs don't leak into one another. */
export function __resetNewBookEstablishmentForTests(): void {
  tracked = null;
  lastResult = null;
}
