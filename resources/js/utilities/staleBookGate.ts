/**
 * Cross-tab "stale for edit" registry — a zero-import leaf (shared state lives
 * here so no import cycle / TDZ risk, and it's window-backed so every
 * code-split module instance in the tab sees the SAME registry).
 *
 * When another tab in this browser edits a book we have open READ-ONLY, we do
 * NOT block reading (this tab has no edits to lose — the user is often just
 * reading further down the page while editing in the other window). Instead
 * the book's root is marked here, and the WRITE entry points (edit mode,
 * highlight create/delete) consult the mark: they must refresh before writing,
 * because this tab's rendered DOM predates the other tab's edits and saving
 * from it would clobber them.
 *
 * The mark is keyed by ROOT book id (sub-books share their parent's fate,
 * mirroring the BOOK_EDITED broadcast). It is cleared when the book is loaded
 * again (loadHyperText re-reads IndexedDB, which this browser SHARES with the
 * editing tab, so a re-render is fresh) — and a full reload clears it for free
 * since the registry dies with the window.
 */

function registry(): Record<string, true> {
  const w = window as any;
  if (!w.__hyperlitStaleForEdit) w.__hyperlitStaleForEdit = {};
  return w.__hyperlitStaleForEdit;
}

function rootOf(bookId: string | null | undefined): string | null {
  const root = bookId?.split('/')[0];
  return root || null;
}

/** Another tab edited `bookId` while this tab has it open without editing it. */
export function markBookStaleForEdit(bookId: string | null | undefined): void {
  const root = rootOf(bookId);
  if (root) registry()[root] = true;
}

/** This tab just (re)rendered `bookId` fresh from IndexedDB. */
export function clearBookStaleForEdit(bookId: string | null | undefined): void {
  const root = rootOf(bookId);
  if (root) delete registry()[root];
}

/** Must a write path (edit mode / annotation) force a refresh first? */
export function isBookStaleForEdit(bookId: string | null | undefined): boolean {
  const root = rootOf(bookId);
  return root ? registry()[root] === true : false;
}
