import { openDatabase, parseNodeId } from '../indexedDB/index';
import { verbose } from '../utilities/logger';
import { appendGateParam } from '../components/utilities/gateFilter';

/**
 * Fetch a single chunk from the server by chunk_id.
 * Used when the lazy loader needs a chunk that hasn't been downloaded yet.
 */
export async function fetchSingleChunkFromServer(bookId: string, chunkId: string | number): Promise<any[]> {
    try {
        const url = buildChunkUrl(bookId, chunkId);
        verbose.content(`Fetching chunk ${chunkId} from server: ${url}`, 'chunkFetcher.js');

        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`Failed to fetch chunk ${chunkId}: ${response.status}`);
            return [];
        }

        const data = await response.json();
        return data.nodes || [];
    } catch (error) {
        console.error(`Error fetching chunk ${chunkId}:`, error);
        return [];
    }
}

/**
 * Store a single chunk's nodes to IndexedDB using put() (upsert) semantics.
 */
export async function storeSingleChunkToIndexedDB(nodes: any[]): Promise<void> {
    if (!nodes || nodes.length === 0) return;

    const db = await openDatabase();

    const processedChunks = nodes.map((chunk) => ({
        ...chunk,
        startLine: parseNodeId(chunk.startLine),
        footnotes: typeof chunk.footnotes === 'string'
            ? (chunk.footnotes ? JSON.parse(chunk.footnotes) : null)
            : chunk.footnotes,
        hypercites: typeof chunk.hypercites === 'string'
            ? (chunk.hypercites ? JSON.parse(chunk.hypercites) : null)
            : chunk.hypercites,
        hyperlights: typeof chunk.hyperlights === 'string'
            ? (chunk.hyperlights ? JSON.parse(chunk.hyperlights) : null)
            : chunk.hyperlights,
        raw_json: typeof chunk.raw_json === 'string'
            ? (chunk.raw_json ? JSON.parse(chunk.raw_json) : null)
            : chunk.raw_json,
    }));

    // E2EE seam (docs/e2ee.md): decrypt BEFORE opening the write transaction
    // (an await inside an open tx auto-commits it). Server-rebuilt embedded
    // annotation views are unusable for encrypted books — blank them and
    // rebuild from the local (already decrypted) annotation stores.
    const { rowHasEnvelopes, decryptRows } = await import('../e2ee/transform');
    let finalChunks = processedChunks;
    if (processedChunks.some((c) => rowHasEnvelopes('nodes', c))) {
        finalChunks = await decryptRows('nodes', processedChunks);
        for (const chunk of finalChunks) {
            chunk.hyperlights = [];
            chunk.hypercites = [];
        }
        const { rebuildNodeArrays } = await import('../indexedDB/hydration/rebuild');
        await rebuildNodeArrays(finalChunks, { skipWrite: true });
    }

    const tx = db.transaction('nodes', 'readwrite');
    const store = tx.objectStore('nodes');
    for (const chunk of finalChunks) {
        store.put(chunk);
    }

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Build API URL for fetching a single chunk, handling sub-book IDs.
 */
function buildChunkUrl(bookId: string, chunkId: string | number): string {
    const slashIndex = bookId.indexOf('/');
    let url;
    if (slashIndex !== -1) {
        const parentBook = bookId.substring(0, slashIndex);
        const subId = bookId.substring(slashIndex + 1);
        url = `/api/database-to-indexeddb/books/${parentBook}/${subId}/initial?chunk_id=${chunkId}`;
    } else {
        url = `/api/database-to-indexeddb/books/${bookId}/chunk/${chunkId}`;
    }
    return appendGateParam(url);
}
