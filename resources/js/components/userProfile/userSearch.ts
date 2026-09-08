/**
 * User-scoped search for /u/{username} pages — the same searchBox component as
 * the homepage (search/searchBox.ts), configured with user ids, per-user query
 * persistence, and the user-library search endpoint
 * (ShelfController::publicSystemSearch: mode=library titles, default
 * full-text, mode=semantic embeddings — visitors see the user's public books,
 * an OWNER session searches their private books too; the server decides via
 * the sanctum guard, the client sends nothing about ownership).
 *
 * The mode preference is a user preference shared across user pages; the
 * query is per-page-user (restoring user A's query into user B's box would
 * lie). The archivist submit passes the page's username so the ask is scoped
 * to that user's library (AiBrainController::ask `username`).
 *
 * Registered via ButtonRegistry (pages: ['user']) — survives SPA nav.
 */

import { createSearchBox } from '../../search/searchBox';

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
        queryKey: (username) => `user_search_query_${username}`,
    },
    placeholders: {
        library: 'Search titles & authors...',
        fulltext: 'Search book text...',
        semantic: 'Search by meaning...',
        archivist: 'Ask the AI Archivist about this library...',
    },
    // User scope = this page's user (the searchBox contextId IS the username,
    // read from the container's data-username).
    archivist: {
        onSubmit: (query, username) => {
            void import('../aiArchivist/archivistPanel').then((m) =>
                m.openArchivistPanel({ question: query, shelfId: null, username: username || null }));
        },
    },
    noResultsMessage: () => 'No matches in this library.',
    endpointFor: (mode, query, username) => {
        const modeParam = { library: '&mode=library', fulltext: '', semantic: '&mode=semantic' }[mode];
        return `/api/public/library/${encodeURIComponent(username)}/search?q=${encodeURIComponent(query)}${modeParam}`;
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
