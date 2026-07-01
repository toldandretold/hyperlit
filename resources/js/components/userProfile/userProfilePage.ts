// resources/js/components/userProfile/userProfilePage.ts

import { log } from '../../utilities/logger'

let userProfilePageInitialized = false;

// Stored handler references for cleanup
let tierSelectorToggleHandler: any = null;
let tierOptionSelectionHandler: any = null;
let tierDropdownOutsideClickHandler: any = null;
let stripeTopUpHandler: any = null;
let userBookActionsHandler: any = null;

export function destroyUserProfilePage() {
    if (tierSelectorToggleHandler) {
        document.removeEventListener('click', tierSelectorToggleHandler);
        tierSelectorToggleHandler = null;
    }
    if (tierOptionSelectionHandler) {
        document.removeEventListener('click', tierOptionSelectionHandler);
        tierOptionSelectionHandler = null;
    }
    if (tierDropdownOutsideClickHandler) {
        document.removeEventListener('click', tierDropdownOutsideClickHandler);
        tierDropdownOutsideClickHandler = null;
    }
    if (stripeTopUpHandler) {
        document.removeEventListener('click', stripeTopUpHandler);
        stripeTopUpHandler = null;
    }
    if (userBookActionsHandler) {
        document.removeEventListener('click', userBookActionsHandler);
        userBookActionsHandler = null;
    }
    userProfilePageInitialized = false;
}

