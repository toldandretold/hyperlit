// Extracted from divEditor/index.ts — the document-level `selectionchange` listener that
// (1) tracks which chunk currently has focus (debounced, so the observer isn't restarted
// on every cursor move) and (2) rescues the caret when it lands directly in a top/bottom
// sentinel div. Pulled out so the two decisions are unit-testable; index.ts just calls
// initSelectionFocusTracker() once at module load.
import { debounce } from '../utilities/debounce';
import {
  chunkOverflowInProgress,
  currentObservedChunk,
  setCurrentObservedChunk,
} from '../utilities/operationState';
import { getEditToolbar } from '../editToolbar/index';
import { getCurrentChunk } from './chunkManager';
import { isEventInActiveDiv } from './editSessionManager';
import { verbose } from '../utilities/logger';
import { book } from '../app';

/**
 * Update the "current chunk" state when focus moves to a different chunk. Only touches
 * state — it never restarts the observer. No-op while not editing, mid chunk-overflow,
 * or while the toolbar is actively formatting.
 */
export function updateChunkFocus(): void {
  if (!(window as any).isEditing || chunkOverflowInProgress) return;

  const toolbar = getEditToolbar();
  if (toolbar && toolbar.isFormatting) {
    return;
  }

  const newChunkId = getCurrentChunk();
  const currentChunkId = currentObservedChunk;

  if (newChunkId && newChunkId !== currentChunkId) {
    verbose.content(`Chunk focus changed (debounced): ${currentChunkId} → ${newChunkId}`, 'divEditor/index.js');
    setCurrentObservedChunk(newChunkId);
  }
}

// 🚀 PERFORMANCE: debounce so a burst of selectionchange events collapses to one update.
const handleSelectionChange = debounce(updateChunkFocus, 150);

/**
 * If the caret is sitting directly in a top/bottom sentinel div, move it to the nearest
 * valid (non-sentinel) node. Returns `true` when it acted (the caller should stop and NOT
 * run the debounced focus update), `false` when the element is not a sentinel.
 */
export function rescueCaretFromSentinel(element: Element | null, selection: Selection): boolean {
  const id = element?.id || '';
  const isSentinel = id.endsWith('-top-sentinel') || id.endsWith('-bottom-sentinel');
  if (!isSentinel) return false;

  // Move cursor to nearest valid element immediately
  const editableDiv = document.getElementById(book);
  const validElement = editableDiv?.querySelector('[id]:not([id$="-top-sentinel"]):not([id$="-bottom-sentinel"])') as HTMLElement | null;

  if (validElement) {
    validElement.focus();
    const newRange = document.createRange();
    newRange.selectNodeContents(validElement);
    newRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }
  return true;
}

/** Attach the single document-level selectionchange listener (called once at module load). */
export function initSelectionFocusTracker(): void {
  document.addEventListener("selectionchange", () => {
    // Early return for performance - don't process if not editing
    if (!(window as any).isEditing) return;

    // 🛡️ VERIFY: Check if selection is in the active edit container
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      const element = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) as Element | null;

      // Check if selection is within the active edit div
      if (!isEventInActiveDiv(element)) {
        // Selection is outside active container - ignore this selectionchange
        // This prevents main-content cursor changes from affecting hyperlit editing
        verbose.content(`selectionchange ignored - outside active div`, 'divEditor/index.js');
        return;
      }

      // Quick check: cursor directly in a sentinel div? Rescue it and stop.
      if (rescueCaretFromSentinel(element, selection)) return;
    }

    handleSelectionChange();
  });
}
