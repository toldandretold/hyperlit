/**
 * Create-highlight module — turns a text selection into persisted hyperlight
 * <mark>s and the normalized IndexedDB record (+ PG sync queue).
 *
 * Owns the rangy machinery: rangy creates the marks (highlightSelection), and
 * fixInvalidMarks/wrapTextInElement/cleanupEmptyElements clean up rangy's mess
 * (it can wrap block elements). These are used ONLY by createHighlightHandler,
 * so they live here rather than in marks.ts or selection.
 *
 * Split out of the old selection.js monster (2026-06).
 */

import { updateAnnotationsTimestamp, queueForSync, rebuildNodeArrays, getNodesByDataNodeIDs } from '../indexedDB/index';
import { calculateCleanTextOffset, findContainerWithNumericalId } from './calculations';
import { modifyNewMarks } from './marks';
import { attachMarkListeners } from './listeners';
import { addToHighlightsTable } from './database';
import { reprocessHighlightsForNodes } from './deletion';
import { generateHighlightID, openHighlightById } from './utils';
import { STRUCTURAL_BLOCK_TAGS } from '../utilities/blockElements.js';
import { withPending, addNewlyCreatedHighlight, removeNewlyCreatedHighlight } from '../utilities/operationState.js';

// rangy is a global loaded via a <script> tag in the blade layout.
declare const rangy: any;

// Initialize the highlighter (using rangy)
rangy.init();
const highlighter = rangy.createHighlighter();
const classApplier = rangy.createClassApplier("highlight", {
    elementTagName: "mark",
    applyToAnyTagName: true
});
highlighter.addClassApplier(classApplier);

/**
 * Fix invalid marks that wrap block-level elements
 * Rangy can incorrectly wrap <li>, <p>, etc. in <mark> tags
 * This function detects and fixes those cases
 */
export function fixInvalidMarks(): void {
  const marks = document.querySelectorAll('mark.highlight');

  marks.forEach(mark => {
    // Check if mark contains block elements as direct children
    const blockChildren = Array.from(mark.childNodes).filter(child =>
      child.nodeType === Node.ELEMENT_NODE && STRUCTURAL_BLOCK_TAGS.has((child as HTMLElement).tagName)
    );

    if (blockChildren.length > 0) {
      console.log('🔧 Fixing invalid mark wrapping block elements:', blockChildren.map(c => (c as HTMLElement).tagName));

      // Get the mark's parent to insert fixed content
      const parent = mark.parentNode!;

      // Process each child of the invalid mark
      Array.from(mark.childNodes).forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE && STRUCTURAL_BLOCK_TAGS.has((child as HTMLElement).tagName)) {
          // This is a block element - move it out of the mark
          // and wrap its text content in new marks

          // Create marks inside this block element's text content
          wrapTextInElement(child as HTMLElement, 'mark', ['highlight']);

          // Move the block element out of the mark, before the mark
          parent.insertBefore(child, mark);
        } else if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
          // Text node - wrap it in a mark and move before the invalid mark
          const newMark = document.createElement('mark');
          newMark.className = 'highlight';
          newMark.textContent = child.textContent;
          parent.insertBefore(newMark, mark);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // Non-block element (like <strong>, <em>) - wrap in mark and move
          const newMark = document.createElement('mark');
          newMark.className = 'highlight';
          newMark.appendChild(child.cloneNode(true));
          parent.insertBefore(newMark, mark);
        }
      });

      // Remove the now-empty invalid mark
      mark.remove();
    }
  });

  // Also clean up any empty elements that Rangy may have created
  cleanupEmptyElements();
}

/**
 * Wrap all text content within an element in mark tags
 */
function wrapTextInElement(element: HTMLElement, tagName: string, classes: string[]): void {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  const textNodes: Node[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent || '').trim()) {
      textNodes.push(node);
    }
  }

  textNodes.forEach(textNode => {
    const wrapper = document.createElement(tagName);
    classes.forEach(cls => wrapper.classList.add(cls));
    textNode.parentNode!.insertBefore(wrapper, textNode);
    wrapper.appendChild(textNode);
  });
}

/**
 * Clean up empty elements created by Rangy's extractContents
 */
