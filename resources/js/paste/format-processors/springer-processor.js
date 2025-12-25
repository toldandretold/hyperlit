/**
 * Springer Processor
 * Handles Springer Nature content with clean ID-based linking
 *
 * Key features:
 * - Extracts footnotes from <li id="Fn*"> elements
 * - Extracts references from <p id="ref-CR*"> or <li id="ref-CR*"> elements
 * - Links citations via <a href="#ref-CR*">
 * - Links footnotes via <sup><a href="#Fn*">
 * - Supports narrative and parenthetical citations
 */

import { BaseFormatProcessor } from './base-processor.js';
import { isReferenceSectionHeading } from '../utils/dom-utils.js';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements,
  cloneAndClean,
  reformatCitationLink
} from '../utils/transform-helpers.js';
import { createFootnoteSupElement } from '../utils/footnote-linker.js';

export class SpringerProcessor extends BaseFormatProcessor {
  constructor() {
    super('springer');
    this.refIdMap = new Map(); // Maps ref-CR75 → reference object
  }

  /**
   * Extract footnotes from Springer structure
   * Springer uses <li id="Fn*"> for footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];

    console.log('📚 Springer: Looking for footnotes with Fn* IDs');

    // Find footnote elements with IDs starting with "Fn"
    const footnoteElements = dom.querySelectorAll('[id^="Fn"]');
    console.log(`📚 Springer: Found ${footnoteElements.length} footnote elements`);

    footnoteElements.forEach(element => {
      const fnId = element.id; // e.g., "Fn1", "Fn2"

      // Extract number from ID (e.g., "Fn1" → "1")
      const identifierMatch = fnId.match(/Fn(\d+)/);
      if (!identifierMatch) {
        console.warn(`⚠️ Springer: Could not extract identifier from ID: ${fnId}`);
        return;
      }

      const identifier = identifierMatch[1];

      // Clone and clean element
      const contentClone = cloneAndClean(element, ['a[href*="#Fn"]', '.label']);

      // Remove sup only if it contains the footnote number (label)
      contentClone.querySelectorAll('sup').forEach(el => {
        if (el.textContent.trim() === identifier) {
          el.remove();
        }
      });

      // Remove data-counter attributes
      contentClone.removeAttribute('data-counter');

      // Get content - look for <p> INSIDE content wrapper, not the wrapper itself
      let contentElement = contentClone.querySelector('.c-article-footnote--listed__content p, p');
      if (!contentElement) {
        // Fallback: if no paragraph found, use entire content
        contentElement = contentClone;
        console.warn(`⚠️ Springer: No content paragraph found for footnote ${identifier}, using entire element`);
      }

      const htmlContent = contentElement.innerHTML.trim();

      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          'springer'
        );

        footnotes.push(footnote);

        console.log(`📚 Springer: Extracted footnote ${identifier}: "${htmlContent.substring(0, 50)}..."`);

        // Remove from DOM so it doesn't appear in main content
        element.remove();
      }
    });

    console.log(`📚 Springer: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Link footnotes to in-text references
   * Springer uses <sup><a href="#Fn*"> or full URLs with #Fn* anchors for footnote references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`📚 Springer: Linking ${footnotes.length} footnotes to in-text references`);

    // Find all Springer footnote reference links (href containing #Fn)
    const fnLinks = dom.querySelectorAll('a[href*="#Fn"]');
    let linkedCount = 0;

    fnLinks.forEach(link => {
      const href = link.getAttribute('href'); // e.g., "#Fn1" or "https://...#Fn1"

      // Extract identifier from href (handle both relative and absolute URLs)
      let identifierMatch;
      if (href.includes('#Fn')) {
        // Extract anchor part and then number: "#Fn1" or "https://...#Fn1" → "1"
        const anchor = href.substring(href.indexOf('#'));
        identifierMatch = anchor.match(/#Fn(\d+)/);
      }

      if (!identifierMatch) {
        console.warn(`⚠️ Springer: Could not extract identifier from href: ${href}`);
        return;
      }

      const identifier = identifierMatch[1];
      const footnote = footnotes.find(fn => fn.originalIdentifier === identifier);

      if (footnote) {
        // Create new sup element using centralized utility (removes old anchor pattern)
        const newSup = createFootnoteSupElement(footnote.refId, identifier);

        // Replace the link (and parent sup if exists) with new clean sup
        const parentSup = link.parentElement;
        if (parentSup && parentSup.tagName === 'SUP') {
          parentSup.replaceWith(newSup);
        } else {
          link.replaceWith(newSup);
        }

        linkedCount++;
      } else {
        console.warn(`⚠️ Springer: Could not find footnote for identifier ${identifier}`);
      }
    });

    console.log(`  - Linked ${linkedCount} Springer footnote references`);
  }

  /**
   * Extract references from Springer bibliography
   * Springer uses <p id="ref-CR*"> or <li id="ref-CR*"> for bibliography entries
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    console.log('📚 Springer: Looking for bibliography items with ref-CR* IDs');

    // Find bibliography items with IDs starting with "ref-CR"
    const bibItems = dom.querySelectorAll('[id^="ref-CR"]');
    console.log(`📚 Springer: Found ${bibItems.length} bibliography items`);

    bibItems.forEach(item => {
      const refId = item.id; // e.g., "ref-CR75"

      // Clone and clean element
      const clone = cloneAndClean(item, ['.c-article-references__links', 'a[target="_blank"]', 'svg']);

      // Get clean content
      let contentElement = clone.querySelector('.c-article-references__text, p');
      if (!contentElement) {
        contentElement = clone;
      }

      const htmlContent = contentElement.innerHTML.trim();
      const text = contentElement.textContent.trim();

      // Check if it looks like a valid reference (contains text and reasonable length)
      if (!text || text.length < 10) {
        console.warn(`⚠️ Springer: Skipping empty or too short bibliography item: ${refId}`);
        return;
      }

      const reference = {
        content: htmlContent,
        originalText: text,
        type: 'springer-bibliography',
        needsKeyGeneration: true,
        refId: refId // Store the reference ID (ref-CR75)
      };

      references.push(reference);

      // Map refId to reference for citation linking
      this.refIdMap.set(refId, reference);

      console.log(`📚 Springer: Extracted reference ${refId}: "${text.substring(0, 60)}..."`);

      // Remove from DOM so it doesn't appear in main content
      item.remove();
    });

    console.log(`📚 Springer: Total references extracted: ${references.length}`);

    return references;
  }

  /**
   * Transform structure - unwrap divs and clean up
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 Springer: Applying general structure transformation');

    // STEP 1: Remove original Footnotes/References sections from main content
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // STEP 2: Remove elements with data-static-content attribute
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 Springer: Removed ${removedSections + removedStatic} section(s) from main content`);

    // STEP 3: Unwrap all container elements (including ul, ol for Springer)
    unwrapContainers(dom, 'ul, ol');

    console.log(`📚 Springer: Transformation complete`);
  }

  /**
   * Override linkCitations to convert Springer-specific citation links
   * Springer uses <a href="#ref-CR*"> or full URLs with #ref-CR* anchors for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    console.log('📚 Springer: Converting Springer-specific citation links...');

    // Find all Springer citation links (href containing #ref-CR)
    // Handles both: href="#ref-CR75" and href="https://link.springer.com/...#ref-CR75"
    const citationLinks = dom.querySelectorAll('a[href*="#ref-CR"]');
    let convertedCount = 0;
    let failedCount = 0;

    citationLinks.forEach(link => {
      const href = link.getAttribute('href'); // e.g., "#ref-CR75" or "https://...#ref-CR75"
      const citText = link.textContent.trim(); // e.g., "2024b" or "Lincoln 1854"

      // Extract refId from href (handle both relative and absolute URLs)
      let refId;
      if (href.includes('#')) {
        // Extract anchor part: "#ref-CR75" or "https://...#ref-CR75" → "ref-CR75"
        refId = href.substring(href.indexOf('#') + 1);
      } else {
        console.warn(`⚠️ Springer: href doesn't contain anchor: ${href}`);
        failedCount++;
        return;
      }

      // Look up the reference for this refId
      const reference = this.refIdMap.get(refId);

      if (reference && reference.referenceId) {
        // Convert to proper citation link
        link.setAttribute('href', `#${reference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');

        // Parse citation text to detect narrative vs parenthetical
        // Narrative: "Lincoln (1854)" - contains opening paren
        // Parenthetical: "2024b" or "Lincoln, 1854" - just year/author-year
        const hasOpenParen = citText.includes('(');
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);

        if (yearMatch) {
          const year = yearMatch[1];
          const isNarrative = hasOpenParen;

          // Prepare author text based on citation style
          let author = '';
          if (isNarrative) {
            author = citText.substring(0, citText.indexOf('(')).trim();
          } else {
            author = citText.substring(0, yearMatch.index).trim();
          }

          // Get trailing text after year
          const afterYearPos = citText.indexOf(year) + year.length;
          const trailing = isNarrative ? '' : citText.substring(afterYearPos);

          // Use shared utility for citation reformatting
          reformatCitationLink(link, {
            author,
            year,
            isNarrative,
            trailing
          });
        } else {
          // No year found, keep text as-is
          link.textContent = citText;
        }

        // Remove Springer-specific attributes
        link.removeAttribute('data-track');
        link.removeAttribute('data-track-action');
        link.removeAttribute('data-track-label');
        link.removeAttribute('data-test');
        link.removeAttribute('aria-label');
        link.removeAttribute('title');

        convertedCount++;
      } else {
        console.warn(`⚠️ Springer: Could not find reference for "${citText}" (${refId})`);
        failedCount++;
      }
    });

    console.log(`  - Converted ${convertedCount} Springer citation links, ${failedCount} failed`);
  }
}
