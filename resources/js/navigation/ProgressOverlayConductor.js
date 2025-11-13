/**
 * ProgressOverlayConductor - Conducts when/why progress overlay should show
 * The "brains" that decides *when* to show overlay based on navigation type and context
 *
 * Delegates all actual DOM manipulation to ProgressOverlayEnactor (the "hands")
 * This class provides high-level business logic and navigation pathway decisions
 */
import { ProgressOverlayEnactor } from './ProgressOverlayEnactor.js';

export class ProgressOverlayConductor {
  /**
   * Show progress for initial page loads (pathway 1)
   * Uses the full overlay system
   */
  static showInitialPageLoad(percent = 5, message = 'Loading...') {
    // 🔥 CRITICAL: Don't show overlay if blade template already hid it
    // This happens for new book creation and imported books where content is immediately available
    const isNewBookCreation = sessionStorage.getItem('pending_new_book_sync');
    const isImportedBook = sessionStorage.getItem('pending_import_book');

    // Only show overlay if it's NOT a new book creation or import
    // For new books/imports, blade template correctly hides it and we should respect that
    if (!isNewBookCreation && !isImportedBook) {
      ProgressOverlayEnactor.show(percent, message);
      console.log(`📊 Initial page load progress: ${percent}% - ${message}`);
    } else {
      console.log(`📊 Skipping overlay for new book creation/import`);
    }
  }

  /**
   * Show progress for SPA transitions (pathways 2, 3, 4)
   * More lightweight, preserves existing UI elements
   */
  static showSPATransition(percent = 5, message = 'Loading...') {
    ProgressOverlayEnactor.show(percent, message);
    console.log(`📊 SPA transition progress: ${percent}% - ${message}`);
  }

  /**
   * Show progress specifically for book-to-book navigation (pathway 4)
   * Handles the case where we're already in reader mode
   */
  static showBookToBookTransition(percent = 5, message = 'Loading...', bookId = null) {
    const displayMessage = bookId ? `Loading ${bookId}...` : message;

    ProgressOverlayEnactor.show(percent, displayMessage);

    // Note: We don't call showNavigationLoading() here because we're already using
    // the initial-navigation-overlay above. Calling both creates duplicate overlays
    // that don't get properly cleaned up and cause black screen issues.

    console.log(`📊 Book-to-book transition progress: ${percent}% - ${displayMessage}`);
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
    console.log('📊 ProgressOverlayConductor.hide() - delegating to ProgressOverlayEnactor');
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