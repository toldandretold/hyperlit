/**
 * General Format Processor
 * Fallback processor for unrecognized formats
 * Uses heuristic-based extraction with minimal assumptions about structure
 */

import { BaseFormatProcessor } from './base-processor.js';
import { wrapLooseNodes, unwrap } from '../utils/dom-utils.js';

export class GeneralProcessor extends BaseFormatProcessor {
  constructor() {
    super('general');
  }

  /**
   * Extract footnotes using heuristic pattern matching
   * Looks for:
   * - <sup> tags with numeric content
   * - Paragraphs starting with "N. " or "N) "
   * - Markdown-style footnotes [^N]
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = new Map();

    // 1. Find all <sup> tags to identify referenced footnotes
    const supElements = dom.querySelectorAll('sup');
    const refIdentifiers = new Set();

    supElements.forEach(sup => {
      const identifier = sup.textContent.trim() || sup.getAttribute('fn-count-id');
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);
      }
    });

    console.log(`  - Found ${refIdentifiers.size} footnote references in <sup> tags`);

    // 2. Find potential footnote definitions (paragraphs starting with "N. ")
    const potentialParagraphDefs = new Map();

    dom.querySelectorAll('p').forEach(p => {
      const pText = p.textContent.trim();
      const match = pText.match(/^(\d+)[\.)\s:]/); // Match "1.", "1)", "1 ", or "1:"

      if (match && pText.length > match[0].length) {
        potentialParagraphDefs.set(match[1], p);
      }
    });

    console.log(`  - Found ${potentialParagraphDefs.size} potential paragraph definitions`);

    // 2b. Fallback: Find definitions in <li> elements (common web pattern)
    // Many sites put footnotes in <ul><li> where each <li> starts with <a>number</a>
    if (refIdentifiers.size > 0) {
      const liDefsFound = [];
      dom.querySelectorAll('li').forEach(li => {
        // Strategy A: <li> starts with <a> containing a number (e.g. <a href="...">7</a>)
        const firstAnchor = li.querySelector('a');
        if (firstAnchor) {
          const anchorText = firstAnchor.textContent.trim();
          if (/^\d+$/.test(anchorText) && refIdentifiers.has(anchorText) && !potentialParagraphDefs.has(anchorText)) {
            potentialParagraphDefs.set(anchorText, li);
            liDefsFound.push(anchorText);
            return;
          }
        }
        // Strategy B: <li> text starts with number pattern (same as <p> check)
        const liText = li.textContent.trim();
        const match = liText.match(/^(\d+)[\.)\s:]/);
        if (match && liText.length > match[0].length && refIdentifiers.has(match[1]) && !potentialParagraphDefs.has(match[1])) {
          potentialParagraphDefs.set(match[1], li);
          liDefsFound.push(match[1]);
        }
      });
      if (liDefsFound.length > 0) {
        console.log(`  - Found ${liDefsFound.length} additional definitions in <li> elements`);
      }
    }

    // 3. Sanity check: Do all references have definitions?
    let allRefsHaveDefs = refIdentifiers.size > 0;
    for (const refId of refIdentifiers) {
      if (!potentialParagraphDefs.has(refId)) {
        allRefsHaveDefs = false;
        console.log(`  - ⚠️ Reference ${refId} has no matching definition`);
        break;
      }
    }

    // 4. If sanity check passes, extract footnotes
    if (allRefsHaveDefs && refIdentifiers.size > 0) {
      console.log(`  - ✅ All references have definitions, extracting footnotes`);

      for (const identifier of refIdentifiers) {
        const pElement = potentialParagraphDefs.get(identifier);
        if (!pElement) continue;

        // Extract content, removing the number prefix
        // Handles both plain "7." and <a href="...">7</a> patterns
        const content = pElement.innerHTML.trim()
          .replace(/^\s*<a[^>]*>\s*\d+\s*<\/a>\s*/, '')
          .replace(/^\s*\d+[\.)]\s*/, '');

        const uniqueId = this.generateFootnoteId(bookId, identifier);
        const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);

        footnotes.push(this.createFootnote(
          uniqueId,
          content,
          identifier,
          uniqueRefId,
          'html-paragraph-heuristic'
        ));

        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });

        // Remove the element so it doesn't appear in main content
        const parentList = pElement.parentElement;
        pElement.remove();
        // If this was a <li>, clean up empty parent list
        if (parentList && (parentList.tagName === 'UL' || parentList.tagName === 'OL') && parentList.children.length === 0) {
          parentList.remove();
        }
      }
    } else {
      console.log(`  - ℹ️ Heuristic extraction skipped (not all refs have defs or no refs found)`);
    }

    // 5. Fallback: Handle markdown-style footnotes [^1]: content
    const allParagraphs = dom.querySelectorAll('p');
    allParagraphs.forEach(p => {
      const text = p.textContent.trim();
      const markdownFootnoteMatch = text.match(/^\[\^?(\d+)\]\s*:\s*(.+)$/s);

      if (markdownFootnoteMatch) {
        const identifier = markdownFootnoteMatch[1];
        const content = markdownFootnoteMatch[2].trim();

        if (!footnoteMappings.has(identifier)) {
          const uniqueId = this.generateFootnoteId(bookId, identifier);
          const uniqueRefId = this.generateFootnoteRefId(bookId, identifier);

          // Process the content HTML (may contain links), remove the [^1]: part
          const processedContent = p.innerHTML.replace(/^\[\^?\d+\]\s*:\s*/, '');

          footnotes.push(this.createFootnote(
            uniqueId,
            processedContent,
            identifier,
            uniqueRefId,
            'markdown-html'
          ));

          footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
          p.remove();
        }
      }
    });

    return footnotes;
  }

  /**
   * Extract references using heuristic pattern matching
   * Looks for:
   * - Paragraphs containing years (YYYY)
   * - Paragraphs after "References" or "Bibliography" heading
   * - Handles <br>-separated references within a single <p> (from markdown conversion)
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    // Find "References" or "Bibliography" section
    const allElements = Array.from(dom.children);
    let referenceSectionStartIndex = -1;

    const refHeadings = /^(references|bibliography|works cited|sources)$/i;
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
        referenceSectionStartIndex = i;
        console.log(`  - Found reference section at index ${i}: "${el.textContent.trim()}"`);
        break;
      }
    }

    // Helper: Check if text looks like the start of a reference
    const looksLikeReferenceStart = (text) => {
      if (!text || text.length < 10) return false;
      const trimmed = text.trim();
      // Starts with capital letter (including Unicode like Ö, É) or numbered format [1]
      const startsWithAuthor = /^[A-ZÖÄÜÉÈÊËÀÂÎÏÔÛÇ]/.test(trimmed);
      const startsWithNumber = /^\[\d+\]/.test(trimmed);
      const hasYear = /\d{4}/.test(trimmed);
      return (startsWithAuthor || startsWithNumber) && hasYear;
    };

    // Helper: Extract individual references from a paragraph (handles <br> separated refs)
    const extractRefsFromParagraph = (p, isInRefSection) => {
      const extracted = [];
      const html = p.innerHTML;

      // Check if paragraph contains <br> tags
      if (/<br\s*\/?>/i.test(html)) {
        // Split on <br> tags
        const parts = html.split(/<br\s*\/?>/i).map(s => s.trim()).filter(s => s);

        // Check if multiple parts look like separate references
        const refLikeParts = parts.filter(part => {
          const temp = document.createElement('div');
          temp.innerHTML = part;
          return looksLikeReferenceStart(temp.textContent);
        });

        // Only split if most parts look like references (avoid splitting body paragraphs)
        if (isInRefSection || refLikeParts.length >= parts.length * 0.7) {
          parts.forEach(part => {
            const temp = document.createElement('div');
            temp.innerHTML = part;
            const text = temp.textContent.trim();

            if (looksLikeReferenceStart(text)) {
              extracted.push({
                content: `<p>${part}</p>`,
                originalText: text,
                type: 'html-br-split',
                needsKeyGeneration: true
              });
            }
          });

          if (extracted.length > 0) {
            console.log(`  - Split paragraph into ${extracted.length} references (was <br>-separated)`);
            return extracted;
          }
        }
      }

      // No splitting - treat as single reference if it looks like one
      const text = p.textContent.trim();
      if (looksLikeReferenceStart(text)) {
        extracted.push({
          content: p.outerHTML,
          originalText: text,
          type: 'html-paragraph',
          needsKeyGeneration: true
        });
      }

      return extracted;
    };

    let elementsToScan = [];
    let isInRefSection = false;

    if (referenceSectionStartIndex !== -1) {
      // Scan only elements after the reference heading
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');
      isInRefSection = true;
    } else {
      // No heading found - scan all paragraphs in reverse (bottom-up)
      elementsToScan = Array.from(dom.querySelectorAll('p')).reverse();
    }

    console.log(`  - Scanning ${elementsToScan.length} potential reference paragraphs`);

    const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;

    elementsToScan.forEach(p => {
      const text = p.textContent.trim();
      if (!text) return;

      // Skip if this looks like body text with in-text citations (not a reference list item)
      if (!isInRefSection) {
        const citeMatch = text.match(inTextCitePattern);
        if (citeMatch) {
          const content = citeMatch[1];
          // Reject if it contains author-date citation pattern like (Smith, 2019)
          if (content.includes(',') || /[a-zA-Z]{2,}.*\d{4}/.test(content)) {
            return;
          }
        }
      }

      // Extract references (handles both single refs and <br>-separated refs)
      const refs = extractRefsFromParagraph(p, isInRefSection);
      references.push(...refs);
    });

    console.log(`  - Extracted ${references.length} potential references`);

    return references;
  }

  /**
   * Transform structure: wrap loose nodes and unwrap unnecessary containers
   * This is the "Structure Preserving" strategy from parseGeneralContent()
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log(`  - Applying general structure transformation`);

    // Find and process all container elements (div, article, section, etc.)
    const containers = Array.from(
      dom.querySelectorAll('div, article, section, main, header, footer, aside, nav, button')
    );

    // Process in reverse order (children before parents)
    containers.reverse().forEach(container => {
      // Wrap any loose text/inline nodes in this container
      wrapLooseNodes(container);

      // Unwrap the container itself (move children to parent)
      unwrap(container);
    });

    // Also unwrap <font> tags
    dom.querySelectorAll('font').forEach(unwrap);

    console.log(`  - Unwrapped ${containers.length} containers`);

    // Finally, wrap any loose inline elements left at the top level of dom
    wrapLooseNodes(dom);
    console.log(`  - Wrapped loose inline elements at top level`);
  }
}
