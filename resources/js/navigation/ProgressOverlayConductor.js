/**
 * ProgressOverlayConductor - Conducts when/why progress overlay should show
 * The "brains" that decides *when* to show overlay based on navigation type and context
 *
 * Delegates all actual DOM manipulation to ProgressOverlayEnactor (the "hands")
 * This class provides high-level business logic and navigation pathway decisions
 */
import { ProgressOverlayEnactor } from './ProgressOverlayEnactor.js';
import { verbose } from '../utilities/logger.js';

export class ProgressOverlayConductor {
  /**
   * Show progress for initial page loads (pathway 1)
   * Uses the full overlay system
   *
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Progress message to display
   * @param {boolean} blockInteractions - If true, block all user interactions (default: false)
   */
  static showInitialPageLoad(percent = 5, message = 'Loading...', blockInteractions = false) {
    // 🔥 CRITICAL: Don't show overlay if blade template already hid it
    // This happens for new book creation and imported books where content is immediately available
    const isNewBookCreation = sessionStorage.getItem('pending_new_book_sync');
    const isImportedBook = sessionStorage.getItem('pending_import_book');

    // Only show overlay if it's NOT a new book creation or import
    // For new books/imports, blade template correctly hides it and we should respect that
    if (!isNewBookCreation && !isImportedBook) {
      ProgressOverlayEnactor.show(percent, message, blockInteractions);
      verbose.debug(`Initial page load progress: ${percent}% - ${message}`, 'navigation/ProgressOverlayConductor.js');
    } else {
      verbose.debug('Skipping overlay for new book creation/import', 'navigation/ProgressOverlayConductor.js');
    }
  }

  /**
   * Show progress for SPA transitions (pathways 2, 3, 4)
   * More lightweight, preserves existing UI elements
   *
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Progress message to display
   * @param {boolean} blockInteractions - If true, block all user interactions (default: false)
   */
  static showSPATransition(percent = 5, message = 'Loading...', blockInteractions = false) {
    ProgressOverlayEnactor.show(percent, message, blockInteractions);
    verbose.debug(`SPA transition progress: ${percent}% - ${message}`, 'navigation/ProgressOverlayConductor.js');
  }

  /**
   * Show progress specifically for book-to-book navigation (pathway 4)
   * Handles the case where we're already in reader mode
   *
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Progress message to display
   * @param {string|null} bookId - Book ID to display in message
   * @param {boolean} blockInteractions - If true, block all user interactions (default: false)
   */
  static showBookToBookTransition(percent = 5, message = 'Loading...', bookId = null, blockInteractions = false) {
    const displayMessage = bookId ? `Loading ${bookId}...` : message;

    ProgressOverlayEnactor.show(percent, displayMessage, blockInteractions);

    // Note: We don't call showNavigationLoading() here because we're already using
    // the initial-navigation-overlay above. Calling both creates duplicate overlays
    // that don't get properly cleaned up and cause black screen issues.

    verbose.debug(`Book-to-book transition progress: ${percent}% - ${displayMessage}`, 'navigation/ProgressOverlayConductor.js');
  }

  /**
   * Update progress bar and text
   */
  static updateProgress(percent, message = null) {
    ProgressOverlayEnactor.update(percent, message);
  }

  /**
   * Hide all progress indicators
   *
   * ✅ DELEGATES TO ENACTOR
   * This method simply delegates to ProgressOverlayEnactor for clean, centralized hiding
   */
  static async hide() {
    verbose.content('ProgressOverlayConductor.hide() - delegating to ProgressOverlayEnactor', 'navigation/ProgressOverlayConductor.js');
    return await ProgressOverlayEnactor.hide();
  }

  /**
   * Check if progress is currently visible
   */
  static isVisible() {
    return ProgressOverlayEnactor.isVisible();
  }

  /**
   * Create a progress callback function for use with async operations
   */
  static createProgressCallback(type = 'spa', bookId = null) {
    return (percent, message) => {
      switch (type) {
        case 'initial':
          this.showInitialPageLoad(percent, message);
          break;
        case 'book-to-book':
          this.showBookToBookTransition(percent, message, bookId);
          break;
        case 'spa':
        default:
          this.showSPATransition(percent, message);
          break;
      }
    };
  }
}