function cleanupEmptyElements(): void {
  const editableRoot = document.querySelector('.main-content');
  if (!editableRoot) return;

  STRUCTURAL_BLOCK_TAGS.forEach((tag: string) => {
    editableRoot.querySelectorAll(tag).forEach(el => {
      // Check if element is effectively empty (only whitespace or empty children)
      const hasContent = (el.textContent || '').trim().length > 0 ||
                         el.querySelector('img, video, iframe, br');

      if (!hasContent && !el.id) {
        // Only remove if it has no ID (don't remove our tracked elements)
        console.log(`🧹 Removing empty ${tag} element`);
        el.remove();
      }
    });
  });
}

/**
 * Open brain mode from the selection popup.
 * Creates a real highlight from the selection, then opens the hyperlit container
 * with the brain query input injected inside it.
 */
export async function openBrainFromSelection(event: Event): Promise<void> {
  const selection = window.getSelection();
  console.log('🧠 openBrainFromSelection called, selection:', selection?.toString()?.substring(0, 50), 'collapsed:', selection?.isCollapsed);

  // Clone the range immediately — mousedown may collapse the live selection on some platforms
  let cachedRange: Range | null = null;
  if (selection && selection.rangeCount > 0) {
    try { cachedRange = selection.getRangeAt(0).cloneRange(); } catch (_) { /* noop */ }
  }

  if (!selection || selection.isCollapsed) {
    // Fallback: use the cached range if the live selection already collapsed
    if (!cachedRange || cachedRange.collapsed) {
      console.warn('🧠 BrainMode: No selection or selection collapsed');
      return;
    }
  }

  const selectedText = selection!.toString().trim();
  if (!selectedText || selectedText.length < 5) {
    console.warn('🧠 BrainMode: Selected text too short (min 5 chars), got:', selectedText?.length);
    return;
  }

  // Use live range if available, otherwise fall back to cached clone
  const range = (!selection!.isCollapsed && selection!.rangeCount > 0)
    ? selection!.getRangeAt(0)
    : cachedRange;
  const rangeEl = range?.commonAncestorContainer;
  const containerEl = rangeEl?.nodeType === Node.TEXT_NODE ? rangeEl.parentElement : (rangeEl as HTMLElement | undefined);
  const subBookEl = containerEl?.closest('[data-book-id]') as HTMLElement | null;
  const bookId = subBookEl?.dataset?.bookId
    || document.querySelector('.main-content')?.id;

  if (!bookId) {
    console.warn('🧠 BrainMode: Could not determine book ID');
    return;
  }

  console.log('🧠 BrainMode: Creating highlight for bookId:', bookId, 'selectedText:', selectedText.substring(0, 50));

  // Hide the hyperlight-buttons popup
  const hlButtons = document.getElementById('hyperlight-buttons');
  if (hlButtons) hlButtons.style.display = 'none';

  // Create a real highlight but skip opening the container
  const result = await createHighlightHandler(event, bookId, { skipOpen: true });
  if (!result || !result.highlightId) {
    console.warn('🧠 BrainMode: Failed to create highlight');
    return;
  }

  const { highlightId } = result;
  console.log('🧠 BrainMode: Highlight created:', highlightId);

  // Mark as brain query in IndexedDB (keep creator as the user's name for proper delete permissions)
  try {
    const { openDatabase } = await import('../indexedDB/index');
    const db = await openDatabase();
    const tx = db.transaction('hyperlights', 'readwrite');
    const store = tx.objectStore('hyperlights');
    const idx = store.index('hyperlight_id');
    const existing: any = await new Promise(r => { const req = idx.get(highlightId); req.onsuccess = () => r(req.result); req.onerror = () => r(null); });
    if (existing) {
      existing.raw_json = { brain_query: true };
      store.put(existing);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    }
  } catch (e) {
    console.warn('🧠 BrainMode: Failed to set brain_query flag (non-fatal):', e);
  }

  // Find the mark element for the newly created highlight
  const markElement = document.querySelector(`mark.${highlightId}`);

  // Open hyperlit container with brain mode flag
  const { handleUnifiedContentClick } = await import('../hyperlitContainer/index.js');
  await handleUnifiedContentClick(
    markElement as any,
    [highlightId],
    [highlightId],
    false,
    false,
    null as any,
    false,
    { brainModeHighlightId: highlightId }
  );
}

/**
 * Create a new highlight from selected text
 */
