// Form submission for the cite-form: the submit handler (auth gate, file +
// book-id validation/auto-fix, multipart build) + the Safari/mobile submit shim,
// and the hand-off to the ImportBookTransition pathway. Was setupFormSubmission
// / submitToLaravelAndLoad of newBookForm.js. (Dead saveToIndexedDBThenSync /
// syncToPostgreSQL dropped.)
import { $ } from './dom';
import { getAllowedResubmitBookId, setAllowedResubmitBookId } from './state';
import { validateFileInput, showInsufficientBalanceBanner } from './fileUpload';
import { updateBookUrlPreview } from './bookId';
import { isLoggedIn } from '../../../utilities/auth/index';
import { escapeHtml } from '../../../paste/utils/normalizer.js';
import { showImportFailureModal } from '../../../conversion/bugReportModal.js';

export function setupFormSubmission() {
  console.log("🔥 DEBUG: setupFormSubmission called");
  const form = $('cite-form');
  if (!form) {
    console.error("🔥 DEBUG: setupFormSubmission - form not found");
    return;
  }

  console.log("🔥 DEBUG: setupFormSubmission - form found:", form);

  // ✅ FIX: Check for existing handler more robustly
  if (form._hasSubmitHandler) {
    console.log("🔥 DEBUG: setupFormSubmission - handler already exists, skipping");
    return;
  }

  console.log("🔥 DEBUG: setupFormSubmission - adding new handler to form");
  form._hasSubmitHandler = true;

  const submitHandler = async function(this: any, event: any) {
    console.log("🔥 DEBUG: FORM SUBMIT TRIGGERED");
    event.preventDefault();
    event.stopPropagation();

    if (form._submitting) {
      console.log('⏳ Submit suppressed: already submitting');
      return false;
    }
    form._submitting = true;

    // Auth gate — unauthenticated users cannot import books
    const loggedIn = await isLoggedIn();
    if (!loggedIn) {
      const summary = $('form-validation-summary');
      const list = $('validation-list');
      if (summary && list) {
        list.innerHTML = `<li>You need to <a class="import-auth-link import-auth-login">log in</a> or <a class="import-auth-link import-auth-register">register</a> to import books.</li>`;
        summary.querySelector('h4').textContent = 'Authentication required';
        summary.style.display = 'block';

        summary.querySelector('.import-auth-login')?.addEventListener('click', async () => {
          (window as any).newBookManager?.closeContainer();
          const { initializeUserContainer } = await import('../../userButton/userButton');
          const mgr = initializeUserContainer();
          if (mgr) mgr.showLoginForm();
        });
        summary.querySelector('.import-auth-register')?.addEventListener('click', async () => {
          (window as any).newBookManager?.closeContainer();
          const { initializeUserContainer } = await import('../../userButton/userButton');
          const mgr = initializeUserContainer();
          if (mgr) mgr.showRegisterForm();
        });
      }
      form._submitting = false;
      return false;
    }

    // Force blur active element so any pending validation completes
    try { if (document.activeElement) (document.activeElement as any).blur(); } catch(_) {}

    // Quick file validation
    if (!validateFileInput()) {
      console.log("File validation failed");
      return false;
    }

    // Title + Citation ID validation (block duplicates)
    const submitButton = this.querySelector('button[type="submit"]');
    const bookInput = this.querySelector('#book');
    const titleInput = this.querySelector('#title');

    const errors: any[] = [];

    // Title: default to "Untitled" if empty
    if (!titleInput || !titleInput.value || titleInput.value.trim().length === 0) {
      if (titleInput) titleInput.value = 'Untitled';
    }

    // Citation ID — auto-fix instead of blocking
    let idVal = bookInput?.value?.trim() || '';
    const randomSuffix = () => '_' + Math.random().toString(36).slice(2, 8);

    if (!idVal) {
      idVal = 'book_' + Date.now();
    } else {
      // Strip invalid characters
      idVal = idVal.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!idVal) idVal = 'book_' + Date.now();
    }
    // Ensure minimum length
    if (idVal.length < 3) idVal += randomSuffix();

    if (idVal !== getAllowedResubmitBookId()) {
      // Server availability check — append suffix if taken
      try {
        const resp = await fetch('/api/validate-book-id', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content
          },
          body: JSON.stringify({ book: idVal })
        });
        const data = await resp.json();
        if (data.success && data.exists) {
          idVal += randomSuffix();
        }
      } catch (e) {
        console.warn('Book ID check failed, proceeding with current value', e);
      }
    }

    // Update the input and preview with the final value
    if (bookInput) bookInput.value = idVal;
    updateBookUrlPreview(idVal);
    const bookValidationEl = $('book-validation');
    if (bookValidationEl) { bookValidationEl.textContent = ''; bookValidationEl.className = 'validation-message'; }

    // Update summary
    const summary = $('form-validation-summary');
    const list = $('validation-list');
    if (summary && list) {
      if (errors.length > 0) {
        list.innerHTML = errors.map(e => `<li>${escapeHtml(e.field)}: ${escapeHtml(e.message)}</li>`).join('');
        summary.style.display = 'block';
      } else {
        summary.style.display = 'none';
      }
    }

    if (errors.length > 0) {
      // Do not proceed
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Create Book';
      }
      return false;
    }

    // Passed validations — disable to avoid double submission
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Processing...';
    }

    try {
      // Manual FormData construction for robustness
      const form = this;
      const formData = new FormData();

      // Append all other form fields
      new FormData(form).forEach((value, key) => {
        if (key !== 'markdown_file' && key !== 'markdown_file[]') {
          formData.append(key, value);
        }
      });

      // Explicitly append the file(s)
      const fileInput = form.querySelector('#markdown_file');
      if (fileInput && fileInput.files.length > 0) {
        // Handle multiple files (folder upload) or single file
        for (let i = 0; i < fileInput.files.length; i++) {
          formData.append('markdown_file[]', fileInput.files[i]);
        }
      }

      await submitToLaravelAndLoad(formData, submitButton);
    } finally {
      // If navigation did not occur, allow another try
      form._submitting = false;
    }
  };

  form.addEventListener('submit', submitHandler);
  // Store handler reference for potential cleanup
  form._submitHandler = submitHandler;

  // ✅ DEBUG: Test if the submit button is working + Safari single-tap submit shim
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    console.log("🔥 DEBUG: Found submit button:", submitButton);

    const ensureSubmit = (e: any) => {
      // Mark that shim handled this tap to suppress the next click
      form._shimSubmitted = true;
      setTimeout(() => { form._shimSubmitted = false; }, 600);

      // Prevent the following synthetic click; we will submit programmatically
      e.preventDefault();
      e.stopPropagation();
      try {
        if (document.activeElement && document.activeElement !== submitButton) {
          (document.activeElement as any).blur();
        }
      } catch (_) {}
      // Defer slightly to allow blur handlers/validation to settle
      setTimeout(() => {
        // Guard: if form already disabled button (in-flight), skip
        if (submitButton.disabled) return;
        // Programmatic submit triggers our submit handler
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(submitButton);
        } else {
          form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }, 0);
    };

    // Use pointerup/touchend to capture the first tap on Safari and avoid double-tap
    try {
      submitButton.addEventListener('pointerup', ensureSubmit, { passive: false });
      submitButton.addEventListener('touchend', ensureSubmit, { passive: false });
    } catch (_) {
      submitButton.addEventListener('touchend', ensureSubmit);
    }

    // Suppress immediate native click after shim to avoid double submission in Chrome
    submitButton.addEventListener('click', function(this: any, e: any) {
      if (form._shimSubmitted) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      console.log("🔥 DEBUG: Submit button clicked!", e);
    });
  } else {
    console.error("🔥 DEBUG: Submit button not found!");
  }
}

