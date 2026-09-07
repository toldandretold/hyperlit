/**
 * Shared "upload these image files and insert them as new nodes" flow, used by
 * both the drag-and-drop module and the toolbar image button.
 *
 * Upload-then-insert: nothing enters the contenteditable until the server has
 * confirmed the bytes — a node must never point at a src the server doesn't
 * have. While uploads run, a fixed-position pill (outside the editable, so the
 * MutationObserver/save queue never see it) shows progress. Per-file failures
 * are collected and reported once; successful files still insert.
 */
import { uploadBookImage, isInsertableImageFile } from '../../utilities/bookImageUpload';
import { buildImageNode } from './buildImageNode';
import { insertBlockNodeAfter, insertBlockNodeBefore } from '../insertBlockNode';
import { queueNodeForSave, queueNodeForDeletion } from '../editorState';
import { log, verbose } from '../../utilities/logger';
import type { BookId } from '../../utilities/idHelpers';

/**
 * Make an inserted image node undoable. The undo system's 'format' entries
 * carry arbitrary undoFn/redoFn closures but require entry.elementId to
 * resolve in BOTH states — so the entry anchors on the NEIGHBOUR node (which
 * survives undo and redo), while the closures remove/re-insert the img and
 * persist through the editor's own queues. Dynamic import: the toolbar module
 * is already live in edit mode, and a static import here would drag the whole
 * toolbar into the drop path.
 */
async function recordImageInsertUndo(imgEl: HTMLElement, bookId: BookId): Promise<void> {
  try {
    const { getEditToolbar } = await import('../../editToolbar/index');
    const toolbar = getEditToolbar();
    if (!toolbar || !toolbar.undoManager) return;

    const prevSibling = imgEl.previousElementSibling as HTMLElement | null;
    const anchorEl = (prevSibling ?? imgEl.nextElementSibling) as HTMLElement | null;
    if (!anchorEl || !anchorEl.id) return; // no stable neighbour — skip undo wiring
    const anchorIsPrevious = anchorEl === prevSibling;

    const imgId = imgEl.id;
    const undoFn = (current: HTMLElement) => {
      const img = document.getElementById(imgId);
      if (img) {
        img.remove();
        queueNodeForDeletion(imgId, img as HTMLElement, bookId);
      }
      return current; // caret seats on the neighbour; its re-save is a no-op
    };
    const redoFn = (current: HTMLElement) => {
      if (!document.getElementById(imgId) && current.parentNode) {
        // Restore the original side of the anchor (after a previous-sibling
        // anchor, before a next-sibling anchor).
        current.parentNode.insertBefore(imgEl, anchorIsPrevious ? current.nextSibling : current);
        queueNodeForSave(imgId, 'add', bookId);
      }
      return current;
    };

    toolbar.undoManager.sealGroup(); // typed-text group ends before the insert entry
    toolbar.undoManager.recordFormat(anchorEl.id, undoFn, redoFn, bookId, 0);
    toolbar._updateUndoRedoButtons(bookId);
  } catch {
    // Toolbar not available (e.g. tests) — insert still works, just without undo.
  }
}

/** Multi-file cap — a drop of a whole folder shouldn't fan out unbounded uploads. */
export const MAX_FILES_PER_INSERT = 10;

const PILL_ID = 'image-upload-pill';

function showUploadPill(label: string): HTMLElement {
  let pill = document.getElementById(PILL_ID);
  if (!pill) {
    pill = document.createElement('div');
    pill.id = PILL_ID;
    pill.setAttribute('role', 'status');
    pill.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:80px', 'transform:translateX(-50%)',
      'z-index:10001', 'padding:0.5em 1em', 'border-radius:999px',
      'background:rgba(34,31,32,0.85)', 'color:#fff', 'font-size:0.85rem',
      'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(pill);
  }
  pill.textContent = label;
  return pill;
}

function hideUploadPill(): void {
  document.getElementById(PILL_ID)?.remove();
}

export interface InsertImageFilesResult {
  inserted: HTMLElement[];
  failed: string[];
  skipped: string[];
}

/**
 * Upload + insert a batch of files as new image nodes next to `anchorNode`.
 * `position: 'after'` chains each subsequent image after the previously
 * inserted one, so a multi-file batch keeps its order; `'before'` inserts the
 * first file before the anchor and chains the rest after it.
 */
export async function insertImageFiles(
  files: File[],
  anchorNode: HTMLElement,
  position: 'before' | 'after',
  bookId: BookId,
): Promise<InsertImageFilesResult> {
  const result: InsertImageFilesResult = { inserted: [], failed: [], skipped: [] };

  const usable = files.filter((file) => {
    if (isInsertableImageFile(file)) return true;
    result.skipped.push(file.name);
    return false;
  }).slice(0, MAX_FILES_PER_INSERT);
  if (files.length - result.skipped.length > usable.length) {
    log.user(`Image insert: capped at ${MAX_FILES_PER_INSERT} files`, 'divEditor/insertImageFiles');
  }
  if (!usable.length) return result;

  let anchor = anchorNode;
  let insertPosition = position;
  let index = 0;
  for (const file of usable) {
    index += 1;
    showUploadPill(usable.length > 1 ? `Uploading image ${index}/${usable.length}…` : 'Uploading image…');
    try {
      const upload = await uploadBookImage(bookId, file);
      const img = buildImageNode(upload, {
        encrypted: upload.encrypted,
        previewBlobUrl: upload.encrypted ? URL.createObjectURL(file) : undefined,
      });
      const inserted = insertPosition === 'before'
        ? insertBlockNodeBefore(anchor, img, bookId)
        : insertBlockNodeAfter(anchor, img, bookId);
      if (!inserted) {
        result.failed.push(file.name);
        continue;
      }
      result.inserted.push(inserted);
      await recordImageInsertUndo(inserted, bookId);
      // Chain: the next file goes after the one just inserted.
      anchor = inserted;
      insertPosition = 'after';
    } catch (error) {
      result.failed.push(file.name);
      verbose.content(`Image upload failed for ${file.name}: ${String(error)}`, 'divEditor/insertImageFiles');
    }
  }
  hideUploadPill();

  if (result.failed.length) {
    const { alertDialog } = await import('../../components/dialog/dialog');
    void alertDialog({
      title: 'Image upload failed',
      message: `Could not insert: ${result.failed.join(', ')}`,
    });
  }

  return result;
}