export async function createHighlightHandler(event: Event, bookId: string, options: { skipOpen?: boolean } = {}): Promise<{ highlightId: string; charData: Record<string, { charStart: number; charEnd: number }>; nodeIds: string[]; selectedText: string } | undefined> {
  let selection = window.getSelection()!;
  let range: Range;
  try {
    range = selection.getRangeAt(0);
    console.log("📌 Full selected text:", selection.toString());
  } catch (error) {
    console.error("❌ Error getting range:", error);
    return;
  }

  let selectedText = selection.toString();
  if (!selectedText) {
    console.error("⚠️ No valid text selected.");
    return;
  }

  // Get containers - TARGET NUMERICAL IDS ONLY
  let startContainer = range.startContainer.nodeType === 3
    ? findContainerWithNumericalId(range.startContainer.parentElement)
    : findContainerWithNumericalId(range.startContainer);

  let endContainer = range.endContainer.nodeType === 3
    ? findContainerWithNumericalId(range.endContainer.parentElement)
    : findContainerWithNumericalId(range.endContainer);

  if (!startContainer || !endContainer) {
    console.error("❌ Could not determine start or end block.");
    return;
  }

  const cleanStartOffset = calculateCleanTextOffset(
    startContainer,
    range.startContainer,
    range.startOffset
  );

  const cleanEndOffset = calculateCleanTextOffset(
    endContainer,
    range.endContainer,
    range.endOffset
  );

  // Generate unique highlight ID
  const highlightId = generateHighlightID();

  // Check if selection contains existing marks
  const selectionContainsMarks = range.cloneContents().querySelectorAll('mark').length > 0;

  // Apply the highlight
  console.log("🎨 Before rangy - selection:", selection.toString(), "range:", range);
  console.log("🎨 Range details:", {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    containsExistingMarks: selectionContainsMarks
  });

  if (selectionContainsMarks) {
    console.warn("⚠️ Selection contains existing marks - Rangy may not handle boundaries correctly");
    // TODO: Implement manual mark creation for overlapping highlights
    // For now, still use Rangy but log the warning
  }

  highlighter.highlightSelection("highlight");

  // Fix any invalid marks that wrap block elements (like <li>, <p>)
  fixInvalidMarks();

  const newMarks = document.querySelectorAll('mark.highlight');
  console.log("🎨 After rangy - created marks:", newMarks.length);

  // 🔍 DETAILED LOGGING: Show each mark's context
  Array.from(newMarks).forEach((markEl, idx) => {
    const mark = markEl as HTMLElement;
    const parent = mark.parentElement;
    const dataNodeId = parent?.getAttribute('data-node-id') || 'NO data-node-id';
    const parentId = parent?.id || 'NO id';
    const subBook = mark.closest('[data-book-id]');
    const subBookId = subBook?.getAttribute('data-book-id') || 'NO sub-book';
    const containerType = parent?.tagName || 'UNKNOWN';

    console.log(`🔍 Mark ${idx}: text="${mark.textContent?.substring(0, 30)}" | data-node-id="${dataNodeId}" | parent.id="${parentId}" | sub-book="${subBookId}" | type=${containerType}`);
  });

  modifyNewMarks(highlightId);

  // Find all affected nodes
  const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
  console.log(`🔍 After modifyNewMarks: found ${affectedMarks.length} marks with class ${highlightId}`);

  const affectedIds = new Set<string>();
  const affectedElements = new Map<string, HTMLElement>();
  const updatedNodeChunks: any[] = [];

  affectedMarks.forEach((markEl, idx) => {
    const mark = markEl as HTMLElement;
    const container = mark.closest(
      "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id]"
    ) as HTMLElement | null;
    if (container && container.id) {
      const dataNodeId = container.getAttribute('data-node-id') || 'NO data-node-id';
      const subBook = container.closest('[data-book-id]');
      const subBookId = subBook?.getAttribute('data-book-id') || 'main-content';

      console.log(`🔍 Affected mark ${idx}: container.id="${container.id}" | data-node-id="${dataNodeId}" | sub-book="${subBookId}"`);

      affectedIds.add(container.id);
      affectedElements.set(container.id, container);
    }
  });

  // ✅ NEW: Collect per-node character position data
  const charDataByNode: Record<string, { charStart: number; charEnd: number }> = {};
  const nodeIdMap: Record<string, string> = {};

  // Update all affected nodes in IndexedDB
  for (const chunkId of affectedIds) {
    const isStart = chunkId === startContainer.id;
    const isEnd = chunkId === endContainer.id;

    const cleanLength = (() => {
      const textElem = affectedElements.get(chunkId)!;
      const cleanElem = textElem.cloneNode(true) as HTMLElement;

      // Remove ALL HTML elements to get clean text length (consistent with calculateCleanTextOffset)
      const removeAllHtml = (element: HTMLElement) => {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_ELEMENT,
          null
        );

        const elementsToReplace: Node[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node !== element) {
            elementsToReplace.push(node);
          }
        }

        elementsToReplace.reverse().forEach(el => {
          if (el.parentNode) {
            el.parentNode.replaceChild(document.createTextNode(el.textContent || ''), el);
          }
        });
      };

      removeAllHtml(cleanElem);
      return (cleanElem.textContent || '').length;
    })();

    const startOffset = isStart ? cleanStartOffset : 0;
    const endOffset = isEnd ? cleanEndOffset : cleanLength;

    // ✅ NEW: Store per-node positions for new charData structure
    const element = affectedElements.get(chunkId);
    const nodeId = element?.getAttribute('data-node-id') || chunkId;  // Fallback to startLine if no data-node-id

    nodeIdMap[chunkId] = nodeId;
    charDataByNode[nodeId] = {
      charStart: startOffset,
      charEnd: endOffset
    };

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't update embedded arrays directly
    /*
    const updatedNodeChunk = await updateNodeHighlight(
      bookId,
      chunkId,
      startOffset,
      endOffset,
      highlightId
    );

    if (updatedNodeChunk) {
      updatedNodeChunks.push(updatedNodeChunk);
    }
    */
  }

  try {
    // Wrap database operations with withPending to trigger cloudRef glow
    await withPending(async () => {
      // ✅ NEW SYSTEM: Save to normalized hyperlights table
      const savedHighlightEntry = await addToHighlightsTable(
        bookId,
        {
          highlightId,
          text: selectedText,
          charData: charDataByNode,
          startLine: startContainer!.id as any,
        }
      );

      console.log('✅ NEW SYSTEM: Hyperlight saved to normalized table');

      // ✅ NEW SYSTEM: Rebuild affected node arrays from normalized tables
      const affectedDataNodeIDs = Object.keys(charDataByNode);
      const allAffectedNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
      // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
      // node when the same node_id exists in both parent and sub-book.
      const affectedNodes = allAffectedNodes.filter((n: any) => n.book === bookId);

      await Promise.all([
        rebuildNodeArrays(affectedNodes),
        updateAnnotationsTimestamp(bookId),
      ]);

      console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} affected nodes`);

      // Queue hyperlight for PostgreSQL sync
      queueForSync("hyperlights", highlightId, "update", savedHighlightEntry);

      console.log(
        `✅ NEW SYSTEM: Queued 1 hyperlight for sync, rebuilt ${affectedNodes.length} node arrays.`
      );
    });

    // 🎨 Reprocess highlights to render overlapping segments correctly (outside withPending - DOM only)
    const affectedDataNodeIDs = Object.keys(charDataByNode);
    const allFreshNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
    // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
    // node when the same node_id exists in both parent and sub-book.
    const freshNodes = allFreshNodes.filter((n: any) => n.book === bookId);
    await reprocessHighlightsForNodes(bookId, Array.from(affectedIds), freshNodes);
    console.log(`✅ Reprocessed highlights for ${affectedIds.size} nodes to render overlaps`);

  } catch (error) {
    console.error("❌ Error saving highlight metadata:", error);
  }

  attachMarkListeners();
  window.getSelection()!.removeAllRanges();
  document.getElementById("hyperlight-buttons")!.style.display = "none";

  // Show undo/redo buttons again in edit toolbar
  const editToolbar = document.getElementById("edit-toolbar");
  if (editToolbar) {
    editToolbar.classList.remove("hyperlight-selection-active");
  }

  // Mark highlight as newly created for proper CSS styling in container
  addNewlyCreatedHighlight(highlightId);

  // Clean up the newly created flag after a delay (backend should have processed by then)
  setTimeout(() => {
    removeNewlyCreatedHighlight(highlightId);
  }, 10000); // 10 seconds should be enough for backend processing

  if (!options.skipOpen) {
    await openHighlightById(highlightId, true, [highlightId]);
  }

  return { highlightId, charData: charDataByNode, nodeIds: Object.keys(charDataByNode), selectedText };
}
