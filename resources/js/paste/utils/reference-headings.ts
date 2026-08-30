/**
 * Canonical bibliography heading vocabulary.
 *
 * Before this module the paste engine carried SIX mutually inconsistent heading
 * regexes (general x2, cambridge, sage, science-direct, taylor-francis), between
 * them knowing four words. A reference list titled "Works Consulted",
 * "Notes and References", "7. References" or "Literaturverzeichnis" was invisible
 * to every one of them, which pushed GeneralProcessor onto its heading-less path
 * and from there into inventing references out of body prose.
 *
 * Mirrors REFERENCE_HEADERS in app/Python/digestion/bibliographyExtraction/bibliography.py
 * (the conversion pipeline's list), widened with the entries both sides lacked.
 *
 * DELIBERATE CARVE-OUT — bare 'notes' / 'endnotes' / 'footnotes' are NOT here.
 * They are the FOOTNOTE system's vocabulary: extractFootnotes runs at Stage 2,
 * before reference extraction, and `isReferenceSectionHeading` in dom-utils.ts
 * (a section-REMOVAL matcher, a different job) intentionally covers them. Adding
 * them here would let bibliography detection steal note sections out from under
 * the footnote extractor. The compound forms ("notes and references") are
 * unambiguous and are included.
 */

export const REFERENCE_HEADINGS: readonly string[] = [
  // English — reference lists
  'references',
  'reference',
  'reference list',
  'references cited',
  'cited references',
  'list of references',
  'citations',
  // English — bibliographies
  'bibliography',
  'bibliographies',
  'selected bibliography',
  'works cited',
  'works consulted',
  'cited works',
  'literature cited',
  // English — sources
  'sources',
  'primary sources',
  'secondary sources',
  // Compound forms (safe: the qualifier disambiguates them from a notes section)
  'notes and references',
  'references and notes',
  'references and further reading',
  'references and recommended reading',
  'further reading',
  'suggested reading',
  // Non-English
  'literatur',
  'literaturverzeichnis',
  'bibliographie',
  'références',
  'referenties',
  'bibliografía',
  'bibliografia',
  'referencias',
  'referências',
];

const HEADING_SET = new Set(REFERENCE_HEADINGS);

/**
 * Leading section enumerators that carry no meaning for matching:
 * "7. References", "7) References", "IV. References", "Appendix A: References",
 * "Chapter 3 - References".
 */
const LEADING_PREFIX_RE =
  /^(?:(?:appendix|annex|chapter|section|part)\s+[a-z0-9]{1,4}\s*[:.–—-]?\s*|[0-9]{1,2}(?:\.[0-9]{1,2})*(?:\s*[.):–—-]\s*|\s+)|[ivxlc]{1,5}\s*[.):]\s*)/;

/**
 * True when a heading names a bibliography / reference list.
 *
 * Tolerant of the packaging real documents put around the word: a leading
 * enumerator or "Appendix A:" prefix, a trailing colon, curly apostrophes,
 * and any run of whitespace.
 */
export function isReferenceHeading(headingText: string | null | undefined): boolean {
  if (!headingText) return false;

  let normalized = headingText
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'");

  // Strip a trailing colon / full stop and any leading enumerator.
  normalized = normalized.replace(/[:.\s]+$/, '');
  normalized = normalized.replace(LEADING_PREFIX_RE, '').trim();

  return HEADING_SET.has(normalized);
}
