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
      progressCallback
    } = options;
    
    console.log('🏠 BookToHomeTransition: Starting book-to-home transition', { fromBook });
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressManager.createProgressCallback('spa');
      
      progress(10, 'Preparing to return home...');
      
      // Clean up current reader state
      await this.cleanupReaderState();
      
      progress(30, 'Fetching homepage...');
      
      // Fetch the homepage HTML
      const homeHtml = await this.fetchHomepageHtml();
      
      progress(60, 'Updating page template...');
      
      // Replace the entire body content (reader → home template switch)
      await this.replaceBodyContent(homeHtml);
      
      progress(80, 'Initializing homepage...');
      
      // Initialize the homepage
      await this.initializeHomepage(progress);
      
      // Update the URL
      this.updateUrl();
      
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
    } catch (error) {
      console.warn('Reader cleanup failed, doing manual cleanup:', error);
      
      // Fallback: do minimal cleanup manually
      try {
        const { closeHyperlitContainer } = await import('../../unified-container.js');
        closeHyperlitContainer();
      } catch (containerError) {
        console.warn('Could not close hyperlit container:', containerError);
      }
    }
  }

  /**
   * Fetch the homepage HTML
   */
  static async fetchHomepageHtml() {
    console.log('📥 BookToHomeTransition: Fetching homepage HTML');
    
    const response = await fetch('/');
    if (!response.ok) {
      throw new Error(`Failed to fetch homepage HTML: ${response.status}`);
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
  static async initializeHomepage(progressCallback) {
    console.log('🏠 BookToHomeTransition: Initializing homepage');
    
    try {
      // Reset current book to most-recent for homepage
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook('most-recent');
      
      // Initialize homepage functionality
      const { universalPageInitializer } = await import('../../viewManager.js');
      await universalPageInitializer(progressCallback);
      
      console.log('✅ BookToHomeTransition: Homepage initialization complete');
      
    } catch (error) {
      console.error('❌ BookToHomeTransition: Homepage initialization failed:', error);
      throw error;
    }
  }

  /**
   * Update the browser URL to homepage
   */
  static updateUrl() {
    const newUrl = '/';
    
    try {
      history.pushState({}, '', newUrl);
      console.log(`🔗 BookToHomeTransition: Updated URL to ${newUrl}`);
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }
}