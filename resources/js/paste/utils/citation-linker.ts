/**
 * Citation Linker Utility
 * Processes in-text citations and links them to bibliography references
 *
 * Handles patterns like:
 * - (Author, Year)
 * - (Author et al., Year)
 * - (Author Year: page)
 * - Multiple citations: (Author1, Year1; Author2, Year2)
 *
 * Part of the modular paste processor system.
 */

import { generateReferenceKeys } from './reference-key-generator';

// ---------------------------------------------------------------------------------------------
// YEAR RANGES are date spans, not citations.
// ---------------------------------------------------------------------------------------------
// "in Modi's first term (2014-2019), it intensified in its second term (2019-2024)" cites nothing —
// but each parenthesis is a perfect "(…YYYY…)" candidate and the author's name sits right in front
// of it, so the key generator resolved modi2014 / modi2019 and this linker minted two anchors to
// speeches the author never cited (live: book_1789025680384, pasted from Sage). A phantom link is
// the expensive kind of wrong — the citation review then pairs a claim with a source that was never
// cited, and the hypercite graph grows an edge that does not exist.
//
// This is the SAME rule the server-side linker enforces (app/Python/digestion/citationLinking/
// citation_link_rules.py); the paste path is a second, independent implementation of the scan, so
// it needs its own copy. The tell is positional: a year with another year and a dash on one side of
// it is one endpoint of a span — either side, any dash, including the abbreviated tail ("2014-19").
// A letter-suffixed year ("2024a") is a disambiguation marker and can never be an endpoint, which
// is what keeps "(Modi, 2024a, 2024b)" linking. Page ranges are untouched because BOTH endpoints
// must be year-shaped: "(Nord et al., 2024: 24–25)" still links on 2024.
// `(?:^|\D)` rather than a `(?<!\d)` lookbehind: Safari only gained lookbehind in 16.4, and this
// runs in the reader.
const YEAR_TOKEN_RE = /\d{4}[a-z]?/;
const RANGE_LEFT_RE = /(?:^|\D)(?:1[5-9]\d\d|20\d\d)\s*[-‐‑‒–—―−]\s*$/;
const RANGE_RIGHT_RE = /^\s*[-‐‑‒–—―−]\s*(?:(?:1[5-9]\d\d|20\d\d)|\d{2})(?!\d)/;
const TRAILING_YEAR_RE = /^([\s,]+)(\d{4}[a-z]?)/;

function isYearRangeHalf(text: string, token: string, index: number): boolean {
  if (!/^\d{4}$/.test(token)) return false;          // "2024a" is a suffix, never an endpoint
  const value = parseInt(token, 10);
  if (value < 1500 || value > 2099) return false;
  return RANGE_LEFT_RE.test(text.slice(0, index))
    || RANGE_RIGHT_RE.test(text.slice(index + token.length));
}

/** The year this citation resolves and anchors on, or `null` when it is a date span rather than a
 *  citation. Always the FIRST year, because that is the one `generateReferenceKeys` keys on — so a
 *  first year that is a range endpoint cannot produce a correct link, only a confident wrong one. */
function linkableYear(subCite: string): { token: string; index: number } | null {
  const first = subCite.match(YEAR_TOKEN_RE);
  if (!first || first.index === undefined) return null;
  return isYearRangeHalf(subCite, first[0], first.index)
    ? null
    : { token: first[0], index: first.index };
}

/**
 * "Modi, 2019, 2023" is ONE author citing SEVERAL works, and each year names a different entry.
 * Only the first was ever resolved — the rest of the citation was emitted as plain text, so half
 * of every multi-year citation silently lost its link (invisible on a publisher page that anchors
 * each year itself, which is why the Sage-pasted book looked fine). Each trailing year is re-keyed
 * on its own against `author + year`.
 *
 * A year that opens a span is skipped for the same reason the first one is: "(Smith, 2001,
 * 1990-1994)" is a page range, not a second work. (The CLOSING half is unreachable here — the
 * separator class holds no dash.)
 */