export function initializeUserProfilePage() {
    if (userProfilePageInitialized) {
        return;
    }

    console.log("Initializing user profile page click handlers");

    userProfilePageInitialized = true;

    // Tier selector toggle (delegated — survives DOMPurify sanitization)
    tierSelectorToggleHandler = (e: any) => {
        const selector = e.target.closest('.tier-selector');
        if (!selector) return;
        e.preventDefault();
        e.stopPropagation();
        const dropdown = selector.nextElementSibling; // .tier-dropdown
        if (dropdown) dropdown.classList.toggle('hidden');
    };
    document.addEventListener('click', tierSelectorToggleHandler);

    // Tier option selection
    tierOptionSelectionHandler = async (e: any) => {
        const option = e.target.closest('.tier-option');
        if (!option) return;
        e.preventDefault();
        e.stopPropagation();

        const tier = option.dataset.tier;
        if (!tier) return;

        try {
            const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
            const resp = await fetch('/api/billing/tier', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ tier }),
            });
            const data = await resp.json();
            if (data.success) {
                // Update the tier label in DOM
                const totalCredit = option.closest('.totalCredit');
                if (totalCredit) {
                    // Remove all text/nodes between <strong>Tier:</strong> and .tier-selector
                    const selector = totalCredit.querySelector('.tier-selector');
                    if (selector) {
                        let tierStrong = null;
                        for (const s of totalCredit.querySelectorAll('strong')) {
                            if (s.textContent.trim() === 'Tier:') { tierStrong = s; break; }
                        }
                        if (tierStrong) {
                            // Remove everything between the strong and the selector
                            while (tierStrong.nextSibling && tierStrong.nextSibling !== selector) {
                                tierStrong.nextSibling.remove();
                            }
                            // Insert fresh text node
                            tierStrong.after(` ${data.label} (${data.multiplier}×) `);
                        }
                    }
                    // Update selector data attribute
                    if (selector) selector.dataset.currentTier = tier;

                    // Update active class on options
                    totalCredit.querySelectorAll('.tier-option').forEach((opt: any) => opt.classList.remove('active'));
                    option.classList.add('active');
                }

                // Close dropdown
                const dropdown = option.closest('.tier-dropdown');
                if (dropdown) dropdown.classList.add('hidden');
            }
        } catch (err) {
            log.error('Tier update failed:', '/components/userProfile/userProfilePage.ts', err);
        }
    };
    document.addEventListener('click', tierOptionSelectionHandler);

    // Close tier dropdown on outside click
    tierDropdownOutsideClickHandler = (e: any) => {
        if (!e.target.closest('.tier-dropdown') && !e.target.closest('.tier-selector')) {
            document.querySelectorAll('.tier-dropdown').forEach(d => d.classList.add('hidden'));
        }
    };
    document.addEventListener('click', tierDropdownOutsideClickHandler);

    // Stripe top-up button handler (delegated — survives DOMPurify sanitization)
    stripeTopUpHandler = async (e: any) => {
        const topup = e.target.closest('.stripe-topup');
        if (!topup) return;
        e.preventDefault();
        e.stopPropagation();

        const amount = topup.dataset.topupAmount || 5;
        try {
            const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
            const resp = await fetch('/api/billing/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
                credentials: 'include',
                body: JSON.stringify({ amount: Number(amount), return_url: window.location.href }),
            });
            const data = await resp.json();
            if (data.checkout_url) window.location.href = data.checkout_url;
        } catch (err) {
            log.error('Stripe checkout failed:', '/components/userProfile/userProfilePage.ts', err);
        }
    };
    document.addEventListener('click', stripeTopUpHandler);

    // Book actions menu (replaces old .delete-book handler)
    // Only handle on user pages — homepage has its own handler in homepage.ts
    userBookActionsHandler = async (e: any) => {
        if (!(window as any).isUserPage) return;
        const target = e.target.closest('.book-actions');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();

        const bookId = target.getAttribute('data-book');
        if (!bookId) return;

        const menuItems = [
            { id: 'preview', label: 'Preview', icon: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' },
            { id: 'add-to-shelf', label: 'Add to shelf', icon: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>' },
        ];

        // Owner-only: prefetch citation for Share, and add Share + Delete items
        let citationPromise = null;
        if ((window as any).isOwner) {
            citationPromise = (async () => {
                const { prepareCitationShare } = await import('../../utilities/bibtexProcessor');
                return prepareCitationShare(bookId);
            })().catch(err => { console.error('Citation prep failed:', err); return null; });

            const activeTab = document.querySelector('.arranger-button.active');
            const isShelfTab = (activeTab as any)?.dataset.filter === 'shelf';
            const deleteLabel = isShelfTab ? 'Remove from shelf' : 'Delete book';

            menuItems.push(
                { id: 'share', label: 'Share', icon: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' },
                { id: 'delete', label: deleteLabel, icon: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' },
            );
        }

        const { showFloatingMenu } = await import('../floatingActionMenu/floatingActionMenu');
        showFloatingMenu(target, menuItems, async (action: any) => {
            switch (action) {
                case 'preview':
                    const { showShelfPreview } = await import('../shelves/shelfPreview');
                    showShelfPreview(bookId);
                    break;

                case 'add-to-shelf':
                    const { showAddToShelfMenu } = await import('../shelves/addToShelfMenu');
                    showAddToShelfMenu(target, bookId);
                    break;

                case 'share':
                    try {
                        const data = await citationPromise;
                        if (!data) return;
                        const { copyCitationToClipboard } = await import('../../utilities/bibtexProcessor');
                        copyCitationToClipboard(data);
                    } catch (err) {
                        console.error('Share citation failed:', err);
                    }
                    break;

                case 'delete':
                    await handleDeleteBook(bookId, target);
                    break;
            }
        });
    };
    document.addEventListener('click', userBookActionsHandler);
}

/**
 * Handle book deletion (extracted from old .delete-book handler).
 */
async function handleDeleteBook(bookId: any, target: any) {
    if (!confirm(`Delete "${bookId}" and all associated data?`)) return;

    const libraryCard = target.closest('.libraryCard');
    if (libraryCard) libraryCard.remove();

    // Delete from IndexedDB
    const { deleteBookFromIndexedDB, deleteNodesByNodeIds } = await import('../../indexedDB/index');
    await deleteBookFromIndexedDB(bookId);

    // Also evict the deleted book's library-card node from the local home books. The card lives in
    // the home book (`<home>_<book>_card`), not in `bookId` itself, so deleteBookFromIndexedDB
    // doesn't touch it. Without this the user page re-paints the card on the next visit from the
    // cached home book (an optimistic render that runs before the freshness pull replaces it),
    // mirroring what BookDeletionService removes server-side. window.allBook = `<sanitized>All`.
    try {
      const allHome = (window as any).allBook as string | undefined;
      if (allHome) {
        const base = allHome.replace(/All$/, '');
        const cardNodeIds = [base, base + 'Private', allHome].map(h => `${h}_${bookId}_card`);
        await deleteNodesByNodeIds(cardNodeIds);
      }
    } catch (e) {
      console.warn('Failed to evict home-book card node from IndexedDB:', e);
    }

    // Send delete request to server
    try {
        const { refreshAuth } = await import('../../utilities/auth/index');
        await refreshAuth();

        const csrfToken = (window as any).csrfToken || (document.querySelector('meta[name="csrf-token"]') as any)?.content;
        const resp = await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-TOKEN': csrfToken,
            },
            credentials: 'include',
        });
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`${resp.status} ${txt}`);
        }
        log.content(`Book ${bookId} deletion request sent to server.`, '/components/userProfile/userProfilePage.ts');
    } catch (err) {
        log.error('Server delete failed:', '/components/userProfile/userProfilePage.ts', err);
    }
}
