/**
 * Canonical text extraction — the ONE definition of "what does this node say?"
 *
 * Both sides of the DOM↔IndexedDB comparison must canonicalise identically, or
 * the comparison reports differences that are really artifacts of which side you
 * happened to be looking at. This module is therefore the single home for that
 * canonicalisation, shared by:
 *
 *   - `integrity/verifier.ts`  — "did an edit fail to persist?" (STRICT variant)
 *   - `indexedDB/nodes/batch.ts` — "may a read-mode heal re-persist this node
 *      from the live DOM?" (footnote-TOLERANT variant)
 *
 * ZERO-IMPORT LEAF. It is consulted from `integrity/`, `indexedDB/` and
 * (transitively) `lazyLoader/`, where `batch.ts ← footnoteSelfHeal ← chunkRender`
 * is already a dynamic-import dance specifically to dodge cycles. Adding an
 * import here risks the circular-import TDZ class. Keep it on globals only
 * (DOMParser, Element) and keep it dependency-free.
 */

/**
 * The stand-in a footnote marker's visible number collapses to in the tolerant
 * variant. U+FFFC (OBJECT REPLACEMENT CHARACTER) is used because it cannot occur
 * in prose and survives `normaliseText` (which strips only ZWSP / word joiner).
 */
const FOOTNOTE_MARKER_SENTINEL = '\uFFFC';

/**
 * Normalise text for comparison: strip zero-width characters, collapse all
 * whitespace runs to a single space, trim. Makes a comparison resilient to
 * formatting differences between live DOM and stored HTML.
 */
export function normaliseText(str: string | null | undefined): string {
  return (str || '').replace(/[\u200B\u2060]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract textContent from an element while canonicalising <latex> and
 * <latex-block> elements. KaTeX renders math by injecting visible glyphs +
 * accessibility annotations *inside* the `<latex>` element, so live-DOM
 * textContent diverges from stored HTML (which keeps the element empty with the
 * LaTeX source in `data-math`). Both sides are replaced with the same stable
 * string — the data-math attribute — so the comparison is consistent.
 *
 * `ignoreFootnoteMarkers` additionally collapses every `sup[fn-count-id]`'s
 * visible text to a sentinel. Use it ONLY for the read-mode heal gate: a
 * footnote's displayed number legitimately changes in the DOM (that is what the
 * heal exists to persist), so comparing it would refuse the very writes the heal
 * is for. The verifier must NOT pass it — there, a changed footnote number is a
 * real divergence it is supposed to see and report.
 */
export function textContentCanonical(
  node: Element | null | undefined,
  { ignoreFootnoteMarkers = false }: { ignoreFootnoteMarkers?: boolean } = {},
): string {
  if (!node) return '';
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll('latex, latex-block').forEach((el) => {
    el.textContent = el.getAttribute('data-math') || '';
  });
  if (ignoreFootnoteMarkers) {
    clone.querySelectorAll('sup[fn-count-id]').forEach((el) => {
      el.textContent = FOOTNOTE_MARKER_SENTINEL;
    });
  }
  return clone.textContent || '';
}

/**
 * Parse stored HTML content and extract its canonical text. Mirrors what the
 * browser would render, minus the inline artefacts `contentProcessor` strips on
 * save. Takes the same options as `textContentCanonical` so the stored side is
 * canonicalised by exactly the same rules as the DOM side.
 */
export function textFromStoredHTML(
  html: string | null | undefined,
  options: { ignoreFootnoteMarkers?: boolean } = {},
): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild;
  return textContentCanonical(el || doc.body, options);
}

/**
 * Does the live DOM element still say what the stored content says?
 *
 * This is the gate for deriving node content FROM the live DOM in read mode.
 * Footnote markers are ignored (a renumber is the legitimate read-mode text
 * change); everything else must match.
 *
 * NOTE a `false` here does NOT mean "the page was translated". Several
 * render-time passes legitimately rewrite a node's text — `renderCharts` and
 * `renderHarvestNetworks` replace a `<table>` with an `<svg>`, `renderCitationPaths`
 * strips an anchor — so a chart node diverges on every render of a perfectly
 * healthy book. That is precisely why a divergence must REFUSE the write rather
 * than conclude anything about why: refusing costs a skipped heal, whereas
 * concluding "translated" would wrongly latch the external-translation state and
 * disable edit mode for every book containing a chart. Vendor-marker detection
 * (`utilities/externalTranslation.ts`) is what answers the "why".
 */
export function domMatchesStored(
  domEl: Element | null | undefined,
  storedHtml: string | null | undefined,
): boolean {
  const dom = normaliseText(textContentCanonical(domEl, { ignoreFootnoteMarkers: true }));
  const stored = normaliseText(textFromStoredHTML(storedHtml, { ignoreFootnoteMarkers: true }));
  return dom === stored;
}
