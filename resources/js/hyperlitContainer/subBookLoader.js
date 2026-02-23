/**
 * Sub-Book Loader
 * Handles loading and rendering of sub-books (hyperlight annotations / footnotes)
 * within the hyperlit container's scroller div.
 */

import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from '../lazyLoaderFactory.js';
import { attachMarkListeners } from '../hyperlights/index.js';
import { getNodeChunksFromIndexedDB, addNodeChunkToIndexedDB } from '../indexedDB/index.js';
import { lazyLoaders } from '../initializePage.js';

/** Map of subBookId -> { loader, containerDiv } for all currently-active sub-books. */
export const subBookLoaders = new Map();

/** Sub-books fully synced from the DB this session — skip re-fetch on repeated opens. */
const enrichedSubBooks = new Set();

async function enrichSubBookFromDB(subBookId, loader) {
  if (enrichedSubBooks.has(subBookId)) return;
  enrichedSubBooks.add(subBookId);

  try {
    const { syncBookDataFromDatabase } = await import('../postgreSQL.js');
    const result = await syncBookDataFromDatabase(subBookId);

    // Only refresh if the loader is still mounted (user hasn't closed the container)
    if (result.success && subBookLoaders.has(subBookId)) {
      await loader.refresh();
      console.log(`✅ subBookLoader: Enriched and refreshed "${subBookId}"`);
    }
  } catch (err) {
    console.warn(`⚠️ subBookLoader: Async enrichment failed for "${subBookId}":`, err);
    enrichedSubBooks.delete(subBookId); // allow retry on next open
  }
}

/**
 * Fire-and-forget backend create/upsert call — does not block rendering.
 * Pass nodeId so the backend uses the same UUID we already wrote to IndexedDB.
 */
async function createSubBookOnBackend(subBookId, parentBook, itemId, type, annotationHtml, nodeId = null) {
  try {
    const xsrfToken = decodeURIComponent(
      document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || ''
    );
    const res = await fetch('/api/db/sub-books/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-XSRF-TOKEN': xsrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ type, parentBook, itemId, previewContent: annotationHtml, nodeId }),
    });
    const data = await res.json();
    return data.nodeId || null;
  } catch (err) {
    console.error('❌ subBookLoader: Failed to create/upsert sub-book on backend:', err);
    return null;
  }
}

/**
 * Render a sub-book (hyperlight annotation / footnote) into scrollerDiv via the lazy loader.
 * Safe to call repeatedly — destroys any prior instance for the same subBookId first.
 *
 * Node priority: IndexedDB → previewNodes param → synthesize from annotationHtml
 *
 * @param {string} subBookId        - Full sub-book ID e.g. "TheBible/HL_12345"
 * @param {string} parentBook       - Parent book ID e.g. "TheBible"
 * @param {string} itemId           - The hyperlight or footnote ID e.g. "HL_12345"
 * @param {string} type             - "hyperlight" or "footnote"
 * @param {HTMLElement} scrollerDiv - The .scroller element inside #hyperlit-container
 * @param {Object} [options]
 * @param {string} [options.annotationHtml='']   - Raw HTML fallback if no nodes exist yet
 * @param {Array|null} [options.previewNodes=null] - Preview nodes from IndexedDB record
 * @returns {Promise<object|null>}  - The lazy loader instance, or null on failure
 */
