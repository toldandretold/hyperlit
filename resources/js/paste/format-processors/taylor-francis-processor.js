/**
 * Taylor & Francis Format Processor
 * Handles T&F content with Notes sections and CIT IDs
 */

import { BaseFormatProcessor } from './base-processor.js';
import { unwrap, isReferenceSectionHeading } from '../utils/dom-utils.js';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements,
  cloneAndClean,
  addUniqueReference,
  cleanTFFootnoteContent
} from '../utils/transform-helpers.js';

export class TaylorFrancisProcessor extends BaseFormatProcessor {
  constructor() {
    super('taylor-francis');
    this.extractedReferences = []; // Store references for later use
    this.citIdToRefMap = new Map(); // CIT ID → reference object mapping
  }

  /**
   * Extract footnotes from Taylor & Francis structure
   * Looks for Notes headings and summation-section divs
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];

    // Find and mark footnote paragraphs
    // Look for Notes sections and summation-section divs
    const notesHeadings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');

    notesHeadings.forEach(heading => {
      if (/notes/i.test(heading.textContent.trim()) || heading.id === 'inline_frontnotes') {

        // Mark all following paragraphs as footnotes until we hit another heading
        let nextElement = heading.nextElementSibling;
        while (nextElement) {
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            break; // Hit another heading, stop
          }

          if (nextElement.tagName === 'P') {
            const pText = nextElement.textContent.trim();
            // Check if it starts with a number (footnote pattern)
            const match = pText.match(/^(\d+)[\.\)\s]/);
            if (match) {
              const identifier = match[1];
              nextElement.classList.add('footnote');

              // Get HTML content and clean thoroughly
              let htmlContent = nextElement.innerHTML.trim();

              // Remove leading number (handles both plain text and HTML)
              htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, '');

              // Clean up T&F citation links in footnote content
              htmlContent = cleanTFFootnoteContent(htmlContent);

              footnotes.push(this.createFootnote(
                this.generateFootnoteId(bookId, identifier),
                htmlContent, // Don't add identifier prefix - it's already in the content
                identifier,
                this.generateFootnoteRefId(bookId, identifier),
                'taylor-francis'
              ));
            }
          } else if (nextElement.tagName === 'DIV') {
            // Look inside divs (like summation-section)
            // Check if this div itself has a footnote RID (EN or FN format, case-insensitive)
            const divHasFootnoteId = nextElement.id && /^(EN|FN)/i.test(nextElement.id);

            if (divHasFootnoteId) {
              // This div itself has a footnote ID - process its paragraphs
              const footnoteRid = nextElement.id;
              const paragraphs = nextElement.querySelectorAll('p');
              paragraphs.forEach(p => {
                const pText = p.textContent.trim();
                const match = pText.match(/^(\d+)[\.\)\s]/);
                if (match) {
                  const identifier = match[1];
                  p.classList.add('footnote');

                  // Get HTML content and clean thoroughly
                  let htmlContent = p.innerHTML.trim();

                  // Remove leading number (handles both plain text and HTML)
                  htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, '');

                  // Clean up T&F citation links in footnote content
                  htmlContent = cleanTFFootnoteContent(htmlContent);

                  const footnote = this.createFootnote(
                    this.generateFootnoteId(bookId, identifier), // Always use standard ID
                    htmlContent, // Don't add identifier prefix
                    identifier,
                    this.generateFootnoteRefId(bookId, identifier),
                    'taylor-francis'
                  );
                  // Store the RID for linking - could be "EN" or "FN" format (case-insensitive)
                  const upperRid = footnoteRid.toUpperCase();
                  if (upperRid.startsWith('EN')) {
                    footnote.enId = footnoteRid;
                  } else if (upperRid.startsWith('FN')) {
                    footnote.fnId = footnoteRid;
                  }
                  footnotes.push(footnote);
                }
              });
            } else {
              // This div is a container (like summation-section) - process each child div separately
              const childDivs = nextElement.querySelectorAll('div[id^="EN"], div[id^="FN"], div[id^="en"], div[id^="fn"]');
              childDivs.forEach(childDiv => {
                const footnoteRid = childDiv.id;
                const paragraphs = childDiv.querySelectorAll('p');
                paragraphs.forEach(p => {
                  const pText = p.textContent.trim();
                  const match = pText.match(/^(\d+)[\.\)\s]/);
                  if (match) {
                    const identifier = match[1];
                    p.classList.add('footnote');

                    // Get HTML content and clean thoroughly
                    let htmlContent = p.innerHTML.trim();

                    // Remove leading number (handles both plain text and HTML)
                    htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, '');

                    // Clean up T&F citation links in footnote content
                    htmlContent = cleanTFFootnoteContent(htmlContent);

                    const footnote = this.createFootnote(
                      this.generateFootnoteId(bookId, identifier), // Always use standard ID
                      htmlContent, // Don't add identifier prefix
                      identifier,
                      this.generateFootnoteRefId(bookId, identifier),
                      'taylor-francis'
                    );
                    // Store the RID for linking - could be "EN" or "FN" format (case-insensitive)
                    const upperRid = footnoteRid.toUpperCase();
                    if (upperRid.startsWith('EN')) {
                      footnote.enId = footnoteRid;
                    } else if (upperRid.startsWith('FN')) {
                      footnote.fnId = footnoteRid;
                    }
                    footnotes.push(footnote);
                  }
                });
              });
            }
          }

          nextElement = nextElement.nextElementSibling;
        }
      }
    });

    // Also check for summation-section divs specifically (both "EN" and "FN" formats, case-insensitive)
    const summationSections = dom.querySelectorAll('.summation-section, div[id^="EN"], div[id^="FN"], div[id^="en"], div[id^="fn"]');
    summationSections.forEach(section => {
      const footnoteRid = section.id; // e.g., "EN0001", "FN0002", "fn0003"
      const paragraphs = section.querySelectorAll('p');
      paragraphs.forEach(p => {
        const pText = p.textContent.trim();
        const match = pText.match(/^(\d+)[\.\)\s]/);
        if (match) {
          const identifier = match[1];
          p.classList.add('footnote');

          // Avoid duplicates
          if (!footnotes.find(fn => fn.originalIdentifier === identifier)) {
            // Get HTML content and clean thoroughly
            let htmlContent = p.innerHTML.trim();

            // Remove leading number (handles both plain text and HTML)
            htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, '');

            // Clean up T&F citation links in footnote content
            htmlContent = cleanTFFootnoteContent(htmlContent);

            const footnote = this.createFootnote(
              this.generateFootnoteId(bookId, identifier), // Always use standard ID
              htmlContent, // Don't add identifier prefix
              identifier,
              this.generateFootnoteRefId(bookId, identifier),
              'taylor-francis'
            );
            // Store the RID for linking - could be "EN" or "FN" format (case-insensitive)
            const upperRid = footnoteRid ? footnoteRid.toUpperCase() : '';
            if (upperRid.startsWith('EN')) {
              footnote.enId = footnoteRid;
            } else if (upperRid.startsWith('FN')) {
              footnote.fnId = footnoteRid;
            }
            footnotes.push(footnote);
          }
        }
      });
    });

    console.log(`📝 T&F: Extracted ${footnotes.length} footnotes`);
    return footnotes;
  }

  /**
   * Extract references from Taylor & Francis bibliography
   * Matches OLD code structure from footnoteReferenceExtractor.js
   */
  async extractReferences(dom, bookId) {
    const references = [];

    // Direct search for CIT list items (primary T&F pattern)
    const citItems = dom.querySelectorAll('li[id^="CIT"]');
    if (citItems.length > 0) {
      citItems.forEach(item => {
        const citId = item.id; // e.g., "CIT0038"

        // Clone and clean the item
        const clone = cloneAndClean(item, ['.extra-links']);

        const content = clone.textContent.trim();
        if (content && content.length > 10) {
          // Match old code structure - plain object, no helper methods
          const reference = {
            content: content,
            originalText: content,
            type: 'taylor-francis-cit',
            needsKeyGeneration: true,
            citId: citId // Store the CIT ID for linking
          };
          references.push(reference);

          // Map CIT ID to reference for later citation linking
          this.citIdToRefMap.set(citId, reference);
        }
      });
    }

    // Fallback: Look for References heading and extract from lists
    if (references.length === 0) {
      const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
      for (const heading of headings) {
        if (/references|bibliography/i.test(heading.textContent.trim())) {
          let nextElement = heading.nextElementSibling;
          while (nextElement) {
            if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
              break; // Hit another heading
            }

            // Look INSIDE containers (divs, sections, lists)
            if (nextElement.tagName === 'DIV' || nextElement.tagName === 'SECTION' ||
                nextElement.tagName === 'UL' || nextElement.tagName === 'OL') {
              const refItems = nextElement.querySelectorAll('li, p');
              refItems.forEach(item => {
                // Clone and clean the item
                const clone = cloneAndClean(item, ['.extra-links']);

                const content = clone.textContent.trim();
                if (content && content.length > 10) {
                  // Avoid duplicates using utility
                  addUniqueReference(references, {
                    content: content,
                    originalText: content,
                    type: 'taylor-francis-list',
                    needsKeyGeneration: true
                  }, 'content');
                }
              });
            }

            nextElement = nextElement.nextElementSibling;
          }
        }
      }
    }

