/**
 * Reusable floating action menu.
 * Desktop: absolute-positioned near anchor with above/below flip.
 * Mobile (<768px): fixed bottom sheet.
 */

let activeMenu = null;
let activeBackdrop = null;
let dismissHandler = null;

/**
 * Show a floating menu near an anchor element.
 * @param {HTMLElement} anchorEl - The element to position near
 * @param {Array} items - [{id, label, icon?}]
 * @param {Function} onSelect - Called with item.id when selected
 */
export function showFloatingMenu(anchorEl, items, onSelect) {
    hideFloatingMenu();

    const isMobile = window.innerWidth < 768;

    const backdrop = document.createElement('div');
    backdrop.className = 'floating-action-menu-backdrop';
    backdrop.addEventListener('click', (e) => {
        e.stopPropagation();
        hideFloatingMenu();
    });

    const menu = document.createElement('div');
    menu.className = 'floating-action-menu' + (isMobile ? ' floating-action-menu--mobile' : '');

    for (const item of items) {
        const menuItem = document.createElement('button');
        menuItem.type = 'button';
        menuItem.className = 'floating-action-menu-item';
        menuItem.dataset.action = item.id;

        if (item.icon) {
            const iconSpan = document.createElement('span');
            iconSpan.className = 'floating-action-menu-icon';
            iconSpan.innerHTML = item.icon;
            menuItem.appendChild(iconSpan);
        }

        const labelSpan = document.createElement('span');
        labelSpan.className = 'floating-action-menu-label';
        labelSpan.textContent = item.label;
        menuItem.appendChild(labelSpan);

        menuItem.addEventListener('click', (e) => {
            e.stopPropagation();
            hideFloatingMenu();
            onSelect(item.id);
        });

        menu.appendChild(menuItem);
    }

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    if (!isMobile) {
        positionNearAnchor(menu, anchorEl);
    }

    activeMenu = menu;
    activeBackdrop = backdrop;

    // ESC + scroll still close (the backdrop handles outside clicks).
    dismissHandler = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        hideFloatingMenu();
    };

    setTimeout(() => {
        document.addEventListener('keydown', dismissHandler);
        document.addEventListener('scroll', dismissHandler, { once: true, passive: true });
    }, 0);
}

/**
 * Hide the active floating menu.
 */
export function hideFloatingMenu() {
    if (activeMenu) {
        activeMenu.remove();
        activeMenu = null;
    }
    if (activeBackdrop) {
        activeBackdrop.remove();
        activeBackdrop = null;
    }
    if (dismissHandler) {
        document.removeEventListener('keydown', dismissHandler);
        document.removeEventListener('scroll', dismissHandler);
        dismissHandler = null;
    }
}

/**
 * Position the menu to the left of the anchor element, vertically centered,
 * with a speech-bubble arrow pointing at the anchor.
 */
function positionNearAnchor(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 160;
    const menuHeight = menu.offsetHeight || 120;
    const gap = 10; // space between menu and anchor

    // Vertically center on the anchor
    let top = rect.top + window.scrollY + (rect.height / 2) - (menuHeight / 2);

    // Position to the left of the anchor
    let left = rect.left + window.scrollX - menuWidth - gap;

    // If not enough room on the left, flip to below
    if (left < 8) {
        left = rect.left + window.scrollX;
        top = rect.bottom + window.scrollY + gap;
        menu.classList.add('floating-action-menu--below');
    } else {
        menu.classList.add('floating-action-menu--left');
    }

    // Prevent going off top of screen
    if (top < window.scrollY + 8) {
        top = window.scrollY + 8;
    }

    // Prevent going off bottom of screen
    if (top + menuHeight > window.scrollY + window.innerHeight - 8) {
        top = window.scrollY + window.innerHeight - menuHeight - 8;
    }

    menu.style.position = 'absolute';
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.style.zIndex = '10000';
}
