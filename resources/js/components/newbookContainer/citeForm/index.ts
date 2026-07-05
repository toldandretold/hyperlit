// Cite-form entry points (#cite-form). initializeCitationFormListeners wires the
// type radios + inline bibtex autofill and kicks off every concern sub-setup;
// setupFormSubmissionHandler is the back-compat alias. These are the two
// functions the NewBookContainerManager lazy-imports after injecting the form.
// (The original file's DOMContentLoaded auto-init is dropped — this module is
// only ever loaded lazily, after DOMContentLoaded has fired.)
import '../debugLog';
import { $, qs } from './dom';
import { showFieldsForType } from './fields';
import { populateFieldsFromBibtex, setupBibtexModeAutoReveal } from './bibtex';
import { setupFormSubmission } from './submission';
import { setupClearButton, setupFormPersistence, loadFormData } from './persistence';
import { setupRealTimeValidation } from './validation';
import { setupModeSwitching } from './modes';
import { setupImportSearch } from './search';
import { setupBookUrlPreview, setupBookIdSanitization } from './bookId';
import { setupSourceToggle } from './sourceToggle';
import { setupUrlImport } from './urlImport';
import { setupInlineDropzone } from './fileUpload';
import { setImportEncryptIntent } from '../encryptIntent';

// Main initialization function
export function initializeCitationFormListeners() {
  // Set up radio button listeners
  document.querySelectorAll('input[name="type"]').forEach((radio: any) => {
    radio.addEventListener('change', function(this: any) {
      showFieldsForType(this.value);
    });
  });

  // Set up BibTeX field listeners
  const bibtexField = $('bibtex');
  if (bibtexField) {
    // Helper to kick validators after programmatic autofill
    const triggerAutoValidation = () => {
      const bookField = $('book');
      const title = $('title');
      if (bookField) bookField.dispatchEvent(new Event('input', { bubbles: true }));
      if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
    };
    bibtexField.addEventListener('paste', function(this: any) {
      setTimeout(() => {
        const bibtexText = this.value;
        const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);

        if (typeMatch) {
          const bibType = typeMatch[1].toLowerCase();
          const radio = qs(`input[name="type"][value="${bibType}"]`);

          if (radio) {
            radio.checked = true;
            showFieldsForType(bibType);
          } else {
            const miscRadio = qs('input[name="type"][value="misc"]');
            if (miscRadio) {
              miscRadio.checked = true;
              showFieldsForType('misc');
            }
          }

          setTimeout(() => {
            populateFieldsFromBibtex();
            triggerAutoValidation();
          }, 50);
        }
      }, 0);
    });

    bibtexField.addEventListener('input', function(this: any) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const bibtexText = this.value;
        const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);

        if (typeMatch) {
          const bibType = typeMatch[1].toLowerCase();
          const radio = qs(`input[name="type"][value="${bibType}"]`);

          if (radio) {
            radio.checked = true;
            showFieldsForType(bibType);
            populateFieldsFromBibtex();
            triggerAutoValidation();
          }
        }
      }, 300);
    });
  }

  console.log("Citation form event listeners initialized");

  // ✅ CRITICAL FIX: Set up validation when form is dynamically created
  setupFormSubmission();
  setupClearButton();
  setupRealTimeValidation();
  setupFormPersistence();
  loadFormData();

  // ✅ NEW: Set up 3-mode interface
  setupModeSwitching();
  setupImportSearch();
  setupBookUrlPreview();
  setupBibtexModeAutoReveal();
  setupBookIdSanitization();

  // Top-level source toggle (URL vs file) + URL-import wiring.
  setupSourceToggle();
  setupUrlImport();

  // Inline dropzone (sits below the file input; reuses the file input's
  // change-event pipeline by feeding files into it via attachFilesToInput).
  setupInlineDropzone();

  // E2EE: the header's Encrypt switch writes straight to the intent leaf, so
  // flipping it here works even after a drag-and-drop entry — and the buttons
  // view re-syncs its checkbox from the same leaf when the form closes.
  $('importEncrypted')?.addEventListener('change', function (this: HTMLInputElement) {
    setImportEncryptIntent(this.checked);
  });
}

// Keep setupFormSubmissionHandler as alias for backward compatibility
export function setupFormSubmissionHandler() {
  setupFormSubmission();
}
