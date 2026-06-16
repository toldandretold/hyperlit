/**
 * Cambridge Processor
 * Handles Cambridge University Press content with specific structural patterns
 *
 * Key features:
 * - Converts `.xref.fn` links to simple <sup> tags
 * - Extracts footnotes from `[id^="reference-"][id$="-content"]` divs
 * - Normalizes to "N. Content" format for compatibility with general heuristic
 */

import { BaseFormatProcessor } from './base-processor';
import { isReferenceSectionHeading } from '../utils/dom-utils';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements
} from '../utils/transform-helpers';
import { createFootnoteSupElement } from '../utils/footnote-linker';

export class CambridgeProcessor extends BaseFormatProcessor {
  [key: string]: any;
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
  async extractFootnotes(dom: any, bookId: any) {
    const footnotes: any[] = [];
    const footnoteMappings = new Map();

    console.log('📚 Cambridge: Initial structure check:');
    console.log('  - .xref.fn links:', dom.querySelectorAll('.xref.fn').length);
    console.log('  - reference-*-content divs:', dom.querySelectorAll('[id^="reference-"][id$="-content"]').length);
    console.log('  - circle-list items:', dom.querySelectorAll('.circle-list__item').length);
    console.log('  - fn* divs:', dom.querySelectorAll('div[id^="fn"]').length);

    // STEP 1: Simplify in-text footnote links
    // Convert <a class="xref fn"><span>Footnote </span><sup>1</sup></a> → <sup>1</sup>
    const footnoteLinks = dom.querySelectorAll('.xref.fn, a[href^="#fn"]');
    console.log(`📚 Cambridge: Found ${footnoteLinks.length} in-text footnote links`);

    footnoteLinks.forEach((link: any, index: any) => {
      const sup = link.querySelector('sup');
      if (sup) {
        const identifier = sup.textContent.trim();
        // Create a clean <sup> using centralized utility
        // Note: ID will be assigned later by footnote-linker when footnotes are extracted
        const cleanSup = createFootnoteSupElement('', identifier);
        cleanSup.removeAttribute('id'); // Remove empty id, will be set by linker

        // Replace the entire link with just the <sup>
        link.replaceWith(cleanSup);
      }
    });

    // STEP 2: Convert footnote definitions to simple "N. Content" paragraphs
    // Convert <div id="reference-65-content"><p><span><sup>65</sup></span> Content</p></div> → <p>65. Content</p>
    const footnoteContainers = dom.querySelectorAll('[id^="reference-"][id$="-content"]');
    console.log(`📚 Cambridge: Found ${footnoteContainers.length} footnote definition containers`);

    footnoteContainers.forEach((container: any, index: any) => {
      const idMatch = container.id.match(/reference-(\d+)-content/);
      if (!idMatch) {
        console.log(`📚 Cambridge: Container ${index + 1} has no ID pattern`);
        return;
      }

      const footnoteNum = idMatch[1];

      // Author-date Cambridge articles reuse the reference-N-content markup
      // for bibliography entries, populated with CSL-style spans (.surname,
      // .year, .source…) instead of an inner <p>. Those aren't footnotes —
      // skip them here so extractReferences can claim them.
      const paragraph = container.querySelector('p.p, p');
      if (!paragraph) {
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

      // Store footnote WITHOUT number prefix
      // The UI will add the number when displaying, and base-processor will add it for static section
      footnotes.push(this.createFootnote(
        uniqueId,
        content,  // Just the content, no number prefix
        footnoteNum,
        uniqueRefId,
        'cambridge-normalized'
      ));

      footnoteMappings.set(footnoteNum, { uniqueId, uniqueRefId });

      // Replace container with simple paragraph (for intermediate processing)
      const simpleParagraph = document.createElement('p');
      simpleParagraph.innerHTML = `${footnoteNum}. ${content}`;
      container.replaceWith(simpleParagraph);

      // Remove the paragraph so it doesn't appear in main content
      simpleParagraph.remove();
    });

    // STEP 3: Find and REMOVE original footnote section containers
    // These contain the nested Vue components that need to be cleaned up
    // Pattern 1: circle-list containers (from format-registry.js selector).
    // Preserve wrappers that still hold an unextracted author-date CSL-style
    // reference (no inner <p>) — extractReferences needs to claim those.
    const circleListContainers = dom.querySelectorAll('.circle-list__item, .circle-list');
    let removedCircleLists = 0;
    circleListContainers.forEach((container: any) => {
      const innerRefs = container.querySelectorAll('[id^="reference-"][id$="-content"]');
      const hasUnextractedCsl = Array.from<any>(innerRefs).some((c: any) => !c.querySelector('p.p, p'));
      if (hasUnextractedCsl) return;
      container.remove();
      removedCircleLists++;
    });
    console.log(`📚 Cambridge: Removed ${removedCircleLists} circle-list containers`);

    // Pattern 2: Direct fn* divs
    const fnDivs = dom.querySelectorAll('div[id^="fn"]');
    fnDivs.forEach((div: any) => div.remove());
    console.log(`📚 Cambridge: Removed ${fnDivs.length} fn* divs`);

    console.log(`📚 Cambridge: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Extract and preserve main title/heading
   * Cambridge articles have h1/h2 titles that shouldn't be lost
   *
   * @param {HTMLElement} dom - DOM element
   * @returns {HTMLElement|null} - Extracted title element or null
   */
  extractAndPreserveTitle(dom: any) {
    // Look for the first h1 or h2 that looks like a main title
    const potentialTitles = dom.querySelectorAll('h1, h2');

    for (const heading of potentialTitles) {
      const text = heading.textContent.trim();

      // Skip if it's a section heading (References, Notes, etc.)
      if (/^(references|bibliography|notes|footnotes|abstract|introduction)$/i.test(text)) {
        continue;
      }

      // If it has substantial length, treat it as the main title
      if (text.length > 20) {
        console.log(`📚 Cambridge: Preserved title: "${text.substring(0, 60)}..."`);

        // Clone and remove from current position
        const titleClone = heading.cloneNode(true);
        heading.remove();

        return titleClone;
      }
    }

    return null;
  }

  /**
   * Extract references from Cambridge content
   * Uses stricter filtering to avoid extracting body text as references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom: any, bookId: any) {
    const references: any[] = [];

    console.log('📚 Cambridge: Using improved reference extraction');

    // PATH 1: Author-date articles encode bibliography entries in
    // `reference-N-content` divs that contain CSL spans rather than an inner
    // <p>. extractFootnotes leaves these untouched; pick them up here.
    const cslContainers = Array.from<any>(
      dom.querySelectorAll('[id^="reference-"][id$="-content"]')
    ).filter((c: any) => !c.querySelector('p.p, p'));

    if (cslContainers.length) {
      console.log(`📚 Cambridge: Found ${cslContainers.length} author-date CSL reference container(s)`);
    }

    cslContainers.forEach((container: any) => {
      const text = container.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      // appendStaticSections wraps reference.content in a <p>. The HTML parser
      // closes a <p> on encountering a block-level <div> inside, leaving the
      // <p> empty. Push the container's *inner* content (CSL spans, etc.) so
      // it nests cleanly inside the wrapper <p>.
      references.push({
        content: container.innerHTML,
        originalText: text,
        type: 'cambridge-reference',
        needsKeyGeneration: true,
      });
      // Remove from DOM so appendStaticSections doesn't render it twice.
      container.remove();
    });

    // PATH 2: Bibliography below a "References" heading as flat <p> elements.
    // Find the References/Bibliography heading anywhere in the tree.
    // Clipboard payloads commonly wrap the article in a container element, so
    // a direct-children walk over `dom.children` misses the heading entirely.
    const refHeadings = /^(references|bibliography|works cited)$/i;
    const headings = Array.from<any>(dom.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const referenceHeading = headings.find((h: any) => refHeadings.test(h.textContent.trim()));

    // ONLY process if we found a References heading
    if (!referenceHeading) {
      console.log('📚 Cambridge: No References/Bibliography heading found, skipping reference extraction');
      return references;
    }

    // Filter to in-text citation pattern (from general-processor.js)
    const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;

    // Collect <p> elements that come after the heading in document order,
    // regardless of nesting depth.
    const elementsToScan = Array.from<any>(dom.querySelectorAll('p')).filter((p: any) =>
      referenceHeading.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
    );

    elementsToScan.forEach((p: any) => {
      const text = p.textContent.trim();
      if (!text) return;

      // Skip if it looks like body text with in-text citations
      const citeMatch = text.match(inTextCitePattern);
      if (citeMatch) {
        const content = citeMatch[1];
        // Reject body paragraphs like "(see Smith, 2019)" or "(2017: 143)"
        if (content.includes(',') || content.includes(':') || /[a-zA-Z]{2,}/.test(content)) {
          return;
        }
      }

      // Check for year pattern
      const yearMatch = text.match(/(\d{4}[a-z]?)/);
      if (!yearMatch || yearMatch.index > 150) {
        return;
      }

      // Additional validation: check for bibliography structure
      // Must have: year + reasonable length + punctuation (., ,)
      if (text.length < 30 || !text.includes('.')) {
        return;
      }

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
   * Aggressive cleanup to remove Vue components and Cambridge-specific structures
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom: any, bookId: any) {
    console.log('📚 Cambridge: Applying aggressive structure transformation');

    // STEP 0: Extract and preserve title FIRST (before removals)
    const title = this.extractAndPreserveTitle(dom);

    // STEP 1: Remove specific Vue components that shouldn't be in content
    // Only remove actual Vue component elements (appbutton), not divs with Vue attributes
    const appButtons = dom.querySelectorAll('appbutton');
    appButtons.forEach((el: any) => el.remove());
    console.log(`📚 Cambridge: Removed ${appButtons.length} <appbutton> Vue components`);

    // STEP 2: Remove SVG/img elements from Vue components (icons, buttons)
    // Only remove images that are part of UI components, not content images
    const vueImages = dom.querySelectorAll('img[data-v-d2c09870], img[data-v-2a038744]');
    vueImages.forEach((el: any) => el.remove());
    console.log(`📚 Cambridge: Removed ${vueImages.length} Vue icon images`);

    // STEP 3: Remove Cambridge-specific structural classes
    // These were mostly removed in extractFootnotes, but catch any remaining
    const cambridgeStructural = dom.querySelectorAll('.circle-list, .circle-list__item, .circle-list__item__indicator, .circle-list__item__number, .circle-list__item__grouped, .circle-list__item__grouped__content');
    cambridgeStructural.forEach((el: any) => el.remove());
    console.log(`📚 Cambridge: Removed ${cambridgeStructural.length} Cambridge structural containers`);

    // NOTE: We don't remove all divs with data-v-* attributes because the entire body content has them
    // The base cleanup() will strip these attributes later

    // STEP 4: Remove Notes/References sections from main content
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // STEP 4.5: Remove elements with data-static-content
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 Cambridge: Removed ${removedSections + removedStatic} section(s) from main content`);

    // STEP 5: General unwrapping of remaining containers
    unwrapContainers(dom);

    // STEP 6: Re-insert title at start
    if (title) {
      dom.insertBefore(title, dom.firstChild);
      console.log('📚 Cambridge: Title re-inserted at start of content');
    }

    console.log('📚 Cambridge: Transformation complete');
  }

  /**
   * Override linkFootnotes to convert simplified <sup> tags to proper linked footnotes
   * Cambridge creates <sup fn-count-id="N">N</sup> during extraction
   * Need to convert to <sup id="refId" fn-count-id="N" class="footnote-ref">N</sup>
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom: any, footnotes: any) {
    console.log(`📚 Cambridge: Linking ${footnotes.length} footnotes to in-text references`);

    // Find all simplified <sup fn-count-id="N"> tags created during extraction
    const supTags = dom.querySelectorAll('sup[fn-count-id]');
    let linkedCount = 0;

    supTags.forEach((sup: any) => {
      const identifier = sup.getAttribute('fn-count-id');
      const footnote = footnotes.find((fn: any) => fn.originalIdentifier === identifier);

      if (footnote) {
        // Create new sup element using centralized utility
        const newSup = createFootnoteSupElement(footnote.refId, identifier);

        // Replace existing sup with new clean sup
        sup.replaceWith(newSup);

        linkedCount++;
      } else {
        console.warn(`⚠️ Cambridge: Could not find footnote for identifier ${identifier}`);
      }
    });

    console.log(`  - Linked ${linkedCount} Cambridge footnote references`);
  }
}
