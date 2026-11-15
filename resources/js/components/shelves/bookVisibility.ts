/**
 * Book visibility from the CARD surfaces — the owner's library / shelves on
 * the user page and the owner's archive page (/a/{slug}).
 *
 * Two entry points:
 *   • toggleBookVisibilityFromCard — "Make public" / "Make private" in a card's
 *     … menu. One book, through the ordinary library upsert
 *     (DbLibraryController::upsert), which owns the publish gate, the home-book
 *     move, the shelf-render flush and the notifications.
 *   • offerToPublishShelfBooks — after a shelf goes public: "make all books
 *     within this shelf public?". Visitors are never shown a non-public member
 *     (ShelfController::renderShelfFeed), so a public shelf of private books is
 *     an empty page to everyone but its owner. Yes → POST
 *     /api/shelves/{id}/publish-books (the owner's OWN, non-encrypted books);
 *     No → they stay on the shelf, padlocked, for the owner only.
 *   • offerToUnpublishShelfBooks — the mirror, after a shelf goes private:
 *     "make all books within this shelf private?". A private shelf hides the
 *     list, not the books; Yes → POST /api/shelves/{id}/unpublish-books.
 *
 * Both bulk endpoints handle a CHUNK per call (each book is a full library
 * upsert, ~200ms) and answer with a `next` cursor; runBulkVisibility loops
 * them behind a progress dialog. One silent request for a whole vault-drop
 * shelf took 12s, and a reload in the middle of it is what "didn't work".
 *
 * Only bibliographic visibility travels here — no book content — and an
 * end-to-end-encrypted book is never offered the action (the server pins it
 * private; publishing one is the source container's decrypt flow).
 */

import { log } from '../../utilities/logger';

const SRC = '/components/shelves/bookVisibility.ts';

// Mirrors the padlock LibraryCardGenerator::generateLibraryCardHtml emits, so
// an in-place flip is indistinguishable from the next server render.
const PRIVATE_ICON_HTML = '<span class="private-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';

export interface NonPublicShelfBooks {
    /** The shelf owner's own non-public, non-encrypted books — the publishable ones. */
    own: number;
    /** The owner's encrypted books (pinned private server-side). */
    encrypted: number;
    /** Non-public books that belong to someone else. */
    others: number;
}

export interface PublicShelfBooks {
    /** The shelf owner's own public books — the ones they can make private. */
    own: number;
    /** Public books that belong to someone else. */
    others: number;
}

/** One chunk's answer from /publish-books or /unpublish-books. */
interface BulkVisibilityResponse {
    success?: boolean;
    published?: number;
    unpublished?: number;
    failed?: number;
    publish_denied?: string | null;
    /** Books still to do after this chunk. */
    remaining?: number;
    /** Cursor for the next call; null/absent once the shelf is done. */
    next?: string | null;
    error?: string;
}

interface BulkVisibilityOutcome {
    changed: number;
    failed: number;
    /** The publish gate refused (nothing was changed). */
    denied: string | null;
}

interface UpsertResponse {
    success?: boolean;
    message?: string;
    publish_denied?: string | null;
    library?: { visibility?: string } | null;
}

function getXsrf(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The publish gate refused (PublishGate) — say why, and offer the way through. */
async function explainPublishDenied(reason: string): Promise<void> {
    const { confirmDialog, alertDialog } = await import('../dialog/dialog');
    if (reason === 'unverified_email') {
        const go = await confirmDialog({
            title: 'Verify your email to publish',
            message: 'Publishing a book requires a verified email address. Check your inbox, or resend the link from your account.',
            confirmLabel: 'Verify email',
        });
        if (go) {
            const { promptVerifyEmail } = await import('../../utilities/auth/promptLogin');
            await promptVerifyEmail();
        }
        return;
    }
    if (reason === 'anonymous') {
        const go = await confirmDialog({
            title: 'Register to publish',
            message: 'You need an account to publish a book on Hyperlit. It only takes a moment — your book stays exactly as it is.',
            confirmLabel: 'Register',
        });
        if (go) {
            const { promptRegister } = await import('../../utilities/auth/promptLogin');
            await promptRegister();
        }
        return;
    }
    await alertDialog({ title: "Couldn't change visibility", message: 'Publishing is not available for this account right now.' });
}

/**
 * The shelf's cached renders were flushed server-side; forget every button's
 * remembered render so its next activation fetches a fresh one. With
 * `reopen`, re-render the open shelf now (the same recipe as shelfOverview).
 *
 * EVERY button for the shelf, not just the user page's tab: the archive
 * page's feed buttons are plain `.arranger-button[data-shelf-id]` (one per
 * sort) with no shelf-tab class, and one left pointing at a flushed render
 * opens an empty page.
 */
export async function refreshShelfTab(shelfId: string, shelfName: string, reopen: boolean): Promise<void> {
    try {
        const { invalidateShelfCache, openShelf } = await import('./shelfTabs');
        invalidateShelfCache();
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('.arranger-button[data-shelf-id]'))
            .filter((btn) => btn.dataset.shelfId === shelfId);
        buttons.forEach((btn) => { btn.dataset.content = ''; });
        const tab = buttons.find((btn) => btn.classList.contains('active')) ?? buttons[0];
        const sort = tab?.dataset.sort || 'recent';
        if (reopen) await openShelf(shelfId, shelfName, sort);
    } catch (error) {
        // The change landed; a reload shows it.
        log.error('Shelf re-render after a visibility change failed', SRC, error as Error);
    }
}

