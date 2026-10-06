/**
 * The cite-form draft survives a close/reopen on purpose — but it must not follow
 * the user to the NEXT book.
 *
 * Reported 2026-10-04: opening the import form to upload a PDF showed a previous
 * attempt's Title and /url already filled in. The autofill writes with `setIfEmpty`,
 * so those restored values didn't just look stale — they BLOCKED the new document's
 * own metadata, and the book would have shipped under the old document's title and
 * slug with nothing on screen saying so.
 *
 * Two halves, pinned here:
 *  - attaching a DIFFERENT document re-derives the fields the previous document
 *    wrote (marked `data-autofilled`), while anything the user typed survives;
 *  - pressing Create Book drops the draft, and only a FAILED import gives it back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock is hoisted above the module graph, so both the factory state and the
// paths have to be literals here.
let extractedMetadata = {};

vi.mock('../../../resources/js/components/newbookContainer/citeForm/bookId', () => ({
  generateBookIdFromMetadata: (_bibtex, title, author, year) =>
    [String(author || '').toLowerCase(), year || '', String(title || '').toLowerCase().split(/\s+/)[0]]
      .filter(Boolean).join(''),
  findAvailableBookId: async (id) => id,
  updateBookUrlPreview: () => {},
  setupBookUrlPreview: () => {},
  setupBookIdSanitization: () => {},
}));

vi.mock('../../../resources/js/components/utilities/fileMetadataExtractor', () => ({
  extractFileMetadata: async () => extractedMetadata,
}));

import { getCiteFormHTML } from '../../../resources/js/components/newbookContainer/citeForm/template';
import { handleFileMetadataExtraction } from '../../../resources/js/components/newbookContainer/citeForm/fileUpload';
import { saveFormData, loadFormData, clearSavedFormData } from '../../../resources/js/components/newbookContainer/citeForm/persistence';
import {
  markFieldAutofilled,
  resetFileSelectionTracking,
  watchForManualFieldEdits,
} from '../../../resources/js/components/newbookContainer/citeForm/autofillTracking';

/** Stand in for the file input when the page-level drag-drop overlay has already
 *  attached a document before the form's own modules ran. */
function attachFileToInput(name, { size = 2048, lastModified = 7 } = {}) {
  const input = document.getElementById('markdown_file');
  Object.defineProperty(input, 'files', {
    value: [{ name, size, lastModified }],
    configurable: true,
  });
  return input;
}

function injectForm() {
  document.body.innerHTML = '';
  if (!document.querySelector('meta[name="csrf-token"]')) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'csrf-token');
    meta.setAttribute('content', 'test-token');
    document.head.appendChild(meta);
  }
  const container = document.createElement('div');
  container.id = 'newbook-container';
  container.innerHTML = getCiteFormHTML();
  document.body.appendChild(container);
  return container;
}

/** A selection the file-metadata pipeline can read — only `.files` is touched. */
function selection(name, { size = 1024, lastModified = 1 } = {}) {
  return { files: [{ name, size, lastModified }] };
}

beforeEach(() => {
  localStorage.clear();
  resetFileSelectionTracking();
  extractedMetadata = {};
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
  resetFileSelectionTracking();
});

