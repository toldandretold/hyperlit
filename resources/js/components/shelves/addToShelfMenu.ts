/**
 * "Add to shelf" submenu.
 * Shows user's shelves with checkboxes for toggling membership.
 */

import { isLoggedIn } from '../../utilities/auth/index';
import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { drainResponse } from '../../utilities/drainResponse';
import type { Shelf, ShelfListResponse } from './types';

async function getFloatingMenu() {
    return await import('../floatingActionMenu/floatingActionMenu');
}

async function doInvalidateShelfCache() {
    const mod = await import('./shelfTabs');
    mod.invalidateShelfCache();
}

/**
 * Build the menu shell (root + backdrop), apply mobile-vs-desktop styling,
 * and wire up dismiss handlers. Returns the empty menu and a close() function
 * the caller uses to tear everything down (including the backdrop).
 */
function buildMenuShell(anchorEl: any) {
    const isMobile = window.innerWidth < 768;

    // When the trigger lives in the source container's action bar, the menu is
    // a PANEL-LOCAL popover instead of a body-mounted one: it mounts INSIDE
    // #source-container, blurs that panel's content behind it, and is clipped
    // to it — the same treatment as the share and visibility popovers, so the
    // three surfaces in that bar behave as one system. Body-mounting from there
    // anchored a full shelf list (unbounded, viewport-tall) to a 28px button in
    // a 300px panel, so it sprawled across the page next to the card it belongs
    // to. Mobile keeps the bottom-sheet presentation either way.
    const host: HTMLElement | null = anchorEl?.closest?.('#source-container') ?? null;
    const inPanel = !!host && !isMobile;

    const backdrop = document.createElement('div');
    backdrop.className = 'add-to-shelf-backdrop' + (inPanel ? ' add-to-shelf-backdrop--in-panel' : '');

    const menu = document.createElement('div');
    menu.className = 'floating-action-menu add-to-shelf-menu'
        + (isMobile ? ' floating-action-menu--mobile' : '')
        + (inPanel ? ' add-to-shelf-menu--in-panel' : '');
    // In-panel sits in #source-container's own stacking order (above the 1002
    // action bar); body-mounted keeps its viewport-level z-index.
    if (!inPanel) menu.style.zIndex = '10001';
    if (!isMobile && !inPanel) {
        menu.style.position = 'absolute';
    }

    const mount = inPanel ? host! : document.body;
    mount.appendChild(backdrop);
    mount.appendChild(menu);
    if (inPanel) host!.classList.add('shelf-panel-open');
    else if (!isMobile) positionMenu(menu, anchorEl);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        releaseTrap(); // restores focus to the anchor
        if (inPanel) host!.classList.remove('shelf-panel-open');
        backdrop.remove();
        menu.remove();
        document.removeEventListener('click', dismiss);
    };

    backdrop.addEventListener('click', (e) => { e.stopPropagation(); close(); });

    const dismiss = (e: Event) => {
        if (!menu.contains(e.target as Node | null)) close();
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);

    // Keyboard: trap Tab within the menu, Escape closes (had no Escape at
    // all before), focus restored on close. The menu is still empty here —
    // the trap's rAF re-seat lands on the first item the caller appends.
    const releaseTrap = trapModalFocus(menu, { onEscape: () => close() });

    return { menu, close };
}

/**
 * Anchored login/register prompt — the auth gate shown when a logged-out user
 * clicks a members-only action (add to shelf, like). Reuses the add-to-shelf
 * menu shell so the overlay classes (already in the overlay inventory) and
 * focus-trap wiring stay singular.
 */
export function showLoginPromptMenu(anchorEl: any, message: string) {
    const { menu, close } = buildMenuShell(anchorEl);

    const msg = document.createElement('div');
    msg.className = 'floating-action-menu-item';
    msg.style.flexDirection = 'column';
    msg.style.gap = '8px';
    const span = document.createElement('span');
    span.textContent = message;
    msg.appendChild(span);

    const loginBtn = document.createElement('button');
    loginBtn.className = 'floating-action-menu-item';
    loginBtn.textContent = 'Log in';
    loginBtn.addEventListener('click', async () => {
        close();
        const { initializeUserContainer } = await import('../userButton/userButton');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showLoginForm();
    });

    const registerBtn = document.createElement('button');
    registerBtn.className = 'floating-action-menu-item';
    registerBtn.textContent = 'Register';
    registerBtn.addEventListener('click', async () => {
        close();
        const { initializeUserContainer } = await import('../userButton/userButton');
        const mgr = initializeUserContainer();
        if (mgr) mgr.showRegisterForm();
    });

    menu.appendChild(msg);
    menu.appendChild(loginBtn);
    menu.appendChild(registerBtn);
}

