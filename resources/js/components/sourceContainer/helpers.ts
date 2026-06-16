// Shared leaf helpers for the source-container modules: tiny IDB getters,
// download-name sanitisation, synthetic-book detection, relative-time
// formatting, and the privacy-toggle SVG icons. Zero imports from sibling
// source-container modules (keeps the static graph acyclic).
import { openDatabase } from '../../indexedDB/index';

// SVG icons for privacy toggle
export const PUBLIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2ea44f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <line x1="2" y1="12" x2="22" y2="12"/>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
</svg>`;

export const PRIVATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg>`;

export function formatRelativeTime(isoString: any): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function getRecord(db: any, storeName: string, key: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getBookDownloadName(bookId: any, ext: string): Promise<string> {
  try {
    const db = await openDatabase();
    const record = await getRecord(db, 'library', bookId);
    const title = (record?.title || record?.book || bookId).trim();
    const author = (record?.author || record?.creator || '').trim();
    const sanitize = (s: string) => s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    const safeTitle = sanitize(title) || bookId;
    const safeAuthor = sanitize(author);
    return safeAuthor ? `${safeAuthor} - ${safeTitle}.${ext}` : `${safeTitle}.${ext}`;
  } catch (e) {
    return `book-${bookId}.${ext}`;
  }
}

/**
 * Synthetic book IDs that have no real library row on the server.
 * Skipping the fallback fetch for these avoids noisy 404s.
 */
export function isSyntheticBook(id: any): boolean {
  if (!id) return true;
  if (id === 'most-recent' || id === 'most-connected') return true;
  // Sorted variants like `username_public_title`, `username_all_connected`
  if (/_(public|private|all)_/.test(id)) return true;
  // User-home synthetics
  if (id.endsWith('All') || id.endsWith('Private') || id.endsWith('Account')) return true;
  return false;
}
