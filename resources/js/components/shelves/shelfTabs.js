/**
 * Shelf tab system — manages multiple shelf tabs on the user home page.
 * Tabs behave like browser tabs: scrollable, closable, and persisted.
 */

// Dynamic import to avoid blocking module loading
async function getTransitionFn() {
    const mod = await import('../../homepageDisplayUnit.js');
    return mod.transitionToBookContent;
}

const STORAGE_KEY = 'homepage_open_shelves';
const ACTIVE_SHELF_KEY = 'homepage_active_shelf_id';
let shelvesCache = null;
let pickerVisible = false;

/**
 * Initialize the shelf tab system.
 * Call once on page load after homepage buttons are initialized.
 */
export function initializeShelfTabs() {
    const picker = document.getElementById('shelf-picker-trigger');
    if (!picker) return;

    picker.removeEventListener('click', toggleShelfPicker);
    picker.addEventListener('click', toggleShelfPicker);

    // Restore persisted shelf tabs
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const tabs = JSON.parse(saved);
            if (Array.isArray(tabs)) {
                const activeShelfId = localStorage.getItem(ACTIVE_SHELF_KEY);
                for (const tab of tabs) {
                    createTabButton(tab.shelfId, tab.shelfName, tab.sort, false);
                }
                // Activate the last-active shelf if it exists
                if (activeShelfId) {
                    const btn = document.querySelector(`.shelf-tab[data-shelf-id="${activeShelfId}"]`);
                    if (btn) {
                        activateTab(btn);
                        return;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem(STORAGE_KEY);
        }
    }
}

/**
 * Open a shelf — creates or activates a tab and loads its content.
 */
export async function openShelf(shelfId, shelfName, sort = 'recent') {
    // Check if a tab for this shelf already exists
    const existing = document.querySelector(`.shelf-tab[data-shelf-id="${shelfId}"]`);
    if (existing) {
        activateTab(existing);
        return;
    }

    // Create a new tab button
    const btn = createTabButton(shelfId, shelfName, sort, true);
    if (btn) {
        activateTab(btn);
    }
}

/**
 * Create a dynamic shelf tab button and insert it before the shelf-picker-trigger.
 */
function createTabButton(shelfId, shelfName, sort, persist) {
    const picker = document.getElementById('shelf-picker-trigger');
    if (!picker) return null;

    const btn = document.createElement('button');
    btn.className = 'arranger-button shelf-tab';
    btn.dataset.content = '';
    btn.dataset.filter = 'shelf';
    btn.dataset.shelfId = shelfId;
    btn.dataset.sort = sort;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'shelf-tab-name';
    nameSpan.textContent = shelfName;
    btn.title = shelfName;
    btn.appendChild(nameSpan);

    const closeSpan = document.createElement('span');
    closeSpan.className = 'shelf-tab-close';
    closeSpan.textContent = '\u00d7';
    closeSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(btn);
    });
    btn.appendChild(closeSpan);

    btn.addEventListener('click', () => {
        activateTab(btn);
    });

    picker.parentNode.insertBefore(btn, picker);

    if (persist) {
        persistOpenTabs();
    }

    return btn;
}

/**
 * Activate a shelf tab — load its content and mark it active.
 */
