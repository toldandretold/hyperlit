import { openDatabase } from './indexedDB/index.js';
import {
    loadNodeChunksToIndexedDB,
    loadBibliographyToIndexedDB,
    loadHyperlightsToIndexedDB,
    loadHypercitesToIndexedDB,
} from './postgreSQL.js';
import { log, verbose } from './utilities/logger.js';
import { buildFootnoteMap, updateFootnoteNumbersInDOM } from './footnotes/FootnoteNumberingService.js';
import { appendGateParam } from './components/gateFilter.js';

/**
 * After the first chunk is rendered, download ALL remaining book data
 * in the background and upsert into IndexedDB.
 *
 * Key design decisions:
 * - Uses put() (upsert) for nodes — does NOT clear first, so the
 *   already-loaded initial chunk stays intact.
 * - Updates the lazy loader's node array and marks it as fully loaded.
 * - Fires a custom event so TOC, search, etc. can rebuild their indexes.
 */
export async function backgroundDownloadRemainingChunks(bookId, lazyLoader) {
    if (!bookId || !lazyLoader) return;

    // Guard against double-download
    if (window._backgroundDownloadInProgress) {
        verbose.content('Background download already in progress, skipping', 'backgroundDownloader.js');
        return;
    }

    window._backgroundDownloadInProgress = true;

    try {
        verbose.content(`Starting background download for: ${bookId}`, 'backgroundDownloader.js');

        // Build URL handling sub-book IDs
        const url = buildDataUrl(bookId);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Background download failed: ${response.status}`);
        }

        const data = await response.json();

        // Upsert all data to IndexedDB (put, NOT clear+add)
        const db = await openDatabase();
        await loadNodeChunksToIndexedDB(db, data.nodes);

        await Promise.allSettled([
            loadBibliographyToIndexedDB(db, data.bibliography),
            loadHyperlightsToIndexedDB(db, data.hyperlights),
            loadHypercitesToIndexedDB(db, data.hypercites),
        ]);

        // Update lazy loader with full dataset
        if (lazyLoader) {
            lazyLoader.nodes = data.nodes || lazyLoader.nodes;
            lazyLoader.isFullyLoaded = true;
            lazyLoader.chunkManifest = null; // No longer needed
        }

        // Update window.nodes for other consumers
        if (data.nodes?.length) {
            window.nodes = data.nodes;

            // Rebuild footnote map with FULL dataset (initial chunk only had ~100 nodes)
            buildFootnoteMap(bookId, data.nodes);
            // Fix corrupted fn-count-id on already-rendered DOM sups
            // (PG heals naturally when user edits a node — the save path reads corrected DOM)
            updateFootnoteNumbersInDOM();
        }

        verbose.content(
            `Background download complete: ${data.nodes?.length || 0} nodes, ` +
            `${data.hyperlights?.length || 0} hyperlights, ` +
            `${data.hypercites?.length || 0} hypercites`,
            'backgroundDownloader.js'
        );

        // Notify listeners (TOC, search, etc.)
        window.dispatchEvent(new CustomEvent('backgroundDownloadComplete', {
            detail: { bookId }
        }));

    } catch (error) {
        log.error(`Background download failed: ${error.message}`, 'backgroundDownloader.js', error);
    } finally {
        window._backgroundDownloadInProgress = false;
    }
}

/**
 * Promise-based helper for code that needs to wait for background download.
 * Used by edit operations (paste, renumber) that need all nodes.
 */
export function waitForBackgroundDownload(timeoutMs = 30000) {
    if (!window._backgroundDownloadInProgress) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const handler = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            window.removeEventListener('backgroundDownloadComplete', handler);
            resolve(); // Resolve anyway after timeout
        }, timeoutMs);

        window.addEventListener('backgroundDownloadComplete', handler, { once: true });
    });
}

/**
 * Build the full-data API URL, handling sub-book IDs with slashes.
 */
function buildDataUrl(bookId) {
    const slashIndex = bookId.indexOf('/');
    let url;
    if (slashIndex !== -1) {
        const parentBook = bookId.substring(0, slashIndex);
        const subId = bookId.substring(slashIndex + 1);
        url = `/api/database-to-indexeddb/books/${parentBook}/${subId}/data`;
    } else {
        url = `/api/database-to-indexeddb/books/${bookId}/data`;
    }
    return appendGateParam(url);
}
