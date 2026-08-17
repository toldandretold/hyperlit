/**
 * Homepage Search Module
 * Handles server-side PostgreSQL search for library and full-text modes
 */

import DOMPurify from 'dompurify';
import { verbose } from '../../utilities/logger';
import { searchCacheGet, searchCacheSet } from '../searchResultCache';

// Configuration
const DEBOUNCE_MS = 300;
// Longer debounce + higher minimum for semantic: every uncached keystroke is
// an embedding API round-trip, and 2-char fragments embed to near-noise.
const DEBOUNCE_SEMANTIC_MS = 500;
const MIN_QUERY_LENGTH = 2;
const MIN_QUERY_LENGTH_SEMANTIC = 3;
const RESULTS_LIMIT = 20;

// Storage keys for state persistence
const STORAGE_KEY_QUERY = 'homepage_search_query';
const STORAGE_KEY_MODE = 'homepage_search_mode';
// Legacy boolean key, migrated to STORAGE_KEY_MODE on init
const STORAGE_KEY_FULLTEXT = 'homepage_search_fulltext';

type SearchMode = 'library' | 'fulltext' | 'semantic';

const MODE_PLACEHOLDERS: Record<SearchMode, string> = {
    library: 'Search titles & authors...',
    fulltext: 'Search all content...',
    semantic: 'Search by meaning...',
};

// State
let searchInput: any = null;
let searchToggle: any = null;
let semanticToggle: HTMLInputElement | null = null;
let resultsContainer: any = null;
let debounceTimer: any = null;
let searchMode: SearchMode = 'library';
let abortController: any = null;
let currentSearchQuery = ''; // Track current query for highlighting on navigation
let pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;

function minLen(): number {
    return searchMode === 'semantic' ? MIN_QUERY_LENGTH_SEMANTIC : MIN_QUERY_LENGTH;
}

function debounceMs(): number {
    return searchMode === 'semantic' ? DEBOUNCE_SEMANTIC_MS : DEBOUNCE_MS;
}

function isSearchMode(value: string | null): value is SearchMode {
    return value === 'library' || value === 'fulltext' || value === 'semantic';
}

/**
 * Read the persisted mode, migrating the legacy fulltext boolean key.
 */
function readStoredMode(): SearchMode {
    const stored = localStorage.getItem(STORAGE_KEY_MODE);
    if (isSearchMode(stored)) {
        return stored;
    }
    const legacy = localStorage.getItem(STORAGE_KEY_FULLTEXT);
    if (legacy !== null) {
        const migrated: SearchMode = legacy === 'true' ? 'fulltext' : 'library';
        localStorage.setItem(STORAGE_KEY_MODE, migrated);
        localStorage.removeItem(STORAGE_KEY_FULLTEXT);
        return migrated;
    }
    return 'library';
}

/**
 * Grow the textarea to fit its content (CSS min/max-height clamp the range;
 * beyond the cap it scrolls internally). Runs on every input — including
 * pastes — and after programmatic value restores.
 */
function autosizeSearchInput() {
    if (!searchInput) return;
    searchInput.style.height = 'auto';
    searchInput.style.height = `${searchInput.scrollHeight}px`;
}

/**
 * Sync toggles + placeholder to a mode. The two toggles are mutually
 * exclusive (three effective modes), so both checkboxes are always set.
 */
function applyMode(mode: SearchMode) {
    searchMode = mode;
    if (searchToggle) searchToggle.checked = mode === 'fulltext';
    if (semanticToggle) semanticToggle.checked = mode === 'semantic';
    if (searchInput) searchInput.placeholder = MODE_PLACEHOLDERS[mode];
}

/**
 * Initialize the homepage search functionality
 */
