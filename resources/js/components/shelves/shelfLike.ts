/**
 * Liking a SHELF — and therefore an archive (/a/{slug}) or journal (/j/{slug})
 * page, whose corpus is a shelf. The book like's contract (readerActions.ts)
 * against ShelfLikeController: seat the state from the public count endpoint,
 * optimistic toggle, revert on failure, logged-out clicks get the anchored
 * login prompt. Only public shelves can be liked — the server 404s otherwise.
 *
 * `wireShelfLikeButton` wires ANY button (the shelf header's heart, the
 * archive panel's #like-book) so the two surfaces share one behaviour.
 */

import { isLoggedIn } from '../../utilities/auth/index';
import { log } from '../../utilities/logger';
import { drainResponse } from '../../utilities/drainResponse';

/** The action bar's heart glyph (buildSourceHtml's #like-book). */
export const HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="pointer-events: none;">'
    + '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'
    + '</svg>';

function xsrf(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

function setLikedState(btn: HTMLElement, liked: boolean, noun: string): void {
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    btn.classList.toggle('liked', liked);
    btn.title = liked ? 'Unlike' : 'Like';
    btn.setAttribute('aria-label', liked ? `Unlike this ${noun}` : `Like this ${noun}`);
}

/**
 * Wire `btn` as the like toggle for `shelfId`. `noun` is what the surface
 * calls the thing ("shelf", "archive", "journal") — for the labels only.
 */
export function wireShelfLikeButton(btn: HTMLElement, shelfId: string, noun: string = 'shelf'): void {
    setLikedState(btn, false, noun);

    // Seat the initial liked state — best-effort; unliked stands on failure.
    void (async () => {
        try {
            const resp = await fetch(`/api/public/shelves/${encodeURIComponent(shelfId)}/likes`, {
                headers: { Accept: 'application/json' },
                credentials: 'include',
            });
            const data = await resp.json().catch(() => ({})) as { liked?: boolean };
            if (resp.ok && btn.isConnected) setLikedState(btn, !!data.liked, noun);
        } catch {
            // leave the default unliked state
        }
    })();

    btn.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        if (!(await isLoggedIn())) {
            const { showLoginPromptMenu } = await import('./addToShelfMenu');
            showLoginPromptMenu(btn, `Log in to like ${noun === 'shelf' ? 'shelves' : `${noun}s`}`);
            return;
        }

        // Optimistic toggle; revert if the request fails.
        const wasLiked = btn.getAttribute('aria-pressed') === 'true';
        setLikedState(btn, !wasLiked, noun);
        try {
            const resp = await drainResponse(await fetch(`/api/shelves/${encodeURIComponent(shelfId)}/like`, {
                method: wasLiked ? 'DELETE' : 'POST',
                headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
                credentials: 'include',
            }));
            if (!resp.ok) throw new Error(`shelf like toggle ${resp.status}`);
        } catch (err) {
            setLikedState(btn, wasLiked, noun);
            log.error('Shelf like toggle failed', '/components/shelves/shelfLike.ts', err as Error);
        }
    });
}
