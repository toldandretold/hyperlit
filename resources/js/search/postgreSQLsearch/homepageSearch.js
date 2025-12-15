/**
 * Homepage Search Module
 * Handles server-side PostgreSQL search for library and full-text modes
 */

import { log, verbose } from '../../utilities/logger.js';

// Configuration
const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const RESULTS_LIMIT = 20;

// Storage keys for state persistence
const STORAGE_KEY_QUERY = 'homepage_search_query';
const STORAGE_KEY_FULLTEXT = 'homepage_search_fulltext';

// State
let searchInput = null;
let searchToggle = null;
let resultsContainer = null;
let debounceTimer = null;
let isFullTextMode = false;
let abortController = null;
let currentSearchQuery = ''; // Track current query for highlighting on navigation

/**
 * Initialize the homepage search functionality
 */
export function initializeHomepageSearch() {
    searchInput = document.getElementById('homepage-search-input');
    searchToggle = document.getElementById('fulltext-search-toggle');
    resultsContainer = document.getElementById('search-results-container');

    if (!searchInput || !resultsContainer) {
        verbose.init('Search elements not found, skipping initialization', 'homepageSearch.js');
        return;
    }

    // Restore state from localStorage
    const savedFulltext = localStorage.getItem(STORAGE_KEY_FULLTEXT);
    if (savedFulltext !== null) {
        isFullTextMode = savedFulltext === 'true';
        if (searchToggle) {
            searchToggle.checked = isFullTextMode;
        }
        searchInput.placeholder = isFullTextMode
            ? 'Search all content...'
            : 'Search titles & authors...';
    }

    const savedQuery = localStorage.getItem(STORAGE_KEY_QUERY);
    if (savedQuery) {
        searchInput.value = savedQuery;
    }

    // Bind event listeners
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('keydown', handleKeyDown);
    searchInput.addEventListener('focus', handleFocus);

    if (searchToggle) {
        searchToggle.addEventListener('change', handleToggleChange);
    }

    // Close results when clicking outside
    document.addEventListener('click', handleOutsideClick);

    log.init('Homepage search initialized', 'homepageSearch.js');
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

    document.removeEventListener('click', handleOutsideClick);

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    if (abortController) {
        abortController.abort();
    }

    // Reset state
    searchInput = null;
    searchToggle = null;
    resultsContainer = null;
    isFullTextMode = false;

    verbose.init('Homepage search destroyed', 'homepageSearch.js');
}

/**
 * Handle search input with debouncing
 */
function handleSearchInput(event) {
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
    if (query.length < MIN_QUERY_LENGTH) {
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
    }, DEBOUNCE_MS);
}

/**
 * Perform the actual search request
 */
async function performSearch(query) {
    // Store query for use in navigation links
    currentSearchQuery = query;

    const endpoint = isFullTextMode ? '/api/search/nodes' : '/api/search/library';
    const url = `${endpoint}?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`;

    abortController = new AbortController();

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
            },
            credentials: 'include',
            signal: abortController.signal
        });

        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
            renderResults(data.results, data.mode);
        } else {
            showError('Search failed. Please try again.');
        }

    } catch (error) {
        if (error.name === 'AbortError') {
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
function renderResults(results, mode) {
    if (!results || results.length === 0) {
        showNoResults();
        return;
    }

    let html = '<ul class="search-results-list">';

    if (mode === 'library') {
        // Library results: simple list of books
        results.forEach(result => {
            html += `
                <li class="search-result-item">
                    <a href="/${encodeURIComponent(result.book)}" class="search-result-link">
                        <span class="search-result-headline">${result.headline}</span>
                    </a>
                </li>
            `;
        });
    } else {
        // Full-text results: grouped by book with multiple matches
        results.forEach(bookResult => {
            html += `
                <li class="search-result-book">
                    <div class="search-result-book-header">
                        <a href="/${encodeURIComponent(bookResult.book)}" class="search-result-book-title">
                            ${escapeHtml(bookResult.title || 'Untitled')}
                        </a>
                        <span class="search-result-book-author">${escapeHtml(bookResult.author || 'Unknown')}</span>
                    </div>
                    <ul class="search-result-matches">
            `;

            bookResult.matches.slice(0, 3).forEach(match => {
                const nodeAnchor = match.startLine ? `#${match.startLine}` : '';
                html += `
                    <li class="search-result-match">
                        <a href="/${encodeURIComponent(bookResult.book)}${nodeAnchor}"
                           class="search-result-match-link"
                           data-highlight-query="${escapeHtml(currentSearchQuery)}">
                            <span class="search-result-snippet">${match.headline}</span>
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
    resultsContainer.querySelectorAll('[data-highlight-query]').forEach(link => {
        link.addEventListener('click', (e) => {
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
    resultsContainer.innerHTML = '<div class="search-loading">Searching...</div>';
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');
}

/**
 * Show no results message
 */
function showNoResults() {
    const mode = isFullTextMode ? 'content' : 'titles and authors';
    resultsContainer.innerHTML = `<div class="search-no-results">No results found in ${mode}</div>`;
    resultsContainer.classList.remove('hidden');
    resultsContainer.classList.add('visible');
}

/**
 * Show error message
 */
function showError(message) {
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
 * Handle toggle between library and full-text search
 */
function handleToggleChange(event) {
    isFullTextMode = event.target.checked;

    // Save toggle state to localStorage
    localStorage.setItem(STORAGE_KEY_FULLTEXT, isFullTextMode.toString());

    // Update placeholder text
    searchInput.placeholder = isFullTextMode
        ? 'Search all content...'
        : 'Search titles & authors...';

    // Re-run search if there's a query
    const query = searchInput.value.trim();
    if (query.length >= MIN_QUERY_LENGTH) {
        performSearch(query);
    }

    verbose.content(`Search mode changed to: ${isFullTextMode ? 'fulltext' : 'library'}`, 'homepageSearch.js');
}

/**
 * Handle keyboard navigation
 */
function handleKeyDown(event) {
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
    if (query.length >= MIN_QUERY_LENGTH) {
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
function handleOutsideClick(event) {
    const searchArea = document.getElementById('homepage-search-container');
    if (searchArea && !searchArea.contains(event.target)) {
        hideResults();
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
