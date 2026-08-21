/**
 * Hyperlight (highlight/annotation) content-type handler. priority 5. The richest type:
 * timestamp + build + a large post-open (cursor placement, sub-book loading for every
 * annotation, brain-query polling/injection, the divEditor swap, delete/hide listeners)
 * + item-level (ownership) permission.
 */
import type { ContentTypeHandler, BuildCtx, PostOpenCtx, PermissionCtx } from './types';
import { buildHighlightContent } from '../contentBuilders/displayHyperlights';
import { getCurrentContainer, isStacked } from '../stack';
import { containerState, registerListener } from '../containerState';
import { buildSubBookId } from '../../utilities/subBookIdHelper';
import { openDatabase } from '../../indexedDB/index';
import { getAuthContextSync, getAuthContext } from '../../utilities/auth/index';
import { log } from '../../utilities/logger';

/**
 * Strip one highlight's rendered block from an open container.
 *
 * displayHyperlights emits a FLAT run of siblings per highlight with no wrapper element
 * (author row → blockquote → annotation target → br → separating hr), so the block is
 * "everything from this author row up to the next one".
 */
export function removeHighlightBlock(container: Element, highlightId: string): void {
  const start = container.querySelector<HTMLElement>(`[id="author-${highlightId}"]`);
  if (!start) return;

  const doomed: Element[] = [];
  let node: Element | null = start;
  while (node) {
    doomed.push(node);
    const next: Element | null = node.nextElementSibling;
    if (next && next.classList.contains('author')) break;
    node = next;
  }
  doomed.forEach((el) => el.remove());

  // Deleting the last highlight leaves the previous one's separator dangling.
  const scroller = container.querySelector('.scroller') ?? container;
  const tail = scroller.lastElementChild;
  if (tail && tail.tagName === 'HR') tail.remove();
}

/**
 * Retire the UI that was showing a highlight we just deleted.
 *
 * Without this the container keeps rendering the deleted highlight — which reads as a
 * freeze — and, in a stacked layer, the URL still names the sub-book that the delete just
 * destroyed, so a refresh lands on a sub-book that no longer exists. Popping the layer (or
 * closing the base container) is what restores the parent's URL; both paths already do
 * that cleanup, they were simply never invoked from the delete path.
 *
 * When the layer lists several overlapping highlights, only the deleted one's block goes —
 * the others are still live content and the URL still describes them correctly.
 */
export async function dismissDeletedHighlight(highlightId: string): Promise<void> {
  const container = getCurrentContainer();
  if (!container) return;

  if (container.querySelectorAll('.author[id^="author-"]').length > 1) {
    removeHighlightBlock(container, highlightId);
    return;
  }

  if (isStacked()) {
    const { popTopLayer }: any = await import('../stack');
    await popTopLayer();
  } else {
    // Dynamic: core ↔ contentTypes would otherwise close an import cycle.
    const { closeHyperlitContainer }: any = await import('../core.js');
    await closeHyperlitContainer();
  }
}

