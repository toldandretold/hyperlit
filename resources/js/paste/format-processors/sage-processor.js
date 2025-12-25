/**
 * Sage Publications Processor
 * Handles Sage Publications content
 *
 * Key features:
 * - Extracts footnotes from structured elements
 * - Extracts references from .citations, .ref, [role="listitem"]
 * - Flexible heuristic-based extraction
 */

import { BaseFormatProcessor } from './base-processor.js';
import { isReferenceSectionHeading } from '../utils/dom-utils.js';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements,
  cloneAndClean,
  isValidReference,
  addUniqueReference,
  reformatCitationLink
} from '../utils/transform-helpers.js';
import { createFootnoteSupElement } from '../utils/footnote-linker.js';

export class SageProcessor extends BaseFormatProcessor {
  constructor() {
    super('sage');
  }

  /**
   * Extract footnotes from Sage structure
   * Sage typically uses <sup> tags for footnote markers
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];
    const footnoteMappings = new Map();

    console.log('📚 Sage: Looking for footnotes');

    // Find <sup> tags to identify referenced footnotes
    const supElements = dom.querySelectorAll('sup');
    const refIdentifiers = new Set();
    const refIdMapping = new Map(); // Maps "2" -> "fn2-02633957251384867"

    supElements.forEach(sup => {
      const identifier = sup.textContent.trim() || sup.getAttribute('fn-count-id');
      if (identifier && /^\d+$/.test(identifier)) {
        refIdentifiers.add(identifier);

        // Check if link has href with full ID
        const link = sup.querySelector('a[href*="#fn"]');
        if (link) {
          const href = link.getAttribute('href');
          const match = href.match(/#(fn\d+-[a-z0-9]+)/);
          if (match) {
            refIdMapping.set(identifier, match[1]);
            console.log(`📚 Sage: Mapped footnote ${identifier} to ID ${match[1]}`);
          }
        }
      }
    });

    console.log(`📚 Sage: Found ${refIdentifiers.size} footnote references in <sup> tags`);

    // Find potential footnote definitions
    // Look for elements with IDs or paragraphs starting with "N. "
    const potentialDefs = new Map();

    // Strategy 0: Look for elements by ID (most reliable for Sage)
    for (const identifier of refIdentifiers) {
      let fnElement = null;

      // Try complex ID first (from refIdMapping)
      if (refIdMapping.has(identifier)) {
        const fullId = refIdMapping.get(identifier);
        fnElement = dom.querySelector(`#${fullId}`);
        if (fnElement) {
          console.log(`📚 Sage: Found footnote ${identifier} by complex ID: ${fullId}`);
        }
      }

      // Try simple ID pattern if not found
      if (!fnElement) {
        fnElement = dom.querySelector(`#fn${identifier}`);
        if (fnElement) {
          console.log(`📚 Sage: Found footnote ${identifier} by simple ID: fn${identifier}`);
        }
      }

      if (fnElement) {
        potentialDefs.set(identifier, fnElement);
      }
    }

    console.log(`📚 Sage: Found ${potentialDefs.size} footnotes by ID`);

    // Strategy 1: Look for [role="listitem"] elements (Sage pattern)
    const listItems = dom.querySelectorAll('[role="listitem"]');
    listItems.forEach(item => {
      const text = item.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1])) {
        potentialDefs.set(match[1], item);
        console.log(`📚 Sage: Found footnote ${match[1]} in listitem: "${text.substring(0, 50)}..."`);
      }
    });

    // Strategy 2: Look for .ref elements
    const refElements = dom.querySelectorAll('.ref');
    refElements.forEach(ref => {
      const text = ref.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1]) && !potentialDefs.has(match[1])) {
        potentialDefs.set(match[1], ref);
        console.log(`📚 Sage: Found footnote ${match[1]} in .ref: "${text.substring(0, 50)}..."`);
      }
    });

    // Strategy 3: Look for regular paragraphs with "N. " pattern
    dom.querySelectorAll('p').forEach(p => {
      const text = p.textContent.trim();
      const match = text.match(/^(\d+)[\.\)\s]/);
      if (match && refIdentifiers.has(match[1]) && !potentialDefs.has(match[1])) {
        potentialDefs.set(match[1], p);
        console.log(`📚 Sage: Found footnote ${match[1]} in paragraph: "${text.substring(0, 50)}..."`);
      }
    });

    // Extract footnotes from found definitions
    for (const identifier of refIdentifiers) {
      const element = potentialDefs.get(identifier);

      if (element) {
        // Extract content, removing the "N. " prefix
        // Handle both plain text and HTML-wrapped numbers like <span>2.</span>
        let htmlContent = element.innerHTML.trim();
        htmlContent = htmlContent.replace(/^(\s*<[^>]+>)*\s*\d+[\.\)]\s*/, '');

        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          'sage'
        );

        footnotes.push(footnote);
        footnoteMappings.set(identifier, footnote);

        console.log(`📚 Sage: Extracted footnote ${identifier}: "${htmlContent.substring(0, 50)}..."`);

        // Remove from DOM
        element.remove();
      } else {
        console.warn(`⚠️ Sage: Could not find definition for footnote ${identifier}`);
      }
    }

    console.log(`📚 Sage: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Extract references from Sage bibliography
   * Sage uses elements with IDs matching citation data-xml-rid attributes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    console.log('📚 Sage: Looking for references');

    // Strategy 1: Find bibliography elements by ID (matching data-xml-rid from citations)
    // Look for elements with IDs starting with "bibr" (e.g., id="bibr13-02633957251384867")
    const biblioElements = dom.querySelectorAll('[id^="bibr"]');
    if (biblioElements.length > 0) {
      console.log(`📚 Sage: Found ${biblioElements.length} bibliography elements with bibr IDs`);

      biblioElements.forEach(element => {
        const xmlRid = element.id; // e.g., "bibr13-02633957251384867"

        // Clone and clean element
        const clone = cloneAndClean(element, ['.external-links', '.core-xlink-google-scholar', '.to-citation__wrapper']);

        // Try to find the actual citation content
        let contentElement = clone.querySelector('.citation-content');
        if (!contentElement) {
          // Fallback: use the entire element if no .citation-content found
          contentElement = clone;
        }

        const text = contentElement.textContent.trim();
        const htmlContent = contentElement.innerHTML.trim();

        // Check if it looks like a reference (contains year and has substantial content)
        if (isValidReference(text)) {
          references.push({
            content: htmlContent,
            originalText: text,
            type: 'sage-biblio',
            needsKeyGeneration: true,
            xmlRid: xmlRid // Store for potential linking
          });

          console.log(`📚 Sage: Extracted reference ${xmlRid}: "${text.substring(0, 60)}..."`);
        }
      });
    }

    // Strategy 2: Fallback - Find .citations containers
    if (references.length === 0) {
      const citationContainers = dom.querySelectorAll('.citations');
      if (citationContainers.length > 0) {
        console.log(`📚 Sage: Fallback - Found ${citationContainers.length} .citations containers`);

        citationContainers.forEach(container => {
          // Look for list items or paragraphs inside
          const items = container.querySelectorAll('li, p, [role="listitem"]');

          items.forEach(item => {
            // Clone and clean
            const clone = cloneAndClean(item, ['.external-links', '.core-xlink-google-scholar', '.to-citation__wrapper']);

            const text = clone.textContent.trim();
            const htmlContent = clone.innerHTML.trim();

            // Check if it looks like a reference (contains year)
            if (isValidReference(text)) {
              references.push({
                content: htmlContent,
                originalText: text,
                type: 'sage-citation',
                needsKeyGeneration: true
              });

              console.log(`📚 Sage: Extracted reference from .citations: "${text.substring(0, 60)}..."`);
            }
          });
        });
      }
    }

    // Strategy 2: Find standalone .ref elements (not already processed as footnotes)
    const refElements = dom.querySelectorAll('.ref');
    refElements.forEach(ref => {
      const text = ref.textContent.trim();

      // Skip if it looks like a footnote (starts with number)
      if (/^\d+[\.\)]/.test(text)) {
        return;
      }

      // Check if it looks like a reference (contains year)
      if (isValidReference(text)) {
        // Clone and clean
        const clone = cloneAndClean(ref, ['.external-links', '.core-xlink-google-scholar', '.to-citation__wrapper']);

        const cleanText = clone.textContent.trim();
        const htmlContent = clone.innerHTML.trim();

        // Avoid duplicates using utility
        const newRef = {
          content: htmlContent,
          originalText: cleanText,
          type: 'sage-ref',
          needsKeyGeneration: true
        };

        if (addUniqueReference(references, newRef)) {
          console.log(`📚 Sage: Extracted reference from .ref: "${cleanText.substring(0, 60)}..."`);
        }
      }
    });

    // Strategy 3: Fallback to general reference section detection
    if (references.length === 0) {
      console.log('📚 Sage: No specific elements found, using general reference detection');

      const allElements = Array.from(dom.children);
      let referenceSectionStartIndex = -1;

      const refHeadings = /^(references|bibliography|notes|sources)$/i;
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
          referenceSectionStartIndex = i;
          break;
        }
      }

      if (referenceSectionStartIndex !== -1) {
        const elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');

        elementsToScan.forEach(p => {
          // Clone and clean
          const clone = cloneAndClean(p, ['.external-links', '.core-xlink-google-scholar', '.to-citation__wrapper']);

          const text = clone.textContent.trim();
          const htmlContent = clone.innerHTML.trim();

          if (!text) return;

          if (isValidReference(text)) {
            references.push({
              content: htmlContent,
              originalText: text,
              type: 'sage-paragraph',
              needsKeyGeneration: true
            });
          }
        });
      }
    }

    console.log(`📚 Sage: Total references extracted: ${references.length}`);

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
    console.log('📚 Sage: Applying general structure transformation');

    // STEP 1: Remove original Footnotes/References sections from main content
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // STEP 2: Remove elements with data-static-content
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 Sage: Removed ${removedSections + removedStatic} section(s) from main content`);

    // STEP 3: Unwrap all container elements
    unwrapContainers(dom);

    console.log(`📚 Sage: Transformation complete`);
  }

  /**
   * Override linkCitations to convert Sage-specific citation links
   * Sage uses <a role="doc-biblioref" data-xml-rid="bibr*"> for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    console.log('📚 Sage: Converting Sage-specific citation links...');

    // Find all Sage citation links
    const citationLinks = dom.querySelectorAll('a[role="doc-biblioref"], a[data-xml-rid^="bibr"]');
    let convertedCount = 0;
    let failedCount = 0;

    citationLinks.forEach(link => {
      const citText = link.textContent.trim();
      const xmlRid = link.getAttribute('data-xml-rid');

      console.log(`📚 Sage: Processing citation link: "${citText}" (xml-rid: ${xmlRid})`);

      // Parse citation text to extract author and year
      // Sage patterns: "Author, Year", "Author et al., Year", "Author and Author, Year"
      const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
      if (!yearMatch) {
        console.warn(`⚠️ Sage: Could not extract year from citation: "${citText}"`);
        failedCount++;
        return;
      }

      const year = yearMatch[1];
      const beforeYear = citText.substring(0, yearMatch.index).trim();

      // Detect citation style: narrative vs parenthetical
      // Narrative: "Durose et al. (2022)" - beforeYear ends with "("
      // Parenthetical: "Durose et al., 2022" - beforeYear ends with comma or author name
      const isNarrative = beforeYear.endsWith('(');

      // Generate possible citation keys
      const possibleKeys = [];

      if (beforeYear) {
        // Clean author text: remove "et al.", "and", trailing commas, opening paren
        let cleanAuthor = beforeYear
          .replace(/\s+et\s+al\.?/gi, '')     // Remove "et al."
          .replace(/\s+and\s+/gi, ' ')        // Remove "and"
          .replace(/,\s*$/g, '')              // Remove trailing comma
          .replace(/\(\s*$/g, '')             // Remove trailing opening paren (narrative citations)
          .trim();

        // Split on comma if multiple authors
        const authorParts = cleanAuthor.split(/\s*,\s*/);
        const firstAuthor = authorParts[0];

        // Take last word as surname
        const words = firstAuthor.split(/\s+/);
        const surname = words[words.length - 1];

        possibleKeys.push(surname.toLowerCase() + year);

        // Also try without hyphens for flexibility
        if (surname.includes('-')) {
          possibleKeys.push(surname.toLowerCase().replace(/-/g, '') + year);
        }

        // If multiple authors, try concatenated surnames
        if (authorParts.length > 1) {
          const surnames = authorParts.map(part => {
            const w = part.trim().split(/\s+/);
            return w[w.length - 1].toLowerCase();
          });
          possibleKeys.push(surnames.join('') + year);
        }

        console.log(`📚 Sage: Generated keys for "${citText}": [${possibleKeys.join(', ')}]`);
      }

      // Also try just the year
      possibleKeys.push(year.toLowerCase());

      // Try to find a matching reference
      let matchedReference = null;

      // Strategy 1: Try direct xmlRid match (most reliable for Sage)
      if (xmlRid) {
        matchedReference = references.find(ref => ref.xmlRid === xmlRid);
        if (matchedReference) {
          console.log(`📚 Sage: Matched "${citText}" to reference via xmlRid "${xmlRid}"`);
        }
      }

      // Strategy 2: Try fuzzy key-based matching (fallback)
      if (!matchedReference) {
        for (const reference of references) {
          if (reference.refKeys) {
            for (const key of possibleKeys) {
              if (reference.refKeys.includes(key)) {
                matchedReference = reference;
                console.log(`📚 Sage: Matched "${citText}" to reference via key "${key}"`);
                break;
              }
            }
          }
          if (matchedReference) break;
        }
      }

      if (matchedReference && matchedReference.referenceId) {
        // Convert to proper citation link
        link.setAttribute('href', `#${matchedReference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');

        // Prepare author text (clean up based on citation style)
        let cleanAuthor = '';
        if (beforeYear) {
          if (isNarrative) {
            // Remove trailing opening paren and whitespace for narrative
            cleanAuthor = beforeYear.replace(/\(\s*$/, '').trim();
          } else {
            // Remove trailing comma/whitespace and add comma separator for parenthetical
            cleanAuthor = beforeYear.replace(/[,\s]+$/, '') + ', ';
          }
        }

        // Get trailing text after year (e.g., ": 143")
        const afterYearPos = citText.indexOf(year) + year.length;
        const trailing = isNarrative ? '' : citText.substring(afterYearPos);

        // Use shared utility for citation reformatting
        reformatCitationLink(link, {
          author: cleanAuthor,
          year,
          isNarrative,
          trailing
        });

        // Remove Sage-specific attributes
        link.removeAttribute('role');
        link.removeAttribute('data-xml-rid');

        convertedCount++;
      } else {
        console.warn(`⚠️ Sage: Could not find reference for "${citText}" (${xmlRid}), tried keys:`, possibleKeys);
        failedCount++;
      }
    });

    console.log(`  - Converted ${convertedCount} Sage citation links, ${failedCount} failed`);
  }

  /**
   * Override linkFootnotes to handle Sage-specific linking
   * Similar to general processor - finds <sup> tags and links them
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`📚 Sage: Linking ${footnotes.length} footnotes to in-text references`);

    const supTags = dom.querySelectorAll('sup');
    let linkedCount = 0;

    supTags.forEach(sup => {
      const identifier = sup.textContent.trim() || sup.getAttribute('fn-count-id');

      if (/^\d+$/.test(identifier)) {
        const footnote = footnotes.find(fn => fn.originalIdentifier === identifier);

        if (footnote) {
          // Create new sup element using centralized utility (removes old anchor pattern)
          const newSup = createFootnoteSupElement(footnote.refId, identifier);

          // Replace the existing sup with new clean sup
          sup.replaceWith(newSup);

          linkedCount++;
        }
      }
    });

    console.log(`  - Linked ${linkedCount} Sage footnote references`);
  }
}
