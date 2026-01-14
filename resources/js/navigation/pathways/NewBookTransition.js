/**
 * NewBookTransition - PATHWAY 2
 * Handles creating new books and transitioning from home.blade.php to reader.blade.php
 * This pathway requires full body replacement and enters edit mode
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { ProgressOverlayEnactor } from '../ProgressOverlayEnactor.js';
import { glowCloudOrange, glowCloudGreen, glowCloudRed } from '../../components/editIndicator.js';
import { waitForElementReady, waitForContentReady } from '../../domReadiness.js';
import { log, verbose } from '../../utilities/logger.js';
import { debouncedMasterSync, pendingSyncs, updateDatabaseBookId } from '../../indexedDB/index.js';
import { destroyUserContainer } from '../../components/userContainer.js';
import { destroyNewBookContainer } from '../../components/newBookButton.js';
import { destroyHomepageDisplayUnit } from '../../homepageDisplayUnit.js';
import { cleanupReaderView } from '../../viewManager.js';
import { enforceEditableState, enableEditMode } from '../../components/editButton.js';
import { setCurrentBook } from '../../app.js';
import { universalPageInitializer } from '../../viewManager.js';
import { initializeLogoNav } from '../../components/logoNavToggle.js';
import { createNewBook, fireAndForgetSync } from '../../createNewBook.js';
import { setInitialBookSyncPromise } from '../../utilities/operationState.js';
import { syncIndexedDBtoPostgreSQL } from '../../postgreSQL.js';

export class NewBookTransition {
  /**
   * Execute new book creation and transition
   */
  static async execute(options = {}) {
    const { 
      bookId, 
      pendingSyncData, 
      progressCallback,
      shouldEnterEditMode = true 
    } = options;
    
    verbose.nav('Starting new book transition', 'NewBookTransition.js');
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressOverlayConductor.createProgressCallback('spa');
      
      progress(10, 'Preparing new book...');

      // Start parallel operations early
      const orangeIndicatorPromise = this.ensureOrangeIndicator();
      const cleanupPromise = this.cleanupPreviousState();
      const syncPromise = this.ensurePendingSyncsComplete();

      // Wait for cleanup to complete before starting fetch
      await cleanupPromise;

      progress(30, 'Syncing pending changes...');

      // Start fetch while syncs are completing (can run in parallel)
      const [, readerHtml] = await Promise.all([
        syncPromise,
        this.fetchReaderPageHtml(bookId)
      ]);

      progress(60, 'Updating page structure...');

      // Replace the entire body content (home → reader transition)
      await this.replaceBodyContent(readerHtml, bookId);

      // Ensure orange indicator is set before proceeding
      await orangeIndicatorPromise;
      
      progress(75, 'Initializing reader...');

      // Initialize the reader view
      // Create a scoped progress callback that maps 0-100% to 75-85%
      const scopedProgress = (percent, message) => {
        const scopedPercent = 75 + (percent * 0.10); // Map 0-100% to 75-85%
        progress(scopedPercent, message);
      };
      await this.initializeReader(bookId, scopedProgress);

      progress(85, 'Ensuring content readiness...');

      // Wait for content to be fully ready after initialization
      await waitForContentReady(bookId, {
        maxWaitTime: 10000,
        requireLazyLoader: true
      });
      
      progress(90, 'Setting up edit mode...');
      
      // Enter edit mode if requested
      if (shouldEnterEditMode) {
        await this.enterEditMode();
      }
      
      // Update the URL
      this.updateUrl(bookId, shouldEnterEditMode);

      progress(100, 'Complete!');

      log.nav('New book transition complete', 'NewBookTransition.js');
      // NOTE: NavigationManager will hide the overlay when this returns

    } catch (error) {
      console.error('❌ NewBookTransition: Transition failed:', error);

      // Fallback to full page navigation
      const fallbackUrl = `/${bookId}/edit?target=1${shouldEnterEditMode ? '&edit=1' : ''}`;
      verbose.nav('Falling back to full page navigation', 'NewBookTransition.js');
      window.location.href = fallbackUrl;

      throw error;
    }
  }

  /**
   * Ensure orange indicator shows using deterministic DOM watching
   */
  static async ensureOrangeIndicator() {
    try {
      verbose.nav('Ensuring orange indicator shows', 'NewBookTransition.js');

      // First try to set orange on existing element
      glowCloudOrange();

      // Use deterministic DOM watching instead of polling
      return new Promise((resolve) => {
        const setOrangeIndicator = () => {
          const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1');
          if (cloudSvgPath) {
            cloudSvgPath.style.fill = '#EF8D34';
            verbose.nav('Orange indicator set deterministically', 'NewBookTransition.js');
            return true;
          }
          return false;
        };

        // Try immediately in case element already exists
        if (setOrangeIndicator()) {
          resolve();
          return;
        }

        // Watch for DOM changes to detect when cloudRef is ready
        const observer = new MutationObserver((mutations) => {
          if (setOrangeIndicator()) {
            observer.disconnect();
            resolve();
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });

        // Fallback timeout to prevent infinite waiting (reduced to 1 second)
        setTimeout(() => {
          observer.disconnect();
          console.warn('⚠️ Orange indicator timeout, but continuing...');
          resolve();
        }, 1000);
      });

    } catch (error) {
      console.warn('⚠️ Error ensuring orange indicator:', error);
    }
  }

  /**
   * Wait for DOM to be stable after major changes
   * Uses MutationObserver to detect when DOM stops changing
   */
  static waitForDOMStable(timeoutMs = 5000) {
    return new Promise((resolve) => {
      let stabilityTimer;
      let timeoutTimer;
      
      const cleanup = () => {
        if (observer) observer.disconnect();
        if (stabilityTimer) clearTimeout(stabilityTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      };
      
      const markStable = () => {
        cleanup();
        verbose.nav('DOM stable - ready for initialization', 'NewBookTransition.js');
        resolve();
      };
      
      // Set overall timeout
      timeoutTimer = setTimeout(() => {
        cleanup();
        console.warn('⚠️ DOM stability timeout, but continuing...');
        resolve();
      }, timeoutMs);
      
      const observer = new MutationObserver(() => {
        // Reset stability timer on any DOM change
        if (stabilityTimer) clearTimeout(stabilityTimer);
        
        // Mark stable if no changes for 100ms
        stabilityTimer = setTimeout(markStable, 100);
      });
      
      observer.observe(document.body, { 
        childList: true, 
        subtree: true,
        attributes: false // Don't watch attributes to reduce noise
      });
      
      // Start the initial stability timer
      stabilityTimer = setTimeout(markStable, 100);
    });
  }

  /**
   * Ensure any pending sync operations complete before transitioning
   * This prevents data loss when user edits then immediately navigates
   */
  static async ensurePendingSyncsComplete() {
    verbose.nav('Ensuring pending syncs complete', 'NewBookTransition.js');
    
    try {
      // If there are pending syncs, force them to complete immediately
      if (pendingSyncs.size > 0) {
        verbose.nav(`Found ${pendingSyncs.size} pending syncs, forcing completion`, 'NewBookTransition.js');
        
        // Cancel the debounced timer and execute immediately
        debouncedMasterSync.cancel();
        await debouncedMasterSync();
        
        verbose.nav('Pending syncs completed', 'NewBookTransition.js');
        
        // Show green tick - backend sync confirmed
        glowCloudGreen();
      } else {
        verbose.nav('No pending syncs to complete', 'NewBookTransition.js');
      }
    } catch (error) {
      console.warn('⚠️ NewBookTransition: Error ensuring sync completion:', error);
      // Don't throw - transition should continue even if sync check fails
    }
  }

  /**
   * Clean up any previous reader state
   */
  static async cleanupPreviousState() {
    verbose.nav('Cleaning up previous state', 'NewBookTransition.js');
    
    try {
      // Import and destroy homepage-specific components
      if (destroyUserContainer) destroyUserContainer();
      if (destroyNewBookContainer) destroyNewBookContainer();
      verbose.nav('Homepage containers destroyed', 'NewBookTransition.js');

      if (destroyHomepageDisplayUnit) destroyHomepageDisplayUnit();

      // Also clean up the reader view in case of an inconsistent state
      cleanupReaderView();
    } catch (error) {
      console.warn('⚠️ Cleanup failed, but continuing transition:', error);
    }
  }

  /**
   * Fetch the reader page HTML
   */
  static async fetchReaderPageHtml(bookId) {
    verbose.nav(`Fetching reader HTML for ${bookId}`, 'NewBookTransition.js');
    
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    verbose.nav(`Fetched HTML (${htmlString.length} characters)`, 'NewBookTransition.js');
    
    return htmlString;
  }

  /**
   * Replace body content with reader HTML
   */
  static async replaceBodyContent(htmlString, bookId) {
    verbose.nav('Replacing body content (home → reader)', 'NewBookTransition.js');

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // 🎯 CRITICAL: Preserve the existing navigation overlay
    const existingOverlay = document.getElementById('initial-navigation-overlay');

    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      verbose.nav('Removed overlay from fetched HTML', 'NewBookTransition.js');
    }

    // Replace the entire body content
    document.body.innerHTML = newDoc.body.innerHTML;

    // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
    if (existingOverlay) {
      document.body.insertBefore(existingOverlay, document.body.firstChild);
      verbose.nav('Preserved navigation overlay across body replacement', 'NewBookTransition.js');

      // 🔥 CRITICAL: Rebind ProgressOverlayEnactor to the preserved element
      // After body replacement, ProgressOverlayEnactor's references are stale
      ProgressOverlayEnactor.rebind();
    }

    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');
    verbose.nav('Set data-page="reader"', 'NewBookTransition.js');
    
    // Update document title
    document.title = newDoc.title;
    
    // Reset contentEditable state after HTML replacement
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      verbose.nav('Reset contentEditable after HTML replacement', 'NewBookTransition.js');
    }
    
    // Enforce editable state
    try {
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Initialize the reader view
   */
  static async initializeReader(bookId, progressCallback) {
    verbose.nav(`Initializing reader for ${bookId}`, 'NewBookTransition.js');
    
    try {
      // Set the current book
      setCurrentBook(bookId);
      updateDatabaseBookId(bookId);

      // Initialize the reader view using the existing system
      await universalPageInitializer(progressCallback);

      // 🔧 Reinitialize logo navigation toggle
      verbose.nav('Reinitializing logo navigation toggle', 'NewBookTransition.js');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        verbose.nav('Logo navigation toggle initialized', 'NewBookTransition.js');
      }

      // Wait for DOM to be stable, then rebind UI elements deterministically
      this.rebindUIElementsWhenReady();
      
    } catch (error) {
      console.error('❌ NewBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Rebind UI elements after DOM is stable using deterministic detection
   */
  static async rebindUIElementsWhenReady() {
    try {
      // Wait for DOM to stabilize after the reader initialization
      await this.waitForDOMStable();
      
      // All UI rebinding is now handled by universalPageInitializer
      verbose.nav('UI initialization delegated to universalPageInitializer', 'NewBookTransition.js');
      
    } catch (error) {
      console.warn('Could not rebind UI elements:', error);
    }
  }

  /**
   * Enter edit mode
   */
  static async enterEditMode() {
    verbose.nav('Entering edit mode', 'NewBookTransition.js');

    try {
      // For new books, target the initial H1 element (id="100")
      await enableEditMode("100", false); // Pass "100" as target, false = don't force redirect

      verbose.nav('Edit mode enabled', 'NewBookTransition.js');

    } catch (error) {
      console.error('❌ NewBookTransition: Failed to enter edit mode:', error);
      // Don't throw - edit mode failure shouldn't break the entire transition
    }
  }

  /**
   * Update the browser URL
   */
  static updateUrl(bookId, inEditMode = false) {
    const newUrl = `/${bookId}/edit?target=1${inEditMode ? '&edit=1' : ''}`;
    
    try {
      history.pushState({}, '', newUrl);
      verbose.nav(`Updated URL to ${newUrl}`, 'NewBookTransition.js');
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Create a new book and transition to it
   * This is the main entry point from newBookButton.js
   */
  static async createAndTransition() {
    verbose.nav('Starting create and transition', 'NewBookTransition.js');
    
    try {
      // Import and create the new book
      const pendingSyncData = await createNewBook();

      if (!pendingSyncData) {
        throw new Error('Failed to create new book data');
      }

      // Start background sync
      const syncPromise = fireAndForgetSync(
        pendingSyncData.bookId,
        pendingSyncData.isNewBook,
        pendingSyncData
      );
      setInitialBookSyncPromise(syncPromise);
      
      // Execute the transition
      await this.execute({
        bookId: pendingSyncData.bookId,
        pendingSyncData,
        shouldEnterEditMode: true
      });
      
      // 🔥 CRITICAL: Ensure the initial H1 node gets included in first debounced sync
      // This prevents the initial "Untitled" H1 from being lost if user starts editing immediately
      setTimeout(async () => {
        try {
          verbose.nav('Ensuring initial H1 node is queued for sync', 'NewBookTransition.js');

          // Force a sync of the initial content to ensure the H1 doesn't get lost
          await syncIndexedDBtoPostgreSQL(pendingSyncData.bookId);

          verbose.nav('Initial content sync completed', 'NewBookTransition.js');

          // Show green tick - H1 saved to backend
          glowCloudGreen();

        } catch (error) {
          console.warn('Initial content sync failed (will retry later):', error);
          // Show error indicator
          glowCloudRed();
        }
      }, 2000); // Wait 2 seconds after transition completes
      
      return pendingSyncData;
      
    } catch (error) {
      console.error('❌ NewBookTransition: Create and transition failed:', error);
      throw error;
    }
  }
}