/**
 * E2EE book registry — zero-import leaf state (see the circular-import house
 * rule: shared mutable state lives in modules nothing else is imported by).
 *
 * Tracks which books are encrypted so the sync emitters can decide, synchronously,
 * whether a payload must pass through the encrypt seam. Populated from library
 * records as they flow through the loaders / library store writes; a sub-book
 * inherits its root book's flag (resolved by the CALLER via rootBookId — this
 * module stores only what it is told).
 */

const encryptedBooks = new Map<string, boolean>();

/** Record whether a (top-level) book is encrypted. */
export function setBookEncrypted(bookId: string, encrypted: boolean): void {
  encryptedBooks.set(bookId, encrypted);
}

/**
 * Is this book encrypted? Sub-book ids (`parent/Fn12`, `parent/2/a/b`) resolve
 * to their root book's flag. Unknown books default to false (plaintext) —
 * encryption is opt-in and the flag arrives with the library record.
 */
export function isBookEncrypted(bookId: string): boolean {
  return encryptedBooks.get(rootBookId(bookId)) ?? false;
}

/** Root (top-level) book id: the segment before the first '/'. */
export function rootBookId(bookId: string): string {
  const slash = bookId.indexOf('/');
  return slash === -1 ? bookId : bookId.slice(0, slash);
}

/** Wipe the registry (logout / tests). */
export function clearEncryptedBookRegistry(): void {
  encryptedBooks.clear();
}
