/**
 * FreshPageLoader - PATHWAY 1
 * Handles fresh page loads (user refresh or direct URL access)
 * No SPA transitions, just initialize everything from scratch
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { log } from '../../utilities/logger.js';
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';

export class FreshPageLoader {
  /**
   * Initialize a fresh page load
   * This is the non-SPA pathway used when the page loads from scratch
   *
   * Overlay is hidden by NavigationManager after this completes
   */
  static async initialize(options = {}) {
    const { progressCallback } = options;

    // Use provided progress callback or create our own
    const progress = progressCallback || ProgressOverlayConductor.createProgressCallback('initial');

    // Import the universal page initialization system
    const { universalPageInitializer } = await import('../../viewManager.js');

    // Delegate to the universal page initializer
    // This handles all UI initialization including NavButtons
    await universalPageInitializer(progress);

    // NOTE: NavigationManager will hide the overlay when this method returns
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
   * This should be called from readerDOMContentLoaded.js
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
              // Check and update edit permissions
              const { checkEditPermissionsAndUpdateUI } = await import('../../components/editButton.js');
              await checkEditPermissionsAndUpdateUI();

            } catch (error) {
              log.error('Error handling bfcache restore', '/navigation/pathways/FreshPageLoader.js', error);
            }
          }, 200);
        }
      }
    });
  }
}