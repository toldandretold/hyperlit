/**
 * Citation Search Module
 * Handles searching the library for citations to insert
 * Uses the bottom-up-container with custom content injection
 */

import DOMPurify from 'dompurify';
import { formatBibtexToCitation } from '../utilities/bibtexProcessor.js';

// Configuration
const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const RESULTS_LIMIT = 15;

// State
let debounceTimer = null;
let abortController = null;
let pendingContext = null;
let isOpen = false;

// Bound event handlers (for cleanup)
let boundDocumentClickHandler = null;
let boundDocumentKeyDownHandler = null;

/**
 * Generate the citation search HTML content
 */
function generateCitationSearchContent() {
  return `
    <div class="citation-search-wrapper">
      <input type="text"
             id="citation-search-input"
             class="citation-search-input"
             placeholder="Search library for citation..."
             autocomplete="off"
             spellcheck="false">
      <div id="citation-search-results" class="citation-search-results">
        <div class="citation-search-empty">Type to search library...</div>
      </div>
    </div>
  `;
}

/**
 * Initialize the citation search functionality
 * Uses event delegation - no need to bind to specific elements
 */
export function initializeCitationSearch() {
  // Set up document-level event delegation
  boundDocumentClickHandler = handleDocumentClick;
  boundDocumentKeyDownHandler = handleDocumentKeyDown;

  document.addEventListener('click', boundDocumentClickHandler);
  document.addEventListener('keydown', boundDocumentKeyDownHandler);

  console.log('✅ Citation search initialized (event delegation)');
}

/**
 * Clean up event listeners
 */
export function destroyCitationSearch() {
  if (boundDocumentClickHandler) {
    document.removeEventListener('click', boundDocumentClickHandler);
    boundDocumentClickHandler = null;
  }

  if (boundDocumentKeyDownHandler) {
    document.removeEventListener('keydown', boundDocumentKeyDownHandler);
    boundDocumentKeyDownHandler = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (abortController) {
    abortController.abort();
  }

  // Reset state
  pendingContext = null;
  isOpen = false;
}

/**
 * Open the citation search in the bottom-up-container
 * @param {Object} context - Context for the citation insertion
 * @param {string} context.bookId - The current book ID
 * @param {Range} context.range - The saved selection range
 * @param {Function} context.saveCallback - Callback to save node changes
 */
export function openCitationSearchContainer(context) {
  const container = document.getElementById('bottom-up-container');
  const overlay = document.getElementById('settings-overlay');

  if (!container) {
    console.error('bottom-up-container not found');
    return;
  }

  // Store context for when citation is selected
  pendingContext = context;

  // Inject citation search content
  container.innerHTML = generateCitationSearchContent();

  // Show container
  container.classList.remove('hidden');
  container.classList.add('open');

  if (overlay) {
    overlay.classList.add('active');
  }

  isOpen = true;

  // Set up input listener
  const searchInput = document.getElementById('citation-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', handleSearchInput);
    // Focus after a short delay to ensure container is visible
    setTimeout(() => {
      searchInput.focus();
    }, 100);
  }

  console.log('📖 Citation search opened in bottom-up-container');
}

/**
 * Close the citation search container
 */
export function closeCitationSearchContainer() {
  const container = document.getElementById('bottom-up-container');
  const overlay = document.getElementById('settings-overlay');

  if (container) {
    container.classList.remove('open');
    container.classList.add('hidden');
    // Restore original settings content on next open by settings button
  }

  if (overlay) {
    overlay.classList.remove('active');
  }

  // Clear pending context
  pendingContext = null;
  isOpen = false;

  // Abort any pending search
  if (abortController) {
    abortController.abort();
  }

  console.log('📖 Citation search closed');
}

/**
 * Handle document clicks with event delegation
 */
