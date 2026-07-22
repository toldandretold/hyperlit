/**
 * handlePostOpenActions — runs after the container's HTML is in the DOM. Shared setup
 * (note listeners + focus switcher) → per-type postOpen dispatch → shared teardown
 * (link listeners, private-book check, manage-citations button, edit button). Lives outside
 * index.ts so history.ts imports it here — breaking the index↔history cycle.
 */
import type { PostOpenCtx } from './contentTypes/types';
import { log } from '../utilities/logger';
import { getHandler } from './contentTypes/registry';
import { getHyperlitEditMode } from './core';
import { attachNoteListeners, initializePlaceholders } from './noteListener';
import { attachSubBookFocusSwitcher, buildEditButtonHtml, handleEditButtonClick } from './editMode';
import { attachDataContentIdLinkListeners, checkPrivateBookAccess } from './containerListeners';
import { registerListener } from './containerState';
import { getCurrentContainer } from './stack';

// Per-type post-open runs in this FIXED order (NOT priority order): the shared
// subBookEditor latch means whichever type attaches the divEditor first wins, and the
// historical behaviour is highlight-before-footnote. 'citation' resolves its "Open source"
// button's locked/enabled state post-open (visibility unknown at build for external books).
const POST_OPEN_ORDER = ['highlight', 'footnote', 'hypercite-citation', 'citation'];

export async function handlePostOpenActions(contentTypes: any, newHighlightIds: any = [], focusPreserver: any = null, isNewFootnote: any = false, hasAnyEditPermission: any = false, skipAutoFocus: any = false, db: any = null, options: any = {}) {
  const editModeEnabled = getHyperlitEditMode();

  // Only attach note listeners if edit mode is enabled (prevents editing in read mode)
  if (editModeEnabled) {
    attachNoteListeners();
    initializePlaceholders();
    attachSubBookFocusSwitcher();
  }

  // Shared, mutable across handlers: only the first user-owned sub-book gets the editor.
  const ctx: PostOpenCtx = {
    newHighlightIds, focusPreserver, skipAutoFocus, isNewFootnote, db,
    editModeEnabled, options, subBookEditor: { attached: false },
  };

  for (const type of POST_OPEN_ORDER) {
    const ct = contentTypes.find((c: any) => c.type === type);
    if (!ct) continue;
    const handler = getHandler(type);
    if (handler?.postOpen) await handler.postOpen(ct, ctx);
  }

  // Always attach listeners for management buttons and private book checks
  setTimeout(async () => {
    // Attach data-content-id link listeners for URL updates
    attachDataContentIdLinkListeners();

    // Skip private book checks for footnotes - already checked during content building
    const hasFootnoteOnly = contentTypes.length === 1 && contentTypes[0].type === 'footnote';
    if (!hasFootnoteOnly) {
      // Defer private book access checks to avoid blocking container opening
      if ((window as any).requestIdleCallback) {
        requestIdleCallback(() => checkPrivateBookAccess());
      } else {
        setTimeout(() => checkPrivateBookAccess(), 200);
      }
    }

    // Attach manage citations button listener using registerListener for cleanup
    const manageCitationsBtn = document.querySelector('.manage-citations-btn');
    if (manageCitationsBtn) {
      const { handleManageCitationsClick }: any = await import('./contentBuilders/displayHypercites');
      registerListener(manageCitationsBtn, 'click', handleManageCitationsClick);
    }

    // Insert edit button as direct child of container (NOT inside scroller)
    // to avoid iOS Safari compositing clip from -webkit-overflow-scrolling: touch
    if (hasAnyEditPermission && !options.brainModeHighlightId) {
      const container = getCurrentContainer();
      if (container) {
        const existing = container.querySelector('.hyperlit-edit-btn');
        if (existing) existing.remove();

        container.insertAdjacentHTML('beforeend', buildEditButtonHtml(editModeEnabled));
        const editBtn = container.querySelector('.hyperlit-edit-btn');
        if (editBtn) {
          registerListener(editBtn, 'click', (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            handleEditButtonClick();
          });
        }
      }
    }

    // Prev/next arrows over the user's OWN annotations — highlights AND <u>
    // cites (guards inside attachHighlightNavUI decide whether anything
    // renders). Dynamic import: highlightNav → containerSwap → postOpen must
    // stay out of the static graph.
    const navCt = contentTypes.find((c: any) => c.type === 'highlight')
      || contentTypes.find((c: any) => c.type === 'hypercite');
    if (navCt) {
      const navContainer = getCurrentContainer();
      if (navContainer) {
        try {
          const { attachHighlightNavUI } = await import('./highlightNav');
          await attachHighlightNavUI(navContainer, navCt, options);
        } catch (e) {
          // nav UI is an enhancement — a failure must never break the container,
          // but it must be VISIBLE (a silent catch hid a real import failure once).
          log.error('highlightNav attach failed', 'hyperlitContainer/postOpen.ts', e as any);
        }
      } else {
        try { (window as any).__hlNavDiag = 'postopen:no-container'; } catch { /* no-op */ }
      }
    } else {
      try { (window as any).__hlNavDiag = 'postopen:no-nav-ct'; } catch { /* no-op */ }
    }
  }, 100);
}
