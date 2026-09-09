import { asBookId } from "../indexedDB/types";
import { book as currentBook } from '../app';
import { openDatabase } from '../indexedDB/index';
import {
    loadNodesToIndexedDB,
    loadBibliographyToIndexedDB,
    loadHyperlightsToIndexedDB,
    loadHypercitesToIndexedDB,
} from '../indexedDB/serverSync/index';
import { log, verbose } from '../utilities/logger';
import { rebuildAndRenumber } from '../footnotes/FootnoteNumberingService';
import { appendGateParam } from '../components/utilities/gateFilter';
import { reconvertSyncActive } from '../utilities/reconvertHandoff';

/**
 * How many chunks to fetch per batch request.
 * ~50 chunks ≈ ~5000 nodes — keeps each response under ~10MB.
 */
const CHUNKS_PER_BATCH = 50;

/* ── Book-scoped in-flight registry ───────────────────────────────────────
 * A background download belongs to ONE book, but the SPA can navigate to a
 * different book while it is still running — the user page loads its own
 * aggregate book (`{username}All`) and its download regularly outlives the
 * nav into a reader. With a single global boolean that produced two bugs:
 *   1. Every "wait until my book is fully downloaded" consumer (edit mode,
 *      paste, exports, internal nav) parked on the OTHER book's download —
 *      the edit button sat dead for seconds after a user→reader nav.
 *   2. The newly-entered book's own download was skipped by the
 *      double-download guard, so it never got its remaining chunks.
 * The registry is keyed by book id so both are impossible; `isCurrentBook`
 * additionally fences the GLOBAL writes at the end of a download (see below).
 */
const inFlight = new Set<string>();

function markInFlight(bookId: string, active: boolean): void {
    if (active) inFlight.add(bookId);
    else inFlight.delete(bookId);
    // Legacy mirror for any reader of the old flag (kept truthful: "some
    // book is downloading"). New code asks isBackgroundDownloadInProgress().
    (window as any)._backgroundDownloadInProgress = inFlight.size > 0;
}

/** Is a background download running — for `bookId` if given, for ANY book otherwise? */
export function isBackgroundDownloadInProgress(bookId?: string | null): boolean {
    return bookId ? inFlight.has(String(bookId)) : inFlight.size > 0;
}

/**
 * Is `bookId` the book currently rendered? Sub-books count as their parent
 * (a `book_x/Fn3` download belongs to the `book_x` reader that opened it).
 *
 * TWO sources of truth on purpose: `book` from app.ts (kept current by
 * setCurrentBook on SPA nav) AND the rendered `.main-content` id — home/user
 * feed pages mint that container lazily when a tab is pressed, long after
 * app.ts captured `book` from `body[data-book]` (the username on /u/ pages),
 * so the feed's own download would otherwise read as "not current".
 */
function isCurrentBook(bookId: string): boolean {
    const target = String(bookId).split('/')[0];
    const candidates = [
        String(currentBook || ''),
        document.querySelector<HTMLElement>('.main-content')?.id || '',
    ].filter(Boolean);
    if (!candidates.length) return true; // nothing to compare against — behave as before
    return candidates.some((c) => c === bookId || c.split('/')[0] === target);
}

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
export async function backgroundDownloadRemainingChunks(bookId: string, lazyLoader: any) {
    if (!bookId || !lazyLoader) return;

    // While a reconvert is mid-flight (polling window) OR this is the gated first load right after
    // a reconvert reload, stay OUT of the way: readerEntry force-fresh-populates IDB in order, and
    // this path's upsert + rebuildAndRenumber re-render would race it and scramble node order.
    if (reconvertSyncActive(bookId)) {
        verbose.content('Reconvert in progress — skipping background download', 'backgroundDownloader.js');
        return;
    }

    // Guard against double-download OF THIS BOOK — another book's download
    // (e.g. the user page's aggregate book, still finishing after the nav)
    // must not suppress this one.
    if (inFlight.has(bookId)) {
        verbose.content(`Background download already in progress for ${bookId}, skipping`, 'backgroundDownloader.js');
        return;
    }

    markInFlight(bookId, true);

    try {
        verbose.content(`Starting batched background download for: ${bookId}`, 'backgroundDownloader.js');

        // If no chunk manifest, fall back to monolithic download
        const manifest = lazyLoader.chunkManifest || (window as any).chunkManifest;
        if (!manifest || manifest.length === 0) {
            verbose.content('No chunk manifest available, falling back to full download', 'backgroundDownloader.js');
            await fullDownloadFallback(bookId, lazyLoader);
            return;
        }

        // Build batch ranges from the manifest
        const allChunkIds = manifest.map((c: any) => c.chunk_id).sort((a: number, b: number) => a - b);
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

            let batchData: any = null;
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
                } catch (err: any) {
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

        // Upsert all nodes to IndexedDB — book-keyed, so this is always safe
        // and always worth doing, even if the reader moved on meanwhile.
        const db = await openDatabase();
        await loadNodesToIndexedDB(db, allNodes);

        // Update lazy loader with full dataset
        if (lazyLoader) {
            lazyLoader.nodes = allNodes;
            lazyLoader.isFullyLoaded = true;
            lazyLoader.chunkManifest = null;
        }

        // Everything below is GLOBAL / DOM-scoped state owned by whatever book
        // is on screen NOW. A download that outlived its nav must not touch it:
        // `window.nodes` would hand the rendered book another book's dataset,
        // and rebuildAndRenumber walks the LIVE DOM — renumbering the displayed
        // book's sups from this book's footnote map and then persisting that
        // DOM back into THIS book's IDB rows (cross-book content corruption).
        if (allNodes.length && isCurrentBook(bookId)) {
            (window as any).nodes = allNodes;

            // Rebuild footnote map with FULL dataset (initial chunk only had ~100 nodes),
            // update already-rendered DOM sups, AND persist the new numbers to IDB.
            // The persist step is critical: without it, DOM and IDB diverge and the
            // periodic integrity check trips a self-heal on every affected node.
            await rebuildAndRenumber(asBookId(bookId), allNodes);
        } else if (allNodes.length) {
            verbose.content(
                `Navigated away from ${bookId} — IDB updated, skipping global/DOM swap`,
                'backgroundDownloader.js'
            );
        }

        verbose.content(
            `Background download complete: ${allNodes.length} nodes in ${batches.length} batches`,
            'backgroundDownloader.js'
        );

        // Notify listeners (TOC, search, etc.)
        window.dispatchEvent(new CustomEvent('backgroundDownloadComplete', {
            detail: { bookId }
        }));

    } catch (error: any) {
        log.error(`Background download failed: ${error.message}`, 'backgroundDownloader.js', error);

        // Fire failure event so UI can show retry
        window.dispatchEvent(new CustomEvent('backgroundDownloadFailed', {
            detail: { bookId, error: error.message }
        }));
    } finally {
        markInFlight(bookId, false);
    }
}

