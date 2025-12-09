// searchToolbar.js - Manages the search toolbar for in-text search

import { log, verbose } from "../../utilities/logger.js";
import { cancelPendingNavigationCleanup, navigateToInternalId } from "../../scrolling.js";
import { getNodeChunksFromIndexedDB } from "../../indexedDB/nodes/read.js";
import { getLocalStorageKey } from "../../indexedDB/index.js";
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
    this.matchesByChunk = new Map(); // chunk_id -> array of matches with matchIndex
    this.initialStartLine = null;  // Scroll position when search opened (for nearest match)

    // Bound event handlers
    this.boundInputHandler = this.handleInput.bind(this);
    this.boundPrevHandler = this.handlePrev.bind(this);
    this.boundNextHandler = this.handleNext.bind(this);
    this.boundKeydownHandler = this.handleKeydown.bind(this);
    this.boundClickOutsideHandler = this.handleClickOutside.bind(this);
    // Touch handlers with preventDefault to avoid ghost clicks
    this.boundPrevTouchHandler = (e) => { e.preventDefault(); this.handlePrev(); };
    this.boundNextTouchHandler = (e) => { e.preventDefault(); this.handleNext(); };

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
      this.prevButton.addEventListener('touchend', this.boundPrevTouchHandler);
    }

    if (this.nextButton) {
      this.nextButton.addEventListener('click', this.boundNextHandler);
      this.nextButton.addEventListener('touchend', this.boundNextTouchHandler);
    }

    verbose.init('SearchToolbar: Event listeners attached', '/search/inTextSearch/searchToolbar.js');
  }

  /**
   * Open the search toolbar
   */
  async open() {
    if (!this.toolbar) return;

    log.init('SearchToolbar: Opening', '/search/inTextSearch/searchToolbar.js');

    // Capture initial scroll position for nearest-match search
    this.initialStartLine = this.getCurrentVisibleStartLine();
    verbose.init(`SearchToolbar: Captured initial position: ${this.initialStartLine}`, '/search/inTextSearch/searchToolbar.js');

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

    // Clear previous highlights from DOM when query changes
    clearSearchHighlights();
    this.matchesByChunk = new Map();

    if (!query || query.length === 0) {
      this.matches = [];
      this.currentMatchIndex = -1;
      this.updateNavigationButtons(false);
      this.updateMatchCounter(0, 0);

      // Return to initial reading position when search is cleared
      if (this.initialStartLine !== null && currentLazyLoader) {
        verbose.init(`SearchToolbar: Search cleared, returning to initial position: ${this.initialStartLine}`, '/search/inTextSearch/searchToolbar.js');
        navigateToInternalId(String(this.initialStartLine), currentLazyLoader, false);
      }
      return;
    }

    // Perform search
    if (this.searchIndexCache) {
      this.matches = searchIndex(this.searchIndexCache, query);

      if (this.matches.length > 0) {
        // Group matches by chunk_id for efficient batch insertion
        this.matches.forEach((match, index) => {
          const chunkId = match.chunk_id;
          if (!this.matchesByChunk.has(chunkId)) {
            this.matchesByChunk.set(chunkId, []);
          }
          this.matchesByChunk.get(chunkId).push({ ...match, matchIndex: index });
        });

        // Apply marks to chunks already in DOM
        this.applyMarksToLoadedChunks();

        // Find the first match at or after current scroll position
        this.currentMatchIndex = this.findNearestMatchIndex();
        this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
        this.updateNavigationButtons(true);
        // Navigate to the nearest match
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
    const chunkId = match.chunk_id;
    const targetId = String(match.startLine);

    verbose.init(`SearchToolbar: Navigating to match ${this.currentMatchIndex + 1}/${this.matches.length} (startLine: ${targetId}, chunk: ${chunkId})`, '/search/inTextSearch/searchToolbar.js');

    if (!currentLazyLoader) return;

    // Check if chunk is already loaded - if so, skip navigation and go directly to mark
    const chunkAlreadyLoaded = currentLazyLoader.currentlyLoadedChunks?.has(chunkId);

    if (chunkAlreadyLoaded) {
      // Chunk is loaded - just highlight and scroll to mark directly
      this.highlightCurrentMatch();
    } else {
      // Chunk not loaded - need to load it first
      navigateToInternalId(targetId, currentLazyLoader, false);

      // Apply highlight after a short delay to let chunk load
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
    const chunkId = match.chunk_id;

    // Ensure all marks for this chunk are applied
    this.applyMarksForChunk(chunkId);

    // Remove 'current' from all marks
    document.querySelectorAll('mark.search-highlight.current').forEach(m => {
      m.classList.remove('current');
    });

    // Add 'current' to the target mark
    const markEl = document.getElementById(`search-match-${this.currentMatchIndex}`);
    if (markEl) {
      markEl.classList.add('current');
      markEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /**
   * Apply all search marks for a specific chunk
   * @param {number} chunkId - The chunk ID to apply marks for
   */
  applyMarksForChunk(chunkId) {
    const chunkMatches = this.matchesByChunk.get(chunkId);
    if (!chunkMatches) return;

    chunkMatches.forEach(match => {
      const markId = `search-match-${match.matchIndex}`;

      // Skip if mark already exists (handles chunk reload case)
      if (document.getElementById(markId)) return;

      const element = document.getElementById(String(match.startLine));
      if (!element) return;

      const isCurrent = match.matchIndex === this.currentMatchIndex;
      applySearchHighlight(element, match.charStart, match.charEnd, isCurrent, markId);
    });
  }

  /**
   * Apply marks to all currently loaded chunks
   * Called when the search query changes to immediately show results in visible chunks
   */
  applyMarksToLoadedChunks() {
    if (!currentLazyLoader?.currentlyLoadedChunks) return;

    // For each loaded chunk, apply marks if we have matches there
    currentLazyLoader.currentlyLoadedChunks.forEach(chunkId => {
      if (this.matchesByChunk.has(chunkId)) {
        this.applyMarksForChunk(chunkId);
      }
    });
  }

  /**
   * Get the current visible element's startLine from sessionStorage
   * @returns {number|null} The startLine of the currently visible element, or null
   */
  getCurrentVisibleStartLine() {
    if (!currentLazyLoader?.bookId) return null;

    try {
      const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
      const sessionData = sessionStorage.getItem(scrollKey);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        if (parsed?.elementId) {
          return parseFloat(parsed.elementId);
        }
      }
    } catch (e) {
      console.warn('SearchToolbar: Error reading scroll position', e);
    }
    return null;
  }

  /**
   * Find the index of the first match at or after the initial scroll position (when search opened)
   * @returns {number} The index of the nearest match (0 if none found after initial position)
   */
  findNearestMatchIndex() {
    if (this.matches.length === 0) return 0;

    // Use the position captured when search opened
    if (this.initialStartLine === null) return 0;

    // Find first match with startLine >= initial position
    for (let i = 0; i < this.matches.length; i++) {
      if (parseFloat(this.matches[i].startLine) >= this.initialStartLine) {
        verbose.init(`SearchToolbar: Starting from match ${i + 1} (startLine ${this.matches[i].startLine} >= initial ${this.initialStartLine})`, '/search/inTextSearch/searchToolbar.js');
        return i;
      }
    }

    // No match after initial position - wrap to first match
    verbose.init(`SearchToolbar: No matches after initial position (${this.initialStartLine}), wrapping to first match`, '/search/inTextSearch/searchToolbar.js');
    return 0;
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
    this.matchesByChunk = new Map();
    this.initialStartLine = null;
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
      this.prevButton.removeEventListener('touchend', this.boundPrevTouchHandler);
    }

    if (this.nextButton) {
      this.nextButton.removeEventListener('click', this.boundNextHandler);
      this.nextButton.removeEventListener('touchend', this.boundNextTouchHandler);
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
