/**
 * blockFormat/types — the contract the block-format command modules
 * (headingFormat / listFormat / blockquoteCodeFormat) need from their caller.
 *
 * A zero-sibling-import leaf: it references only type-only imports (SelectionManager,
 * the id vocabulary, the callback types), so the command modules can `import type` it
 * WITHOUT importing `blockFormatter.ts` — keeping the graph acyclic (blockFormatter
 * imports the command modules, never the reverse).
 */
import type { SelectionManager } from '../selectionManager';
import type { BookId } from '../../utilities/idHelpers';
import type { SaveToIndexedDBCallback, DeleteFromIndexedDBCallback } from '../types';

/** A block-format command's outcome: the changed node's id + the resulting element. */
export interface BlockFormatResult {
  modifiedElementId: string | null;
  newElement: HTMLElement | null;
}

/**
 * The subset of BlockFormatter that the command modules call back into (passed as `self`).
 * BlockFormatter satisfies this structurally.
 */
export interface BlockCommandContext {
  selectionManager: SelectionManager;
  currentBookId: BookId | null;
  saveToIndexedDBCallback: SaveToIndexedDBCallback | null;
  deleteFromIndexedDBCallback: DeleteFromIndexedDBCallback | null;
  /** Excluded from de-any (legacy undo entanglement — see undoManager.ts). */
  undoManager: any;
  _contentPreservingWrap(element: Element, type: 'blockquote' | 'code'): HTMLElement;
  _contentPreservingUnwrap(element: Element, type: 'blockquote' | 'code'): HTMLElement;
  _mergeBlocksIntoList(paragraphs: HTMLElement[], listType: 'ul' | 'ol'): Promise<BlockFormatResult>;
  _mergeBlocksIntoBlockquote(paragraphs: HTMLElement[]): Promise<BlockFormatResult>;
  unwrapBlock(blockToUnwrap: Element, type: 'blockquote' | 'code'): Promise<BlockFormatResult>;
  wrapBlock(blockParentToToggle: Element, type: 'blockquote' | 'code'): Promise<BlockFormatResult>;
}
