/**
 * Base Format Processor
 * Template Method Pattern - defines the processing pipeline
 * Subclasses override format-specific stages while common stages are implemented here
 */

import { normalizeContent } from '../utils/normalizer.js';
import { createTempDOM, removeEmptyBlocks, stripAttributes, groupInlineElements } from '../utils/dom-utils.js';
import { generateReferenceKeys } from '../utils/reference-key-generator.js';
import { processInTextCitations } from '../utils/citation-linker.js';
import { processFootnoteReferences } from '../utils/footnote-linker.js';

export class BaseFormatProcessor {
  /**
   * @param {string} formatType - Format identifier (e.g., 'cambridge', 'oup')
   */
  constructor(formatType) {
    this.formatType = formatType;
  }

  /**
   * Template method - defines the algorithm structure
   * Subclasses override specific stages but cannot change the order
   *
   * @param {string} htmlContent - Raw HTML content to process
   * @param {string} bookId - Book identifier for database operations
   * @returns {Promise<{html: string, footnotes: Array, references: Array, formatType: string}>}
   */
  async process(htmlContent, bookId) {
    console.log(`📚 Processing ${this.formatType} format`);

    // Stage 1: Create DOM and normalize (common)
    const dom = this.createDOM(htmlContent);
    this.normalize(dom);

    // Stage 2: Extract footnotes (format-specific)
    const footnotes = await this.extractFootnotes(dom, bookId);
    console.log(`  - Extracted ${footnotes.length} footnotes`);

    // Stage 3: Extract references (format-specific)
    const references = await this.extractReferences(dom, bookId);
    console.log(`  - Extracted ${references.length} references`);

    // Stage 4: Transform structure (format-specific)
    await this.transformStructure(dom, bookId);

    // Stage 5: Cleanup (common) - BEFORE linking so we don't strip essential classes
    this.cleanup(dom);

    // Stage 6: Link processing (common, but uses format-specific data)
    this.linkCitations(dom, references);
    this.linkFootnotes(dom, footnotes);

    console.log(`✅ ${this.formatType} processing complete`);

    return {
      html: dom.innerHTML,
      footnotes,
      references,
      formatType: this.formatType
    };
  }

  /**
   * Lightweight processing for small pastes (≤10 nodes)
   * Only runs security-critical stages: normalize + cleanup
   * Skips footnote/reference extraction, structure transformation, and linking
   *
   * @param {string} htmlContent - Raw HTML content to process
   * @param {string} bookId - Book identifier for database operations
   * @returns {Promise<{html: string, footnotes: Array, references: Array, formatType: string}>}
   */
  async processLite(htmlContent, bookId) {
    console.log(`📚 [LITE] Processing ${this.formatType} format (minimal)`);

    // Stage 1: Create DOM and normalize (common)
    const dom = this.createDOM(htmlContent);
    this.normalize(dom);

    // Stage 2: Cleanup (SECURITY CRITICAL - strips XSS attributes)
    this.cleanup(dom);

    console.log(`✅ [LITE] ${this.formatType} processing complete`);

    return {
      html: dom.innerHTML,
      footnotes: [],
      references: [],
      formatType: this.formatType
    };
  }

  // ========================================================================
  // COMMON STAGES (implemented in base class)
  // ========================================================================

  /**
   * Create a temporary DOM element from HTML
   * @param {string} html - HTML content
   * @returns {HTMLElement} - DOM element
   */
  createDOM(html) {
    return createTempDOM(html);
  }

  /**
   * Normalize content (smart quotes, nbsp, etc.)
   * @param {HTMLElement} dom - DOM to normalize
   */
  normalize(dom) {
    // Normalize HTML content
    const normalizedHtml = normalizeContent(dom.innerHTML, true);
    dom.innerHTML = normalizedHtml;
  }

