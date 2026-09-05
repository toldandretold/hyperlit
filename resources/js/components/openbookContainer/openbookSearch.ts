// Library-mode-only searchBox instance for the Open flyout — same factory as
// the homepage search, same /api/search/library endpoint. The fulltext /
// semantic toggle ids do NOT exist in the partial ON PURPOSE: the factory
// null-guards missing toggles, readStoredMode defaults our fresh modeKey to
// 'library', and with no toggles changeMode can never fire — so this instance
// is permanently locked to library (titles & authors) mode.
import { createSearchBox } from '../../search/searchBox';

const RESULTS_LIMIT = 10;

const openbookSearchBox = createSearchBox({
  ids: {
    container: 'openbook-search-container',
    input: 'openbook-search-input',
    results: 'openbook-search-results',
    fulltextToggle: 'openbook-fulltext-toggle', // intentionally absent from the DOM
    semanticToggle: 'openbook-semantic-toggle', // intentionally absent from the DOM
  },
  storage: {
    modeKey: 'openbook_search_mode',
    queryKey: () => 'openbook_search_query',
  },
  placeholders: {
    library: 'Search titles & authors...',
    fulltext: 'Search titles & authors...', // unreachable (no toggle)
    semantic: 'Search titles & authors...', // unreachable (no toggle)
  },
  noResultsMessage: () => 'No matches in titles and authors',
  endpointFor: (_mode, query) =>
    `/api/search/library?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`,
  logSource: '/components/openbookContainer/openbookSearch.ts',
});

export function initializeOpenbookSearch(): void {
  openbookSearchBox.init();
}

export function destroyOpenbookSearch(): void {
  openbookSearchBox.destroy();
}
