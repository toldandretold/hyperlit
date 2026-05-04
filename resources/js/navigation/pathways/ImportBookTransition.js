/**
 * ImportBookTransition - PATHWAY 3
 * Handles book imports from form submission to reader.blade.php
 * This pathway involves backend processing and full body replacement
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { ProgressOverlayEnactor } from '../ProgressOverlayEnactor.js';
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
import { openDatabase, updateDatabaseBookId } from '../../indexedDB/index.js';
import { showConversionFeedbackToast } from '../../conversion/feedbackToast.js';

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

    // 🔥 CRITICAL: Rebind ProgressOverlayEnactor to the preserved element
    // After body replacement, ProgressOverlayEnactor's references are stale
    ProgressOverlayEnactor.rebind();
    
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
      updateDatabaseBookId(bookId);

      // Hide overlay immediately for imported books
      const overlay = document.getElementById('initial-navigation-overlay');
      if (overlay) {
        overlay.style.display = 'none';
        overlay.style.visibility = 'hidden';
        console.log('🎯 ImportBookTransition: Overlay hidden for imported book');
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

  // Stage labels for progress UI
  static STAGE_LABELS = {
    queued: 'Waiting to start...',
    starting: 'Starting document processing...',
    epub_load: 'Loading EPUB content...',
    epub_transforms: 'Normalizing document structure...',
    epub_footnotes: 'Detecting footnotes...',
    epub_sanitize: 'Sanitizing HTML...',
    epub_write: 'Writing output files...',
    epub_complete: 'EPUB normalization complete',
    doc_parse: 'Parsing document...',
    doc_bibliography: 'Scanning bibliography...',
    doc_footnotes: 'Processing footnotes...',
    doc_linking: 'Linking citations...',
    doc_footnote_linking: 'Linking footnotes...',
    doc_audit: 'Validating footnotes...',
    doc_json_gen: 'Building content...',
    doc_sanitize: 'Sanitizing output...',
    doc_json_written: 'Output files written',
    docx_converting: 'Converting document...',
    db_write: 'Saving to database...',
    db_footnotes: 'Saving footnotes...',
    db_references: 'Saving references...',
    complete: 'Import complete!',
  };

  /**
   * Create progress UI by replacing form content
   */
  static createImportProgressUI(bookId) {
    const container = document.getElementById('newbook-container');
    const citeForm = container?.querySelector('#cite-form');
    const targetEl = citeForm || container;

    if (!targetEl) {
      console.warn('Could not find form container for progress UI');
      return null;
    }

    // Save original content and layout for potential restoration
    const savedHtml = targetEl.innerHTML;
    const scroller = container?.querySelector('.scroller');
    const savedScrollerPosition = scroller?.style.position;
    const savedScrollerHeight = scroller?.style.height;
    const savedContainerHeight = container?.style.height;

    // Switch scroller from absolute to relative so it contributes to flow height,
    // then let the container shrink-wrap the progress content
    if (scroller) {
      scroller.style.position = 'relative';
      scroller.style.height = 'auto';
    }
    if (container) {
      container.style.height = 'auto';
      container.style.transition = 'height 0.3s ease-out';
    }

    targetEl.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; max-width: 480px; margin: 0 auto;">
        <h3 style="margin: 0 0 24px; font-size: 18px; font-weight: 600; color: var(--text-color, #fff);">
          Importing document...
        </h3>
        <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; margin-bottom: 16px;">
          <div id="import-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4EACAE, #EF8D34); border-radius: 2px; transition: width 0.4s ease;"></div>
        </div>
        <p id="import-stage-text" style="margin: 0 0 6px; font-size: 14px; color: var(--text-color, #ccc);">
          Waiting to start...
        </p>
        <p id="import-detail-text" style="margin: 0 0 20px; font-size: 12px; color: var(--text-muted, #888);">
        </p>
        <p id="import-notify-row" style="margin: 0; font-size: 12px; color: var(--text-muted, #666);">
          <a href="#" id="import-notify-btn"
             style="color: var(--text-muted, #888); text-decoration: underline; cursor: pointer;">
            Email me when done
          </a>
        </p>
      </div>
    `;

    const progressBar = document.getElementById('import-progress-bar');
    const stageText = document.getElementById('import-stage-text');
    const detailText = document.getElementById('import-detail-text');

    const notifyBtn = document.getElementById('import-notify-btn');
    const notifyRow = document.getElementById('import-notify-row');
    if (notifyBtn) {
      notifyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        notifyBtn.style.pointerEvents = 'none';
        notifyBtn.textContent = 'Requesting...';
        try {
          const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
          const resp = await fetch(`/api/import-progress/${bookId}/notify`, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'X-CSRF-TOKEN': csrfToken,
            },
            credentials: 'include',
          });
          if (resp.ok) {
            notifyRow.textContent = "We'll email you when done. You can close this tab.";
          } else {
            const data = await resp.json().catch(() => ({}));
            notifyRow.textContent = data.message || 'Could not set up email notification.';
          }
        } catch {
          notifyRow.textContent = 'Could not set up email notification.';
        }
      });
    }

    return {
      update(pct, msg, detail) {
        if (progressBar && pct != null) progressBar.style.width = `${Math.min(pct, 100)}%`;
        if (stageText && msg) stageText.textContent = msg;
        if (detailText) detailText.textContent = detail || '';
      },
      showError(msg) {
        if (stageText) {
          stageText.textContent = msg || 'Processing failed';
          stageText.style.color = '#CC8888';
        }
        if (progressBar) progressBar.style.background = '#CC8888';
      },
      restoreForm() {
        targetEl.innerHTML = savedHtml;
        if (scroller) {
          scroller.style.position = savedScrollerPosition || '';
          scroller.style.height = savedScrollerHeight || '';
        }
        if (container) {
          container.style.height = savedContainerHeight || '';
        }
      },
    };
  }

  /**
   * Poll import progress endpoint
   */
  static async pollImportProgress(bookId, progressUI) {
    let networkRetries = 0;
    const MAX_NETWORK_RETRIES = 30;

    const poll = async () => {
      try {
        const resp = await fetch(`/api/import-progress/${bookId}`);
        if (!resp.ok) {
          // 404 means progress file not yet written, keep polling
          if (resp.status === 404) {
            progressUI.update(0, 'Waiting to start...', '');
            await new Promise(r => setTimeout(r, 2000));
            return poll();
          }
          throw new Error(`Poll failed: ${resp.status}`);
        }

        // Successful response — reset network retry counter
        networkRetries = 0;

        const data = await resp.json();

        if (data.status === 'complete') {
          progressUI.update(100, 'Import complete!', '');
          return data;
        } else if (data.status === 'failed') {
          throw new Error(data.detail || 'Processing failed');
        }

        // Staleness check: if progress hasn't updated in 5 minutes, assume the job died
        if (data.updated_at && data.status === 'processing') {
          const updatedAt = new Date(data.updated_at).getTime();
          const now = Date.now();
          if (now - updatedAt > 300_000) {
            throw new Error('Import appears to have stalled. Check your email for updates, or try again.');
          }
        }

        const label = this.STAGE_LABELS[data.stage] || data.stage || '';
        progressUI.update(data.percent || 0, label, data.detail || '');

        await new Promise(r => setTimeout(r, 2000));
        return poll();
      } catch (err) {
        console.warn(`[poll] error: ${err.name}: ${err.message}`);
        // Network/server errors — retry with backoff
        if (err.message?.startsWith('Poll failed') || err.name === 'TypeError') {
          networkRetries++;
          if (networkRetries > MAX_NETWORK_RETRIES) {
            throw new Error('Lost connection to server. Check your email for updates, or try again.');
          }
          // Backoff: 3s, 3s, 3s, 5s, 5s, 8s... capped at 10s
          const delay = Math.min(10000, networkRetries <= 3 ? 3000 : networkRetries <= 5 ? 5000 : 8000);
          progressUI.update(null, 'Reconnecting...', `Attempt ${networkRetries}/${MAX_NETWORK_RETRIES}`);
          await new Promise(r => setTimeout(r, delay));
          return poll();
        }
        throw err;
      }
    };

    return poll();
  }

  /**
   * Handle form submission and backend processing
   * This is the main entry point from newBookForm.js
   */
  static async handleFormSubmissionAndTransition(formData, submitButton) {
    console.log('ImportBookTransition: Starting form submission and transition');

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
          console.error('Server validation errors:', errorJson);

          if (errorJson.error && errorJson.error.includes('Failed to process file')) {
            isProcessingError = true;
            errorDetails = `File processing failed: ${errorJson.error}`;
          } else if (errorJson.errors) {
            const validationErrors = Object.entries(errorJson.errors)
              .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
              .join('\n');
            errorDetails = `Validation failed:\n${validationErrors}`;
          } else {
            errorDetails = errorJson.message || errorJson.error || errorText;
          }
        } catch (e) {
          console.error('Server error (not JSON):', errorText);
          errorDetails = errorText;
        }

        const error = new Error(`Server responded with ${response.status}: ${errorDetails}`);
        error.isProcessingError = isProcessingError;
        error.status = response.status;
        throw error;
      }

      const result = await response.json();
      console.log('Import response:', result);

      if (!result.bookId) {
        throw new Error('No bookId returned from backend');
      }

      // Save the authoritative library record from server immediately
      if (result.library) {
        const db = await openDatabase();
        const tx = db.transaction('library', 'readwrite');
        tx.objectStore('library').put(result.library);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        console.log('Server library record saved to IndexedDB');
      }

      // If status is 'processing', show progress UI and poll
      if (result.status === 'processing') {
        console.log('Import dispatched to background, starting progress polling');

        const progressUI = this.createImportProgressUI(result.bookId);

        if (!progressUI) {
          // Fallback: can't show progress UI, just wait
          console.warn('Could not create progress UI, falling back');
        }

        try {
          const completeData = await this.pollImportProgress(result.bookId, progressUI || {
            update() {},
            showError() {},
            restoreForm() {},
          });

          // Check for footnote audit issues
          const completedResult = completeData?.result || completeData;
          if (completedResult?.hasFootnoteIssues && completedResult?.footnoteAudit) {
            const userChoice = await this.showFootnoteAuditModal(completedResult.footnoteAudit, result.bookId);

            if (userChoice === 'resubmit') {
              await this.deleteImportedBook(result.bookId);
              if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Submit';
              }
              if (progressUI) progressUI.restoreForm();
              return null;
            }
          }

          // Update IndexedDB library record with server-extracted metadata
          if (completedResult?.updatedLibrary) {
            try {
              const db = await openDatabase();
              const tx = db.transaction('library', 'readwrite');
              tx.objectStore('library').put(completedResult.updatedLibrary);
              await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
              });
              console.log('Updated library record saved to IndexedDB from post-processing');
            } catch (libErr) {
              console.warn('Failed to update library in IndexedDB (non-fatal):', libErr);
            }
          }

          // Data is already in PostgreSQL from the background job.
          // Skip loadFromJSONFiles (downloads entire JSON via HTTP — too large for big books).
          // The reader's normal chunked loading (database-to-indexeddb API) will handle it.
          console.log('Background import complete — reader will load from database');

          if (progressUI) {
            progressUI.update(100, 'Import complete! Opening book...', '');
          }

          this.clearFormData();

          await this.execute({
            bookId: result.bookId,
            shouldEnterEditMode: true
          });
          console.log('Import transition complete');

          // Show conversion feedback toast if stats are available
          const stats = completedResult?.conversionStats;
          if (stats) {
            showConversionFeedbackToast({
              bookId: result.bookId,
              stats,
              footnoteAudit: completedResult?.footnoteAudit,
            });
          }

          return completedResult;

        } catch (pollError) {
          console.error('Import polling failed:', pollError);
          // Restore the form so the user can see the container and try again
          if (progressUI) {
            progressUI.restoreForm();
          }
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Submit';
          }
          throw pollError;
        }
      }

      // Synchronous completion (no-file imports, etc.)
      if (!result.bookId) {
        throw new Error('No bookId returned from backend');
      }

      // Check for footnote audit issues before proceeding
      if (result.hasFootnoteIssues && result.footnoteAudit) {
        const userChoice = await this.showFootnoteAuditModal(result.footnoteAudit, result.bookId);

        if (userChoice === 'resubmit') {
          await this.deleteImportedBook(result.bookId);

          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Submit';
          }
          return null;
        }
      }

      // Pre-load the book's content into IndexedDB
      try {
        await loadFromJSONFiles(result.bookId);
        console.log('Pre-loaded imported book content');
      } catch (e) {
        console.warn('Preloading JSON failed; continuing with reader fallback:', e);
      }

      this.clearFormData();

      await this.execute({
        bookId: result.bookId,
        shouldEnterEditMode: true
      });

      if (result.conversionStats) {
        showConversionFeedbackToast({
          bookId: result.bookId,
          stats: result.conversionStats,
          footnoteAudit: result.footnoteAudit,
        });
      }

      return result;

    } catch (error) {
      console.error('Import failed:', error);

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

  /**
   * Show footnote audit modal when issues are detected
   * @param {object} audit - footnote audit data
   * @param {string} bookId
   * @param {object} [options]
   * @param {'import'|'reconvert'} [options.mode='import'] - 'reconvert' shows a single OK button
   * @returns {Promise<'proceed'|'resubmit'>}
   */
  static showFootnoteAuditModal(audit, bookId, options = {}) {
    const mode = options.mode || 'import';
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'custom-alert-overlay';

      const alertBox = document.createElement('div');
      alertBox.className = 'custom-alert';
      alertBox.style.width = '580px';
      alertBox.style.maxHeight = '80vh';
      alertBox.style.overflowY = 'auto';

      const issueCount = (audit.gaps?.length || 0) +
        (audit.unmatched_refs?.length || 0) +
        (audit.unmatched_defs?.length || 0) +
        (audit.duplicates?.length || 0);

      let detailsHtml = '';

      if (audit.gaps?.length) {
        detailsHtml += `<div style="margin-bottom:10px"><strong>Gaps (${audit.gaps.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
        for (const gap of audit.gaps.slice(0, 10)) {
          const afterHeading = gap.after_ref_heading ? ` in "${gap.after_ref_heading}"` : '';
          const beforeHeading = gap.before_ref_heading ? ` in "${gap.before_ref_heading}"` : '';
          const afterCtx = gap.after_ref_context ? `"${gap.after_ref_context.substring(0, 80)}..."` : '';
          const beforeCtx = gap.before_ref_context ? `"${gap.before_ref_context.substring(0, 80)}..."` : '';
          const crossSection = gap.after_ref_section_id && gap.before_ref_section_id && gap.after_ref_section_id !== gap.before_ref_section_id
            ? '<br><em style="color:#b58900">(likely cross-section — different chapters)</em>' : '';
          detailsHtml += `<li style="margin-bottom:8px">Missing [^${gap.missing}]:` +
            `<br>&nbsp;&nbsp;[^${gap.after_ref}]${afterHeading} — ${afterCtx}` +
            `<br>&nbsp;&nbsp;[^${gap.before_ref}]${beforeHeading} — ${beforeCtx}` +
            `${crossSection}</li>`;
        }
        if (audit.gaps.length > 10) detailsHtml += `<li>...and ${audit.gaps.length - 10} more</li>`;
        detailsHtml += '</ul></div>';
      }

      if (audit.duplicates?.length) {
        detailsHtml += `<div style="margin-bottom:10px"><strong>Duplicates (${audit.duplicates.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
        for (const dup of audit.duplicates.slice(0, 10)) {
          detailsHtml += `<li>[^${dup.number}] appears ${dup.count} times in section ${dup.section}</li>`;
        }
        if (audit.duplicates.length > 10) detailsHtml += `<li>...and ${audit.duplicates.length - 10} more</li>`;
        detailsHtml += '</ul></div>';
      }

      if (audit.unmatched_refs?.length) {
        detailsHtml += `<div style="margin-bottom:10px"><strong>Unmatched references (${audit.unmatched_refs.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
        for (const ref of audit.unmatched_refs.slice(0, 5)) {
          detailsHtml += `<li>[^${ref.number}] has no definition</li>`;
        }
        if (audit.unmatched_refs.length > 5) detailsHtml += `<li>...and ${audit.unmatched_refs.length - 5} more</li>`;
        detailsHtml += '</ul></div>';
      }

      if (audit.unmatched_defs?.length) {
        detailsHtml += `<div style="margin-bottom:10px"><strong>Unmatched definitions (${audit.unmatched_defs.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
        for (const def of audit.unmatched_defs.slice(0, 5)) {
          const numLabel = def.number ? `[^${def.number}]` : def.footnote_id;
          const secLabel = def.section ? ` (section ${def.section})` : '';
          const preview = def.definition_preview?.substring(0, 200) || '';
          detailsHtml += `<li>${numLabel}${secLabel}: ${preview}</li>`;
        }
        if (audit.unmatched_defs.length > 5) detailsHtml += `<li>...and ${audit.unmatched_defs.length - 5} more</li>`;
        detailsHtml += '</ul></div>';
      }

      alertBox.innerHTML = `
        <h3>Footnote Audit</h3>
        <p style="margin-bottom:8px">${audit.total_refs} references, ${audit.total_defs} definitions</p>
        <p style="margin-bottom:12px">Detected <strong>${issueCount} issue${issueCount !== 1 ? 's' : ''}</strong> in your document.</p>
        ${detailsHtml}
        <div class="alert-buttons" style="margin-top:16px">
          ${mode === 'reconvert'
            ? '<button class="alert-button primary" data-action="proceed">OK</button>'
            : `<button class="alert-button secondary" data-action="resubmit">Re-submit</button>
               <button class="alert-button primary" data-action="proceed">Proceed anyway</button>`
          }
        </div>
      `;

      const cleanup = (action) => {
        overlay.remove();
        alertBox.remove();
        resolve(action);
      };

      alertBox.addEventListener('click', (e) => {
        const action = e.target.dataset?.action;
        if (action === 'proceed' || action === 'resubmit') {
          cleanup(action);
        }
      });

      // Escape key dismisses as "proceed"
      const keyHandler = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', keyHandler);
          cleanup('proceed');
        }
      };
      document.addEventListener('keydown', keyHandler);

      document.body.appendChild(overlay);
      document.body.appendChild(alertBox);
    });
  }

  /**
   * Delete an imported book (for re-submit flow)
   */
  static async deleteImportedBook(bookId) {
    try {
      // Delete from IndexedDB
      const { deleteBookFromIndexedDB } = await import('../../indexedDB/index.js');
      await deleteBookFromIndexedDB(bookId);

      // Delete from server
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': csrfToken,
        },
        credentials: 'include',
      });

      console.log(`🗑️ ImportBookTransition: Deleted book ${bookId} for re-submit`);
    } catch (e) {
      console.warn('Failed to delete imported book for re-submit:', e);
    }
  }
}