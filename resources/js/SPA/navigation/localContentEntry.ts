/**
 * "Did we arrive on a page whose content is ALREADY painted?" — the
 * presentation question the loading-overlay code actually wants to ask.
 *
 * New-book creation and book import both land on a reader whose content the
 * client already has, and whose blade has already hidden the initial overlay.
 * Showing (or restoring) a loading overlay there flashes a spinner over content
 * that is right there, and — worse — can leave the overlay up.
 *
 * Those call sites used to ask this by reading the SYNC markers directly
 * (`pending_new_book_sync` / `pending_import_book`), which quietly coupled
 * "should I paint a spinner" to "has this book reached the server". Two
 * unrelated lifetimes: the sync marker is cleared when the create SETTLES,
 * which is nothing to do with whether the overlay should show. The import side
 * already keeps its presentation flag (`pending_import_book`) separate from its
 * permission flag (`imported_book_flag`) for exactly this reason.
 *
 * Deliberately a DERIVED question, not a fourth stored flag: another piece of
 * persisted state is another thing that can leak, and a leaked overlay flag is
 * precisely the bug viewManager's clear site documents (it "silently killed the
 * boot overlay AND the resume curtain for every later full load in the same
 * tab"). So this reads the two markers that already exist and gives the three
 * presentation call sites their own vocabulary.
 */

import { getPendingNewBook } from '../../utilities/pendingNewBook';

/** The import side's OVERLAY flag (its permissions live in `imported_book_flag`). */
const PENDING_IMPORT_KEY = 'pending_import_book';

/** True when this entry is a just-created book (content already in IndexedDB). */
export function isNewBookEntry(): boolean {
  return getPendingNewBook() !== null;
}

/** True when this entry is a just-imported book (content already painted by the import). */
export function isImportedBookEntry(): boolean {
  try {
    return !!sessionStorage.getItem(PENDING_IMPORT_KEY);
  } catch {
    return false;
  }
}

/**
 * True when the content for this entry is already local, so a loading overlay
 * must NOT be shown or restored.
 */
export function isLocalContentEntry(): boolean {
  return isNewBookEntry() || isImportedBookEntry();
}
