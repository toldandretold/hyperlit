/**
 * The fallback processor is EXTRACTION ONLY.
 *
 * It used to carry four private duplicates of the real persistence paths, and
 * all four were broken:
 *
 *   - saveFootnotesToIndexedDB / saveReferencesToIndexedDB awaited an
 *     IDBRequest and a non-existent `tx.complete`, and wrote 3-field records
 *     where the real path writes the full one.
 *   - syncFootnotesToPostgreSQL / syncReferencesToPostgreSQL skipped the
 *     isPasteInProgress() guard that indexedDB/footnotes/index.ts and
 *     indexedDB/bibliography/index.ts both carry, so they fired before the
 *     book's `library` row existed and were rejected by RLS. Prod case
 *     book_1787965215968 logged "Failed to sync references to PostgreSQL" at
 *     01:00:17; the same rows synced fine at 01:00:23 once the row existed.
 *
 * Persistence belongs to the caller: largePasteHandler saves through
 * saveAllFootnotesToIndexedDB / saveAllReferencesToIndexedDB, and
 * paste/index.ts pushes through syncPasteToPostgreSQL at the right moment.
 *
 * Follows the precedent at
 * tests/javascript/indexedDB/footnotesBibliography.test.js:62-68.
 */

import { describe, it, expect } from 'vitest';

describe('fallback processor stays extraction-only', () => {
  it('does not re-export the broken private persistence functions', async () => {
    const mod = await import('../../../resources/js/paste/fallback-processor');

    expect(mod.saveFootnotesToIndexedDB).toBeUndefined();
    expect(mod.saveReferencesToIndexedDB).toBeUndefined();
    expect(mod.syncFootnotesToPostgreSQL).toBeUndefined();
    expect(mod.syncReferencesToPostgreSQL).toBeUndefined();
  });

  it('does not re-export the deleted html-preprocessor', async () => {
    // utils/html-preprocessor.ts was dead (its only importers were this
    // re-export and an archive/ file whose import path did not resolve) and it
    // carried the same /^\d+$/ marker-text bug that lost bracketed markers.
    // isRealLink survives at utils/dom-utils.ts.
    const mod = await import('../../../resources/js/paste/fallback-processor');

    expect(mod.preprocessHTMLContent).toBeUndefined();
    expect(mod.isRealLink).toBeUndefined();
  });

  it('still exports the extraction entry point', async () => {
    const mod = await import('../../../resources/js/paste/fallback-processor');
    expect(typeof mod.processContentForFootnotesAndReferences).toBe('function');
  });
});
