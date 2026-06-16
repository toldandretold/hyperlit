/**
 * Footnote content-type handler. priority 2. Build delegates to displayFootnotes;
 * postOpen lazy-loads the footnote sub-book and attaches the editor when editing;
 * permission is book-level.
 */
import type { ContentTypeHandler, BuildCtx, PostOpenCtx, PermissionCtx } from './types';
import { buildFootnoteContent } from '../contentBuilders/displayFootnotes';
import { getCurrentContainer } from '../stack';
import { containerState } from '../containerState';
import { book } from '../../app.js';
import { buildSubBookId } from '../../utilities/subBookIdHelper';
import { openDatabase } from '../../indexedDB/index';
import { canUserEditBook } from '../../utilities/auth/index';

export const footnoteHandler: ContentTypeHandler = {
  type: 'footnote',
  priority: 2,

  async buildContent(ct: any, ctx: BuildCtx): Promise<string> {
    return (await buildFootnoteContent(ct, ctx.db, ctx.editModeEnabled)) || '';
  },

  async checkPermission(_ct: any, _ctx: PermissionCtx): Promise<boolean> {
    // Footnotes use book-level permission.
    return await canUserEditBook(book);
  },

  async postOpen(ct: any, ctx: PostOpenCtx): Promise<void> {
    try {
      const footnoteId = ct.footnoteId;

      if (footnoteId) {
        // Resolve parent book ID: prefer contentType, then DOM walk, then global
        const parentBookId = ct.parentBookId
          || ct.element?.closest('[data-book-id]')?.dataset?.bookId
          || book;

        // Auto-load footnote content via lazy loader
        const scroller = getCurrentContainer()?.querySelector('.scroller');
        if (scroller) {
          // Skip IDB read for brand-new footnotes (record has empty content)
          let fnRecord: any = null;
          if (!ctx.isNewFootnote) {
            const database = ctx.db || await openDatabase();
            const tx = database.transaction('footnotes', 'readonly');
            const store = tx.objectStore('footnotes');
            fnRecord = await new Promise((resolve: any) => {
              const req = store.get([parentBookId, footnoteId]);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(null);
            });
            // DIAGNOSTIC — remove after debugging
            console.log(`🔍 FN LOOKUP: key=[${parentBookId}, ${footnoteId}], found=${!!fnRecord}, has_preview=${fnRecord?.preview_nodes?.length ?? 'null'}, content_len=${fnRecord?.content?.length ?? 'null'}`);
          }
          const subBookId = buildSubBookId(parentBookId, footnoteId);
          const footnotesSection = scroller.querySelector(`.footnotes-section[data-footnote-id="${footnoteId}"]`);
          const { loadSubBook }: any = await import('../subBookLoader.js');
          // Determine mode: 'create' for new footnotes, 'read' for existing
          const mode = ctx.isNewFootnote ? 'create' : 'read';
          console.log(`📂 Loading footnote "${subBookId}" in ${mode} mode (parent: ${parentBookId})`);
          // Await so we can attach the sub-book editor immediately after the first chunk renders
          const loader: any = await loadSubBook(subBookId, parentBookId, footnoteId, 'footnote', scroller, {
            annotationHtml: fnRecord?.content || '',
            previewNodes: fnRecord?.preview_nodes || null,
            targetElement: footnotesSection,
            mode,
          });

          // Mark footnote sub-book as user-editable
          const subBookEl = scroller.querySelector(`.sub-book-content[data-book-id="${subBookId}"]`);
          if (subBookEl) {
            subBookEl.setAttribute('data-user-can-edit', 'true');
            if (ctx.editModeEnabled) {
              subBookEl.contentEditable = 'true';
            }
          }

          // Swap divEditor onto the sub-book when edit mode is active (only if no editor attached yet)
          if (ctx.editModeEnabled && !ctx.subBookEditor.attached && loader) {
            if (subBookEl) {
              const { startObserving, isEditorObserving }: any = await import('../../divEditor/index');
              if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
              if (!containerState.previousIsEditing) containerState.previousIsEditing = (window as any).isEditing;
              if (!(window as any).isEditing) (window as any).isEditing = true;
              await startObserving(subBookEl, subBookId);
              if (!subBookEl.dataset.pasteAttached) {
                const { addPasteListener }: any = await import('../../paste/index.js');
                addPasteListener(subBookEl);
                subBookEl.dataset.pasteAttached = 'true';
              }
              ctx.subBookEditor.attached = true;
              console.log(`✏️ Sub-book editor activated for footnote: ${subBookId}`);
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
    } catch (error) {
      console.error('Error in footnote post-actions:', error);
    }
  },
};