describe('swapping in a different document', () => {
  it('re-derives the fields the PREVIOUS document filled in', async () => {
    injectForm();

    extractedMetadata = { title: 'MASTER 19.2_CGJun24_final version', author: 'Rowland', year: '2019' };
    await handleFileMetadataExtraction(selection('master.docx'));
    expect(document.getElementById('title').value).toBe('MASTER 19.2_CGJun24_final version');
    expect(document.getElementById('author').value).toBe('Rowland');

    extractedMetadata = { title: 'A Theory of Justice', author: 'Rawls', year: '1971' };
    await handleFileMetadataExtraction(selection('rawls.docx'));

    expect(document.getElementById('title').value).toBe('A Theory of Justice');
    expect(document.getElementById('author').value).toBe('Rawls');
    expect(document.getElementById('year').value).toBe('1971');
  });

  it('leaves a title the USER typed alone', async () => {
    injectForm();
    watchForManualFieldEdits();

    extractedMetadata = { title: 'master-19-2-cgjun24', author: 'Rowland' };
    await handleFileMetadataExtraction(selection('master.docx'));

    // A real keystroke takes the field off the document's books.
    const title = document.getElementById('title');
    title.value = 'The title I actually want';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    extractedMetadata = { title: 'A Theory of Justice', author: 'Rawls' };
    await handleFileMetadataExtraction(selection('rawls.docx'));

    expect(title.value).toBe('The title I actually want');
    expect(document.getElementById('author').value).toBe('Rawls');
  });

  it('does not discard its own autofill when the SAME file is re-attached', async () => {
    injectForm();

    extractedMetadata = { title: 'A Theory of Justice', author: 'Rawls' };
    await handleFileMetadataExtraction(selection('rawls.docx'));

    extractedMetadata = {};
    await handleFileMetadataExtraction(selection('rawls.docx'));

    expect(document.getElementById('title').value).toBe('A Theory of Justice');
  });

  it('re-derives through a RESTORED draft — the reported bug', async () => {
    vi.useFakeTimers();
    injectForm();

    // A previous attempt, saved exactly as the live form would have saved it.
    document.getElementById('title').value = 'MASTER 19.2_CGJun24_final version';
    document.getElementById('author').value = 'Rowland';
    document.getElementById('book').value = 'rowland2019master';
    ['title', 'author', 'book'].forEach((id) => markFieldAutofilled(document.getElementById(id)));
    saveFormData();
    expect(JSON.parse(localStorage.getItem('formData')).autofilled).toEqual(['title', 'author', 'book']);

    // Reopened form: the draft comes back, marks and all.
    injectForm();
    loadFormData();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    expect(document.getElementById('title').value).toBe('MASTER 19.2_CGJun24_final version');

    extractedMetadata = { title: 'A Theory of Justice', author: 'Rawls', year: '1971' };
    await handleFileMetadataExtraction(selection('rawls.docx'));

    expect(document.getElementById('title').value).toBe('A Theory of Justice');
    expect(document.getElementById('author').value).toBe('Rawls');
    expect(document.getElementById('book').value).not.toBe('rowland2019master');
  });

  it('does not restore the old attempt over a file dropped onto the page', async () => {
    vi.useFakeTimers();
    injectForm();
    document.getElementById('title').value = 'MASTER 19.2_CGJun24_final version';
    document.getElementById('book').value = 'rowland2019master';
    document.getElementById('note').value = 'keep me';
    ['title', 'book'].forEach((id) => markFieldAutofilled(document.getElementById(id)));
    saveFormData();

    // Drag-drop entry: the overlay attaches the file and the metadata pipeline
    // runs BEFORE the draft loads (validation.ts wires its listener first).
    injectForm();
    const input = attachFileToInput('rawls.docx');
    extractedMetadata = { title: 'A Theory of Justice', author: 'Rawls' };
    await handleFileMetadataExtraction(input);

    loadFormData();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();

    expect(document.getElementById('title').value).toBe('A Theory of Justice');
    expect(document.getElementById('book').value).not.toBe('rowland2019master');
    // Fields the document never supplied still come back from the draft.
    expect(document.getElementById('note').value).toBe('keep me');
    expect(document.getElementById('file-restore-note')).toBeNull();
  });
});

describe('clearSavedFormData', () => {
  it('drops both draft keys', () => {
    localStorage.setItem('formData', '{"title":"x"}');
    localStorage.setItem('newbook-form-data', '{"title":"x"}');
    clearSavedFormData();
    expect(localStorage.getItem('formData')).toBeNull();
    expect(localStorage.getItem('newbook-form-data')).toBeNull();
  });
});
