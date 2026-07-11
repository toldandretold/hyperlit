/**
 * nodeText — extract the plain visible text from a node's (possibly hostile) HTML.
 *
 * Zero-import leaf. `DOMParser` documents are INERT — no script execution, no
 * `<img onerror>`, no resource loads — unlike a detached div's `innerHTML` (the
 * stored-XSS vector noted in docs/security). We only ever want the words the user
 * wrote, so we take `textContent`, collapse runs of whitespace, and trim.
 *
 * Two callers rely on the SAME normalization so their outputs are comparable:
 *  - the stale-tab overlay preview (BroadcastListener.lostNodePreviewText), and
 *  - the lost-ACK self-conflict check (syncQueue/selfConflictContentCheck), which
 *    compares a local node's text against the server's current text to decide
 *    whether a 409 is our own already-committed write (see docs / plan).
 */
export function nodePlainText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}
