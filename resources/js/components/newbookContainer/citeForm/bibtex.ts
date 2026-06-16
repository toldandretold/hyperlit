// BibTeX parse/autofill for the cite-form: regex-extract fields from the
// #bibtex textarea into the form inputs, plus the bibtex-mode auto-reveal that
// generates a /url once a title is parsed. Was populateFieldsFromBibtex /
// setupBibtexModeAutoReveal / checkBibtexAndReveal of newBookForm.js.
import { $, qs } from './dom';
import { generateBookIdFromMetadata, findAvailableBookId, updateBookUrlPreview } from './bookId';

export function populateFieldsFromBibtex() {
  const bibtexField = $('bibtex');
  if (!bibtexField) return;

  const bibtexText = bibtexField.value.trim();
  if (!bibtexText) return;

  const patterns: any = {
    id: /@\w+\s*\{\s*([^,]+)\s*,/,
    title: /title\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    author: /author\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    journal: /journal\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    year: /year\s*=\s*[\{"']?(\d+)[\}"']?/i,
    pages: /pages\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    publisher: /publisher\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    school: /school\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    note: /note\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    url: /url\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    volume: /volume\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    issue: /number\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    booktitle: /booktitle\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    chapter: /chapter\s*=\s*[\{"']([^}\"']+)[\}"']/i,
    editor: /editor\s*=\s*[\{"']([^}\"']+)[\}"']/i
  };

  let changed = false;
  Object.entries(patterns).forEach(([field, pattern]: [any, any]) => {
    const match = bibtexText.match(pattern);
    if (match) {
      const fieldName = field === 'id' ? 'book' : field;
      const element = $(fieldName);
      if (element) {
        let newVal = match[1].trim();

        // Auto-format URL if it's a URL field
        if (field === 'url' && newVal && !newVal.match(/^https?:\/\//i)) {
          newVal = `https://${newVal}`;
        }

        if (element.value !== newVal) {
          element.value = newVal;
          changed = true;
        }
      }
    }
  });

  // If fields were updated programmatically, trigger their validation listeners
  if (changed) {
    const bookField = $('book');
    const title = $('title');
    if (bookField) bookField.dispatchEvent(new Event('input', { bubbles: true }));
    if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function setupBibtexModeAutoReveal() {
  const bibtexField = $('bibtex');
  if (!bibtexField) return;

  // Watch for successful parse → auto-reveal form fields
  const observer = new MutationObserver(() => {});
  // Instead of MutationObserver, hook into the existing input/paste handlers
  // by checking if title got populated after bibtex change
  bibtexField.addEventListener('input', () => {
    clearTimeout(bibtexField._revealTimer);
    bibtexField._revealTimer = setTimeout(() => {
      checkBibtexAndReveal();
    }, 400);
  });
  bibtexField.addEventListener('paste', () => {
    setTimeout(() => checkBibtexAndReveal(), 100);
  });
}

export async function checkBibtexAndReveal() {
  const currentMode = qs('input[name="import_mode"]:checked')?.value;
  if (currentMode !== 'bibtex') return;

  const titleField = $('title');
  if (titleField && titleField.value.trim()) {
    // Title was populated — don't reveal #import-form-fields in bibtex mode;
    // detail fields stay hidden. The user sees file upload + /url + submit.

    // Auto-generate book ID if empty
    const bookField = $('book');
    if (bookField && !bookField.value) {
      const bibtex = $('bibtex')?.value || '';
      const title = titleField.value;
      const author = $('author')?.value || '';
      const year = $('year')?.value || '';
      const generatedId = generateBookIdFromMetadata(bibtex, title, author, year);
      if (generatedId) {
        const availableId = await findAvailableBookId(generatedId);
        bookField.value = availableId;
        updateBookUrlPreview(availableId);
        bookField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
}