/**
 * Show the "Add to shelf" submenu for a given book.
 * @param {HTMLElement} anchorEl - Position anchor
 * @param {string} bookId - The book to add/remove
 */
export async function showAddToShelfMenu(anchorEl: any, bookId: any) {
    const { hideFloatingMenu } = await getFloatingMenu();
    hideFloatingMenu();

    // Auth gate — prompt login/register for unauthenticated users
    const loggedIn = await isLoggedIn();
    if (!loggedIn) {
        showLoginPromptMenu(anchorEl, 'Log in to add books to shelves');
        return;
    }

    const shelves: Array<Shelf & { isMember: boolean }> = await fetchShelvesWithMembership(bookId);

    const { menu, close } = buildMenuShell(anchorEl);

    // "New shelf..." at top
    const newItem = document.createElement('button');
    newItem.type = 'button';
    newItem.className = 'floating-action-menu-item add-shelf-new';
    newItem.textContent = '+ New shelf...';
    newItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        close();
        await createShelfAndAdd(anchorEl, bookId);
    });
    menu.appendChild(newItem);

    // Existing shelves with checkboxes
    for (const shelf of shelves) {
        const item = document.createElement('label');
        item.className = 'floating-action-menu-item add-shelf-checkbox-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = shelf.isMember;
        checkbox.addEventListener('change', async () => {
            await toggleShelfMembership(shelf.id, bookId, checkbox.checked);
        });

        const label = document.createElement('span');
        label.textContent = shelf.name;

        item.appendChild(checkbox);
        item.appendChild(label);
        menu.appendChild(item);
    }
}

/**
 * Fetch shelves with membership status for a book.
 */
async function fetchShelvesWithMembership(bookId: any) {
    try {
        const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
        const resp = await fetch(`/api/shelves?book=${encodeURIComponent(bookId)}`, {
            headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
        });
        const data: ShelfListResponse = await resp.json();
        const shelves: Shelf[] = data.shelves || [];
        // The Likes shelf is deliberately absent: you join it by liking the
        // book (the heart in the same action bar), not by ticking a box, and
        // the server refuses a manual add anyway. Showing an unticked box that
        // 422s would read as broken.
        return shelves
            .filter(s => s.kind !== 'likes')
            .map(s => ({ ...s, isMember: !!s.is_member }));
    } catch (err) {
        console.error('Failed to fetch shelves for add-to-shelf:', err);
        return [];
    }
}

/**
 * Toggle a book's membership in a shelf.
 */
async function toggleShelfMembership(shelfId: any, bookId: any, shouldAdd: any) {
    const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
    try {
        if (shouldAdd) {
            await drainResponse(await fetch(`/api/shelves/${shelfId}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ book: bookId }),
            }));
        } else {
            await drainResponse(await fetch(`/api/shelves/${shelfId}/items/${encodeURIComponent(bookId)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
            }));
        }
        await doInvalidateShelfCache();
    } catch (err) {
        console.error('Failed to toggle shelf membership:', err);
    }
}

/**
 * Create a new shelf and immediately add the book to it.
 */
async function createShelfAndAdd(anchorEl: any, bookId: any) {
    const name = prompt('Shelf name:');
    if (!name || !name.trim()) return;

    const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
    try {
        const resp = await fetch('/api/shelves', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
            body: JSON.stringify({ name: name.trim(), visibility: 'private' }),
        });
        const data = await resp.json();
        if (data.success && data.shelf) {
            // Add the book to the new shelf
            await drainResponse(await fetch(`/api/shelves/${data.shelf.id}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ book: bookId }),
            }));
            await doInvalidateShelfCache();
        }
    } catch (err) {
        console.error('Failed to create shelf:', err);
    }
}

/**
 * Position menu near anchor.
 */
function positionMenu(menu: any, anchor: any) {
    const rect = anchor.getBoundingClientRect();
    const offset = 8;
    let top = rect.bottom + window.scrollY + offset;
    let left = rect.left + window.scrollX;

    const menuWidth = menu.offsetWidth || 180;
    if (left + menuWidth > window.innerWidth) {
        left = window.innerWidth - menuWidth - 8;
    }

    // If the menu overflows below the viewport, position it above the anchor instead
    const menuHeight = menu.offsetHeight || 200;
    if (rect.bottom + offset + menuHeight > window.innerHeight) {
        top = rect.top + window.scrollY - menuHeight - offset;
        // If that would go above the viewport, clamp to top
        if (top < window.scrollY) {
            top = window.scrollY + 8;
        }
    }

    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
}
