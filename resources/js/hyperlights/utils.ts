/**
 * Utils module - Utility functions for hyperlights
 */

import { handleUnifiedContentClick } from '../hyperlitContainer/containerActions';
import { verbose } from '../utilities/logger';

/**
 * Generate a unique highlight ID
 * @returns Unique ID in format HL_{timestamp}
 */
export function generateHighlightID(): string {
    let hyperLightFlag = 'HL';
    let timestamp = Date.now();
    return `${hyperLightFlag}_${timestamp}`;
}

/**
 * Is this highlight POSITIVELY known to belong to a book other than the rendered one?
 *
 * Deliberately evidence-based rather than "does this book own it", because the two differ on the
 * case that matters: a highlight the store has never heard of. That is the normal state for a
 * freshly-followed deep link (the record arrives via fetch-on-demand during navigation), so
 * treating "not found" as "not ours" would refuse legitimate opens. Only a record found under a
 * DIFFERENT book is proof of a cross-book replay. Any failure answers "no evidence" and the open
 * proceeds exactly as before.
 */
async function highlightOwnedByAnotherBook(highlightId: string): Promise<boolean> {
  const renderedBook = document.querySelector('.main-content')?.id;
  if (!renderedBook) return false;
  try {
    const { openDatabase } = await import('../indexedDB/core/connection');
    const db = await openDatabase();
    return await new Promise<boolean>((resolve) => {
      try {
        const store = db.transaction('hyperlights', 'readonly').objectStore('hyperlights');
        if (!store.indexNames.contains('hyperlight_id')) return resolve(false);
        const req = store.index('hyperlight_id').getAll(highlightId);
        req.onsuccess = () => {
          const rows = req.result || [];
          // No record anywhere → no evidence. A record here → ours. Only elsewhere → foreign.
          resolve(rows.length > 0 && !rows.some((r: any) => r.book === renderedBook));
        };
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

/**
 * Open highlight by ID (legacy function - redirects to unified system)
 */
export async function openHighlightById(
  rawIds: string | string[],
  hasUserHighlight = false,
  newHighlightIds: string[] = []
): Promise<void> {
  // Redirect to unified system
  const highlightIds = Array.isArray(rawIds) ? rawIds : [rawIds];
  const element = document.querySelector(`mark.${highlightIds[0]}`) as HTMLElement | null;

  if (element) {
    console.log(`🎯 Found mark element for ${highlightIds[0]}, using element-based approach`);
    await handleUnifiedContentClick(element, highlightIds, newHighlightIds);
  } else {
    // No mark in the DOM. That is NORMAL for a highlight in an unloaded chunk of THIS book, and
    // it is also what a highlight belonging to ANOTHER book looks like — a stale id replayed
    // across a book change during rapid back/forward. The direct-ID path below cannot tell the
    // two apart, so it opened book A's annotation over book B's text and then stamped A's id
    // into B's URL (handleUnifiedContentClick builds the entry from the RENDERED book segment
    // plus the highlight hash). The resulting `/book_x/AIreview#HL_…` is a URL that can never
    // resolve: the next hash navigation toasts "Couldn't find 'HL_…' — showing start of book"
    // and throws the reader to the top, with a container open over text that has no mark in it.
    // Ownership is the discriminator the DOM can't give us — ask the store.
    if (await highlightOwnedByAnotherBook(highlightIds[0]!)) {
      verbose.nav(
        `Refusing to open highlight ${highlightIds[0]} — it belongs to another book, not the rendered `
        + `${document.querySelector('.main-content')?.id ?? 'unknown'} (stale cross-book replay)`,
        'hyperlights/utils.ts'
      );
      return;
    }
    console.log(`🎯 Mark element not found for ${highlightIds[0]}, using direct highlight ID approach`);
    // The mark isn't in the DOM yet (async chunk load / rapid nav). Use the direct-ID
    // path in handleUnifiedContentClick (element=null, directHyperciteId) — NOT a fake
    // element object, which lacks .closest and throws mid-navigation (freezing back/forward).
    await handleUnifiedContentClick(null, null, newHighlightIds, false, false, highlightIds[0]);
  }
}

/**
 * Helper function to handle placeholder behavior for annotation divs
 */
export function attachPlaceholderBehavior(highlightId: string): void {
  const annotationDiv = document.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  ) as HTMLElement | null;
  if (!annotationDiv) return;

  // Function to check if div is effectively empty
  const isEffectivelyEmpty = (div: HTMLElement) => {
    return !(div.textContent || '').trim();
  };

  // Function to update placeholder visibility
  const updatePlaceholder = () => {
    if (isEffectivelyEmpty(annotationDiv)) {
      annotationDiv.classList.add('empty-annotation');
    } else {
      annotationDiv.classList.remove('empty-annotation');
    }
  };

  // Initial check
  updatePlaceholder();

  // Update on input
  annotationDiv.addEventListener('input', updatePlaceholder);

  // Update on focus/blur for better UX
  annotationDiv.addEventListener('focus', updatePlaceholder);
  annotationDiv.addEventListener('blur', updatePlaceholder);
}
