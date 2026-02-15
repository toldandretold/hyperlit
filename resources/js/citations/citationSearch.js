/**
 * Citation Search Module
 * Handles searching the library for citations to insert
 * Uses a lightweight toolbar (same pattern as search-toolbar)
 *
 * ⚠️ DEPRECATED - This module is being replaced by CitationMode in editToolbar/citationMode.js
 * The citation search interface is now integrated directly into the edit toolbar.
 * This file is kept temporarily for rollback capability and will be removed after migration.
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

// Touch tracking for scroll vs tap detection
let touchStartX = null;
let touchStartY = null;
const TAP_THRESHOLD = 10; // pixels - if touch moves more than this, it's a scroll

// Bound event handlers (for cleanup)
let boundDocumentClickHandler = null;
let boundDocumentKeyDownHandler = null;
let boundDocumentTouchStartHandler = null;
let boundDocumentTouchEndHandler = null;
let boundInputHandler = null;

/**
 * Initialize the citation search functionality
 * Sets up event delegation for clicks and keyboard
 */
export function initializeCitationSearch() {
  boundDocumentClickHandler = handleDocumentClick;
  boundDocumentKeyDownHandler = handleDocumentKeyDown;
  boundDocumentTouchStartHandler = handleDocumentTouchStart;
  boundDocumentTouchEndHandler = handleDocumentTouchEnd;

  document.addEventListener('click', boundDocumentClickHandler, true);
  document.addEventListener('keydown', boundDocumentKeyDownHandler, true);
  document.addEventListener('touchstart', boundDocumentTouchStartHandler, { capture: true, passive: true });
  document.addEventListener('touchend', boundDocumentTouchEndHandler, true);

  // Set up input listener on the static input element
  const searchInput = document.getElementById('citation-search-input');
  if (searchInput) {
    boundInputHandler = handleSearchInput;
    searchInput.addEventListener('input', boundInputHandler);
  }

  console.log('✅ Citation search initialized');
}

/**
 * Clean up event listeners
 */
export function destroyCitationSearch() {
  if (boundDocumentClickHandler) {
    document.removeEventListener('click', boundDocumentClickHandler, true);
    boundDocumentClickHandler = null;
  }

  if (boundDocumentKeyDownHandler) {
    document.removeEventListener('keydown', boundDocumentKeyDownHandler, true);
    boundDocumentKeyDownHandler = null;
  }

  if (boundDocumentTouchStartHandler) {
    document.removeEventListener('touchstart', boundDocumentTouchStartHandler, { capture: true, passive: true });
    boundDocumentTouchStartHandler = null;
  }

  if (boundDocumentTouchEndHandler) {
    document.removeEventListener('touchend', boundDocumentTouchEndHandler, true);
    boundDocumentTouchEndHandler = null;
  }

  // Reset touch tracking
  touchStartX = null;
  touchStartY = null;

  const searchInput = document.getElementById('citation-search-input');
  if (searchInput && boundInputHandler) {
    searchInput.removeEventListener('input', boundInputHandler);
    boundInputHandler = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (abortController) {
    abortController.abort();
  }

  pendingContext = null;
  isOpen = false;
}

/**
 * Open the citation search toolbar
 * @param {Object} context - Context for the citation insertion
 * @param {string} context.bookId - The current book ID
 * @param {Range} context.range - The saved selection range
 * @param {Function} context.saveCallback - Callback to save node changes
 */
export function openCitationSearchContainer(context) {
  const toolbar = document.getElementById('citation-toolbar');
  const searchInput = document.getElementById('citation-search-input');
  const resultsContainer = document.getElementById('citation-toolbar-results');

  if (!toolbar) {
    console.error('citation-toolbar not found');
    return;
  }

  // Store context for when citation is selected
  pendingContext = context;

  // Clear previous results and input
  if (resultsContainer) {
    resultsContainer.innerHTML = '';
  }
  if (searchInput) {
    searchInput.value = '';
  }

  // Show toolbar (same pattern as search-toolbar)
  toolbar.classList.add('visible');
  isOpen = true;

  // Prevent scroll chaining when results container isn't scrollable
  if (resultsContainer) {
    resultsContainer.addEventListener('touchmove', handleResultsContainerTouch, { passive: false });
  }

  // Focus input after a short delay to ensure toolbar is visible
  if (searchInput) {
    setTimeout(() => {
      searchInput.focus();
    }, 100);
  }

  console.log('📖 Citation search toolbar opened');
}

/**
 * Handle touch events on results container to prevent parent scrolling when not scrollable
 */
function handleResultsContainerTouch(e) {
  const container = e.currentTarget;
  const isScrollable = container.scrollHeight > container.clientHeight;

  // If container isn't scrollable, prevent touch from scrolling parent
  // Don't use stopPropagation - let clicks still work
  if (!isScrollable) {
    e.preventDefault();
  }
}

/**
 * Close the citation search toolbar
 */
export function closeCitationSearchContainer() {
  const toolbar = document.getElementById('citation-toolbar');
  const searchInput = document.getElementById('citation-search-input');
  const resultsContainer = document.getElementById('citation-toolbar-results');

  if (toolbar) {
    toolbar.classList.remove('visible');
  }

  // Clear input and results
  if (searchInput) {
    searchInput.value = '';
    searchInput.blur();
  }
  if (resultsContainer) {
    resultsContainer.innerHTML = '';
    resultsContainer.removeEventListener('touchmove', handleResultsContainerTouch);
  }

  // Clear pending context
  pendingContext = null;
  isOpen = false;

  // Abort any pending search
  if (abortController) {
    abortController.abort();
  }

  // Clear debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  console.log('📖 Citation search toolbar closed');
}

/**
 * Handle document clicks with event delegation
 */
function handleDocumentClick(event) {
  console.log('🔍 Citation click - isOpen:', isOpen, 'target:', event.target.tagName, event.target.className);

  if (!isOpen) return;

  const toolbar = document.getElementById('citation-toolbar');
  const isInside = toolbar && toolbar.contains(event.target);

  console.log('🔍 toolbar found:', !!toolbar, 'isInside:', isInside);

  // If click is inside the toolbar, handle it
  if (isInside) {
    // Handle citation result item clicks
    const resultItem = event.target.closest('.citation-result-item');
    console.log('🔍 resultItem found:', !!resultItem);
    if (resultItem) {
      event.preventDefault();
      event.stopPropagation();
      handleCitationSelection(resultItem);
    }
    // For other clicks inside toolbar (input, etc.), do nothing
    return;
  }

  // Click is outside the toolbar - close it
  console.log('🔍 Click outside - closing');
  closeCitationSearchContainer();
}

/**
 * Handle document touchstart events (for scroll vs tap detection)
 */
function handleDocumentTouchStart(event) {
  if (!isOpen) return;

  const touch = event.touches?.[0];
  if (touch) {
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }
}

/**
 * Handle document touchend events (for mobile)
 * Only acts on TAPS (< 10px movement), ignores SCROLLS
 */
function handleDocumentTouchEnd(event) {
  if (!isOpen) return;

  const touch = event.changedTouches?.[0];
  if (!touch) return;

  // Check if this was a scroll (moved > threshold) vs tap
  if (touchStartX !== null && touchStartY !== null) {
    const deltaX = Math.abs(touch.clientX - touchStartX);
    const deltaY = Math.abs(touch.clientY - touchStartY);

    // Reset for next touch
    touchStartX = null;
    touchStartY = null;

    // If moved significantly, it's a scroll - don't close or select
    if (deltaX > TAP_THRESHOLD || deltaY > TAP_THRESHOLD) {
      return;
    }
  }

  // This is a tap - handle it
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!target) return;

  const toolbar = document.getElementById('citation-toolbar');
  const isInside = toolbar && toolbar.contains(target);

  if (isInside) {
    const resultItem = target.closest('.citation-result-item');
    if (resultItem) {
      event.preventDefault();
      handleCitationSelection(resultItem);
    }
    return;
  }

  // Tap outside - close
  closeCitationSearchContainer();
}

