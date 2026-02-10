/**
 * Wiley Processor
 * Handles Wiley Online Library content with bibId-based linking
 *
 * Key features:
 * - Extracts references from <li data-bib-id="..."> elements
 * - Links citations via <a href="#..." class="bibLink">
 * - Supports structured reference data (author, year, title spans)
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
import { generateReferenceKeys } from '../utils/reference-key-generator.js';

export class WileyProcessor extends BaseFormatProcessor {
  constructor() {
    super('wiley');
    this.bibIdToRefMap = new Map(); // Maps bibId → reference object
  }

  /**
   * Extract footnotes from Wiley structure
   * Wiley typically uses endnotes/references rather than traditional footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];

    console.log('📚 Wiley: Looking for footnotes');

    // Wiley may use note elements with specific patterns
    // Check for common footnote patterns
    const noteElements = dom.querySelectorAll('.note, [role="doc-footnote"], .footnote');

    noteElements.forEach((element, index) => {
      const identifier = String(index + 1);
      const clone = cloneAndClean(element, ['.back-link', 'a[href^="#"]']);
      const htmlContent = clone.innerHTML.trim();

      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          'wiley'
        );

        footnotes.push(footnote);
        element.remove();
      }
    });

    console.log(`📚 Wiley: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Extract references from Wiley bibliography
   * Wiley uses <li data-bib-id="..."> for bibliography entries
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    console.log('📚 Wiley: Looking for bibliography items with data-bib-id');

    // Find bibliography items with data-bib-id attribute
    const bibItems = dom.querySelectorAll('li[data-bib-id]');
    console.log(`📚 Wiley: Found ${bibItems.length} bibliography items`);

    bibItems.forEach(item => {
      const bibId = item.getAttribute('data-bib-id'); // e.g., "isd212080-bib-0007"

      // Clone and clean element - remove external links
      const clone = cloneAndClean(item, [
        '.extra-links',
        '.getFTR',
        '.getFTR__content',
        '.google-scholar',
        'a[target="_blank"]',
        '[aria-hidden="true"]',
        '.hidden'
      ]);

      // Extract structured data from Wiley spans if available
      const author = item.querySelector('.author')?.textContent?.trim() || '';
      const year = item.querySelector('.pubYear')?.textContent?.trim() || '';

      // Get clean content
      const htmlContent = clone.innerHTML.trim();
      const text = clone.textContent.trim();

      // Check if it looks like a valid reference
      if (!text || text.length < 10) {
        console.warn(`⚠️ Wiley: Skipping empty or too short bibliography item: ${bibId}`);
        return;
      }

      // Generate reference ID from author+year if available, otherwise use bibId
      let referenceId;
      if (author && year) {
        const refKeys = generateReferenceKeys(`${author} ${year}`, '', 'wiley');
        referenceId = refKeys.length > 0 ? refKeys[0] : `wiley_${bibId}`;
      } else {
        referenceId = `wiley_${bibId}`;
      }

      const reference = {
        referenceId,
        content: htmlContent,
        originalText: text,
        type: 'wiley-bibliography',
        needsKeyGeneration: true, // Let base class also generate keys for additional matching
        bibId: bibId // Store original bibId for citation linking
      };

      references.push(reference);

      // Map bibId to reference for citation linking
      this.bibIdToRefMap.set(bibId, reference);

      console.log(`📚 Wiley: Extracted reference ${bibId}: "${text.substring(0, 60)}..."`);

      // Remove from DOM so it doesn't appear in main content
      item.remove();
    });

    console.log(`📚 Wiley: Total references extracted: ${references.length}`);

    return references;
  }

  /**
   * Transform structure - unwrap divs and clean up Wiley-specific elements
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 Wiley: Applying structure transformation');

    // STEP 1: Remove original References sections from main content
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // STEP 2: Remove elements with data-static-content attribute
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 Wiley: Removed ${removedSections + removedStatic} section(s) from main content`);

    // STEP 3: Remove Wiley-specific UI elements
    const uiSelectors = [
      '.pb-dropzone',           // Wiley dropzones
      '.loa-wrapper',           // Author list wrappers
      '.accordion',             // Accordions
      '.accordion-tabbed',      // Tabbed accordions
      '.epub-sections',         // Section metadata
      '.article-header__widget',// Header widgets
      '.article-tools',         // Article tools
      '.metrics-section',       // Metrics
      '.share-article',         // Share buttons
      '[data-pb-dropzone]',     // Data dropzones
      '.getFTR',                // Full text resolver
      '.extra-links',           // External links
      '.google-scholar',        // Google Scholar links
      'svg',                    // SVG icons
      '[aria-hidden="true"]'    // Hidden elements
    ];

    uiSelectors.forEach(selector => {
      dom.querySelectorAll(selector).forEach(el => el.remove());
    });

    // STEP 4: Clean up empty reference lists
    dom.querySelectorAll('ul.article__references, ol.article__references').forEach(list => {
      if (list.children.length === 0) {
        list.remove();
      }
    });

    // STEP 5: Unwrap container elements
    unwrapContainers(dom);

    console.log(`📚 Wiley: Transformation complete`);
  }

  /**
   * Override linkCitations to convert Wiley-specific citation links
   * Wiley uses <a href="#bibId" class="bibLink"> or full URLs with #bibId anchors
   * Note: By the time this runs, cleanup has stripped classes, so we match by href pattern
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    console.log('📚 Wiley: Converting Wiley-specific citation links...');

    // Find all links that might be Wiley citations
    // After cleanup, classes are stripped, so we need to find by href pattern
    // Wiley bibIds look like: isd212080-bib-0007 (pattern: *-bib-*)
    const allLinks = dom.querySelectorAll('a[href*="-bib-"]');
    let convertedCount = 0;
    let failedCount = 0;

    allLinks.forEach(link => {
      const href = link.getAttribute('href'); // e.g., "#isd212080-bib-0007" or full URL with anchor
      const citText = link.textContent.trim(); // e.g., "1965" or "Olson, 1965"

      if (!href) {
        return;
      }

      // Extract bibId from href - handle both relative and full URLs
      // Pattern: #isd212080-bib-0007 or https://...#isd212080-bib-0007
      let bibId;
      if (href.includes('#')) {
        bibId = href.substring(href.indexOf('#') + 1);
      } else {
        // No anchor, skip this link
        return;
      }

      // Validate it looks like a Wiley bibId
      if (!bibId.includes('-bib-')) {
        return;
      }

      // Look up the reference for this bibId
      const reference = this.bibIdToRefMap.get(bibId);

      if (reference && reference.referenceId) {
        // Convert to proper citation link
        link.setAttribute('href', `#${reference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');

        // Parse citation text to detect if it contains year
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);

        if (yearMatch) {
          const year = yearMatch[1];

          // Check if there's author text before the year
          const yearIndex = citText.indexOf(year);
          let author = citText.substring(0, yearIndex).trim();

          // Clean up author text (remove trailing comma, parentheses)
          author = author.replace(/[,;]$/, '').trim();
          author = author.replace(/^\(/, '').replace(/\)$/, '').trim();

          // Check if this is a narrative citation (author outside parentheses)
          const isNarrative = author.length > 0 && !citText.startsWith('(');

          // Get trailing text after year
          const afterYearPos = yearIndex + year.length;
          const trailing = citText.substring(afterYearPos).replace(/^\)/, '').trim();

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

        // Remove Wiley-specific attributes
        link.removeAttribute('data-tab');
        link.removeAttribute('id');
        link.removeAttribute('data-tooltip');
        link.removeAttribute('tabindex');

        convertedCount++;
      } else {
        console.warn(`⚠️ Wiley: Could not find reference for "${citText}" (${bibId})`);
        failedCount++;
      }
    });

    console.log(`  - Converted ${convertedCount} Wiley citation links, ${failedCount} failed`);
  }
}