export function initializeHomepageSearch() {
    searchInput = document.getElementById('homepage-search-input');
    searchToggle = document.getElementById('fulltext-search-toggle');
    semanticToggle = document.getElementById('semantic-search-toggle') as HTMLInputElement | null;
    resultsContainer = document.getElementById('search-results-container');

    if (!searchInput || !resultsContainer) {
        verbose.init('Search elements not found, skipping initialization', 'homepageSearch.js');
        return;
    }

    // Restore state from localStorage (migrates the legacy fulltext key)
    applyMode(readStoredMode());

    const savedQuery = localStorage.getItem(STORAGE_KEY_QUERY);
    if (savedQuery) {
        searchInput.value = savedQuery;
        autosizeSearchInput();
    }

    // Bind event listeners
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('keydown', handleKeyDown);
    searchInput.addEventListener('focus', handleFocus);

    if (searchToggle) {
        searchToggle.addEventListener('change', handleToggleChange);
    }
    if (semanticToggle) {
        semanticToggle.addEventListener('change', handleSemanticToggleChange);
    }

    // Close results when clicking outside
    document.addEventListener('click', handleOutsideClick);

    // Safari bfcache: Back resumes the frozen page — NO init re-runs, the
    // stale results dropdown is still open, and Safari clears
    // autocomplete="off" text inputs on restore (possibly AFTER pageshow, so
    // re-apply again a beat later). Empty the dropdown so a focus can't
    // resurrect stale results. (Same fix as journalSearch.)
    pageshowHandler = (e: PageTransitionEvent) => {
        if (!e.persisted || !searchInput) return;
        if (resultsContainer) resultsContainer.innerHTML = '';
        hideResults();
        const applySaved = () => {
            applyMode(readStoredMode());
            if (searchInput) {
                searchInput.value = localStorage.getItem(STORAGE_KEY_QUERY) || '';
                autosizeSearchInput();
            }
        };
        applySaved();
        setTimeout(applySaved, 150);
    };
    window.addEventListener('pageshow', pageshowHandler);

    verbose.init('Homepage search initialized', 'homepageSearch.js');
}

/**
 * Clean up event listeners
 */
export function destroyHomepageSearch() {
    if (searchInput) {
        searchInput.removeEventListener('input', handleSearchInput);
        searchInput.removeEventListener('keydown', handleKeyDown);
        searchInput.removeEventListener('focus', handleFocus);
    }

    if (searchToggle) {
        searchToggle.removeEventListener('change', handleToggleChange);
    }

    if (semanticToggle) {
        semanticToggle.removeEventListener('change', handleSemanticToggleChange);
    }

    document.removeEventListener('click', handleOutsideClick);

    if (pageshowHandler) {
        window.removeEventListener('pageshow', pageshowHandler);
        pageshowHandler = null;
    }

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    if (abortController) {
        abortController.abort();
    }

    // Reset state
    searchInput = null;
    searchToggle = null;
    semanticToggle = null;
    resultsContainer = null;
    searchMode = 'library';

    verbose.init('Homepage search destroyed', 'homepageSearch.js');
}

/**
 * Handle search input with debouncing
 */
function handleSearchInput(event: any) {
    autosizeSearchInput();

    const query = event.target.value.trim();

    // Clear previous timer
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    // Abort any in-flight request
    if (abortController) {
        abortController.abort();
    }

    // Clear results if query is too short
    if (query.length < minLen()) {
        hideResults();
        // Clear stored query if input is cleared
        if (query.length === 0) {
            localStorage.removeItem(STORAGE_KEY_QUERY);
        }
        return;
    }

    // Save query to localStorage
    localStorage.setItem(STORAGE_KEY_QUERY, query);

    // Show loading state
    showLoading();

    // Debounce the search
    debounceTimer = setTimeout(() => {
        performSearch(query);
    }, debounceMs());
}

/**
 * Perform the actual search request
 */
