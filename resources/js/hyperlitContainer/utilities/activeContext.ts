/**
 * Active Context — tracks which book is currently being edited.
 *
 * When only the main book is open, getActiveBook() returns the global `book`
 * from app.js (existing behaviour, unchanged).
 *
 * When a sub-book is expanded inside the hyperlit container and has focus,
 * setActiveBook(subBookId) is called so that highlight creation, footnote
 * insertion, and hypercite operations target the sub-book rather than the
 * main book.
 *
 * Focus listeners in hyperlitContainer/core are responsible for calling
 * setActiveBook() / clearActiveBook() at the right moments.
 */

import { book } from '../../app';
import type { BookId } from '../../indexedDB/types';

let activeBookId: BookId | null = null;

/**
 * Get the currently active book ID.
 * Falls back to the global main-book `book` if no sub-book has focus.
 */
export function getActiveBook(): BookId {
    return activeBookId || book;
}

/**
 * Set the active book to a sub-book (called when sub-book div gains focus).
 */
export function setActiveBook(bookId: BookId) {
    activeBookId = bookId;
}

/**
 * Clear the active book override (called when sub-book div loses focus,
 * or when the hyperlit container closes).
 */
export function clearActiveBook() {
    activeBookId = null;
}
