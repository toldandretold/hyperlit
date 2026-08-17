/**
 * Journal-scoped search for /j/{slug} pages — the same searchBox component as
 * the homepage (search/searchBox.ts), configured with journal ids, per-shelf
 * query persistence, and the shelf-scoped public search endpoint
 * (ShelfController::publicSearch: mode=library titles, default full-text,
 * mode=semantic embeddings — all restricted to the shelf's public books).
 *
 * The mode preference is a user preference shared across journals; the query
 * is per-journal (restoring journal A's query into journal B's box would lie).
 * A journal with no harvested shelf renders the box disabled ("No articles
 * yet") via the context requirement.
 *
 * Registered via ButtonRegistry (pages: ['journal']) — survives SPA nav.
 */

import { createSearchBox } from '../../search/searchBox';

const journalSearchBox = createSearchBox({
    ids: {
        container: 'journal-search-container',
        input: 'journal-search-input',
        results: 'journal-search-results',
        fulltextToggle: 'journal-fulltext-toggle',
        semanticToggle: 'journal-semantic-toggle',
    },
    storage: {
        modeKey: 'journal_search_mode',
        legacyFulltextKey: 'journal_search_fulltext',
        queryKey: (shelfId) => `journal_search_query_${shelfId}`,
    },
    placeholders: {
        library: 'Search titles & authors...',
        fulltext: 'Search article text...',
        semantic: 'Search by meaning...',
    },
    noResultsMessage: () => 'No matches in this journal.',
    endpointFor: (mode, query, shelfId) => {
        const modeParam = { library: '&mode=library', fulltext: '', semantic: '&mode=semantic' }[mode];
        return `/api/public/shelves/${encodeURIComponent(shelfId)}/search?q=${encodeURIComponent(query)}${modeParam}`;
    },
    context: { datasetKey: 'shelfId', missingPlaceholder: 'No articles yet' },
    logSource: '/components/journal/journalSearch.ts',
});

export function initializeJournalSearch(): void {
    journalSearchBox.init();
}

export function destroyJournalSearch(): void {
    journalSearchBox.destroy();
}
