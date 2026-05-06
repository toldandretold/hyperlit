/**
 * Sort dropdown and client-side search for shelf/library views.
 */

// Dynamic imports to avoid blocking module loading
async function getOpenShelf() {
    const mod = await import('./shelfTabs.js');
    return mod.openShelf;
}

let currentSortBar = null;

/**
 * Show the sort/search bar above .main-content.
 * @param {Object} options - { shelfId, shelfName, currentSort, isSystemShelf }
 */
export function showSortBar(options = {}) {
    removeSortBar();

    const { shelfId, shelfName, currentSort = 'recent', isSystemShelf = false } = options;

    const bar = document.createElement('div');
    bar.id = 'shelf-sort-bar';
    bar.className = 'shelf-sort-bar';

    // Sort dropdown
    const sortContainer = document.createElement('div');
    sortContainer.className = 'shelf-sort-container';

    const sortLabel = document.createElement('span');
    sortLabel.className = 'shelf-sort-label';
    sortLabel.textContent = 'Sort:';
    sortContainer.appendChild(sortLabel);

    const sortSelect = document.createElement('select');
    sortSelect.className = 'shelf-sort-select';

    const sortOptions = [
        { value: 'recent', label: 'Recent' },
        { value: 'views', label: 'Most viewed' },
    ];

    // Only show "Date added" and "Manual" for user shelves (not system)
    if (!isSystemShelf) {
        sortOptions.push({ value: 'added', label: 'Date added' });
        sortOptions.push({ value: 'manual', label: 'Manual' });
    }

    for (const opt of sortOptions) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === currentSort) option.selected = true;
        sortSelect.appendChild(option);
    }

    sortSelect.addEventListener('change', () => {
        handleSortChange(sortSelect.value, shelfId, shelfName, isSystemShelf);
    });
    sortContainer.appendChild(sortSelect);
    bar.appendChild(sortContainer);

    // Search input
    const searchContainer = document.createElement('div');
    searchContainer.className = 'shelf-search-container';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search...';
    searchInput.className = 'shelf-search-input';
    searchInput.addEventListener('input', () => {
        handleSearch(searchInput.value);
    });
    searchContainer.appendChild(searchInput);
    bar.appendChild(searchContainer);

    // Insert above .main-content
    const wrapper = document.querySelector('.user-content-wrapper') || document.querySelector('.home-content-wrapper');
    const mainContent = document.querySelector('.main-content');
    if (wrapper && mainContent) {
        wrapper.insertBefore(bar, mainContent);
    }

    currentSortBar = bar;
}

/**
 * Remove the sort/search bar.
 */
export function removeSortBar() {
    if (currentSortBar) {
        currentSortBar.remove();
        currentSortBar = null;
    }
    // Also remove any leftover
    const existing = document.getElementById('shelf-sort-bar');
    if (existing) existing.remove();
}

/**
 * Handle sort change.
 * For small shelves (<=100 cards), reorder DOM. For large, re-render from server.
 */
async function handleSortChange(newSort, shelfId, shelfName, isSystemShelf) {
    const cards = document.querySelectorAll('.libraryCard');

    if (!isSystemShelf && shelfId && cards.length > 100) {
        // Large shelf — re-render from server
        const openShelf = await getOpenShelf();
        await openShelf(shelfId, shelfName, newSort);
    } else if (!isSystemShelf && shelfId) {
        // Small shelf — re-render from server (simpler than client sort for now)
        const openShelf = await getOpenShelf();
        await openShelf(shelfId, shelfName, newSort);
    } else {
        // System shelf (public/private) — client-side sort
        sortCardsInDOM(newSort, cards);
    }
}

/**
 * Sort library cards in the DOM without server call.
 */
function sortCardsInDOM(sortType, cards) {
    const parent = cards[0]?.parentElement;
    if (!parent) return;

    const cardArray = Array.from(cards);

    cardArray.sort((a, b) => {
        switch (sortType) {
            case 'views':
                // Use data attribute if available, otherwise fall back to DOM order
                return (parseInt(b.dataset.views) || 0) - (parseInt(a.dataset.views) || 0);
            case 'recent':
            default:
                // Keep original server order (by startLine)
                return parseInt(a.id) - parseInt(b.id);
        }
    });

    // Re-append in new order
    for (const card of cardArray) {
        parent.appendChild(card);
    }
}

/**
 * Client-side filter of library cards by text content.
 */
function handleSearch(query) {
    const cards = document.querySelectorAll('.libraryCard');
    const lower = query.toLowerCase().trim();

    for (const card of cards) {
        if (!lower) {
            card.style.display = '';
        } else {
            const text = card.textContent.toLowerCase();
            card.style.display = text.includes(lower) ? '' : 'none';
        }
    }
}