    console.log(`📚 T&F: Extracted ${references.length} references`);

    // Store for use in transformStructure
    this.extractedReferences = references;

    return references;
  }

  /**
   * Override linkCitations to handle T&F-specific data-rid links
   * After base class generates reference IDs, convert data-rid links to href links
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and keys
    super.linkCitations(dom, references);

    // Now convert T&F citation links from data-rid to href
    const citationLinks = dom.querySelectorAll('a[data-rid^="CIT"]');
    let convertedCount = 0;

    citationLinks.forEach(link => {
      const citId = link.getAttribute('data-rid'); // e.g., "CIT0038"

      // Look up the reference for this CIT ID
      const reference = this.citIdToRefMap.get(citId);

      if (reference && reference.referenceId) {
        // Convert to proper reference link
        link.setAttribute('href', `#${reference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');

        // Remove ALL T&F-specific attributes
        link.removeAttribute('data-rid');
        link.removeAttribute('data-behaviour');
        link.removeAttribute('data-ref-type');
        link.removeAttribute('data-label');
        link.removeAttribute('data-registered');

        convertedCount++;
      } else {
        console.warn(`⚠️ T&F: Could not find reference for ${citId}`);
      }
    });

    console.log(`  - Converted ${convertedCount} T&F citation links`);
  }

  /**
   * Override linkFootnotes to handle T&F-specific data-rid footnote links
   */
  linkFootnotes(dom, footnotes) {
    // DO NOT call super.linkFootnotes() - it causes double-processing and malformed structures
    // T&F has unique structures that require special handling:
    // - Format 1: <a data-rid="EN0001"><sup>1</sup></a> (endnotes)
    // - Format 2: <a data-rid="FN0002"><sup>2</sup></a> (footnotes)
    // - Format 3: <a data-rid="fn0003"><sup>3</sup></a> (lowercase footnotes)

    // Convert T&F footnote links from data-rid to href (both "EN" and "FN" formats, case-insensitive)
    const footnoteLinks = dom.querySelectorAll('a[data-rid^="EN"], a[data-rid^="FN"], a[data-rid^="en"], a[data-rid^="fn"]');
    let convertedCount = 0;

    footnoteLinks.forEach(link => {
      const footnoteRid = link.getAttribute('data-rid'); // e.g., "EN0001", "FN0002", or "fn0003"

      // Find the footnote with this RID (could be stored as enId or fnId, case-insensitive match)
      const upperRid = footnoteRid.toUpperCase();
      const footnote = footnotes.find(fn =>
        (fn.enId && fn.enId.toUpperCase() === upperRid) ||
        (fn.fnId && fn.fnId.toUpperCase() === upperRid)
      );

      if (footnote) {
        // Extract the number from the <sup> tag inside the link BEFORE any processing
        const supElement = link.querySelector('sup');
        let identifier = supElement ? supElement.textContent.trim() : footnote.originalIdentifier;

        // Validate identifier is not empty
        if (!identifier || identifier === '') {
          console.warn(`⚠️ T&F: Empty identifier for ${footnoteRid}, using originalIdentifier: ${footnote.originalIdentifier}`);
          identifier = footnote.originalIdentifier;
        }

        // Create new structure: <sup id="..." fn-count-id="1"><a href="..." class="footnote-ref">1</a></sup>
        const newSup = document.createElement('sup');
        newSup.id = footnote.refId;
        newSup.setAttribute('fn-count-id', identifier);

        const newLink = document.createElement('a');
        newLink.href = `#${footnote.footnoteId}`;
        newLink.className = 'footnote-ref';
        newLink.textContent = identifier;

        newSup.appendChild(newLink);

        // Replace the original link with the new sup structure
        link.parentNode.replaceChild(newSup, link);

        convertedCount++;
      } else {
        console.warn(`⚠️ T&F: Could not find footnote for ${footnoteRid}`);
      }
    });

    console.log(`  - Converted ${convertedCount} T&F footnote links`);
  }

  /**
   * Transform structure - unwrap divs and clean up
   */
  async transformStructure(dom, bookId) {
    // 1. Remove entire extra-links divs (contains View, Web of Science, Google Scholar, etc.)
    // Must happen BEFORE unwrapping divs/spans
    dom.querySelectorAll('.extra-links').forEach(el => el.remove());

    // 2. T&F-specific: Clean up citation link TEXT but KEEP the links
    // Remove "Citation" text from the link content, but preserve <a> tags for later conversion
    const citationLinks = dom.querySelectorAll('a[data-rid^="CIT"]');
    citationLinks.forEach(link => {
      // Get the text content (e.g., "Citation1984a" or just "1984a")
      const textContent = link.textContent;
      // Remove "Citation" prefix but keep the year
      const cleanText = textContent.replace(/^Citation/i, '');
      // Update the link's text content
      link.textContent = cleanText;
      // Keep the link element for later conversion in linkCitations()
    });

    // 3. Remove footnote and reference sections from main content
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // 4. Remove elements with data-static-content
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 T&F: Removed ${removedSections + removedStatic} section(s) from main content`);

    // 5. Unwrap T&F footnote/citation wrapper spans first (before general unwrapping)
    const tfWrapperSpans = Array.from(dom.querySelectorAll('span.ref-lnk'));
    tfWrapperSpans.forEach(span => {
      unwrap(span);
    });

    // 6. Unwrap all container elements
    unwrapContainers(dom);
  }
}