function linkTrailingYears(
  trailingPart: string,
  authorPart: string,
  contextBefore: string,
  referenceMappings: Map<string, string>,
  formatType: string,
): string {
  let remaining = trailingPart;
  let out = '';
  while (remaining) {
    const extra = remaining.match(TRAILING_YEAR_RE);
    if (!extra) return out + remaining;
    // Defaults are unreachable — both groups are mandatory in TRAILING_YEAR_RE —
    // but they keep `tsc --noEmit` clean under noUncheckedIndexedAccess.
    const [, separator = '', yearToken = ''] = extra;
    const rest = remaining.slice(extra[0].length);
    if (RANGE_RIGHT_RE.test(rest)) {
      out += separator + yearToken;
      remaining = rest;
      continue;
    }
    const keys = generateReferenceKeys(authorPart + yearToken, contextBefore, formatType);
    const hit = keys.find((key: string) => referenceMappings.has(key));
    out += hit
      ? `${separator}<a href="#${referenceMappings.get(hit)}" class="in-text-citation">${yearToken}</a>`
      : separator + yearToken;
    remaining = rest;
  }
  return out;
}

/**
 * Process and link in-text citations in pasted content
 * @param {string} htmlContent - HTML content containing citations
 * @param {Map} referenceMappings - Map of citation keys to reference IDs
 * @param {Array} allReferences - Array of all reference objects (for fallback matching)
 * @param {string} formatType - Format type identifier (e.g., 'oup', 'taylor-francis')
 * @returns {string} - HTML with linked citations
 */
