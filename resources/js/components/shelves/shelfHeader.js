/**
 * Shelf Header Component
 * Shows title, visibility icon, share button, and sort dropdown
 * for both system shelves (Public/Private) and custom shelves.
 */

import { fixHeaderSpacing, transitionToBookContent } from '../../homepageDisplayUnit.js';
import DOMPurify from 'dompurify';

let currentHeader = null;
let titleDebounceTimer = null;
let searchDebounceTimer = null;
let isFullTextMode = false;
let abortController = null;
let currentIsOwner = true;
let currentShelfId = null;
let currentIsSystemShelf = true;
let currentUsername = null;

const LOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>';
const GLOBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
const DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

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
 * @param {string|null} opts.slug - URL slug for the shelf
 */
export function showShelfHeader(opts) {
    removeShelfHeader();

    const { shelfId, shelfName, currentSort, isSystemShelf, isOwner, username, slug } = opts;
    let visibility = opts.visibility;

    // Track ownership at module level for search/sort routing
    currentIsOwner = isOwner;
    currentShelfId = shelfId;
    currentIsSystemShelf = isSystemShelf;
    currentUsername = username;

    // Determine the API id param for shelf search
    // For owner on system shelf, use 'all' to search both public and private books
    let searchShelfId = isSystemShelf ? (isOwner ? 'all' : visibility) : shelfId;

    const header = document.createElement('div');
    header.id = 'shelf-header';
    header.className = 'shelf-header';

    // --- Title row ---
    const titleRow = document.createElement('div');
    titleRow.className = 'shelf-header-title-row';

    const title = document.createElement('h2');
    title.className = 'shelf-header-title';

    // --- Library filter dropdown for owner on system shelf ---
    if (isSystemShelf && isOwner) {
        const filterLabels = { all: 'All', public: 'Public', private: 'Private' };
        const savedFilter = localStorage.getItem('user_library_filter') || 'all';
        let currentFilter = savedFilter;

        // Update visibility and searchShelfId from saved filter
        visibility = currentFilter;
        searchShelfId = currentFilter;

        title.textContent = filterLabels[currentFilter];
        title.classList.add('clickable');
        title.innerHTML = `${filterLabels[currentFilter]}<span class="filter-indicator">\u25BE</span>`;

        // Wrap title in a positioned container for the dropdown
        const titleWrapper = document.createElement('span');
        titleWrapper.style.position = 'relative';
        titleWrapper.style.display = 'inline-block';

        let dropdownOpen = false;
        let dropdown = null;

        function closeDropdown() {
            if (dropdown) {
                dropdown.remove();
                dropdown = null;
            }
            dropdownOpen = false;
        }

        function openDropdown() {
            if (dropdownOpen) { closeDropdown(); return; }

            dropdown = document.createElement('div');
            dropdown.className = 'library-filter-dropdown';

            ['all', 'public', 'private'].forEach(filterValue => {
                const btn = document.createElement('button');
                btn.textContent = filterLabels[filterValue];
                if (filterValue === currentFilter) btn.classList.add('active');
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    currentFilter = filterValue;

                    // Update title text
                    title.innerHTML = `${filterLabels[filterValue]}<span class="filter-indicator">\u25BE</span>`;

                    // Update visibility and searchShelfId for sort/search
                    visibility = filterValue;
                    searchShelfId = filterValue;

                    // Determine book to load
                    let bookId;
                    if (filterValue === 'all') {
                        bookId = window.allBook;
                    } else if (filterValue === 'public') {
                        bookId = window.userPageBook;
                    } else {
                        bookId = window.userPageBook + 'Private';
                    }

                    // Save preference
                    localStorage.setItem('user_library_filter', filterValue);

                    closeDropdown();

                    // Load the book
                    if (bookId) {
                        await transitionToBookContent(bookId, true);
                    }
                });
                dropdown.appendChild(btn);
            });

            titleWrapper.appendChild(dropdown);
            dropdownOpen = true;

            // Close on outside click
            setTimeout(() => {
                document.addEventListener('click', function handler(e) {
                    if (!titleWrapper.contains(e.target)) {
                        closeDropdown();
                        document.removeEventListener('click', handler);
                    }
                });
            }, 0);
        }

        title.addEventListener('click', (e) => {
            e.stopPropagation();
            openDropdown();
        });

        titleWrapper.appendChild(title);
        titleRow.appendChild(titleWrapper);
    } else {
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
    }

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

    // --- Copy link button (public custom shelves) ---
    if (!isSystemShelf) {
        shareBtn = document.createElement('span');
        shareBtn.className = 'shelf-header-copy-btn';
        shareBtn.title = 'Copy shelf link';
        shareBtn.innerHTML = COPY_SVG;
        shareBtn.style.display = currentVisibility === 'public' ? '' : 'none';
        shareBtn.addEventListener('click', () => {
            const shelfSlug = slug || shelfId;
            const url = `${window.location.origin}/u/${encodeURIComponent(username)}/shelf/${encodeURIComponent(shelfSlug)}`;
            navigator.clipboard.writeText(url).then(() => {
                shareBtn.classList.add('copied');
                setTimeout(() => shareBtn.classList.remove('copied'), 1500);
            });
        });
        titleRow.appendChild(shareBtn);

        // --- Delete button (owner only, custom shelves) ---
        if (isOwner) {
            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'shelf-header-delete-btn';
            deleteBtn.title = 'Delete shelf';
            deleteBtn.innerHTML = DELETE_SVG;
            deleteBtn.addEventListener('click', async () => {
                const confirmed = await showDeleteConfirm(title.textContent.trim());
                if (!confirmed) return;

                try {
                    await fetch(`/api/shelves/${shelfId}`, {
                        method: 'DELETE',
                        headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
                        credentials: 'include',
                    });

                    // Invalidate shelf cache so picker refreshes
                    const { invalidateShelfCache, closeTab } = await import('./shelfTabs.js');
                    invalidateShelfCache();

                    // Close the tab
                    const tab = document.querySelector(`.shelf-tab[data-shelf-id="${shelfId}"]`);
                    if (tab) {
                        closeTab(tab);
                    }
                } catch (err) {
                    console.error('Failed to delete shelf:', err);
                }
            });
            titleRow.appendChild(deleteBtn);
        }
    }

    header.appendChild(titleRow);

    // --- Search bar ---
    const searchContainer = document.createElement('div');
    searchContainer.className = 'shelf-header-search';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'shelf-header-search-input';
    searchInput.placeholder = 'Search titles & authors\u2026';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;

    // --- Full-text toggle ---
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'shelf-fulltext-toggle';

    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.className = 'shelf-fulltext-checkbox';

    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'shelf-fulltext-slider';

    const toggleText = document.createElement('span');
    toggleText.className = 'shelf-fulltext-text';
    toggleText.textContent = 'Full text';

    toggleLabel.appendChild(toggleCheckbox);
    toggleLabel.appendChild(toggleSlider);
    toggleLabel.appendChild(toggleText);

    // Toggle change handler
    toggleCheckbox.addEventListener('change', () => {
        isFullTextMode = toggleCheckbox.checked;
        searchInput.placeholder = isFullTextMode
            ? 'Search full text\u2026'
            : 'Search titles & authors\u2026';

        // Clear current results/state
        clearInlineResults();
        filterLibraryCards('');

        // Re-run with current input
        const query = searchInput.value.trim();
        if (query) {
            if (isFullTextMode) {
                performShelfSearch(query, searchShelfId);
            } else {
                filterLibraryCards(query);
            }
        }
    });

    // Search input handler
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        const query = searchInput.value.trim();

        if (isFullTextMode) {
            if (abortController) abortController.abort();
            if (query.length < 2) {
                clearInlineResults();
                return;
            }
            showInlineStatus('Searching\u2026');
            searchDebounceTimer = setTimeout(() => {
                performShelfSearch(query, searchShelfId);
            }, 300);
        } else {
            searchDebounceTimer = setTimeout(() => {
                filterLibraryCards(query);
            }, 150);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            clearInlineResults();
            filterLibraryCards('');
            searchInput.blur();
        }
    });

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(toggleLabel);
    header.appendChild(searchContainer);

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

        if (isSystemShelf && !isOwner) {
            // Visitor on system shelf: sort via public API
            try {
                const resp = await fetch(`/api/public/library/${encodeURIComponent(username)}/render?sort=${encodeURIComponent(newSort)}`);
                const data = await resp.json();
                if (data.bookId) {
                    await transitionToBookContent(data.bookId, true);
                }
            } catch (err) {
                console.error('Failed to sort system shelf:', err);
            }
        } else if (isSystemShelf) {
            // Owner on system shelf: render sorted via backend
            localStorage.setItem('user_shelf_sort_library', newSort);
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
        } else if (!isOwner) {
            // Visitor on custom shelf: re-render via public API
            try {
                const resp = await fetch(`/api/public/shelves/${encodeURIComponent(shelfId)}/render?sort=${encodeURIComponent(newSort)}`);
                const data = await resp.json();
                if (data.bookId) {
                    await transitionToBookContent(data.bookId, true);
                    // Update the tab's data attributes
                    const tab = document.querySelector(`.visitor-shelf-tab[data-shelf-id="${shelfId}"]`);
                    if (tab) {
                        tab.dataset.sort = newSort;
                        tab.dataset.content = data.bookId;
                    }
                }
            } catch (err) {
                console.error('Failed to sort public shelf:', err);
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
 * Perform full-text search scoped to a shelf via the API.
 */
async function performShelfSearch(query, searchShelfId) {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    // Use public API for visitors on custom shelves or system shelves
    const usePublicSystemApi = !currentIsOwner && currentIsSystemShelf;
    const usePublicApi = !currentIsOwner && !currentIsSystemShelf && currentShelfId;
    const url = usePublicSystemApi
        ? `/api/public/library/${encodeURIComponent(currentUsername)}/search?q=${encodeURIComponent(query)}`
        : usePublicApi
            ? `/api/public/shelves/${encodeURIComponent(currentShelfId)}/search?q=${encodeURIComponent(query)}`
            : `/api/shelves/${encodeURIComponent(searchShelfId)}/search?q=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
            credentials: 'include',
            signal: abortController.signal,
        });

        if (!response.ok) throw new Error(`Search failed: ${response.status}`);

        const data = await response.json();

        if (!data.success || !data.results || data.results.length === 0) {
            showInlineStatus('No results found');
            return;
        }

        renderInlineResults(data.results, query);
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Shelf search error:', err);
        showInlineStatus('Search failed');
    }
}

/**
 * Hide all library cards and show a status message in main-content.
 */
function showInlineStatus(message) {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    // Hide all existing cards
    mainContent.querySelectorAll('[data-node-id]').forEach(card => {
        card.style.display = 'none';
    });

    // Remove existing results container
    const existing = mainContent.querySelector('.shelf-fts-results');
    if (existing) existing.remove();

    // Insert status
    const container = document.createElement('div');
    container.className = 'shelf-fts-results';
    container.innerHTML = `<p class="shelf-fts-status">${escapeHtml(message)}</p>`;
    mainContent.prepend(container);
}

/**
 * Render full-text search results inline in main-content.
 */
function renderInlineResults(results, query) {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    // Hide all existing cards
    mainContent.querySelectorAll('[data-node-id]').forEach(card => {
        card.style.display = 'none';
    });

    // Remove existing results container
    const existing = mainContent.querySelector('.shelf-fts-results');
    if (existing) existing.remove();

    // Build results container
    const container = document.createElement('div');
    container.className = 'shelf-fts-results';

    results.forEach(bookResult => {
        const displayTitle = bookResult.title || 'Unreferenced';
        const displayAuthor = bookResult.author || 'Anon.';

        // Library card for the book (matches LibraryCardGenerator format)
        const card = document.createElement('p');
        card.className = 'libraryCard';
        card.innerHTML = `<strong>${escapeHtml(displayAuthor)}</strong> <em>${escapeHtml(displayTitle)}</em>. <a href="/${encodeURIComponent(bookResult.book)}"><span class="open-icon">\u2197</span></a>`;
        container.appendChild(card);

        // Snippet paragraphs (up to 3)
        bookResult.matches.slice(0, 3).forEach(match => {
            const nodeAnchor = match.startLine ? `#${match.startLine}` : '';
            const snippet = document.createElement('p');
            snippet.className = 'shelf-fts-snippet';
            snippet.innerHTML = `<a href="/${encodeURIComponent(bookResult.book)}${nodeAnchor}" data-highlight-query="${escapeHtml(query)}" data-start-line="${match.startLine || ''}">${DOMPurify.sanitize(match.headline, { ALLOWED_TAGS: ['mark'] })}</a>`;
            container.appendChild(snippet);
        });
    });

    mainContent.prepend(container);

    // Store highlight query in sessionStorage on snippet click
    container.querySelectorAll('[data-highlight-query]').forEach(link => {
        link.addEventListener('click', () => {
            const q = link.dataset.highlightQuery;
            if (q) {
                sessionStorage.setItem('pendingHighlightQuery', q);
                const startLine = link.dataset.startLine;
                if (startLine) {
                    sessionStorage.setItem('pendingHighlightStartLine', startLine);
                }
            }
        });
    });
}

