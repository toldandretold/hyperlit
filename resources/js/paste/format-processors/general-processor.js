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

    // 1. Find all footnote references - both <sup> tags and <a href="#ftnN"> links
    const refIdentifiers = new Set();

    // 1a. Check <sup> tags with numeric content
    const supElements = dom.querySelectorAll('sup');
    supElements.forEach(sup => {
      const identifier = sup.textContent.trim() || sup.getAttribute('fn-count-id');
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);
      }
    });

    // 1b. Check anchor links with #ftn patterns (e.g., <a href="#ftn1">[1]</a> or <a href="...#ftn1">)
    const anchorLinks = dom.querySelectorAll('a[href]');
    anchorLinks.forEach(link => {
      const href = link.getAttribute('href');
      const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
      if (fragmentMatch) {
        refIdentifiers.add(fragmentMatch[1]);
      }
    });

    console.log(`  - Found ${refIdentifiers.size} footnote references (from <sup> and anchor links)`);

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

    // 2c. Fallback: Find definitions with anchor-based IDs (<a name="fn1">, <a name="ftn1">, <a name="_ftn1">, etc.)
    // Common in academic PDFs and web exports
    if (refIdentifiers.size > 0) {
      const anchorDefsFound = [];
      dom.querySelectorAll('a[name^="fn"], a[name^="ftn"], a[name^="_ftn"], a[name^="note"], a[name^="_edn"]').forEach(anchor => {
        const name = anchor.getAttribute('name');
        const numMatch = name.match(/(\d+)/);
        if (numMatch && refIdentifiers.has(numMatch[1]) && !potentialParagraphDefs.has(numMatch[1])) {
          const container = anchor.closest('p, li, div');
          if (container) {
            potentialParagraphDefs.set(numMatch[1], container);
            anchorDefsFound.push(numMatch[1]);
          }
        }
      });
      if (anchorDefsFound.length > 0) {
        console.log(`  - Found ${anchorDefsFound.length} additional definitions via anchor names`);
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
   * Extract references - prioritizes anchor-based detection over heuristics
   * Strategy:
   * 1. Find all paragraphs with <a name="ref..."> anchors - these ARE the references
   * 2. Only fall back to heuristics if no anchor-based refs found
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    // STRATEGY 1: Anchor-based detection (most reliable)
    // Find all paragraphs containing <a name="ref..."> anchors
    const anchorRefs = dom.querySelectorAll('a[name^="ref"]');
    if (anchorRefs.length > 0) {
      console.log(`  - 🎯 Found ${anchorRefs.length} anchor-based references (using anchor detection)`);

      anchorRefs.forEach(anchor => {
        const container = anchor.closest('p, li, div');
        if (!container) return;

        const ref = {
          content: container.outerHTML,
          originalText: container.textContent.trim(),
          type: 'anchor-based',
          needsKeyGeneration: true,
          originalAnchorId: anchor.getAttribute('name')
        };

        references.push(ref);
      });

      console.log(`  - Extracted ${references.length} anchor-based references`);
      return references;
    }

    // STRATEGY 2: Heuristic-based detection (fallback)
    console.log(`  - No anchor-based references found, using heuristic detection`);

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
              const ref = {
                content: `<p>${part}</p>`,
                originalText: text,
                type: 'html-br-split',
                needsKeyGeneration: true
              };

              extracted.push(ref);
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
        const ref = {
          content: p.outerHTML,
          originalText: text,
          type: 'html-paragraph',
          needsKeyGeneration: true
        };

        extracted.push(ref);
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
