/**
 * NewBookTransition - PATHWAY 2
 * Handles creating new books and transitioning from home.blade.php to reader.blade.php
 * This pathway requires full body replacement and enters edit mode
 */
import { ProgressManager } from '../ProgressManager.js';
import { showSpinner, showTick } from '../../editIndicator.js';
import { waitForElementReady } from '../../domReadiness.js';

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
    
    console.log('📝 NewBookTransition: Starting new book transition', { bookId, shouldEnterEditMode });
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressManager.createProgressCallback('spa');
      
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
      const { waitForContentReady } = await import('../../domReadiness.js');
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
      await ProgressManager.hide();
      
      console.log('✅ NewBookTransition: New book transition complete');
      
    } catch (error) {
      console.error('❌ NewBookTransition: Transition failed:', error);
      
      // Fallback to full page navigation
      const fallbackUrl = `/${bookId}/edit?target=1${shouldEnterEditMode ? '&edit=1' : ''}`;
      console.log('🔄 NewBookTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;
      
      throw error;
    }
  }

  /**
   * Ensure orange indicator shows using deterministic DOM watching
   */
  static async ensureOrangeIndicator() {
    try {
      console.log('🟠 NewBookTransition: Ensuring orange indicator shows');

      // First try to set orange on existing element
      showSpinner();

      // Use deterministic DOM watching instead of polling
      return new Promise((resolve) => {
        const setOrangeIndicator = () => {
          const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1');
          if (cloudSvgPath) {
            cloudSvgPath.style.fill = '#EF8D34';
            console.log('✅ Orange indicator set deterministically');
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
        console.log('✅ DOM stable - ready for initialization');
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
    console.log('🔄 NewBookTransition: Ensuring pending syncs complete...');
    
    try {
      // Import the debounced sync function and pending syncs map
      const { debouncedMasterSync, pendingSyncs } = await import('../../cache-indexedDB.js');
      const { showTick } = await import('../../editIndicator.js');
      
      // If there are pending syncs, force them to complete immediately
      if (pendingSyncs.size > 0) {
        console.log(`🔄 NewBookTransition: Found ${pendingSyncs.size} pending syncs, forcing completion...`);
        
        // Cancel the debounced timer and execute immediately
        debouncedMasterSync.cancel();
        await debouncedMasterSync();
        
        console.log('✅ NewBookTransition: Pending syncs completed');
        
        // Show green tick - backend sync confirmed
        showTick();
      } else {
        console.log('✅ NewBookTransition: No pending syncs to complete');
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
    console.log('🧹 NewBookTransition: Cleaning up previous state');
    
    try {
      // Import and destroy homepage-specific components
      const { destroyUserContainer } = await import('../../userContainer.js');
      const { destroyNewBookContainer } = await import('../../newBookButton.js');
      if (destroyUserContainer) destroyUserContainer();
      if (destroyNewBookContainer) destroyNewBookContainer();
      console.log('🧹 NewBookTransition: Homepage containers destroyed.');

      const { destroyHomepageDisplayUnit } = await import('../../homepageDisplayUnit.js');
      if (destroyHomepageDisplayUnit) destroyHomepageDisplayUnit();

      // Also clean up the reader view in case of an inconsistent state
      const { cleanupReaderView } = await import('../../viewManager.js');
      cleanupReaderView();
    } catch (error) {
      console.warn('⚠️ Cleanup failed, but continuing transition:', error);
    }
  }

  /**
   * Fetch the reader page HTML
   */
  static async fetchReaderPageHtml(bookId) {
    console.log(`📥 NewBookTransition: Fetching reader HTML for ${bookId}`);
    
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    console.log(`✅ NewBookTransition: Fetched HTML (${htmlString.length} characters)`);
    
    return htmlString;
  }

  /**
   * Replace body content with reader HTML
   */
  static async replaceBodyContent(htmlString, bookId) {
    console.log('🔄 NewBookTransition: Replacing body content (home → reader)');

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // 🎯 CRITICAL: Preserve the existing navigation overlay
    const existingOverlay = document.getElementById('initial-navigation-overlay');

    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 NewBookTransition: Removed overlay from fetched HTML');
    }

    // Replace the entire body content
    document.body.innerHTML = newDoc.body.innerHTML;

    // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
    if (existingOverlay) {
      document.body.insertBefore(existingOverlay, document.body.firstChild);
      console.log('🎯 NewBookTransition: Preserved navigation overlay across body replacement');
    }
    
    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');
    console.log('🎯 NewBookTransition: Set data-page="reader"');
    
    // Update document title
    document.title = newDoc.title;
    
    // Reset contentEditable state after HTML replacement
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      console.log("🧹 NewBookTransition: Reset contentEditable after HTML replacement");
    }
    
    // Enforce editable state
    try {
      const { enforceEditableState } = await import('../../editButton.js');
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Initialize the reader view
   */
  static async initializeReader(bookId, progressCallback) {
    console.log(`🚀 NewBookTransition: Initializing reader for ${bookId}`);
    
    try {
      // Set the current book
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);
      
      // Initialize the reader view using the existing system
      const { universalPageInitializer } = await import('../../viewManager.js');
      await universalPageInitializer(progressCallback);
      
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
      console.log("✅ NewBookTransition: UI initialization delegated to universalPageInitializer");
      
    } catch (error) {
      console.warn('Could not rebind UI elements:', error);
    }
  }

  /**
   * Enter edit mode
   */
  static async enterEditMode() {
    console.log('📝 NewBookTransition: Entering edit mode');
    
    try {
      const { enableEditMode } = await import('../../editButton.js');
      await enableEditMode(null, false); // false = don't force redirect
      
      console.log('✅ NewBookTransition: Edit mode enabled');
      
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
      console.log(`🔗 NewBookTransition: Updated URL to ${newUrl}`);
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Create a new book and transition to it
   * This is the main entry point from newBookButton.js
   */
  static async createAndTransition() {
    console.log('📝 NewBookTransition: Starting create and transition');
    
    try {
      // Import and create the new book
      const { createNewBook } = await import('../../createNewBook.js');
      const pendingSyncData = await createNewBook();
      
      if (!pendingSyncData) {
        throw new Error('Failed to create new book data');
      }
      
      // Start background sync
      const { fireAndForgetSync } = await import('../../createNewBook.js');
      const { setInitialBookSyncPromise } = await import('../../operationState.js');
      
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
          console.log('🎯 NewBookTransition: Ensuring initial H1 node is queued for sync');
          
          // Force a sync of the initial content to ensure the H1 doesn't get lost
          const { syncIndexedDBtoPostgreSQL } = await import('../../postgreSQL.js');
          await syncIndexedDBtoPostgreSQL(pendingSyncData.bookId);
          
          console.log('✅ NewBookTransition: Initial content sync completed');
          
          // Show green tick - H1 saved to backend
          const { showTick } = await import('../../editIndicator.js');
          showTick();
          
        } catch (error) {
          console.warn('Initial content sync failed (will retry later):', error);
          // Show error indicator
          const { showError } = await import('../../editIndicator.js');
          showError();
        }
      }, 2000); // Wait 2 seconds after transition completes
      
      return pendingSyncData;
      
    } catch (error) {
      console.error('❌ NewBookTransition: Create and transition failed:', error);
      throw error;
    }
  }
}