  /**
   * Link in-text citations to references
   * Common pattern: (Author, Year) → linked to reference
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Extracted references with mappings
   */
  linkCitations(dom, references) {
    if (!references || references.length === 0) return;

    // Post-process references that need key generation
    const referenceMappings = new Map();

    references.forEach((ref, index) => {
      // If reference needs key generation, generate them now
      if (ref.needsKeyGeneration) {
        const refKeys = generateReferenceKeys(ref.originalText || ref.content, '', this.formatType);

        // Use first key as referenceId if not already set
        if (!ref.referenceId) {
          if (refKeys.length > 0) {
            ref.referenceId = refKeys[0];
          } else {
            // Fallback: generate unique ID if no keys could be generated
            ref.referenceId = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            console.warn(`⚠️ ${this.formatType}: No keys generated for reference, using fallback ID: ${ref.referenceId}`);
          }
        }

        // Store refKeys on reference object
        ref.refKeys = refKeys.length > 0 ? refKeys : [ref.referenceId];

        // Map all keys to this reference ID
        ref.refKeys.forEach(key => {
          referenceMappings.set(key, ref.referenceId);
        });
      } else if (ref.refKeys && ref.referenceId) {
        // Reference already has keys, just populate mappings
        ref.refKeys.forEach(key => {
          referenceMappings.set(key, ref.referenceId);
        });
      }
    });

    console.log(`  - Built reference mappings: ${referenceMappings.size} keys for ${references.length} references`);

    // Apply citation linking using the old working code
    if (referenceMappings.size > 0) {
      const linkedHtml = processInTextCitations(dom.innerHTML, referenceMappings, references, this.formatType);
      dom.innerHTML = linkedHtml;
      console.log(`  - Citation linking complete`);
    }
  }

  /**
   * Link footnote references to footnotes
   * Common pattern: <sup>1</sup> → linked to footnote
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Extracted footnotes with mappings
   */
  linkFootnotes(dom, footnotes) {
    if (!footnotes || footnotes.length === 0) return;

    // Build footnoteMappings from footnotes array
    const footnoteMappings = new Map();
    footnotes.forEach(footnote => {
      if (footnote.originalIdentifier) {
        footnoteMappings.set(footnote.originalIdentifier, {
          uniqueId: footnote.footnoteId,
          uniqueRefId: footnote.refId
        });
      }
    });

    // Apply footnote reference linking
    if (footnoteMappings.size > 0) {
      const linkedHtml = processFootnoteReferences(dom.innerHTML, footnoteMappings, this.formatType);
      dom.innerHTML = linkedHtml;
      console.log(`  - Footnote linking complete: ${footnotes.length} footnotes`);
    }
  }

  /**
   * Cleanup DOM (remove empty elements, strip attributes, etc.)
   * @param {HTMLElement} dom - DOM element
   */
  cleanup(dom) {
    // Remove empty block elements
    removeEmptyBlocks(dom);

    // Strip styles, classes, and non-essential IDs
    stripAttributes(dom, 'pasted-'); // Preserve IDs starting with 'pasted-'

    // Group loose inline elements into paragraphs
    groupInlineElements(dom);

    console.log(`  - Cleanup complete`);
  }

  // ========================================================================
  // FORMAT-SPECIFIC STAGES (must be overridden by subclasses)
  // ========================================================================

  /**
   * Extract footnotes from content
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement extractFootnotes()`);
  }

  /**
   * Extract references/bibliography from content
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement extractReferences()`);
  }

  /**
   * Transform document structure (format-specific transformations)
   * Must be implemented by subclass
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    throw new Error(`${this.formatType} processor must implement transformStructure()`);
  }

  // ========================================================================
  // HELPER METHODS (available to subclasses)
  // ========================================================================

  /**
   * Generate unique footnote ID
   * @param {string} bookId - Book identifier
   * @param {string|number} identifier - Footnote identifier (e.g., '1')
   * @returns {string} - Unique footnote ID
   */
  generateFootnoteId(bookId, identifier) {
    return `${bookId}Fn${Date.now()}${identifier}`;
  }

  /**
   * Generate unique footnote reference ID
   * @param {string} bookId - Book identifier
   * @param {string|number} identifier - Footnote identifier
   * @returns {string} - Unique reference ID
   */
  generateFootnoteRefId(bookId, identifier) {
    return `${bookId}Fnref${Date.now()}${identifier}`;
  }

  /**
   * Create footnote object with standard structure
   * @param {string} footnoteId - Unique footnote ID
   * @param {string} content - Footnote content (HTML)
   * @param {string|number} originalIdentifier - Original identifier from source
   * @param {string} refId - Reference ID for back-linking
   * @param {string} type - Type of footnote (e.g., 'html-paragraph-heuristic')
   * @returns {Object} - Footnote object
   */
  createFootnote(footnoteId, content, originalIdentifier, refId, type) {
    return {
      footnoteId,
      content,
      originalIdentifier: String(originalIdentifier),
      refId,
      type
    };
  }

  /**
   * Create reference object with standard structure
   * @param {string} referenceId - Unique reference ID
   * @param {string} content - Reference content (HTML)
   * @param {string} originalText - Original text for key generation
   * @param {string} type - Type of reference
   * @param {Array<string>} refKeys - Reference keys for lookup
   * @returns {Object} - Reference object
   */
  createReference(referenceId, content, originalText, type, refKeys = []) {
    return {
      referenceId,
      content,
      originalText,
      type,
      refKeys
    };
  }
}
