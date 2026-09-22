/**
 * Science Direct Format Processor
 * Handles Science Direct content with XOCS data attributes
 *
 * Key features:
 * - Extracts references from <span class="reference"> elements
 * - Extracts footnotes from <dl class="footnote"> definition blocks
 * - Converts anchor citation links to proper reference links
 * - Maps bib* IDs to sref* reference IDs
 *
 * ScienceDirect hosts BOTH citation styles and they share one anchor vocabulary.
 * An author-date article marks its in-text citations
 *   <a data-xocs-content-type="reference" data-xocs-content-id="b0120">
 * and a footnote article marks its NOTE markers with the very same content-type,
 * only ided `fnN`:
 *   <a data-xocs-content-type="reference" data-xocs-content-id="fn1"><sup>1</sup></a>
 * so the id PREFIX — `b`/`bib` vs `fn` — is the only thing separating a
 * bibliography link from a footnote marker. Until 2026-09 only author-date
 * captures had been seen, so `extractFootnotes` returned [] unconditionally and
 * `convertCitationLinks` swallowed every `fn` anchor as a failed bibliography
 * lookup, replacing it with its own text: all 109 notes of a Journal of
 * Historical Geography article were lost and each marker became a bare digit
 * glued to the sentence it followed ("…communist government.1 Five years…").
 * Fixture: tests/paste/fixtures/clipboard/sciencedirect-footnotes.html.
 */

import { BaseFormatProcessor } from './base-processor';
import { isReferenceHeading } from '../utils/reference-headings';
import {
  unwrapContainers,
  cloneAndClean,
  isValidReference
} from '../utils/transform-helpers';
import { createFootnoteSupElement } from '../utils/footnote-linker';

export class ScienceDirectProcessor extends BaseFormatProcessor {
  [key: string]: any;
  constructor() {
    super('science-direct');
    this.bibIdToRefMap = new Map(); // Maps bib69 → reference object
    this.fnIdToFootnote = new Map(); // Maps fn1 → footnote object
    this.extractedFootnotes = []; // Same objects as the returned array, kept for the in-note citation pass
  }


  /**
   * Extract footnotes from Science Direct structure.
   *
   * Definitions live in a `.footnotes` block as one <dl class="footnote"> per
   * note:
   *   <dl class="footnote">
   *     <dt class="footnote-label"><a href="…#bfn1"><sup>1</sup></a></dt>
   *     <dd class="footnote-detail"><div id="ntpara0015">…</div></dd>
   *   </dl>
   * The label's fragment is the MARKER's `name` (`bfn1`); the marker's own id is
   * `fn1` — that is the key the in-text anchors are matched on.
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom: HTMLElement, bookId: string) {
    const footnotes: unknown[] = [];
    const blocks = dom.querySelectorAll('dl.footnote');

    blocks.forEach((block: Element) => {
      const label = block.querySelector('dt.footnote-label') || block.querySelector('dt');
      const labelAnchor = label ? label.querySelector('a[href*="#"]') : null;

      const detail = block.querySelector('dd.footnote-detail') || block.querySelector('dd');
      if (!detail) return;

      // An UNLABELLED note carries no marker anywhere in the body — SD uses one
      // for article-level statements ("This article is part of a special issue
      // entitled…"). Minting a footnote nothing can point at would bury it in
      // the Notes section, so keep the text as prose. It has to become a real
      // <p>, not a left-alone <dl>: the surviving definition list ends up nested
      // INSIDE a paragraph by cleanup, and a block inside a <p> splits into an
      // empty tagged node plus an untagged orphan when the paste is stored.
      if (!label || !labelAnchor) {
        this.replaceWithParagraph(block, detail);
        return;
      }

      const identifier = this.footnoteIdentifierFrom(label, labelAnchor);
      if (!identifier) {
        this.replaceWithParagraph(block, detail);
        return;
      }

      // Keep <a> elements: SD footnotes cite bare URLs and the anchor's TEXT is
      // that URL, so the `a[target="_blank"]` removal the reference extractor
      // does would delete the citation's only locator.
      const clone = cloneAndClean(detail, ['.ReferenceLinks', 'svg']);
      const content = this.flattenReferenceContent(clone);
      if (!content) return;

      const footnoteId = this.generateFootnoteId(bookId, identifier);
      const footnote = this.createFootnote(
        footnoteId,
        content,
        identifier,
        this.generateFootnoteRefId(footnoteId),
        'science-direct',
      );

      footnotes.push(footnote);
      this.fnIdToFootnote.set(`fn${identifier}`, footnote);
      block.remove();
    });

    console.log(`📚 ScienceDirect: Extracted ${footnotes.length} footnotes from ${blocks.length} definition blocks`);
    this.extractedFootnotes = footnotes;
    return footnotes;
  }

  /**
   * Swap a footnote <dl> we are NOT extracting for a plain paragraph of its
   * detail text, so no definition list survives into the stored content.
   */
  replaceWithParagraph(block: Element, detail: Element) {
    const content = this.flattenReferenceContent(cloneAndClean(detail, ['.ReferenceLinks', 'svg']));
    if (!content) {
      block.remove();
      return;
    }
    const paragraph = document.createElement('p');
    paragraph.innerHTML = content;
    block.replaceWith(paragraph);
  }