export const hyperlightHandler: ContentTypeHandler = {
  type: 'highlight',
  priority: 5,

  async fetchTimestamp(ct: any, db: any): Promise<number> {
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    if (ct.highlightIds && ct.highlightIds.length > 0) {
      const req = idx.get(ct.highlightIds[0]);
      const result: any = await new Promise((resolve: any) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (result && result.time_since) return result.time_since;
    }
    return 0;
  },

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildHighlightContent(ct, ctx.newHighlightIds, ctx.db, ctx.editModeEnabled)) || '';
  },

  async checkPermission(ct: any, ctx: PermissionCtx): Promise<boolean> {
    // If there are newly created highlights, user can edit those
    if (ctx.newHighlightIds && ctx.newHighlightIds.length > 0) {
      return true;
    }
    // 🚀 PERFORMANCE: Use cached ownership from buildHighlightContent when available
    if (ct.highlightOwnership) {
      for (const [, isOwner] of ct.highlightOwnership) {
        if (isOwner) return true;
      }
      return false;
    }
    // Cold path: no cache, read from IDB
    const database = ctx.db || await openDatabase();
    const tx = database.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    for (const id of ct.highlightIds) {
      const result: any = await new Promise((res: any) => {
        const req = idx.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });
      if (result) {
        const isUserHighlight = result.is_user_highlight === true
          || (ctx.currentUser && result.creator && (
               result.creator === ctx.currentUser.name     ||
               result.creator === ctx.currentUser.username  ||
               result.creator === ctx.currentUser.email
             ))
          || (!result.creator && result.creator_token === ctx.currentUserId);
        if (isUserHighlight) return true;
      }
    }
    return false;
  },

  async postOpen(ct: any, ctx: PostOpenCtx): Promise<void> {
    try {
      const { highlightIds } = ct;
      const auth = getAuthContextSync() || await getAuthContext();
      const { user: currentUser, userId: currentUserId } = auth;

      // 🚀 PERFORMANCE: Use cached records from buildHighlightContent when available
      let results: any;
      if (ct.cachedHighlightRecords) {
        results = ct.cachedHighlightRecords;
      } else {
        // Cold path: no cache, read from IDB
        const database = ctx.db || await openDatabase();
        const tx = database.transaction("hyperlights", "readonly");
        const store = tx.objectStore("hyperlights");
        const idx = store.index("hyperlight_id");

        const reads = highlightIds.map((id: any) =>
          new Promise((res: any, rej: any) => {
            const req = idx.get(id);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          })
        );

        results = await Promise.all(reads);
      }
      let firstUserAnnotation: any = null;

      // Find first editable highlight for cursor placement
      results.forEach((highlight: any) => {
        if (highlight) {
          // 🔒 SECURITY: Prefer server-calculated is_user_highlight (doesn't expose tokens)
          // Fall back to local comparison only for locally-created highlights not yet synced
          const isUserHighlight = highlight.is_user_highlight === true
            || (currentUser && highlight.creator && (
                 highlight.creator === currentUser.name     ||
                 highlight.creator === currentUser.username  ||
                 highlight.creator === currentUser.email
               ))
            || (!highlight.creator && highlight.creator_token === currentUserId);
          const isNewlyCreated = ctx.newHighlightIds.includes(highlight.hyperlight_id);
          const isEditable = isUserHighlight || isNewlyCreated;

          if (isEditable && !firstUserAnnotation) {
            firstUserAnnotation = highlight.hyperlight_id;
          }
        }
      });

      // Place cursor in first user annotation if available AND edit mode is enabled
      // Skip if skipAutoFocus is true (edit button handles focus separately)
      if (firstUserAnnotation && ctx.editModeEnabled && !ctx.skipAutoFocus) {
        setTimeout(() => {
          const annotationDiv = document.querySelector(
            `.annotation[data-highlight-id="${firstUserAnnotation}"]`
          );
          if (annotationDiv) {
            const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

            if (!isMobile) {
              (annotationDiv as HTMLElement).focus();
              setTimeout(() => {
                try {
                  const range = document.createRange();
                  const selection = window.getSelection();
                  range.selectNodeContents(annotationDiv);
                  range.collapse(false);
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                } catch (e) {
                  console.log('Range selection not supported');
                }
              }, 50);
            }
          }
        }, 150);
      }

      // Reuse highlightsWithNodes computed during buildHighlightContent (avoids duplicate IDB query)
      const highlightsWithNodes = ct.highlightsWithNodes || new Set();

      // Auto-load sub-book content for ALL highlights with annotations
      const scroller = getCurrentContainer()?.querySelector('.scroller');
      if (scroller) {
        const { loadSubBook }: any = await import('../subBookLoader.js');
        for (const highlight of results) {
          if (!highlight) continue;

          const isNewlyCreated = ctx.newHighlightIds.includes(highlight.hyperlight_id);

          // Reopening a brain highlight that hasn't completed yet — poll for result.
          // Must check BEFORE the skip condition below (no annotation/preview_nodes yet).
          // Skip when brainModeHighlightId is set — that's the initial open, not a reopen.
          const rawMeta = typeof highlight.raw_json === 'string'
              ? (() => { try { return JSON.parse(highlight.raw_json); } catch { return {}; } })()
              : (highlight.raw_json || {});
          if (rawMeta.brain_query === true && !highlight.sub_book_id
              && !highlight.preview_nodes && !highlightsWithNodes.has(highlight.hyperlight_id)
              && !(ctx.options.brainModeHighlightId && highlight.hyperlight_id === ctx.options.brainModeHighlightId)) {
            // Brain results are AI-generated, always read-only
            const { setHyperlitEditMode: setEditOff }: any = await import('../core.js');
            setEditOff(false);
            const { getEditToolbar: getToolbar }: any = await import('../../editToolbar/index');
            getToolbar()?.setEditMode(false);

            const { injectBrainPolling }: any = await import('../brainQuery.js');
            // Fire-and-forget: UI is injected synchronously, polling runs in background.
            // Do NOT await — the fetch can hang and block animateHyperlitContainerOpen().
            injectBrainPolling(highlight, scroller);
            continue;
          }

          // Skip highlights without annotations — no sub-book to load
          // (but allow newly created highlights through so we can create their sub-book)
          if (!highlight.annotation && !highlight.preview_nodes && !highlightsWithNodes.has(highlight.hyperlight_id) && !isNewlyCreated) continue;

          const isUserHighlight = highlight.is_user_highlight === true
            || (currentUser && highlight.creator && (
                 highlight.creator === currentUser.name     ||
                 highlight.creator === currentUser.username  ||
                 highlight.creator === currentUser.email
               ))
            || (!highlight.creator && highlight.creator_token === currentUserId);
          const isOwnerOrNew = isUserHighlight || isNewlyCreated;

          const subBookId = buildSubBookId(highlight.book, highlight.hyperlight_id);

          // Find the target container rendered by displayHyperlights.js
          const targetEl = scroller.querySelector(
            `.highlight-annotation[data-highlight-id="${highlight.hyperlight_id}"]`
          );

          // Brain mode: inject question input instead of loading sub-book
          if (ctx.options.brainModeHighlightId && highlight.hyperlight_id === ctx.options.brainModeHighlightId) {
            const { injectBrainInput }: any = await import('../brainQuery.js');
            await injectBrainInput(targetEl, highlight, scroller, ctx.options.selectionContext);
            continue;
          }

          // Determine if we need to attach the editor (only for user-owned highlights)
          const needsEditor = isOwnerOrNew && ctx.editModeEnabled && !ctx.subBookEditor.attached;

          const loaderOpts = {
            annotationHtml: highlight.annotation || '',
            previewNodes: highlight.preview_nodes || null,
            targetElement: targetEl || null,
            mode: isNewlyCreated ? 'create' : 'read',
            creator: highlight.creator || null,
          };

          const loader: any = await loadSubBook(subBookId, highlight.book, highlight.hyperlight_id, 'hyperlight', scroller, loaderOpts);

          // Mark user-owned sub-books and set contentEditable on all of them
          const subBookEl = scroller.querySelector(`.sub-book-content[data-book-id="${subBookId}"]`);
          if (subBookEl && isOwnerOrNew) {
            subBookEl.setAttribute('data-user-can-edit', 'true');
            if (ctx.editModeEnabled) {
              subBookEl.contentEditable = 'true';
            }
          }

          // Attach editor observer only to the first user-owned sub-book
          if (needsEditor && loader) {
            if (subBookEl) {
              const { startObserving, isEditorObserving }: any = await import('../../divEditor/index');
              // Capture the main-editor restore flags ONLY on a genuine first
              // attach. During an in-place content swap (arrow nav) the globals
              // are container-owned — window.isEditing is true BECAUSE of the
              // container's edit session — and capturing them here would make
              // the eventual close restore edit mode onto the MAIN book.
              if (!ctx.options?.isContentSwap) {
                if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
                if (!containerState.previousIsEditing) containerState.previousIsEditing = (window as any).isEditing;
              }
              if (!(window as any).isEditing) (window as any).isEditing = true;
              await startObserving(subBookEl, subBookId);
              if (!subBookEl.dataset.pasteAttached) {
                const { addPasteListener }: any = await import('../../paste/index');
                addPasteListener(subBookEl);
                subBookEl.dataset.pasteAttached = 'true';
              }
              ctx.subBookEditor.attached = true;
              console.log(`✏️ Sub-book editor activated for highlight: ${subBookId}`);
              const { getEditToolbar: getToolbar }: any = await import('../../editToolbar/index');
              getToolbar()?.setBookId(subBookId);
              getToolbar()?.setEditMode(true);

              const firstNode = subBookEl.querySelector('.chunk p, .chunk [id]');
              if (firstNode) {
                firstNode.focus({ preventScroll: true });
                const range = document.createRange();
                const sel = window.getSelection();
                range.setStart(firstNode, 0);
                range.collapse(true);
                sel?.removeAllRanges();
                sel?.addRange(range);
              }
            }
          }
        }
      }

      // Attach delete/hide button listeners using event delegation on container
      // This prevents listener accumulation - one listener handles all buttons
      setTimeout(async () => {
        const { deleteHighlightById, hideHighlightById }: any = await import('../../hyperlights/index');
        const container = getCurrentContainer();
        if (container) {
          const { confirmDialog, alertDialog }: any = await import('../../components/dialog/dialog');

          const handler = async (e: any) => {
            const button = e.target.closest('.delete-highlight-btn');
            if (!button) return;

            const highlightId = button.getAttribute('data-highlight-id');
            const action = button.getAttribute('data-action'); // 'delete' or 'hide'
            if (!highlightId || button.dataset.busy === 'true') return;

            // Confirm first: this is irreversible (a delete destroys the highlight's
            // sub-book and everything written in it) and the trash sits a thumb's width
            // from the Public/Private pill, so a mis-tap used to be unrecoverable.
            const confirmed = await confirmDialog({
              title: action === 'hide' ? 'Delete this highlight?' : 'Delete your highlight?',
              message: action === 'hide'
                ? 'It will be hidden for everyone, along with its annotation.'
                : 'The highlight and everything written under it go with it. This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!confirmed) return;

            button.dataset.busy = 'true';
            try {
              if (action === 'hide') {
                // Book owner hiding someone else's highlight - sets hidden=true
                await hideHighlightById(highlightId);
              } else {
                // User deleting their own highlight - permanent removal
                await deleteHighlightById(highlightId);
              }
              await dismissDeletedHighlight(highlightId);
            } catch (err) {
              button.dataset.busy = 'false';
              log.error('Highlight delete failed', '/hyperlitContainer/contentTypes/hyperlightHandler.ts', err as any);
              await alertDialog({
                title: "Couldn't delete that highlight",
                message: (err as Error)?.message ?? 'Unknown error',
              });
            }
          };
          registerListener(container, 'click', handler);
        }
      }, 200);

    } catch (error) {
      console.error('Error in highlight post-actions:', error);
    }
  },
};
