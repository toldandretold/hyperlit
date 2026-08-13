/**
 * Is the reader running as a GUEST inside someone else's document?
 *
 * The maintainer harnesses (/maintainer/conversion and /maintainer/journal-import) frame the real
 * reader beside the source it was converted from. That reader is the same code as the top-level
 * one, so it does what it always does on a container close: `history.back()`, to consume the entry
 * that opening the container pushed.
 *
 * Inside an iframe that is not a local operation. Session history is JOINT across the whole
 * browsing context, so an iframe's `history.back()` steps whatever entry happens to be last —
 * which on the maintainer pages is another frame's navigation. Observed live: closing a citation
 * in the reader pane stepped the READER frame back to `about:blank` (pane goes empty), or the
 * SOURCE frame back off its PDF (pane goes white), or the maintainer page itself, which is the
 * "the whole page gets cooked and I have to refresh" report.
 *
 * So when embedded, the container closes IN PLACE and never writes a history entry: no pushState
 * on open, no back() on close. The state is still recorded via replaceState, so restoration and
 * the stack's book-identity checks keep working — only the joint history is left alone.
 *
 * Deliberately a capability check on the window, not a page-name allowlist: any future host that
 * frames the reader gets the right behaviour without knowing about this file.
 */
export function isEmbeddedReader(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // A cross-origin ancestor throws on access — which itself means we are framed.
    return true;
  }
}
