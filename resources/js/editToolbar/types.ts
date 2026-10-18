/**
 * editToolbar/types — shared callback contracts for the toolbar's formatting
 * handlers. Folder-root types per the migration convention.
 *
 * Scope: the ID-bearing save seam only (the orchestrator's DOM/button fields are a
 * separate de-`any` follow-up).
 */
import type { LineId } from '../utilities/idHelpers';

/**
 * Persist a formatted block back to IndexedDB. `id` is the block's positional
 * LineId (read off the DOM element being formatted); `html` is its outerHTML.
 * Implemented by EditToolbar.saveToIndexedDB and threaded into every formatter.
 */
export type SaveToIndexedDBCallback = (
  id: LineId,
  html: string,
  options?: Record<string, unknown>,
) => void | Promise<void>;

/** Delete a node from IndexedDB by its positional id (used when list→block merges drop extras). */
export type DeleteFromIndexedDBCallback = (id: LineId) => void | Promise<void>;

/** A concrete heading tag — the list-item converter needs the LEVEL, not the
 *  word "heading" (passing the word minted a <pre> for years). */
export type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** Convert a single list item to a block (heading/blockquote/code) during list→block formatting.
 *  Return value is ignored by callers (fire-and-await), hence the loose result type. */
export type ConvertListItemToBlockCallback = (
  listItem: HTMLElement,
  blockType: HeadingTag | 'blockquote' | 'code',
) => void | Promise<unknown>;