async function performSearch(query: any) {
    // Store query for use in navigation links
    currentSearchQuery = query;

    const endpoint = {
        library: '/api/search/library',
        fulltext: '/api/search/nodes',
        semantic: '/api/search/semantic',
    }[searchMode];
    const url = `${endpoint}?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`;

    // Client-side cache (URL key encodes endpoint/mode/query) — backspacing or
    // retyping an identical query renders instantly without a round-trip.
    const cached = searchCacheGet<{ results: any; mode: any }>(url);
    if (cached) {
        renderResults(cached.results, cached.mode);
        return;
    }

    abortController = new AbortController();

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content
            },
            credentials: 'include',
            signal: abortController.signal
        });

        if (!response.ok) {
            // The semantic endpoint 503s when the embedding provider is down —
            // a dependency outage worth naming, not a generic failure.
            if (response.status === 503) {
                showError('Semantic search is temporarily unavailable');
                return;
            }
            throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
            searchCacheSet(url, data);
            renderResults(data.results, data.mode);
        } else {
            showError('Search failed. Please try again.');
        }

    } catch (error) {
        if ((error as any).name === 'AbortError') {
            // Request was aborted, ignore
            return;
        }
        console.error('Search error:', error);
        showError('Search failed. Please try again.');
    }
}

/**
 * Render search results
 */
