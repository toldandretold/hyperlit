/**
 * NavigationManager - Central coordinator for all navigation pathways
 * Routes navigation requests to the appropriate pathway handler
 *
 * NEW SYSTEM: Structure-aware navigation with 2 universal pathways
 * - SameTemplateTransition: Content-only for same structure (reader→reader, home→home, user→user)
 * - DifferentTemplateTransition: Full body replacement for cross-structure transitions
 *
 * LEGACY SYSTEM: Maintained for backward compatibility
 */
import { ProgressManager } from './ProgressManager.js';
import { SameTemplateTransition } from './pathways/SameTemplateTransition.js';
import { DifferentTemplateTransition } from './pathways/DifferentTemplateTransition.js';
import { LinkNavigationHandler } from './LinkNavigationHandler.js';

export class NavigationManager {
  static navigationCount = 0;

  /**
   * Route navigation request to appropriate pathway
   */
  static async navigate(pathway, options = {}) {
    this.navigationCount++;
    console.log(`🧭 NavigationManager: Routing to ${pathway} (transition #${this.navigationCount})`, options);
    
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
   * NEW SYSTEM: Structure-aware navigation
   * Automatically determines and executes the appropriate transition based on page structures
   */
  static async navigateByStructure(options = {}) {
    this.navigationCount++;
    console.log(`🧭 NavigationManager: Structure-aware navigation (transition #${this.navigationCount})`, options);

    try {
      // Get current structure
      const currentStructure = LinkNavigationHandler.getPageStructure();
      console.log(`📊 Current structure: ${currentStructure}`);

      // Detect target structure
      const targetStructure = await this.detectTargetStructure(options);
      console.log(`📊 Target structure: ${targetStructure}`);

      // Check if structures are compatible (same-to-same only)
      const compatible = LinkNavigationHandler.areStructuresCompatible(currentStructure, targetStructure);
      console.log(`📊 Structures compatible: ${compatible}`);

      if (compatible) {
        // Same structure: content-only transition
        console.log(`✨ Using SameTemplateTransition (${currentStructure}→${targetStructure})`);
        return await SameTemplateTransition.execute(options);
      } else {
        // Different structures: full body replacement
        console.log(`✨ Using DifferentTemplateTransition (${currentStructure}→${targetStructure})`);
        return await DifferentTemplateTransition.execute({
          ...options,
          fromStructure: currentStructure,
          toStructure: targetStructure
        });
      }
    } catch (error) {
      console.error(`❌ Structure-aware navigation failed:`, error);
      ProgressManager.hide();
      throw error;
    }
  }

  /**
   * Detect target structure from navigation options
   */
  static async detectTargetStructure(options = {}) {
    const { targetUrl, toBook, targetStructure } = options;

    // If explicitly provided, use it
    if (targetStructure) {
      return targetStructure;
    }

    // Try to detect from URL
    if (targetUrl) {
      return await this.detectStructureFromUrl(targetUrl);
    }

    // Try to detect from book ID
    if (toBook) {
      return await this.detectStructureFromUrl(`/${toBook}`);
    }

    // Default fallback
    console.warn('Could not detect target structure, defaulting to reader');
    return 'reader';
  }

  /**
   * Detect structure type from URL using simple pattern matching
   * Fast, offline-friendly, no fetching required!
   */
  static async detectStructureFromUrl(url) {
    try {
      const urlObj = new URL(url, window.location.origin);
      const path = urlObj.pathname;

      // Root path is home
      if (path === '/' || path === '') {
        return 'home';
      }

      const pathSegments = path.split('/').filter(Boolean);

      // /u/{username} is user page
      if (pathSegments[0] === 'u' && pathSegments.length >= 2) {
        console.log(`✅ Detected user page structure: /u/${pathSegments[1]}`);
        return 'user';
      }

      // Everything else is reader (/{book}, /{book}/HL_xxx, etc.)
      console.log(`✅ Detected reader structure: ${path}`);
      return 'reader';

    } catch (error) {
      console.warn('Could not detect structure from URL:', error);
      return 'reader';
    }
  }

  /**
   * Legacy compatibility methods for existing code
   */
  static async initializeReaderView(progressCallback = null) {
    console.log('🔄 NavigationManager: Legacy initializeReaderView call (deprecated)');
    return await this.navigate('fresh-page-load', { progressCallback });
  }
  
  static async universalPageInitializer(progressCallback = null) {
    console.log('🔄 NavigationManager: universalPageInitializer call');
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