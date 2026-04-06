/**
 * BookToBookTransition - PATHWAY 4
 * Handles navigation between books while already in reader mode
 * Only replaces content, preserves navigation elements and uses specialized progress handling
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { waitForNavigationTarget, waitForElementReady, waitForElementReadyWithProgress, waitForMultipleElementsReadyWithProgress, waitForLayoutStabilization, waitForContentReady } from '../../domReadiness.js';
import { cleanupReaderView } from '../../viewManager.js';
import { resetEditModeState, enforceEditableState } from '../../components/editButton.js';
import { destroyUserContainer } from '../../components/userContainer.js';
import { setCurrentBook } from '../../app.js';
import { updateDatabaseBookId } from '../../indexedDB/index.js';
import { setSkipScrollRestoration } from '../../utilities/operationState.js';
import { universalPageInitializer } from '../../viewManager.js';
import { initializeLogoNav } from '../../components/logoNavToggle.js';
import { pendingFirstChunkLoadedPromise, currentLazyLoader, buildChainFromUrl, openContainerChain } from '../../initializePage.js';
import { navigateToHyperciteTarget } from '../../hypercites/index.js';
import { navigateToFootnoteTarget } from '../../hypercites/navigation.js';
import { navigateToInternalId } from '../../scrolling.js';

export class BookToBookTransition {
  static isTransitioning = false;
  static currentTransitionPromise = null;
  static abortController = null;
  /**
   * Execute book-to-book transition
   */
  static async execute(options = {}) {
    // Handle concurrent transitions more gracefully
    if (this.isTransitioning && this.currentTransitionPromise) {
      console.log('🔄 BookToBookTransition: Transition in progress, waiting for completion...');
      try {
        await this.currentTransitionPromise;
      } catch (error) {
        console.warn('Previous transition failed, proceeding with new one:', error);
      }
    }
    
    // Abort any ongoing transition
    if (this.abortController) {
      this.abortController.abort();
    }
    
    this.abortController = new AbortController();
    this.isTransitioning = true;
    const {
      fromBook,
      toBook,
      hash = '',
      hyperlightId = null,
      hyperciteId = null,
      footnoteId = null,
      targetUrl = null,
      progressCallback
    } = options;

    // URL will be updated at the end after all initialization is complete
    console.log('📖 BookToBookTransition: Starting book-to-book transition', {
      fromBook, toBook, hash, hyperlightId, hyperciteId, footnoteId
    });
    
    // Create the transition promise for concurrent handling
    this.currentTransitionPromise = (async () => {
      try {
        // ALWAYS create and show progress immediately, before any async operations
        const progress = progressCallback || this.createDeterministicProgressCallback(toBook);
        
        // Guarantee immediate visibility
        ProgressOverlayConductor.showBookToBookTransition(5, `Loading ${toBook}...`, toBook);
        
        // Save scroll position before destroying the old reader
        if (currentLazyLoader?.forceSaveScrollPosition) {
          currentLazyLoader.forceSaveScrollPosition();
        }

        // Clean up current reader state (but preserve navigation)
        await this.cleanupCurrentReader();

        progress(20, 'Fetching book content...');
        
        // Fetch the target book's HTML
        const readerHtml = await this.fetchReaderPageHtml(toBook);
        
        progress(40, 'Updating content...');
        
        // Replace only the page content (not the entire body)
        await this.replacePageContent(readerHtml, toBook);
        
        progress(50, 'Waiting for DOM stabilization...');

        // Wait for DOM to be ready for content insertion
        await waitForLayoutStabilization();
        
        progress(60, 'Initializing reader...');

        // Set pending navigation target so fetchInitialChunk can load the correct chunk
        const navigationTarget = hash?.substring(1) || hyperlightId || hyperciteId || footnoteId || null;
        window._pendingChunkTarget = navigationTarget;

        // Initialize the new reader view
        // Pass hash navigation flag to prevent scroll position interference
        const hasHashNavigation = !!(hash || hyperlightId || hyperciteId || footnoteId);
        await this.initializeReader(toBook, progress, hasHashNavigation);

        progress(75, 'Ensuring content readiness...');

        // Wait for content to be fully ready after initialization
        await waitForContentReady(toBook, {
          maxWaitTime: 10000,
          requireLazyLoader: true
        });
        
        progress(78, 'Loading initial content...');

        // When hash navigation is pending, skip loading chunk 0 —
        // handleHashNavigation will load the correct chunk directly via
        // findLineForCustomId → loadChunk. Loading chunk 0 first is wasted
        // work since _navigateToInternalId clears the container anyway.
        if (!hasHashNavigation) {
          await this.ensureInitialContentLoaded(toBook);
        }
        
        progress(80, 'Finalizing navigation...');

        // Update URL early to keep browser history in sync
        this.updateUrlWithStatePreservation(toBook, hash);

        // Handle any hash-based navigation (hyperlights, hypercites, footnotes, etc.)
        const hashNavHandled = await this.handleHashNavigation(hash, hyperlightId, hyperciteId, footnoteId, toBook, progress, targetUrl);

        // Wait for any container restoration triggered by initializeLazyLoader
        // (happens on back-nav when the restored entry has a matching containerStack)
        const { pendingContainerRestorePromise } = await import('../../initializePage.js');
        if (pendingContainerRestorePromise) {
          await pendingContainerRestorePromise;
        }

        progress(100, 'Complete!');

        console.log('✅ BookToBookTransition: Book-to-book transition complete');
        // NOTE: NavigationManager will hide the overlay when this returns

      } catch (error) {
        console.error('❌ BookToBookTransition: Transition failed:', error);

        // Fallback to full page navigation
        const fallbackUrl = `/${toBook}${hash}`;
        console.log('🔄 BookToBookTransition: Falling back to full page navigation:', fallbackUrl);
        window.location.href = fallbackUrl;

        throw error;
      }
    })();
    
    try {
      return await this.currentTransitionPromise;
    } finally {
      // Always reset the transitioning flag and cleanup
      this.isTransitioning = false;
      this.currentTransitionPromise = null;
      this.abortController = null;
    }
  }

  /**
   * Clean up current reader state while preserving navigation
   */
  static async cleanupCurrentReader() {
    console.log('🧹 BookToBookTransition: Cleaning up current reader (preserving navigation)');

    try {
      // Import and call the existing cleanup function from viewManager
      cleanupReaderView();

      // Explicitly reset all edit mode state flags as a safeguard
      resetEditModeState();

      // 🧹 CRITICAL: Destroy user container to prevent stale button references
      if (typeof destroyUserContainer === 'function') {
        destroyUserContainer();
        console.log('✅ BookToBookTransition: User container destroyed');
      }

      // The original cleanup for overlays is still useful here
      this.cleanupNavigationOverlays();

    } catch (error) {
      console.warn('Some cleanup steps failed, continuing:', error);
    }
  }

  /**
   * Clean up accumulated navigation overlays
   */
  static cleanupNavigationOverlays() {
    console.log('🧹 BookToBookTransition: Cleaning up accumulated navigation overlays');
    
    // Remove all navigation overlay elements (except the main one we'll reuse)
    const overlays = document.querySelectorAll('.navigation-overlay');
    let removedCount = 0;
    
    overlays.forEach(overlay => {
      // Keep the main initial-navigation-overlay for reuse, remove any duplicates
      if (overlay.id !== 'initial-navigation-overlay') {
        overlay.remove();
        removedCount++;
        console.log('🧹 BookToBookTransition: Removed duplicate navigation overlay');
      }
    });
    
    if (removedCount > 0) {
      console.log(`🧹 BookToBookTransition: Cleaned up ${removedCount} duplicate navigation overlays`);
    }
  }

  /**
   * Fetch the reader page HTML for target book
   */
  static async fetchReaderPageHtml(bookId) {
    console.log(`📥 BookToBookTransition: Fetching reader HTML for ${bookId}`);
    
    const response = await fetch(`/${bookId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    console.log(`✅ BookToBookTransition: Fetched HTML (${htmlString.length} characters)`);
    
    return htmlString;
  }

  /**
   * Replace only the page content, preserving navigation elements
   */
  static async replacePageContent(htmlString, bookId) {
    console.log('🔄 BookToBookTransition: Replacing page content (preserving navigation)');
    
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');
    
    // Try to replace just the #page-wrapper content if it exists
    const currentPageWrapper = document.getElementById('page-wrapper');
    const newPageWrapper = newDoc.getElementById('page-wrapper');
    
    if (currentPageWrapper && newPageWrapper) {
      console.log('🎯 BookToBookTransition: Replacing #page-wrapper content');
      currentPageWrapper.innerHTML = newPageWrapper.innerHTML;
    } else {
      // Fallback: replace entire body but preserve navigation overlay
      console.warn('🎯 BookToBookTransition: #page-wrapper not found, falling back to body replacement');

      // 🎯 CRITICAL: Preserve the existing navigation overlay
      const existingOverlay = document.getElementById('initial-navigation-overlay');

      // Remove any overlay from fetched HTML (we'll keep the existing one)
      const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
      if (overlayInFetchedHTML) {
        overlayInFetchedHTML.remove();
        console.log('🎯 BookToBookTransition: Removed overlay from fetched HTML');
      }

      // Replace body content
      document.body.innerHTML = newDoc.body.innerHTML;

      // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
      if (existingOverlay) {
        document.body.insertBefore(existingOverlay, document.body.firstChild);
        console.log('🎯 BookToBookTransition: Preserved navigation overlay across body replacement');
      }
    }
    
    // Sync body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Update document title
    document.title = newDoc.title;
    
    // Reset contentEditable state
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      console.log("🧹 BookToBookTransition: Reset contentEditable");
    }
    
    // Enforce editable state
    try {
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Initialize the reader for the new book
   */
  static async initializeReader(bookId, progressCallback, hasHashNavigation = false) {
    console.log(`🚀 BookToBookTransition: Initializing reader for ${bookId}, hasHashNavigation: ${hasHashNavigation}`);

    try {
      // Set the current book
      setCurrentBook(bookId);
      updateDatabaseBookId(bookId);

      // Always clear stale skip flag from previous transitions
      setSkipScrollRestoration(false);

      // 🚀 CRITICAL: If we have hash navigation, set the global skip flag BEFORE universalPageInitializer
      // This persists across lazy loader resets and prevents restoreScrollPosition() from interfering
      if (hasHashNavigation) {
        console.log(`🔒 Pre-setting skipScrollRestoration = true (hash navigation pending)`);
        setSkipScrollRestoration(true);
      }

      // Initialize reader view but skip overlay restoration for book-to-book
      await universalPageInitializer(progressCallback);

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 BookToBookTransition: Reinitializing logo navigation toggle');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ BookToBookTransition: Logo navigation toggle initialized');
      }

      // All UI rebinding is now handled by universalPageInitializer
      console.log("✅ BookToBookTransition: UI initialization delegated to universalPageInitializer");

    } catch (error) {
      console.error('❌ BookToBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Handle hash-based navigation (hyperlights, hypercites, footnotes, internal links)
   * @returns {boolean} - True if progress bar was hidden during navigation
   */
  static async handleHashNavigation(hash, hyperlightId, hyperciteId, footnoteId, bookId, progress, targetUrl = null) {
    if (!hash && !hyperlightId && !hyperciteId && !footnoteId) {
      console.log('📖 BookToBookTransition: No hash navigation needed');
      return false;
    }

    console.log('🎯 BookToBookTransition: Handling hash navigation', {
      hash, hyperlightId, hyperciteId, footnoteId
    });

    try {
      // Wait for content to be fully loaded — but only if a chunk was pre-loaded
      // by ensureInitialContentLoaded. When hash navigation is pending we skipped
      // that step (no point loading chunk 0 just to discard it), so the promise
      // won't resolve until _navigateToInternalId loads the correct chunk itself.
      const hasPreloadedChunk = !!document.querySelector(`#${CSS.escape(bookId)} [data-chunk-id]`);
      if (pendingFirstChunkLoadedPromise && hasPreloadedChunk) {
        console.log('⏳ BookToBookTransition: Waiting for content to load before navigation');
        await pendingFirstChunkLoadedPromise;
        console.log('✅ BookToBookTransition: Content loaded, proceeding with navigation');
      }

      // Multi-level cascade: footnote + hyperlight/hypercite → nested containers
      if (footnoteId && (hyperlightId || hyperciteId) && targetUrl) {
        console.log('🔗 BookToBookTransition: Detected multi-level cascade, using chain system');
        try {
          const urlObj = new URL(targetUrl, window.location.origin);
          const pathSegments = urlObj.pathname.split('/').filter(Boolean);
          const chain = await buildChainFromUrl(bookId, pathSegments);

          if (chain && chain.length > 0) {
            const finalHash = hyperciteId || null;
            console.log(`🔗 BookToBookTransition: Opening chain: ${chain.map(c => c.itemId).join(' -> ')} -> ${finalHash}`);
            await openContainerChain(chain, currentLazyLoader, finalHash);
            return true;
          }
          console.warn('🔗 BookToBookTransition: Chain resolution returned empty, falling through');
        } catch (chainError) {
          console.error('🔗 BookToBookTransition: Chain navigation failed, falling through:', chainError);
        }
      }

      // Handle different types of navigation
      if (hyperlightId && hyperciteId) {
        // Hyperlight + hypercite navigation - progress will be hidden when elements are ready
        await this.navigateToHyperciteTarget(hyperlightId, hyperciteId, progress);
        return true; // Progress was hidden by the navigation
      } else if (hyperlightId) {
        // Just hyperlight navigation - progress will be hidden when element is ready
        await this.navigateToInternalId(hyperlightId, progress);
        return true; // Progress was hidden by the navigation
      } else if (footnoteId) {
        // Footnote navigation - scroll to footnote marker and open in container
        const internalId = hash ? (hash.startsWith('#') ? hash.substring(1) : hash) : null;
        console.log(`🎯 BookToBookTransition: Navigating to footnote ${footnoteId}, internal: ${internalId}`);
        await navigateToFootnoteTarget(footnoteId, internalId, currentLazyLoader);
        return true;
      } else if (hash) {
        // General hash navigation - progress will be hidden when element is ready
        const targetId = hash.startsWith('#') ? hash.substring(1) : hash;
        await this.navigateToInternalId(targetId, progress);
        return true; // Progress was hidden by the navigation
      }

      return false; // No navigation performed

    } catch (error) {
      console.error('❌ BookToBookTransition: Hash navigation failed:', error);
      // Don't throw - navigation failure shouldn't break the entire transition
      return false; // Progress was not hidden due to error
    }
  }

  /**
   * Navigate to a hypercite target with deterministic element detection and progress optimization
   */
  static async navigateToHyperciteTarget(hyperlightId, hyperciteId, progress) {
    console.log(`🎯 BookToBookTransition: Delegating to navigateToHyperciteTarget for ${hyperlightId} -> ${hyperciteId}`);

    try {
      // Let navigateToHyperciteTarget handle all the logic: waiting, scrolling, and opening
      // Don't wait here - it causes double-waiting and prevents proper scrolling
      if (currentLazyLoader) {
        await navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);

        // Hide progress indicator once navigation is complete
        if (progress && typeof progress.updateProgress === 'function') {
          progress.updateProgress(100);
          setTimeout(() => progress.hide(), 100);
        }
      } else {
        console.warn('currentLazyLoader not available for hypercite navigation');
      }
    } catch (error) {
      console.error('Failed to navigate to hypercite target:', error);
      // Don't throw - attempt navigation anyway as fallback
      try {
        if (currentLazyLoader) {
          await navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);
        }
      } catch (fallbackError) {
        console.error('Fallback hypercite navigation also failed:', fallbackError);
      }
    }
  }

  /**
   * Navigate to an internal ID with deterministic element detection and progress optimization
   */
  static async navigateToInternalId(targetId, progress) {
    console.log(`🎯 BookToBookTransition: Navigating to internal ID: ${targetId}`);

    try {
      // Get the lazy loader and call navigateToInternalId which handles:
      // 1. Determining which chunk contains the element
      // 2. Loading that chunk (and adjacent chunks)
      // 3. Waiting for the element to be ready
      // 4. Scrolling to it
      if (currentLazyLoader) {
        // 🚀 iOS Safari fix: Properly await navigation completion
        // This prevents iOS scroll restoration from interfering before navigation is done
        const result = await navigateToInternalId(targetId, currentLazyLoader, false);
        console.log(`✅ BookToBookTransition: Navigation complete for ${targetId}`, result);

        // Update progress to show navigation is complete
        if (progress) {
          progress(98, 'Navigation complete');
        }
        return result;
      } else {
        console.warn('currentLazyLoader not available for internal navigation');
        throw new Error('LazyLoader not available');
      }
    } catch (error) {
      console.error('Failed to navigate to internal ID:', error);
      // Re-throw to let NavigationManager handle error cleanup
      throw error;
    }
  }

  /**
   * Update the browser URL while preserving container state for back button
   */
  static updateUrlWithStatePreservation(bookId, hash = '') {
    const newUrl = `/${bookId}${hash}`;
    
    try {
      const currentUrl = window.location.pathname + window.location.hash;
      
      // Only update URL if we're not already there
      if (currentUrl !== newUrl) {
        console.log(`🔗 BookToBookTransition: Navigating to ${newUrl}`);
        
        // For book-to-book navigation, create a new history entry so back/forward works
        const currentState = history.state || {};
        
        // Add book transition metadata while preserving container state
        const newState = {
          ...currentState,
          hyperlitContainer: null,
          containerStack: null,
          bookTransition: {
            fromBook: this.getCurrentBookId(),
            toBook: bookId,
            timestamp: Date.now()
          }
        };
        
        // Use pushState to create proper navigation history
        history.pushState(newState, '', newUrl);
      } else {
        console.log(`🔗 BookToBookTransition: Already at ${newUrl}`);
      }
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Legacy method for compatibility - now delegates to state-preserving version
   */
  static updateUrl(bookId, hash = '') {
    return this.updateUrlWithStatePreservation(bookId, hash);
  }

  /**
   * Get current book ID from DOM or URL
   */
  static getCurrentBookId() {
    // Try to get from current URL first
    const pathSegments = window.location.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0 && !pathSegments[0].startsWith('HL_')) {
      return pathSegments[0];
    }
    
    // Fallback to DOM detection
    const bookElement = document.querySelector('[id]:not([id^="HL_"]):not([id^="hypercite_"])');
    return bookElement ? bookElement.id : 'unknown';
  }

  /**
   * Handle hyperlight URL navigation (special case of book-to-book) with smart progress management
   */
  static async handleHyperlightNavigation(options = {}) {
    const { 
      fromBook, 
      toBook, 
      hyperlightId, 
      hyperciteId,
      progressCallback 
    } = options;
    
    console.log('✨ BookToBookTransition: Handling hyperlight navigation', { 
      fromBook, toBook, hyperlightId, hyperciteId 
    });
    
    // Use deterministic progress callback that shows progress immediately
    const progress = progressCallback || this.createDeterministicProgressCallback(toBook);
    
    // Execute transition with specific hyperlight handling
    return await this.execute({
      fromBook,
      toBook,
      hash: hyperciteId ? `#${hyperciteId}` : '',
      hyperlightId,
      hyperciteId,
      progressCallback: progress
    });
  }

  /**
   * Parse a hyperlight URL and extract components
   */
  static parseHyperlightUrl(url) {
    try {
      const urlObj = new URL(url, window.location.origin);
      const pathSegments = urlObj.pathname.split('/').filter(Boolean);
      
      if (pathSegments.length >= 2 && pathSegments[1].startsWith('HL_')) {
        return {
          bookId: pathSegments[0],
          hyperlightId: pathSegments[1],
          hyperciteId: urlObj.hash ? urlObj.hash.substring(1) : null
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error parsing hyperlight URL:', error);
      return null;
    }
  }

  /**
   * Check if a URL represents a hyperlight navigation
   */
  static isHyperlightUrl(url) {
    const parsed = this.parseHyperlightUrl(url);
    return parsed !== null;
  }

  /**
   * Create a deterministic progress callback that shows progress immediately
   */
  static createDeterministicProgressCallback(toBook) {
    // Always show progress immediately, never suppress
    const progressCallback = ProgressOverlayConductor.createProgressCallback('book-to-book', toBook);
    
    // Show initial progress immediately
    progressCallback(5, `Loading ${toBook}...`);
    
    return progressCallback;
  }

  /**
   * Ensure initial content is actually loaded into the DOM
   */
  static async ensureInitialContentLoaded(bookId) {
    console.log(`📄 BookToBookTransition: Ensuring initial content loaded for ${bookId}`);
    
    try {
      // Check if content is already in the DOM
      const container = document.getElementById(bookId);
      if (!container) {
        console.warn(`Container #${bookId} not found`);
        return;
      }
      
      const existingChunks = container.querySelectorAll('[data-chunk-id]');
      if (existingChunks.length > 0) {
        console.log(`✅ Content already loaded: ${existingChunks.length} chunks found`);
        return;
      }
      
      // Get the lazy loader and manually load first chunk
      if (!currentLazyLoader) {
        console.warn('No lazy loader available for manual chunk loading');
        return;
      }
      
      // Find the first chunk to load — prefer chunk 0, but during chunked lazy loading
      // the initial chunk may be a different one (e.g. the chunk containing a navigation target)
      if (window.nodes && window.nodes.length > 0) {
        const firstChunk = window.nodes[0];
        if (firstChunk) {
          console.log(`📄 Manually loading first chunk ${firstChunk.chunk_id} for ${bookId}`);
          currentLazyLoader.loadChunk(firstChunk.chunk_id, "down");
          
          // Wait a moment for the chunk to be inserted
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // Verify it was loaded
          const loadedChunks = container.querySelectorAll('[data-chunk-id]');
          if (loadedChunks.length > 0) {
            console.log(`✅ Initial content loaded successfully: ${loadedChunks.length} chunks`);
          } else {
            console.warn(`❌ Initial content load may have failed`);
          }
        }
      }
      
    } catch (error) {
      console.error('Error ensuring initial content loaded:', error);
    }
  }

  /**
   * Create regular progress callback for non-cached content
   */
  static createBookToBookProgressCallback(toBook) {
    const { ProgressOverlayConductor } = window;
    if (!ProgressOverlayConductor) {
      console.warn('ProgressOverlayConductor not available, using console fallback');
      return (percent, message) => console.log(`Progress: ${percent}% - ${message}`);
    }

    return ProgressOverlayConductor.showBookToBookTransition(toBook);
  }
}