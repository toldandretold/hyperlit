/**
 * Pure DOM position collector for hyperlights (<mark>) and hypercites (<u>).
 *
 * Extracted from batch.js so the zero-width-residue guard + de-dupe can be unit-tested in
 * isolation — importing batch.js drags in editor/saveQueue side effects (circular imports).
 * Mirrors the bookIdResolver.js extraction pattern. No imports: just DOM walking.
 *
 * Tests: tests/javascript/indexedDB/hyperciteZeroWidthResidue.test.js
 */
import type { CharRange, RelationshipStatus } from '../types';

/** A <mark> occurrence measured in the node — input to updateHyperlightRecords. */
export interface CollectedHyperlight extends CharRange {
  highlightID: string;
}

/** A <u> occurrence measured in the node — input to updateHyperciteRecords. */
export interface CollectedHypercite extends CharRange {
  hyperciteId: string;
  relationshipStatus: RelationshipStatus;
  citedIN: string[];
  time_since: number;
}

/** Prior hypercite state used to carry status/citedIN/time across a re-measure. */
export type ExistingHypercite = {
  hyperciteId: string;
  relationshipStatus?: RelationshipStatus;
  citedIN?: string[];
  time_since?: number;
};

/**
 * Find the character offset of an element's text within a parent, by walking text nodes.
 * @returns start offset, or -1 if the element contains no text node
 */
export function findElementPosition(element: Element, parent: Node): number {
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT, null);

  let position = 0;
  let currentNode: Node | null;
  while ((currentNode = walker.nextNode())) {
    if (element.contains(currentNode) || (element as Node) === currentNode) {
      return position;
    }
    position += (currentNode.textContent ?? '').length;
  }
  return -1; // Element not found
}

/**
 * Walk a node's <mark> (hyperlight) and <u> (hypercite) descendants and compute their
 * character ranges, with guards that prevent split-residue corruption:
 *   - skip any element whose text is empty (length 0) — never persist a zero-width record
 *   - hyperlights: positions are derived per HL_* CLASS, as the union of every mark
 *     segment carrying that class — NEVER from mark.id. The renderer (applyHighlights)
 *     splits overlapping highlights into disjoint segments: multi-coverage segments get
 *     the synthetic id "HL_overlap" and each fragment of a split highlight repeats the
 *     same real id. Trusting mark.id created phantom "HL_overlap" records, shrank split
 *     highlights (last write wins), and never updated fully-contained ones. Pinned in
 *     tests/javascript/hyperlights/overlapClick.characterization.test.js.
 *   - hypercites: de-dupe by id, keeping the wider span (DOM order must not decide
 *     which write wins)
 */
export function collectMarkAndCitePositions(
  node: HTMLElement,
  existingHypercites: ExistingHypercite[] = [],
): { hyperlights: CollectedHyperlight[]; hypercites: CollectedHypercite[] } {
  const hyperlights: CollectedHyperlight[] = [];
  const hypercites: CollectedHypercite[] = [];
  const totalNodeLength = (node.textContent ?? '').length;

  // Process <mark> tags for hyperlights — accumulate each HL_* class's span as the
  // union of all segments carrying that class.
  const spansByHighlight = new Map<string, CharRange>();
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    // ✅ WHITELIST: Only save marks that have a class starting with "HL_"
    // This prevents ephemeral marks (search highlights, etc.) from being saved.
    // "HL_overlap" is excluded: it's the renderer's synthetic id for multi-coverage
    // segments, not a highlight — and books corrupted before this fix can carry it
    // as a class too; it must never be (re-)persisted.
    const highlightIds = Array.from(mark.classList).filter(
      (cls) => cls.startsWith('HL_') && cls !== 'HL_overlap'
    );
    if (highlightIds.length === 0) {
      return; // Only save proper user highlights
    }

    // ⚠️ SKIP newly created highlights - they already have correct positions from selection.js
    // Rangy may have created incorrect mark boundaries for overlapping highlights
    if (mark.hasAttribute('data-new-hl')) {
      console.log(`⏭️ Skipping position recalculation for newly created highlight ${mark.id} (has data-new-hl attribute)`);
      return; // Don't recalculate positions for newly created highlights
    }

    const startPos = findElementPosition(mark, node);
    const highlightLength = (mark.textContent ?? '').length;

    // Skip zero-width residue (e.g. an empty clone left behind when a selection boundary
    // lands on an existing mark's edge) — a length-0 element would otherwise be persisted
    // as charStart === charEnd and clobber the real record.
    if (highlightLength === 0) {
      console.warn(`⏭️ Skipping zero-width hyperlight residue: ${mark.id}`);
      return;
    }

    if (startPos < 0) return;

    highlightIds.forEach((highlightID) => {
      const span = spansByHighlight.get(highlightID);
      if (!span) {
        spansByHighlight.set(highlightID, {
          charStart: startPos,
          charEnd: startPos + highlightLength,
        });
      } else {
        // Another segment of the same highlight (split by an overlap or a
        // protected element like a footnote sup) — widen to the union.
        span.charStart = Math.min(span.charStart, startPos);
        span.charEnd = Math.max(span.charEnd, startPos + highlightLength);
      }
    });
  });

  spansByHighlight.forEach((span, highlightID) => {
    hyperlights.push({
      highlightID,
      charStart: span.charStart,
      charEnd: span.charEnd,
    });

    console.log("Calculated hyperlight positions:", {
      id: highlightID,
      startPos: span.charStart,
      endPos: span.charEnd,
      totalNodeLength,
    });
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
    const uLength = (uTag.textContent ?? '').length;

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
        const dupe = hypercites[dupeIndex]!;
        const existingSpan = dupe.charEnd - dupe.charStart;
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
