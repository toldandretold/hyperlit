/**
 * serverSync/pull — fetch a book (or just its annotations) from the Laravel
 * API and hydrate the IndexedDB stores. The pull-side counterpart to
 * syncQueue (push). Split out of the former resources/js/postgreSQL.js.
 *
 * Access-control UI (private/deleted book modals) is delegated out via dynamic
 * import — those handlers live in the page-load layer, not the data layer.
 */
import { openDatabase } from '../index';
import { verbose } from '../../utilities/logger';
import { flushAllPendingEdits } from './flush';
import {
  clearBookDataFromIndexedDB,
  clearAnnotationsFromIndexedDB,
  updateEmbeddedAnnotationsInNodes,
} from './clear';
import {
  loadNodesToIndexedDB,
  loadFootnotesToIndexedDB,
  loadBibliographyToIndexedDB,
  loadHyperlightsToIndexedDB,
  loadHypercitesToIndexedDB,
  loadLibraryToIndexedDB,
} from './loaders';
import type { BookDataResponse, AnnotationsResponse, PullResult, ServerNodeRow } from './types';

/**
 * Sync complete book data from Laravel API to IndexedDB
 */
export async function syncBookDataFromDatabase(bookId: string): Promise<PullResult> {
  verbose.content(`Starting database sync for: ${bookId}`, 'serverSync/pull');

  try {
    // 1. Fetch data from Laravel API
    verbose.content('Making API request', 'serverSync/pull');

    // Include gate filter as query param so server-side annotation filtering matches client
    const { appendGateParam } = await import('../../components/utilities/gateFilter');
    const response = await fetch(appendGateParam(`/api/database-to-indexeddb/books/${bookId}/data`));

    verbose.content(`API response received: ${response.status}`, 'serverSync/pull');

    if (!response.ok) {
      if (response.status === 404) {
        verbose.content(`Book "${bookId}" not found in database - this is normal for new books`, 'serverSync/pull');
        return { success: false, reason: 'book_not_found' };
      }

      // 🗑️ Handle deleted book
      if (response.status === 410) {
        const errorData = await response.json() as BookDataResponse;
        verbose.content(`Book "${bookId}" has been deleted`, 'serverSync/pull');

        if (errorData.error === 'book_deleted') {
          const { handleDeletedBookAccess } = await import('../../pageLoad/accessGuards');
          await handleDeletedBookAccess(bookId);
          return { success: false, reason: 'book_deleted' };
        }
      }

      // 🔒 Handle private book access denied
      if (response.status === 403) {
        const errorData = await response.json() as BookDataResponse;
        verbose.content(`Access denied to book "${bookId}"`, 'serverSync/pull');

        if (errorData.error === 'access_denied') {
          // Import handlePrivateBookAccessDenied function
          const { handlePrivateBookAccessDenied } = await import('../../pageLoad/accessGuards');
          await handlePrivateBookAccessDenied(bookId);
          return { success: false, reason: 'access_denied' };
        }
      }

      const errorText = await response.text();
      console.error(`❌ API request failed:`, {
        status: response.status,
        statusText: response.statusText,
        errorText
      });
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as BookDataResponse;
    verbose.content(`Data received: ${data.nodes?.length || 0} nodes, ${data.hyperlights?.length || 0} highlights`, 'serverSync/pull');

    // 2. Open IndexedDB
    verbose.content('Opening IndexedDB', 'serverSync/pull');
    const db = await openDatabase();

    // 2.5 Flush any pending edits to the server before clearing
    await flushAllPendingEdits();

    // 3. Clear existing data for this book
    verbose.content('Clearing existing data for this book', 'serverSync/pull');
    await clearBookDataFromIndexedDB(db, bookId);

    // 4. Load all data types into IndexedDB
    verbose.content('Loading all data types into IndexedDB', 'serverSync/pull');
    const loadResults = await Promise.allSettled([
      loadNodesToIndexedDB(db, data.nodes),
      loadFootnotesToIndexedDB(db, data.footnotes),
      loadBibliographyToIndexedDB(db, data.bibliography),
      loadHyperlightsToIndexedDB(db, data.hyperlights),
      loadHypercitesToIndexedDB(db, data.hypercites),
      loadLibraryToIndexedDB(db, data.library)
    ]);

    // Log results of each load operation
    const loadTypes = ['nodes', 'footnotes', 'bibliography', 'hyperlights', 'hypercites', 'library'];
    loadResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`❌ ${loadTypes[index]} failed to load:`, result.reason);
      }
    });

    // Check if any loads failed
    const failures = loadResults.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`❌ ${failures.length} data types failed to load`, failures);
      throw new Error(`Failed to load ${failures.length} data types into IndexedDB`);
    }

    verbose.content('Database sync completed', 'serverSync/pull');

    return {
      success: true,
      metadata: data.metadata,
      reason: 'synced_from_database',
      loaded_counts: {
        nodes: data.nodes?.length || 0,
        hyperlights: data.hyperlights?.length || 0,
        hypercites: data.hypercites?.length || 0
      }
    };

  } catch (error) {
    const err = error as Error;
    console.error("❌ Database sync failed:", {
      bookId,
      error: err.message,
      stack: err.stack
    });
    return {
      success: false,
      error: err.message,
      reason: 'sync_error'
    };
  }
}

