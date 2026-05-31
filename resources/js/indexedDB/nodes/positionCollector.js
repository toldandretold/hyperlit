/**
 * Pure DOM position collector for hyperlights (<mark>) and hypercites (<u>).
 *
 * Extracted from batch.js so the zero-width-residue guard + de-dupe can be unit-tested in
 * isolation — importing batch.js drags in editor/saveQueue side effects (circular imports).
 * Mirrors the bookIdResolver.js extraction pattern. No imports: just DOM walking.
 *
 * Tests: tests/javascript/indexedDB/hyperciteZeroWidthResidue.test.js
 */

/**
 * Find the character offset of an element's text within a parent, by walking text nodes.
 * @returns {number} start offset, or -1 if the element contains no text node
 */
export function findElementPosition(element, parent) {
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, null, false);

  let position = 0;
  let currentNode;
  while ((currentNode = walker.nextNode())) {
    if (element.contains(currentNode) || element === currentNode) {
      return position;
    }
    position += currentNode.textContent.length;
  }
  return -1; // Element not found
}

/**
 * Walk a node's <mark> (hyperlight) and <u> (hypercite) descendants and compute their
 * character ranges, with two guards that prevent split-residue corruption:
 *   - skip any element whose text is empty (length 0) — never persist a zero-width record
 *   - de-dupe by id, keeping the wider span (DOM order must not decide which write wins)
 *
 * @param {HTMLElement} node - the node element (e.g. <p>) to scan
 * @param {Array<Object>} existingHypercites - prior records, for merging status/citedIN/time
 * @returns {{ hyperlights: Array, hypercites: Array }}
 */
export function collectMarkAndCitePositions(node, existingHypercites = []) {
  const hyperlights = [];
  const hypercites = [];
  const totalNodeLength = node.textContent.length;

  // Process <mark> tags for hyperlights
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    // ✅ WHITELIST: Only save marks that have a class starting with "HL_"
    // This prevents ephemeral marks (search highlights, etc.) from being saved
    const hasHLClass = Array.from(mark.classList).some(cls => cls.startsWith('HL_'));
    if (!hasHLClass) {
      return; // Only save proper user highlights
    }

    // ⚠️ SKIP newly created highlights - they already have correct positions from selection.js
    // Rangy may have created incorrect mark boundaries for overlapping highlights
    if (mark.hasAttribute('data-new-hl')) {
      console.log(`⏭️ Skipping position recalculation for newly created highlight ${mark.id} (has data-new-hl attribute)`);
      return; // Don't recalculate positions for newly created highlights
    }

    const startPos = findElementPosition(mark, node);
    const highlightLength = mark.textContent.length;

    // Skip zero-width residue (e.g. an empty clone left behind when a selection boundary
    // lands on an existing mark's edge) — a length-0 element would otherwise be persisted
    // as charStart === charEnd and clobber the real record.
    if (highlightLength === 0) {
      console.warn(`⏭️ Skipping zero-width hyperlight residue: ${mark.id}`);
      return;
    }

    if (startPos >= 0) {
      hyperlights.push({
        highlightID: mark.id,
        charStart: startPos,
        charEnd: startPos + highlightLength,
      });

      console.log("Calculated hyperlight positions:", {
        id: mark.id,
        text: mark.textContent,
        startPos,
        endPos: startPos + highlightLength,
        totalNodeLength,
      });
    }
  });

  // Process <u> tags for hypercites
  const uTags = node.getElementsByTagName("u");
  Array.from(uTags).forEach((uTag) => {
    // FIX: Only process <u> tags that are actual hypercites (have a specific ID format)
    // This prevents plain, non-hypercite <u> tags from being processed and causing errors.
    if (!uTag.id || !uTag.id.startsWith('hypercite_')) {
      return; // Skip this tag if it's not a valid hypercite
    }
    if (uTag.classList.contains('hypercite-tombstone')) return; // ghost — handled by caller

    const startPos = findElementPosition(uTag, node);
    const uLength = uTag.textContent.length;

    // Skip zero-width residue. When a selection boundary lands on an existing cite's edge,
    // range.extractContents() can leave an empty duplicate-id <u></u> ghost behind. Measured
    // here it would be charStart === charEnd and, written last, would clobber the real cite's
    // range (making it unrenderable & unnavigable). Never persist a zero-length hypercite.
    if (uLength === 0) {
      console.warn(`⏭️ Skipping zero-width hypercite residue: ${uTag.id}`);
      return;
    }

    if (startPos >= 0) {
      // ✅ MERGE: Find existing hypercite data or use defaults
      const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === uTag.id);

      // De-dupe defensively: if this id was already collected this pass (e.g. a surviving
      // split duplicate), keep whichever occurrence spans more characters rather than letting
      // DOM order decide which write wins.
      const dupeIndex = hypercites.findIndex(hc => hc.hyperciteId === uTag.id);
      if (dupeIndex !== -1) {
        const existingSpan = hypercites[dupeIndex].charEnd - hypercites[dupeIndex].charStart;
        if (uLength <= existingSpan) {
          console.warn(`⏭️ Skipping narrower duplicate of hypercite ${uTag.id} (${uLength} ≤ ${existingSpan})`);
          return;
        }
        console.warn(`♻️ Replacing narrower duplicate of hypercite ${uTag.id} with wider span (${uLength} > ${existingSpan})`);
        hypercites.splice(dupeIndex, 1);
      }

      hypercites.push({
        hyperciteId: uTag.id,
        charStart: startPos,
        charEnd: startPos + uLength,
        relationshipStatus: existingHypercite?.relationshipStatus || "single",
        citedIN: existingHypercite?.citedIN || [],
        time_since: existingHypercite?.time_since || Math.floor(Date.now() / 1000)
      });

      console.log("Calculated hypercite positions:", {
        id: uTag.id,
        text: uTag.textContent,
        startPos,
        endPos: startPos + uLength,
        totalNodeLength,
      });
    }
  });

  return { hyperlights, hypercites };
}
