/**
 * User-scoped search for /u/{username} pages — the same searchBox component as
 * the homepage (search/searchBox.ts), configured with user ids, per-user query
 * persistence, and the user-library search endpoint
 * (ShelfController::publicSystemSearch: mode=library titles, default
 * full-text, mode=semantic embeddings — visitors see the user's public books,
 * an OWNER session searches their private books too; the server decides via
 * the sanctum guard, the client sends nothing about ownership).
 *
 * SHELF NARROWING: an open shelf tab is the page's sub-scope, so the box
 * searches what the feed is showing rather than the whole library. The tab is
 * read from the DOM per query (searchBox's `subScope` seam — never cached, see
 * its doc block) and travels as `&shelf={uuid}`; the server re-checks that the
 * shelf belongs to the page's user and is public-or-yours.
 *
 * The mode preference is a user preference shared across user pages; the
 * query is per-page-user (restoring user A's query into user B's box would
 * lie). The archivist submit passes the page's username so the ask is scoped
 * to that user's library (AiBrainController::ask `username`) — or the shelf id
 * when a tab is open, since ask() treats the two as mutually exclusive (422)
 * and the shelf is the narrower corpus.
 *
 * Registered via ButtonRegistry (pages: ['user']) — survives SPA nav.
 */

import { createSearchBox, type SearchSubScope } from '../../search/searchBox';

/**
 * The open shelf tab, if any. Covers BOTH tab flavours: the owner's dynamic
 * tabs (shelfTabs.ts, name in a .shelf-tab-name span beside the × ) and the
 * visitor's server-rendered public-shelf tabs (name in data-shelf-name).
 *
 * Fallback to the archivist panel: opening an answer EVICTS the feed and
 * clears the active tab, so with an answer up the tab row would report "whole
 * library" and a follow-up question would silently widen. The panel carries
 * the scope its answer was asked against (archivistPanel's stampAskScope).
 */
function readActiveShelf(): SearchSubScope | null {
    const tab = document.querySelector<HTMLElement>(
        '.user-pill-scroller .arranger-button.active[data-filter="shelf"]',
    );
    if (tab?.dataset.shelfId) {
        const name = tab.querySelector('.shelf-tab-name')?.textContent?.trim()
            || tab.dataset.shelfName
            || 'this shelf';
        return { id: tab.dataset.shelfId, name };
    }

    const panel = document.querySelector<HTMLElement>('.main-content.archivist-panel[data-archivist-shelf-id]');
    const panelShelfId = panel?.dataset.archivistShelfId;
    if (panelShelfId) {
        return { id: panelShelfId, name: panel?.dataset.archivistShelfName || 'this shelf' };
    }

    return null;
}

/**
 * Display budget for a shelf name inside the copy below. Shelf names run to
 * 255 chars; unclipped, a long one pushes the part that says WHAT is being
 * searched out of the visible input. Clipped names end in an ellipsis, which
 * is also why the scoped copy drops the trailing "..." the unscoped
 * placeholders carry — two ellipses in one line read as a mistake.
 */
const MAX_SHELF_NAME = 24;

function shortShelfName(name: string): string {
    return name.length > MAX_SHELF_NAME
        ? `${name.slice(0, MAX_SHELF_NAME - 1).trimEnd()}…`
        : name;
}

const userSearchBox = createSearchBox({
    ids: {
        container: 'user-search-container',
        input: 'user-search-input',
        results: 'user-search-results',
        fulltextToggle: 'user-fulltext-toggle',
        semanticToggle: 'user-semantic-toggle',
        brainButton: 'archivist-brain-button',
        askButton: 'archivist-ask-button',
    },
    storage: {
        modeKey: 'user_search_mode',
        // Deliberately per-USER, not per-shelf: switching shelves keeps the
        // typed query so the same question can be re-asked of a new corpus.
        queryKey: (username) => `user_search_query_${username}`,
    },
    placeholders: {
        library: 'Search titles & authors...',
        fulltext: 'Search book text...',
        semantic: 'Search by meaning...',
        archivist: 'Ask the AI Archivist about this library...',
    },
    // User scope = this page's user (the searchBox contextId IS the username,
    // read from the container's data-username); an open shelf tab narrows it.
    archivist: {
        onSubmit: (query, username, shelf) => {
            void import('../aiArchivist/archivistPanel').then((m) =>
                m.openArchivistPanel({
                    question: query,
                    shelfId: shelf ? shelf.id : null,
                    shelfName: shelf ? shelf.name : null,
                    username: shelf ? null : (username || null),
                }));
        },
    },
    subScope: {
        read: readActiveShelf,
        watch: [
            // the pill row: `active` flips + a tab being closed
            {
                selector: '.user-pill-scroller',
                options: { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] },
            },
            // the feed slot, DIRECT children only: an archivist answer taking
            // it over (carrying its own scope) or being closed again. No
            // subtree — feed chunks render in here.
            { selector: '.home-content-wrapper', options: { childList: true } },
        ],
        placeholders: {
            library: (name) => `Search titles & authors in “${shortShelfName(name)}”`,
            fulltext: (name) => `Search text in “${shortShelfName(name)}”`,
            semantic: (name) => `Search “${shortShelfName(name)}” by meaning`,
            archivist: (name) => `Ask the AI Archivist about “${shortShelfName(name)}”`,
        },
    },
    noResultsMessage: (_mode, shelf) => (
        shelf ? `No matches in “${shortShelfName(shelf.name)}”.` : 'No matches in this library.'
    ),
    endpointFor: (mode, query, username, shelf) => {
        const modeParam = { library: '&mode=library', fulltext: '', semantic: '&mode=semantic' }[mode];
        const shelfParam = shelf ? `&shelf=${encodeURIComponent(shelf.id)}` : '';
        return `/api/public/library/${encodeURIComponent(username)}/search?q=${encodeURIComponent(query)}${modeParam}${shelfParam}`;
    },
    context: { datasetKey: 'username', missingPlaceholder: 'No library yet' },
    logSource: '/components/userProfile/userSearch.ts',
});

export function initializeUserSearch(): void {
    userSearchBox.init();
}

export function destroyUserSearch(): void {
    userSearchBox.destroy();
}