/**
 * Fetch a book's CURRENT server nodes WITHOUT touching IndexedDB.
 *
 * Read-only sibling of syncBookDataFromDatabase for the lost-ACK self-conflict
 * check (syncQueue/selfConflictContentCheck): on a 409 we need the server's
 * present content for the conflicting nodes to compare against what we tried to
 * write — but we must NOT hydrate the stores (that would clobber the local edit
 * before we've decided whether to keep it). So this does ONLY the fetch, mirroring
 * the request in syncBookDataFromDatabase (same endpoint, same gate param, same
 * sub-book id handling — the id, slashes and all, goes straight into the path).
 *
 * Returns raw ServerNodeRow[] (E2EE `content` still enveloped — the caller decrypts
 * via e2ee/transform.decryptRows). Throws on network/HTTP failure so the caller can
 * treat "couldn't verify" as "don't silently recover".
 */
export async function fetchServerNodesRaw(bookId: string): Promise<ServerNodeRow[]> {
  const { appendGateParam } = await import('../../components/utilities/gateFilter');
  const response = await fetch(appendGateParam(`/api/database-to-indexeddb/books/${bookId}/data`));
  if (!response.ok) {
    throw new Error(`fetchServerNodesRaw: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as BookDataResponse;
  return data.nodes ?? [];
}

/**
 * Sync only annotations (hyperlights/hypercites) from Laravel API to IndexedDB.
 * Used when only annotations have changed, not book content (nodes).
 */
export async function syncAnnotationsOnly(bookId: string): Promise<PullResult> {
  verbose.content(`Starting annotations-only sync for: ${bookId}`, 'serverSync/pull');

  try {
    // 1. Fetch only annotations (not the full book with all nodes)
    // Include gate filter as query param so server applies it immediately
    // (avoids race with async preference save, works for anonymous users)
    const { appendGateParam } = await import('../../components/utilities/gateFilter');
    // Slash-split nested sub-book ids (book_x/Fn_y/HL_z) onto the two-segment route — a plain
    // /books/${bookId}/annotations 404'd for EVERY nested sub-book (only the single-segment route
    // existed server-side; Laravel params don't match "/"). The literal is built inline here — in
    // the SAME function as the fetch — on purpose: the flow-map generator detects endpoints by
    // scanning a fetch fn's own body for `/api/…` literals and only resolves URL-builder helpers in
    // the SAME module, so a cross-module helper would hide this endpoint (flowViz.generate.test.js).
    const annId = String(bookId);
    const annSlash = annId.indexOf('/');
    const annotationsUrl = annSlash !== -1
      ? `/api/database-to-indexeddb/books/${annId.substring(0, annSlash)}/${annId.substring(annSlash + 1)}/annotations`
      : `/api/database-to-indexeddb/books/${annId}/annotations`;
    const response = await fetch(appendGateParam(annotationsUrl));

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as AnnotationsResponse;
    verbose.content(`Annotations received: ${data.hyperlights?.length || 0} highlights, ${data.hypercites?.length || 0} hypercites`, 'serverSync/pull');

    // 2. Open IndexedDB
    const db = await openDatabase();

    // 2.5 Flush any pending edits to the server before clearing
    await flushAllPendingEdits();

    // 3. Clear only annotations for this book (not nodes)
    await clearAnnotationsFromIndexedDB(db, bookId);

    // 4. Load only annotations into IndexedDB (standalone stores)
    const loadResults = await Promise.allSettled([
      loadHyperlightsToIndexedDB(db, data.hyperlights),
      loadHypercitesToIndexedDB(db, data.hypercites),
    ]);

    // Check if any loads failed
    const failures = loadResults.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`❌ ${failures.length} annotation types failed to load`, failures);
      throw new Error(`Failed to load annotations into IndexedDB`);
    }

    // 5. Update embedded hyperlights/hypercites within nodes store
    // This is critical because lazyLoader renders using node.hyperlights, not standalone store.
    // data.hyperlights/hypercites arrive GATE-FILTERED server-side (getHyperlights/getHypercites
    // apply gate + singles filtering; pinned deep-link targets ride the pinned= param), so the
    // embedded rebuild here inherits exactly the filtered set.
    await updateEmbeddedAnnotationsInNodes(db, bookId, data.hyperlights, data.hypercites);

    verbose.content('Annotations-only sync completed', 'serverSync/pull');

    return {
      success: true,
      reason: 'annotations_synced',
      loaded_counts: {
        hyperlights: data.hyperlights?.length || 0,
        hypercites: data.hypercites?.length || 0
      }
    };

  } catch (error) {
    const err = error as Error;
    console.error("❌ Annotations sync failed:", {
      bookId,
      error: err.message,
      stack: err.stack
    });
    return {
      success: false,
      error: err.message,
      reason: 'sync_error'
    };
  }
}
