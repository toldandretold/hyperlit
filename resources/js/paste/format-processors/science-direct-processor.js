/**
 * Science Direct Format Processor
 * Handles Science Direct content with XOCS data attributes
 *
 * Key features:
 * - Extracts references from <span class="reference"> elements
 * - Converts anchor citation links to proper reference links
 * - Maps bib* IDs to sref* reference IDs
 */

import { BaseFormatProcessor } from './base-processor.js';
import { unwrap, wrapLooseNodes } from '../utils/dom-utils.js';

export class ScienceDirectProcessor extends BaseFormatProcessor {
  constructor() {
    super('science-direct');
    this.bibIdToRefMap = new Map(); // Maps bib69 → reference object
  }


  /**
   * Extract footnotes from Science Direct structure
   * Science Direct typically doesn't use traditional footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    console.log('📚 ScienceDirect: Science Direct typically uses inline references, not footnotes');
    return [];
  }

  /**
   * Extract references from Science Direct bibliography
   * Science Direct uses <span class="reference"> elements with complex nested structure
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    console.log('📚 ScienceDirect: Looking for references');

    // Strategy 1: Find <span class="reference"> elements (primary Science Direct pattern)
    const referenceSpans = dom.querySelectorAll('span.reference[id^="sref"]');

    if (referenceSpans.length > 0) {
      console.log(`📚 ScienceDirect: Found ${referenceSpans.length} reference spans`);

      referenceSpans.forEach(refSpan => {
        const refId = refSpan.id; // e.g., "sref27"

        // Clone to avoid modifying original DOM
        const clone = refSpan.cloneNode(true);

        // Remove external links, PDF buttons, and other non-content elements
        clone.querySelectorAll('.ReferenceLinks, a.pdf, a[target="_blank"], svg').forEach(el => el.remove());

        // Remove inline styles
        clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

        // Get clean content
        const htmlContent = clone.innerHTML.trim();
        const text = clone.textContent.trim();

        // Find corresponding anchor/label to get the bibId
        // Look for anchor with href pointing back to this reference
        const parentLi = refSpan.closest('li');
        let bibId = null;

        if (parentLi) {
          // Look for anchor with id like "ref-id-bibXX" or similar
          const labelAnchor = parentLi.querySelector('span.label a.anchor');
          if (labelAnchor) {
            const hrefMatch = labelAnchor.getAttribute('href');
            if (hrefMatch && hrefMatch.startsWith('#bbib')) {
              // Extract bibId from #bbibXX -> bibXX
              bibId = hrefMatch.substring(1).replace('bbib', 'bib');
            }
          }

          // Also check for data-xocs-content-id attributes
          if (!bibId) {
            const xocsAnchor = parentLi.querySelector('a[data-xocs-content-id^="bib"]');
            if (xocsAnchor) {
              bibId = xocsAnchor.getAttribute('data-xocs-content-id');
            }
          }
        }

        // Fallback: try to extract bibId from refId (sref27 -> bib27)
        if (!bibId) {
          const numMatch = refId.match(/\d+/);
          if (numMatch) {
            bibId = `bib${numMatch[0]}`;
          }
        }

        // Check if it looks like a valid reference (contains text and reasonable length)
        if (text.length > 20) {
          const reference = {
            content: htmlContent,
            originalText: text,
            type: 'science-direct',
            needsKeyGeneration: true,
            refId: refId, // Store the actual reference ID (sref27)
            bibId: bibId  // Store the citation link ID (bib27)
          };

          references.push(reference);

          // Map bibId to reference for citation linking
          if (bibId) {
            this.bibIdToRefMap.set(bibId, reference);
          }
        }
      });
    }

    // Strategy 2: Fallback - Look for list items with reference-like content
    if (references.length === 0) {
      console.log('📚 ScienceDirect: No reference spans found, searching for reference list items');

      // Look for sections with "References" or "Bibliography" heading
      const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');

      for (const heading of headings) {
        if (/references|bibliography/i.test(heading.textContent.trim())) {
          console.log(`📚 ScienceDirect: Found references section: "${heading.textContent.trim()}"`);

          let nextElement = heading.nextElementSibling;
          while (nextElement) {
            if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
              break; // Hit another heading
            }

            // Look for list items
            if (nextElement.tagName === 'UL' || nextElement.tagName === 'OL') {
              const listItems = nextElement.querySelectorAll('li');

              listItems.forEach((item, index) => {
                const clone = item.cloneNode(true);
                clone.querySelectorAll('.ReferenceLinks, a.pdf, a[target="_blank"], svg').forEach(el => el.remove());
                clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

                const text = clone.textContent.trim();
                const htmlContent = clone.innerHTML.trim();

                // Check if it looks like a reference (contains year)
                const yearMatch = text.match(/\d{4}[a-z]?/);
                if (yearMatch && text.length > 20) {
                  references.push({
                    content: htmlContent,
                    originalText: text,
                    type: 'science-direct-list',
                    needsKeyGeneration: true
                  });

                  console.log(`📚 ScienceDirect: Extracted reference from list: "${text.substring(0, 60)}..."`);
                }
              });
            }

            nextElement = nextElement.nextElementSibling;
          }
        }
      }
    }

    console.log(`📚 ScienceDirect: Total references extracted: ${references.length}`);
    return references;
  }

  /**
   * Transform structure - remove bibliography sections and unwrap containers
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 ScienceDirect: Applying structure transformation');

    // 1. Remove reference sections from main content
    const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach(heading => {
      const headingText = heading.textContent.trim().toLowerCase();
      if (/^(references|bibliography|works cited)$/i.test(headingText)) {
        let nextElement = heading.nextElementSibling;
        heading.remove();

        while (nextElement) {
          const next = nextElement.nextElementSibling;
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            break;
          }
          nextElement.remove();
          nextElement = next;
        }
      }
    });

    // 2. Unwrap all container divs
    const containers = Array.from(
      dom.querySelectorAll('div, article, section, main, header, footer, aside, nav, button')
    );

    // Process in reverse order (children before parents)
    containers.reverse().forEach(container => {
      wrapLooseNodes(container);
      unwrap(container);
    });

    // 3. Also unwrap <font> tags
    dom.querySelectorAll('font').forEach(unwrap);

    console.log('📚 ScienceDirect: Transformation complete');
  }

  /**
   * Override linkCitations to convert Science Direct citation links
   * Science Direct uses data-xocs-content-id="bib*" for citations (not href)
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    console.log('📚 ScienceDirect: Converting Science Direct citation links...');

    // Find all Science Direct citation links using data-xocs-content-id
    // (clipboard HTML doesn't include href="#bib*", only the data attribute)
    const citationLinks = dom.querySelectorAll('a[data-xocs-content-id^="bib"]');
    console.log(`📚 ScienceDirect: Found ${citationLinks.length} citation links`);
    let convertedCount = 0;
    let failedCount = 0;

    citationLinks.forEach(link => {
      const bibId = link.getAttribute('data-xocs-content-id'); // e.g., "bib69"

      // Look up the reference for this bibId
      const reference = this.bibIdToRefMap.get(bibId);

      if (reference && reference.referenceId) {
        // Extract citation text
        const citText = link.textContent.trim();

        // Convert to proper reference link
        link.setAttribute('href', `#${reference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');
        link.textContent = citText;

        // Remove Science Direct-specific attributes
        link.removeAttribute('data-sd-ui-side-panel-opener');
        link.removeAttribute('data-xocs-content-type');
        link.removeAttribute('data-xocs-content-id');
        link.removeAttribute('name');

        convertedCount++;
      } else {
        // Reference not found - keep the link as plain text
        const citText = link.textContent.trim();
        const textNode = document.createTextNode(citText);
        link.replaceWith(textNode);
        console.warn(`⚠️ ScienceDirect: Reference not found for ${bibId}, converted to plain text: "${citText}"`);
        failedCount++;
      }
    });

    console.log(`  - Converted ${convertedCount} Science Direct citation links, ${failedCount} failed`);
  }
}
