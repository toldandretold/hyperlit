/**
 * "The next book made from the New panel belongs on THIS shelf."
 *
 * Set by the archive panel's plus on an archive / journal page the viewer
 * keeps (archivePanel/index.ts), right before it opens the New panel; taken
 * (read once + cleared) by the two paths that actually make a book — a blank
 * new book (NewBookTransition, once the server has it) and a file import
 * (ImportBookTransition's batch-of-one, which carries it as `shelf_id`).
 *
 * It must never leak onto a book made some other way, so it is short-lived,
 * and a REAL click on the ordinary New button (the plus's own click is
 * synthetic) clears it.
 */

import { log } from './logger';
import { drainResponse } from './drainResponse';

const KEY = 'pending_new_book_shelf';
const MAX_AGE_MS = 15 * 60 * 1000;

let guardInstalled = false;

function installGuard(): void {
    if (guardInstalled) return;
    guardInstalled = true;
    document.addEventListener('click', (e) => {
        if (e.isTrusted && (e.target as Element | null)?.closest?.('#newBookButton')) clearNewBookShelfTarget();
    }, true);
}

export function setNewBookShelfTarget(shelfId: string): void {
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ shelfId, at: Date.now() }));
        installGuard();
    } catch { /* storage unavailable — the book is simply not shelved */ }
}

export function clearNewBookShelfTarget(): void {
    try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/** Read the target once and clear it. Null when none is set or it has aged out. */
export function takeNewBookShelfTarget(): string | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        if (!raw) return null;
        const { shelfId, at } = JSON.parse(raw) as { shelfId?: string; at?: number };
        return shelfId && typeof at === 'number' && Date.now() - at < MAX_AGE_MS ? shelfId : null;
    } catch {
        return null;
    }
}

/** Put a book the server already has onto a shelf the viewer owns. */
export async function addBookToShelf(shelfId: string, bookId: string): Promise<boolean> {
    try {
        const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
        const resp = await drainResponse(await fetch(`/api/shelves/${encodeURIComponent(shelfId)}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
            body: JSON.stringify({ book: bookId }),
        }));
        if (!resp.ok) throw new Error(`add to shelf ${resp.status}`);
        return true;
    } catch (error) {
        log.error('Could not add the new book to its shelf', '/utilities/newBookShelfTarget.ts', error as Error);
        return false;
    }
}
