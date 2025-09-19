/**
 * FreshPageLoader - PATHWAY 1
 * Handles fresh page loads (user refresh or direct URL access)
 * No SPA transitions, just initialize everything from scratch
 */
import { ProgressManager } from '../ProgressManager.js';

export class FreshPageLoader {
  /**
   * Initialize a fresh page load
   * This is the non-SPA pathway used when the page loads from scratch
   */
  static async initialize(options = {}) {
    const { progressCallback } = options;
    
    console.log('🆕 FreshPageLoader: Starting fresh page initialization');
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressManager.createProgressCallback('initial');
      
      // Import the existing reader initialization system
      const { initializeReaderView } = await import('../../viewManager.js');
      
      // Delegate to the existing reader initialization
      // This maintains compatibility with the current system
      await initializeReaderView(progress);
      
      console.log('✅ FreshPageLoader: Fresh page initialization complete');
      
    } catch (error) {
      console.error('❌ FreshPageLoader: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Check if this is a fresh page load scenario
   */
  static isFreshPageLoad() {
    // Check various indicators that suggest this is a fresh page load
    const hasSessionStorage = !!sessionStorage.getItem('pending_new_book_sync') || 
                             !!sessionStorage.getItem('pending_import_book');
    
    const isPageReload = performance.navigation?.type === performance.navigation.TYPE_RELOAD ||
                        performance.getEntriesByType('navigation')[0]?.type === 'reload';
    
    const hasRefererFromSameDomain = document.referrer && 
                                   new URL(document.referrer).origin === window.location.origin;
    
    // If no session storage flags and either it's a reload or no same-domain referrer
    return !hasSessionStorage && (isPageReload || !hasRefererFromSameDomain);
  }

  /**
   * Setup fresh page load listeners
   * This should be called from reader-DOMContentLoaded.js
   */
  static setupFreshPageLoadHandling() {
    // Handle browser back/forward cache restoration
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        console.log('🔄 FreshPageLoader: Page restored from bfcache');
        
        const pageType = document.body.getAttribute('data-page');
        const hasReaderContent = pageType === 'reader' || 
                               document.querySelector('.main-content, .book-content');
        
        if (hasReaderContent) {
          // Small delay to ensure DOM is fully restored
          setTimeout(async () => {
            try {
              console.log('🔧 FreshPageLoader: Reinitializing after bfcache restore');
              
              // Check and update edit permissions
              const { checkEditPermissionsAndUpdateUI } = await import('../../editButton.js');
              await checkEditPermissionsAndUpdateUI();
              
            } catch (error) {
              console.error('❌ FreshPageLoader: Error handling bfcache restore:', error);
            }
          }, 200);
        }
      }
    });

    console.log('✅ FreshPageLoader: Fresh page load handling setup complete');
  }
}