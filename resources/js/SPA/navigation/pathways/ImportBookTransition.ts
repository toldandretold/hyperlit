/**
 * ImportBookTransition - PATHWAY 3
 * Handles book imports from form submission to reader.blade.php
 * This pathway involves backend processing and full body replacement
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { log, verbose } from '../../../utilities/logger';
import { trapModalFocus } from '../../../utilities/modalFocusTrap';
import { registerNavActions } from '../navigationRegistry';
import { ProgressOverlayEnactor } from '../ProgressOverlayEnactor.js';
import { syncPageStylesheets, syncBodyAttributes } from '../utils/pageStylesheets';
import { waitForLayoutStabilization, waitForContentReady } from '../../domReadiness';
import { destroyUserContainer } from '../../../components/userButton/userButton';
import { destroyNewBookContainer } from '../../../components/newBookButton/newBookButton';
import { destroyHomepageDisplayUnit } from '../../../components/homepage/homepageDisplayUnit';
import { resetEditModeState, enforceEditableState, enableEditMode } from '../../../components/editButton/index';
import { cleanupReaderView } from '../../viewManager';
import { setCurrentBook } from '../../../app';
import { resolveFirstChunkPromise, loadFromJSONFiles } from '../../../pageLoad/index';
import { universalPageInitializer } from '../../viewManager';
import { initializeLogoNav } from '../../../components/logoNav/logoNav';
import { openDatabase, updateDatabaseBookId } from '../../../indexedDB/index';
import { showConversionFeedbackToast } from '../../../conversion/feedbackToast.js';
import { showImportFailureModal } from '../../../conversion/bugReportModal.js';
import type { BookId } from '../../../utilities/idHelpers';

export class ImportBookTransition {
  /**
   * Execute book import and transition
   */
  static async execute(options: any = {}) {
    const {
      bookId,
      progressCallback,
      shouldEnterEditMode = true
    } = options;

    verbose.nav('📥 ImportBookTransition: Starting import book transition', '/SPA/navigation/pathways/ImportBookTransition.ts', { bookId, shouldEnterEditMode } as any);

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

      // Update the URL now that the book id is known — BEFORE initializeImportedReader
      // hides the nav overlay (which is when the SPA transition is considered done).
      // Doing it later (after the up-to-10s content-ready wait + edit-mode entry) left
      // the URL stuck at the home root for the whole import window.
      this.updateUrl(bookId);

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
      
      // (URL was updated earlier, before initializeImportedReader hid the overlay.)

      // E2EE (docs/e2ee.md): "Encrypt after import" — the pipeline needed the
      // plaintext to convert; now lock the finished book (transition + full
      // pull + ciphertext re-push) and the server scrubs every plaintext
      // residue (plainText, embeddings, nodes_history, conversion artifacts).
      const encryptFlag = sessionStorage.getItem('pending_import_encrypt');
      if (encryptFlag && (encryptFlag === bookId || encryptFlag === '1')) {
        sessionStorage.removeItem('pending_import_encrypt');
        progress(96, 'Encrypting book…');
        try {
          const { lockBook } = await import('../../../e2ee/lifecycle');
          await lockBook(bookId);
          progress(99, 'Book encrypted.');
        } catch (lockError) {
          log.error('Auto-lock after import failed — book imported but NOT encrypted', '/SPA/navigation/pathways/ImportBookTransition.ts', lockError);
          const detail = lockError instanceof Error ? `\n\nDetails: ${lockError.name}: ${lockError.message}` : '';
          window.alert(`The book imported fine, but encrypting it failed — use the lock button in the book's source panel to retry.${detail}`);
        }
      }

      progress(100, 'Import complete!');

      verbose.nav('✅ ImportBookTransition: Import book transition complete', '/SPA/navigation/pathways/ImportBookTransition.ts');
      // NOTE: NavigationManager will hide the overlay when this returns

    } catch (error) {
      log.error('❌ ImportBookTransition: Transition failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', error);

      // Fallback to full page navigation
      const fallbackUrl = `/${bookId}/edit`;
      window.location.href = fallbackUrl;

      throw error;
    }
  }

  /**
   * Clean up any previous reader state
   */
  static async cleanupPreviousState() {
    try {
      // Import and destroy homepage-specific components
      if (destroyUserContainer) destroyUserContainer();
      if (destroyNewBookContainer) destroyNewBookContainer();

      if (destroyHomepageDisplayUnit) destroyHomepageDisplayUnit();

      // Also explicitly reset all edit mode state flags as a safeguard
      resetEditModeState();

      // Also clean up the reader view in case of an inconsistent state
      cleanupReaderView();
    } catch (error) {
      // Non-fatal: continue the transition
    }
  }

  /**
   * Fetch the reader page HTML for imported book
   */
  static async fetchReaderPageHtml(bookId: BookId) {
    console.log(`📥 ImportBookTransition: Fetching reader HTML for imported book ${bookId}`);
    
    const response = await fetch(`/${bookId}/edit`);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();

    return htmlString;
  }

  /**
   * Replace body content with reader HTML
   */
  static async replaceBodyContent(htmlString: any, bookId: BookId) {
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // 🎯 CRITICAL: Preserve the existing navigation overlay
    const existingOverlay = document.getElementById('initial-navigation-overlay');

    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
    }

    // Install reader page CSS before its body appears (home→reader switch)
    const removeStaleStylesheets = await syncPageStylesheets(newDoc);

    // Replace the entire body content
    document.body.innerHTML = newDoc.body.innerHTML;

    // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
    if (existingOverlay) {
      document.body.insertBefore(existingOverlay, document.body.firstChild);
    }

    // 🔥 CRITICAL: Rebind ProgressOverlayEnactor to the preserved element
    // After body replacement, ProgressOverlayEnactor's references are stale
    ProgressOverlayEnactor.rebind();
    
    // Sync all body attributes (exact — stale ones from the old template go)
    syncBodyAttributes(newDoc);

    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');

    // New page CSS is live and the old body is gone — drop the old page's sheets
    removeStaleStylesheets();

    // Update document title
    document.title = newDoc.title;
    
    // Reset contentEditable state after HTML replacement
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
    }

    // Enforce editable state
    try {
      enforceEditableState();
    } catch (error) {
      // Non-fatal
    }
  }

  /**
   * Set up session storage for imported book handling
   */
  static setupImportedBookSession(bookId: BookId) {
    // Set the session flag for overlay management
    sessionStorage.setItem('pending_import_book', bookId);

    // Mark this as imported content
    sessionStorage.setItem('imported_book_flag', bookId);
  }

  /**
   * Initialize the imported reader view
   */
  static async initializeImportedReader(bookId: BookId, progressCallback: any) {
    try {
      // Set the current book
      setCurrentBook(bookId);
      updateDatabaseBookId(bookId);

      // Hide overlay immediately for imported books
      const overlay = document.getElementById('initial-navigation-overlay');
      if (overlay) {
        overlay.style.display = 'none';
        overlay.style.visibility = 'hidden';
      }

      // Resolve the first chunk promise since content is already in DOM
      try {
        resolveFirstChunkPromise();
      } catch (error) {
        // Non-fatal
      }

      // Initialize the reader view using the existing system
      await universalPageInitializer(progressCallback);

      // 🔧 Reinitialize logo navigation toggle
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
      }

      // All UI rebinding is now handled by universalPageInitializer

    } catch (error) {
      log.error('❌ ImportBookTransition: Reader initialization failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', error);
      throw error;
    }
  }

  /**
   * Enter edit mode
   */
  static async enterEditMode() {
    try {
      await (enableEditMode as any)(null, false); // false = don't force redirect

    } catch (error) {
      log.error('❌ ImportBookTransition: Failed to enter edit mode:', '/SPA/navigation/pathways/ImportBookTransition.ts', error);
      // Don't throw - edit mode failure shouldn't break the entire transition
    }
  }

  /**
   * Update the browser URL
   */
  static updateUrl(bookId: any) {
    const newUrl = `/${bookId}/edit`;
    
    try {
      history.pushState({}, '', newUrl);
    } catch {
      // Non-fatal — URL update is best-effort
    }
  }

  // Stage labels for progress UI
  static STAGE_LABELS: any = {
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
  static createImportProgressUI(bookId: BookId) {
    const container = document.getElementById('newbook-container') as HTMLElement | null;
    const citeForm = container?.querySelector('#cite-form') as HTMLElement | null;
    const targetEl = (citeForm || container) as HTMLElement | null;

    if (!targetEl) {
      return null;
    }

    // Save original content and layout for potential restoration
    const savedHtml = targetEl.innerHTML;
    const scroller = container?.querySelector('.scroller') as HTMLElement | null;
    const savedScrollerPosition = scroller?.style.position;
    const savedScrollerHeight = scroller?.style.height;
    const savedContainerHeight = container?.style.height;

    // Once the scroller flips to position:relative (below), it stops covering the container
    // edge-to-edge and instead respects the container's 12px padding — which exposes a frame
    // of the container's glass background AND a second, radius-mismatched glass background on
    // the scroller, plus the absolutely-positioned .mask-top/.mask-bottom fade strips that were
    // sized to the full-bleed scroller. The result is a "box inside a box" double-edge. Drop the
    // padding, make the scroller transparent, and hide the masks so only ONE glass panel paints.
    const savedContainerPadding = container?.style.padding;
    const savedScrollerBackground = scroller?.style.background;
    // #cite-form (== targetEl) paints a SOLID opaque var(--color-background) with SQUARE
    // corners — vs the container's translucent rounded glass. Shrunk to the progress box it
    // becomes a sharp-cornered solid rectangle inside the rounded glass = the "cooked edge".
    const savedTargetBackground = targetEl.style.background;
    const maskTop = container?.querySelector('.mask-top') as HTMLElement | null;
    const maskBottom = container?.querySelector('.mask-bottom') as HTMLElement | null;
    const savedMaskTopDisplay = maskTop?.style.display;
    const savedMaskBottomDisplay = maskBottom?.style.display;

    // Switch scroller from absolute to relative so it contributes to flow height,
    // then let the container shrink-wrap the progress content
    if (scroller) {
      scroller.style.position = 'relative';
      scroller.style.height = 'auto';
    }
    if (container) {
      container.style.height = 'auto';
      container.style.transition = 'height 0.3s ease-out';
      container.style.padding = '0';
    }
    if (maskTop) maskTop.style.display = 'none';
    if (maskBottom) maskBottom.style.display = 'none';

    targetEl.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; max-width: 480px; margin: 0 auto;">
        <h3 style="margin: 0 0 24px; font-size: 18px; font-weight: 600; color: var(--color-text, #fff);">
          Importing document...
        </h3>
        <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.6); border-radius: 2px; overflow: hidden; margin-bottom: 16px;">
          <div id="import-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4EACAE, #EF8D34); border-radius: 2px; transition: width 0.4s ease;"></div>
        </div>
        <p id="import-stage-text" style="margin: 0 0 6px; font-size: 14px; color: var(--color-text, #ccc);">
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
    const notifyRow = document.getElementById('import-notify-row') as any;
    if (notifyBtn) {
      notifyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        notifyBtn.style.pointerEvents = 'none';
        notifyBtn.textContent = 'Requesting...';
        try {
          const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
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
      update(pct: any, msg: any, detail: any) {
        if (progressBar && pct != null) progressBar.style.width = `${Math.min(pct, 100)}%`;
        if (stageText && msg) stageText.textContent = msg;
        if (detailText) detailText.textContent = detail || '';
      },
      showError(msg: any) {
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
          scroller.style.background = savedScrollerBackground || '';
        }
        if (container) {
          container.style.height = savedContainerHeight || '';
          container.style.padding = savedContainerPadding || '';
        }
        if (maskTop) maskTop.style.display = savedMaskTopDisplay || '';
        if (maskBottom) maskBottom.style.display = savedMaskBottomDisplay || '';
        targetEl.style.background = savedTargetBackground || '';
      },
    };
  }

  /**
   * Poll import progress endpoint
   */
  static async pollImportProgress(bookId: any, progressUI: any) {
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
      } catch (err: any) {
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
   * Show the import-failure modal and, if the user clicks "Try again", re-run the
   * conversion for the same book via the reconvert endpoint. Loops so a failed retry
   * simply re-offers the modal (each attempt is a user click — no auto-retry storm).
   * Returns the completed import result when a retry succeeds, or null when the user
   * dismisses / reports instead (caller then rethrows the original error).
   */
  static async offerFailureRecovery(bookId: any, initialError: any): Promise<any> {
    let errorMessage = initialError?.message || String(initialError);

    for (;;) {
      let choice: any = null;
      try {
        choice = await showImportFailureModal({
          status: 'poll_failure',
          errorMessage,
          bookId,
          originalFile: null,
          source: 'poll_failure',
        });
      } catch (_) {
        return null; // modal failed to render — fall back to the thrown error
      }

      if (choice !== 'retry') return null; // dismissed / reported → stop recovering

      try {
        return await this.retryImportViaReconvert(bookId);
      } catch (retryErr: any) {
        // The retry failed too — loop back and re-show the modal with the new error
        // so the user can retry again or send a report.
        log.error('Import retry (reconvert) failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', retryErr);
        errorMessage = retryErr?.message || String(retryErr);
      }
    }
  }

  /**
   * Re-run the import for an existing book via POST /api/books/{book}/reconvert,
   * then poll to completion and open the book — the automated form of the manual
   * "re-submit with the same book id" fix. Reuses the OCR cache server-side, so it
   * does NOT re-charge the user. Reuses the same progress UI + poller as a fresh
   * import. Throws if the reconvert dispatch or the ensuing poll fails.
   */
  static async retryImportViaReconvert(bookId: any): Promise<any> {
    const progressUI = this.createImportProgressUI(bookId) || {
      update() {}, showError() {}, restoreForm() {},
    };
    progressUI.update(2, 'Retrying import…', '');

    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const resp = await fetch(`/api/books/${bookId}/reconvert`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrfToken },
      credentials: 'include',
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.message || `Retry failed — server returned ${resp.status}.`);
    }

    const completeData = await this.pollImportProgress(bookId, progressUI);
    const completedResult = completeData?.result || completeData;

    this.clearFormData();
    await this.execute({ bookId, shouldEnterEditMode: true });

    const stats = completedResult?.conversionStats;
    if (stats) {
      showConversionFeedbackToast({
        bookId,
        stats,
        footnoteAudit: completedResult?.footnoteAudit,
      });
    }

    return completedResult;
  }

  /**
   * On-device OCR inside the macOS shell: when the upload is a single PDF,
   * run the native engine (ocr.* bridge, Apple Vision/PDFKit) and append the
   * Mistral-shaped result as `ocr_response` — ImportController seeds it as the
   * conversion pipeline's OCR cache, so no Mistral call happens and nothing is
   * billed. No-op in a plain browser. If the engine fails, the user chooses
   * between server OCR (billed per page) and aborting the import.
   */
  static async attachNativeOcrIfAvailable(formData: any, submitButton: any) {
    // Leaf module, dynamically imported so non-shell visitors never fetch it.
    const { nativeOcrAvailable, nativePdfOcr } = await import('../../../utilities/nativeOcr');
    if (!nativeOcrAvailable()) return;

    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if ((key === 'markdown_file' || key === 'markdown_file[]') && value instanceof File) {
        files.push(value);
      }
    }
    const pdf = files.length === 1 ? files[0] : undefined;
    if (!pdf || !pdf.name.toLowerCase().endsWith('.pdf')) return;

    const originalText = submitButton ? submitButton.textContent : null;
    try {
      const result = await nativePdfOcr(pdf, (p) => {
        if (submitButton) {
          // totalPages is 0 while a BYO remote provider (user's Mistral key)
          // is in flight — no page counts there, just keepalive pulses.
          submitButton.textContent = p.totalPages > 0
            ? `OCR page ${p.page}/${p.totalPages}…`
            : 'OCR (your provider)…';
        }
      });
      formData.append('ocr_response', result.blob, 'ocr_response.json');
      formData.append('ocr_source', result.source === 'mistral' ? 'client_mistral' : 'client_native');
      if (submitButton && originalText) submitButton.textContent = originalText;
    } catch (e: any) {
      log.error('Native OCR failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', e);
      if (submitButton && originalText) submitButton.textContent = originalText;
      const proceed = window.confirm(
        `On-device OCR failed (${e?.message || 'unknown error'}).\n\n` +
        'Continue with server OCR instead? Server OCR is billed per page.'
      );
      if (!proceed) {
        const cancelled: any = new Error('Import cancelled after on-device OCR failure');
        cancelled.handledByImportFailureModal = true; // no second failure modal
        throw cancelled;
      }
      // Proceed with the plain upload — the server runs (billed) Mistral OCR.
    }
  }

  /**
   * Handle form submission and backend processing
   * This is the main entry point from newBookForm.js
   */
  static async handleFormSubmissionAndTransition(formData: any, submitButton: any) {
    // Hoisted so the outer catch can restore button layout regardless of
    // where in the try block the failure occurred.
    let restoreButtonLayout = () => {};

    try {
      // Get CSRF token
      const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;

      // Inside the macOS shell, OCR a single-PDF upload on-device first and
      // attach the result — the server seeds it as the pipeline's OCR cache
      // (no Mistral call, no charge). Falls back to server OCR on failure,
      // but only with the user's consent (server OCR is billed per page).
      await ImportBookTransition.attachNativeOcrIfAvailable(formData, submitButton);

      // Sum total bytes of File entries in the FormData so we can show an
      // accurate "X / Y MB" during upload (large PDFs can take 30s+ to upload
      // before the server even starts processing).
      let totalUploadBytes = 0;
      for (const [, value] of formData.entries()) {
        if (value && typeof value === 'object' && typeof value.size === 'number') {
          totalUploadBytes += value.size;
        }
      }
      const originalButtonText = submitButton ? submitButton.textContent : null;
      const totalMB = (totalUploadBytes / 1024 / 1024).toFixed(1);

      // Hide the Clear button and stretch the upload button to full width
      // so the live "Uploading X / Y MB" text is easier to read for big files.
      // Stash the prior styles so we can restore on failure.
      const clearButton = document.getElementById('clearButton');
      const stashedClearDisplay = clearButton ? clearButton.style.display : null;
      const stashedSubmitWidth = submitButton ? submitButton.style.width : null;
      const stashedSubmitFlex = submitButton ? submitButton.style.flex : null;
      if (clearButton) clearButton.style.display = 'none';
      if (submitButton) {
        submitButton.style.width = '100%';
        submitButton.style.flex = '1 1 100%';
      }
      restoreButtonLayout = () => {
        if (clearButton) clearButton.style.display = stashedClearDisplay || '';
        if (submitButton) {
          submitButton.style.width = stashedSubmitWidth || '';
          submitButton.style.flex = stashedSubmitFlex || '';
        }
      };

      // Submit via XHR (instead of fetch) to get upload-progress events.
      const response: any = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/import-file');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        if (csrfToken) xhr.setRequestHeader('X-CSRF-TOKEN', csrfToken);

        xhr.upload.addEventListener('progress', (e) => {
          if (!submitButton) return;
          if (e.lengthComputable && e.total > 0) {
            const pct = Math.round((e.loaded / e.total) * 100);
            const loadedMB = (e.loaded / 1024 / 1024).toFixed(1);
            submitButton.textContent = `Uploading ${pct}% (${loadedMB} / ${totalMB} MB)`;
          } else if (totalUploadBytes > 0) {
            submitButton.textContent = `Uploading ${totalMB} MB…`;
          }
        });

        xhr.upload.addEventListener('load', () => {
          if (submitButton) {
            submitButton.textContent = totalUploadBytes > 0
              ? `Upload complete (${totalMB} MB) — server processing…`
              : 'Server processing…';
          }
        });

        xhr.onload = () => {
          // Adapt the XHR response to a fetch-like shape so the rest of this
          // function (which was written for fetch) keeps working unchanged.
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            text: () => Promise.resolve(xhr.responseText || ''),
            json: () => Promise.resolve(JSON.parse(xhr.responseText || 'null')),
          });
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => reject(new Error('Upload aborted'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));

        xhr.send(formData);
      });

      if (!response.ok) {
        // Restore the button text + layout on failure so the next try doesn't
        // read "Server processing…" against a hidden Clear button.
        if (submitButton && originalButtonText) submitButton.textContent = originalButtonText;
        restoreButtonLayout();
        const errorText = await response.text();
        let errorDetails;
        let isProcessingError = false;

        try {
          const errorJson = JSON.parse(errorText);
          log.error('Server validation errors:', '/SPA/navigation/pathways/ImportBookTransition.ts', errorJson);

          if (errorJson.error && errorJson.error.includes('Failed to process file')) {
            isProcessingError = true;
            errorDetails = `File processing failed: ${errorJson.error}`;
          } else if (errorJson.errors) {
            const validationErrors = (Object.entries(errorJson.errors) as [string, any][])
              .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
              .join('\n');
            errorDetails = `Validation failed:\n${validationErrors}`;
          } else {
            errorDetails = errorJson.message || errorJson.error || errorText;
          }
        } catch (e) {
          log.error('Server error (not JSON):', '/SPA/navigation/pathways/ImportBookTransition.ts', errorText);
          errorDetails = errorText;
        }

        const error: any = new Error(`Server responded with ${response.status}: ${errorDetails}`);
        error.isProcessingError = isProcessingError;
        error.status = response.status;
        throw error;
      }

      const result = await response.json();

      if (!result.bookId) {
        throw new Error('No bookId returned from backend');
      }

      // Save the authoritative library record from server immediately
      if (result.library) {
        // Server record has no client-only base_timestamp; freeze it at the server version we're
        // adopting (mirror the pull path) so it isn't dropped → no false 409 on the next node edit.
        const serverLibrary = { ...result.library, base_timestamp: result.library.timestamp };
        const db = await openDatabase();
        const tx = db.transaction('library', 'readwrite');
        tx.objectStore('library').put(serverLibrary);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }

      // If status is 'processing', show progress UI and poll
      if (result.status === 'processing') {
        const progressUI = this.createImportProgressUI(result.bookId);

        try {
          const completeData = await this.pollImportProgress(result.bookId, progressUI || {
            update() {},
            showError() {},
            restoreForm() {},
          });

          // Footnote-audit issues are no longer gated by a blocking pre-scan modal:
          // the same audit rides into the conversion feedback toast below, whose
          // "✨ Try vibe fix" button is the proper way to repair footnotes now.
          const completedResult = completeData?.result || completeData;

          // Update IndexedDB library record with server-extracted metadata
          if (completedResult?.updatedLibrary) {
            try {
              const updatedLibrary = { ...completedResult.updatedLibrary, base_timestamp: completedResult.updatedLibrary.timestamp };
              const db = await openDatabase();
              const tx = db.transaction('library', 'readwrite');
              tx.objectStore('library').put(updatedLibrary);
              await new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
              });
            } catch (libErr) {
              // Non-fatal
            }
          }

          // Data is already in PostgreSQL from the background job.
          // Skip loadFromJSONFiles (downloads entire JSON via HTTP — too large for big books).
          // The reader's normal chunked loading (database-to-indexeddb API) will handle it.

          if (progressUI) {
            progressUI.update(100, 'Import complete! Opening book...', '');
          }

          this.clearFormData();

          await this.execute({
            bookId: result.bookId,
            shouldEnterEditMode: true
          });

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

        } catch (pollError: any) {
          log.error('Import polling failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', pollError);
          // Restore the form so the user can see the container and try again
          if (progressUI) {
            progressUI.restoreForm();
          }
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'Submit';
          }

          // Show the import-failure modal and, if the user clicks "Try again",
          // re-run the conversion for the same book. File is already on disk
          // server-side (the job ran), so no client-side re-upload is needed.
          const recovered = await this.offerFailureRecovery(result.bookId, pollError);
          if (recovered) return recovered; // a retry succeeded → book is open

          // Tag so the outer catch in newBookForm.js doesn't open a second modal.
          (pollError as any).handledByImportFailureModal = true;
          throw pollError;
        }
      }

      // Synchronous completion (no-file imports, etc.)
      if (!result.bookId) {
        throw new Error('No bookId returned from backend');
      }

      // (No blocking footnote-audit pre-scan — issues surface in the feedback toast
      // below, with "✨ Try vibe fix" as the repair path.)

      // Pre-load the book's content into IndexedDB
      try {
        await loadFromJSONFiles(result.bookId);
      } catch (e) {
        // Non-fatal: continue with reader fallback
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
      log.error('Import failed:', '/SPA/navigation/pathways/ImportBookTransition.ts', error);

      // Re-enable submit button + restore Clear button visibility on failure.
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
      }
      restoreButtonLayout();

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
    } catch (e) {
      // Non-fatal
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
  static showFootnoteAuditModal(audit: any, bookId: any, options: any = {}) {
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
        detailsHtml += `<div style="margin-bottom:10px"><strong>In-text footnotes <code>[^1]</code> with no definition (${audit.unmatched_refs.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
        for (const ref of audit.unmatched_refs.slice(0, 5)) {
          detailsHtml += `<li>[^${ref.number}] has no definition</li>`;
        }
        if (audit.unmatched_refs.length > 5) detailsHtml += `<li>...and ${audit.unmatched_refs.length - 5} more</li>`;
        detailsHtml += '</ul></div>';
      }

      if (audit.unmatched_defs?.length) {
        detailsHtml += `<div style="margin-bottom:10px"><strong>Footnote definitions <code>[1]:</code> with no in-text <code>[^1]</code> marker (${audit.unmatched_defs.length}):</strong><ul style="margin:4px 0;padding-left:20px;text-align:left;font-size:13px">`;
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
        <p style="margin-bottom:8px">${audit.total_refs} in-text footnotes <code>[^1]</code>, ${audit.total_defs} footnote definitions <code>[1]:</code></p>
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

      let releaseTrap: (() => void) | null = null;
      const cleanup = (action: any) => {
        releaseTrap?.(); // restores focus to the opener
        releaseTrap = null;
        overlay.remove();
        alertBox.remove();
        resolve(action);
      };

      alertBox.addEventListener('click', (e: any) => {
        const action = e.target.dataset?.action;
        if (action === 'proceed' || action === 'resubmit') {
          cleanup(action);
        }
      });

      document.body.appendChild(overlay);
      document.body.appendChild(alertBox);
      // Keyboard: trap Tab in the alert (overlay is a sibling — trap the box);
      // Escape dismisses as "proceed", matching the previous behavior.
      releaseTrap = trapModalFocus(alertBox, { onEscape: () => cleanup('proceed') });
    });
  }

  /**
   * Delete an imported book (for re-submit flow)
   */
  static async deleteImportedBook(bookId: any) {
    try {
      // Delete from IndexedDB
      const { deleteBookFromIndexedDB } = await import('../../../indexedDB/index');
      await deleteBookFromIndexedDB(bookId);

      // Delete from server
      const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
      await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': csrfToken,
        },
        credentials: 'include',
      });
    } catch (e) {
      // Non-fatal
    }
  }
}

// Register the import-progress + audit-modal entry points into the navigation leaf so
// reconvert can drive them without a dynamic reconvert→ImportBookTransition import.
registerNavActions({
  pollImportProgress: (bookId: any, progressUI: any) => ImportBookTransition.pollImportProgress(bookId, progressUI),
  showFootnoteAuditModal: (audit: any, bookId: any, options?: any) => ImportBookTransition.showFootnoteAuditModal(audit, bookId, options),
});