async function activateTab(btn) {
    const shelfId = btn.dataset.shelfId;
    const sort = btn.dataset.sort || 'recent';

    // If the tab already has content loaded, just switch to it
    if (btn.dataset.content) {
        document.querySelectorAll('.arranger-button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        localStorage.setItem(ACTIVE_SHELF_KEY, shelfId);
        localStorage.setItem('homepage_active_button', btn.dataset.content);

        const transitionToBookContent = await getTransitionFn();
        await transitionToBookContent(btn.dataset.content, true);

        // Show shelf header for custom shelf
        const { showShelfHeader } = await import('./shelfHeader.js');
        const shelf = window.userShelves?.find(s => s.id == shelfId);
        showShelfHeader({
            shelfId,
            shelfName: btn.querySelector('.shelf-tab-name')?.textContent || '',
            visibility: shelf?.visibility || 'private',
            currentSort: sort,
            isSystemShelf: false,
            isOwner: true,
            username: window.username,
            slug: shelf?.slug || null,
        });
        return;
    }

    // Render the synthetic book for this shelf
    const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
    try {
        const resp = await fetch(`/api/shelves/${shelfId}/render?sort=${sort}`, {
            headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
        });
        const data = await resp.json();
        if (!data.bookId) return;

        btn.dataset.content = data.bookId;

        document.querySelectorAll('.arranger-button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        localStorage.setItem(ACTIVE_SHELF_KEY, shelfId);
        localStorage.setItem('homepage_active_button', data.bookId);

        const transitionToBookContent = await getTransitionFn();
        await transitionToBookContent(data.bookId, true);

        // Show shelf header for custom shelf
        const { showShelfHeader } = await import('./shelfHeader.js');
        const shelf = window.userShelves?.find(s => s.id == shelfId);
        showShelfHeader({
            shelfId,
            shelfName: btn.querySelector('.shelf-tab-name')?.textContent || '',
            visibility: shelf?.visibility || 'private',
            currentSort: sort,
            isSystemShelf: false,
            isOwner: true,
            username: window.username,
            slug: shelf?.slug || null,
        });
    } catch (err) {
        console.error('Failed to open shelf:', err);
    }
}

/**
 * Close a shelf tab. If it was active, activate the previous tab or Public.
 */
export function closeTab(btn) {
    const wasActive = btn.classList.contains('active');
    const allTabs = Array.from(document.querySelectorAll('.shelf-tab'));
    const idx = allTabs.indexOf(btn);

    btn.remove();
    persistOpenTabs();

    if (wasActive) {
        // Try to activate the previous shelf tab, else the one after, else Public
        const remaining = Array.from(document.querySelectorAll('.shelf-tab'));
        if (remaining.length > 0) {
            const nextTab = remaining[Math.min(idx, remaining.length) - 1] || remaining[0];
            activateTab(nextTab);
        } else {
            // No shelf tabs left — activate Public
            localStorage.removeItem(ACTIVE_SHELF_KEY);
            const publicBtn = document.querySelector('.arranger-button[data-filter="public"]');
            if (publicBtn) {
                publicBtn.click();
            }
        }
    }
}

/**
 * Persist the list of open shelf tabs to localStorage.
 */
function persistOpenTabs() {
    const tabs = Array.from(document.querySelectorAll('.shelf-tab')).map(btn => ({
        shelfId: btn.dataset.shelfId,
        shelfName: btn.querySelector('.shelf-tab-name')?.textContent || '',
        sort: btn.dataset.sort || 'recent',
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
}

/**
 * Toggle the shelf picker dropdown.
 */
async function toggleShelfPicker(e) {
    e.stopPropagation();
    const trigger = e.currentTarget; // capture before await
    const existing = document.getElementById('shelf-picker-dropdown');
    if (existing) {
        existing.remove();
        pickerVisible = false;
        return;
    }

    pickerVisible = true;
    const shelves = await fetchShelves();
    renderShelfPicker(shelves, trigger);
}

/**
 * Fetch user's shelves from API (with simple cache).
 */
async function fetchShelves(forceRefresh = false) {
    if (shelvesCache && !forceRefresh) return shelvesCache;

    try {
        const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
        const resp = await fetch('/api/shelves', {
            headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
            credentials: 'include',
        });
        const data = await resp.json();
        shelvesCache = data.shelves || [];
        return shelvesCache;
    } catch (err) {
        console.error('Failed to fetch shelves:', err);
        return [];
    }
}

/**
 * Render the shelf picker dropdown below the trigger button.
 */
function renderShelfPicker(shelves, trigger) {
    const dropdown = document.createElement('div');
    dropdown.id = 'shelf-picker-dropdown';
    dropdown.className = 'shelf-picker-dropdown';

    // "New shelf..." option
    const newOption = document.createElement('div');
    newOption.className = 'shelf-picker-item shelf-picker-new';
    newOption.textContent = '+ New shelf...';
    newOption.addEventListener('click', (e) => {
        e.stopPropagation();
        showNewShelfForm(dropdown);
    });
    dropdown.appendChild(newOption);

    // Existing shelves
    for (const shelf of shelves) {
        const item = document.createElement('div');
        item.className = 'shelf-picker-item';
        item.textContent = shelf.name;
        item.dataset.shelfId = shelf.id;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.remove();
            pickerVisible = false;
            openShelf(shelf.id, shelf.name, shelf.default_sort || 'recent');
        });
        dropdown.appendChild(item);
    }

    // Position below trigger, clamped to viewport
    const rect = trigger.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    document.body.appendChild(dropdown);
    const dropdownWidth = dropdown.offsetWidth;
    const maxLeft = window.innerWidth - dropdownWidth - 8;
    dropdown.style.left = Math.min(rect.left, maxLeft) + 'px';

    // Dismiss on outside click
    const dismiss = (e) => {
        if (!dropdown.contains(e.target) && e.target !== trigger) {
            dropdown.remove();
            pickerVisible = false;
            document.removeEventListener('click', dismiss);
        }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
}

/**
 * Show inline form for creating a new shelf.
 */
function showNewShelfForm(dropdown) {
    // Clear dropdown contents and show form
    dropdown.innerHTML = '';
    dropdown.classList.add('shelf-picker-form');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Shelf name';
    nameInput.className = 'shelf-name-input';
    nameInput.maxLength = 255;
    dropdown.appendChild(nameInput);

    const visRow = document.createElement('div');
    visRow.className = 'shelf-visibility-row';
    visRow.innerHTML = `
        <label><input type="radio" name="shelf-vis" value="private" checked> Private</label>
        <label><input type="radio" name="shelf-vis" value="public"> Public</label>
    `;
    dropdown.appendChild(visRow);

    const createBtn = document.createElement('button');
    createBtn.className = 'shelf-create-btn';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const visibility = dropdown.querySelector('input[name="shelf-vis"]:checked')?.value || 'private';

        try {
            const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
            const resp = await fetch('/api/shelves', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ name, visibility }),
            });
            const data = await resp.json();
            if (data.success && data.shelf) {
                shelvesCache = null; // Invalidate cache
                dropdown.remove();
                pickerVisible = false;
                openShelf(data.shelf.id, data.shelf.name, 'recent');
            } else if (data.error) {
                alert(data.error);
            }
        } catch (err) {
            console.error('Failed to create shelf:', err);
        }
    });
    dropdown.appendChild(createBtn);

    nameInput.focus();
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createBtn.click();
    });
}

/**
 * Invalidate the shelf cache (call after mutations).
 */
export function invalidateShelfCache() {
    shelvesCache = null;
}

/**
 * Clear all shelf tabs.
 */
export function clearActiveShelf() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_SHELF_KEY);
    document.querySelectorAll('.shelf-tab').forEach(btn => btn.remove());
}