async function submitToLaravelAndLoad(formData: any, submitButton: any) {
  console.log("🔥 DEBUG: submitToLaravelAndLoad STARTED");
  console.log("Submitting to Laravel controller for file processing...");

  try {
    // Use the new ImportBookTransition pathway
    const { ImportBookTransition } = await import('../../../SPA/navigation/pathways/ImportBookTransition');

    const result = await ImportBookTransition.handleFormSubmissionAndTransition(formData, submitButton);
    if (!result) {
      // User chose re-submit from footnote audit — form already reset by ImportBookTransition.
      // Store the book ID so validators skip the "already taken" check on re-submit.
      const bookInput = $('book');
      setAllowedResubmitBookId(bookInput?.value?.trim() || null);
      return;
    }
    console.log(`🔥 DEBUG: ImportBookTransition completed for ${result.bookId}`);

  } catch (error: any) {
    console.error("❌ Import failed:", error);

    // Re-enable the button only on failure, since on success we navigate away.
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Submit";
    }

    // Build the modal context (used by 402 banner link OR direct modal open)
    const bookInput = $('book');
    const fileInput = $('markdown_file') || document.querySelector('input[type="file"][name="markdown_file"]');
    const originalFile = (fileInput as any)?.files?.[0] || null;
    const modalContext = {
      status: error.status != null ? String(error.status) : 'network',
      errorMessage: error.message || String(error),
      bookId: bookInput?.value?.trim() || null,
      originalFile,
      source: 'pre_conversion',
    };

    // Insufficient balance — show inline banner with embedded "Report it" link
    if (error.status === 402) {
      showInsufficientBalanceBanner(modalContext);
      return;
    }

    // Poll-failure modal already shown — don't double-fire
    if (error.handledByImportFailureModal) return;

    showImportFailureModal(modalContext);
  }
}
