/**
 * The "Make public" / "Make private" entry of a library card's … menu — the
 * ONE definition, shared by the user-page menu (userProfilePage) and the
 * archive-page menu (homepage.ts). A zero-import leaf so both menus can ask
 * it synchronously; the action itself lives in bookVisibility.ts.
 *
 * The card says everything needed: `libraryCard-private` (the padlock) is the
 * current state, `libraryCard-encrypted` rules the action out (the server
 * pins an encrypted book private), and on a SHELF — which mixes the owner's
 * books with other people's — `libraryCard-own` marks the ones the shelf's
 * owner may change (LibraryCardGenerator::markAsOwn).
 */

export type BookVisibilityAction = 'make-public' | 'make-private';

export interface BookVisibilityMenuItem {
    id: BookVisibilityAction;
    label: string;
    icon: string;
}

const GLOBE_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20a15.3 15.3 0 0 1 0-20z"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/**
 * @param trigger     the clicked .book-actions anchor
 * @param mixedOwners true where the list can hold other people's books (a
 *                    shelf / archive feed) — the card must then be marked own
 */
export function bookVisibilityMenuItem(trigger: Element, mixedOwners: boolean): BookVisibilityMenuItem | null {
    const card = trigger.closest('.libraryCard');
    if (!card || card.classList.contains('libraryCard-encrypted')) return null;
    if (mixedOwners && !card.classList.contains('libraryCard-own')) return null;

    return card.classList.contains('libraryCard-private')
        ? { id: 'make-public', label: 'Make public', icon: GLOBE_ICON }
        : { id: 'make-private', label: 'Make private', icon: LOCK_ICON };
}
