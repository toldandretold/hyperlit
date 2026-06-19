import { asBookId, LATEST, type BookId } from "../indexedDB/types";
/**
 * Delete-highlight module — removes the hyperlight(s) (and user content links,
 * in edit mode) that overlap the current selection, from the DOM and IndexedDB,
 * and queues the deletions for PG sync.
 *
 * Split out of the old selection.js monster (2026-06).
 */

import { queueForSync, updateBookTimestamp } from '../indexedDB/index';
import { removeHighlightFromHyperlights, removeHighlightFromNodeChunksWithDeletion } from './database';
import { unwrapMark, unwrapElement, isContentLink } from './deletion';
import { setProgrammaticUpdateInProgress } from '../utilities/operationState';
// queueNodeForSave loaded lazily (edit-only, below) so this read-mode highlight module doesn't
// statically pull the divEditor (editor) chunk into the eager bundle.

/**
 * Delete highlight(s) that overlap with selected text
 */
export async function deleteHighlightHandler(event: Event, bookId: BookId): Promise<void> {
  event.preventDefault();
  console.log("Delete button clicked.");

  let selection = window.getSelection()!;
  let selectedText = selection.toString();

  if (!selectedText) {
    console.error("No text selected to delete.");
    return;
  }

  const marks = document.querySelectorAll("mark");
  let highlightIdsToRemove: string[] = [];
  const affectedNodeChunks = new Set<string>();

  // Check if the selection intersects with existing highlights
  const selectionRange = selection.getRangeAt(0);

  // First pass: identify which highlight IDs to remove based on selection intersection
  marks.forEach((mark) => {
    let shouldRemove = false;

    try {
      const markRange = document.createRange();
      markRange.selectNodeContents(mark);

      // Check if ranges intersect
      const intersects = selectionRange.compareBoundaryPoints(Range.END_TO_START, markRange) <= 0 &&
                       markRange.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0;

      shouldRemove = intersects;
    } catch (e) {
      // Fallback to text-based comparison if range comparison fails
      shouldRemove = selectedText.indexOf((mark.textContent || '').trim()) !== -1 ||
                    (mark.textContent || '').trim().indexOf(selectedText) !== -1;
    }

    if (shouldRemove) {
      let highlightId = Array.from(mark.classList).find(
        (cls) => cls !== "highlight" && cls.startsWith("HL_")
      );

      if (highlightId && !highlightIdsToRemove.includes(highlightId)) {
        highlightIdsToRemove.push(highlightId);
        console.log("Removing highlight for:", highlightId);
      }
    }
  });

  // Find content links that intersect the selection (edit mode only)
  const linksToUnwrap: HTMLElement[] = [];
  if ((window as any).isEditing) {
    const anchorRoot = (selectionRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? selectionRange.commonAncestorContainer.parentElement
      : selectionRange.commonAncestorContainer) as HTMLElement | null;
    const linkSearchRoot = anchorRoot?.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id], .main-content, [data-book-id]') || anchorRoot;
    if (linkSearchRoot && linkSearchRoot.querySelectorAll) {
      const anchors = linkSearchRoot.querySelectorAll('a[href]');
      anchors.forEach(anchor => {
        if (!isContentLink(anchor as HTMLAnchorElement)) return;
        try {
          const anchorRange = document.createRange();
          anchorRange.selectNodeContents(anchor);
          const intersects = selectionRange.compareBoundaryPoints(Range.END_TO_START, anchorRange) <= 0 &&
                           anchorRange.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0;
          if (intersects) linksToUnwrap.push(anchor as HTMLElement);
        } catch (e) {
          if (selectedText.indexOf((anchor.textContent || '').trim()) !== -1 ||
              (anchor.textContent || '').trim().indexOf(selectedText) !== -1) {
            linksToUnwrap.push(anchor as HTMLElement);
          }
        }
      });
    }
  }

  // Second pass: remove ALL marks with the highlight class (not by ID, by class)
  // Wrap in programmatic flag so the MutationObserver doesn't treat
  // these DOM changes as user edits (the mark element gets detached,
  // which would otherwise trigger an ISOLATION BREACH error).
  setProgrammaticUpdateInProgress(true);
  try {
    highlightIdsToRemove.forEach(highlightId => {
      const allMarksWithClass = document.querySelectorAll(`mark.${highlightId}`);
      console.log(`Removing ${allMarksWithClass.length} marks with class ${highlightId}`);

      allMarksWithClass.forEach(markEl => {
        const mark = markEl as HTMLElement;
        const container = mark.closest(
          "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id]"
        );
        if (container && container.id) {
          affectedNodeChunks.add(container.id);
        }
        unwrapMark(mark);
      });
    });

    // Unwrap content links
    linksToUnwrap.forEach(anchor => {
      const container = anchor.closest(
        "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id]"
      );
      if (container && container.id) {
        affectedNodeChunks.add(container.id);
      }
      unwrapElement(anchor);
    });
  } finally {
    setProgrammaticUpdateInProgress(false);
  }

  // Queue affected nodes for save if links were unwrapped (links have no IndexedDB records).
  // linksToUnwrap is only populated in edit mode (above), so the editor chunk loads lazily here.
  if (linksToUnwrap.length > 0) {
    const { queueNodeForSave } = await import('../divEditor/index');
    affectedNodeChunks.forEach(nodeId => {
      queueNodeForSave(nodeId, 'update');
    });
    console.log(`✅ Unwrapped ${linksToUnwrap.length} content links, queued ${affectedNodeChunks.size} nodes for save`);
  }

  const updatedNodeChunks: any[] = [];
  const deletedHyperlights: any[] = [];

  for (const highlightId of highlightIdsToRemove) {
    try {
      // Get the deleted hyperlight data first
      const deletedHyperlight = await removeHighlightFromHyperlights(
        highlightId
      );
      if (deletedHyperlight) {
        deletedHyperlights.push(deletedHyperlight);
      }

      // Update nodes with explicit deletion instructions
      const affectedNodes = await removeHighlightFromNodeChunksWithDeletion(
        bookId,
        highlightId,
        deletedHyperlight
      );
      if (affectedNodes && affectedNodes.length > 0) {
        updatedNodeChunks.push(...affectedNodes);
      }
    } catch (error) {
      console.error(
        `Error removing highlight ${highlightId} from IndexedDB:`,
        error
      );
    }
  }

  if (highlightIdsToRemove.length > 0) {
    await updateBookTimestamp(bookId);

    deletedHyperlights.forEach((hl) => {
      if (hl && hl.hyperlight_id) {
        queueForSync("hyperlights", hl.hyperlight_id, "delete", hl);
      }
    });

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't queue node updates
    /*
    updatedNodeChunks.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodes", chunk.startLine, "update", chunk);
      }
    });
    */

    console.log(
      `✅ Queued for sync: ${deletedHyperlights.length} deletions (no node updates in NEW system).`
    );

    // 🎨 Reprocess highlights to render remaining highlights correctly
    if (affectedNodeChunks.size > 0) {
      const { reprocessHighlightsForNodes } = await import('./deletion');
      await reprocessHighlightsForNodes(bookId, Array.from(affectedNodeChunks));
      console.log(`✅ Reprocessed highlights for ${affectedNodeChunks.size} nodes after deletion`);
    }
  }

  // Clear selection and hide buttons
  window.getSelection()!.removeAllRanges();
  document.getElementById("hyperlight-buttons")!.style.display = "none";
  document.getElementById("delete-hyperlight")!.style.display = "none";

  // Show undo/redo buttons again in edit toolbar
  const editToolbar = document.getElementById("edit-toolbar");
  if (editToolbar) {
    editToolbar.classList.remove("hyperlight-selection-active");
  }
}
