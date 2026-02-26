/**
 * Sub-Book Loader
 * Handles loading and rendering of sub-books (hyperlight annotations / footnotes)
 * within the hyperlit container's scroller div.
 */

import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed, createChunkElement } from '../lazyLoaderFactory.js';
import { attachMarkListeners } from '../hyperlights/index.js';
import { getNodeChunksFromIndexedDB, addNodeChunkToIndexedDB } from '../indexedDB/index.js';
import { lazyLoaders } from '../initializePage.js';
import { generateNodeId } from '../utilities/IDfunctions.js';

/**
 * Insert bottom sentinel to activate lazy loading for remaining chunks.
 * Called when user clicks "[read more]" button.
 */
function insertBottomSentinel(loader) {
  const container = loader.container;
  const uniqueId = container.getAttribute('data-book-id') || Math.random().toString(36).substr(2, 5);
  
  // Create bottom sentinel
  const bottomSentinel = document.createElement("div");
  bottomSentinel.id = `${uniqueId}-bottom-sentinel`;
  bottomSentinel.classList.add("sentinel");
  bottomSentinel.contentEditable = "false";
  bottomSentinel.style.userSelect = "none";
  
  // Append to container
  container.appendChild(bottomSentinel);
  
  // Observe the new sentinel
  if (loader.observer) {
    loader.observer.observe(bottomSentinel);
    console.log(`👁️ Bottom sentinel inserted and observed for "${uniqueId}"`);
  } else {
    console.warn(`⚠️ No observer found for loader, sentinel may not trigger lazy loading`);
  }
  
  // Store reference on loader instance
  loader.bottomSentinel = bottomSentinel;
}

/**
 * Add "[read more]" button after content if there are more nodes beyond the preview.
 * Button click will create lazy loader and activate full lazy loading.
 * 
 * @param {string} subBookId - The sub-book ID
 * @param {HTMLElement} container - The container div
 * @param {Array} previewNodeIds - Array of preview node IDs
 * @param {HTMLElement} scrollerDiv - The scroller element
 * @param {number} totalNodes - Total number of nodes available
 */
function addReadMoreButton(subBookId, container, previewNodeIds, scrollerDiv, totalNodes) {
  console.log(`📊 Checking for [read more] button: ${previewNodeIds.length} preview nodes, ${totalNodes} total nodes`);
  
  // Check if button already exists
  if (container.querySelector('.expand-sub-book')) {
    console.log(`ℹ️ [read more] button already exists, skipping`);
    return;
  }
  
  // Find the last chunk element
  const chunks = container.querySelectorAll('[data-chunk-id]');
  if (chunks.length === 0) {
    console.warn(`⚠️ No chunks found to attach [read more] button`);
    return;
  }
  
  const lastChunk = chunks[chunks.length - 1];
  
  // Create the read more button
  const readMoreButton = document.createElement('a');
  readMoreButton.className = 'expand-sub-book';
  readMoreButton.textContent = '[read more]';
  readMoreButton.href = '#';
  readMoreButton.style.cursor = 'pointer';
  readMoreButton.style.display = 'inline-block';
  readMoreButton.style.marginTop = '0.5em';
  readMoreButton.style.marginBottom = '0.5em';
  
  // Add click handler
  readMoreButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log(`📖 User clicked [read more] for sub-book "${subBookId}"`);
    
    // Remove the button immediately for visual feedback
    readMoreButton.remove();
    
    // Get the current state
    const subBookState = subBookLoaders.get(subBookId);
    if (!subBookState || !subBookState.loader) {
      console.warn(`⚠️ Sub-book loader not found for "${subBookId}"`);
      return;
    }
    
    const loader = subBookState.loader;
    
    // Get fresh full nodes from IndexedDB
    const freshNodes = await getNodeChunksFromIndexedDB(subBookId);
    if (!freshNodes?.length) {
      console.warn(`⚠️ No nodes found in IndexedDB for "${subBookId}"`);
      return;
    }
    
    console.log(`📥 Loaded ${freshNodes.length} full nodes from IndexedDB`);
    
    // Update loader with full nodes
    loader.nodes = freshNodes;
    loader.previewNodeIds = null; // Clear preview restriction
    
    // Clear currently loaded chunks to start fresh
    loader.currentlyLoadedChunks.clear();
    
    // Clear preview content
    console.log(`🧹 Clearing preview content for full lazy load`);
    container.innerHTML = '';
    
    // Insert bottom sentinel to activate lazy loading
    console.log(`🚀 Inserting bottom sentinel to activate lazy loading`);
    insertBottomSentinel(loader);
    
    // Start loading from chunk 0
    const firstChunkId = freshNodes[0]?.chunk_id ?? 0;
    console.log(`📥 Starting lazy load from chunk ${firstChunkId}`);
    await loader.loadChunk(firstChunkId, 'down');
    
    console.log(`✅ Lazy loading activated for "${subBookId}" - full content loading`);
  });
  
  // Insert button after the last chunk
  lastChunk.insertAdjacentElement('afterend', readMoreButton);
  
  console.log(`✅ Added [read more] button (${previewNodeIds.length}/${totalNodes} nodes previewed)`);
}

