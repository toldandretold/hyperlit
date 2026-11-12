/**
 * Nominating a shelf's OVERVIEW book — the member the owner pins as the
 * shelf's intro / readme (a course overview for a reading list). Server:
 * shelves.overview_book via PATCH /api/shelves/{id} (ShelfController::update;
 * App\Services\Shelves\ShelfOverview decides when it counts). The render then
 * leads with that card, pin showing, for every viewer; the shelf's archive
 * page shows the book as its about and the vault export makes it the hub note.
 *
 * Driven from the card actions menu on the owner's own shelf (userProfilePage)
 * and on the owner's archive page for it (homepage.ts's card menu, which is the
 * one that runs on /a/ pages).
 */

import { log } from '../../utilities/logger';
import { readArchiveEditSeed } from '../archivePage/archiveTitleEditor';

function getXsrf(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

/**
 * Set (book id) or clear (null) the overview of the shelf currently open in
 * the owner's feed, then re-render that shelf so the pin shows. Returns
 * whether the server took it.
 */
export async function setShelfOverview(bookId: string | null): Promise<boolean> {
    const header = document.getElementById('shelf-header');
    // The owner's shelf header (shelfHeader stamps it for owner + ordinary
    // shelf only), else the owner's archive page for that shelf.
    const archiveSeed = header?.dataset.dropShelfId ? null : readArchiveEditSeed();
    const shelfId = header?.dataset.dropShelfId || archiveSeed?.shelfId;
    if (!shelfId) return false;

    try {
        const resp = await fetch(`/api/shelves/${encodeURIComponent(shelfId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
            credentials: 'include',
            body: JSON.stringify({ overview_book: bookId }),
        });
        const data = await resp.json().catch(() => ({})) as { error?: string };
        if (!resp.ok) throw new Error(data.error || `Save failed (${resp.status})`);
    } catch (error) {
        log.error('Setting the shelf overview failed', '/components/shelves/shelfOverview.ts', error as Error);
        const { alertDialog } = await import('../dialog/dialog');
        await alertDialog({ title: 'Could not pin the overview', message: error instanceof Error ? error.message : 'Try again.' });
        return false;
    }

    // The archive page's about section, document count and feed all change
    // with the overview — reload rather than patch three places.
    if (archiveSeed) {
        window.location.reload();
        return true;
    }

    // Re-render: the server flushed the shelf's cached feeds; clear the tab's
    // remembered render so re-opening fetches the new order.
    try {
        const { invalidateShelfCache, openShelf } = await import('./shelfTabs');
        invalidateShelfCache();
        const tab = document.querySelector<HTMLElement>(
            `.shelf-tab[data-shelf-id="${shelfId}"], .visitor-shelf-tab[data-shelf-id="${shelfId}"]`,
        );
        const sort = tab?.dataset.sort || 'recent';
        if (tab) tab.dataset.content = '';
        await openShelf(shelfId, header?.dataset.dropShelfName || '', sort);
    } catch (error) {
        // The save landed; a reload shows it.
        log.error('Shelf re-render after overview change failed', '/components/shelves/shelfOverview.ts', error as Error);
    }

    return true;
}