export async function loadSubBook(
  subBookId, parentBook, itemId, type, scrollerDiv,
  { annotationHtml = '', previewNodes = null, targetElement = null } = {}
) {
  // Clean up any prior instance
  destroySubBook(subBookId);

  // 1. Fetch nodes: IndexedDB → previewNodes → create locally and write to IndexedDB
  let nodes = await getNodeChunksFromIndexedDB(subBookId);
  let isNewSubBook = false;

  if (!nodes?.length) {
    if (previewNodes?.length) {
      console.log(`📥 subBookLoader: Using preview nodes for "${subBookId}"`);
      nodes = previewNodes;
    } else {
      // Nothing exists anywhere — synthesise a local node and register on backend
      isNewSubBook = true;
      const localNodeId = crypto.randomUUID();
      const strippedText = annotationHtml.replace(/<[^>]+>/g, '');
      const initialHtml = `<p data-node-id="${localNodeId}" no-delete-id="please" style="min-height:1.5em;">${strippedText}</p>`;
      await addNodeChunkToIndexedDB(subBookId, 1, initialHtml, 0, localNodeId);
      console.log(`📝 subBookLoader: Wrote initial node (${localNodeId}) to IndexedDB for "${subBookId}"`);
      nodes = await getNodeChunksFromIndexedDB(subBookId);
    }
  }

  // 2. Fire backend create ONLY for brand-new sub-books
  if (isNewSubBook) {
    const firstLocalNodeId = nodes[0]?.node_id ?? null;
    createSubBookOnBackend(subBookId, parentBook, itemId, type, annotationHtml, firstLocalNodeId);
  }

  // 3. Create the container div (no id — avoids "/" in HTML id attributes)
  const containerDiv = document.createElement('div');
  containerDiv.className = 'sub-book-content';
  containerDiv.setAttribute('data-book-id', subBookId);
  if (targetElement) {
    const hr = targetElement.querySelector('hr');
    hr ? targetElement.insertBefore(containerDiv, hr) : targetElement.appendChild(containerDiv);
  } else {
    scrollerDiv.appendChild(containerDiv);
  }

  if (!nodes?.length) {
    containerDiv.innerHTML = '<p style="min-height:1.5em;"></p>';
    subBookLoaders.set(subBookId, { loader: null, containerDiv });
    return null;
  }

  // 3. Create lazy loader — pass containerDiv directly + use .scroller as IntersectionObserver root
  const loader = createLazyLoader({
    nodes,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: subBookId,
    containerElement: containerDiv,  // bypass getElementById
    scrollableParent: scrollerDiv,   // IntersectionObserver root = .scroller
  });

  if (!loader) {
    console.error(`❌ subBookLoader: createLazyLoader returned null for "${subBookId}"`);
    containerDiv.innerHTML = '<p style="opacity:0.5;font-style:italic;">Failed to load content.</p>';
    subBookLoaders.set(subBookId, { loader: null, containerDiv });
    return null;
  }

  // 4. Load the first chunk
  const firstChunk = nodes.find(c => c.chunk_id === 0) ?? nodes[0];
  if (firstChunk) {
    await loader.loadChunk(firstChunk.chunk_id, 'down');
  }

  // 5. Register for cleanup
  subBookLoaders.set(subBookId, { loader, containerDiv });
  lazyLoaders[subBookId] = loader;

  // 6. Async enrichment — fetch full data into IndexedDB so marks and editors work correctly.
  //    Skip for brand-new sub-books (backend create hasn't completed yet).
  if (!isNewSubBook) {
    enrichSubBookFromDB(subBookId, loader); // intentionally not awaited
  }

  console.log(`✅ subBookLoader: Sub-book "${subBookId}" loaded (${nodes.length} nodes)`);
  return loader;
}

/**
 * Disconnect the lazy loader and remove the DOM element for a specific sub-book.
 * @param {string} subBookId
 */
export function destroySubBook(subBookId) {
  const entry = subBookLoaders.get(subBookId);
  if (!entry) return;

  entry.loader?.disconnect();
  entry.containerDiv?.remove();
  subBookLoaders.delete(subBookId);
  delete lazyLoaders[subBookId];

  console.log(`🧹 subBookLoader: Destroyed sub-book "${subBookId}"`);
}

/**
 * Destroy ALL currently-active sub-book loaders.
 * Called when the hyperlit container closes.
 */
export function destroyAllSubBooks() {
  for (const id of [...subBookLoaders.keys()]) {
    destroySubBook(id);
  }
}
