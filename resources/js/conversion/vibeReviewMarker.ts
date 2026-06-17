/* Per-book "I just ran a vibe review" marker (localStorage).
   Zero-import leaf so readerEntry can check it cheaply WITHOUT importing the heavy
   feedbackToast module, and both sides share one key string. The on-load Keep/Revert
   check (checkPendingVibeReview) is gated on this so we only poll the review endpoint
   after a vibe-convert was actually requested — not on every page load. */

const key = (book: string) => `vibeReviewPending:${book}`;

export function setVibeReviewMarker(book: string): void {
  try { localStorage.setItem(key(book), '1'); } catch { /* storage unavailable */ }
}

export function clearVibeReviewMarker(book: string): void {
  try { localStorage.removeItem(key(book)); } catch { /* storage unavailable */ }
}

export function hasVibeReviewMarker(book: string): boolean {
  try { return localStorage.getItem(key(book)) === '1'; } catch { return false; }
}
