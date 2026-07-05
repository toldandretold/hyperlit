/**
 * Locked-card title enhancer (docs/e2ee.md): server-rendered cards for
 * encrypted books carry a generic "[padlock] Encrypted book" label (the server only
 * has ciphertext). On the OWNER's device the plaintext title lives in the
 * local library store — swap it in. Fresh devices simply keep the generic
 * label until the book is first opened/unlocked.
 *
 * ButtonRegistry component (pages: home/user) — re-runs on every SPA entry.
 */

import { getConnection } from '../../indexedDB/core/connection';
import { verbose } from '../../utilities/logger';
import { encryptedLockSvg } from './lockIcon';

let enhanced = new WeakSet<Element>();

async function localTitle(bookId: string): Promise<string | null> {
  try {
    const db = await getConnection();
    return await new Promise((resolve) => {
      const req = db.transaction('library', 'readonly').objectStore('library').get(bookId);
      req.onsuccess = () => {
        const record = req.result as { title?: string | null; encrypted?: boolean } | undefined;
        // Only plaintext local titles (never render a stray envelope)
        const title = record?.title;
        resolve(title && !title.startsWith('hlenc.v1.') ? title : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export function initLockedCardTitles(): void {
  const cards = document.querySelectorAll('.libraryCard-encrypted');
  if (!cards.length) return;

  let swapped = 0;
  void Promise.all(
    Array.from(cards).map(async (card) => {
      if (enhanced.has(card)) return;
      const bookId = card.querySelector('a.book-actions')?.getAttribute('data-book');
      const citation = card.querySelector('.card-citation');
      if (!bookId || !citation) return;

      const title = await localTitle(bookId);
      if (title) {
        citation.innerHTML = encryptedLockSvg(14, 'vertical-align:-2px') + ' ';
        const em = document.createElement('em');
        em.textContent = title; // textContent — the title is user data
        citation.appendChild(em);
        swapped++;
      }
      enhanced.add(card);
    }),
  ).then(() => {
    if (swapped) verbose.content(`Swapped ${swapped} encrypted-card title(s) from local store`, 'e2ee/ui/lockedCardTitles');
  });
}

export function destroyLockedCardTitles(): void {
  enhanced = new WeakSet();
}
