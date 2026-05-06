/**
 * Shelf preview overlay — read-only preview of a book's first chunk.
 * Reuses the ref-overlay backdrop pattern.
 */

import { fetchSingleChunkFromServer } from '../../chunkFetcher.js';

let previewOverlay = null;
let previewContainer = null;

/**
 * Show a read-only preview of a book.
 * Fetches chunk 0 and renders it in an overlay.
 * @param {string} bookId - The book to preview
 */
export async function showShelfPreview(bookId) {
    hideShelfPreview();

    // Create backdrop overlay
    previewOverlay = document.createElement('div');
    previewOverlay.id = 'shelf-preview-overlay';
    previewOverlay.className = 'shelf-preview-overlay';
    previewOverlay.addEventListener('click', (e) => {
        if (e.target === previewOverlay) hideShelfPreview();
    });

    // Create preview container
    previewContainer = document.createElement('div');
    previewContainer.className = 'shelf-preview-container';

    // Loading state
    previewContainer.innerHTML = '<p class="shelf-preview-loading"><em>Loading preview...</em></p>';
    previewOverlay.appendChild(previewContainer);
    document.body.appendChild(previewOverlay);

    // Fetch chunk 0
    try {
        const nodes = await fetchSingleChunkFromServer(bookId, 0);

        if (!nodes || nodes.length === 0) {
            previewContainer.innerHTML = '<p class="shelf-preview-empty"><em>No content available</em></p>';
        } else {
            // Render nodes as read-only HTML
            previewContainer.innerHTML = '';
            const content = document.createElement('div');
            content.className = 'shelf-preview-content';

            for (const node of nodes) {
                if (node.content) {
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = node.content;
                    // Strip any contenteditable attributes
                    wrapper.querySelectorAll('[contenteditable]').forEach(el => {
                        el.removeAttribute('contenteditable');
                    });
                    content.appendChild(wrapper.firstElementChild || wrapper);
                }
            }
            previewContainer.appendChild(content);
        }

        // Add action bar at bottom
        const actionBar = document.createElement('div');
        actionBar.className = 'shelf-preview-actions';

        // Open button
        const goBtn = document.createElement('a');
        goBtn.href = '/' + bookId;
        goBtn.className = 'shelf-preview-action-btn';
        goBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Open';
        actionBar.appendChild(goBtn);

        // Add to shelf button
        const shelfBtn = document.createElement('button');
        shelfBtn.type = 'button';
        shelfBtn.className = 'shelf-preview-action-btn';
        shelfBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Add to shelf';
        shelfBtn.addEventListener('click', async () => {
            const { showAddToShelfMenu } = await import('./addToShelfMenu.js');
            showAddToShelfMenu(shelfBtn, bookId);
        });
        actionBar.appendChild(shelfBtn);

        // Delete button — only for owners on their own page
        if (window.isOwner) {
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'shelf-preview-action-btn';
            deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete';
            deleteBtn.addEventListener('click', async () => {
                if (!confirm(`Delete "${bookId}" and all associated data?`)) return;

                hideShelfPreview();

                // Remove card from DOM
                const card = document.querySelector(`.book-actions[data-book="${bookId}"]`);
                const libraryCard = card?.closest('.libraryCard');
                if (libraryCard) libraryCard.remove();

                // Delete from IndexedDB
                const { deleteBookFromIndexedDB } = await import('../../indexedDB/index.js');
                await deleteBookFromIndexedDB(bookId);

                // Server delete
                try {
                    const { refreshAuth } = await import('../../utilities/auth.js');
                    await refreshAuth();
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
                }
            });
            actionBar.appendChild(deleteBtn);
        }

        previewContainer.appendChild(actionBar);
    } catch (err) {
        console.error('Preview fetch failed:', err);
        previewContainer.innerHTML = '<p class="shelf-preview-empty"><em>Failed to load preview</em></p>';
    }

    // ESC to close
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            hideShelfPreview();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

/**
 * Hide and clean up the preview overlay.
 */
export function hideShelfPreview() {
    if (previewOverlay) {
        previewOverlay.remove();
        previewOverlay = null;
    }
    if (previewContainer) {
        previewContainer = null;
    }
}
