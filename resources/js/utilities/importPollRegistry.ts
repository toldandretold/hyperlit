// Zero-import leaf (see "circular-import TDZ → leaf state"): cancellation
// tokens for in-flight import-progress pollers, keyed by bookId.
//
// The in-form import card's 2s poll loop used to run forever after the newbook
// container closed mid-import — driving detached DOM nodes and burning the
// import-progress rate bucket. The poller registers a token here and checks it
// each tick; the container close path calls cancelAllImportPolls(). Shared as
// a leaf because the poller lives in SPA/navigation and the close machinery in
// components/newbookContainer, and neither may import the other (cycle-free
// invariant).

interface PollToken {
  cancelled: boolean;
}

const tokens = new Map<string, PollToken>();

/** Create + register a fresh token for a book's poll loop. */
export function registerImportPoll(bookId: string): PollToken {
  const token: PollToken = { cancelled: false };
  tokens.set(bookId, token);
  return token;
}

/** Drop a token, but only if it is still the registered one (a newer poll for
 * the same book may have replaced it). */
export function clearImportPoll(bookId: string, token: PollToken): void {
  if (tokens.get(bookId) === token) tokens.delete(bookId);
}

/** Cancel the poll loop for one book. The loop resolves null on its next tick. */
export function cancelImportPoll(bookId: string): void {
  const token = tokens.get(bookId);
  if (token) token.cancelled = true;
}

const cancelAllListeners: Array<() => void> = [];

/**
 * Notify when cancelAllImportPolls fires (i.e. the newbook container closed
 * mid-import). The import-queue widget uses this to release its card claims
 * so an orphaned-but-still-running import re-surfaces in the corner pill.
 */
export function onCancelAllImportPolls(cb: () => void): void {
  cancelAllListeners.push(cb);
}

/** Cancel every in-flight import poll (container closed / torn down). */
export function cancelAllImportPolls(): void {
  for (const token of tokens.values()) token.cancelled = true;
  tokens.clear();
  for (const cb of cancelAllListeners) {
    try { cb(); } catch { /* listener errors must not break the close path */ }
  }
}