function handleDocumentClick(event) {
  if (!isOpen) return;

  const container = document.getElementById('bottom-up-container');

  // Handle citation result item clicks
  const resultItem = event.target.closest('.citation-result-item');
  if (resultItem && container?.contains(resultItem)) {
    event.preventDefault();
    event.stopPropagation();
    handleCitationSelection(resultItem);
    return;
  }

  // Handle overlay click to close
  const overlay = event.target.closest('#settings-overlay');
  if (overlay) {
    closeCitationSearchContainer();
    return;
  }
}

/**
 * Handle document keydown events
 */
function handleDocumentKeyDown(event) {
  if (!isOpen) return;

  if (event.key === 'Escape') {
    closeCitationSearchContainer();
  }
}

/**
 * Handle search input with debouncing
 */
function handleSearchInput(event) {
  const query = event.target.value.trim();
  const resultsContainer = document.getElementById('citation-search-results');

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
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="citation-search-empty">Type to search library...</div>';
    }
    return;
  }

  // Show loading state
  if (resultsContainer) {
    resultsContainer.innerHTML = '<div class="citation-search-loading">Searching...</div>';
  }

  // Debounce the search
  debounceTimer = setTimeout(() => {
    performSearch(query);
  }, DEBOUNCE_MS);
}

/**
 * Perform the actual search request
 */
async function performSearch(query) {
  const url = `/api/search/library?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`;

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
      await renderResults(data.results);
    } else {
      showError('Search failed. Please try again.');
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      // Request was aborted, ignore
      return;
    }
    console.error('Citation search error:', error);
    showError('Search failed. Please try again.');
  }
}

/**
 * Render search results as citation entries
 */
async function renderResults(results) {
  const resultsContainer = document.getElementById('citation-search-results');
  if (!resultsContainer) return;

  if (!results || results.length === 0) {
    resultsContainer.innerHTML = '<div class="citation-search-empty">No results found</div>';
    return;
  }

  // Build HTML for each result
  const resultItems = [];

  for (const result of results) {
    // Get formatted citation if bibtex exists
    let displayHtml = '';
    if (result.bibtex) {
      try {
        const formatted = await formatBibtexToCitation(result.bibtex);
        displayHtml = DOMPurify.sanitize(formatted, { ALLOWED_TAGS: ['i', 'em', 'b', 'strong', 'a'] });
      } catch (e) {
        displayHtml = escapeHtml(result.title || result.book);
      }
    } else {
      // Fallback to title and author
      const title = result.title || 'Untitled';
      const author = result.author || 'Unknown';
      displayHtml = `<span class="citation-title">${escapeHtml(title)}</span><span class="citation-author">${escapeHtml(author)}</span>`;
    }

    resultItems.push(`
      <button type="button"
              class="citation-result-item"
              data-book-id="${escapeHtml(result.book)}"
              data-bibtex="${escapeHtml(result.bibtex || '')}">
        ${displayHtml}
      </button>
    `);
  }

  resultsContainer.innerHTML = resultItems.join('');
}

/**
 * Handle selection of a citation result
 */
async function handleCitationSelection(button) {
  const citedBookId = button.getAttribute('data-book-id');
  const bibtex = button.getAttribute('data-bibtex');

  if (!citedBookId) {
    console.error('No book ID found on citation result');
    return;
  }

  if (!pendingContext) {
    console.error('No pending citation context');
    closeCitationSearchContainer();
    return;
  }

  console.log(`📝 Citation selected: ${citedBookId}`);

  try {
    // Dynamic import to avoid circular dependencies
    const { insertCitationAtCursor } = await import('./citationInserter.js');

    // Insert the citation
    await insertCitationAtCursor(
      pendingContext.range,
      pendingContext.bookId,
      citedBookId,
      bibtex,
      pendingContext.saveCallback
    );

    // Close the search container
    closeCitationSearchContainer();

  } catch (error) {
    console.error('Error inserting citation:', error);
    showError('Failed to insert citation');
  }
}

/**
 * Show error message in results
 */
function showError(message) {
  const resultsContainer = document.getElementById('citation-search-results');
  if (resultsContainer) {
    resultsContainer.innerHTML = `<div class="citation-search-empty" style="color: #ef4444;">${escapeHtml(message)}</div>`;
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
