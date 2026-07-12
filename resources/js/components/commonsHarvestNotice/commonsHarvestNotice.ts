// Reader-entry notice for COMMONS books: on opening an auto-harvested,
// owner-less text, show a one-time transient toast so the reader knows from the
// outset it was machine-converted (and can flag issues). Registered through
// ButtonRegistry (pages: ['reader']) so it survives SPA navigation. The
// persistent equivalent lives in the source panel's Librarian section.
import { book } from '../../app';
import { openDatabase } from '../../indexedDB/index';
import { getRecord, isSyntheticBook } from '../sourceContainer/helpers';
import { isCommonsBook } from '../sourceContainer/researchWorkflows';
import { showCommonsHarvestToast, hideCommonsHarvestToast } from '../sourceContainer/commonsFeedback';

/** The book's library record — IndexedDB first, then the server (mirrors buildSourceHtml). */
async function loadRecord(b: string): Promise<any> {
  try {
    const db = await openDatabase();
    let record = await getRecord(db, 'library', b);
    if (!record && !isSyntheticBook(b)) {
      const resp = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(b)}/library`, { credentials: 'include' });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.success && data.library) record = data.library;
      }
    }
    return record;
  } catch {
    return null;
  }
}

export async function initCommonsHarvestNotice(): Promise<void> {
  const b = String(book || '');
  if (!b || b.includes('/')) return; // no book / sub-book → skip

  // Show at most once per book per browser; the Librarian-section note stays.
  const key = `commonsNoticeSeen_${b}`;
  try {
    if (localStorage.getItem(key) === '1') return;
  } catch { /* private mode — just proceed */ }

  const record = await loadRecord(b);
  if (!isCommonsBook(record)) return;
  if (String(book || '') !== b) return; // navigated away during the async read

  try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
  showCommonsHarvestToast(b);
}

export function destroyCommonsHarvestNotice(): void {
  hideCommonsHarvestToast();
}
