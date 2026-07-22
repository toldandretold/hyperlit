/**
 * ghostLedger — the persistent, clickable surface for GHOSTED highlights
 * (underlying text deleted; see ./ghost). Rendered as a section AFTER the book
 * text — a sibling of `main.main-content` inside `.reader-content-wrapper`,
 * deliberately OUTSIDE the editable/observed content, so it never interacts
 * with the editor's MutationObserver, the save path, or positionCollector.
 *
 * Each entry shows the ghost's old highlightedText as ghost-styled highlighted
 * text + 👻; clicking opens the hyperlit container via openHighlightById's
 * direct-ID path (no mark exists in the DOM). Entries use `.ghost-ledger-mark`
 * with data-highlight-id — deliberately NOT `mark.HL_*` — so mark-group hover,
 * delete-unwrap sweeps and mark listeners never see them.
 *
 * Scheduling: scheduleGhostLedger(bookId) is called from the reader's lazy
 * loader initializers (fires on BOTH full page load and in-SPA book open). It
 * double-fires (short + long delay) because highlight hydration may land after
 * the loader exists; renders are idempotent and re-check the rendered book.
 */

import DOMPurify from 'dompurify';
import { verbose } from '../../utilities/logger';
import { openDatabase } from '../../indexedDB/core/connection';
import { getAuthContextSync, getAuthContext } from '../../utilities/auth/index';
import { getOwnedHighlightsForBook, type AuthIdentity } from './list';
import { partitionGhosts } from './ghost';

const LEDGER_ID = 'ghost-ledger';
const RENDER_DELAYS_MS = [2000, 8000];

let scheduledFor: string | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];

function renderedMainBookId(): string {
  return (document.querySelector('.main-content') as HTMLElement | null)?.id || '';
}

export function destroyGhostLedger(): void {
  document.getElementById(LEDGER_ID)?.remove();
}

/** Idempotent render: removes any existing ledger, rebuilds if ghosts exist. */
export async function renderGhostLedger(bookId: string): Promise<void> {
  // The book may have changed between scheduling and firing (SPA nav).
  if (!bookId || renderedMainBookId() !== bookId) {
    destroyGhostLedger();
    return;
  }
  const mainEl = document.querySelector('main.main-content') as HTMLElement | null;
  const wrapper = mainEl?.parentElement;
  if (!mainEl || !wrapper) return;

  try {
    const rawAuth = getAuthContextSync() || await getAuthContext();
    const auth: AuthIdentity = { user: rawAuth?.user ?? null, userId: rawAuth?.userId ?? null };
    const db = await openDatabase();
    const owned = await getOwnedHighlightsForBook(bookId, auth, db);
    const { ghosts } = await partitionGhosts(owned, db);

    destroyGhostLedger();
    if (ghosts.length === 0) return;

    const section = document.createElement('section');
    section.id = LEDGER_ID;
    section.setAttribute('aria-label', 'Ghosted highlights');
    const entries = ghosts.map((g) => {
      const text = DOMPurify.sanitize(String(g.highlightedText ?? ''), { ALLOWED_TAGS: [] }).trim() || '(empty highlight)';
      const id = DOMPurify.sanitize(g.hyperlight_id, { ALLOWED_TAGS: [] });
      return `<span class="ghost-ledger-mark" data-highlight-id="${id}" role="button" tabindex="-1">${text} 👻</span>`;
    }).join(' ');
    section.innerHTML = `
      <h2 class="ghost-ledger-heading">👻 Ghosted highlights</h2>
      <p class="ghost-ledger-hint">These highlights lost their underlying text to later edits. Click one to open it.</p>
      <div class="ghost-ledger-items">${entries}</div>`;

    // Delegated click → open the highlight in the hyperlit container. The
    // ledger element is replaced wholesale on rebuild, so no listener cleanup
    // bookkeeping is needed.
    section.addEventListener('click', async (e: Event) => {
      const markEl = (e.target as HTMLElement).closest?.('.ghost-ledger-mark') as HTMLElement | null;
      const id = markEl?.getAttribute('data-highlight-id');
      if (!id) return;
      e.preventDefault();
      const { openHighlightById } = await import('../utils');
      void openHighlightById(id);
    });

    mainEl.insertAdjacentElement('afterend', section);
    verbose.content(`ghost ledger rendered: ${ghosts.length} ghost(s) for ${bookId}`, 'hyperlights/myHighlights/ghostLedger');
  } catch {
    // Ledger is an enhancement — a failure must never affect the reader.
  }
}

/**
 * Schedule ledger renders for a freshly-opened book. Cancels any previous
 * schedule; double-fires so late highlight hydration is still caught.
 */
export function scheduleGhostLedger(bookId: string): void {
  if (!bookId) return;
  if (scheduledFor === bookId && timers.length > 0) return;
  scheduledFor = bookId;
  timers.forEach(clearTimeout);
  timers = RENDER_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      const idle = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(() => void renderGhostLedger(bookId), { timeout: 3000 });
      else void renderGhostLedger(bookId);
    }, delay),
  );
}
