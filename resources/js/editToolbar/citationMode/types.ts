/**
 * citationMode/types — shared shapes for the citation search mode (zero-import leaf).
 */

export interface CitationModeOptions {
  toolbar?: HTMLElement | null;
  citationButton?: HTMLElement | null;
  citationContainer?: HTMLElement | null;
  citationInput?: HTMLInputElement | null;
  citationResults?: HTMLElement | null;
  closeHeadingSubmenuCallback?: () => void;
}

/** The custom shelf-dropdown sub-UI (present only if its full markup block exists). */
export interface ShelfUI {
  picker: HTMLElement;
  trigger: HTMLElement;
  current: HTMLElement;
  options: HTMLElement;
}

/** Category C refs — the scope-chip bar (+ optional shelf), live ONLY while the mode is open.
 *  Held as one nullable bundle so a single guard narrows them all to non-null. */
export interface ScopeChipsUI {
  scopeBar: HTMLElement;
  scopeButtons: HTMLElement[];
  shelf: ShelfUI | null;
}

/** Caller-supplied context for an open citation session (cursor + how to persist). */
export interface PendingContext {
  bookId: string;
  range: Range;
  // Threaded straight to citationInserter; kept loose at this dynamic boundary.
  saveCallback: (id: any, html: any, options?: any) => void | Promise<void>;
  undoSnapshot?: { elementId: string; oldHTML: string; cursorBefore?: number } | null;
  undoManager?: any;
}

/** A row from /api/search/combined. */
export interface CitationSearchResult {
  bibtex?: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  source?: string;
  is_private?: boolean;
  book?: string;
  canonical_source_id?: string | null;
  has_nodes?: boolean;
}
