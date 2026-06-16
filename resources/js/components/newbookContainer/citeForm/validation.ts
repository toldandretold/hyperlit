// Real-time field validation for the cite-form: book-id (debounced server
// uniqueness probe), title, file, year, url — with per-field messages + the
// validation summary. Was setupRealTimeValidation() of newBookForm.js. Reads
// allowedResubmitBookId from ./state; file-change also drives metadata extract.
import { $, qs } from './dom';
import { getAllowedResubmitBookId } from './state';
import { hideInsufficientBalanceBanner, handleFileMetadataExtraction } from './fileUpload';
import { escapeHtml } from '../../../paste/utils/normalizer';

export function setupRealTimeValidation() {
  // Validation functions
  const validators: any = {
    validateBookId: async (value: any) => {
      if (!value) return { valid: true, message: 'Custom url key recommended' };
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) return { valid: false, message: 'Only letters, numbers, underscores, and hyphens allowed' };
      if (value.length < 3) return { valid: false, message: 'Book ID must be at least 3 characters' };

      // Re-submitting to same book ID after footnote audit — skip server check
      if (value === getAllowedResubmitBookId()) {
        return { valid: true, message: 'Re-submitting to same book ID' };
      }

      // Check database for existing book ID
      try {
        const response = await fetch('/api/validate-book-id', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content
          },
          body: JSON.stringify({ book: value })
        });

        let data;
        try {
          data = await response.json();
        } catch (parseErr) {
          console.warn('Citation ID check: non-JSON response', parseErr);
          // Non-blocking: do not show an error state here; enforce on submit
          return { valid: true, message: '' };
        }

        if (!data.success) {
          // Non-blocking warning; treat as neutral so UI isn't alarming
          return { valid: true, message: '' };
        }

        if (data.exists) {
          const linkHtml = `<a href="${data.book_url}" target="_blank" style="color: #EF8D34; text-decoration: underline;">View existing book</a>`;
          return {
            valid: false,
            message: `Citation ID "${value}" is already taken by "${data.book_title}". ${linkHtml}`,
            isHtml: true
          };
        }

        return { valid: true, message: 'Citation ID is available' };

      } catch (error) {
        console.warn('Citation ID validation error (non-blocking):', error);
        // Non-blocking: avoid showing an error; submit-time check will catch duplicates
        return { valid: true, message: '' };
      }
    },

    validateTitle: (value: any) => {
      if (value && value.length > 255) return { valid: false, message: 'Title must be less than 255 characters' };
      return { valid: true, message: '' };
    },

    validateFile: (fileInput: any) => {
      if (!fileInput.files || fileInput.files.length === 0) {
        return { valid: false, message: 'Please select a file to upload' };
      }

      const file = fileInput.files[0];
      const validExtensions = ['.md', '.epub', '.doc', '.docx', '.html', '.pdf'];
      const fileName = file.name.toLowerCase();
      const isValidType = validExtensions.some(ext => fileName.endsWith(ext));

      if (!isValidType) {
        const extList = validExtensions.join(', ');
        return { valid: false, message: `Please select a valid file (${extList})` };
      }

      if (file.size > 250 * 1024 * 1024) { // 250MB
        return { valid: false, message: 'File size must be less than 250MB' };
      }

      return { valid: true, message: 'Valid file selected' };
    },

    validateYear: (value: any) => {
      if (!value) return { valid: true, message: '' }; // Optional field
      const year = parseInt(value);
      const currentYear = new Date().getFullYear();
      if (year < 1000 || year > currentYear + 10) {
        return { valid: false, message: `Year must be between 1000 and ${currentYear + 10}` };
      }
      return { valid: true, message: 'Valid year' };
    },

    validateUrl: (value: any) => {
      if (!value) return { valid: true, message: '' }; // Optional field

      // Auto-format URL if it doesn't have a protocol
      let formattedUrl = value.trim();
      if (formattedUrl && !formattedUrl.match(/^https?:\/\//i)) {
        formattedUrl = `https://${formattedUrl}`;
      }

      try {
        new URL(formattedUrl);
        return { valid: true, message: 'Valid URL', formattedValue: formattedUrl };
      } catch (e) {
        return { valid: false, message: 'Please enter a valid URL (e.g., example.com or https://example.com)' };
      }
    }
  };

  // Show validation message
  const showValidationMessage = (elementId: string, result: any) => {
    const msgElement = $(`${elementId}-validation`);
    if (msgElement) {
      if (result.isHtml) {
        msgElement.innerHTML = result.message;
        // Prevent validation message links from closing the form
        const links = msgElement.querySelectorAll('a');
        links.forEach((link: any) => {
          link.addEventListener('click', (e: any) => {
            e.stopPropagation(); // Prevent event bubbling to overlay

            // Mark that we clicked an external link (for mobile handling)
            if ((window as any).newBookManager) {
              (window as any).newBookManager.recentExternalLinkClick = true;
              console.log('🔥 MOBILE: External link clicked - flagged to preserve form state');
            }
          });
        });
      } else {
        msgElement.textContent = result.message;
      }
      msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
    }
  };

  // Validate form and update messages (do not disable the submit button pre-emptively)
  const validateForm = async () => {
    const bookField = $('book');
    const title = $('title');
    const fileInput = $('markdown_file');
    const submitButton = $('createButton');

    if (!bookField || !title || !fileInput || !submitButton) return;

    // Do not disable the button here to avoid Safari double-tap issues
    // Avoid hitting the server here; handle citation ID via its own listeners
    const titleResult = validators.validateTitle(title.value);
    const fileResult = validators.validateFile(fileInput);

    const isFormValid = titleResult.valid && fileResult.valid;
    // Show individual field messages
    showValidationMessage('title', titleResult);
    showValidationMessage('file', fileResult);
    // Keep the submit button enabled; the submit handler will guard and show errors if needed
    submitButton.textContent = 'Create Book';

    // Update validation summary
    updateValidationSummary([
      { field: 'Title', result: titleResult }
    ]);

    return isFormValid;
  };

  // Update validation summary
  const updateValidationSummary = (validations: any[]) => {
    const summary = $('form-validation-summary');
    const list = $('validation-list');

    if (!summary || !list) return;

    const errors = validations.filter(v => !v.result.valid && v.result.message);

    if (errors.length > 0) {
      list.innerHTML = errors.map(e => `<li>${escapeHtml(e.field)}: ${escapeHtml(e.result.message)}</li>`).join('');
      summary.style.display = 'block';
    } else {
      summary.style.display = 'none';
    }
  };

  // Set up individual field validators
  const bookField = $('book');
  if (bookField) {
    let validationTimeout: any;

    bookField.addEventListener('input', function(this: any) {
      clearTimeout(validationTimeout);
      // Debounce the database check to avoid too many requests
      validationTimeout = setTimeout(async () => {
        const result = await validators.validateBookId(this.value);
        showValidationMessage('book', result);
        // Also refresh summary with current local field states
        const titleResult = validators.validateTitle($('title')?.value || '');
        updateValidationSummary([
          { field: 'Book ID', result },
          { field: 'Title', result: titleResult }
        ]);
      }, 500);
    });

    bookField.addEventListener('blur', async function(this: any) {
      clearTimeout(validationTimeout);
      const result = await validators.validateBookId(this.value);
      showValidationMessage('book', result);
      const titleResult = validators.validateTitle($('title')?.value || '');
      updateValidationSummary([
        { field: 'Citation ID', result },
        { field: 'Title', result: titleResult }
      ]);
    });
  }

  const titleField = $('title');
  if (titleField) {
    titleField.addEventListener('input', function(this: any) {
      const result = validators.validateTitle(this.value);
      showValidationMessage('title', result);
      setTimeout(validateForm, 100);
    });
    titleField.addEventListener('blur', function(this: any) {
      const result = validators.validateTitle(this.value);
      showValidationMessage('title', result);
      validateForm();
    });
  }

  const fileField = $('markdown_file');
  if (fileField) {
    fileField.addEventListener('change', function(this: any) {
      hideInsufficientBalanceBanner();
      const result = validators.validateFile(this);
      // Pass field base id 'file' so showValidationMessage targets #file-validation
      showValidationMessage('file', result);
      validateForm();
      handleFileMetadataExtraction(this);
    });
    // If a file was pre-attached BEFORE this listener was wired (e.g. via
    // the page-level drag-drop overlay, which fires `change` on the input
    // ~100ms before initializeCitationFormListeners runs), fire the
    // validation + metadata-extraction pipeline now so autofill still happens.
    if (fileField.files && fileField.files.length > 0) {
      fileField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  const yearField = $('year');
  if (yearField) {
    yearField.addEventListener('input', function(this: any) {
      const result = validators.validateYear(this.value);
      if (result.message) {
        // Only show year validation if there's an actual message (error or success)
        const msgElement = qs('#year').parentNode.querySelector('.validation-message');
        if (!msgElement) {
          const newMsgElement = document.createElement('div');
          newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          newMsgElement.textContent = result.message;
          yearField.parentNode.appendChild(newMsgElement);
        } else {
          msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          msgElement.textContent = result.message;
        }
      }
    });
  }

  const urlField = $('url');
  if (urlField) {
    urlField.addEventListener('blur', function(this: any) {
      const result = validators.validateUrl(this.value);

      // Auto-format the URL in the input field if validation succeeded
      if (result.valid && result.formattedValue && result.formattedValue !== this.value) {
        this.value = result.formattedValue;
      }

      if (result.message) {
        // Only show URL validation if there's an actual message (error or success)
        const msgElement = qs('#url').parentNode.querySelector('.validation-message');
        if (!msgElement) {
          const newMsgElement = document.createElement('div');
          newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          newMsgElement.textContent = result.message;
          urlField.parentNode.appendChild(newMsgElement);
        } else {
          msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          msgElement.textContent = result.message;
        }
      }
    });

    urlField.addEventListener('input', function(this: any) {
      const result = validators.validateUrl(this.value);
      if (result.message) {
        // Show validation during typing (but don't auto-format until blur)
        const msgElement = qs('#url').parentNode.querySelector('.validation-message');
        if (!msgElement) {
          const newMsgElement = document.createElement('div');
          newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          newMsgElement.textContent = result.message;
          urlField.parentNode.appendChild(newMsgElement);
        } else {
          msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
          msgElement.textContent = result.message;
        }
      }
    });
  }

  // Initial validation
  setTimeout(validateForm, 500);
}
