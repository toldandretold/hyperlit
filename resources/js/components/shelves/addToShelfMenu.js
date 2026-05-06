/**
 * "Add to shelf" submenu.
 * Shows user's shelves with checkboxes for toggling membership.
 */

import { isLoggedIn } from '../../utilities/auth.js';

async function getFloatingMenu() {
    return await import('../floatingActionMenu.js');
}

async function doInvalidateShelfCache() {
    const mod = await import('./shelfTabs.js');
    mod.invalidateShelfCache();
}

/**
 * Show the "Add to shelf" submenu for a given book.
 * @param {HTMLElement} anchorEl - Position anchor
 * @param {string} bookId - The book to add/remove
 */
export async function showAddToShelfMenu(anchorEl, bookId) {
    const { hideFloatingMenu } = await getFloatingMenu();
    hideFloatingMenu();

    // Auth gate — prompt login/register for unauthenticated users
    const loggedIn = await isLoggedIn();
    if (!loggedIn) {
        const menu = document.createElement('div');
        menu.className = 'floating-action-menu add-to-shelf-menu';
        menu.style.position = 'absolute';
        menu.style.zIndex = '10001';

        const msg = document.createElement('div');
        msg.className = 'floating-action-menu-item';
        msg.style.flexDirection = 'column';
        msg.style.gap = '8px';
        msg.innerHTML = '<span>Log in to add books to shelves</span>';

        const loginBtn = document.createElement('button');
        loginBtn.className = 'floating-action-menu-item';
        loginBtn.textContent = 'Log in';
        loginBtn.addEventListener('click', async () => {
            menu.remove();
            const { initializeUserContainer } = await import('../userContainer.js');
            const mgr = initializeUserContainer();
            if (mgr) mgr.showLoginForm();
        });

        const registerBtn = document.createElement('button');
        registerBtn.className = 'floating-action-menu-item';
        registerBtn.textContent = 'Register';
        registerBtn.addEventListener('click', async () => {
            menu.remove();
            const { initializeUserContainer } = await import('../userContainer.js');
            const mgr = initializeUserContainer();
            if (mgr) mgr.showRegisterForm();
        });

        menu.appendChild(msg);
        menu.appendChild(loginBtn);
        menu.appendChild(registerBtn);
        document.body.appendChild(menu);
        positionMenu(menu, anchorEl);

        // Dismiss on outside click
        const dismiss = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', dismiss);
            }
        };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
        return;
    }

    const shelves = await fetchShelvesWithMembership(bookId);

    const menu = document.createElement('div');
    menu.className = 'floating-action-menu add-to-shelf-menu';
    menu.style.position = 'absolute';
    menu.style.zIndex = '10001';

    // "New shelf..." at top
    const newItem = document.createElement('button');
    newItem.type = 'button';
    newItem.className = 'floating-action-menu-item add-shelf-new';
    newItem.textContent = '+ New shelf...';
    newItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.remove();
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

    document.body.appendChild(menu);
    positionMenu(menu, anchorEl);

    // Dismiss on outside click
    const dismiss = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', dismiss);
        }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
}

/**
 * Fetch shelves with membership status for a book.
 */
async function fetchShelvesWithMembership(bookId) {
    try {
        const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
        const resp = await fetch('/api/shelves', {
            headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
        });
        const data = await resp.json();
        const shelves = data.shelves || [];

        // TODO: In a future iteration, fetch membership status from a batch endpoint.
        // For now, return all shelves without membership info (unchecked by default).
        return shelves.map(s => ({ ...s, isMember: false }));
    } catch (err) {
        console.error('Failed to fetch shelves for add-to-shelf:', err);
        return [];
    }
}

/**
 * Toggle a book's membership in a shelf.
 */
async function toggleShelfMembership(shelfId, bookId, shouldAdd) {
    const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
    try {
        if (shouldAdd) {
            await fetch(`/api/shelves/${shelfId}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ book: bookId }),
            });
        } else {
            await fetch(`/api/shelves/${shelfId}/items/${encodeURIComponent(bookId)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
            });
        }
        await doInvalidateShelfCache();
    } catch (err) {
        console.error('Failed to toggle shelf membership:', err);
    }
}

/**
 * Create a new shelf and immediately add the book to it.
 */
async function createShelfAndAdd(anchorEl, bookId) {
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
            await fetch(`/api/shelves/${data.shelf.id}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ book: bookId }),
            });
            await doInvalidateShelfCache();
        }
    } catch (err) {
        console.error('Failed to create shelf:', err);
    }
}

/**
 * Position menu near anchor.
 */
function positionMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const offset = 8;
    let top = rect.bottom + window.scrollY + offset;
    let left = rect.left + window.scrollX;

    const menuWidth = menu.offsetWidth || 180;
    if (left + menuWidth > window.innerWidth) {
        left = window.innerWidth - menuWidth - 8;
    }

    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
}
