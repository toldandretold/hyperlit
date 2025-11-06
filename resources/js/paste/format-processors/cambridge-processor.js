/**
 * Cambridge Processor
 * Handles Cambridge University Press content with specific structural patterns
 *
 * Key features:
 * - Converts `.xref.fn` links to simple <sup> tags
 * - Extracts footnotes from `[id^="reference-"][id$="-content"]` divs
 * - Normalizes to "N. Content" format for compatibility with general heuristic
 */

import { BaseFormatProcessor } from './base-processor.js';
import { wrapLooseNodes, unwrap } from '../utils/dom-utils.js';

export class CambridgeProcessor extends BaseFormatProcessor {
  constructor() {
    super('cambridge');
  }

  /**
   * Extract footnotes from Cambridge-specific structure
   * Cambridge footnotes have a complex nested structure that needs normalization
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = new Map();

    console.log('📚 Cambridge: Initial structure check:');
    console.log('  - .xref.fn links:', dom.querySelectorAll('.xref.fn').length);
    console.log('  - reference-*-content divs:', dom.querySelectorAll('[id^="reference-"][id$="-content"]').length);

    // STEP 1: Simplify in-text footnote links
    // Convert <a class="xref fn"><span>Footnote </span><sup>1</sup></a> → <sup>1</sup>
    const footnoteLinks = dom.querySelectorAll('.xref.fn, a[href^="#fn"]');
    console.log(`📚 Cambridge: Found ${footnoteLinks.length} in-text footnote links`);

    footnoteLinks.forEach((link, index) => {
      const sup = link.querySelector('sup');
      if (sup) {
        const identifier = sup.textContent.trim();
        // Create a clean <sup> with fn-count-id attribute
        const cleanSup = document.createElement('sup');
        cleanSup.setAttribute('fn-count-id', identifier);
        cleanSup.textContent = identifier;

        // Replace the entire link with just the <sup>
        link.replaceWith(cleanSup);
        console.log(`📚 Cambridge: Simplified in-text ref ${index + 1}: ${identifier}`);
      }
    });

    // STEP 2: Convert footnote definitions to simple "N. Content" paragraphs
    // Convert <div id="reference-65-content"><p><span><sup>65</sup></span> Content</p></div> → <p>65. Content</p>
    const footnoteContainers = dom.querySelectorAll('[id^="reference-"][id$="-content"]');
    console.log(`📚 Cambridge: Found ${footnoteContainers.length} footnote definition containers`);

    footnoteContainers.forEach((container, index) => {
      const idMatch = container.id.match(/reference-(\d+)-content/);
      if (!idMatch) {
        console.log(`📚 Cambridge: Container ${index + 1} has no ID pattern`);
        return;
      }

      const footnoteNum = idMatch[1];

      // Extract content from nested structure
      const paragraph = container.querySelector('p.p, p');
      if (!paragraph) {
        console.log(`📚 Cambridge: No paragraph in footnote ${footnoteNum}`);
        return;
      }

      // Clone and remove label span
      const cleanParagraph = paragraph.cloneNode(true);
      const labelSpan = cleanParagraph.querySelector('span.label');
      if (labelSpan) labelSpan.remove();

      const content = cleanParagraph.innerHTML.trim();

      // Create unique IDs for this footnote
      const uniqueId = this.generateFootnoteId(bookId, footnoteNum);
      const uniqueRefId = this.generateFootnoteRefId(bookId, footnoteNum);

      // Store footnote with "N. Content" format
      footnotes.push(this.createFootnote(
        uniqueId,
        `${footnoteNum}. ${content}`,
        footnoteNum,
        uniqueRefId,
        'cambridge-normalized'
      ));

      footnoteMappings.set(footnoteNum, { uniqueId, uniqueRefId });

      // Replace container with simple paragraph (for intermediate processing)
      const simpleParagraph = document.createElement('p');
      simpleParagraph.innerHTML = `${footnoteNum}. ${content}`;
      container.replaceWith(simpleParagraph);

      console.log(`📚 Cambridge: Converted footnote ${footnoteNum} to "N. Content" format`);

      // Remove the paragraph so it doesn't appear in main content
      simpleParagraph.remove();
    });

    console.log(`📚 Cambridge: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Extract references from Cambridge content
   * Cambridge typically doesn't have special reference formatting beyond general patterns
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    // Cambridge references usually follow standard patterns
    // We can rely on the general reference extraction logic
    console.log('📚 Cambridge: Using general reference extraction patterns');

    // Look for reference-like paragraphs (containing years, appearing after certain headings, etc.)
    const allElements = Array.from(dom.children);
    let referenceSectionStartIndex = -1;

    const refHeadings = /^(references|bibliography|notes|footnotes|sources)$/i;
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
        referenceSectionStartIndex = i;
        break;
      }
    }

    let elementsToScan = [];
    if (referenceSectionStartIndex !== -1) {
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');
    } else {
      elementsToScan = Array.from(dom.querySelectorAll('p')).reverse();
    }

    elementsToScan.forEach(p => {
      const text = p.textContent.trim();
      if (!text) return;

      // Check for year pattern
      const yearMatch = text.match(/(\d{4}[a-z]?)/);
      if (!yearMatch || yearMatch.index > 150) {
        return;
      }

      // This looks like a reference
      references.push({
        content: p.outerHTML,
        originalText: text,
        type: 'cambridge-reference',
        needsKeyGeneration: true
      });
    });

    console.log(`📚 Cambridge: Extracted ${references.length} references`);

    return references;
  }

  /**
   * Transform document structure
   * For Cambridge, most transformation is done during footnote extraction
   * Here we apply the general structure-preserving transformation
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 Cambridge: Applying general structure transformation');

    // Find and process all container elements
    const containers = Array.from(
      dom.querySelectorAll('div, article, section, main, header, footer, aside, nav, button')
    );

    // Process in reverse order (children before parents)
    containers.reverse().forEach(container => {
      // Wrap any loose text/inline nodes
      wrapLooseNodes(container);

      // Unwrap the container itself
      unwrap(container);
    });

    // Also unwrap <font> tags
    dom.querySelectorAll('font').forEach(unwrap);

    console.log(`📚 Cambridge: Transformation complete`);
  }

  /**
   * Override linkFootnotes to convert simplified <sup> tags to proper linked footnotes
   * Cambridge creates <sup fn-count-id="N">N</sup> during extraction
   * Need to convert to <sup id="refId" fn-count-id="N"><a href="#footnoteId" class="footnote-ref">N</a></sup>
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`📚 Cambridge: Linking ${footnotes.length} footnotes to in-text references`);

    // Find all simplified <sup fn-count-id="N"> tags created during extraction
    const supTags = dom.querySelectorAll('sup[fn-count-id]');
    let linkedCount = 0;

    supTags.forEach(sup => {
      const identifier = sup.getAttribute('fn-count-id');
      const footnote = footnotes.find(fn => fn.originalIdentifier === identifier);

      if (footnote) {
        // Add ID for backlinking
        sup.id = footnote.refId;

        // Create link inside sup
        const link = document.createElement('a');
        link.href = `#${footnote.footnoteId}`;
        link.className = 'footnote-ref';
        link.textContent = identifier;

        // Replace sup content with link
        sup.textContent = '';
        sup.appendChild(link);

        linkedCount++;
      } else {
        console.warn(`⚠️ Cambridge: Could not find footnote for identifier ${identifier}`);
      }
    });

    console.log(`  - Linked ${linkedCount} Cambridge footnote references`);
  }
}
