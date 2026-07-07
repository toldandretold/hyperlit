/**
 * Hyperlight (highlight/annotation) content-type handler. priority 5. The richest type:
 * timestamp + build + a large post-open (cursor placement, sub-book loading for every
 * annotation, brain-query polling/injection, the divEditor swap, delete/hide listeners)
 * + item-level (ownership) permission.
 */
import type { ContentTypeHandler, BuildCtx, PostOpenCtx, PermissionCtx } from './types';
import { buildHighlightContent } from '../contentBuilders/displayHyperlights';
import { getCurrentContainer } from '../stack';
import { containerState, registerListener } from '../containerState';
import { buildSubBookId } from '../../utilities/subBookIdHelper';
import { openDatabase } from '../../indexedDB/index';
import { getAuthContextSync, getAuthContext } from '../../utilities/auth/index';

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
              if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
              if (!containerState.previousIsEditing) containerState.previousIsEditing = (window as any).isEditing;
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
          const handler = async (e: any) => {
            const button = e.target.closest('.delete-highlight-btn');
            if (!button) return;

            const highlightId = button.getAttribute('data-highlight-id');
            const action = button.getAttribute('data-action'); // 'delete' or 'hide'

            if (action === 'hide') {
              // Book owner hiding someone else's highlight - sets hidden=true
              await hideHighlightById(highlightId);
            } else {
              // User deleting their own highlight - permanent removal
              await deleteHighlightById(highlightId);
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
