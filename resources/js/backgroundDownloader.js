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
 * How many chunks to fetch per batch request.
 * ~50 chunks ≈ ~5000 nodes — keeps each response under ~10MB.
 */
const CHUNKS_PER_BATCH = 50;

/**
 * After the first chunk is rendered, download ALL remaining book data
 * in batches and upsert into IndexedDB.
 *
 * Key design decisions:
 * - Fetches nodes in batches of ~50 chunks via /data/batch?from=X&to=Y
 * - Uses put() (upsert) for nodes — does NOT clear first, so the
 *   already-loaded initial chunk stays intact.
 * - Atomic swap: only updates lazyLoader/window.nodes/footnotes AFTER
 *   all batches succeed — preserves "all or nothing" semantics.
 * - Fires backgroundDownloadFailed on failure so UI can show retry.
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
        verbose.content(`Starting batched background download for: ${bookId}`, 'backgroundDownloader.js');

        // If no chunk manifest, fall back to monolithic download
        const manifest = lazyLoader.chunkManifest || window.chunkManifest;
        if (!manifest || manifest.length === 0) {
            verbose.content('No chunk manifest available, falling back to full download', 'backgroundDownloader.js');
            await fullDownloadFallback(bookId, lazyLoader);
            return;
        }

        // Build batch ranges from the manifest
        const allChunkIds = manifest.map(c => c.chunk_id).sort((a, b) => a - b);
        const batches = buildBatchRanges(allChunkIds, CHUNKS_PER_BATCH);

        verbose.content(
            `Downloading ${allChunkIds.length} chunks in ${batches.length} batches`,
            'backgroundDownloader.js'
        );

        // Accumulate all nodes across batches
        const allNodes = [];

        for (let i = 0; i < batches.length; i++) {
            const { from, to } = batches[i];
            const batchUrl = buildBatchUrl(bookId, from, to);

            verbose.content(
                `Batch ${i + 1}/${batches.length}: chunks ${from}-${to}`,
                'backgroundDownloader.js'
            );

            let batchData = null;
            let retried = false;

            // Attempt fetch with one retry
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const response = await fetch(batchUrl);
                    if (!response.ok) {
                        throw new Error(`Batch fetch failed: ${response.status}`);
                    }
                    batchData = await response.json();
                    break;
                } catch (err) {
                    if (attempt === 0) {
                        retried = true;
                        verbose.content(
                            `Batch ${i + 1} failed, retrying: ${err.message}`,
                            'backgroundDownloader.js'
                        );
                        // Brief pause before retry
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        throw new Error(`Batch ${i + 1} failed after retry: ${err.message}`);
                    }
                }
            }

            if (batchData?.nodes?.length) {
                allNodes.push(...batchData.nodes);
            }

            if (retried) {
                verbose.content(`Batch ${i + 1} succeeded on retry`, 'backgroundDownloader.js');
            }
        }

        // === Atomic swap: same semantics as before ===

        // Upsert all nodes to IndexedDB
        const db = await openDatabase();
        await loadNodeChunksToIndexedDB(db, allNodes);

        // Update lazy loader with full dataset
        if (lazyLoader) {
            lazyLoader.nodes = allNodes;
            lazyLoader.isFullyLoaded = true;
            lazyLoader.chunkManifest = null;
        }

        // Update window.nodes for other consumers
        if (allNodes.length) {
            window.nodes = allNodes;

            // Rebuild footnote map with FULL dataset (initial chunk only had ~100 nodes)
            buildFootnoteMap(bookId, allNodes);
            // Fix corrupted fn-count-id on already-rendered DOM sups
            updateFootnoteNumbersInDOM();
        }

        verbose.content(
            `Background download complete: ${allNodes.length} nodes in ${batches.length} batches`,
            'backgroundDownloader.js'
        );

        // Notify listeners (TOC, search, etc.)
        window.dispatchEvent(new CustomEvent('backgroundDownloadComplete', {
            detail: { bookId }
        }));

    } catch (error) {
        log.error(`Background download failed: ${error.message}`, 'backgroundDownloader.js', error);

        // Fire failure event so UI can show retry
        window.dispatchEvent(new CustomEvent('backgroundDownloadFailed', {
            detail: { bookId, error: error.message }
        }));
    } finally {
        window._backgroundDownloadInProgress = false;
    }
}

/**
 * Promise-based helper for code that needs to wait for background download.
 * Used by edit operations (paste, renumber) that need all nodes.
 * Resolves on either success or failure.
 */
export function waitForBackgroundDownload(timeoutMs = 30000) {
    if (!window._backgroundDownloadInProgress) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const handler = () => {
            clearTimeout(timer);
            window.removeEventListener('backgroundDownloadComplete', completeHandler);
            window.removeEventListener('backgroundDownloadFailed', failHandler);
            resolve();
        };
        const completeHandler = handler;
        const failHandler = handler;

        const timer = setTimeout(() => {
            window.removeEventListener('backgroundDownloadComplete', completeHandler);
            window.removeEventListener('backgroundDownloadFailed', failHandler);
            resolve(); // Resolve anyway after timeout
        }, timeoutMs);

        window.addEventListener('backgroundDownloadComplete', completeHandler, { once: true });
        window.addEventListener('backgroundDownloadFailed', failHandler, { once: true });
    });
}

/**
 * Build batch ranges from a sorted array of chunk IDs.
 * Groups consecutive chunks into batches of `batchSize`.
 * Returns [{from, to}, ...] where from/to are chunk_id values (inclusive).
 */
function buildBatchRanges(sortedChunkIds, batchSize) {
    const batches = [];
    for (let i = 0; i < sortedChunkIds.length; i += batchSize) {
        const slice = sortedChunkIds.slice(i, i + batchSize);
        batches.push({
            from: slice[0],
            to: slice[slice.length - 1],
        });
    }
    return batches;
}

/**
 * Build the batch-data API URL, handling sub-book IDs with slashes.
 */
function buildBatchUrl(bookId, from, to) {
    const slashIndex = bookId.indexOf('/');
    let url;
    if (slashIndex !== -1) {
        // Sub-books use the full /data endpoint (they're small)
        const parentBook = bookId.substring(0, slashIndex);
        const subId = bookId.substring(slashIndex + 1);
        url = `/api/database-to-indexeddb/books/${parentBook}/${subId}/data`;
    } else {
        url = `/api/database-to-indexeddb/books/${bookId}/data/batch?from=${from}&to=${to}`;
    }
    return appendGateParam(url);
}

/**
 * Build the full-data API URL (for fallback when no manifest).
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

/**
 * Fallback: monolithic download when no chunk manifest is available.
 * Preserves the original behavior for sub-books and edge cases.
 */
async function fullDownloadFallback(bookId, lazyLoader) {
    const url = buildDataUrl(bookId);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Background download failed: ${response.status}`);
    }

    const data = await response.json();

    // Upsert all data to IndexedDB
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
        lazyLoader.chunkManifest = null;
    }

    // Update window.nodes for other consumers
    if (data.nodes?.length) {
        window.nodes = data.nodes;
        buildFootnoteMap(bookId, data.nodes);
        updateFootnoteNumbersInDOM();
    }

    verbose.content(
        `Background download complete (full fallback): ${data.nodes?.length || 0} nodes`,
        'backgroundDownloader.js'
    );

    window.dispatchEvent(new CustomEvent('backgroundDownloadComplete', {
        detail: { bookId }
    }));
}
