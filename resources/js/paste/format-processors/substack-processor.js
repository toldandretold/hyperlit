/**
 * Substack Processor
 * Handles Substack newsletter content with footnotes
 *
 * Key features:
 * - Converts <a data-component-name="FootnoteAnchorToDOM"> to standard <sup> tags
 * - Extracts footnote content from .footnote-content divs
 * - Does NOT handle references/bibliography (Substack doesn't use them)
 */

import { BaseFormatProcessor } from './base-processor.js';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements
} from '../utils/transform-helpers.js';
import { createFootnoteSupElement } from '../utils/footnote-linker.js';

export class SubstackProcessor extends BaseFormatProcessor {
  constructor() {
    super('substack');
  }

  /**
   * Extract footnotes from Substack-specific structure
   * Substack uses:
   * - In-text: <a data-component-name="FootnoteAnchorToDOM" id="footnote-anchor-9-117335878" href="...">9</a>
   * - Content: <div class="footnote-content"><p>...</p></div>
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = new Map();

    console.log('📚 Substack: Initial structure check:');
    console.log('  - FootnoteAnchorToDOM links:', dom.querySelectorAll('a[data-component-name="FootnoteAnchorToDOM"]').length);
    console.log('  - .footnote-content divs:', dom.querySelectorAll('.footnote-content').length);
    console.log('  - footnote-anchor links:', dom.querySelectorAll('[id^="footnote-anchor-"]').length);

    // STEP 1: Process in-text footnote anchors
    // Convert <a data-component-name="FootnoteAnchorToDOM">9</a> → <sup fn-count-id="9">9</sup>
    const footnoteAnchors = dom.querySelectorAll('a[data-component-name="FootnoteAnchorToDOM"]');
    console.log(`📚 Substack: Found ${footnoteAnchors.length} in-text footnote anchors`);

    footnoteAnchors.forEach((anchor) => {
      const identifier = anchor.textContent.trim();

      if (identifier && /^\d+$/.test(identifier)) {
        // Create a clean <sup> with fn-count-id for later linking
        const cleanSup = createFootnoteSupElement('', identifier);
        cleanSup.removeAttribute('id'); // ID will be set by linker

        // Replace the anchor with the <sup>
        anchor.replaceWith(cleanSup);
      }
    });

    // STEP 2: Extract footnote content from .footnote-content divs
    // Structure: <div class="footnote-content"><p>Content here</p></div>
    // The back-link has href like "#footnote-anchor-16-117335878"
    const footnoteContents = dom.querySelectorAll('.footnote-content');
    console.log(`📚 Substack: Found ${footnoteContents.length} footnote content containers`);

    footnoteContents.forEach((container) => {
      let footnoteNum = null;

      // Method 1: Find the footnote number from the back-link
      const backLink = container.querySelector('a[href*="#footnote-anchor-"]');
      if (backLink) {
        const href = backLink.getAttribute('href');
        const match = href.match(/#footnote-anchor-(\d+)-/);
        if (match) {
          footnoteNum = match[1];
        }
      }

      // Method 2: Check parent elements for footnote ID
      if (!footnoteNum) {
        let parent = container.parentElement;
        while (parent && !footnoteNum) {
          const parentId = parent.id;
          if (parentId) {
            const idMatch = parentId.match(/footnote-(\d+)-/);
            if (idMatch) {
              footnoteNum = idMatch[1];
            }
          }
          parent = parent.parentElement;
        }
      }

      // Method 3: Look for anchor with footnote ID pattern in the container
      if (!footnoteNum) {
        const anchorWithId = container.querySelector('a[href*="#footnote-anchor-"]') ||
                            container.parentElement?.querySelector('a[href*="#footnote-anchor-"]');
        if (anchorWithId) {
          const href = anchorWithId.getAttribute('href');
          const match = href.match(/#footnote-anchor-(\d+)-/);
          if (match) {
            footnoteNum = match[1];
          }
        }
      }

      // Method 4: Fallback - find number at start of content
      if (!footnoteNum) {
        const firstText = container.textContent.trim();
        const numMatch = firstText.match(/^(\d+)/);
        if (numMatch) {
          footnoteNum = numMatch[1];
        }
      }

      if (!footnoteNum) {
        console.warn('📚 Substack: Could not determine footnote number for container');
        return;
      }

      // Extract content, removing back-link and number prefix
      const clone = container.cloneNode(true);

      // Remove back-link elements
      clone.querySelectorAll('a[href*="#footnote-anchor-"]').forEach(el => el.remove());

      // Get the content HTML
      let content = clone.innerHTML.trim();

      // Remove leading number prefix if present (e.g., "16. Content" → "Content")
      // Handles: "16. text", "16) text", "16: text", or just "16 text"
      content = content.replace(/^(\s*<[^>]+>)*\s*\d+[\.\):\s]\s*/, '');

      // Generate unique IDs
      const uniqueId = this.generateFootnoteId(bookId, footnoteNum);
      const uniqueRefId = this.generateFootnoteRefId(uniqueId);

      // Create footnote object
      footnotes.push(this.createFootnote(
        uniqueId,
        content,
        footnoteNum,
        uniqueRefId,
        'substack'
      ));

      footnoteMappings.set(footnoteNum, { uniqueId, uniqueRefId });

      console.log(`📚 Substack: Extracted footnote ${footnoteNum}`);
    });

    // STEP 3: Remove footnote containers from DOM
    // They will be re-added as static content by base processor
    footnoteContents.forEach(container => {
      // Remove the container and its parent if it's a footnote wrapper
      let parent = container.parentElement;
      container.remove();

      // Also remove parent if it's now empty or is a footnote-specific container
      if (parent && (parent.textContent.trim() === '' ||
          parent.classList.contains('footnote') ||
          parent.id?.includes('footnote'))) {
        parent.remove();
      }
    });

    // STEP 4: Remove any remaining footnote section containers
    // Look for divs with footnote-related classes or IDs
    const footnoteWrappers = dom.querySelectorAll('[class*="footnote"], [id*="footnote"]');
    footnoteWrappers.forEach(el => {
      // Only remove if it's a container, not an inline element
      if (!['A', 'SUP', 'SPAN'].includes(el.tagName)) {
        // Check if it's empty or only has whitespace
        if (el.textContent.trim() === '' || el.querySelector('.footnote-content')) {
          el.remove();
        }
      }
    });

    console.log(`📚 Substack: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Extract references from content
   * Substack newsletters typically don't have formal bibliography sections
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Empty array (no references)
   */
  async extractReferences(dom, bookId) {
    console.log('📚 Substack: Skipping reference extraction (not applicable for newsletters)');
    return [];
  }

  /**
   * Transform document structure
   * Clean up Substack-specific HTML structures
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 Substack: Applying structure transformation');

    // STEP 1: Remove any Notes/Footnotes section headings and content
    const removedSections = removeSectionsByHeading(dom, (text) => {
      const normalized = text.trim().toLowerCase();
      return ['footnotes', 'notes', 'endnotes'].includes(normalized);
    });

    // STEP 2: Remove elements with data-static-content (from previous processing)
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 Substack: Removed ${removedSections + removedStatic} section(s)`);

    // STEP 3: Unwrap unnecessary container divs
    unwrapContainers(dom);

    // STEP 4: Remove Substack-specific attributes that aren't needed
    dom.querySelectorAll('[data-component-name]').forEach(el => {
      el.removeAttribute('data-component-name');
    });

    // STEP 5: Clean up any remaining footnote-anchor elements that weren't converted
    // (these are the back-links in the footnote section)
    dom.querySelectorAll('.footnote-anchor').forEach(el => {
      // If it's a link back to the in-text reference, remove it
      const href = el.getAttribute('href');
      if (href && href.includes('#footnote-anchor-')) {
        el.remove();
      }
    });

    console.log('📚 Substack: Transformation complete');
  }

  /**
   * Override linkFootnotes to handle Substack's simplified <sup> tags
   * Converts <sup fn-count-id="N">N</sup> to fully linked footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`📚 Substack: Linking ${footnotes.length} footnotes to in-text references`);

    // Find all <sup fn-count-id="N"> tags created during extraction
    const supTags = dom.querySelectorAll('sup[fn-count-id]');
    let linkedCount = 0;

    supTags.forEach(sup => {
      const identifier = sup.getAttribute('fn-count-id');
      const footnote = footnotes.find(fn => fn.originalIdentifier === identifier);

      if (footnote) {
        // Create new sup element using centralized utility
        const newSup = createFootnoteSupElement(footnote.refId, identifier);

        // Replace existing sup with properly linked version
        sup.replaceWith(newSup);
        linkedCount++;
      } else {
        console.warn(`⚠️ Substack: Could not find footnote for identifier ${identifier}`);
      }
    });

    console.log(`  - Linked ${linkedCount} Substack footnote references`);
  }
}