/**
 * Remove inline full-text results and restore all library cards.
 */
function clearInlineResults() {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    const container = mainContent.querySelector('.shelf-fts-results');
    if (container) container.remove();

    // Restore all hidden cards
    mainContent.querySelectorAll('[data-node-id]').forEach(card => {
        card.style.display = '';
    });
}

/**
 * Filter library cards in main-content by matching query against text content.
 */
function filterLibraryCards(query) {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    const cards = mainContent.querySelectorAll('[data-node-id]');
    const lowerQuery = query.toLowerCase();

    cards.forEach(card => {
        if (!lowerQuery) {
            card.style.display = '';
            return;
        }
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(lowerQuery) ? '' : 'none';
    });
}

/**
 * Remove the shelf header from DOM and clean up.
 */
export function removeShelfHeader() {
    if (titleDebounceTimer) {
        clearTimeout(titleDebounceTimer);
        titleDebounceTimer = null;
    }
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    isFullTextMode = false;
    clearInlineResults();
    filterLibraryCards('');
    const existing = document.getElementById('shelf-header');
    if (existing) {
        existing.remove();
    }
    currentHeader = null;
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

/**
 * Show a confirmation dialog before deleting a shelf.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 */
function showDeleteConfirm(shelfName) {
    const message = `Delete <strong>${escapeHtml(shelfName)}</strong>? This will remove the shelf and unlink all books from it. The books themselves will not be deleted.`;

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
                <button class="confirm-action confirm-danger">Delete</button>
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
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
