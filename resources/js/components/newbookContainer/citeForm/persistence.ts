// Cite-form draft persistence (localStorage key 'formData') + the Clear button.
// Was saveFormData / loadFormData / setupFormPersistence / setupClearButton of
// newBookForm.js. This is now the SINGLE draft system — the NewBookContainerManager's parallel
// 'newbook-form-data' system was merged away into here (the file-restore note + filename are
// carried over below; the old stale-`_token` restore was dropped as a latent bug).
import { $, qs, qsa } from './dom';
import { showFieldsForType } from './fields';
import { switchImportMode } from './modes';
import { updateBookUrlPreview } from './bookId';
import { hidePdfCostEstimate, hideInsufficientBalanceBanner } from './fileUpload';
import { setAllowedResubmitBookId } from './state';
import { getImportEncryptIntent } from '../encryptIntent';

export function saveFormData() {
  const selectedType = qs('input[name="type"]:checked');
  const formData = {
    bibtex: $('bibtex').value,
    author: $('author').value,
    title: $('title').value,
    journal: $('journal').value,
    publisher: $('publisher').value,
    year: $('year').value,
    pages: $('pages').value,
    book: $('book').value,
    url: $('url').value,
    school: $('school').value,
    note: $('note').value,
    volume: $('volume')?.value || '',
    issue: $('issue')?.value || '',
    booktitle: $('booktitle')?.value || '',
    chapter: $('chapter')?.value || '',
    editor: $('editor')?.value || '',
    type: selectedType ? selectedType.value : '',
    import_mode: qs('input[name="import_mode"]:checked')?.value || 'search'
  };

  // File inputs can't be restored, but remember the filename so the user gets a "please
  // reselect" note on reload (carried over from the old container draft system).
  const fileInput = $('markdown_file');
  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    (formData as any).selectedFileName = fileInput.files[0].name;
  }

  localStorage.setItem('formData', JSON.stringify(formData));
}

export function loadFormData() {
  const savedData = localStorage.getItem('formData');
  if (savedData) {
    const formData = JSON.parse(savedData);

    // Restore import mode first
    if (formData.import_mode) {
      const modeRadio = qs(`input[name="import_mode"][value="${formData.import_mode}"]`);
      if (modeRadio) {
        modeRadio.checked = true;
        switchImportMode(formData.import_mode);
      }
    }

    Object.entries(formData).forEach(([key, value]) => {
      const element = $(key);
      if (element && value) {
        element.value = value;
      }
    });

    if (formData.type) {
      const radio = qs(`input[name="type"][value="${formData.type}"]`);
      if (radio) {
        radio.checked = true;
        showFieldsForType(formData.type);
      }
    }

    // A previously selected file can't be restored — show a note prompting reselection
    // (carried over from the old container draft system).
    if (formData.selectedFileName) {
      const fileInput = $('markdown_file');
      if (fileInput) {
        const existingNote = $('file-restore-note');
        if (existingNote) existingNote.remove();

        const fileNote = document.createElement('div');
        fileNote.id = 'file-restore-note';
        fileNote.style.fontSize = '12px';
        fileNote.style.color = '#EF8D34';
        fileNote.style.marginTop = '5px';
        fileNote.textContent = `Previously selected: ${formData.selectedFileName} (please reselect)`;
        fileInput.parentNode.insertBefore(fileNote, fileInput.nextSibling);
      }
    }

    // After restoring values, trigger validations so the user sees status immediately
    setTimeout(() => {
      try {
        const title = $('title');
        const fileInput = $('markdown_file');

        // Kick title validators (immediate UX feedback)
        if (title) {
          title.dispatchEvent(new Event('input', { bubbles: true }));
          title.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        // Kick citation validators (server check runs once on blur if value exists)
        // @ts-expect-error `citation` is undefined here — pre-existing bug, preserved verbatim
        if (citation) {
          // @ts-expect-error see above
          citation.dispatchEvent(new Event('input', { bubbles: true }));
          // @ts-expect-error see above
          citation.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        // Show file validation message (will indicate reselect if empty)
        if (fileInput) {
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {
        console.warn('Initial validation trigger failed', e);
      }
    }, 50);
  }
}

// Form persistence setup
export function setupFormPersistence() {
  const form = $('cite-form');
  if (form) {
    form.addEventListener('input', saveFormData);
  }
}

// Clear button handler
export function setupClearButton() {
  const clearButton = $('clearButton');
  if (clearButton) {
    clearButton.addEventListener('click', function(this: any, e: any) {
      e.preventDefault();
      const form = $('cite-form');
      if (!form) return;

      // Reset inputs
      form.reset();

      // form.reset() reverts the header's Encrypt switch to its render-time
      // default — re-sync it from the intent leaf (Clear wipes fields, not the
      // encrypt choice).
      const encryptToggle = $('importEncrypted');
      if (encryptToggle) encryptToggle.checked = getImportEncryptIntent();

      // Hide PDF cost estimate and balance banner
      hidePdfCostEstimate();
      hideInsufficientBalanceBanner();

      // Hide optional fields (labels and inputs)
      qsa('.optional-field').forEach((field: any) => {
        field.style.display = 'none';
      });

      // Clear validation messages (remove inline display so CSS classes can show later)
      qsa('.validation-message').forEach((msg: any) => {
        msg.textContent = '';
        msg.innerHTML = '';
        msg.className = 'validation-message';
        msg.style.removeProperty('display');
      });
      const summary = $('form-validation-summary');
      const list = $('validation-list');
      if (summary) summary.style.display = 'none';
      if (list) list.innerHTML = '';

      // Re-enable submit button
      const submitButton = $('createButton');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Create Book';
      }

      // Clear any persisted form data (both keys used across modules)
      localStorage.removeItem('formData');
      localStorage.removeItem('newbook-form-data');

      // Reset re-submit bypass so normal validation applies again
      setAllowedResubmitBookId(null);

      // Reset back to search mode
      const searchRadio = qs('input[name="import_mode"][value="search"]');
      if (searchRadio) {
        searchRadio.checked = true;
        switchImportMode('search');
      }

      // Reset URL preview
      updateBookUrlPreview('');
    }, { passive: false });
  }
}
