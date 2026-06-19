/**
 * Pure book-ID resolution logic for batch operations.
 *
 * Lives in its own module (no IndexedDB / editor imports) so it can be unit-tested
 * without dragging in the rest of the app.
 *
 * Priority: explicit option → sub-book container in DOM → main book element → global → "latest".
 * Walking via closest('[data-book-id]') is what lets a save inside a sub-book be attributed
 * to the sub-book rather than the parent.
 *
 * Unit tests: tests/javascript/indexedDB/batch.test.js
 */
import { asBookId, LATEST, type BookId } from '../types';

export interface ResolveBookIdArgs {
  optionsBookId?: BookId | null;
  firstRecordEl?: Element | null;
  mainContent?: Element | null;
  globalBook?: BookId | null;
}

export function resolveBookIdForBatch({ optionsBookId, firstRecordEl, mainContent, globalBook }: ResolveBookIdArgs): BookId {
  const subBookFromDom = firstRecordEl?.closest?.('[data-book-id]') as HTMLElement | null | undefined;
  const subBookId = subBookFromDom?.dataset?.bookId;
  return optionsBookId
    || (subBookId ? asBookId(subBookId) : null)
    || (mainContent?.id ? asBookId(mainContent.id) : null)
    || globalBook
    || LATEST;
}
