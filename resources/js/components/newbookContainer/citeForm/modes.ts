// Import-mode tabs for the cite-form: search / bibtex / manual. Toggles the
// per-mode panels and resets shared search state on switch. Was
// setupModeSwitching / switchImportMode of newBookForm.js. searchState lives in
// ./state so search.ts and this module share it without a cycle.
import { $, qsa } from './dom';
import { searchState } from './state';

export function setupModeSwitching() {
  const modeRadios = qsa('input[name="import_mode"]');
  if (!modeRadios.length) return;

  modeRadios.forEach((radio: any) => {
    radio.addEventListener('change', () => switchImportMode(radio.value));
  });
}

export function switchImportMode(mode: string) {
  const searchPanel = $('import-mode-search');
  const bibtexPanel = $('import-mode-bibtex');
  const formFields = $('import-form-fields');
  const libraryNotice = $('library-match-notice');

  // Abort in-flight search + any pending external-ingest follow-up query
  if (searchState.abort) { searchState.abort.abort(); searchState.abort = null; }
  if (searchState.externalRetry) { clearTimeout(searchState.externalRetry); searchState.externalRetry = null; }

  // Hide library notice
  if (libraryNotice) libraryNotice.style.display = 'none';

  // Toggle panels
  if (searchPanel) searchPanel.style.display = mode === 'search' ? '' : 'none';
  if (bibtexPanel) bibtexPanel.style.display = mode === 'bibtex' ? '' : 'none';

  if (mode === 'manual') {
    // Show form fields immediately
    if (formFields) formFields.style.display = '';
  } else if (mode === 'search') {
    // Hide form fields until a result is selected
    if (formFields) formFields.style.display = 'none';
    // Clear search results + reset pagination
    searchState.offset = 0;
    searchState.query = '';
    const results = $('import-search-results');
    if (results) results.innerHTML = '';
    const input = $('import-search-input');
    if (input) { input.value = ''; input.focus(); }
  } else if (mode === 'bibtex') {
    // Hide form fields until bibtex is parsed
    if (formFields) formFields.style.display = 'none';
    const bibtex = $('bibtex');
    if (bibtex) bibtex.focus();
  }
}
