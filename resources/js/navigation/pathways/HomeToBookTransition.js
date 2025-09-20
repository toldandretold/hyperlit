/**
 * HomeToBookTransition - PATHWAY 6
 * Handles navigation from home.blade.php to reader.blade.php
 * Full body replacement and template switch from home to reader
 */
import { ProgressManager } from '../ProgressManager.js';

export class HomeToBookTransition {
  /**
   * Execute home-to-book transition
   */
  static async execute(options = {}) {
    const { 
      toBook,
      hash = '',
      progressCallback
    } = options;
    
    console.log('📖 HomeToBookTransition: Starting home-to-book transition', { toBook, hash });
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressManager.createProgressCallback('spa');
      
      progress(10, `Loading ${toBook}...`);
      
      // Clean up current homepage state
      await this.cleanupHomepageState();
      
      progress(30, 'Fetching book content...');
      
      // Fetch the book's reader HTML
      const readerHtml = await this.fetchBookHtml(toBook);
      
      progress(60, 'Updating page template...');
      
      // Replace the entire body content (home → reader template switch)
      await this.replaceBodyContent(readerHtml);
      
      progress(70, 'Waiting for DOM stabilization...');
      
      // Wait for DOM to be ready for content insertion
      const { waitForLayoutStabilization } = await import('../../domReadiness.js');
      await waitForLayoutStabilization();
      
      progress(80, 'Initializing reader...');
      
      // Initialize the reader
      await this.initializeReader(toBook, progress);
      
      progress(85, 'Ensuring content readiness...');
      
      // Wait for content to be fully ready after initialization
      const { waitForContentReady } = await import('../../domReadiness.js');
      await waitForContentReady(toBook, {
        maxWaitTime: 10000,
        requireLazyLoader: true
      });
      
      // Update the URL
      this.updateUrl(toBook, hash);
      
      // Navigate to hash if provided
      if (hash) {
        progress(90, 'Navigating to target...');
        await this.navigateToHash(hash);
      }
      
      progress(100, 'Book loaded!');
      await ProgressManager.hide();
      
      console.log('✅ HomeToBookTransition: Home-to-book transition complete');
      
    } catch (error) {
      console.error('❌ HomeToBookTransition: Transition failed:', error);
      
      // Fallback to full page navigation
      const fallbackUrl = hash ? `/${toBook}${hash}` : `/${toBook}`;
      console.log('🔄 HomeToBookTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;
      
      throw error;
    }
  }

  /**
   * Clean up current homepage state before transition
   */
  static async cleanupHomepageState() {
    console.log('🧹 HomeToBookTransition: Cleaning up homepage state');
    
    try {
      // Clean up any homepage-specific components or listeners
      // Most cleanup will happen automatically when we replace the body content
      console.log('✅ HomeToBookTransition: Homepage cleanup complete');
    } catch (error) {
      console.warn('Homepage cleanup failed:', error);
    }
  }

  /**
   * Fetch the book's reader HTML
   */
  static async fetchBookHtml(bookId) {
    console.log(`📥 HomeToBookTransition: Fetching reader HTML for ${bookId}`);
    
    const response = await fetch(`/${bookId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch book HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    console.log(`✅ HomeToBookTransition: Fetched HTML (${htmlString.length} characters)`);
    
    return htmlString;
  }

  /**
   * Replace body content with reader HTML (home → reader template switch)
   */
  static async replaceBodyContent(htmlString) {
    console.log('🔄 HomeToBookTransition: Replacing body content (home → reader)');
    
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');
    
    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 HomeToBookTransition: Removed overlay from fetched HTML');
    }
    
    // Preserve the existing overlay before replacing body content
    const existingOverlay = document.getElementById('initial-navigation-overlay');
    const overlayToPreserve = existingOverlay ? existingOverlay.cloneNode(true) : null;
    
    // Replace the entire body content (template switch)
    document.body.innerHTML = newDoc.body.innerHTML;
    
    // Restore the overlay if it existed
    if (overlayToPreserve) {
      document.body.insertBefore(overlayToPreserve, document.body.firstChild);
      
      // Reset overlay to its default state for reader
      overlayToPreserve.style.display = '';
      overlayToPreserve.style.visibility = '';
      
      console.log('🎯 HomeToBookTransition: Preserved and restored navigation overlay with reset state');
    }
    
    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');
    console.log('🎯 HomeToBookTransition: Set data-page="reader"');
    
    // Update document title
    document.title = newDoc.title;
    
    console.log('✅ HomeToBookTransition: Body content replaced successfully');
  }

  /**
   * Initialize the reader after template switch
   */
  static async initializeReader(bookId, progressCallback) {
    console.log(`📖 HomeToBookTransition: Initializing reader for ${bookId}`);
    
    try {
      // Set current book for reader
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);
      
      // Initialize reader functionality
      const { universalPageInitializer } = await import('../../viewManager.js');
      await universalPageInitializer(progressCallback);
      
      // Explicitly load first chunk for SPA context (since observer might not trigger immediately)
      await this.ensureContentLoaded(bookId);
      
      console.log('✅ HomeToBookTransition: Reader initialization complete');
      
    } catch (error) {
      console.error('❌ HomeToBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Update the browser URL to book path
   */
  static updateUrl(bookId, hash = '') {
    const newUrl = `/${bookId}${hash}`;
    
    try {
      history.pushState({}, '', newUrl);
      console.log(`🔗 HomeToBookTransition: Updated URL to ${newUrl}`);
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Ensure content is loaded for SPA context
   */
  static async ensureContentLoaded(bookId) {
    console.log(`📄 HomeToBookTransition: Ensuring content loaded for ${bookId}`);
    
    try {
      // Check if we have chunks and a lazy loader
      if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.warn('No nodeChunks available for content loading');
        return;
      }
      
      // Get the current lazy loader
      const { currentLazyLoader } = await import('../../initializePage.js');
      if (!currentLazyLoader) {
        console.warn('No currentLazyLoader available for content loading');
        return;
      }
      
      // Check if content is already loaded
      const bookContainer = document.getElementById(bookId);
      if (bookContainer && bookContainer.children.length > 2) { // More than just sentinels
        console.log('📄 Content already loaded, skipping');
        return;
      }
      
      // Load the first chunk
      const firstChunk = window.nodeChunks.find(chunk => chunk.chunk_id === 0) || window.nodeChunks[0];
      if (firstChunk) {
        console.log(`📄 Loading initial chunk ${firstChunk.chunk_id} for ${bookId} (SPA context)`);
        currentLazyLoader.loadChunk(firstChunk.chunk_id, "down");
      }
      
    } catch (error) {
      console.warn('Could not ensure content loaded:', error);
    }
  }

  /**
   * Navigate to hash target if provided
   */
  static async navigateToHash(hash) {
    if (!hash) return;
    
    console.log(`🎯 HomeToBookTransition: Navigating to hash ${hash}`);
    
    try {
      // Import navigation utilities
      const { waitForNavigationTarget } = await import('../../domReadiness.js');
      
      // Extract target ID from hash (remove the #)
      const targetId = hash.substring(1);
      
      // Wait for the target element to be ready, then navigate
      const container = document.querySelector('.reader-content-wrapper') || document.body;
      const targetElement = await waitForNavigationTarget(targetId, container);
      
      if (targetElement) {
        // Scroll to the target element
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        console.log(`✅ HomeToBookTransition: Navigated to ${hash}`);
      }
    } catch (error) {
      console.warn(`Could not navigate to hash ${hash}:`, error);
      // Fallback: try simple hash navigation
      if (hash) {
        window.location.hash = hash;
      }
    }
  }
}