/**
 * Handle document keydown events
 */
function handleDocumentKeyDown(event) {
  if (!isOpen) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeCitationSearchContainer();
  }
}

/**
 * Handle search input with debouncing
 */
function handleSearchInput(event) {
  if (!isOpen) return;

  const query = event.target.value.trim();
  const resultsContainer = document.getElementById('citation-toolbar-results');

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
      resultsContainer.innerHTML = '';
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
  const resultsContainer = document.getElementById('citation-toolbar-results');
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
  console.log('🔍 handleCitationSelection called with button:', button);

  const citedBookId = button.getAttribute('data-book-id');
  const bibtex = button.getAttribute('data-bibtex');

  console.log('🔍 citedBookId:', citedBookId, 'bibtex length:', bibtex?.length);

  if (!citedBookId) {
    console.error('No book ID found on citation result');
    return;
  }

  console.log('🔍 pendingContext:', pendingContext);

  if (!pendingContext) {
    console.error('No pending citation context');
    closeCitationSearchContainer();
    return;
  }

  console.log(`📝 Citation selected: ${citedBookId}`);

  try {
    console.log('🔍 About to insert citation');
    console.log('🔍 pendingContext.range:', pendingContext.range);
    console.log('🔍 pendingContext.range.collapsed:', pendingContext.range?.collapsed);
    console.log('🔍 pendingContext.range.startContainer:', pendingContext.range?.startContainer);

    // Dynamic import to avoid circular dependencies
    const { insertCitationAtCursor } = await import('./citationInserter.js');

    console.log('🔍 Calling insertCitationAtCursor...');

    // Insert the citation
    await insertCitationAtCursor(
      pendingContext.range,
      pendingContext.bookId,
      citedBookId,
      bibtex,
      pendingContext.saveCallback
    );

    console.log('🔍 insertCitationAtCursor completed');

    // Close the search toolbar
    closeCitationSearchContainer();

  } catch (error) {
    console.error('Error inserting citation:', error);
    console.error('Error stack:', error.stack);
    showError('Failed to insert citation');
  }
}

/**
 * Show error message in results
 */
function showError(message) {
  const resultsContainer = document.getElementById('citation-toolbar-results');
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
