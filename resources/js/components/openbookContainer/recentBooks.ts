// Recents for the Open flyout: offline-available books (library record +
// nodes, synthetic feeds already filtered by the IDB helper), ordered by
// last-read (readingAnchor savedAt), falling back to the record's content
// timestamp. Rendering is DOM-API only — titles/authors are user data and
// must never hit innerHTML.
import { getAllOfflineAvailableBooks } from '../../indexedDB/index';
import type { LibraryRecord } from '../../indexedDB/types';
import { getSavedAnchor } from '../../scrolling/readingAnchor';

const RECENT_LIMIT = 15;

export async function loadRecentBooks(excludeBookId?: string): Promise<LibraryRecord[]> {
  const records = await getAllOfflineAvailableBooks();
  return records
    // The book currently on screen has no business in an "open a book" list.
    .filter((r) => !excludeBookId || String(r.book) !== excludeBookId)
    .map((r) => ({ r, at: getSavedAnchor(String(r.book))?.savedAt ?? r.timestamp ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT)
    .map((x) => x.r);
}

/** Title fallback chain: record.title → bibtex title field → 'Untitled'. */
function displayTitle(r: LibraryRecord): string {
  if (r.title && r.title !== 'Untitled') return r.title;
  const m = r.bibtex?.match(/title\s*=\s*[{"]([^}"]+)[}"]/i);
  return m?.[1]?.trim() || r.title || 'Untitled';
}

export function renderRecentList(
  listEl: HTMLElement,
  records: LibraryRecord[],
  onPick: (bookId: string) => void,
): void {
  listEl.textContent = '';
  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'openbook-empty';
    empty.textContent = 'No books cached on this device yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const r of records) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-row-btn openbook-recent-item';
    btn.dataset.bookId = String(r.book);
    const title = document.createElement('span');
    title.className = 'openbook-recent-title';
    title.textContent = displayTitle(r);
    btn.appendChild(title);
    if (r.author) {
      const author = document.createElement('span');
      author.className = 'openbook-recent-author';
      author.textContent = r.author;
      btn.appendChild(author);
    }
    btn.addEventListener('click', () => onPick(String(r.book)));
    listEl.appendChild(btn);
  }
}
