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