/**
 * Promise-based helper for code that needs to wait for a background download.
 * Used by edit operations (edit mode, paste, exports, internal nav) that need
 * all nodes.  Resolves on either success or failure.
 *
 * ALWAYS pass the book you actually care about: without it this waits for the
 * next completion of ANY book, which is how the edit button ended up parked on
 * the user page's aggregate-book download after a user→reader navigation.
 */
export function waitForBackgroundDownload(bookId?: string | null, timeoutMs = 30000): Promise<void> {
    const target = bookId ? String(bookId) : null;
    if (!isBackgroundDownloadInProgress(target)) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            window.removeEventListener('backgroundDownloadComplete', handler);
            window.removeEventListener('backgroundDownloadFailed', handler);
            resolve();
        };
        // Ignore completions belonging to another book — but always re-check
        // the registry, so a download that ended without its event still frees us.
        const handler = (e: Event) => {
            const done = (e as CustomEvent)?.detail?.bookId;
            if (target && done && String(done) !== target) {
                if (!isBackgroundDownloadInProgress(target)) finish();
                return;
            }
            finish();
        };

        const timer = setTimeout(() => {
            window.removeEventListener('backgroundDownloadComplete', handler);
            window.removeEventListener('backgroundDownloadFailed', handler);
            resolve(); // Resolve anyway after timeout
        }, timeoutMs);

        window.addEventListener('backgroundDownloadComplete', handler);
        window.addEventListener('backgroundDownloadFailed', handler);
    });
}

/**
 * Build batch ranges from a sorted array of chunk IDs.
 * Groups consecutive chunks into batches of `batchSize`.
 * Returns [{from, to}, ...] where from/to are chunk_id values (inclusive).
 */
function buildBatchRanges(sortedChunkIds: number[], batchSize: number): any[] {
    const batches: any[] = [];
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
function buildBatchUrl(bookId: string, from: number, to: number) {
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
function buildDataUrl(bookId: string) {
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
async function fullDownloadFallback(bookId: string, lazyLoader: any) {
    const url = buildDataUrl(bookId);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Background download failed: ${response.status}`);
    }

    const data = await response.json();

    // Upsert all data to IndexedDB
    const db = await openDatabase();
    await loadNodesToIndexedDB(db, data.nodes);

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

    // Update window.nodes for other consumers — only while this book is still
    // the rendered one (see the fence in the batched path above).
    if (data.nodes?.length && isCurrentBook(bookId)) {
        (window as any).nodes = data.nodes;
        // Rebuild + update DOM + persist (see comment in main path above).
        await rebuildAndRenumber(asBookId(bookId), data.nodes);
    }

    verbose.content(
        `Background download complete (full fallback): ${data.nodes?.length || 0} nodes`,
        'backgroundDownloader.js'
    );

    window.dispatchEvent(new CustomEvent('backgroundDownloadComplete', {
        detail: { bookId }
    }));
}
