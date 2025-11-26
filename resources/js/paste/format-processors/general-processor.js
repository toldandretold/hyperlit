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

        // Extract content, removing the "N. " prefix
        const content = pElement.innerHTML.trim().replace(/^\s*\d+[\.)]\s*/, '');

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

        // Remove the paragraph so it doesn't appear in main content
        pElement.remove();
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

    const refHeadings = /^(references|bibliography|notes|footnotes|sources)$/i;
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
        referenceSectionStartIndex = i;
        console.log(`  - Found reference section at index ${i}: "${el.textContent.trim()}"`);
        break;
      }
    }

    let elementsToScan = [];
    if (referenceSectionStartIndex !== -1) {
      // Scan only elements after the reference heading
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');
    } else {
      // No heading found - scan all paragraphs in reverse (bottom-up)
      elementsToScan = Array.from(dom.querySelectorAll('p')).reverse();
    }

    console.log(`  - Scanning ${elementsToScan.length} potential reference paragraphs`);

    const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;

    elementsToScan.forEach(p => {
      const text = p.textContent.trim();
      if (!text) return;

      // Stricter check: A reference list item should not contain an in-text citation
      const citeMatch = text.match(inTextCitePattern);
      if (citeMatch) {
        const content = citeMatch[1];
        // Allow if it's just the year, e.g., Author. (2017). Title.
        // Reject if it's more complex, e.g., (see Smith, 2019) or (2017: 143)
        if (content.includes(',') || content.includes(':') || /[a-zA-Z]{2,}/.test(content)) {
          return; // This is a body paragraph, not a reference item
        }
      }

      // Original check for reference-like structure (year appears early)
      const yearMatch = text.match(/(\d{4}[a-z]?)/);
      if (!yearMatch || yearMatch.index > 150) {
        return;
      }

      // This looks like a reference - extract it
      // Reference key generation is handled by footnoteReferenceExtractor.js
      // We just mark it as a potential reference here
      references.push({
        content: p.outerHTML,
        originalText: text,
        type: 'html-paragraph',
        needsKeyGeneration: true  // Flag for later processing
      });
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
