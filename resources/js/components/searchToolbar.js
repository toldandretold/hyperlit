// searchToolbar.js - Manages the search toolbar for in-text search

import { log, verbose } from "../utilities/logger.js";
import { cancelPendingNavigationCleanup } from "../scrolling.js";

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

    verbose.init('SearchToolbar initialized', '/components/searchToolbar.js');
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

    verbose.init('SearchToolbar: DOM elements bound', '/components/searchToolbar.js');
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

    verbose.init('SearchToolbar: Event listeners attached', '/components/searchToolbar.js');
  }

  /**
   * Open the search toolbar
   */
  open() {
    if (!this.toolbar) return;

    log.init('SearchToolbar: Opening', '/components/searchToolbar.js');

    // CRITICAL: Block any scroll restoration/navigation BEFORE we do anything
    // This prevents saved scroll positions from interfering
    window.searchToolbarBlockingNavigation = true;

    // Cancel any pending navigation cleanup timers from previous navigations
    cancelPendingNavigationCleanup();

    this.toolbar.classList.add('visible');
    this.isOpen = true;

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
  }

  /**
   * Close the search toolbar
   */
  close() {
    if (!this.toolbar) return;

    log.init('SearchToolbar: Closing', '/components/searchToolbar.js');

    this.toolbar.classList.remove('visible');
    this.isOpen = false;

    // Clear navigation blocking flag
    window.searchToolbarBlockingNavigation = false;

    // Restore perimeter buttons
    this.showPerimeterButtons();

    // Remove click outside listener
    document.removeEventListener('click', this.boundClickOutsideHandler, true);

    // Clear input
    if (this.input) {
      this.input.value = '';
      this.input.blur();
    }

    // Clear any search highlights (will be implemented later)
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
    verbose.init(`SearchToolbar: Input changed - "${query}"`, '/components/searchToolbar.js');

    // Placeholder for future search functionality
    // This will eventually:
    // 1. Search through IndexedDB
    // 2. Highlight matches in the document
    // 3. Update match counter
    // 4. Enable/disable navigation buttons

    if (query.length > 0) {
      // For now, just enable navigation buttons as placeholder
      this.updateNavigationButtons(true);
    } else {
      this.updateNavigationButtons(false);
      this.updateMatchCounter(0, 0);
      this.clearSearch();
    }
  }

  /**
   * Handle previous match button
   */
  handlePrev() {
    verbose.init('SearchToolbar: Previous match', '/components/searchToolbar.js');
    // Placeholder for navigation to previous match
  }

  /**
   * Handle next match button
   */
  handleNext() {
    verbose.init('SearchToolbar: Next match', '/components/searchToolbar.js');
    // Placeholder for navigation to next match
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
   * Clear search highlights and results
   * Placeholder for future implementation
   */
  clearSearch() {
    verbose.init('SearchToolbar: Clearing search', '/components/searchToolbar.js');
    // This will eventually:
    // 1. Remove all highlight marks from document
    // 2. Clear search results from memory
    // 3. Reset IndexedDB search state
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

    verbose.init('SearchToolbar: Perimeter buttons hidden', '/components/searchToolbar.js');
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

    verbose.init('SearchToolbar: Perimeter buttons shown', '/components/searchToolbar.js');
  }

  /**
   * Rebind elements after SPA transitions
   */
  rebindElements() {
    this.bindElements();
    verbose.init('SearchToolbar: Elements rebound', '/components/searchToolbar.js');
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

    verbose.init('SearchToolbar: Event listeners removed', '/components/searchToolbar.js');
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
    log.init('Search Toolbar initialized', '/components/searchToolbar.js');
  } else {
    // Manager exists, just rebind elements after SPA transition
    searchToolbarManager.rebindElements();
    verbose.init('Search Toolbar rebound', '/components/searchToolbar.js');
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
    verbose.init('Search Toolbar destroyed', '/components/searchToolbar.js');
    return true;
  }
  return false;
}
