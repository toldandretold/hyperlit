/**
 * The `pending_new_book_sync` marker — ONE accessor for the reload-surviving
 * half of "this book exists locally but maybe not on the server".
 *
 * TWO HALVES, on purpose:
 *   - `utilities/newBookEstablished` — the handshake running RIGHT NOW in this
 *     tab. In-memory, so it dies with the page.
 *   - THIS — a sessionStorage record that SURVIVES A RELOAD. Its value is not a
 *     flag but the whole `pendingSyncData` payload (library record + initial
 *     node), because that is what `readerEntry` re-sends if the user refreshes
 *     before the create lands. That recovery is why it can't just be folded into
 *     the in-memory signal.
 *
 * What reads it, and why it must stay ONE question: "the server doesn't have
 * this book yet" — so `loadHyperText` skips the server-timestamp compare,
 * `chunkLoadRouter` skips fetching chunks, `syncQueue/master` sends a falsy
 * base so the 409 stale-check is skipped, and `auth/permissions` grants edit
 * rights for a book the server has never heard of.
 *
 * What does NOT belong here: "don't show the loading overlay". That is a
 * presentation question that merely CORRELATES with a new book — see
 * `SPA/navigation/localContentEntry`. The import side already learned this the
 * hard way: it keeps `pending_import_book` (overlay) separate from
 * `imported_book_flag` (permissions), after the overlay flag leaked and
 * silently killed the boot overlay + resume curtain for every later load in the
 * tab (viewManager's clear site documents it).
 *
 * The nine call sites used to each do their own `JSON.parse(getItem(...))`
 * inside their own try/catch. Now there is one parse, one clear, one place to
 * look — which is also what keeps the marker from leaking: a leaked marker
 * means a book is treated as not-on-the-server FOREVER, quietly disabling its
 * optimistic-concurrency protection.
 *
 * Imports NOTHING but the logger (itself import-free) — this is read by the data
 * layer, the SPA layer and the page-load layer, so it must stay a leaf.
 */
import { log } from './logger';

/** The storage key. Exported so nothing else has to spell it (e.g. logout's preserve list). */
export const PENDING_NEW_BOOK_KEY = 'pending_new_book_sync';

export interface PendingNewBook {
  bookId: string;
  isNewBook?: boolean;
  /** The library row to re-send after a reload. */
  libraryRecord?: unknown;
  /** The initial node(s) to re-send after a reload. */
  nodes?: unknown[];
}

/** The pending-create record, or null when there is none / it is unreadable. */
export function getPendingNewBook(): PendingNewBook | null {
  try {
    const raw = sessionStorage.getItem(PENDING_NEW_BOOK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingNewBook | null;
    return parsed && typeof parsed.bookId === 'string' ? parsed : null;
  } catch {
    return null; // malformed — treat as "nothing pending", never throw at a caller
  }
}

/** Is THIS book the one still waiting to land on the server? */
export function isPendingNewBook(bookId: string | null | undefined): boolean {
  if (!bookId) return false;
  return getPendingNewBook()?.bookId === bookId;
}

/** Store the create payload so a reload can re-send it. */
export function setPendingNewBook(payload: PendingNewBook): void {
  try {
    sessionStorage.setItem(PENDING_NEW_BOOK_KEY, JSON.stringify(payload));
  } catch (error) {
    // Storage full / disabled: the create still works, it just can't be resumed
    // after a reload. Never let this break book creation.
    log.error('Could not record the pending new book for reload recovery', '/utilities/pendingNewBook.ts', error);
  }
}

/**
 * Clear the marker once creation has settled.
 *
 * @param bookId  Clear ONLY if the marker is for this book — a second new book
 *   may have overwritten it while the first was still settling. Omit to clear
 *   unconditionally (the error paths that can't identify the book).
 */
export function clearPendingNewBook(bookId?: string | null): void {
  try {
    if (bookId && getPendingNewBook()?.bookId !== bookId) return;
    sessionStorage.removeItem(PENDING_NEW_BOOK_KEY);
  } catch { /* storage unavailable — nothing to clear */ }
}
