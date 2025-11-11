/**
 * SameTemplateTransition - Universal handler for same-structure transitions
 * Handles content-only replacement for reader→reader, home→home, user→user
 * Preserves page wrapper, buttons, and header - only replaces .main-content using shared utilities
 */
import { ProgressManager } from '../ProgressManager.js';
import { LinkNavigationHandler } from '../LinkNavigationHandler.js';
import { swapHomeContent, navigateToHash, updateUrl } from '../utils/contentSwapHelpers.js';

export class SameTemplateTransition {
  /**
   * Execute same-structure transition (content-only replacement)
   */
  static async execute(options = {}) {
    const currentStructure = LinkNavigationHandler.getPageStructure();
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
  static async handleReaderToReader(options = {}) {
    console.log('📖 SameTemplateTransition: Delegating reader→reader to BookToBookTransition');

    // Import and delegate to the battle-tested BookToBookTransition
    const { BookToBookTransition } = await import('./BookToBookTransition.js');
    return await BookToBookTransition.execute(options);
  }


  /**
   * Handle home→home transition (content swap only)
   * Uses the homepageDisplayUnit pattern: remove old .main-content, create new, load content
   */
  static async handleHomeToHome(options = {}) {
    const { toBook, hash = '', progressCallback } = options;

    console.log('🏠 SameTemplateTransition: Home→Home content swap', { toBook });

    try {
      const progress = progressCallback || ProgressManager.createProgressCallback('content-swap');

      progress(10, `Loading ${toBook}...`);

      // Use the shared swapHomeContent utility
      await swapHomeContent(toBook, true);

      // Update URL with state preservation for back button (using shared utility)
      const newUrl = `/${toBook}${hash}`;
      const { LinkNavigationHandler } = await import('../LinkNavigationHandler.js');
      const currentBook = LinkNavigationHandler.getBookIdFromUrl(window.location.pathname);
      updateUrl(newUrl, {
        fromBook: currentBook,
        toBook: toBook,
        fromStructure: 'home',
        toStructure: 'home',
        transitionType: 'content-swap'
      });

      // Handle hash navigation if present (using shared utility)
      if (hash) {
        progress(90, 'Navigating to target...');
        await navigateToHash(hash, 'home');
      }

      progress(100, 'Complete!');
      await ProgressManager.hide();

      console.log('✅ SameTemplateTransition: Home→Home transition complete');

    } catch (error) {
      console.error('❌ SameTemplateTransition: Home→Home transition failed:', error);
      await ProgressManager.hide();
      throw error;
    }
  }


  /**
   * Handle user→user transition (content swap only)
   * Same pattern as home→home
   */
  static async handleUserToUser(options = {}) {
    const { toBook, hash = '', progressCallback } = options;

    console.log('👤 SameTemplateTransition: User→User content swap', { toBook });

    try {
      const progress = progressCallback || ProgressManager.createProgressCallback('content-swap');

      progress(10, `Loading ${toBook}...`);

      // Use the shared swapHomeContent utility (works for both home and user pages)
      await swapHomeContent(toBook, true);

      // Update URL with state preservation for back button (using shared utility)
      const newUrl = `/${toBook}${hash}`;
      const { LinkNavigationHandler } = await import('../LinkNavigationHandler.js');
      const currentBook = LinkNavigationHandler.getBookIdFromUrl(window.location.pathname);
      updateUrl(newUrl, {
        fromBook: currentBook,
        toBook: toBook,
        fromStructure: 'user',
        toStructure: 'user',
        transitionType: 'content-swap'
      });

      // Handle hash navigation if present (using shared utility)
      if (hash) {
        progress(90, 'Navigating to target...');
        await navigateToHash(hash, 'user');
      }

      progress(100, 'Complete!');
      await ProgressManager.hide();

      console.log('✅ SameTemplateTransition: User→User transition complete');

    } catch (error) {
      console.error('❌ SameTemplateTransition: User→User transition failed:', error);
      await ProgressManager.hide();
      throw error;
    }
  }
}