export function processInTextCitations(htmlContent: any, referenceMappings: any, allReferences: any[] = [], formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  // Taylor & Francis specific processing
  if (formatType === 'taylor-francis') {
    console.log(`📚 T&F: Processing in-text citations with ${referenceMappings.size} reference mappings`);
  }

  // Convert existing anchor-based citations
  // Handles both:
  // - Direct anchors: <a href="#ref7">
  // - Full URLs with fragments: <a href="https://example.com/page#ref7">
  let anchorLinksConverted = 0;
  const allAnchors = tempDiv.querySelectorAll('a[href]');

  allAnchors.forEach((link: any) => {
    // Skip if inside static bibliography section
    if (link.closest('[data-static-content="bibliography"]')) return;
    // Skip if already a Hyperlit citation
    if (link.classList.contains('in-text-citation')) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Extract fragment identifier from href (works for both #ref7 and https://...#ref7)
    const fragmentMatch = href.match(/#([a-zA-Z][\w-]*)$/);
    if (!fragmentMatch) return;

    const anchorId = fragmentMatch[1];
    if (referenceMappings.has(anchorId)) {
      link.setAttribute('href', '#' + referenceMappings.get(anchorId));
      link.classList.add('in-text-citation');
      anchorLinksConverted++;
    }
  });

  if (anchorLinksConverted > 0) {
    console.log(`  - ✅ Converted ${anchorLinksConverted} anchor-based citations to Hyperlit format`);
  }

  // Find citation patterns (Author Year) or (Year)
  const walker = document.createTreeWalker(
    tempDiv,
    NodeFilter.SHOW_TEXT,
    null);

  const textNodes: any[] = [];
  let node: any;
  while (node = walker.nextNode()) {
    // Skip if inside a link or script/style
    const parent = node.parentElement;
    if (parent && !['SCRIPT', 'STYLE', 'A'].includes(parent.tagName)) {
      // Skip if inside bibliography section (but allow footnotes section)
      const isStaticBibliography = parent.getAttribute('data-static-content') === 'bibliography'
        || parent.closest('[data-static-content="bibliography"]');

      if (isStaticBibliography) {
        continue;
      }

      textNodes.push(node);
    }
  }

  textNodes.forEach((textNode: any) => {
    const text = textNode.textContent;
    const citationPattern = /\(([^)]*?\d{4}[^)]*?)\)/g;
    let match: any;
    const replacements: any[] = [];

    while ((match = citationPattern.exec(text)) !== null) {
      const citationBlock = match[1];
      const subCitations = citationBlock.split(/;\s*/);
      let linkedParts: any[] = [];

      subCitations.forEach((subCite: any, index: any) => {
        const trimmed = subCite.trim();
        if (!trimmed) return;

        // A DATE SPAN is not a citation — "(2014-2019)" has nothing to resolve, so leave the text
        // exactly as it is. (Emitted before the prefix stripping below: the separator bookkeeping
        // at the end of this callback still has to run.)
        if (linkableYear(trimmed) === null && YEAR_TOKEN_RE.test(trimmed)) {
          linkedParts.push(trimmed);
          if (index < subCitations.length - 1) linkedParts.push('; ');
          return;
        }

        // Handle indirect citations like (Cited in Smith, 2020)
        let processedCite = trimmed;
        const prefixes = ['Cited in ', 'Quoted in ', 'see ', 'e.g., ', 'cf. '];
        for (const prefix of prefixes) {
            if (processedCite.toLowerCase().startsWith(prefix.toLowerCase())) {
                processedCite = processedCite.substring(prefix.length);
                break;
            }
        }

        const keys = generateReferenceKeys(processedCite, text.substring(0, match.index), formatType);
        let linked = false;
        let referenceId: any = null; // To store the found ID

        for (const key of keys) {
          if (referenceMappings.has(key)) {
            referenceId = referenceMappings.get(key);
            linked = true;
            break;
          }
        }

        // Acronym fallback logic
        if (!linked) {
            const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
            const authorMatch = processedCite.match(/^([A-Z]{2,})/);

            if (yearMatch && authorMatch && allReferences.length > 0) {
                const year = yearMatch[1];
                const acronym = authorMatch[1];

                for (const reference of allReferences) {
                    if (reference.originalText.includes(year)) {
                        const authorPart = reference.originalText.split(year)[0];
                        const initials = authorPart.match(/\b[A-Z]/g)?.join('');

                        if (initials === acronym) {
                            referenceId = reference.referenceId;
                            linked = true;
                            break;
                        }
                    }
                }
            }
        }

        if (linked) {
            const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
            if (yearMatch) {
              const authorPart = processedCite.substring(0, yearMatch.index);
              const yearPart = yearMatch[1];
              const trailingPart = processedCite.substring(yearMatch.index + yearMatch[0].length);

              // Re-add the prefix if it was stripped, so it stays visible
              const originalPrefix = trimmed.substring(0, trimmed.length - processedCite.length);

              linkedParts.push(
                originalPrefix + authorPart,
                `<a href="#${referenceId}" class="in-text-citation">${yearPart}</a>`,
                linkTrailingYears(trailingPart, authorPart, text.substring(0, match.index),
                                  referenceMappings, formatType)
              );
            } else {
              linkedParts.push(`<a href="#${referenceId}" class="in-text-citation">${trimmed}</a>`);
            }
        } else {
            linkedParts.push(trimmed);
        }

        if (index < subCitations.length - 1) linkedParts.push('; ');
      });

      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: `(${linkedParts.join('')})`
      });
    }

    // Apply replacements in reverse order
    if (replacements.length > 0) {
      let newHTML = text;
      for (let i = replacements.length - 1; i >= 0; i--) {
        const repl = replacements[i];
        newHTML = newHTML.substring(0, repl.start) + repl.replacement + newHTML.substring(repl.end);
      }

      // Replace text node with HTML
      const span = document.createElement('span');
      span.innerHTML = newHTML;
      textNode.parentNode.replaceChild(span, textNode);

      // Unwrap the span
      while (span.firstChild) {
        span.parentNode!.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  });

  return tempDiv.innerHTML;
}
