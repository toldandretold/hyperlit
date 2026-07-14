import { openDatabase } from '../indexedDB/index';
import {
    loadNodesToIndexedDB,
    loadLibraryToIndexedDB,
    loadBibliographyToIndexedDB,
    loadHyperlightsToIndexedDB,
    loadHypercitesToIndexedDB,
    clearBookDataFromIndexedDB,
} from '../indexedDB/serverSync/index';
import { log, verbose } from '../utilities/logger';
import { OpenHyperlightID, OpenFootnoteID } from '../app';
import { gateQueryParam, getPinnedHyperciteIds, pinHypercite } from '../components/utilities/gateFilter';
import type { ReadingPosition } from '../scrolling/readingPosition';

/**
 * Fetch the initial chunk from the server for fast first-render loading.
 * Returns one chunk of nodes + a manifest describing all chunks, so the
 * lazy loader can discover and fetch remaining chunks on demand.
 */
export async function fetchInitialChunk(bookId: string): Promise<any> {
    try {
        // Build query params based on URL context
        const params = buildInitialChunkParams();
        injectGateParam(params);
        const queryString = params.toString();
        const url = buildApiUrl(bookId, queryString);

        verbose.content(`Fetching initial chunk: ${url}`, 'initialChunkLoader.js');

        const response = await fetch(url);

        if (!response.ok) {
            return await handleErrorResponse(response, bookId);
        }

        const data = await response.json();

        // E2EE open-gate, fresh-device case (docs/e2ee.md): the library row rides
        // this response — if the book is encrypted and the vault is locked, unlock
        // BEFORE the loaders run (their decrypt would throw, and allSettled below
        // would swallow that into a broken half-loaded render).
        if (data.library?.encrypted) {
            const { isVaultUnlocked } = await import('../e2ee/keys');
            if (!(await isVaultUnlocked())) {
                try {
                    const { showUnlockModal } = await import('../e2ee/ui/unlockModal');
                    await showUnlockModal();
                } catch {
                    window.location.href = '/'; // dismissed — leave the book
                    return { success: false, reason: 'e2ee_locked' };
                }
            }
        }

        // Store to IndexedDB
        const db = await openDatabase();
        // Clear stale data for this book to prevent duplicate node_ids
        // (server may have renumbered startLines since last cache)
        await clearBookDataFromIndexedDB(db, bookId);
        const [nodesResult] = await Promise.allSettled([
            loadNodesToIndexedDB(db, data.initial_chunk),
            loadFootnotesToIndexedDB(db, data.footnotes),
            loadLibraryToIndexedDB(db, data.library),
            loadBibliographyToIndexedDB(db, data.bibliography),
            loadHyperlightsToIndexedDB(db, data.hyperlights),
            loadHypercitesToIndexedDB(db, data.hypercites),
        ]);

        // The reader renders from the returned `nodes` (→ window.nodes). Use the DECRYPTED,
        // processed records that loadNodesToIndexedDB returns — NOT the raw `data.initial_chunk`,
        // which for an ENCRYPTED book is still ciphertext (loadNodesToIndexedDB decrypts a COPY for
        // IDB). Returning the raw ciphertext rendered hlenc.v1 blobs as empty content on fresh-device
        // load (IDB was plaintext, the DOM was blank). Fall back to the raw rows only if the loader
        // rejected (plaintext books are unaffected either way).
        const decryptedNodes = nodesResult.status === 'fulfilled' && nodesResult.value?.length
            ? nodesResult.value
            : (data.initial_chunk || []);

        verbose.content(
            `Initial chunk loaded: chunk ${data.target_chunk_id}, ` +
            `${data.initial_chunk?.length || 0} nodes, ` +
            `${data.chunk_manifest?.length || 0} total chunks in manifest`,
            'initialChunkLoader.js'
        );

        return {
            success: true,
            nodes: decryptedNodes,
            chunkManifest: data.chunk_manifest || [],
            targetChunkId: data.target_chunk_id,
            targetResolved: data.target_resolved !== false, // default true for backward compat
            targetReason: data.target_reason || null,
            targetFallbackUsed: data.target_fallback_used || null,
            bookmark: (data.bookmark ?? null) as ReadingPosition | null,
            library: data.library,
            footnotes: data.footnotes,
            metadata: data.metadata,
        };

    } catch (error: any) {
        log.error(`Initial chunk fetch failed: ${error.message}`, 'initialChunkLoader.js', error);
        return { success: false, error: error.message, reason: 'sync_error' };
    }
}

