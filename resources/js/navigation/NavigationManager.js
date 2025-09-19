/**
 * NavigationManager - Central coordinator for all navigation pathways
 * Routes navigation requests to the appropriate pathway handler
 */
import { ProgressManager } from './ProgressManager.js';

export class NavigationManager {
  /**
   * Route navigation request to appropriate pathway
   */
  static async navigate(pathway, options = {}) {
    console.log(`🧭 NavigationManager: Routing to ${pathway}`, options);
    
    try {
      switch (pathway) {
        case 'fresh-page-load':
          return await this.handleFreshPageLoad(options);
        
        case 'create-new-book':
          return await this.handleCreateNewBook(options);
        
        case 'import-book':
          return await this.handleImportBook(options);
        
        case 'book-to-book':
          return await this.handleBookToBookTransition(options);
        
        default:
          throw new Error(`Unknown navigation pathway: ${pathway}`);
      }
    } catch (error) {
      console.error(`❌ Navigation failed for pathway ${pathway}:`, error);
      ProgressManager.hide();
      throw error;
    }
  }

  /**
   * PATHWAY 1: Fresh page load (user refresh or direct URL)
   * Uses full initialization without SPA transitions
   */
  static async handleFreshPageLoad(options = {}) {
    console.log('🔄 NavigationManager: Fresh page load pathway');
    
    const { FreshPageLoader } = await import('./pathways/FreshPageLoader.js');
    return await FreshPageLoader.initialize(options);
  }

  /**
   * PATHWAY 2: Create new book (home.blade.php → reader.blade.php)
   * Full body replacement, enters edit mode
   */
  static async handleCreateNewBook(options = {}) {
    console.log('📝 NavigationManager: Create new book pathway');
    
    const { NewBookTransition } = await import('./pathways/NewBookTransition.js');
    return await NewBookTransition.execute(options);
  }

  /**
   * PATHWAY 3: Import book (form submission → reader.blade.php)
   * Backend processing with full body replacement
   */
  static async handleImportBook(options = {}) {
    console.log('📥 NavigationManager: Import book pathway');
    
    const { ImportBookTransition } = await import('./pathways/ImportBookTransition.js');
    return await ImportBookTransition.execute(options);
  }

  /**
   * PATHWAY 4: Book-to-book navigation (reader → reader)
   * Content replacement only, preserves navigation
   */
  static async handleBookToBookTransition(options = {}) {
    console.log('📖 NavigationManager: Book-to-book transition pathway');
    
    const { BookToBookTransition } = await import('./pathways/BookToBookTransition.js');
    return await BookToBookTransition.execute(options);
  }

  /**
   * Determine which pathway should be used based on context
   */
  static determinePathway(context = {}) {
    const { 
      currentPageType, 
      targetPageType, 
      isLinkClick, 
      isFormSubmission, 
      isRefresh,
      fromBook,
      toBook 
    } = context;

    // Fresh page load
    if (isRefresh || !currentPageType) {
      return 'fresh-page-load';
    }

    // Create new book
    if (currentPageType === 'home' && targetPageType === 'reader' && !isFormSubmission) {
      return 'create-new-book';
    }

    // Import book
    if (isFormSubmission && targetPageType === 'reader') {
      return 'import-book';
    }

    // Book-to-book navigation
    if (currentPageType === 'reader' && targetPageType === 'reader' && fromBook !== toBook) {
      return 'book-to-book';
    }

    // Default fallback
    console.warn('Could not determine navigation pathway, using fresh page load');
    return 'fresh-page-load';
  }

  /**
   * Smart navigation - automatically determines and executes the right pathway
   */
  static async smartNavigate(context = {}) {
    const pathway = this.determinePathway(context);
    return await this.navigate(pathway, context);
  }

  /**
   * Legacy compatibility methods for existing code
   */
  static async initializeReaderView(progressCallback = null) {
    console.log('🔄 NavigationManager: Legacy initializeReaderView call');
    return await this.navigate('fresh-page-load', { progressCallback });
  }

  static async transitionToReaderView(bookId, hash = '', progressCallback = null) {
    console.log('🔄 NavigationManager: Legacy transitionToReaderView call');
    
    // Determine if this is book-to-book or create new book based on current state
    const currentPageType = document.body.getAttribute('data-page');
    
    if (currentPageType === 'reader') {
      return await this.navigate('book-to-book', { 
        toBook: bookId, 
        hash, 
        progressCallback 
      });
    } else {
      return await this.navigate('create-new-book', { 
        bookId, 
        hash, 
        progressCallback 
      });
    }
  }

  static async initializeImportedBook(bookId) {
    console.log('🔄 NavigationManager: Legacy initializeImportedBook call');
    return await this.navigate('import-book', { bookId });
  }
}