/**
 * Hydrate preview nodes with fresh hyperlights/hypercites data.
 * Re-renders chunk content with updated preview nodes (with hyperlights).
 * 
 * @param {Object} subBookState - The sub-book state object
 * @param {Array} previewNodeIds - Array of preview node IDs to hydrate
 * @param {Array} freshNodes - Fresh node data from IndexedDB (includes hyperlights/hypercites)
 */
async function hydratePreviewNodes(subBookState, previewNodeIds, freshNodes) {
  const container = subBookState.containerDiv;
  
  if (previewNodeIds.length === 0) {
    console.warn(`⚠️ No preview node IDs stored, cannot hydrate preview nodes`);
    return;
  }
  
  console.log(`🔄 Hydrating ${previewNodeIds.length} preview nodes with fresh hyperlights`);
  
  // Get fresh data for ONLY the preview nodes
  const previewNodes = freshNodes.filter(n => previewNodeIds.includes(n.node_id));
  
  if (previewNodes.length === 0) {
    console.warn(`⚠️ No preview nodes found in fresh data, skipping hydration`);
    return;
  }
  
  // Group by chunk ID
  const nodesByChunk = {};
  previewNodes.forEach(node => {
    if (!nodesByChunk[node.chunk_id]) {
      nodesByChunk[node.chunk_id] = [];
    }
    nodesByChunk[node.chunk_id].push(node);
  });
  
  // Re-render each chunk with fresh hyperlights/hypercites
  for (const [chunkId, chunkNodes] of Object.entries(nodesByChunk)) {
    const chunkEl = container.querySelector(`[data-chunk-id="${chunkId}"]`);
    if (!chunkEl) {
      console.warn(`⚠️ No chunk element found for chunk ${chunkId}`);
      continue;
    }
    
    // Create new chunk element with fresh data
    const newChunkEl = createChunkElement(chunkNodes, { bookId: subBookState.bookId });
    
    if (newChunkEl) {
      // Preserve height to prevent layout shift during re-render
      const originalHeight = chunkEl.offsetHeight;
      chunkEl.style.height = originalHeight + 'px';
      chunkEl.style.minHeight = originalHeight + 'px';
      
      // Replace content in-place (preserving the chunk wrapper)
      chunkEl.innerHTML = newChunkEl.innerHTML;
      
      // Re-attach listeners to the updated content
      attachMarkListeners(chunkEl);
      
      // Release height constraints after DOM settles
      requestAnimationFrame(() => {
        chunkEl.style.height = '';
        chunkEl.style.minHeight = '';
      });
      
      console.log(`✅ Hydrated chunk ${chunkId} with ${chunkNodes.length} preview nodes (with hyperlights)`);
    }
  }
  
  // Update stored nodes
  subBookState.nodes = freshNodes;
}

/** Map of subBookId -> { loader, containerDiv } for all currently-active sub-books. */
export const subBookLoaders = new Map();

/** Sub-books fully synced from the DB this session — skip re-fetch on repeated opens. */
const enrichedSubBooks = new Set();

