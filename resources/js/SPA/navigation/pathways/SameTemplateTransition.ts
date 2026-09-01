/**
 * SameTemplateTransition - Universal handler for same-structure transitions
 * Handles content-only replacement for reader→reader, home→home, user→user
 * Preserves page wrapper, buttons, and header - only replaces .main-content using shared utilities
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { getPageStructure, getBookIdFromUrl } from '../utils/structureDetection.js';
import { swapHomeContent, navigateToHash, updateUrl } from '../utils/contentSwapHelpers.js';

export class SameTemplateTransition {
  /**
   * Execute same-structure transition (content-only replacement)
   */
  static async execute(options: any = {}) {
    const currentStructure = getPageStructure();
    console.log(`🔄 SameTemplateTransition: ${currentStructure}→${currentStructure} transition`, options);

    try {
      // Route to structure-specific handler
      switch (currentStructure) {
        case 'reader':
          return await this.handleReaderToReader(options);

        case 'home':
          return await this.handleHomeToHome(options);

        case 'user':
          return await this.handleUserToUser(options);

        case 'journal':
          return await this.handleJournalToJournal(options);

        default:
          throw new Error(`Unknown structure type: ${currentStructure}`);
      }
    } catch (error) {
      console.error('❌ SameTemplateTransition: Transition failed:', error);
      throw error;
    }
  }

  /**
   * Handle reader→reader transition (delegates to BookToBookTransition)
   * This is the most complex case with hash navigation, hyperlights, etc.
   */
  static async handleReaderToReader(options: any = {}) {
    console.log('📖 SameTemplateTransition: Delegating reader→reader to BookToBookTransition');

    // Import and delegate to the battle-tested BookToBookTransition
    const { BookToBookTransition } = await import('./BookToBookTransition.js');
    return await BookToBookTransition.execute(options);
  }


  /**
   * Handle home→home transition (content swap only)
   * Uses the homepageDisplayUnit pattern: remove old .main-content, create new, load content
   */
  static async handleHomeToHome(options: any = {}) {
    const { toBook, hash = '', isPopstate = false, progressCallback } = options;

    console.log('🏠 SameTemplateTransition: Home→Home content swap', { toBook });

    try {
      const progress = progressCallback || ProgressOverlayConductor.createProgressCallback('content-swap');

      progress(10, `Loading ${toBook}...`);

      // Use the shared swapHomeContent utility
      await swapHomeContent(toBook, true);

      // Update URL with state preservation for back button (using shared utility)
      const newUrl = `/${toBook}${hash}`;
      const currentBook = getBookIdFromUrl(window.location.pathname);
      updateUrl(newUrl, {
        fromBook: currentBook,
        toBook: toBook,
        fromStructure: 'home',
        toStructure: 'home',
        transitionType: 'content-swap',
        isPopstate
      });

      // Handle hash navigation if present (using shared utility)
      if (hash) {
        progress(90, 'Navigating to target...');
        await navigateToHash(hash, 'home');
      }

      progress(100, 'Complete!');

      console.log('✅ SameTemplateTransition: Home→Home transition complete');
      // NOTE: NavigationManager will hide the overlay when this returns

    } catch (error) {
      console.error('❌ SameTemplateTransition: Home→Home transition failed:', error);
      throw error;
    }
  }


  /**
   * Handle user→user transition (full body replacement)
   * User→User requires full body replacement because ownership,
   * arranger buttons, shelves, and globals all change between users
   */
  static async handleUserToUser(options: any = {}) {
    const { targetUrl, hash = '', isPopstate = false, progressCallback } = options;

    console.log('👤 SameTemplateTransition: User→User delegating to DifferentTemplateTransition');

    const { DifferentTemplateTransition } = await import('./DifferentTemplateTransition.js');
    return await DifferentTemplateTransition.execute({
      fromStructure: 'user',
      toStructure: 'user',
      targetUrl,
      hash,
      isPopstate,
      progressCallback,
    });
  }

  /**
   * Handle journal→journal (incl. archive→archive — /a pages share the
   * journal structure): full body replacement, like user→user — the hero,
   * about copy and shelf tabs all change between scopes. Previously this fell
   * through to "Unknown structure type: journal".
   */
  static async handleJournalToJournal(options: any = {}) {
    const { targetUrl, hash = '', isPopstate = false, progressCallback } = options;

    const { DifferentTemplateTransition } = await import('./DifferentTemplateTransition.js');
    return await DifferentTemplateTransition.execute({
      fromStructure: 'journal',
      toStructure: 'journal',
      targetUrl,
      hash,
      isPopstate,
      progressCallback,
    });
  }
}