/**
 * Drive one bulk endpoint to completion: a chunk per call, following the
 * server's `next` cursor, behind a progress dialog the user can't dismiss
 * (walking away mid-loop is the one way this stops half-done). Stops on the
 * publish gate, on an error (after reporting how far it got via the throw),
 * or when the server says nothing is left.
 */
async function runBulkVisibility(
    shelfId: string,
    endpoint: 'publish-books' | 'unpublish-books',
    total: number,
    labels: { title: string; progress: (done: number, total: number) => string },
): Promise<BulkVisibilityOutcome> {
    const { progressDialog } = await import('../dialog/dialog');
    const outcome: BulkVisibilityOutcome = { changed: 0, failed: 0, denied: null };
    const progress = progressDialog({ title: labels.title, message: labels.progress(0, total) });

    try {
        let after: string | null = null;
        // Bounded: each call advances the cursor past at least one book, so
        // `total` calls is already more than a correct server can need.
        for (let call = 0; call <= total; call++) {
            const resp: Response = await fetch(`/api/shelves/${encodeURIComponent(shelfId)}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                credentials: 'include',
                body: JSON.stringify(after ? { after } : {}),
            });
            const data = await resp.json().catch(() => ({})) as BulkVisibilityResponse;
            if (!resp.ok) throw new Error(data.error || `The change failed (${resp.status})`);

            if (data.publish_denied) {
                outcome.denied = data.publish_denied;
                break;
            }
            outcome.changed += Number(data.published ?? data.unpublished) || 0;
            outcome.failed += Number(data.failed) || 0;
            progress.update(labels.progress(Math.min(total, outcome.changed + outcome.failed), total));

            if (!data.next || data.next === after) break;
            after = data.next;
        }
    } finally {
        progress.close();
    }
    return outcome;
}

/**
 * A shelf just went public and holds books that did not. Ask once; on yes,
 * publish the owner's own books. Resolves to how many became public (0 when
 * declined, refused or nothing was publishable).
 */
export async function offerToPublishShelfBooks(shelfId: string, counts: NonPublicShelfBooks): Promise<number> {
    const { confirmDialog, alertDialog } = await import('../dialog/dialog');
    const own = Number(counts.own) || 0;
    const encrypted = Number(counts.encrypted) || 0;
    const others = Number(counts.others) || 0;

    const leftovers: string[] = [];
    if (encrypted > 0) {
        leftovers.push(`${encrypted} encrypted ${plural(encrypted, 'book stays', 'books stay')} private either way.`);
    }
    if (others > 0) {
        leftovers.push(`${others} ${plural(others, 'book belongs', 'books belong')} to someone else and can't be changed from here.`);
    }

    if (own === 0) {
        if (leftovers.length) {
            await alertDialog({
                title: 'Some books stay hidden',
                message: `Visitors only see the public books on a shelf. ${leftovers.join(' ')}`,
            });
        }
        return 0;
    }

    const yes = await confirmDialog({
        title: 'Make all books within this shelf public?',
        message: [
            `${own} of your books on this shelf ${plural(own, "isn't", "aren't")} public, so visitors won't see ${plural(own, 'it', 'them')}.`,
            `Choose No to keep ${plural(own, 'it', 'them')} private — ${plural(own, 'it stays', 'they stay')} on the shelf, marked with a padlock, visible only to you.`,
            ...leftovers,
        ].join('\n\n'),
        confirmLabel: 'Yes, make public',
        cancelLabel: 'No, keep private',
        danger: true,
    });
    if (!yes) return 0;

    try {
        const { changed: published, failed, denied } = await runBulkVisibility(shelfId, 'publish-books', own, {
            title: 'Making books public…',
            progress: (done, total) => `${done} of ${total} ${plural(total, 'book', 'books')} done. Keep this page open.`,
        });
        if (denied) {
            await explainPublishDenied(denied);
            return 0;
        }
        if (failed > 0) {
            await alertDialog({
                title: 'Not every book was published',
                message: `${published} ${plural(published, 'book is', 'books are')} now public; ${failed} could not be changed and ${plural(failed, 'stays', 'stay')} private.`,
            });
        }
        return published;
    } catch (error) {
        log.error('Publishing a shelf\'s books failed', SRC, error as Error);
        await alertDialog({ title: "Couldn't make the books public", message: error instanceof Error ? error.message : 'Try again.' });
        return 0;
    }
}

/**
 * The mirror: a shelf just went private but holds books that are still
 * public — a private shelf hides the LIST, not the books. Ask once; on yes,
 * make the owner's own books private. Resolves to how many became private
 * (0 when declined or nothing was the owner's to hide).
 */
export async function offerToUnpublishShelfBooks(shelfId: string, counts: PublicShelfBooks): Promise<number> {
    const { confirmDialog, alertDialog } = await import('../dialog/dialog');
    const own = Number(counts.own) || 0;
    const others = Number(counts.others) || 0;
    // Nothing of the owner's is public: other people's books are theirs to
    // keep public, and that needs no announcement.
    if (own === 0) return 0;

    const yes = await confirmDialog({
        title: 'Make all books within this shelf private?',
        message: [
            `${own} of your books on this shelf ${plural(own, 'is', 'are')} still public. A private shelf hides the shelf, not the books — anyone can still read ${plural(own, 'it', 'them')} from your library or ${plural(own, 'its', 'their')} own link.`,
            `Choose Yes to make ${plural(own, 'it', 'them')} private everywhere: anyone with a link loses access, on every shelf. Choose No to leave ${plural(own, 'it', 'them')} public.`,
            ...(others > 0
                ? [`${others} ${plural(others, 'book belongs', 'books belong')} to someone else and ${plural(others, 'stays', 'stay')} public either way.`]
                : []),
        ].join('\n\n'),
        confirmLabel: 'Yes, make private',
        cancelLabel: 'No, keep public',
    });
    if (!yes) return 0;

    try {
        const { changed: unpublished, failed } = await runBulkVisibility(shelfId, 'unpublish-books', own, {
            title: 'Making books private…',
            progress: (done, total) => `${done} of ${total} ${plural(total, 'book', 'books')} done. Keep this page open.`,
        });
        if (failed > 0) {
            await alertDialog({
                title: 'Not every book was made private',
                message: `${unpublished} ${plural(unpublished, 'book is', 'books are')} now private; ${failed} could not be changed and ${plural(failed, 'stays', 'stay')} public.`,
            });
        }
        return unpublished;
    } catch (error) {
        log.error('Making a shelf\'s books private failed', SRC, error as Error);
        await alertDialog({ title: "Couldn't make the books private", message: error instanceof Error ? error.message : 'Try again.' });
        return 0;
    }
}

/** Best-effort: keep a locally cached library record in step with the server. */
async function mirrorVisibilityLocally(bookId: string, visibility: 'public' | 'private'): Promise<void> {
    try {
        const { openDatabase } = await import('../../indexedDB/index');
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('library', 'readwrite');
            const store = tx.objectStore('library');
            const req = store.get(bookId);
            req.onsuccess = () => {
                const record = req.result;
                // Not cached on this device — nothing to mirror, and never mint a
                // partial library row for a book the client has not loaded.
                if (!record) return;
                record.visibility = visibility;
                if (record.raw_json && typeof record.raw_json === 'object') {
                    record.raw_json.visibility = visibility;
                }
                store.put(record);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        const { clearEditPermissionCache } = await import('../../utilities/auth/index');
        clearEditPermissionCache(bookId);
    } catch (error) {
        log.error('Mirroring a visibility change into the local library failed', SRC, error as Error);
    }
}

/** Flip the padlock on every rendered card for this book (or drop a card its tab no longer lists). */
function patchRenderedCards(bookId: string, isPublic: boolean, inShelf: boolean): void {
    // The Library tab's Public / Private filters each list ONE visibility; a
    // flipped book has left that list. Shelves and "All" keep the card.
    const libraryFilter = inShelf ? 'all' : (localStorage.getItem('user_library_filter') || 'all');
    const leavesList = (libraryFilter === 'public' && !isPublic) || (libraryFilter === 'private' && isPublic);

    document.querySelectorAll<HTMLElement>('.libraryCard .book-actions').forEach((actions) => {
        if (actions.getAttribute('data-book') !== bookId) return;
        const card = actions.closest<HTMLElement>('.libraryCard');
        if (!card) return;
        if (leavesList) {
            card.remove();
            return;
        }
        card.classList.toggle('libraryCard-private', !isPublic);
        const icon = card.querySelector('.private-icon');
        if (isPublic) {
            icon?.remove();
        } else if (!icon) {
            actions.insertAdjacentHTML('beforebegin', PRIVATE_ICON_HTML);
        }
    });
}

/**
 * "Make public" / "Make private" from a library card's … menu. `card` is the
 * clicked menu trigger (the .book-actions anchor). Resolves to whether the
 * book ended up in the requested state.
 */
export async function toggleBookVisibilityFromCard(bookId: string, makePublic: boolean, card: Element | null): Promise<boolean> {
    const { confirmDialog, alertDialog } = await import('../dialog/dialog');
    const wanted: 'public' | 'private' = makePublic ? 'public' : 'private';

    if (card?.closest('.libraryCard-encrypted')) {
        await alertDialog({
            title: 'This book is encrypted',
            message: 'An encrypted book stays private. Open it and use its visibility control to decrypt and publish it.',
        });
        return false;
    }

    const confirmed = await confirmDialog(makePublic
        ? { title: 'Make this book public?', message: 'Let the world read your hypertext literature.', confirmLabel: 'Make public', danger: true }
        : { title: 'Make this book private?', message: 'Anyone with the link will lose access. Only you will be able to read it.', confirmLabel: 'Make private' });
    if (!confirmed) return false;

    try {
        const resp = await fetch('/api/db/library/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
            credentials: 'include',
            // A fresh clock, or upsert reads the write as stale and no-ops.
            body: JSON.stringify({ data: { book: bookId, visibility: wanted, timestamp: Date.now() } }),
        });
        const data = await resp.json().catch(() => ({})) as UpsertResponse;
        if (!resp.ok || data.success === false) {
            throw new Error(data.message || `Save failed (${resp.status})`);
        }
        if (data.publish_denied) {
            await explainPublishDenied(data.publish_denied);
            return false;
        }
        // upsert answers 200 for a non-owner or a stale write too — only the
        // stored value says whether it took.
        if (data.library?.visibility !== wanted) {
            throw new Error(makePublic ? 'This book could not be made public.' : 'This book could not be made private.');
        }
    } catch (error) {
        log.error('Changing a book\'s visibility from its card failed', SRC, error as Error);
        await alertDialog({ title: "Couldn't change visibility", message: error instanceof Error ? error.message : 'Unknown error' });
        return false;
    }

    await mirrorVisibilityLocally(bookId, wanted);

    const shelfTab = document.querySelector<HTMLElement>('.arranger-button.active[data-filter="shelf"]');
    patchRenderedCards(bookId, makePublic, !!shelfTab);

    // The server flushed every shelf render holding this book. The cards on
    // screen are patched in place above; no shelf tab may keep pointing at a
    // flushed render, so each re-fetches on its next activation.
    document.querySelectorAll<HTMLElement>('.arranger-button[data-filter="shelf"]').forEach((tab) => {
        tab.dataset.content = '';
    });
    if ((window as { isUserPage?: boolean }).isUserPage) {
        try {
            const { invalidateShelfCache } = await import('./shelfTabs');
            invalidateShelfCache();
        } catch (error) {
            log.error('Invalidating the shelf cache after a visibility change failed', SRC, error as Error);
        }
    }

    return true;
}
