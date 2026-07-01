// Extracted from divEditor/index.ts's startObserving — the click handler behind the
// per-node "delete" buttons on broken images and video embeds. Two independent branches:
//   • broken-image: resolve the REAL top-level node (not a phantom descendant), drop the
//     image subtree or the whole node, persist explicitly (the MutationObserver can't see
//     a numeric-id removal when a non-id wrapper is removed).
//   • video-embed: the .video-embed IS the node — remove it and focus an adjacent block,
//     or leave a replacement <p> when it stood alone.
// Pulled out so it is unit-testable via a synthetic click on a fixture.
import { resolveTopLevelNode, stripPhantomDescendantIds } from '../utilities/nodeResolve';
import { asLineId, type BookId } from '../utilities/idHelpers';
import type { SaveQueue } from './saveQueue';

interface VideoDeleteHandlerOptions {
  editableDiv: HTMLElement;
  bookId: BookId | null;
  /** Read live at click time — a new edit session swaps the SaveQueue instance. */
  getSaveQueue: () => SaveQueue | null;
}

export function createVideoDeleteHandler(
  { editableDiv, bookId, getSaveQueue }: VideoDeleteHandlerOptions,
): (e: MouseEvent) => void {
  return (e: any) => {
    const deleteBtn = e.target.closest('[data-action="delete-video"], [data-action="delete-broken-image"]');
    if (!deleteBtn) return; // Early exit for performance

    e.preventDefault();
    e.stopPropagation();

    const saveQueue = getSaveQueue();
    const isImage = deleteBtn.dataset.action === 'delete-broken-image';

    if (isImage) {
      const wrapper = deleteBtn.closest('.broken-image-wrapper');
      if (!wrapper) return;

      // ✅ Resolve the REAL top-level node (e.g. the <figure>), NOT an innermost
      // phantom node that backend conversion may have stamped inside it. Using
      // wrapper.closest('[data-node-id]') here climbed to a ghost <p>/<button>
      // inside the figure, so the figure's stored content was never updated and
      // the broken image returned on refresh. See utilities/nodeResolve.
      const nodeEl = resolveTopLevelNode(wrapper, editableDiv);
      console.log(`🗑️ Deleting broken image in node: ${nodeEl?.id}`);

      if (!nodeEl) {
        wrapper.remove();
        return;
      }

      const lineId = nodeEl.id ? asLineId(nodeEl.id) : null;
      // When the <picture>/<img> IS the node, the wrapper we created sits OUTSIDE
      // the node element (it contains it) — so the node holds nothing but the
      // image and deleting the image means deleting the whole node.
      const nodeInsideWrapper = wrapper.contains(nodeEl);

      let deleteWholeNode = nodeInsideWrapper;
      let focusTarget: Element | null = null;

      if (nodeInsideWrapper) {
        // Remove the whole node (the wrapper carries it out of the DOM). The
        // MutationObserver can't see a numeric-id removal when a non-id wrapper
        // is removed, so we persist the deletion explicitly below.
        focusTarget = wrapper.nextElementSibling || wrapper.previousElementSibling;
        wrapper.remove();
      } else {
        // The image is one part of a richer node → drop just the image subtree.
        wrapper.remove();
        // 🧹 Strip phantom numeric id / data-node-id off descendants so the node
        // persists as a single clean record (defensive for already-imported
        // books that have these baked in).
        stripPhantomDescendantIds(nodeEl);

        const hasMedia = !!nodeEl.querySelector('img, picture, iframe, video');
        if (nodeEl.textContent.trim() === '' && !hasMedia) {
          // Nothing meaningful left — delete the whole node rather than leaving
          // an empty shell (e.g. <figure><br></figure>).
          deleteWholeNode = true;
          focusTarget = nodeEl.nextElementSibling || nodeEl.previousElementSibling;
          nodeEl.remove();
        } else {
          focusTarget = nodeEl;
        }
      }

      if (deleteWholeNode) {
        // deletionMap is keyed by lineId, so this is idempotent even if the
        // MutationObserver also catches the figure-shell removal.
        if (lineId && saveQueue) {
          saveQueue.queueDeletion(lineId, nodeEl, bookId);
        }
        console.log(`✅ Broken image removed (node ${lineId ?? '?'} deleted)`);
      } else {
        // Explicit save — don't rely on MutationObserver alone
        if (lineId && saveQueue) {
          saveQueue.queueNode(lineId, 'update');
        }
        console.log(`✅ Broken image removed`);
      }

      if (focusTarget && (focusTarget as HTMLElement).isConnected) {
        const range = document.createRange();
        const selection: any = window.getSelection();
        range.selectNodeContents(focusTarget);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      // Video embed: the .video-embed IS the node element
      const videoEmbed = deleteBtn.closest('.video-embed');
      if (!videoEmbed || !videoEmbed.id) return;

      console.log(`🗑️ Deleting video embed: ${videoEmbed.id}`);

        // Check for adjacent content to focus cursor
        let focusTarget = null;
        let focusAtEnd = false;

        const nextSibling = videoEmbed.nextElementSibling;
        const prevSibling = videoEmbed.previousElementSibling;

        // Prefer next sibling, fall back to previous
        if (nextSibling && nextSibling.matches('p, h1, h2, h3, h4, h5, h6, div, blockquote, pre, li')) {
          focusTarget = nextSibling;
          focusAtEnd = false; // Place cursor at start
        } else if (prevSibling && prevSibling.matches('p, h1, h2, h3, h4, h5, h6, div, blockquote, pre, li')) {
          focusTarget = prevSibling;
          focusAtEnd = true; // Place cursor at end
        }

        if (focusTarget) {
          // Remove video and focus existing adjacent content
          videoEmbed.remove();

          const range = document.createRange();
          const selection: any = window.getSelection();

          // Find first text node or use element itself
          const textNode = focusTarget.firstChild;
          if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            range.setStart(textNode, focusAtEnd ? textNode.length : 0);
          } else {
            range.selectNodeContents(focusTarget);
            range.collapse(!focusAtEnd);
          }

          selection.removeAllRanges();
          selection.addRange(range);

          console.log(`✅ Video embed removed, cursor ${focusAtEnd ? 'at end of' : 'at start of'} ${focusTarget.tagName.toLowerCase()}`);
        } else {
          // No adjacent content - create replacement paragraph
          const replacementP = document.createElement('p');
          replacementP.id = videoEmbed.id;
          if (videoEmbed.hasAttribute('data-node-id')) {
            replacementP.setAttribute('data-node-id', videoEmbed.getAttribute('data-node-id'));
          }
          replacementP.innerHTML = '<br>';

          videoEmbed.parentNode.insertBefore(replacementP, videoEmbed);
          videoEmbed.remove();

          // Set cursor to new paragraph
          const range = document.createRange();
          const selection: any = window.getSelection();
          range.setStart(replacementP, 0);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);

          console.log(`✅ Video embed ${replacementP.id} replaced with paragraph (standalone video)`);
        }
      }
  };
}
