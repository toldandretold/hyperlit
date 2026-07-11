import { asBookId } from "../types";
/**
 * References (Bibliography) Operations Module
 * Handles reference/bibliography operations in IndexedDB
 */

import { openDatabase } from '../core/connection';
import { syncReferencesToPostgreSQL } from './syncReferencesToPostgreSQL';
import type { BibliographyRecord, BookId } from '../types';

interface ReferencesDeps {
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
}

// Injected dependencies (crash-if-uninitialized, same as the pre-TS module)
let withPending: ReferencesDeps['withPending'];

// Initialization function to inject dependencies
export function initReferencesDependencies(deps: ReferencesDeps): void {
  withPending = deps.withPending;
}

/**
 * Save an array of reference objects to IndexedDB (bulk operation)
 * Then syncs to PostgreSQL (sync failure is swallowed — local save wins)
 */
export async function saveAllReferencesToIndexedDB(references: BibliographyRecord[], bookId: BookId): Promise<void> {
  if (!references || references.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("bibliography", "readwrite");
    const store = tx.objectStore("bibliography");

    references.forEach((reference) => {
      const record = { ...reference, book: bookId };
      store.put(record);
    });

    return new Promise<void>((resolve, reject) => {
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
      tx.onerror = () => {
        console.error("❌ Error saving references to IndexedDB:", tx.error);
        reject(tx.error);
      };
    });
  });
}

// PostgreSQL Sync
export {
  syncReferencesToPostgreSQL,
} from './syncReferencesToPostgreSQL';

/**
 * The `/api/canonical/{id}/best-version` response — the only `canonical_source` data
 * that reaches the client. Mirrors `CanonicalSourceController::bestVersion`: `book` is the
 * best VISIBLE library version (or null = citation-only), plus enough metadata for the card.
 */
export interface CanonicalMetadata {
  title?: string | null;
  author?: string | null;
  year?: number | null;
  journal?: string | null;
  publisher?: string | null;
  doi?: string | null;
  abstract?: string | null;
  oa_url?: string | null;
  pdf_url?: string | null;
  /** Identifiers → the "view on OpenAlex / Open Library" link in the verified state on a fresh open. */
  openalex_id?: string | null;
  open_library_key?: string | null;
  /** Original URL for a web-only canonical (no DOI/OA) — the link OUT when its only version was a
   * suppressed WebFetch stub (best-version returns book: null). */
  source_url?: string | null;
}
export interface CanonicalBestVersion {
  book: BookId | null;
  has_version: boolean;
  metadata: CanonicalMetadata;
}

/** Click-time resolution result for a bibliography record. */
export interface BibliographyTarget {
  type: 'library' | 'citation-card';
  book?: BookId;
  canonical_source_id?: string;
  has_nodes?: boolean;
  metadata?: CanonicalMetadata;
}

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
 */
export async function resolveBibliographyTarget(
  bibRecord: Partial<BibliographyRecord> | null | undefined,
): Promise<BibliographyTarget | null> {
  if (!bibRecord) return null;

  // Modern path: canonical-aware resolution.
  if (bibRecord.canonical_source_id) {
    try {
      const resp = await fetch(
        `/api/canonical/${encodeURIComponent(String(bibRecord.canonical_source_id))}/best-version`,
        {
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin',
        }
      );
      if (resp.ok) {
        const data: CanonicalBestVersion = await resp.json();
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
          canonical_source_id: String(bibRecord.canonical_source_id),
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
      book: asBookId(String(bibRecord.source_id)),
      has_nodes: bibRecord.source_has_nodes !== false,
    };
  }

  return null;
}