  /**
   * The displayed note number for a <dt class="footnote-label">.
   * Prefers the visible <sup>, falling back to the digits in the label's
   * `#bfnN` fragment. Non-numeric labels (†, ☆) are refused — the in-text
   * anchors are keyed `fnN`, so a symbol has nothing to match against.
   */
  footnoteIdentifierFrom(label: Element, labelAnchor: Element): string | null {
    const sup = label.querySelector('sup');
    const labelText = (sup || labelAnchor).textContent?.trim() ?? '';
    if (/^\d+$/.test(labelText)) return String(parseInt(labelText, 10));

    const fragment = (labelAnchor.getAttribute('href') || '').split('#')[1] || '';
    const fragmentDigits = fragment.match(/^b?fn-?(\d+)$/i)?.[1];
    return fragmentDigits ? String(parseInt(fragmentDigits, 10)) : null;
  }

  /**
   * Link in-text footnote markers structurally — `data-xocs-content-id="fn1"`
   * maps EXACTLY to one extracted note, so no text scanning is involved (and
   * none is wanted: the base scanner would read sentence-final digits in a
   * 109-note article as phantom markers).
   *
   * Runs at stage 7, after cleanup: cleanup strips style/class/id but leaves
   * data attributes, so the anchors are still identifiable here.
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Extracted footnotes
   */
  linkFootnotes(dom: HTMLElement, footnotes: unknown[]) {
    if (!footnotes || footnotes.length === 0) return;

    const markers = dom.querySelectorAll('a[data-xocs-content-id^="fn"]');
    let linked = 0;
    let orphaned = 0;

    markers.forEach((marker: Element) => {
      const contentId = marker.getAttribute('data-xocs-content-id') || '';
      const footnote = this.fnIdToFootnote.get(contentId);
      const target = marker.parentElement && marker.parentElement.tagName === 'SUP'
        ? marker.parentElement
        : marker;

      if (footnote) {
        target.replaceWith(createFootnoteSupElement(footnote.refId, footnote.originalIdentifier));
        linked++;
        return;
      }

      // No definition (a partial selection that missed the notes block). Keep
      // the number superscripted rather than unwrapping it — a bare digit
      // dropped into the text reads as part of the sentence — but never ship
      // the live sciencedirect.com anchor.
      const orphanSup = document.createElement('sup');
      orphanSup.textContent = marker.textContent?.trim() ?? '';
      target.replaceWith(orphanSup);
      orphaned++;
    });

    console.log(`📚 ScienceDirect: Linked ${linked} footnote markers (${orphaned} without a definition)`);
  }

