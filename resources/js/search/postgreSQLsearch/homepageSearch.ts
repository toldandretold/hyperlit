/**
 * Homepage Search — global site search: library (titles & authors),
 * full-text (all node content), and opt-in semantic (embeddings).
 *
 * Thin config over the shared searchBox factory (../searchBox.ts) — the
 * journal pages instantiate the same component with their own ids, storage
 * keys, and shelf-scoped endpoints (components/journal/journalSearch.ts).
 */

import { createSearchBox } from '../searchBox';

const RESULTS_LIMIT = 20;

const homepageSearchBox = createSearchBox({
    ids: {
        container: 'homepage-search-container',
        input: 'homepage-search-input',
        results: 'search-results-container',
        fulltextToggle: 'fulltext-search-toggle',
        semanticToggle: 'semantic-search-toggle',
    },
    storage: {
        modeKey: 'homepage_search_mode',
        legacyFulltextKey: 'homepage_search_fulltext',
        queryKey: () => 'homepage_search_query',
    },
    placeholders: {
        library: 'Search titles & authors...',
        fulltext: 'Search all content...',
        semantic: 'Search by meaning...',
    },
    noResultsMessage: (mode) =>
        `No results found in ${mode === 'fulltext' ? 'content' : 'titles and authors'}`,
    endpointFor: (mode, query) => {
        const endpoint = {
            library: '/api/search/library',
            fulltext: '/api/search/nodes',
            semantic: '/api/search/semantic',
        }[mode];
        return `${endpoint}?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`;
    },
    logSource: 'homepageSearch.js',
});

export function initializeHomepageSearch() {
    homepageSearchBox.init();
}

export function destroyHomepageSearch() {
    homepageSearchBox.destroy();
}
