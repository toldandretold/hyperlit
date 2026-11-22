/**
 * localCopyCompleteness — ONE accessor for "does IndexedDB hold only PART of this book?"
 *
 * A reader's first render is one chunk (`fetchInitialChunk` clears the book's local rows
 * and stores ~100 nodes); the rest arrives via `pageLoad/backgroundDownload`. If that
 * download never completes — the tab closes mid-stream, a batch fails, Safari kills the
 * IDB connection under the write — the local copy stays a fragment. And on the next visit
 * `loadHyperText` used to treat ANY non-empty local copy as the whole book: no manifest,
 * no backfill, a ToC / search / export built from 400 of 3,062 nodes, forever, because
 * the owner's own saves keep the library timestamps level so nothing ever looks stale
 * (prod 2026-11-22, `john2005restorative` — surfaced as a false "server/IDB divergence").
 *
 * POLARITY IS DELIBERATE: the marker says PARTIAL, and its absence means "assume whole".
 * A "complete" marker would have to be stamped by every path that makes a whole copy
 * without downloading one — a locally created book, a paste, an import — and a book the
 * server has never heard of that lacked it would be sent down the server-fetch path,
 * which CLEARS the local rows first. With this polarity both failure directions are
 * benign: a stale "partial" costs one extra download; a missing one falls back to the
 * load-time count check (`isLocalCopyShortOfServer` in serverSync/countReconcile).
 *
 * localStorage, not the IDB library record: that record is replaced wholesale by server
 * pulls and is POSTed back on every sync, so a client-only field would be both wiped and
 * leaked. Nothing here is load-bearing if storage is unavailable — it degrades to the
 * old behaviour plus the count check.
 *
 * Imports NOTHING — read by the data layer and the page-load layer, so it stays a leaf.
 */

const PARTIAL_PREFIX = 'localCopyPartial_';
const REPAIR_PREFIX = 'localCopyShortRepair_';

/** Fallback for a session whose storage THROWS (private mode) — never consulted otherwise. */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

function remove(key: string): void {
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* nothing stored, nothing to remove */ }
}

/** The local copy of `bookId` is about to be (or is known to be) a fragment. */
export function markLocalCopyPartial(bookId: string): void {
  if (!bookId) return;
  write(PARTIAL_PREFIX + bookId, String(Date.now()));
}

/** The whole book was just written locally — a completed download or a full pull. */
export function markLocalCopyComplete(bookId: string): void {
  if (!bookId) return;
  remove(PARTIAL_PREFIX + bookId);
}

/** True only when a first-chunk load marked this book and no full download cleared it. */
export function isLocalCopyPartial(bookId: string | null | undefined): boolean {
  if (!bookId) return false;
  return read(PARTIAL_PREFIX + bookId) !== null;
}

/**
 * Loop-breaker for the COUNT-triggered repair (an unmarked short copy found by comparing
 * against the server's node count). A repair that completes and STILL leaves the local
 * count short is not an incomplete download — it is a real divergence the watchdog owns —
 * and re-downloading on every load would never fix it. So a repair is attempted once per
 * observed server count; a different count (the book changed) earns a new attempt.
 */
export function shortRepairAlreadyTried(bookId: string, serverCount: number): boolean {
  return read(REPAIR_PREFIX + bookId) === String(serverCount);
}

export function noteShortRepairAttempt(bookId: string, serverCount: number): void {
  if (!bookId) return;
  write(REPAIR_PREFIX + bookId, String(serverCount));
}

/** Counts agree again — forget the attempt so a future shortfall is repaired afresh. */
export function clearShortRepairAttempt(bookId: string): void {
  if (!bookId) return;
  remove(REPAIR_PREFIX + bookId);
}