  /**
   * Extract references from Science Direct bibliography
   * Science Direct uses <span class="reference"> elements with complex nested structure
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom: any, bookId: any) {
    const references: any[] = [];

    console.log('📚 ScienceDirect: Looking for references');

    // Strategy 1: Find <span class="reference"> elements (primary Science Direct pattern)
    // Note: Different articles use different id prefixes (sref, h, etc.)
    const referenceSpans = dom.querySelectorAll('span.reference[id]');

    if (referenceSpans.length > 0) {
      console.log(`📚 ScienceDirect: Found ${referenceSpans.length} reference spans`);

      referenceSpans.forEach((refSpan: any) => {
        const refId = refSpan.id; // e.g., "sref27"

        // Clone and clean element
        const clone = cloneAndClean(refSpan, ['.ReferenceLinks', 'a.pdf', 'a[target="_blank"]', 'svg']);

        // Get clean content (flatten nested block elements)
        const htmlContent = this.flattenReferenceContent(clone);
        const text = clone.textContent.trim();

        // Find corresponding anchor/label to get the bibId
        // Look for anchor with href pointing back to this reference
        const parentLi = refSpan.closest('li');
        let bibId: any = null;

        if (parentLi) {
          // Look for anchor with id like "ref-id-bibXX" or similar
          const labelAnchor = parentLi.querySelector('span.label a.anchor');
          if (labelAnchor) {
            const hrefMatch = labelAnchor.getAttribute('href');
            if (hrefMatch && hrefMatch.startsWith('#bb')) {
              // Extract bibId: #bbib0120 -> bib0120 OR #bb0120 -> b0120
              // Remove '#b' prefix (2 chars) to get the bibId
              bibId = hrefMatch.substring(2);
            }
          }

          // Also check for data-xocs-content-id attributes (different articles use b*, bib*, etc.)
          if (!bibId) {
            const xocsAnchor = parentLi.querySelector('a[data-xocs-content-id^="b"]');
            if (xocsAnchor) {
              bibId = xocsAnchor.getAttribute('data-xocs-content-id');
            }
          }
        }

        // Fallback: try to extract bibId from refId (h0120 -> b0120, sref27 -> b27)
        if (!bibId) {
          const numMatch = refId.match(/\d+/);
          if (numMatch) {
            bibId = `b${numMatch[0]}`;
          }
        }

        // Check if it looks like a valid reference (contains text and reasonable length)
        if (text.length > 20) {
          const reference = {
            content: htmlContent,
            originalText: text,
            type: 'science-direct',
            needsKeyGeneration: true,
            refId: refId, // Store the actual reference ID (h0120, sref27, etc.)
            bibId: bibId  // Store the citation link ID (b0120, etc.)
          };

          references.push(reference);

          // Map bibId to reference for citation linking
          // Store under multiple ID variations to handle different formats
          if (bibId) {
            this.bibIdToRefMap.set(bibId, reference);
            // Also store "bib" prefix version if we have just "b" (b0120 -> bib0120)
            if (bibId.startsWith('b') && !bibId.startsWith('bib')) {
              this.bibIdToRefMap.set('bi' + bibId, reference);
            }
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
        if (isReferenceHeading(heading.textContent)) {
          console.log(`📚 ScienceDirect: Found references section: "${heading.textContent.trim()}"`);

          let nextElement = heading.nextElementSibling;
          while (nextElement) {
            if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
              break; // Hit another heading
            }

            // Look for list items - handle both direct lists and lists inside wrapper divs
            let listsToProcess: any[] = [];

            if (nextElement.tagName === 'UL' || nextElement.tagName === 'OL') {
              listsToProcess.push(nextElement);
            } else if (nextElement.querySelectorAll) {
              // Look for lists nested inside this element
              const nestedLists = nextElement.querySelectorAll('ul, ol');
              listsToProcess.push(...nestedLists);
            }

            // Process all found lists
            listsToProcess.forEach((list: any) => {
              const listItems = list.querySelectorAll('li');

              listItems.forEach((item: any, index: any) => {
                const clone = cloneAndClean(item, ['.ReferenceLinks', 'a.pdf', 'a[target="_blank"]', 'svg']);

                const text = clone.textContent.trim();
                const htmlContent = this.flattenReferenceContent(clone);

                // Check if it looks like a reference (contains year)
                if (isValidReference(text)) {
                  references.push({
                    content: htmlContent,
                    originalText: text,
                    type: 'science-direct-list',
                    needsKeyGeneration: true
                  });

                  console.log(`📚 ScienceDirect: Extracted reference from list: "${text.substring(0, 60)}..."`);
                }
              });
            });

            nextElement = nextElement.nextElementSibling;
          }
        }
      }
    }

    console.log(`📚 ScienceDirect: Total references extracted: ${references.length}`);
    return references;
  }

  /**
   * Flatten nested block elements in reference content
   * Preserves inline elements (links, em, strong, sup, sub)
   * Converts everything to a single inline text flow suitable for <p> tag
   *
   * @param {HTMLElement} clone - Cloned reference element
   * @returns {string} - Flattened HTML content
   */
  flattenReferenceContent(clone: any) {
    // Elements to preserve as-is (inline formatting)
    const PRESERVE_INLINE = new Set(['A', 'EM', 'I', 'STRONG', 'B', 'SUP', 'SUB']);

    // Block elements that should add spacing when traversed
    const BLOCK_ELEMENTS = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'LI', 'HEADER']);

    /**
     * Recursively flatten node tree
     * @param {Node} node - Current node
     * @param {boolean} addSpaceBefore - Whether to add space before this node
     * @returns {string} - HTML string
     */
    function flattenNode(node: any, addSpaceBefore = false) {
      // Text node - return content with optional leading space
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        // Don't add space if text already starts with space or if text is empty
        if (addSpaceBefore && text && !/^\s/.test(text)) {
          return ' ' + text;
        }
        return text;
      }

      // Element node
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();

        // Preserve inline elements with their tags
        if (PRESERVE_INLINE.has(tagName)) {
          const tempEl = node.cloneNode(false); // Shallow clone (no children)
          let childHtml = '';

          for (let child of node.childNodes) {
            childHtml += flattenNode(child, false);
          }

          tempEl.innerHTML = childHtml;
          return (addSpaceBefore ? ' ' : '') + tempEl.outerHTML;
        }

        // Block elements - flatten children and add spacing
        if (BLOCK_ELEMENTS.has(tagName)) {
          let result = '';
          let isFirst = true;

          for (let child of node.childNodes) {
            const needsSpace = !isFirst && result.trim().length > 0;
            result += flattenNode(child, needsSpace);
            isFirst = false;
          }

          // Add trailing space if this block has content and needs separation
          if (addSpaceBefore && result.trim().length > 0 && !/^\s/.test(result)) {
            result = ' ' + result;
          }

          return result;
        }

        // Other elements (spans, etc.) - just process children
        let result = '';
        for (let child of node.childNodes) {
          result += flattenNode(child, false);
        }
        return result;
      }

      return '';
    }

    const flattened = flattenNode(clone);

    // Clean up excessive whitespace
    return flattened
      .replace(/\s+/g, ' ')  // Multiple spaces → single space
      .replace(/\s+([.,;:])/g, '$1')  // Space before punctuation
      .trim();
  }

  /**
   * Transform structure - remove bibliography sections and unwrap containers
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom: any, bookId: any) {
    console.log('📚 ScienceDirect: Applying structure transformation');

    // 1. Remove reference sections from main content (custom matcher for ScienceDirect)
    const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((heading: any) => {
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

    // 2. Unwrap all container elements
    unwrapContainers(dom);

    // 3. Convert citation links NOW (before cleanup strips data attributes and classes)
    this.convertCitationLinks(dom);

    console.log('📚 ScienceDirect: Transformation complete');
  }

  /**
   * Convert Science Direct citation links to proper reference links
   * MUST be called during transformStructure (before cleanup strips data attributes)
   *
   * Science Direct uses data-xocs-content-id="b*" for citations (not href)
   *
   * @param {HTMLElement} dom - DOM element
   */
  convertCitationLinks(dom: any) {
    console.log('📚 ScienceDirect: Converting Science Direct citation links...');

    const inBody = this.convertCitationAnchorsIn(dom);

    // Footnote bodies were lifted OUT of the DOM at stage 2, before this ran, so
    // a citation living inside a note — "(Lenin, 1920)" in note 2 of the
    // author-date fixture — never passes under the query above and would ship
    // with its live sciencedirect.com anchor intact. Convert those here too:
    // appendStaticSections puts the content back into the DOM at stage 6, in
    // time for linkCitations to swap the temp bibId for the real reference id.
    let inNotes = { converted: 0, failed: 0 };
    this.extractedFootnotes.forEach((footnote: { content: string }) => {
      const temp = document.createElement('div');
      temp.innerHTML = footnote.content;
      const result = this.convertCitationAnchorsIn(temp);
      if (result.converted || result.failed) {
        footnote.content = temp.innerHTML;
        inNotes = { converted: inNotes.converted + result.converted, failed: inNotes.failed + result.failed };
      }
    });

    console.log(
      `  - Converted ${inBody.converted} Science Direct citation links, ${inBody.failed} failed` +
      ` (+${inNotes.converted}/${inNotes.failed} inside footnote text)`,
    );
  }

  /**
   * One citation-anchor conversion pass over a root element.
   *
   * Selector note: it matches on `data-xocs-content-type` ALONE, not
   * `a.anchor[…]` — footnote content has already been through stripAttributes
   * by the time it gets here, so the publisher's `class="anchor"` is gone while
   * the data attributes remain.
   *
   * @param {HTMLElement} root - Element to convert citation anchors within
   * @returns {{converted: number, failed: number}}
   */
  convertCitationAnchorsIn(root: ParentNode) {
    const citationLinks = root.querySelectorAll('a[data-xocs-content-type="reference"]');
    let convertedCount = 0;
    let failedCount = 0;

    citationLinks.forEach((link: any) => {
      const bibId = link.getAttribute('data-xocs-content-id'); // e.g., "b0120"

      // FOOTNOTE markers wear the same content-type as bibliography links and
      // are told apart only by their `fnN` id. They belong to linkFootnotes —
      // falling through to the "reference not found" branch below is what
      // dissolved 109 markers into bare digits.
      if (!bibId || /^fn\d/i.test(bibId)) return;

      // Look up the reference for this bibId
      const reference = this.bibIdToRefMap.get(bibId);

      if (reference) {
        // Extract citation text
        const citText = link.textContent.trim();

        // Store temporary bibId in href (will be updated to actual referenceId later)
        link.setAttribute('href', `#${bibId}`);
        link.setAttribute('class', 'in-text-citation');
        link.setAttribute('data-temp-bibid', bibId); // Mark for later reference ID update
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

    return { converted: convertedCount, failed: failedCount };
  }

  /**
   * Override linkCitations to update temporary bibId hrefs with actual reference IDs
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom: any, references: any) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    // Now update all ScienceDirect citation links that have temporary bibId hrefs
    // Note: cleanup stripped the class, so we query by data-temp-bibid only
    const tempLinks = dom.querySelectorAll('a[data-temp-bibid]');
    console.log(`📚 ScienceDirect: Updating ${tempLinks.length} temporary citation links with reference IDs`);

    let updatedCount = 0;
    tempLinks.forEach((link: any) => {
      const bibId = link.getAttribute('data-temp-bibid');
      const reference = this.bibIdToRefMap.get(bibId);

      if (reference && reference.referenceId) {
        // Update href to actual reference ID and re-add class (cleanup stripped it)
        link.setAttribute('href', `#${reference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');
        link.removeAttribute('data-temp-bibid'); // Clean up temp marker
        updatedCount++;
      } else {
        console.warn(`⚠️ ScienceDirect: No reference ID found for bibId: ${bibId}`);
      }
    });

    console.log(`📚 ScienceDirect: Updated ${updatedCount} citation links with reference IDs`);
  }
}
