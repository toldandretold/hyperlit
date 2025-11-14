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

        // 2. Queue the node chunk for deletion in IndexedDB
        const { batchDeleteIndexedDBRecords } = await import('../indexedDB/index.js');
        batchDeleteIndexedDBRecords([nodeId]);

        // 3. Send delete request to the server in the background
        try {
            // Ensure CSRF cookie is present
            await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfToken = csrfMeta ? csrfMeta.content : null;
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
