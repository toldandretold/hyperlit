/**
 * ================================================================================================
 * FALLBACK PROCESSOR - Legacy Footnote/Reference Extraction
 * ================================================================================================
 *
 * This file provides fallback processing when format-specific processors don't extract
 * footnotes/references from pasted content. It uses the GeneralProcessor as a safety net.
 *
 * ================================================================================================
 * WHEN THIS IS USED
 * ================================================================================================
 *
 * Called by handleJsonPaste() in paste.js when:
 * - Format processor returned 0 footnotes AND 0 references
 * - Content might still contain extractable footnotes/references
 * - Need a second-pass extraction attempt
 *
 * ================================================================================================
 * WHAT IT DOES
 * ================================================================================================
 *
 * 1. Runs GeneralProcessor.process() on the content
 * 2. Extracts footnotes (anchor graph, <sup>, [^1], paragraph patterns)
 * 3. Extracts references (scans for bibliographies, years, authors)
 * 4. Returns processed content + mappings
 *
 * It does NOT persist anything — see the note in the function body. Saving and
 * syncing belong to the caller, which does both correctly and at the right time.
 *
 * ================================================================================================
 * KEY EXPORTS
 * ================================================================================================
 *
 * processContentForFootnotesAndReferences()  - Extraction only, no persistence
 *
 * ================================================================================================
 * RE-EXPORTS (for backward compatibility)
 * ================================================================================================
 *
 * The following utilities are re-exported for any legacy code that imports them from here:
 * - generateReferenceKeys
 * - processInTextCitations
 * - processFootnoteReferences
 *
 * ================================================================================================
 */

import { GeneralProcessor } from './format-processors/general-processor';

// ========================================================================
// ORCHESTRATION - Main entry point for footnote/reference processing
// ========================================================================

/**
 * Process pasted content for footnotes and references
 * This is now a simplified orchestrator that delegates to format processors
 *
 * @param {string} htmlContent - HTML content to process
 * @param {string} bookId - Book identifier
 * @param {boolean} isHTMLContent - Whether content is HTML (vs markdown/plain text)
 * @param {string} formatType - Format type identifier
 * @returns {Promise<Object>} - {processedContent, footnotes, references, footnoteMappings, referenceMappings}
 */
export async function processContentForFootnotesAndReferences(htmlContent: any, bookId: any, isHTMLContent = false, formatType = 'general') {
  console.log('🔍 [FALLBACK] Processing content via fallback processor...');
  console.log('🔍 Content type:', isHTMLContent ? 'HTML' : 'Markdown/Plain text');
  console.log('🔍 Format type:', formatType);

  // Use the general processor as fallback
  const processor = new GeneralProcessor();
  const result = await processor.process(htmlContent, bookId);

  // Build mappings for compatibility with old code
  const footnoteMappings = new Map();
  result.footnotes.forEach((footnote: any) => {
    if (footnote.originalIdentifier) {
      footnoteMappings.set(footnote.originalIdentifier, {
        uniqueId: footnote.footnoteId,
        uniqueRefId: footnote.refId
      });
    }
  });

  const referenceMappings = new Map();
  result.references.forEach((reference: any) => {
    if (reference.refKeys && reference.referenceId) {
      reference.refKeys.forEach((key: any) => {
        referenceMappings.set(key, reference.referenceId);
      });
    }
  });

  // NO persistence here. This function is EXTRACTION ONLY.
  //
  // It used to save to IndexedDB and push to PostgreSQL through four private
  // duplicates of the real code paths, and all four were broken. The saves
  // awaited an IDBRequest and a non-existent `tx.complete`, and wrote 3-field
  // records where the real path writes the full one. The syncs skipped the
  // isPasteInProgress() guard that indexedDB/footnotes and indexedDB/bibliography
  // both carry, so they fired before the book's `library` row existed and were
  // rejected by RLS ("Failed to sync references to PostgreSQL", prod case
  // book_1787965215968 at 01:00:17 — the same rows synced fine 6s later).
  //
  // The caller already does this properly: largePasteHandler saves via
  // saveAllFootnotesToIndexedDB / saveAllReferencesToIndexedDB, and
  // paste/index.ts pushes through syncPasteToPostgreSQL once the book exists.

  return {
    processedContent: result.html,
    footnotes: result.footnotes,
    references: result.references,
    footnoteMappings,
    referenceMappings
  };
}

// ========================================================================
// DATABASE STORAGE SYSTEM
// ========================================================================

// ========================================================================
// POSTGRESQL SYNC FUNCTIONS
// ========================================================================

// ========================================================================
// LEGACY EXPORTS (for backward compatibility)
// ========================================================================

// Re-export utilities for any code that still imports them from here
export { generateReferenceKeys } from './utils/reference-key-generator';
export { processInTextCitations } from './utils/citation-linker';
export { processFootnoteReferences } from './utils/footnote-linker';

// Note: The following functions have been removed and moved to format processors:
// - extractFootnotes() → moved to format processors
// - extractFootnotesFromHTML() → moved to format processors
// - extractReferences() → moved to format processors
// - extractReferencesFromHTML() → moved to format processors
// - extractPlainTextFootnotes() → moved to GeneralProcessor