/**
 * Build the API URL, handling sub-book IDs with slashes.
 */
function buildApiUrl(bookId: string, queryString: string) {
    // Sub-books have IDs like "parentBook/subId" — route accordingly
    const slashIndex = bookId.indexOf('/');
    let base;
    if (slashIndex !== -1) {
        const parentBook = bookId.substring(0, slashIndex);
        const subId = bookId.substring(slashIndex + 1);
        base = `/api/database-to-indexeddb/books/${parentBook}/${subId}/initial`;
    } else {
        base = `/api/database-to-indexeddb/books/${bookId}/initial`;
    }
    return queryString ? `${base}?${queryString}` : base;
}

/**
 * Determine query params from URL hash / OpenHyperlightID / OpenFootnoteID.
 */
function buildInitialChunkParams() {
    const params = new URLSearchParams();

    // Priority 0: SPA navigation target (set by BookToBookTransition before loadHyperText)
    // During SPA transitions, window.location.hash hasn't been updated yet
    const spaTarget = (window as any)._pendingChunkTarget;
    const spaFallback = (window as any)._pendingChunkFallbackTarget;
    if (spaTarget) {
        (window as any)._pendingChunkTarget = null; // Consume it
        (window as any)._pendingChunkFallbackTarget = null;
        if (spaTarget.startsWith('hypercite_') || spaTarget.startsWith('HL_') || spaTarget.startsWith('Fn') || spaTarget.includes('_Fn')) {
            params.set('target', spaTarget);
            // Pin hypercite deep-link targets so the target-exempted record (server
            // sends it even if gated/'single') also survives the CLIENT gate at render.
            if (spaTarget.startsWith('hypercite_')) pinHypercite(spaTarget);
            if (spaFallback) {
                params.set('fallback_target', spaFallback);
            }
            return params;
        }
        if (/^\d+(\.\d+)?$/.test(spaTarget)) {
            params.set('element_id', spaTarget);
            return params;
        }
    } else {
        (window as any)._pendingChunkFallbackTarget = null; // Clean up even if no SPA target
    }

    // Priority 1: URL hash target
    const hash = window.location.hash?.substring(1);
    if (hash) {
        if (hash.startsWith('hypercite_') || hash.startsWith('HL_') || hash.startsWith('Fn') || hash.includes('_Fn')) {
            params.set('target', hash);
            // Pin hypercite deep-link targets (see SPA branch above)
            if (hash.startsWith('hypercite_')) pinHypercite(hash);
            // If hash took priority but a hyperlight/footnote exists from the path,
            // send it as fallback so the backend loads the right chunk if hash target is stale
            if (OpenHyperlightID) {
                params.set('fallback_target', OpenHyperlightID);
            } else if (OpenFootnoteID) {
                params.set('fallback_target', OpenFootnoteID);
            }
            return params;
        }
        // Numeric hash = element ID (startLine)
        if (/^\d+(\.\d+)?$/.test(hash)) {
            params.set('element_id', hash);
            return params;
        }
    }

    // Priority 2: OpenHyperlightID from URL path
    if (OpenHyperlightID) {
        params.set('target', OpenHyperlightID);
        return params;
    }

    // Priority 3: OpenFootnoteID from URL path (footnote IDs contain _Fn)
    if (OpenFootnoteID) {
        params.set('target', OpenFootnoteID);
        return params;
    }

    // Priority 4: Resume from saved position
    params.set('resume', 'true');
    return params;
}

/**
 * Inject gate filter + pinned-hypercite params into a URLSearchParams (mutates in place).
 * Pinned rides independently of gate settings (fresh users have no stored gate but a
 * followed deep link must still be exempted server-side).
 */
