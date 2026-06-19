/**
 * serverSync/push — push IndexedDB state up to the server (Laravel API).
 *
 * Used after new-book creation to persist the locally-seeded data. Split out
 * of the former resources/js/postgreSQL.js.
 */
import { DB_VERSION } from '../core/connection';
import { verbose } from '../../utilities/logger';

/** Per-store push configuration (endpoint + the IDB key range to read). */
interface StoreConfig {
  endpoint: string;
  keyRange: IDBKeyRange;
  useCompositeKey: boolean;
}

/** A stored record viewed through only the fields the push path reads. */
interface PushRecordView {
  book?: string;
  chunk_id?: number;
  startLine?: number;
}

async function syncBookDataToServer(bookName: string, objectStoreName: string, method = 'upsert'): Promise<unknown> {
    const storeConfig: Record<string, StoreConfig> = {
        nodes: {
            endpoint: `/api/db/nodes/${method}`,
            keyRange: IDBKeyRange.bound([bookName, 0], [bookName, Number.MAX_VALUE]),
            useCompositeKey: true
        },
        hyperlights: {
            endpoint: `/api/db/hyperlights/${method}`,
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        hypercites: {
            endpoint: `/api/db/hypercites/${method}`,
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        library: {
            endpoint: `/api/db/library/${method}`,
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        },
        footnotes: {
            endpoint: `/api/db/footnotes/${method}`,
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        }
    };

    const config = storeConfig[objectStoreName];
    if (!config) {
        throw new Error(`syncBookDataToServer: unknown object store "${objectStoreName}"`);
    }

    verbose.content(`Sync attempt for ${objectStoreName} from window/tab ${window.name || 'unnamed'}`, 'serverSync/push');

    try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        const tx = db.transaction([objectStoreName], "readonly");
        const store = tx.objectStore(objectStoreName);

        // Get all data first
        const allData = await new Promise<PushRecordView[]>((resolve) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
        });

        verbose.content(`${objectStoreName} total records: ${allData.length}`, 'serverSync/push');

        // Try both book ID formats
        const bookNameWithoutSlash = bookName.replace('/', '');
        const bookNameWithSlash = bookName.startsWith('/') ? bookName : `/${bookName}`;

        // Filter for this book (checking both formats)
        let bookData: PushRecordView | PushRecordView[] | undefined;
        if (objectStoreName === 'library' || objectStoreName === 'footnotes') {
            bookData = await new Promise<PushRecordView | undefined>((resolve) => {
                const request = store.get(bookNameWithoutSlash);
                request.onsuccess = () => {
                    if (request.result) {
                        resolve(request.result);
                    } else {
                        const request2 = store.get(bookNameWithSlash);
                        request2.onsuccess = () => resolve(request2.result);
                    }
                };
            });
        } else {
            bookData = allData.filter((item) =>
                item.book === bookNameWithoutSlash ||
                item.book === bookNameWithSlash
            );
        }

        verbose.content(`${objectStoreName} data found: ${bookData ? JSON.stringify(bookData).substring(0, 100) + '...' : 'none'}`, 'serverSync/push');

        // If no data, return early
        if (!bookData || (Array.isArray(bookData) && bookData.length === 0)) {
            verbose.content(`No ${objectStoreName} data found for ${bookName}`, 'serverSync/push');
            return {
                status: 'success',
                message: `No ${objectStoreName} data to sync`
            };
        }

        // ⚠️ CRITICAL SAFETY CHECK for nodes: Abort if IndexedDB appears incomplete
        // This prevents mass deletion when IndexedDB was cleared mid-session
        if (objectStoreName === 'nodes' && Array.isArray(bookData)) {
            const isNum = (v: number | undefined): v is number => v != null;
            const chunkIds = [...new Set(bookData.map((n) => n.chunk_id).filter(isNum))].sort((a, b) => a - b);
            const hasChunk0 = chunkIds.includes(0);
            const startLines = bookData.map((n) => n.startLine).filter(isNum);
            const minStartLine = Math.min(...startLines);
            const maxStartLine = Math.max(...startLines);

            console.warn(`⚠️ FULL BOOK SYNC (syncBookDataToServer) DIAGNOSTIC:`, {
                nodeCount: bookData.length,
                chunkIds,
                hasChunk0,
                minStartLine,
                maxStartLine,
                bookName,
                timestamp: Date.now()
            });

            // Abort if missing chunk 0 (first chunk should always exist)
            if (bookData.length > 0 && !hasChunk0 && chunkIds.length > 0) {
                console.error(`🚨 ABORTING FULL BOOK SYNC: IndexedDB missing chunk 0!`, {
                    stack: new Error().stack,
                    chunkIds,
                    nodeCount: bookData.length,
                    lowestStartLine: minStartLine
                });
                throw new Error(`Full book sync aborted: IndexedDB appears incomplete (missing chunk 0). This may indicate IndexedDB was cleared mid-session.`);
            }

            // Warn if suspiciously few nodes
            if (bookData.length < 10 && bookData.length > 0) {
                console.warn(`⚠️ SUSPICIOUS: Only ${bookData.length} nodes in IndexedDB for full sync - potential data loss risk`);
            }
        }

        // Normalize the book ID format for sending to server
        const normalizedBookName = bookNameWithoutSlash;

        // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
        const requestBody = {
            book: normalizedBookName,
            data: bookData
        };

        verbose.content(`Sending ${objectStoreName} data to server`, 'serverSync/push');

        // Send to server - credentials: 'include' ensures cookies are sent
        const response = await fetch(config.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement).content
            },
            credentials: 'include', // This sends the anon_token cookie
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Server error for ${objectStoreName}:`, errorText);
            throw new Error(errorText);
        }

        const result: unknown = await response.json();
        verbose.content(`Success syncing ${objectStoreName}`, 'serverSync/push');
        return result;

    } catch (error) {
        console.error(`❌ Error syncing ${objectStoreName}:`, error);
        throw error;
    }
}

// get data from indexedDB, and send to backend for update
export async function syncIndexedDBtoPostgreSQL(bookName: string): Promise<unknown> {
  try {
    const results = await syncAllBookData(bookName); // Fixed parameter
    console.log("Sync succeeded:", results);
    return results;
  } catch (error) {
    console.error("Sync failed completely:", error);
    throw error; // Propagate error
  }
}

async function syncAllBookData(bookName: string): Promise<unknown> {
  verbose.content(`Starting sync for ${bookName}`, 'serverSync/push');

  // 1) Upsert the library row first
  const libResult = await syncBookDataToServer(bookName, 'library');

  // 2) Once library exists, fire off the rest
  const [nc, hl, hc, fn] = await Promise.all([
    syncBookDataToServer(bookName, 'nodes'),
    syncBookDataToServer(bookName, 'hyperlights'),
    syncBookDataToServer(bookName, 'hypercites'),
    syncBookDataToServer(bookName, 'footnotes'),
  ]);

  verbose.content('All syncs completed', 'serverSync/push');

  return { libResult, nc, hl, hc, fn };
}
