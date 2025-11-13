/**
 * NavigationManager - Central coordinator for all navigation pathways
 * Routes navigation requests to the appropriate pathway handler
 *
 * NEW SYSTEM: Structure-aware navigation with 2 universal pathways
 * - SameTemplateTransition: Content-only for same structure (reader→reader, home→home, user→user)
 * - DifferentTemplateTransition: Full body replacement for cross-structure transitions
 *
 * LEGACY SYSTEM: Maintained for backward compatibility
 *
 * OVERLAY MANAGEMENT:
 * NavigationManager is the ONLY place that calls ProgressOverlayEnactor.hide()
 * All pathways just do their work - NavigationManager handles overlay lifecycle
 */
import { log } from '../utilities/logger.js';
import { ProgressOverlayEnactor } from './ProgressOverlayEnactor.js';
import { ProgressOverlayConductor } from './ProgressOverlayConductor.js';
import { SameTemplateTransition } from './pathways/SameTemplateTransition.js';
import { DifferentTemplateTransition} from './pathways/DifferentTemplateTransition.js';
import { getPageStructure, areStructuresCompatible } from './utils/structureDetection.js';

export class NavigationManager {
  static navigationCount = 0;

  /**
   * Route navigation request to appropriate pathway
   *
   * ✅ CENTRALIZED OVERLAY MANAGEMENT
   * This is the ONLY method that calls ProgressOverlayEnactor.hide()
   * All pathways delegate overlay lifecycle to NavigationManager
   */
  static async navigate(pathway, options = {}) {
    this.navigationCount++;
    log.nav(`Routing to ${pathway} (transition #${this.navigationCount})`, '/navigation/NavigationManager.js');

    try {
      // Route to appropriate pathway
      // Pathways do NOT hide the overlay - we handle that here
      switch (pathway) {
        case 'fresh-page-load':
          await this.handleFreshPageLoad(options);
          break;

        case 'create-new-book':
          await this.handleCreateNewBook(options);
          break;

        case 'import-book':
          await this.handleImportBook(options);
          break;

        case 'book-to-book':
          await this.handleBookToBookTransition(options);
          break;

        default:
          throw new Error(`Unknown navigation pathway: ${pathway}`);
      }

      // ✅ Success - hide overlay
      await ProgressOverlayEnactor.hide();

    } catch (error) {
      log.error(`Navigation failed for pathway ${pathway}`, '/navigation/NavigationManager.js', error);

      // ✅ Error - still hide overlay (guaranteed via finally block in ProgressOverlayEnactor)
      await ProgressOverlayEnactor.hide();

      throw error;
    }
  }

  /**
   * PATHWAY 1: Fresh page load (user refresh or direct URL)
   * Uses full initialization without SPA transitions
   */
  static async handleFreshPageLoad(options = {}) {
    log.nav('Fresh page load pathway', '/navigation/NavigationManager.js');

    const { FreshPageLoader } = await import('./pathways/FreshPageLoader.js');
    return await FreshPageLoader.initialize(options);
  }

  /**
   * PATHWAY 2: Create new book (home.blade.php → reader.blade.php)
   * Full body replacement, enters edit mode
   */
  static async handleCreateNewBook(options = {}) {
    log.nav('Create new book pathway', '/navigation/NavigationManager.js');

    const { NewBookTransition } = await import('./pathways/NewBookTransition.js');

    // Support two modes:
    // 1. createAndTransition: true - Create new book data first, then transition
    // 2. Normal mode - Transition with existing bookId
    if (options.createAndTransition) {
      return await NewBookTransition.createAndTransition();
    }

    return await NewBookTransition.execute(options);
  }

  /**
   * PATHWAY 3: Import book (form submission → reader.blade.php)
   * Backend processing with full body replacement
   */
  static async handleImportBook(options = {}) {
    log.nav('Import book pathway', '/navigation/NavigationManager.js');

    const { ImportBookTransition } = await import('./pathways/ImportBookTransition.js');
    return await ImportBookTransition.execute(options);
  }

  /**
   * PATHWAY 4: Book-to-book navigation (reader → reader)
   * Content replacement only, preserves navigation
   */
  static async handleBookToBookTransition(options = {}) {
    log.nav('Book-to-book transition pathway', '/navigation/NavigationManager.js');

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
    log.error('Could not determine navigation pathway, using fresh page load', '/navigation/NavigationManager.js');
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
   *
   * ✅ CENTRALIZED OVERLAY MANAGEMENT
   * This method also hides overlay on completion/error
   */
  static async navigateByStructure(options = {}) {
    this.navigationCount++;
    log.nav(`Structure-aware navigation (transition #${this.navigationCount})`, '/navigation/NavigationManager.js');

    try {
      // Get current structure
      const currentStructure = getPageStructure();

      // Detect target structure
      const targetStructure = await this.detectTargetStructure(options);

      // Check if structures are compatible (same-to-same only)
      const compatible = areStructuresCompatible(currentStructure, targetStructure);

      if (compatible) {
        // Same structure: content-only transition
        log.nav(`SameTemplateTransition (${currentStructure}→${targetStructure})`, '/navigation/NavigationManager.js');
        await SameTemplateTransition.execute(options);
      } else {
        // Different structures: full body replacement
        log.nav(`DifferentTemplateTransition (${currentStructure}→${targetStructure})`, '/navigation/NavigationManager.js');
        await DifferentTemplateTransition.execute({
          ...options,
          fromStructure: currentStructure,
          toStructure: targetStructure
        });
      }

      // ✅ Success - hide overlay
      await ProgressOverlayEnactor.hide();

    } catch (error) {
      log.error('Structure-aware navigation failed', '/navigation/NavigationManager.js', error);

      // ✅ Error - still hide overlay
      await ProgressOverlayEnactor.hide();

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
        return 'user';
      }

      // Everything else is reader (/{book}, /{book}/HL_xxx, etc.)
      return 'reader';

    } catch (error) {
      log.error('Could not detect structure from URL', '/navigation/NavigationManager.js', error);
      return 'reader';
    }
  }

  /**
   * Legacy compatibility methods for existing code
   */
  static async initializeReaderView(progressCallback = null) {
    return await this.navigate('fresh-page-load', { progressCallback });
  }

  static async universalPageInitializer(progressCallback = null) {
    return await this.navigate('fresh-page-load', { progressCallback });
  }

  static async transitionToReaderView(bookId, hash = '', progressCallback = null) {
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
    return await this.navigate('import-book', { bookId });
  }
}