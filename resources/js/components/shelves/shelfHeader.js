/**
 * Shelf Header Component
 * Shows title, visibility icon, share button, and sort dropdown
 * for both system shelves (Public/Private) and custom shelves.
 */

import { fixHeaderSpacing, transitionToBookContent } from '../../homepageDisplayUnit.js';

let currentHeader = null;
let titleDebounceTimer = null;

const LOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>';
const GLOBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

function getXsrf() {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

/**
 * Show the shelf header. Removes any existing header first.
 * @param {Object} opts
 * @param {number|null} opts.shelfId - null for system shelves
 * @param {string} opts.shelfName
 * @param {string} opts.visibility - 'public' or 'private'
 * @param {string} opts.currentSort - 'recent', 'connected', 'lit', 'added'
 * @param {boolean} opts.isSystemShelf
 * @param {boolean} opts.isOwner
 * @param {string} opts.username
 */
export function showShelfHeader(opts) {
    removeShelfHeader();

    const { shelfId, shelfName, visibility, currentSort, isSystemShelf, isOwner, username } = opts;

    const header = document.createElement('div');
    header.id = 'shelf-header';
    header.className = 'shelf-header';

    // --- Title row ---
    const titleRow = document.createElement('div');
    titleRow.className = 'shelf-header-title-row';

    const title = document.createElement('h2');
    title.className = 'shelf-header-title';
    title.textContent = shelfName;

    const canEdit = !isSystemShelf && isOwner;
    title.contentEditable = canEdit ? 'true' : 'false';

    if (canEdit) {
        title.addEventListener('input', () => {
            clearTimeout(titleDebounceTimer);
            // Enforce max length
            if (title.textContent.length > 100) {
                title.textContent = title.textContent.slice(0, 100);
            }
            titleDebounceTimer = setTimeout(() => {
                const newName = title.textContent.trim();
                if (!newName || !shelfId) return;
                // Update the tab label
                const tabName = document.querySelector(`.shelf-tab[data-shelf-id="${shelfId}"] .shelf-tab-name`);
                if (tabName) tabName.textContent = newName;
                // Save to API
                fetch(`/api/shelves/${shelfId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                    credentials: 'include',
                    body: JSON.stringify({ name: newName }),
                });
            }, 1000);
        });
        // Prevent Enter from creating newlines
        title.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                title.blur();
            }
        });
    }
    titleRow.appendChild(title);

    // --- Visibility icon (custom shelves only) ---
    let currentVisibility = visibility;
    let visIcon = null;
    let shareBtn = null;

    if (!isSystemShelf) {
        visIcon = document.createElement('span');
        visIcon.className = 'shelf-header-visibility-icon';
        visIcon.title = currentVisibility === 'public' ? 'Public' : 'Private';
        visIcon.innerHTML = currentVisibility === 'public' ? GLOBE_SVG : LOCK_SVG;

        if (isOwner) {
            visIcon.addEventListener('click', async () => {
                const newVis = currentVisibility === 'public' ? 'private' : 'public';

                const confirmed = await showVisibilityConfirm(title.textContent.trim(), newVis);
                if (!confirmed) return;

                try {
                    await fetch(`/api/shelves/${shelfId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                        credentials: 'include',
                        body: JSON.stringify({ visibility: newVis }),
                    });
                    currentVisibility = newVis;
                    visIcon.innerHTML = newVis === 'public' ? GLOBE_SVG : LOCK_SVG;
                    visIcon.title = newVis === 'public' ? 'Public' : 'Private';
                    // Show/hide share button
                    if (shareBtn) {
                        shareBtn.style.display = newVis === 'public' ? '' : 'none';
                    }
                } catch (err) {
                    console.error('Failed to toggle visibility:', err);
                }
            });
        }
        titleRow.appendChild(visIcon);
    }

    // --- Share button (public custom shelves) ---
    if (!isSystemShelf) {
        shareBtn = document.createElement('button');
        shareBtn.className = 'shelf-header-share-btn';
        shareBtn.textContent = 'Share';
        shareBtn.style.display = currentVisibility === 'public' ? '' : 'none';
        shareBtn.addEventListener('click', () => {
            showShareModal(username, title.textContent.trim(), shelfId);
        });
        titleRow.appendChild(shareBtn);
    }

    header.appendChild(titleRow);

    // --- Controls row (sort dropdown) ---
    const controls = document.createElement('div');
    controls.className = 'shelf-header-controls';

    const sortSelect = document.createElement('select');
    sortSelect.className = 'shelf-sort-select';

    const sortOptions = [
        { value: 'recent', label: 'Recently Added' },
        { value: 'title', label: 'Title (A\u2013Z)' },
        { value: 'author', label: 'Author (A\u2013Z)' },
        { value: 'connected', label: 'Most Connected' },
        { value: 'lit', label: 'Most Lit' },
    ];
    if (!isSystemShelf) {
        sortOptions.push({ value: 'added', label: 'Date Added' });
    }

    for (const opt of sortOptions) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === currentSort) option.selected = true;
        sortSelect.appendChild(option);
    }

    sortSelect.addEventListener('change', async () => {
        const newSort = sortSelect.value;

        if (isSystemShelf) {
            // System shelf: render sorted via backend
            localStorage.setItem('user_shelf_sort_' + visibility, newSort);
            try {
                const resp = await fetch('/api/user-home/render', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                    credentials: 'include',
                    body: JSON.stringify({ visibility, sort: newSort }),
                });
                const data = await resp.json();
                if (data.bookId) {
                    await transitionToBookContent(data.bookId, true);
                }
            } catch (err) {
                console.error('Failed to sort system shelf:', err);
            }
        } else {
            // Custom shelf: update default_sort then re-render
            try {
                await fetch(`/api/shelves/${shelfId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                    credentials: 'include',
                    body: JSON.stringify({ default_sort: newSort }),
                });
                // Re-render the shelf by calling openShelf
                const { openShelf } = await import('./shelfTabs.js');
                // Update the tab's sort data attribute
                const tab = document.querySelector(`.shelf-tab[data-shelf-id="${shelfId}"]`);
                if (tab) {
                    tab.dataset.sort = newSort;
                    tab.dataset.content = ''; // Clear to force re-render
                }
                await openShelf(shelfId, title.textContent.trim(), newSort);
            } catch (err) {
                console.error('Failed to sort custom shelf:', err);
            }
        }
    });

    controls.appendChild(sortSelect);
    header.appendChild(controls);

    // --- Insert into DOM ---
    const fixedHeader = document.querySelector('.fixed-header');
    const mainContent = document.querySelector('.main-content');
    if (fixedHeader && mainContent) {
        fixedHeader.parentNode.insertBefore(header, mainContent);
    } else if (fixedHeader) {
        fixedHeader.insertAdjacentElement('afterend', header);
    }

    currentHeader = header;
    fixHeaderSpacing();
}

/**
 * Remove the shelf header from DOM and clean up.
 */
export function removeShelfHeader() {
    if (titleDebounceTimer) {
        clearTimeout(titleDebounceTimer);
        titleDebounceTimer = null;
    }
    const existing = document.getElementById('shelf-header');
    if (existing) {
        existing.remove();
    }
    currentHeader = null;
}

/**
 * Show a share modal with citation info for a public shelf.
 */
function showShareModal(username, shelfName, shelfId) {
    // Remove any existing modal
    const existingOverlay = document.querySelector('.shelf-share-overlay');
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'shelf-share-overlay';

    const year = new Date().getFullYear();
    const url = `${window.location.origin}/u/${encodeURIComponent(username)}/shelf/${shelfId}`;
    const citationText = `${username}, \u201c${shelfName},\u201d ${year}. ${url}`;

    const modal = document.createElement('div');
    modal.className = 'shelf-share-modal';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px">Share Shelf</h3>
        <div class="shelf-share-citation">${escapeHtml(citationText)}</div>
        <div class="shelf-share-actions">
            <button class="shelf-share-copy">Copy</button>
            <button class="shelf-share-close">Close</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('.shelf-share-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(citationText).then(() => {
            const btn = modal.querySelector('.shelf-share-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });
    });

    modal.querySelector('.shelf-share-close').addEventListener('click', () => {
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

/**
 * Show a confirmation dialog before changing shelf visibility.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 */
function showVisibilityConfirm(shelfName, newVis) {
    const isGoingPublic = newVis === 'public';
    const message = isGoingPublic
        ? `Make <strong>${escapeHtml(shelfName)}</strong> public? Anyone with the link will be able to see this shelf.`
        : `Make <strong>${escapeHtml(shelfName)}</strong> private? Only you will be able to see it.`;
    const confirmLabel = isGoingPublic ? 'Make Public' : 'Make Private';

    return new Promise((resolve) => {
        const existing = document.querySelector('.shelf-visibility-confirm');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'shelf-visibility-confirm';

        const modal = document.createElement('div');
        modal.className = 'shelf-visibility-confirm-modal';
        modal.innerHTML = `
            <p>${message}</p>
            <div class="shelf-visibility-confirm-actions">
                <button class="confirm-cancel">Cancel</button>
                <button class="confirm-action">${confirmLabel}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('.confirm-cancel').addEventListener('click', () => {
            overlay.remove();
            resolve(false);
        });

        modal.querySelector('.confirm-action').addEventListener('click', () => {
            overlay.remove();
            resolve(true);
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                resolve(false);
            }
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