async function enrichSubBookFromDB(subBookId, subBookState) {
  if (enrichedSubBooks.has(subBookId)) return;
  enrichedSubBooks.add(subBookId);

  try {
    // ── Timestamp guard (same pattern as checkAndUpdateIfNeeded in initializePage.js) ──
    const { getLibraryRecordFromServer, getLibraryObjectFromIndexedDB } = await import('../indexedDB/core/library.js');

    const [serverRecord, localRecord] = await Promise.all([
      getLibraryRecordFromServer(subBookId),
      getLibraryObjectFromIndexedDB(subBookId),
    ]);

    const serverTimestamp = serverRecord?.timestamp || 0;
    const localTimestamp  = localRecord?.timestamp  || 0;

    console.log(`🔍 Sub-book timestamp check for "${subBookId}":`, {
      serverTimestamp, localTimestamp,
      serverNewer: serverTimestamp > localTimestamp
    });

    // If no server record, or local is same/newer → skip destructive sync
    if (!serverRecord || serverTimestamp <= localTimestamp) {
      console.log(`⏳ Sub-book "${subBookId}": local is up-to-date, skipping server sync`);
      return;
    }

    // Server is newer → proceed with destructive sync
    console.log(`🔥 Sub-book "${subBookId}": server is newer, syncing...`);
    const { syncBookDataFromDatabase } = await import('../postgreSQL.js');
    const result = await syncBookDataFromDatabase(subBookId);

    // Only process if the sub-book is still mounted (user hasn't closed the container)
    if (result.success && subBookLoaders.has(subBookId)) {
      // Get fresh data from IndexedDB (includes hyperlights/hypercites)
      const freshNodes = await getNodeChunksFromIndexedDB(subBookId);
      const previewNodeIds = subBookState.previewNodeIds || [];

      console.log(`📚 Enrichment complete: ${freshNodes.length} total nodes, ${previewNodeIds.length} were previewed`);

      // Hydrate preview nodes with fresh hyperlights/hypercites data
      await hydratePreviewNodes(subBookState, previewNodeIds, freshNodes);

      // Update state with fresh data
      subBookState.nodes = freshNodes;

      // Check if there's more content than we previewed
      if (freshNodes.length > previewNodeIds.length && !subBookState.hasMoreContent) {
        console.log(`📊 More content available: ${freshNodes.length} > ${previewNodeIds.length}`);
        subBookState.hasMoreContent = true;

        // Add [read more] button if not already present
        addReadMoreButton(subBookId, subBookState.containerDiv, previewNodeIds, subBookState.scrollerDiv, freshNodes.length);
      }

      console.log(`✅ subBookLoader: Enriched and hydrated "${subBookId}" with ${freshNodes.length} nodes`);
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
 * @param {string} [options.mode='read']         - 'read' (preview mode) | 'create' | 'edit' (full lazy loader)
 * @returns {Promise<object|null>}  - The lazy loader instance, or null on failure
 */
export async function loadSubBook(
  subBookId, parentBook, itemId, type, scrollerDiv,
  { annotationHtml = '', previewNodes = null, targetElement = null, mode = 'read' } = {}
) {
  // Clean up any prior instance
  destroySubBook(subBookId);

  // 1. Fetch nodes: previewNodes → IndexedDB → create locally and write to IndexedDB
  // NOTE: We always use previewNodes for initial load to ensure lazy loading works correctly.
  // The full nodes from IndexedDB will be available after async enrichment.
  let nodes = null;
  let isNewSubBook = false;

  if (previewNodes?.length) {
    console.log(`📥 subBookLoader: Using preview nodes for "${subBookId}" (lazy loading mode)`);
    nodes = previewNodes;
  } else {
    // Check if full nodes exist in IndexedDB
    const existingNodes = await getNodeChunksFromIndexedDB(subBookId);
    
    if (existingNodes?.length) {
      // We have full nodes, but still need preview nodes for lazy loading
      // Extract first 5 nodes as preview
      console.log(`📥 subBookLoader: Using first 5 nodes from ${existingNodes.length} existing nodes for "${subBookId}"`);
      nodes = existingNodes.slice(0, 5);
    } else {
      // Nothing exists anywhere — synthesise a local node and register on backend
      isNewSubBook = true;
      const localNodeId = generateNodeId(subBookId);
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
    await createSubBookOnBackend(subBookId, parentBook, itemId, type, annotationHtml, firstLocalNodeId);
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

  // BRANCH: Create or Edit mode = full lazy loader (for paste, editing, etc.)
  if (mode === 'create' || mode === 'edit') {
    console.log(`📝 Loading sub-book "${subBookId}" in ${mode} mode with full lazy loader`);
    
    // Create lazy loader with full data for editing
    const loader = createLazyLoader({
      nodes,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: subBookId,
      containerElement: containerDiv,
      scrollableParent: scrollerDiv,
    });

    if (!loader) {
      console.error(`❌ subBookLoader: createLazyLoader returned null for "${subBookId}"`);
      containerDiv.innerHTML = '<p style="opacity:0.5;font-style:italic;">Failed to load content.</p>';
      subBookLoaders.set(subBookId, { loader: null, containerDiv });
      return null;
    }

    // Load all chunks (not just preview)
    const uniqueChunkIds = [...new Set(nodes.map(n => n.chunk_id))].sort((a, b) => a - b);
    console.log(`📥 subBookLoader: Loading ${uniqueChunkIds.length} chunk(s) for "${subBookId}" (${mode} mode)`);
    
    for (const chunkId of uniqueChunkIds) {
      await loader.loadChunk(chunkId, 'down');
    }

    // Register for cleanup
    subBookLoaders.set(subBookId, { loader, containerDiv });
    lazyLoaders[subBookId] = loader;

    // Async enrichment for new sub-books
    if (!isNewSubBook && mode === 'edit') {
      enrichSubBookFromDB(subBookId, { loader, containerDiv, previewNodeIds: [], scrollerDiv, hasMoreContent: true, nodes, bookId: subBookId });
    }

    console.log(`✅ subBookLoader: Sub-book "${subBookId}" loaded in ${mode} mode (${nodes.length} nodes)`);
    return loader;
  }

  // BRANCH: Read mode = preview mode WITH lazy loader (for highlighting, but 5 nodes only)
  console.log(`👁️ Loading sub-book "${subBookId}" in read mode (preview with lazy loader)`);
  
  // Get preview nodes (first 5)
  const firstFiveNodes = nodes.slice(0, 5);
  const previewNodeIds = firstFiveNodes.map(n => n.node_id);
  console.log(`📥 subBookLoader: Preparing ${firstFiveNodes.length} preview nodes for "${subBookId}"`);

  // Hydrate preview nodes with highlight marks from the normalized hyperlights store.
  // Preview nodes come from highlight.preview_nodes with empty hyperlights arrays —
  // rebuildNodeArrays queries the hyperlights store by node_id and populates them.
  const { rebuildNodeArrays } = await import('../indexedDB/hydration/rebuild.js');
  await rebuildNodeArrays(firstFiveNodes);

  // Create lazy loader with preview nodes only (not all nodes)
  // This enables highlighting while keeping load minimal
  const loader = createLazyLoader({
    nodes: firstFiveNodes,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: subBookId,
    containerElement: containerDiv,
    scrollableParent: scrollerDiv,
  });

  if (!loader) {
    console.error(`❌ subBookLoader: createLazyLoader returned null for "${subBookId}"`);
    containerDiv.innerHTML = '<p style="opacity:0.5;font-style:italic;">Failed to load content.</p>';
    subBookLoaders.set(subBookId, { loader: null, containerDiv });
    return null;
  }

  // Load only the chunk containing preview nodes
  const uniqueChunkIds = [...new Set(firstFiveNodes.map(n => n.chunk_id))].sort((a, b) => a - b);
  console.log(`📥 subBookLoader: Loading ${uniqueChunkIds.length} preview chunk(s) for "${subBookId}"`);
  
  for (const chunkId of uniqueChunkIds) {
    await loader.loadChunk(chunkId, 'down');
    
    // Re-render with ONLY preview nodes (not all nodes in the chunk)
    const chunkEl = containerDiv.querySelector(`[data-chunk-id="${chunkId}"]`);
    if (chunkEl) {
      const previewNodesInChunk = firstFiveNodes.filter(n => n.chunk_id === chunkId);
      if (previewNodesInChunk.length > 0) {
        console.log(`🔄 Re-rendering chunk ${chunkId} with ${previewNodesInChunk.length} preview nodes only`);
        const newChunkEl = createChunkElement(previewNodesInChunk, loader);
        if (newChunkEl) {
          // Preserve height to prevent layout shift
          const originalHeight = chunkEl.offsetHeight;
          chunkEl.style.height = originalHeight + 'px';
          chunkEl.style.minHeight = originalHeight + 'px';
          
          chunkEl.innerHTML = newChunkEl.innerHTML;
          attachMarkListeners(chunkEl);
          
          // Release height constraints
          requestAnimationFrame(() => {
            chunkEl.style.height = '';
            chunkEl.style.minHeight = '';
          });
        }
      }
    }
  }

  // Store preview node IDs on loader
  loader.previewNodeIds = previewNodeIds;
  console.log(`📍 Stored ${previewNodeIds.length} preview node IDs for "${subBookId}"`);
  
  // Remove bottom sentinel - we'll add it back when user clicks "[read more]"
  if (loader.bottomSentinel) {
    console.log(`🗑️ Removing bottom sentinel from sub-book "${subBookId}"`);
    loader.observer?.unobserve(loader.bottomSentinel);
    loader.bottomSentinel.remove();
    loader.bottomSentinel = null;
  }

  // Register for cleanup
  subBookLoaders.set(subBookId, { loader, containerDiv });
  lazyLoaders[subBookId] = loader;

  // Check if full nodes exist and add [read more] button
  const existingNodes = await getNodeChunksFromIndexedDB(subBookId);
  const totalAvailableNodes = existingNodes?.length || nodes.length;
  const hasMoreContent = totalAvailableNodes > firstFiveNodes.length;
  
  if (hasMoreContent) {
    addReadMoreButton(subBookId, containerDiv, previewNodeIds, scrollerDiv, totalAvailableNodes);
  }

  // If full nodes exist, hydrate with hyperlights immediately
  if (existingNodes?.length > 0) {
    console.log(`📚 Full data exists (${existingNodes.length} nodes) - hydrating preview with hyperlights`);
    loader.nodes = existingNodes;
    await hydratePreviewNodes({ loader, containerDiv, bookId: subBookId }, previewNodeIds, existingNodes);
  }

  // Async enrichment — fetch fresh data from backend
  if (!isNewSubBook) {
    enrichSubBookFromDB(subBookId, { loader, containerDiv, previewNodeIds, scrollerDiv, hasMoreContent, nodes: existingNodes || nodes, bookId: subBookId });
  }

  console.log(`✅ subBookLoader: Sub-book "${subBookId}" loaded in read mode (${firstFiveNodes.length}/${totalAvailableNodes} nodes, lazy loader active)`);
  return loader;
}

// ============================================================================
// STATE SAVE / RESTORE (for stack support)
// ============================================================================

/**
 * Snapshot the current subBookLoaders map so it can be restored later.
 */
export function saveSubBookState() {
  return new Map(subBookLoaders);
}

/**
 * Restore subBookLoaders from a snapshot.
 */
export function restoreSubBookState(saved) {
  if (!saved) return;
  subBookLoaders.clear();
  for (const [k, v] of saved) {
    subBookLoaders.set(k, v);
    if (v.loader) lazyLoaders[k] = v.loader;
  }
}

/**
 * Clear subBookLoaders and lazyLoaders entries without removing DOM elements.
 * Used when pushing a stacked layer — Level 1's DOM stays intact while
 * the module-level maps are reset for the fresh Level 2 layer.
 */
export function resetSubBookState() {
  for (const [id, entry] of subBookLoaders) {
    entry.loader?.disconnect();
    delete lazyLoaders[id];
  }
  subBookLoaders.clear();
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
