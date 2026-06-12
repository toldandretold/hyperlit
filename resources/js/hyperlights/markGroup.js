/**
 * Mark-group resolution — zero-import leaf module.
 *
 * A single hyperlight is usually rendered as SEVERAL sibling <mark> elements:
 * applyHighlights splits it at overlap boundaries, and protected elements
 * (footnote <sup>s, etc.) split it further. Hover/click feedback applied to
 * one mark element therefore lights up only a fragment of the highlight —
 * which reads as "the highlight doesn't match the highlighted text".
 *
 * These helpers resolve a mark element to its full visual group: every mark
 * carrying at least one of the same HL_* classes. Identity lives in the
 * CLASSES — mark.id is a rendering artifact (multi-coverage segments share
 * the synthetic id "HL_overlap"); see positionCollector.ts for the same rule
 * on the save path.
 *
 * Tests: tests/javascript/hyperlights/markGroup.test.js
 */

/** Class applied to every mark in the hovered highlight's group. */
export const GROUP_HOVER_CLASS = 'hl-group-hover';

/**
 * Extract the highlight IDs a mark carries.
 * Excludes the literal "HL_overlap" — it's the renderer's synthetic id for
 * multi-coverage segments (and residue class in books corrupted before the
 * positionCollector fix), not a highlight identity.
 *
 * @param {HTMLElement} mark
 * @returns {string[]}
 */
export function getHighlightIdsFromMark(mark) {
  if (!mark || !mark.classList) return [];
  return Array.from(mark.classList).filter(
    (cls) => cls.startsWith('HL_') && cls !== 'HL_overlap'
  );
}

const escapeCss = (s) =>
  (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s;

/**
 * All marks (in DOM order, deduped) carrying any of the given highlight IDs.
 *
 * @param {string[]} highlightIds
 * @param {ParentNode} root - scope to search (default: document)
 * @returns {HTMLElement[]}
 */
export function getMarksForHighlightIds(highlightIds, root = document) {
  if (!highlightIds || highlightIds.length === 0) return [];
  const selector = highlightIds.map((id) => `mark.${escapeCss(id)}`).join(', ');
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Resolve a mark element to its full visual group — every mark sharing at
 * least one HL_* class with it (including the mark itself).
 *
 * @param {HTMLElement} mark
 * @param {ParentNode} root - scope to search (default: document)
 * @returns {HTMLElement[]}
 */
export function getMarkGroup(mark, root = document) {
  return getMarksForHighlightIds(getHighlightIdsFromMark(mark), root);
}

/**
 * Apply the group-hover class to every mark in the hovered mark's group.
 * @param {HTMLElement} mark - the mark under the cursor
 * @param {ParentNode} root
 */
export function applyGroupHover(mark, root = document) {
  getMarkGroup(mark, root).forEach((m) => m.classList.add(GROUP_HOVER_CLASS));
}

/**
 * Clear group-hover from all marks.
 * @param {ParentNode} root
 */
export function clearGroupHover(root = document) {
  root.querySelectorAll(`mark.${GROUP_HOVER_CLASS}`).forEach((m) =>
    m.classList.remove(GROUP_HOVER_CLASS)
  );
}