function renderResults(results: any, mode: any) {
    if (!results || results.length === 0) {
        showNoResults();
        return;
    }

    let html = '<ul class="search-results-list">';

    if (mode === 'library') {
        // Library results: simple list of books
        results.forEach((result: any) => {
            html += `
                <li class="search-result-item">
                    <a href="/${encodeURIComponent(result.book)}" class="search-result-link">
                        <span class="search-result-headline">${DOMPurify.sanitize(result.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
                    </a>
                </li>
            `;
        });
    } else if (mode === 'semantic') {
        // Semantic results: flat ranked list (rank IS the signal — no book
        // grouping), plain excerpts (no exact matched term to <mark>).
        // `match` is the server's floor-rescaled percentage: 0% = the measured
        // cosine noise floor (unrelated English), 100% = identical — the top
        // of the scale is real, not clamped.
        results.forEach((result: any) => {
            const nodeAnchor = result.startLine ? `#${result.startLine}` : '';
            const matchPct = typeof result.match === 'number'
                ? `<span class="search-result-similarity">${result.match}% match</span>`
                : '';
            html += `
                <li class="search-result-semantic">
                    <a href="/${encodeURIComponent(result.book)}${nodeAnchor}"
                       class="search-result-match-link"
                       data-highlight-query="${escapeHtml(currentSearchQuery)}">
                        <span class="search-result-snippet">${escapeHtml(result.excerpt)}</span>
                        <span class="search-result-semantic-source">
                            <span class="search-result-book-title">${escapeHtml(result.title || 'Untitled')}</span>${matchPct}
                            <span class="search-result-book-author">${escapeHtml(result.author || 'Unknown')}</span>
                        </span>
                    </a>
                </li>
            `;
        });
    } else {
        // Full-text results: grouped by book with multiple matches
        results.forEach((bookResult: any) => {
            const isSubbook = bookResult.is_subbook;
            const displayTitle = isSubbook
                ? (bookResult.parent_title || 'Untitled')
                : (bookResult.title || 'Untitled');
            const displayAuthor = isSubbook
                ? (bookResult.parent_author || 'Unknown')
                : (bookResult.author || 'Unknown');
            const kindLabel = isSubbook
                ? (bookResult.subbook_kind === 'highlight' ? 'Highlight in ' : 'Footnote in ')
                : '';

            html += `
                <li class="search-result-book${isSubbook ? ' search-result-subbook' : ''}">
                    <div class="search-result-book-header">
                        <a href="/${encodeURIComponent(bookResult.book)}" class="search-result-book-title">
                            ${kindLabel ? `<span class="search-result-subbook-label">${kindLabel}</span>` : ''}${escapeHtml(displayTitle)}
                        </a>
                        <span class="search-result-book-author">${escapeHtml(displayAuthor)}</span>
                    </div>
                    <ul class="search-result-matches">
            `;

            bookResult.matches.slice(0, 3).forEach((match: any) => {
                const nodeAnchor = match.startLine ? `#${match.startLine}` : '';
                html += `
                    <li class="search-result-match">
                        <a href="/${encodeURIComponent(bookResult.book)}${nodeAnchor}"
                           class="search-result-match-link"
                           data-highlight-query="${escapeHtml(currentSearchQuery)}">
                            <span class="search-result-snippet">${DOMPurify.sanitize(match.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
                        </a>
                    </li>
                `;
            });

            if (bookResult.matches.length > 3) {
                html += `<li class="search-result-more">+${bookResult.matches.length - 3} more matches</li>`;
            }

            html += '</ul></li>';
        });
    }

    html += '</ul>';

    resultsContainer.innerHTML = html;
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');

    // Add click handler for full-text result links to store query for highlighting
    resultsContainer.querySelectorAll('[data-highlight-query]').forEach((link: any) => {
        link.addEventListener('click', (e: any) => {
            const query = link.dataset.highlightQuery;
            if (query) {
                // Extract startLine from the href hash
                const href = link.getAttribute('href');
                const hashMatch = href.match(/#(\d+)/);
                const startLine = hashMatch ? hashMatch[1] : null;

                // Store in sessionStorage for the reader page to pick up
                sessionStorage.setItem('pendingHighlightQuery', query);
                if (startLine) {
                    sessionStorage.setItem('pendingHighlightStartLine', startLine);
                }
                verbose.content(`Stored highlight query: ${query}, startLine: ${startLine}`, 'homepageSearch.js');
            }
        });
    });
}

/**
 * Show loading state
 */
function showLoading() {
    // Semantic gets its own copy: the query-embedding round-trip adds
    // ~100-300ms on cache miss, so set the expectation.
    const text = searchMode === 'semantic' ? 'Searching by meaning...' : 'Searching...';
    resultsContainer.innerHTML = `<div class="search-loading">${text}</div>`;
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');
}

/**
 * Show no results message
 */
function showNoResults() {
    // Semantic "no results" usually means nothing cleared the similarity
    // cutoff — distinguish that from a keyword miss.
    const message = searchMode === 'semantic'
        ? 'No sufficiently similar passages found'
        : `No results found in ${searchMode === 'fulltext' ? 'content' : 'titles and authors'}`;
    resultsContainer.innerHTML = `<div class="search-no-results">${message}</div>`;
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');
}

/**
 * Show error message
 */
function showError(message: any) {
    resultsContainer.innerHTML = `<div class="search-error">${escapeHtml(message)}</div>`;
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');
}

/**
 * Hide results container
 */
function hideResults() {
    resultsContainer.classList.remove('visible');
    resultsContainer.classList.add('hidden');
    resultsContainer.innerHTML = '';
}

/**
 * Persist + apply a mode change from either toggle, re-running the search if
 * a long-enough query is present.
 */
function changeMode(mode: SearchMode) {
    applyMode(mode);
    localStorage.setItem(STORAGE_KEY_MODE, mode);

    const query = searchInput.value.trim();
    if (query.length >= minLen()) {
        performSearch(query);
    } else {
        hideResults();
    }

    verbose.content(`Search mode changed to: ${mode}`, 'homepageSearch.js');
}

/**
 * Full-text toggle. Mutually exclusive with the semantic toggle: checking one
 * unchecks the other (applyMode handles both checkboxes).
 */
function handleToggleChange(event: any) {
    changeMode(event.target.checked ? 'fulltext' : 'library');
}

/**
 * Semantic toggle — see handleToggleChange for the exclusivity contract.
 */
function handleSemanticToggleChange(event: any) {
    changeMode(event.target.checked ? 'semantic' : 'library');
}

/**
 * Handle keyboard navigation
 */
function handleKeyDown(event: any) {
    if (event.key === 'Escape') {
        hideResults();
        searchInput.blur();
    }
}

/**
 * Handle focus on search input
 * Re-triggers search if there's a query but no results showing
 */
function handleFocus() {
    const query = searchInput.value.trim();
    if (query.length >= minLen()) {
        // Re-search if we have a query but no results showing
        if (!resultsContainer.innerHTML || resultsContainer.classList.contains('hidden')) {
            performSearch(query);
        } else {
            resultsContainer.classList.remove('hidden');
            resultsContainer.classList.add('visible');
        }
    }
}

/**
 * Handle clicks outside search area
 */
function handleOutsideClick(event: any) {
    const searchArea = document.getElementById('homepage-search-container');
    if (searchArea && !searchArea.contains(event.target)) {
        hideResults();
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: any) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
