/**
 * BookToHomeTransition - PATHWAY 5
 * Handles navigation from reader.blade.php to home.blade.php
 * Full body replacement and template switch from reader to home
 */
import { ProgressManager } from '../ProgressManager.js';

export class BookToHomeTransition {
  /**
   * Execute book-to-home transition
   */
  static async execute(options = {}) {
    const {
      fromBook,
      targetUrl = '/',
      progressCallback,
      replaceHistory = false
    } = options;
    
    console.log('🏠 BookToHomeTransition: Starting book-to-home transition', { fromBook });
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressManager.createProgressCallback('spa');
      
      progress(10, 'Preparing to return home...');
      
      // Clean up current reader state
      await this.cleanupReaderState();
      
      progress(30, 'Fetching homepage...');

      // Fetch the homepage HTML (or user page HTML if targetUrl specified)
      const homeHtml = await this.fetchHomepageHtml(targetUrl);

      progress(60, 'Updating page template...');
      
      // Replace the entire body content (reader → home template switch)
      await this.replaceBodyContent(homeHtml);
      
      progress(70, 'Waiting for DOM stabilization...');
      
      // Wait for DOM to be ready for content insertion
      const { waitForLayoutStabilization } = await import('../../domReadiness.js');
      await waitForLayoutStabilization();
      
      progress(80, 'Initializing homepage...');

      // Initialize the homepage (pass targetUrl for subdomain awareness)
      await this.initializeHomepage(progress, targetUrl);
      
      progress(90, 'Ensuring homepage readiness...');
      
      // Wait for homepage content to be fully ready - use deterministic approach like other pathways
      const { waitForCompleteReadiness } = await import('../../domReadiness.js');
      try {
        await waitForCompleteReadiness('most-recent', {
          maxWaitTime: 15000,
          requireLazyLoader: true, // Homepage DOES have lazy loaders for book content
          targetId: null // No specific navigation target needed
        });
        console.log('✅ BookToHomeTransition: Homepage content is fully ready');
      } catch (error) {
        console.warn('❌ BookToHomeTransition: Homepage readiness check failed:', error);
        
        // Try a simpler fallback approach
        try {
          const { waitForContentReady } = await import('../../domReadiness.js');
          await waitForContentReady('most-recent', {
            maxWaitTime: 8000,
            requireLazyLoader: true
          });
          console.log('✅ BookToHomeTransition: Homepage ready via fallback');
        } catch (fallbackError) {
          console.warn('❌ BookToHomeTransition: Fallback readiness check also failed:', fallbackError);
          // Give a bit more time for things to settle
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Update the URL
      this.updateUrl(targetUrl, replaceHistory);

      progress(100, 'Welcome home!');
      await ProgressManager.hide();
      
      console.log('✅ BookToHomeTransition: Book-to-home transition complete');
      
    } catch (error) {
      console.error('❌ BookToHomeTransition: Transition failed:', error);
      
      // Fallback to full page navigation
      const fallbackUrl = '/';
      console.log('🔄 BookToHomeTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;
      
      throw error;
    }
  }

  /**
   * Clean up current reader state before transition
   */
  static async cleanupReaderState() {
    console.log('🧹 BookToHomeTransition: Cleaning up reader state');
    
    try {
      // Import and call the existing cleanup function
      const { cleanupReaderView } = await import('../../viewManager.js');
      cleanupReaderView();

      // Explicitly reset all edit mode state flags as a safeguard
      const { resetEditModeState } = await import('../../components/editButton.js');
      resetEditModeState();
      
      // Close any open containers but don't destroy managers - they'll rebind to new DOM
      await this.closeOpenContainers();
      
    } catch (error) {
      console.warn('Reader cleanup failed, doing manual cleanup:', error);
      
      // Fallback: do minimal cleanup manually
      try {
        const { closeHyperlitContainer } = await import('../../hyperlitContainer/index.js');
        closeHyperlitContainer();
      } catch (containerError) {
        console.warn('Could not close hyperlit container:', containerError);
      }
    }
  }

  /**
   * Close any open containers before transition
   */
  static async closeOpenContainers() {
    console.log('🧹 BookToHomeTransition: Closing open containers');
    
    try {
      // Close hyperlit container if open
      const { closeHyperlitContainer } = await import('../../hyperlitContainer/index.js');
      closeHyperlitContainer();
      console.log('🧹 Closed hyperlit container');

      // Close source container if open
      const sourceButton = document.getElementById('cloudRef');
      if (sourceButton) {
        const { default: sourceManager } = await import('../../components/sourceButton.js');
        if (sourceManager && sourceManager.isOpen) {
          sourceManager.closeContainer();
          console.log('🧹 Closed source container');
        }
      }


      
    } catch (error) {
      console.warn('Container closing failed:', error);
    }
  }

  /**
   * Fetch the homepage HTML (or user page HTML)
   */
  static async fetchHomepageHtml(targetUrl = '/') {
    console.log(`📥 BookToHomeTransition: Fetching HTML from ${targetUrl}`);

    const response = await fetch(targetUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch HTML: ${response.status}`);
    }

    const htmlString = await response.text();
    console.log(`✅ BookToHomeTransition: Fetched HTML (${htmlString.length} characters)`);

    return htmlString;
  }

  /**
   * Replace body content with homepage HTML (reader → home template switch)
   */
  static async replaceBodyContent(htmlString) {
    console.log('🔄 BookToHomeTransition: Replacing body content (reader → home)');
    
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');
    
    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 BookToHomeTransition: Removed overlay from fetched HTML');
    }
    
    // Preserve the existing overlay before replacing body content
    const existingOverlay = document.getElementById('initial-navigation-overlay');
    const overlayToPreserve = existingOverlay ? existingOverlay.cloneNode(true) : null;
    
    // Replace the entire body content (template switch)
    document.body.innerHTML = newDoc.body.innerHTML;
    
    // Restore the overlay if it existed
    if (overlayToPreserve) {
      document.body.insertBefore(overlayToPreserve, document.body.firstChild);
      
      // Reset overlay to its default state for homepage
      overlayToPreserve.style.display = '';
      overlayToPreserve.style.visibility = '';
      
      console.log('🎯 BookToHomeTransition: Preserved and restored navigation overlay with reset state');
    }
    
    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Ensure data-page is set to "home"
    document.body.setAttribute('data-page', 'home');
    console.log('🎯 BookToHomeTransition: Set data-page="home"');
    
    // Update document title
    document.title = newDoc.title;
    
    console.log('✅ BookToHomeTransition: Body content replaced successfully');
  }

  /**
   * Initialize the homepage after template switch
   */
  static async initializeHomepage(progressCallback, targetUrl = '/') {
    console.log('🏠 BookToHomeTransition: Initializing homepage');

    try {
      // Determine book ID from target URL (subdomain-aware)
      const { LinkNavigationHandler } = await import('../LinkNavigationHandler.js');
      const bookId = LinkNavigationHandler.getBookIdFromUrl(targetUrl);

      console.log(`🏠 BookToHomeTransition: Setting book to ${bookId}`);

      // Set current book (could be 'most-recent' or username)
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);
      
      // CRITICAL: Reinitialize container managers BEFORE universalPageInitializer
      // This ensures buttons are ready before NavButtons removes 'loading' class
      await this.reinitializeContainerManagers();
      
      // Initialize homepage functionality - this will reinitialize NavButtons
      const { universalPageInitializer } = await import('../../viewManager.js');
      
      try {
        // Set flag to prevent double initialization in universalPageInitializer
        window.containersAlreadyInitialized = true;
        await universalPageInitializer(progressCallback);
      } finally {
        // Clean up the flag
        delete window.containersAlreadyInitialized;
      }
      
      console.log('✅ BookToHomeTransition: Homepage initialization complete');
      
    } catch (error) {
      console.error('❌ BookToHomeTransition: Homepage initialization failed:', error);
      throw error;
    }
  }

  /**
   * Reinitialize container managers after body replacement
   */
  static async reinitializeContainerManagers() {
    console.log('🔧 BookToHomeTransition: Reinitializing container managers');
    
    try {
      // Check if userButton exists before initializing
      const userButton = document.getElementById('userButton');
      console.log('🔧 BookToHomeTransition: userButton exists?', !!userButton, userButton);
      
      // Initialize homepage-specific managers
      const { initializeUserContainer } = await import('../../components/userContainer.js');
      const userManager = initializeUserContainer();
      console.log('🔧 BookToHomeTransition: User manager created?', !!userManager, userManager);
      
      if (userManager && userManager.initializeUser) {
        await userManager.initializeUser();
        console.log('✅ BookToHomeTransition: User state reinitialized');
      }
      
      const { initializeNewBookContainer } = await import('../../components/newBookButton.js');
      const newBookManager = initializeNewBookContainer();

      const { initializeHomepageButtons } = await import('../../homepageDisplayUnit.js');
      initializeHomepageButtons();
      
      // Shared container managers will rebind via viewManager
      await this.rebindSharedContainerManagers();

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 BookToHomeTransition: Reinitializing logo navigation toggle');
      const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ BookToHomeTransition: Logo navigation toggle initialized');
      }

      console.log('✅ BookToHomeTransition: Container managers reinitialized');
      
    } catch (error) {
      console.warn('❌ BookToHomeTransition: Could not reinitialize container managers:', error);
    }
  }

  /**
   * Rebind shared container managers to new DOM elements after body replacement
   */
  static async rebindSharedContainerManagers() {
    console.log('🔧 BookToHomeTransition: Rebinding shared container managers to new DOM');
    
    try {
      // The managers weren't destroyed, so they'll rebind automatically via viewManager
      // This is just for logging - the actual rebinding happens in viewManager
      console.log('✅ Shared container managers will rebind via viewManager');
      
    } catch (error) {
      console.warn('Shared container rebinding failed:', error);
    }
  }

  /**
   * Update the browser URL to homepage or user page
   */
  static updateUrl(targetUrl = '/', replaceHistory = false) {
    try {
      if (replaceHistory) {
        history.replaceState({}, '', targetUrl);
        console.log(`🔗 BookToHomeTransition: Replaced URL with ${targetUrl}`);
      } else {
        history.pushState({}, '', targetUrl);
        console.log(`🔗 BookToHomeTransition: Updated URL to ${targetUrl}`);
      }
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

}