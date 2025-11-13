/**
 * ImportBookTransition - PATHWAY 3
 * Handles book imports from form submission to reader.blade.php
 * This pathway involves backend processing and full body replacement
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { waitForLayoutStabilization, waitForContentReady } from '../../domReadiness.js';
import { destroyUserContainer } from '../../components/userContainer.js';
import { destroyNewBookContainer } from '../../components/newBookButton.js';
import { destroyHomepageDisplayUnit } from '../../homepageDisplayUnit.js';
import { resetEditModeState, enforceEditableState, enableEditMode } from '../../components/editButton.js';
import { cleanupReaderView } from '../../viewManager.js';
import { setCurrentBook } from '../../app.js';
import { resolveFirstChunkPromise, loadFromJSONFiles } from '../../initializePage.js';
import { universalPageInitializer } from '../../viewManager.js';
import { initializeLogoNav } from '../../components/logoNavToggle.js';
import { openDatabase } from '../../indexedDB/index.js';

export class ImportBookTransition {
  /**
   * Execute book import and transition
   */
  static async execute(options = {}) {
    console.log('🔥 DEBUG: ImportBookTransition.execute() CALLED with options:', options);

    const {
      bookId,
      progressCallback,
      shouldEnterEditMode = true
    } = options;

    console.log('📥 ImportBookTransition: Starting import book transition', { bookId, shouldEnterEditMode });
    
    try {
      // Use provided progress callback or create our own
      const progress = progressCallback || ProgressOverlayConductor.createProgressCallback('spa');
      
      progress(10, 'Processing imported book...');
      
      // Clean up any previous reader state
      await this.cleanupPreviousState();
      
      progress(30, 'Fetching reader interface...');
      
      // Fetch the reader page HTML for the imported book
      const readerHtml = await this.fetchReaderPageHtml(bookId);
      
      progress(50, 'Updating page structure...');
      
      // Replace the entire body content (form → reader transition)
      await this.replaceBodyContent(readerHtml, bookId);
      
      progress(60, 'Waiting for DOM stabilization...');

      // Wait for DOM to be ready for content insertion
      await waitForLayoutStabilization();
      
      // Set up session storage for imported book handling
      this.setupImportedBookSession(bookId);
      
      progress(70, 'Initializing imported content...');
      
      // Initialize the imported reader view
      await this.initializeImportedReader(bookId, progress);
      
      progress(80, 'Ensuring content readiness...');

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

      progress(100, 'Import complete!');

      console.log('✅ ImportBookTransition: Import book transition complete');
      // NOTE: NavigationManager will hide the overlay when this returns

    } catch (error) {
      console.error('❌ ImportBookTransition: Transition failed:', error);

      // Fallback to full page navigation
      const fallbackUrl = `/${bookId}/edit?target=1${shouldEnterEditMode ? '&edit=1' : ''}`;
      console.log('🔄 ImportBookTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;

      throw error;
    }
  }

  /**
   * Clean up any previous reader state
   */
  static async cleanupPreviousState() {
    console.log('🧹 ImportBookTransition: Cleaning up previous state');
    
    try {
      // Import and destroy homepage-specific components
      if (destroyUserContainer) destroyUserContainer();
      if (destroyNewBookContainer) destroyNewBookContainer();
      console.log('🧹 ImportBookTransition: Homepage containers destroyed.');

      if (destroyHomepageDisplayUnit) destroyHomepageDisplayUnit();

      // Also explicitly reset all edit mode state flags as a safeguard
      resetEditModeState();

      // Also clean up the reader view in case of an inconsistent state
      cleanupReaderView();
    } catch (error) {
      console.warn('⚠️ Cleanup failed, but continuing transition:', error);
    }
  }

  /**
   * Fetch the reader page HTML for imported book
   */
  static async fetchReaderPageHtml(bookId) {
    console.log(`📥 ImportBookTransition: Fetching reader HTML for imported book ${bookId}`);
    
    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    console.log(`✅ ImportBookTransition: Fetched HTML (${htmlString.length} characters)`);
    
    return htmlString;
  }

  /**
   * Replace body content with reader HTML
   */
  static async replaceBodyContent(htmlString, bookId) {
    console.log('🔄 ImportBookTransition: Replacing body content (import form → reader)');

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // 🎯 CRITICAL: Preserve the existing navigation overlay
    const existingOverlay = document.getElementById('initial-navigation-overlay');

    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 ImportBookTransition: Removed overlay from fetched HTML');
    }

    // Replace the entire body content
    document.body.innerHTML = newDoc.body.innerHTML;

    // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
    if (existingOverlay) {
      document.body.insertBefore(existingOverlay, document.body.firstChild);
      console.log('🎯 ImportBookTransition: Preserved navigation overlay across body replacement');
    }
    
    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');
    console.log('🎯 ImportBookTransition: Set data-page="reader"');
    
    // Update document title
    document.title = newDoc.title;
    
    // Reset contentEditable state after HTML replacement
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      console.log("🧹 ImportBookTransition: Reset contentEditable after HTML replacement");
    }
    
    // Enforce editable state
    try {
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Set up session storage for imported book handling
   */
  static setupImportedBookSession(bookId) {
    // Set the session flag for overlay management
    sessionStorage.setItem('pending_import_book', bookId);
    console.log(`🎯 ImportBookTransition: Set pending_import_book flag: ${bookId}`);
    
    // Mark this as imported content
    sessionStorage.setItem('imported_book_flag', bookId);
    console.log(`🎯 ImportBookTransition: Set imported_book_flag: ${bookId}`);
  }

  /**
   * Initialize the imported reader view
   */
  static async initializeImportedReader(bookId, progressCallback) {
    console.log(`🚀 ImportBookTransition: Initializing imported reader for ${bookId}`);
    
    try {
      // Set the current book
      setCurrentBook(bookId);

      // Hide overlay immediately for imported books
      const overlay = document.getElementById('initial-navigation-overlay');
      if (overlay) {
        overlay.style.display = 'none';
        overlay.style.visibility = 'hidden';
        overlay.remove();
        console.log('🎯 ImportBookTransition: Overlay removed for imported book');
      }

      // Resolve the first chunk promise since content is already in DOM
      try {
        resolveFirstChunkPromise();
        console.log("✅ ImportBookTransition: First chunk promise resolved");
      } catch (error) {
        console.warn('Could not resolve first chunk promise:', error);
      }

      // Initialize the reader view using the existing system
      await universalPageInitializer(progressCallback);

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 ImportBookTransition: Reinitializing logo navigation toggle');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ ImportBookTransition: Logo navigation toggle initialized');
      }

      // All UI rebinding is now handled by universalPageInitializer
      console.log("✅ ImportBookTransition: UI initialization delegated to universalPageInitializer");
      
    } catch (error) {
      console.error('❌ ImportBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Enter edit mode
   */
  static async enterEditMode() {
    console.log('📝 ImportBookTransition: Entering edit mode');
    
    try {
      await enableEditMode(null, false); // false = don't force redirect

      console.log('✅ ImportBookTransition: Edit mode enabled');
      
    } catch (error) {
      console.error('❌ ImportBookTransition: Failed to enter edit mode:', error);
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
      console.log(`🔗 ImportBookTransition: Updated URL to ${newUrl}`);
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Handle form submission and backend processing
   * This is the main entry point from newBookForm.js
   */
  static async handleFormSubmissionAndTransition(formData, submitButton) {
    console.log('📥 ImportBookTransition: Starting form submission and transition');
    
    try {
      // Get CSRF token
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      
      // Submit to Laravel backend
      const response = await fetch('/import-file', {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetails;
        let isProcessingError = false;
        
        try {
          const errorJson = JSON.parse(errorText);
          console.error('❌ Server validation errors:', errorJson);
          
          // Check if this is a file processing error (vs validation error)
          if (errorJson.error && errorJson.error.includes('Failed to process file')) {
            isProcessingError = true;
            errorDetails = `File processing failed: ${errorJson.error}\n\nThis may be due to:\n• Document format issues\n• Backend processing script errors\n• File complexity\n\nTry with a simpler document or check the backend logs.`;
          } else if (errorJson.errors) {
            const validationErrors = Object.entries(errorJson.errors)
              .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
              .join('\n');
            errorDetails = `Validation failed:\n${validationErrors}`;
          } else {
            errorDetails = errorJson.message || errorJson.error || errorText;
          }
        } catch (e) {
          console.error('❌ Server error (not JSON):', errorText);
          errorDetails = errorText;
        }
        
        // Create a more specific error for processing failures
        const error = new Error(`Server responded with ${response.status}: ${errorDetails}`);
        error.isProcessingError = isProcessingError;
        throw error;
      }

      const result = await response.json();
      console.log('✅ Import completed:', result);

      if (!result.bookId) {
        throw new Error('No bookId returned from backend');
      }

      // Save the authoritative library record from server
      if (result.library) {
        const db = await openDatabase();
        const tx = db.transaction('library', 'readwrite');
        tx.objectStore('library').put(result.library);

        // Wait for transaction to complete using proper IndexedDB API
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        console.log('✅ Server library record saved to IndexedDB');
      }

      // Pre-load the book's content into IndexedDB
      console.log('🔥 DEBUG: About to pre-load book content for:', result.bookId);
      try {
        console.log('🔥 DEBUG: loadFromJSONFiles imported, calling it now...');
        await loadFromJSONFiles(result.bookId);
        console.log('✅ Pre-loaded imported book content');
      } catch (e) {
        console.error('❌ DEBUG: Preloading JSON failed with error:', e);
        console.warn('Preloading JSON failed; continuing with reader fallback:', e);
      }
      console.log('🔥 DEBUG: Finished preloading section (after try-catch)');

      // Clear form data since import was successful
      this.clearFormData();

      // Execute the import transition
      console.log('🚀 About to execute import transition for bookId:', result.bookId);
      await this.execute({
        bookId: result.bookId,
        shouldEnterEditMode: true
      });
      console.log('✅ Import transition execute completed');

      return result;

    } catch (error) {
      console.error('❌ Import failed:', error);
      
      // Re-enable submit button on failure
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
      }
      
      throw error;
    }
  }

  /**
   * Clear saved form data after successful import
   */
  static clearFormData() {
    try {
      localStorage.removeItem('formData');
      localStorage.removeItem('newbook-form-data');
      console.log('🧹 ImportBookTransition: Cleared saved form data');
    } catch (e) {
      console.warn('Unable to clear saved form data:', e);
    }
  }
}