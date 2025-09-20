/**
 * BookToBookTransition - PATHWAY 4
 * Handles navigation between books while already in reader mode
 * Only replaces content, preserves navigation elements and uses specialized progress handling
 */
import { ProgressManager } from '../ProgressManager.js';
import { waitForNavigationTarget, waitForElementReady } from '../../domReadiness.js';

export class BookToBookTransition {
  static isTransitioning = false;
  /**
   * Execute book-to-book transition
   */
  static async execute(options = {}) {
    // Prevent multiple simultaneous transitions
    if (this.isTransitioning) {
      console.log('🚫 BookToBookTransition: Already transitioning, ignoring duplicate request');
      return;
    }
    
    this.isTransitioning = true;
    const { 
      fromBook,
      toBook, 
      hash = '',
      hyperlightId = null,
      hyperciteId = null,
      progressCallback
    } = options;

    // URL will be updated at the end after all initialization is complete    
    console.log('📖 BookToBookTransition: Starting book-to-book transition', { 
      fromBook, toBook, hash, hyperlightId, hyperciteId 
    });
    
    try {
      // Use provided progress callback or create book-to-book specific one
      const progress = progressCallback || this.createBookToBookProgressCallback(toBook);
      
      progress(5, `Loading ${toBook}...`);
      
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
      const { waitForLayoutStabilization } = await import('../../domReadiness.js');
      await waitForLayoutStabilization();
      
      progress(60, 'Initializing reader...');
      
      // Initialize the new reader view
      await this.initializeReader(toBook, progress);
      
      progress(75, 'Ensuring content readiness...');
      
      // Wait for content to be fully ready after initialization
      const { waitForContentReady } = await import('../../domReadiness.js');
      await waitForContentReady(toBook, {
        maxWaitTime: 10000,
        requireLazyLoader: true
      });
      
      progress(78, 'Loading initial content...');
      
      // Manually trigger first chunk load to ensure content appears
      await this.ensureInitialContentLoaded(toBook);
      
      progress(80, 'Finalizing navigation...');
      
      // Handle any hash-based navigation (hyperlights, hypercites, etc.)
      await this.handleHashNavigation(hash, hyperlightId, hyperciteId, toBook);
      
      // Final URL update after all initialization and navigation is complete
      this.updateUrl(toBook, hash);
      
      progress(100, 'Complete!');
      await ProgressManager.hide();
      
      console.log('✅ BookToBookTransition: Book-to-book transition complete');
      
    } catch (error) {
      console.error('❌ BookToBookTransition: Transition failed:', error);
      
      // Hide progress on error
      await ProgressManager.hide();
      
      // Fallback to full page navigation
      const fallbackUrl = `/${toBook}/edit?target=1&edit=1${hash}`;
      console.log('🔄 BookToBookTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;
      
      throw error;
    } finally {
      // Always reset the transitioning flag
      this.isTransitioning = false;
    }
  }

  /**
   * Clean up current reader state while preserving navigation
   */
  static async cleanupCurrentReader() {
    console.log('🧹 BookToBookTransition: Cleaning up current reader (preserving navigation)');
    
    try {
      // Close any open containers
      const { closeHyperlitContainer } = await import('../../unified-container.js');
      closeHyperlitContainer();
      
      // Clean up accumulated navigation overlays
      this.cleanupNavigationOverlays();
      
      // Clean up global event handlers (but not navigation ones)
      // This is a selective cleanup - we keep the navigation overlay
      
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
    
    const response = await fetch(`/${bookId}/edit?target=1`);
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
      // Fallback: replace entire body but this is less ideal
      console.warn('🎯 BookToBookTransition: #page-wrapper not found, falling back to body replacement');
      
      // Remove any overlay from fetched HTML
      const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
      if (overlayInFetchedHTML) {
        overlayInFetchedHTML.remove();
        console.log('🎯 BookToBookTransition: Removed overlay from fetched HTML');
      }
      
      document.body.innerHTML = newDoc.body.innerHTML;
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
      const { enforceEditableState } = await import('../../editButton.js');
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Initialize the reader for the new book
   */
  static async initializeReader(bookId, progressCallback) {
    console.log(`🚀 BookToBookTransition: Initializing reader for ${bookId}`);
    
    try {
      // Set the current book
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);
      
      // Initialize reader view but skip overlay restoration for book-to-book
      const { universalPageInitializer } = await import('../../viewManager.js');
      await universalPageInitializer(progressCallback);
      
      // All UI rebinding is now handled by universalPageInitializer
      console.log("✅ BookToBookTransition: UI initialization delegated to universalPageInitializer");
      
    } catch (error) {
      console.error('❌ BookToBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Handle hash-based navigation (hyperlights, hypercites, internal links)
   */
  static async handleHashNavigation(hash, hyperlightId, hyperciteId, bookId) {
    if (!hash && !hyperlightId && !hyperciteId) {
      console.log('📖 BookToBookTransition: No hash navigation needed');
      return;
    }
    
    console.log('🎯 BookToBookTransition: Handling hash navigation', { 
      hash, hyperlightId, hyperciteId 
    });
    
    try {
      // Wait for content to be fully loaded
      const { pendingFirstChunkLoadedPromise } = await import('../../initializePage.js');
      if (pendingFirstChunkLoadedPromise) {
        console.log('⏳ BookToBookTransition: Waiting for content to load before navigation');
        await pendingFirstChunkLoadedPromise;
        console.log('✅ BookToBookTransition: Content loaded, proceeding with navigation');
      }
      
      // Handle different types of navigation
      if (hyperlightId && hyperciteId) {
        // Hyperlight + hypercite navigation
        await this.navigateToHyperciteTarget(hyperlightId, hyperciteId);
      } else if (hyperlightId) {
        // Just hyperlight navigation
        await this.navigateToInternalId(hyperlightId);
      } else if (hash) {
        // General hash navigation
        const targetId = hash.startsWith('#') ? hash.substring(1) : hash;
        await this.navigateToInternalId(targetId);
      }
      
    } catch (error) {
      console.error('❌ BookToBookTransition: Hash navigation failed:', error);
      // Don't throw - navigation failure shouldn't break the entire transition
    }
  }

  /**
   * Navigate to a hypercite target with deterministic element detection
   */
  static async navigateToHyperciteTarget(hyperlightId, hyperciteId) {
    console.log(`🎯 BookToBookTransition: Navigating to hyperlight ${hyperlightId} -> hypercite ${hyperciteId}`);
    
    try {
      // Wait for both the hyperlight and hypercite elements to be ready
      const mainContainer = document.getElementById('main') || document.body;
      
      console.log(`⏳ BookToBookTransition: Waiting for hyperlight ${hyperlightId} and hypercite ${hyperciteId} to be ready`);
      
      // Wait for hyperlight first
      await waitForElementReady(hyperlightId, {
        maxAttempts: 40,
        checkInterval: 50,
        container: mainContainer
      });
      
      // Then wait for hypercite
      await waitForElementReady(hyperciteId, {
        maxAttempts: 40,
        checkInterval: 50,
        container: mainContainer
      });
      
      console.log(`✅ BookToBookTransition: Both hyperlight ${hyperlightId} and hypercite ${hyperciteId} are ready`);
      
      const { navigateToHyperciteTarget } = await import('../../hyperCites.js');
      const { currentLazyLoader } = await import('../../initializePage.js');
      
      if (currentLazyLoader) {
        navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);
      } else {
        console.warn('currentLazyLoader not available for hypercite navigation');
      }
    } catch (error) {
      console.error('Failed to navigate to hypercite target:', error);
      // Don't throw - attempt navigation anyway as fallback
      try {
        const { navigateToHyperciteTarget } = await import('../../hyperCites.js');
        const { currentLazyLoader } = await import('../../initializePage.js');
        
        if (currentLazyLoader) {
          navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);
        }
      } catch (fallbackError) {
        console.error('Fallback hypercite navigation also failed:', fallbackError);
      }
    }
  }

  /**
   * Navigate to an internal ID with deterministic element detection
   */
  static async navigateToInternalId(targetId) {
    console.log(`🎯 BookToBookTransition: Navigating to internal ID: ${targetId}`);
    
    try {
      // Wait for the target element to be fully ready before attempting navigation
      const mainContainer = document.getElementById('main') || document.body;
      const targetElement = await waitForElementReady(targetId, {
        maxAttempts: 40, // Allow more time for lazy loading
        checkInterval: 50,
        container: mainContainer
      });
      
      console.log(`✅ BookToBookTransition: Target element ${targetId} is ready, proceeding with navigation`);
      
      const { navigateToInternalId } = await import('../../scrolling.js');
      const { currentLazyLoader } = await import('../../initializePage.js');
      
      if (currentLazyLoader) {
        navigateToInternalId(targetId, currentLazyLoader, false);
      } else {
        console.warn('currentLazyLoader not available for internal navigation');
      }
    } catch (error) {
      console.error('Failed to navigate to internal ID:', error);
      // Don't throw - attempt navigation anyway as fallback
      try {
        const { navigateToInternalId } = await import('../../scrolling.js');
        const { currentLazyLoader } = await import('../../initializePage.js');
        
        if (currentLazyLoader) {
          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      } catch (fallbackError) {
        console.error('Fallback navigation also failed:', fallbackError);
      }
    }
  }

  /**
   * Update the browser URL
   */
  static updateUrl(bookId, hash = '') {
    const newUrl = `/${bookId}${hash}`;
    
    try {
      const currentUrl = window.location.pathname + window.location.hash;
      
      // Only update URL if we're not already there
      if (currentUrl !== newUrl) {
        console.log(`🔗 BookToBookTransition: Navigating to ${newUrl}`);
        // Replace current history entry instead of pushing new one
        history.replaceState(null, '', newUrl);
      } else {
        console.log(`🔗 BookToBookTransition: Already at ${newUrl}`);
      }
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Handle hyperlight URL navigation (special case of book-to-book)
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
    
    // Create specialized progress callback for hyperlight navigation
    const progress = progressCallback || ProgressManager.createProgressCallback('book-to-book', toBook);
    
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
   * Create a smart progress callback that suppresses progress bar for cached books
   */
  static createSmartProgressCallback(toBook) {
    let progressSuppressed = false;
    let actualProgressCallback = null;
    let earlyProgressCalls = [];
    
    const smartCallback = (percent, message) => {
      // Check if this is a "cache hit" message pattern
      if (message && (
        message.includes('Loading from cache') || 
        message.includes('cached nodeChunks') ||
        message.includes('Checking local cache')
      )) {
        console.log(`📖 BookToBookTransition: Suppressing progress bar - ${toBook} loading from cache`);
        progressSuppressed = true;
        // Clear any early progress calls since we're suppressing
        earlyProgressCalls = [];
        return; // Don't show progress for cached content
      }
      
      // If progress is suppressed, don't do anything
      if (progressSuppressed) {
        return;
      }
      
      // If we haven't determined cache status yet, store the call
      if (!actualProgressCallback && !progressSuppressed) {
        earlyProgressCalls.push({ percent, message });
        
        // Only create the actual callback if we get significant progress calls
        // Delay creation to see if cache detection happens first
        if (earlyProgressCalls.length > 2) {
          actualProgressCallback = ProgressManager.createProgressCallback('book-to-book', toBook);
          // Replay stored calls
          earlyProgressCalls.forEach(({ percent: p, message: m }) => {
            actualProgressCallback(p, m);
          });
          earlyProgressCalls = [];
        }
        return;
      }
      
      // Only show progress if not suppressed and we have a callback
      if (!progressSuppressed && actualProgressCallback) {
        actualProgressCallback(percent, message);
      }
    };
    
    // Add a property to check if progress was suppressed
    smartCallback.wasProgressSuppressed = () => progressSuppressed;
    
    return smartCallback;
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
      const { currentLazyLoader } = await import('../../initializePage.js');
      if (!currentLazyLoader) {
        console.warn('No lazy loader available for manual chunk loading');
        return;
      }
      
      // Find the first chunk to load
      if (window.nodeChunks && window.nodeChunks.length > 0) {
        const firstChunk = window.nodeChunks.find(chunk => chunk.chunk_id === 0) || window.nodeChunks[0];
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
    const { ProgressManager } = window;
    if (!ProgressManager) {
      console.warn('ProgressManager not available, using console fallback');
      return (percent, message) => console.log(`Progress: ${percent}% - ${message}`);
    }
    
    return ProgressManager.showBookToBookTransition(toBook);
  }
}