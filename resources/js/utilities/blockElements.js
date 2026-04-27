/**
 * Block Element Definitions — Single Source of Truth
 *
 * Centralises every block-tag / inline-tag list used across the codebase
 * so that adding a new tag (e.g. <hr>, <figure>) only requires one edit.
 */

// ---------------------------------------------------------------------------
// 1. BLOCK_ELEMENT_TAGS — elements that get their own ID in the save pipeline
// ---------------------------------------------------------------------------
export const BLOCK_ELEMENT_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'DIV', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'TABLE',
  'HR', 'FIGURE',
]);

// CSS selector derived from the Set (lowercase for querySelector)
export const BLOCK_ELEMENT_SELECTOR = Array.from(BLOCK_ELEMENT_TAGS)
  .map(t => t.toLowerCase())
  .join(', ');

// ---------------------------------------------------------------------------
// 2. STRUCTURAL_BLOCK_TAGS — wider set for parsing / layout classification
//    Includes everything in BLOCK_ELEMENT_TAGS plus structural wrappers
// ---------------------------------------------------------------------------
export const STRUCTURAL_BLOCK_TAGS = new Set([
  ...BLOCK_ELEMENT_TAGS,
  'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'ASIDE', 'NAV', 'MAIN', 'FIGCAPTION',
  'TR', 'TD', 'TH',
]);

// ---------------------------------------------------------------------------
// 3. INLINE_SKIP_TAGS — tags the save pipeline skips (not real nodes)
// ---------------------------------------------------------------------------
export const INLINE_SKIP_TAGS = new Set([
  'FONT', 'B', 'I', 'U', 'SPAN', 'STRONG', 'EM', 'A',
  'SUB', 'SUP', 'MARK', 'S', 'SMALL', 'CODE', 'BR',
  'ABBR', 'CITE', 'LATEX', 'IMG',
]);

// ---------------------------------------------------------------------------
// 4. ID_SKIP_TAGS — tags ensureNodeHasValidId() skips (no ID assignment)
// ---------------------------------------------------------------------------
export const ID_SKIP_TAGS = new Set([
  'BR', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U',
  'SUP', 'SUB', 'A', 'IMG', 'LI',
]);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Check if a tag name belongs to the core block element set */
export function isBlockElementTag(tagName) {
  return BLOCK_ELEMENT_TAGS.has(tagName.toUpperCase());
}

/** Check if a tag name belongs to the wider structural block set */
export function isStructuralBlockTag(tagName) {
  return STRUCTURAL_BLOCK_TAGS.has(tagName.toUpperCase());
}
