// Book-id (/url slug) concerns for the cite-form: generate a slug from
// metadata, find an available one (server uniqueness probe), the #book →
// #book-url-preview live preview, and input sanitisation. Was the
// generateBookIdFromMetadata / findAvailableBookId / updateBookUrlPreview /
// setupBookUrlPreview / sanitizeBookIdValue / setupBookIdSanitization functions
// of newBookForm.js.
import { $ } from './dom';

export function generateBookIdFromMetadata(bibtex: any, title: any, author: any, year: any): string {
  // Priority 1: extract citation key from BibTeX (only if it looks human-readable)
  if (bibtex) {
    const keyMatch = bibtex.match(/@\w+\s*\{\s*([^,\s]+)\s*,/);
    if (keyMatch && keyMatch[1] && /^[a-zA-Z0-9_-]+$/.test(keyMatch[1]) && keyMatch[1].length >= 3
      && /[a-zA-Z]{2,}/.test(keyMatch[1])) {
      return keyMatch[1];
    }
  }

  const lastName = author ? author.split(/[,\s]+/)[0].replace(/[^a-zA-Z]/g, '').toLowerCase() : '';
  const firstTitleWord = title ? title.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';

  // Priority 2: author + year + title → lastNameYEARfirstWord
  if (lastName.length >= 2 && year && firstTitleWord) {
    return lastName + year + firstTitleWord;
  }

  // Priority 3: author + year (no title)
  if (lastName.length >= 2 && year) {
    return lastName + year;
  }

  // Priority 4: title + year (no author)
  if (firstTitleWord && year) {
    return firstTitleWord + year;
  }

  // Priority 5: just title → first three words
  if (title) {
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .slice(0, 3)
      .join('_');
    if (slug.length >= 3) return slug;
  }

  // Fallback
  return 'import_' + Date.now();
}

export async function findAvailableBookId(baseId: string): Promise<string> {
  const csrf = (document.querySelector('meta[name="csrf-token"]') as any)?.content;

  const tryCandidate = async (candidate: string) => {
    const resp = await fetch('/api/validate-book-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: JSON.stringify({ book: candidate })
    });
    const data = await resp.json();
    return data.success && !data.exists;
  };

  // Phase 1: baseId, then _v2 through _v5
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? baseId : `${baseId}_v${i + 1}`;
    try {
      if (await tryCandidate(candidate)) return candidate;
    } catch { break; }
  }

  // Phase 2: 3 attempts with random 4-digit suffix
  for (let i = 0; i < 3; i++) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${baseId}_${rand}`;
    try {
      if (await tryCandidate(candidate)) return candidate;
    } catch { break; }
  }

  // Ultimate fallback: timestamp (guaranteed unique)
  return `${baseId}_${Date.now()}`;
}

export function updateBookUrlPreview(value: any) {
  const preview = $('book-url-preview');
  if (preview) {
    preview.textContent = value || 'your-id';
  }
}

export function setupBookUrlPreview() {
  const bookField = $('book');
  if (!bookField) return;
  bookField.addEventListener('input', () => {
    updateBookUrlPreview(bookField.value.trim());
  });
}

export function sanitizeBookIdValue(value: string, full = false): string {
  let v = value.toLowerCase();
  if (full) {
    // Full cleanup: spaces → underscores, strip everything else
    v = v.replace(/\s+/g, '_');
  }
  // Strip any character not in [a-z0-9_-]
  v = v.replace(/[^a-z0-9_-]/g, '');
  return v;
}

export function setupBookIdSanitization() {
  const bookField = $('book');
  if (!bookField) return;

  bookField.addEventListener('paste', () => {
    // Defer to allow paste content to land in the field
    setTimeout(() => {
      const cleaned = sanitizeBookIdValue(bookField.value, true);
      if (cleaned !== bookField.value) {
        bookField.value = cleaned;
        updateBookUrlPreview(cleaned);
        bookField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 0);
  });

  bookField.addEventListener('blur', () => {
    const cleaned = sanitizeBookIdValue(bookField.value, true);
    if (cleaned !== bookField.value) {
      bookField.value = cleaned;
      updateBookUrlPreview(cleaned);
      bookField.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // On input: only strip clearly invalid chars (not spaces) to avoid fighting mid-keystroke
  bookField.addEventListener('input', () => {
    const cleaned = sanitizeBookIdValue(bookField.value, false);
    if (cleaned !== bookField.value) {
      const pos = bookField.selectionStart - (bookField.value.length - cleaned.length);
      bookField.value = cleaned;
      bookField.setSelectionRange(pos, pos);
    }
  });
}
