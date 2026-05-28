/**
 * References (Bibliography) Operations Module
 * Handles reference/bibliography operations in IndexedDB
 */

import { openDatabase } from '../core/connection.js';
import { syncReferencesToPostgreSQL } from './syncReferencesToPostgreSQL.js';

// Import from the main indexedDB file (temporary until fully refactored)
let withPending;

// Initialization function to inject dependencies
export function initReferencesDependencies(deps) {
  withPending = deps.withPending;
}

/**
 * Save an array of reference objects to IndexedDB (bulk operation)
 * Then syncs to PostgreSQL
 *
 * @param {Array} references - Array of reference objects
 * @param {string} bookId - Book identifier
 * @returns {Promise<void>}
 */
export async function saveAllReferencesToIndexedDB(references, bookId) {
  if (!references || references.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("bibliography", "readwrite");
    const store = tx.objectStore("bibliography");

    references.forEach((reference) => {
      const record = { ...reference, book: bookId };
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      // Make the oncomplete handler async to use await
      tx.oncomplete = async () => {
        console.log(
          `✅ ${references.length} references successfully saved to IndexedDB for book: ${bookId}`
        );

        // --- ADDED: Trigger the sync to PostgreSQL ---
        try {
          // syncReferencesToPostgreSQL already imported statically
          await syncReferencesToPostgreSQL(bookId, references);
        } catch (err) {
          console.warn("⚠️ Reference sync to PostgreSQL failed:", err);
        }
        // --- END ADDED ---

        resolve();
      };
      tx.onerror = (e) => {
        console.error("❌ Error saving references to IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// PostgreSQL Sync
export {
  syncReferencesToPostgreSQL,
} from './syncReferencesToPostgreSQL.js';

/**
 * Resolve a bibliography record to the right click-time target.
 *
 * Test coverage: tests/javascript/indexedDB/bibliographyResolver.test.js (Vitest)
 * — 10 tests covering: canonical→best-version, citation-card fallback when
 * canonical has no version, network-error fallback to source_id, legacy
 * source_id-only records, source_has_nodes back-compat.
 * See tests/Feature/Citations/README.md for the full suite.
 *
 * Returns one of:
 *   { type: 'library', book, has_nodes, metadata? } — navigate to that library row
 *   { type: 'citation-card', canonical_source_id, metadata } — show citation-only card
 *   null — couldn't resolve (corrupt record / orphan canonical / network issue)
 *
 * Precedence:
 *   1. canonical_source_id (modern citations) → /api/canonical/{id}/best-version
 *      - server returns a visible library version if one exists → navigate
 *      - server returns book: null → citation-card mode
 *   2. source_id (legacy + orphan-library citations) → navigate to that book
 *
 * Network failures on the canonical lookup fall through to source_id when
 * available, so legacy behaviour stays intact if the new endpoint is down.
 *
 * @param {Object} bibRecord  An IDB bibliography record
 * @returns {Promise<{type: string, book?: string, canonical_source_id?: string, has_nodes?: boolean, metadata?: Object} | null>}
 */
export async function resolveBibliographyTarget(bibRecord) {
  if (!bibRecord) return null;

  // Modern path: canonical-aware resolution.
  if (bibRecord.canonical_source_id) {
    try {
      const resp = await fetch(
        `/api/canonical/${encodeURIComponent(bibRecord.canonical_source_id)}/best-version`,
        {
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin',
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.book) {
          return {
            type: 'library',
            book: data.book,
            has_nodes: true,
            metadata: data.metadata,
          };
        }
        return {
          type: 'citation-card',
          canonical_source_id: bibRecord.canonical_source_id,
          metadata: data.metadata,
        };
      }
      // 404 = canonical itself missing; fall through to source_id rather than dead-end.
      console.warn('resolveBibliographyTarget: canonical lookup returned', resp.status);
    } catch (e) {
      console.warn('resolveBibliographyTarget: canonical lookup failed, falling back to source_id', e);
    }
  }

  // Legacy / orphan-library path.
  if (bibRecord.source_id) {
    return {
      type: 'library',
      book: bibRecord.source_id,
      has_nodes: bibRecord.source_has_nodes !== false,
    };
  }

  return null;
}
