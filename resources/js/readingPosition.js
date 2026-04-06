/**
 * Reading Position — server-persisted bookmark for cross-device resume.
 *
 * Saves the user's scroll position (element ID + chunk ID) to the server
 * with a 5-second debounce. Also fires on page unload via sendBeacon.
 */

let debounceTimer = null;
const DEBOUNCE_MS = 5000;

/**
 * Debounced save of reading position to server.
 * Called from lazyLoaderFactory.js forceSavePosition().
 */
export function debouncedServerSave(bookId, elementId, chunkId) {
    if (!bookId || !elementId) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        saveToServer(bookId, elementId, chunkId);
    }, DEBOUNCE_MS);
}

/**
 * Immediate save via sendBeacon (for beforeunload).
 * sendBeacon doesn't need CSRF tokens — the route is excluded from CSRF verification.
 */
export function sendBeaconSave(bookId, elementId, chunkId) {
    if (!bookId || !elementId) return;

    const url = buildPositionUrl(bookId);
    const data = JSON.stringify({
        element_id: elementId,
        chunk_id: chunkId,
    });
    const blob = new Blob([data], { type: 'application/json' });

    try {
        navigator.sendBeacon(url, blob);
    } catch (e) {
        // sendBeacon can fail silently — that's OK
    }
}

/**
 * Save reading position via fetch (normal path).
 */
async function saveToServer(bookId, elementId, chunkId) {
    try {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        const url = buildPositionUrl(bookId);

        await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
            },
            credentials: 'include',
            body: JSON.stringify({
                element_id: elementId,
                chunk_id: chunkId,
            }),
        });
    } catch (error) {
        // Silently fail — position saving is best-effort
        console.debug('Reading position save failed:', error.message);
    }
}

/**
 * Build the API URL for saving position, handling sub-book IDs.
 */
function buildPositionUrl(bookId) {
    return `/api/database-to-indexeddb/books/${encodeURIComponent(bookId)}/reading-position`;
}