function injectGateParam(params: URLSearchParams) {
    const gp = gateQueryParam();
    if (gp) {
        // gp is "gate=..." — extract the value part
        const val = gp.substring(5); // skip "gate="
        params.set('gate', decodeURIComponent(val));
    }
    const pinned = getPinnedHyperciteIds();
    if (pinned.length > 0) {
        params.set('pinned', pinned.join(','));
    }
    return params;
}

/**
 * Determine the bootstrap navigation target from URL hash / SPA globals / path params.
 * Returns { target, fallbackTarget } instead of URLSearchParams.
 * Does NOT consume the SPA globals — buildInitialChunkParams (used by the server path) does that.
 */
export function resolveBootstrapTarget() {
    // Priority 0: SPA navigation target
    const spaTarget = (window as any)._pendingChunkTarget;
    const spaFallback = (window as any)._pendingChunkFallbackTarget;
    if (spaTarget) {
        return { target: spaTarget, fallbackTarget: spaFallback || null };
    }

    // Priority 1: URL hash target
    const hash = window.location.hash?.substring(1);
    if (hash) {
        let fallbackTarget = null;
        if (hash.startsWith('hypercite_') || hash.startsWith('HL_') || /(^|_)Fn\d/.test(hash)) {
            if (OpenHyperlightID) fallbackTarget = OpenHyperlightID;
            else if (OpenFootnoteID) fallbackTarget = OpenFootnoteID;
        }
        return { target: hash, fallbackTarget };
    }

    // Priority 2: OpenHyperlightID from URL path
    if (OpenHyperlightID) {
        return { target: OpenHyperlightID, fallbackTarget: null };
    }

    // Priority 3: OpenFootnoteID from URL path
    if (OpenFootnoteID) {
        return { target: OpenFootnoteID, fallbackTarget: null };
    }

    // Priority 4: No explicit target — resolver will handle resume/default
    return { target: null, fallbackTarget: null };
}

/**
 * Handle error responses matching the existing pattern in indexedDB/serverSync.
 */
async function handleErrorResponse(response: Response, bookId: string): Promise<any> {
    if (response.status === 404) {
        return { success: false, reason: 'book_not_found' };
    }
    if (response.status === 410) {
        const { handleDeletedBookAccess } = await import('./accessGuards');
        await handleDeletedBookAccess(bookId);
        return { success: false, reason: 'book_deleted' };
    }
    if (response.status === 403) {
        const { handlePrivateBookAccessDenied } = await import('./accessGuards');
        await handlePrivateBookAccessDenied(bookId);
        return { success: false, reason: 'access_denied' };
    }
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
}

/**
 * Inline footnote loader — mirrors indexedDB/serverSync loadFootnotesToIndexedDB
 * (that function is not exported, so we replicate it here).
 */
async function loadFootnotesToIndexedDB(db: any, footnotes: any) {
    if (!footnotes || !footnotes.data) {
        return;
    }

    const footnotesData = footnotes.data;
    const records: any[] = [];

    for (const [footnoteId, footnoteData] of Object.entries(footnotesData) as [string, any][]) {
        const isNewFormat = typeof footnoteData === 'object' && footnoteData !== null;
        records.push({
            book: footnotes.book,
            footnoteId: footnoteId,
            content: isNewFormat ? (footnoteData.content ?? '') : footnoteData,
            preview_nodes: isNewFormat ? (footnoteData.preview_nodes ?? null) : null,
        });
    }

    // E2EE seam (docs/e2ee.md): decrypt BEFORE opening the write transaction.
    const { rowHasEnvelopes, decryptRows } = await import('../e2ee/transform');
    const finalRecords = records.some((r) => rowHasEnvelopes('footnotes', r))
        ? await decryptRows('footnotes', records)
        : records;

    const tx = db.transaction('footnotes', 'readwrite');
    const store = tx.objectStore('footnotes');
    const promises = finalRecords.map((record) => new Promise<void>((resolve, reject) => {
        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    }));

    await Promise.all(promises);
}
