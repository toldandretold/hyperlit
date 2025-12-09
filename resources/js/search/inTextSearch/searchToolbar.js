// searchToolbar.js - Manages the search toolbar for in-text search

import { log, verbose } from "../../utilities/logger.js";
import { cancelPendingNavigationCleanup, navigateToInternalId } from "../../scrolling.js";
import { getNodeChunksFromIndexedDB } from "../../indexedDB/nodes/read.js";
import { currentLazyLoader } from "../../initializePage.js";
import { buildSearchIndex, searchIndex } from "./searchEngine.js";
import {
  applySearchHighlight,
  clearSearchHighlights,
  setSearchMode
} from "./searchHighlight.js";

/**
 * SearchToolbarManager - Manages the search toolbar UI and state
 */
class SearchToolbarManager {
  constructor() {
    this.toolbar = null;
    this.input = null;
    this.prevButton = null;
    this.nextButton = null;
    this.matchCounter = null;
    this.isOpen = false;

    // Search state
    this.searchIndexCache = null;  // Cached search index
    this.matches = [];             // Current search matches
    this.currentMatchIndex = -1;   // Current match position

    // Bound event handlers
    this.boundInputHandler = this.handleInput.bind(this);
    this.boundPrevHandler = this.handlePrev.bind(this);
    this.boundNextHandler = this.handleNext.bind(this);
    this.boundKeydownHandler = this.handleKeydown.bind(this);
    this.boundClickOutsideHandler = this.handleClickOutside.bind(this);

    // Bind elements
    this.bindElements();

    // Setup event listeners
    this.setupEventListeners();

    verbose.init('SearchToolbar initialized', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Bind DOM elements
   */
  bindElements() {
    this.toolbar = document.getElementById('search-toolbar');
    this.input = document.getElementById('search-input');
    this.prevButton = document.getElementById('search-prev-button');
    this.nextButton = document.getElementById('search-next-button');
    this.matchCounter = document.getElementById('search-match-counter');

    if (!this.toolbar) {
      console.warn('SearchToolbar: search-toolbar element not found');
      return;
    }

    verbose.init('SearchToolbar: DOM elements bound', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    if (!this.toolbar) return;

    // Input field
    if (this.input) {
      this.input.addEventListener('input', this.boundInputHandler);
      this.input.addEventListener('keydown', this.boundKeydownHandler);
    }

    // Navigation buttons
    if (this.prevButton) {
      this.prevButton.addEventListener('click', this.boundPrevHandler);
    }

    if (this.nextButton) {
      this.nextButton.addEventListener('click', this.boundNextHandler);
    }

    verbose.init('SearchToolbar: Event listeners attached', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Open the search toolbar
   */
  async open() {
    if (!this.toolbar) return;

    log.init('SearchToolbar: Opening', '/search/inTextSearch/searchToolbar.js');

    // Cancel any pending navigation cleanup timers from previous navigations
    cancelPendingNavigationCleanup();

    this.toolbar.classList.add('visible');
    this.isOpen = true;

    // Enable search mode (dims other highlights)
    setSearchMode(true);

    // Hide perimeter buttons for clean search UI
    this.hidePerimeterButtons();

    // Add click outside listener
    setTimeout(() => {
      document.addEventListener('click', this.boundClickOutsideHandler, true);
    }, 100);

    // Focus the input field
    if (this.input) {
      // Delay focus slightly to ensure keyboard handling is ready
      setTimeout(() => {
        this.input.focus();
      }, 100);
    }

    // Reset match counter
    this.updateMatchCounter(0, 0);

    // Disable navigation buttons initially
    this.updateNavigationButtons(false);

    // Build search index if not cached
    await this.ensureSearchIndex();
  }

  /**
   * Ensure search index is built
   */
  async ensureSearchIndex() {
    // If we already have an index, don't rebuild
    if (this.searchIndexCache) {
      verbose.init('SearchToolbar: Using cached search index', '/search/inTextSearch/searchToolbar.js');
      return;
    }

    // Get book ID from lazyLoader
    const bookId = currentLazyLoader?.bookId;
    if (!bookId) {
      console.warn('SearchToolbar: No bookId available');
      return;
    }

    try {
      const nodes = await getNodeChunksFromIndexedDB(bookId);
      this.searchIndexCache = buildSearchIndex(nodes);
      verbose.init(`SearchToolbar: Index built with ${this.searchIndexCache.length} entries`, '/search/inTextSearch/searchToolbar.js');
    } catch (error) {
      console.error('SearchToolbar: Failed to build search index', error);
    }
  }

  /**
   * Close the search toolbar
   */
  close() {
    if (!this.toolbar) return;

    log.init('SearchToolbar: Closing', '/search/inTextSearch/searchToolbar.js');

    this.toolbar.classList.remove('visible');
    this.isOpen = false;

    // Disable search mode and clear highlights
    setSearchMode(false);
    clearSearchHighlights();

    // Restore perimeter buttons
    this.showPerimeterButtons();

    // Remove click outside listener
    document.removeEventListener('click', this.boundClickOutsideHandler, true);

    // Clear input
    if (this.input) {
      this.input.value = '';
      this.input.blur();
    }

    // Clear search state but keep index cached
    this.clearSearch();
  }

  /**
   * Toggle the search toolbar
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Handle input changes
   */
  handleInput(e) {
    const query = e.target.value;
    verbose.init(`SearchToolbar: Input changed - "${query}"`, '/search/inTextSearch/searchToolbar.js');

    // Clear previous highlights when query changes
    clearSearchHighlights();

    if (!query || query.length === 0) {
      this.matches = [];
      this.currentMatchIndex = -1;
      this.updateNavigationButtons(false);
      this.updateMatchCounter(0, 0);
      return;
    }

    // Perform search
    if (this.searchIndexCache) {
      this.matches = searchIndex(this.searchIndexCache, query);

      if (this.matches.length > 0) {
        this.currentMatchIndex = 0;
        this.updateMatchCounter(1, this.matches.length);
        this.updateNavigationButtons(true);
        // Navigate to first match
        this.navigateToCurrentMatch();
      } else {
        this.currentMatchIndex = -1;
        this.updateMatchCounter(0, 0);
        this.updateNavigationButtons(false);
      }
    }
  }

  /**
   * Navigate to the current match and highlight it
   */
  navigateToCurrentMatch() {
    if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
      return;
    }

    const match = this.matches[this.currentMatchIndex];
    const targetId = String(match.startLine);

    verbose.init(`SearchToolbar: Navigating to match ${this.currentMatchIndex + 1}/${this.matches.length} (startLine: ${targetId}, char: ${match.charStart}-${match.charEnd})`, '/search/inTextSearch/searchToolbar.js');

    if (currentLazyLoader) {
      navigateToInternalId(targetId, currentLazyLoader, false);

      // Apply highlight after a short delay to let chunk load if needed
      setTimeout(() => {
        this.highlightCurrentMatch();
      }, 300);
    }
  }

  /**
   * Highlight the current match in the DOM
   */
  highlightCurrentMatch() {
    if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
      return;
    }

    const match = this.matches[this.currentMatchIndex];
    const element = document.getElementById(String(match.startLine));

    if (!element) {
      console.warn('SearchToolbar: Element not found for highlight', match.startLine);
      return;
    }

    // Clear previous highlights first
    clearSearchHighlights();

    // Apply highlight to current match
    const markEl = applySearchHighlight(element, match.charStart, match.charEnd, true);

    if (markEl) {
      // Scroll the mark into view if it's not visible
      markEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /**
   * Handle previous match button
   */
  handlePrev() {
    if (this.matches.length === 0) return;

    verbose.init('SearchToolbar: Previous match', '/search/inTextSearch/searchToolbar.js');

    // Wrap around to end if at beginning
    if (this.currentMatchIndex <= 0) {
      this.currentMatchIndex = this.matches.length - 1;
    } else {
      this.currentMatchIndex--;
    }

    this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
    this.navigateToCurrentMatch();
  }

  /**
   * Handle next match button
   */
  handleNext() {
    if (this.matches.length === 0) return;

    verbose.init('SearchToolbar: Next match', '/search/inTextSearch/searchToolbar.js');

    // Wrap around to beginning if at end
    if (this.currentMatchIndex >= this.matches.length - 1) {
      this.currentMatchIndex = 0;
    } else {
      this.currentMatchIndex++;
    }

    this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
    this.navigateToCurrentMatch();
  }

  /**
   * Handle clicks outside the search toolbar
   */
  handleClickOutside(e) {
    // Don't close if clicking inside the toolbar
    if (this.toolbar && this.toolbar.contains(e.target)) {
      return;
    }

    // Don't close if clicking the settings button (which opens the toolbar)
    if (e.target.closest('#searchButton')) {
      return;
    }

    // Close the toolbar
    this.close();
  }

  /**
   * Handle keyboard shortcuts in search input
   */
  handleKeydown(e) {
    // Enter or Cmd/Ctrl+G = next match
    if (e.key === 'Enter' || (e.key === 'g' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      if (e.shiftKey) {
        this.handlePrev();
      } else {
        this.handleNext();
      }
    }
    // Escape = close search
    else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  /**
   * Update match counter display
   */
  updateMatchCounter(current, total) {
    if (this.matchCounter) {
      this.matchCounter.textContent = `${current} of ${total}`;
    }
  }

  /**
   * Update navigation button states
   */
  updateNavigationButtons(enabled) {
    if (this.prevButton) {
      this.prevButton.disabled = !enabled;
    }
    if (this.nextButton) {
      this.nextButton.disabled = !enabled;
    }
  }

  /**
   * Clear search results (keeps index cached)
   */
  clearSearch() {
    verbose.init('SearchToolbar: Clearing search', '/search/inTextSearch/searchToolbar.js');
    this.matches = [];
    this.currentMatchIndex = -1;
  }

  /**
   * Invalidate the search index (call when book changes)
   */
  invalidateIndex() {
    verbose.init('SearchToolbar: Invalidating search index', '/search/inTextSearch/searchToolbar.js');
    this.searchIndexCache = null;
    this.matches = [];
    this.currentMatchIndex = -1;
  }

  /**
   * Hide all perimeter buttons when search is open
   */
  hidePerimeterButtons() {
    const perimeterButtonIds = [
      'bottom-right-buttons',
      'bottom-left-buttons',
      'topRightContainer',
      'logoNavWrapper',
      'userButtonContainer'
    ];

    perimeterButtonIds.forEach(id => {
      const element = document.getElementById(id);
      if (element && !element.classList.contains('perimeter-hidden')) {
        element.classList.add('perimeter-hidden');
      }
    });

    verbose.init('SearchToolbar: Perimeter buttons hidden', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Show all perimeter buttons when search is closed
   */
  showPerimeterButtons() {
    const perimeterButtonIds = [
      'bottom-right-buttons',
      'bottom-left-buttons',
      'topRightContainer',
      'logoNavWrapper',
      'userButtonContainer'
    ];

    perimeterButtonIds.forEach(id => {
      const element = document.getElementById(id);
      if (element && element.classList.contains('perimeter-hidden')) {
        element.classList.remove('perimeter-hidden');
      }
    });

    verbose.init('SearchToolbar: Perimeter buttons shown', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Rebind elements after SPA transitions
   */
  rebindElements() {
    this.bindElements();
    // Invalidate index on rebind since book may have changed
    this.invalidateIndex();
    verbose.init('SearchToolbar: Elements rebound', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    // Remove click outside listener if it exists
    document.removeEventListener('click', this.boundClickOutsideHandler, true);

    if (this.input) {
      this.input.removeEventListener('input', this.boundInputHandler);
      this.input.removeEventListener('keydown', this.boundKeydownHandler);
    }

    if (this.prevButton) {
      this.prevButton.removeEventListener('click', this.boundPrevHandler);
    }

    if (this.nextButton) {
      this.nextButton.removeEventListener('click', this.boundNextHandler);
    }

    verbose.init('SearchToolbar: Event listeners removed', '/search/inTextSearch/searchToolbar.js');
  }
}

// Search toolbar manager instance (singleton)
let searchToolbarManager = null;

/**
 * Initialize the search toolbar manager
 */
export function initializeSearchToolbar() {
  if (!searchToolbarManager) {
    // Create new manager instance
    searchToolbarManager = new SearchToolbarManager();
    log.init('Search Toolbar initialized', '/search/inTextSearch/searchToolbar.js');
  } else {
    // Manager exists, just rebind elements after SPA transition
    searchToolbarManager.rebindElements();
    verbose.init('Search Toolbar rebound', '/search/inTextSearch/searchToolbar.js');
  }

  return searchToolbarManager;
}

/**
 * Get the search toolbar manager instance
 */
export function getSearchToolbar() {
  return searchToolbarManager;
}

/**
 * Open the search toolbar
 */
export function openSearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.open();
  }
}

/**
 * Close the search toolbar
 */
export function closeSearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.close();
  }
}

/**
 * Toggle the search toolbar
 */
export function toggleSearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.toggle();
  }
}

/**
 * Check if search toolbar is currently open
 */
export function isSearchToolbarOpen() {
  return searchToolbarManager ? searchToolbarManager.isOpen : false;
}

/**
 * Destroy search toolbar manager for cleanup during navigation
 */
export function destroySearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.destroy();
    searchToolbarManager = null;
    verbose.init('Search Toolbar destroyed', '/search/inTextSearch/searchToolbar.js');
    return true;
  }
  return false;
}

/**
 * Invalidate the search index (call when book changes or content is edited)
 */
export function invalidateSearchIndex() {
  if (searchToolbarManager) {
    searchToolbarManager.invalidateIndex();
  }
}
