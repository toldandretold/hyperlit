/**
 * serverSync/pull — fetch a book (or just its annotations) from the Laravel
 * API and hydrate the IndexedDB stores. The pull-side counterpart to
 * syncQueue (push). Split out of the former resources/js/postgreSQL.js.
 *
 * Access-control UI (private/deleted book modals) is delegated out via dynamic
 * import — those handlers live in the page-load layer, not the data layer.
 */
import { openDatabase } from '../index';
import { log, verbose } from '../../utilities/logger';
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
import type { BookDataResponse, AnnotationsResponse, PullResult } from './types';

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

    log.content('Database sync completed', 'serverSync/pull');

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
    const response = await fetch(appendGateParam(`/api/database-to-indexeddb/books/${bookId}/annotations`));

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
    // This is critical because lazyLoader renders using node.hyperlights, not standalone store
    // We use the standalone hyperlights (data.hyperlights) because they're unfiltered
    await updateEmbeddedAnnotationsInNodes(db, bookId, data.hyperlights, data.hypercites);

    log.content('Annotations-only sync completed', 'serverSync/pull');

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
