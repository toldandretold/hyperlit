/**
 * SameTemplateTransition - Universal handler for same-structure transitions
 * Handles content-only replacement for reader→reader, home→home, user→user
 * Preserves page wrapper, buttons, and header - only replaces .main-content
 */
import { ProgressManager } from '../ProgressManager.js';
import { LinkNavigationHandler } from '../LinkNavigationHandler.js';

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

      // Use the homepageDisplayUnit transition pattern
      await this.swapHomeContent(toBook, true);

      // Update URL
      const newUrl = `/${toBook}${hash}`;
      if (window.location.pathname + window.location.hash !== newUrl) {
        window.history.pushState({}, '', newUrl);
        console.log(`🔗 SameTemplateTransition: Updated URL to ${newUrl}`);
      }

      // Handle hash navigation if present
      if (hash) {
        progress(90, 'Navigating to target...');
        await this.navigateToHash(hash);
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

      // Use the same pattern as home→home (both use .main-content swap)
      await this.swapHomeContent(toBook, true);

      // Update URL
      const newUrl = `/${toBook}${hash}`;
      if (window.location.pathname + window.location.hash !== newUrl) {
        window.history.pushState({}, '', newUrl);
        console.log(`🔗 SameTemplateTransition: Updated URL to ${newUrl}`);
      }

      // Handle hash navigation if present
      if (hash) {
        progress(90, 'Navigating to target...');
        await this.navigateToHash(hash);
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

  /**
   * Swap home/user content using homepageDisplayUnit pattern
   * Extracted from homepageDisplayUnit.transitionToBookContent()
   */
  static async swapHomeContent(bookId, showLoader = true) {
    try {
      if (showLoader) {
        const { showNavigationLoading } = await import('../../scrolling.js');
        showNavigationLoading(`Loading ${bookId}...`);
      }

      console.log(`🔄 SameTemplateTransition: Swapping content to ${bookId}`);

      // 🧹 CRITICAL: Destroy existing homepage managers before content swap
      console.log('🧹 SameTemplateTransition: Destroying homepage display unit listeners');
      const { destroyHomepageDisplayUnit } = await import('../../homepageDisplayUnit.js');
      if (typeof destroyHomepageDisplayUnit === 'function') {
        destroyHomepageDisplayUnit();
      }

      // 🧹 CRITICAL: Destroy existing user profile editor if it exists
      const currentStructure = document.body.getAttribute('data-page');
      if (currentStructure === 'user') {
        console.log('🧹 SameTemplateTransition: Destroying user profile editor listeners');
        const { destroyUserProfileEditor } = await import('../../components/userProfileEditor.js');
        if (typeof destroyUserProfileEditor === 'function') {
          destroyUserProfileEditor();
        }
      }

      // Remove existing content containers
      document.querySelectorAll('.main-content').forEach(content => {
        console.log(`🧹 Removing existing content container: ${content.id}`);
        content.remove();
      });

      // Create fresh container for the new content
      // Support both home and user page wrappers
      const mainContainer = document.querySelector('.home-content-wrapper') ||
                            document.querySelector('.user-content-wrapper');
      if (!mainContainer) {
        throw new Error('Content wrapper not found (tried .home-content-wrapper and .user-content-wrapper)');
      }

      const newContentDiv = document.createElement('div');
      newContentDiv.id = bookId;
      newContentDiv.className = 'main-content active-content';
      mainContainer.appendChild(newContentDiv);
      console.log(`✨ Created fresh content container: ${bookId}`);

      // Set the current book context (important for other systems)
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);

      // Reset the current lazy loader so a fresh one gets created
      const { resetCurrentLazyLoader, loadHyperText } = await import('../../initializePage.js');
      resetCurrentLazyLoader();

      // Use the same loading pipeline as regular page transitions
      await loadHyperText(bookId);

      // 🔧 CRITICAL: Reinitialize homepage display unit after content load
      console.log('🔧 SameTemplateTransition: Reinitializing homepage display unit');
      const { initializeHomepageButtons, fixHeaderSpacing } = await import('../../homepageDisplayUnit.js');
      if (typeof initializeHomepageButtons === 'function') {
        initializeHomepageButtons();
      }
      if (typeof fixHeaderSpacing === 'function') {
        fixHeaderSpacing();
      }

      // 🔧 CRITICAL: Reinitialize user profile editor if on user page
      if (currentStructure === 'user') {
        console.log('🔧 SameTemplateTransition: Reinitializing user profile editor');
        const { initializeUserProfileEditor } = await import('../../components/userProfileEditor.js');
        if (typeof initializeUserProfileEditor === 'function') {
          await initializeUserProfileEditor(bookId);
        }
      }

      // 🔧 CRITICAL: Reinitialize TogglePerimeterButtons
      console.log('🔧 SameTemplateTransition: Reinitializing TogglePerimeterButtons');
      const { togglePerimeterButtons } = await import('../../readerDOMContentLoaded.js');
      if (togglePerimeterButtons) {
        togglePerimeterButtons.destroy();
        togglePerimeterButtons.rebindElements();
        togglePerimeterButtons.init();
        togglePerimeterButtons.updatePosition();
        console.log('✅ SameTemplateTransition: TogglePerimeterButtons reinitialized');
      }

      // 🔧 CRITICAL: Reinitialize logo navigation toggle
      console.log('🔧 SameTemplateTransition: Reinitializing logo navigation toggle');
      const { destroyLogoNav, initializeLogoNav } = await import('../../components/logoNavToggle.js');
      if (destroyLogoNav && initializeLogoNav) {
        destroyLogoNav();
        initializeLogoNav();
        console.log('✅ SameTemplateTransition: Logo navigation toggle reinitialized');
      }

      // 🔧 CRITICAL: Reinitialize user container (userButton in logoNavWrapper on user/reader pages)
      console.log('🔧 SameTemplateTransition: Reinitializing user container');
      const { initializeUserContainer } = await import('../../components/userContainer.js');
      const userManager = initializeUserContainer();
      if (userManager && userManager.initializeUser) {
        await userManager.initializeUser();
      }
      console.log('✅ SameTemplateTransition: User container reinitialized');

      console.log(`✅ Successfully loaded ${bookId} content`);

      if (showLoader) {
        const { hideNavigationLoading } = await import('../../scrolling.js');
        hideNavigationLoading();
      }

    } catch (error) {
      console.error(`❌ Failed to swap content to ${bookId}:`, error);
      if (showLoader) {
        const { hideNavigationLoading } = await import('../../scrolling.js');
        hideNavigationLoading();
      }
      throw error;
    }
  }

  /**
   * Navigate to hash target if provided
   */
  static async navigateToHash(hash) {
    if (!hash) return;

    console.log(`🎯 SameTemplateTransition: Navigating to hash ${hash}`);

    try {
      const targetId = hash.substring(1); // Remove the #

      // Wait for target element to be ready
      const { navigateToInternalId } = await import('../../scrolling.js');
      const { currentLazyLoader } = await import('../../initializePage.js');

      if (currentLazyLoader) {
        navigateToInternalId(targetId, currentLazyLoader, false);
        console.log(`✅ SameTemplateTransition: Navigated to ${hash}`);
      }
    } catch (error) {
      console.warn(`Could not navigate to hash ${hash}:`, error);
      // Fallback: simple hash navigation
      if (hash) {
        window.location.hash = hash;
      }
    }
  }
}
