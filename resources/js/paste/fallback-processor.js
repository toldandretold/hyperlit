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
 * 2. Extracts footnotes (scans for <sup>, [^1], paragraph patterns)
 * 3. Extracts references (scans for bibliographies, years, authors)
 * 4. Saves extracted data to IndexedDB
 * 5. Syncs to PostgreSQL via API endpoints
 * 6. Returns processed content + mappings
 *
 * ================================================================================================
 * KEY EXPORTS
 * ================================================================================================
 *
 * processContentForFootnotesAndReferences()  - Main extraction + save pipeline
 * saveFootnotesToIndexedDB()                 - Direct IndexedDB save
 * saveReferencesToIndexedDB()                - Direct IndexedDB save
 *
 * ================================================================================================
 * RE-EXPORTS (for backward compatibility)
 * ================================================================================================
 *
 * The following utilities are re-exported for any legacy code that imports them from here:
 * - generateReferenceKeys
 * - processInTextCitations
 * - processFootnoteReferences
 * - preprocessHTMLContent, isRealLink
 *
 * ================================================================================================
 */

import { openDatabase } from '../indexedDB/index.js';
import { GeneralProcessor } from './format-processors/general-processor.js';

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
export async function processContentForFootnotesAndReferences(htmlContent, bookId, isHTMLContent = false, formatType = 'general') {
  console.log('🔍 [FALLBACK] Processing content via fallback processor...');
  console.log('🔍 Content type:', isHTMLContent ? 'HTML' : 'Markdown/Plain text');
  console.log('🔍 Format type:', formatType);

  // Use the general processor as fallback
  const processor = new GeneralProcessor();
  const result = await processor.process(htmlContent, bookId);

  // Build mappings for compatibility with old code
  const footnoteMappings = new Map();
  result.footnotes.forEach(footnote => {
    if (footnote.originalIdentifier) {
      footnoteMappings.set(footnote.originalIdentifier, {
        uniqueId: footnote.footnoteId,
        uniqueRefId: footnote.refId
      });
    }
  });

  const referenceMappings = new Map();
  result.references.forEach(reference => {
    if (reference.refKeys && reference.referenceId) {
      reference.refKeys.forEach(key => {
        referenceMappings.set(key, reference.referenceId);
      });
    }
  });

  // Save to IndexedDB
  await Promise.all([
    saveFootnotesToIndexedDB(result.footnotes, bookId),
    saveReferencesToIndexedDB(result.references, bookId)
  ]);

  // Sync to PostgreSQL
  const syncPromises = [];

  if (result.footnotes.length > 0) {
    syncPromises.push(syncFootnotesToPostgreSQL(result.footnotes, bookId));
  }

  if (result.references.length > 0) {
    syncPromises.push(syncReferencesToPostgreSQL(result.references, bookId));
  }

  if (syncPromises.length > 0) {
    try {
      await Promise.all(syncPromises);
      console.log(`✅ Synced ${result.footnotes.length} footnotes and ${result.references.length} references to PostgreSQL`);
    } catch (error) {
      console.error('❌ Failed to sync footnotes/references to PostgreSQL:', error);
    }
  }

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

/**
 * Save footnotes to IndexedDB
 * @param {Array} footnotes - Array of footnote objects
 * @param {string} bookId - Book identifier
 */
export async function saveFootnotesToIndexedDB(footnotes, bookId) {
  if (footnotes.length === 0) return;

  try {
    const db = await openDatabase();
    const tx = db.transaction(['footnotes'], 'readwrite');
    const store = tx.objectStore('footnotes');

    for (const footnote of footnotes) {
      const key = [bookId, footnote.footnoteId];
      await store.put({
        book: bookId,
        footnoteId: footnote.footnoteId,
        content: footnote.content
      });
    }

    await tx.complete;
    console.log(`✅ Saved ${footnotes.length} footnotes to IndexedDB`);
  } catch (error) {
    console.error('❌ Error saving footnotes to IndexedDB:', error);
  }
}

/**
 * Save references to IndexedDB
 * @param {Array} references - Array of reference objects
 * @param {string} bookId - Book identifier
 */
export async function saveReferencesToIndexedDB(references, bookId) {
  if (references.length === 0) return;

  try {
    const db = await openDatabase();
    const tx = db.transaction(['references'], 'readwrite');
    const store = tx.objectStore('references');

    for (const reference of references) {
      const key = [bookId, reference.referenceId];
      await store.put({
        book: bookId,
        referenceId: reference.referenceId,
        content: reference.content
      });
    }

    await tx.complete;
    console.log(`✅ Saved ${references.length} references to IndexedDB`);
  } catch (error) {
    console.error('❌ Error saving references to IndexedDB:', error);
  }
}

// ========================================================================
// POSTGRESQL SYNC FUNCTIONS
// ========================================================================

/**
 * Sync footnotes directly to PostgreSQL
 * @param {Array} footnotes - Array of footnote objects
 * @param {string} bookId - Book identifier
 */
async function syncFootnotesToPostgreSQL(footnotes, bookId) {
  if (!footnotes || footnotes.length === 0) return;

  try {
    const response = await fetch('/api/db/footnotes/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        book: bookId,
        data: footnotes.map(footnote => ({
          footnoteId: footnote.footnoteId,
          content: footnote.content
        }))
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`✅ PostgreSQL footnotes sync: ${result.message}`);
    return result;

  } catch (error) {
    console.error('❌ Failed to sync footnotes to PostgreSQL:', error);
    throw error;
  }
}

/**
 * Sync references directly to PostgreSQL
 * @param {Array} references - Array of reference objects
 * @param {string} bookId - Book identifier
 */
async function syncReferencesToPostgreSQL(references, bookId) {
  if (!references || references.length === 0) return;

  // Validate and filter references before syncing
  const validReferences = [];

  references.forEach((reference, index) => {
    // Check if referenceId is a string
    if (typeof reference.referenceId !== 'string') {
      console.error(`❌ Reference ${index} has non-string referenceId:`, reference);
      return;
    }

    // Check if content is a string
    if (typeof reference.content !== 'string') {
      console.error(`❌ Reference ${index} has non-string content:`, reference);
      return;
    }

    // Check for empty values
    if (!reference.referenceId || !reference.content) {
      console.warn(`⚠️ Reference ${index} has empty referenceId or content:`, reference);
      return;
    }

    validReferences.push(reference);
  });

  if (validReferences.length === 0) {
    console.warn('⚠️ No valid references to sync after validation');
    return;
  }

  if (validReferences.length < references.length) {
    console.warn(`⚠️ Filtered out ${references.length - validReferences.length} invalid references`);
  }

  // Log what we're about to send
  const dataToSend = validReferences.map((reference, index) => {
    const mapped = {
      referenceId: reference.referenceId,
      content: reference.content
    };

    // Extra validation: check the mapped data
    if (typeof mapped.referenceId !== 'string') {
      console.error(`❌ MAPPED reference ${index} has non-string referenceId:`, mapped);
    }
    if (typeof mapped.content !== 'string') {
      console.error(`❌ MAPPED reference ${index} has non-string content:`, typeof mapped.content, mapped);
    }

    return mapped;
  });

  console.log(`📤 About to sync ${dataToSend.length} references to PostgreSQL`);
  console.log('📤 First reference:', dataToSend[0]);
  console.log('📤 Last reference:', dataToSend[dataToSend.length - 1]);

  try {
    const response = await fetch('/api/db/references/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        book: bookId,
        data: dataToSend
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`✅ PostgreSQL references sync: ${result.message}`);
    return result;

  } catch (error) {
    console.error('❌ Failed to sync references to PostgreSQL:', error);
    throw error;
  }
}

// ========================================================================
// LEGACY EXPORTS (for backward compatibility)
// ========================================================================

// Re-export utilities for any code that still imports them from here
export { generateReferenceKeys } from './utils/reference-key-generator.js';
export { processInTextCitations } from './utils/citation-linker.js';
export { processFootnoteReferences } from './utils/footnote-linker.js';
export { preprocessHTMLContent, isRealLink } from './utils/html-preprocessor.js';

// Note: The following functions have been removed and moved to format processors:
// - extractFootnotes() → moved to format processors
// - extractFootnotesFromHTML() → moved to format processors
// - extractReferences() → moved to format processors
// - extractReferencesFromHTML() → moved to format processors
// - extractPlainTextFootnotes() → moved to GeneralProcessor
