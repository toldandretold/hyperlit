// resources/js/userProfilePage.js

let userProfilePageInitialized = false;

export function initializeUserProfilePage() {
    if (userProfilePageInitialized) {
        console.log("✅ User profile page already initialized, skipping");
        return;
    }
    
    console.log("🔧 Initializing user profile page click handlers");
    
    // Debug: Check if delete buttons exist in DOM
    const deleteButtons = document.querySelectorAll('.delete-book');
    const libraryCards = document.querySelectorAll('.libraryCard');
    console.log(`🔍 Found ${deleteButtons.length} delete buttons and ${libraryCards.length} library cards in DOM`);
    
    if (deleteButtons.length === 0 && libraryCards.length > 0) {
        console.log("❌ DELETE BUTTONS MISSING: Library cards exist but no delete buttons found!");
        console.log("📝 This indicates the server-side generation is not including delete buttons");
        console.log("🔧 Check if backend changes were deployed and user is properly authenticated server-side");
    }
    
    userProfilePageInitialized = true;

    // Tier selector toggle (delegated — survives DOMPurify sanitization)
    document.addEventListener('click', (e) => {
        const selector = e.target.closest('.tier-selector');
        if (!selector) return;
        e.preventDefault();
        e.stopPropagation();
        const dropdown = selector.nextElementSibling; // .tier-dropdown
        if (dropdown) dropdown.classList.toggle('hidden');
    });

    // Tier option selection
    document.addEventListener('click', async (e) => {
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
                    totalCredit.querySelectorAll('.tier-option').forEach(opt => opt.classList.remove('active'));
                    option.classList.add('active');
                }

                // Close dropdown
                const dropdown = option.closest('.tier-dropdown');
                if (dropdown) dropdown.classList.add('hidden');
            }
        } catch (err) {
            console.error('Tier update failed:', err);
        }
    });

    // Close tier dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.tier-dropdown') && !e.target.closest('.tier-selector')) {
            document.querySelectorAll('.tier-dropdown').forEach(d => d.classList.add('hidden'));
        }
    });

    // Stripe top-up button handler (delegated — survives DOMPurify sanitization)
    document.addEventListener('click', async (e) => {
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
            console.error('Stripe checkout failed:', err);
        }
    });

    document.addEventListener('click', async (e) => {
        const target = e.target.closest('.delete-book');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const bookId = target.getAttribute('data-book');
        if (!bookId) return;

        const libraryCard = target.closest('.libraryCard');
        if (!libraryCard) return;

        const nodeId = libraryCard.id;

        if (!confirm(`Delete "${bookId}" and all associated data?`)) return;

        // 1. Remove from DOM for instant feedback
        libraryCard.remove();

        // 2. Delete the book and all associated data from IndexedDB
        const { deleteBookFromIndexedDB } = await import('../indexedDB/index.js');
        await deleteBookFromIndexedDB(bookId);

        // 3. Send delete request to the server in the background
        try {
            // Refresh auth state to get fresh CSRF token (handles SPA navigation staleness)
            const { refreshAuth } = await import('../utilities/auth.js');
            await refreshAuth();

            // Use the freshly updated CSRF token
            const csrfToken = window.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content;
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
            console.log(`Book ${bookId} deletion request sent to server.`);
        } catch (err) {
            console.error('Server delete failed:', err);
            // Optional: Add UI to inform user of server-side failure
            // and potentially restore the libraryCard element.
        }
    });
}
