import { updateIndexedDBRecordForNormalization } from "../indexedDB/index.js";
import { getAllNodesForBook, renumberNodesInIndexedDB, clearPendingSyncsForBook, pendingSyncs, openDatabase } from "../indexedDB/index.js";
import { executeSyncPayload, updateHistoryLog, debouncedMasterSync } from "../indexedDB/syncQueue/master.js";
import { currentLazyLoader } from "../pageLoad/index";
import { book } from "../app";
import { glowCloudGreen, glowCloudRed, glowCloudLocalSave } from "../components/cloudRef/editIndicator";
import { ProgressOverlayConductor } from "../SPA/navigation/ProgressOverlayConductor.js";
import { verbose } from './logger';
import { ID_SKIP_TAGS } from './blockElements';

// Renumbering system: When IDs get crowded, renumber with 100-gaps
// Uses node_id as stable reference to preserve node identity

// Track if renumbering is in progress
let isRenumberingInProgress = false;
let renumberingPromise: any = null;

/**
 * Trigger renumbering with UI modal (non-blocking)
 */
export async function triggerRenumberingWithModal(delayMs = 100) {
  // Prevent multiple renumbering operations - return existing promise
  if (isRenumberingInProgress && renumberingPromise) {
    console.log('⏸️ Renumbering already in progress - returning existing promise');
    return renumberingPromise;
  }

  isRenumberingInProgress = true;

  // Set global flag IMMEDIATELY to prevent mutation processor from queuing new saves
  (window as any).renumberingInProgress = true;
  console.log('🔒 RENUMBERING: Mutation observer disabled (early)');

  // Create promise that resolves when renumbering completes
  renumberingPromise = (async () => {
    try {
      // Wait for specified delay to allow any in-flight RAF callbacks to complete
      // (they'll see the flag and skip processing)
      if (delayMs > 0) {
        console.log(`⏰ Waiting ${delayMs}ms for any pending RAF callbacks to settle...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      // Show progress overlay with custom message and block interactions
      ProgressOverlayConductor.showSPATransition(10, 'god damn vibe coders!', true);
      await renumberAllNodes();
      // renumberAllNodes() handles overlay hiding and flag reset on success
      return true;
    } catch (error) {
      console.error('❌ Renumbering failed:', error);
      await ProgressOverlayConductor.hide();
      (window as any).renumberingInProgress = false;
      isRenumberingInProgress = false;
      renumberingPromise = null;
      console.log('🔓 RENUMBERING: Mutation observer re-enabled (after error)');
      alert('Renumbering failed. Please try again.');
      throw error;
    }
  })();

  return renumberingPromise;
}

/**
 * Renumber all nodes in the current book with 100-unit gaps
 * Called when we'd be forced to create a decimal ID
 */
async function renumberAllNodes() {
  console.log('🔄 RENUMBERING: Starting system-wide ID renormalization');

  try {
    // 0. Flush all pending saves to IndexedDB first
    console.log('💾 Flushing all pending saves before renumbering...');
    const { flushAllPendingSaves, flushInputDebounce } = await import('../divEditor/index');
    flushInputDebounce();          // Capture any recent typing into SaveQueue
    await flushAllPendingSaves();  // Then flush SaveQueue → IndexedDB
    console.log('✅ All pending saves flushed to IndexedDB');

    // 0.5. CRITICAL: Also flush pending PostgreSQL syncs
    // This ensures all nodes exist in PostgreSQL before we try to update them
    // Otherwise, nodes that don't exist in PostgreSQL will cause startLine conflicts
    console.log('📤 Flushing pending PostgreSQL syncs...');
    if (pendingSyncs.size > 0) {
      console.log(`📤 ${pendingSyncs.size} pending syncs to flush`);
      await debouncedMasterSync.flush();
      console.log('✅ PostgreSQL sync flushed');
    } else {
      console.log('✅ No pending PostgreSQL syncs');
    }

    // 1. Get all nodes from IndexedDB
    const indexedDBNodes = await getAllNodesForBook(book);
    const indexedDBNodeIds = new Set((indexedDBNodes || []).map(n => n.node_id));
    // Map node_id → old chunk_id so we can detect chunk reassignments later
    const indexedDBNodeMap = new Map((indexedDBNodes || []).map(n => [n.node_id, n.chunk_id]));

    // 2. Find orphaned DOM elements (in DOM but not in IndexedDB)
    const allDomElements = document.querySelectorAll('[data-node-id]');
    const orphanedNodes: any[] = [];

    allDomElements.forEach(el => {
      const nodeId = el.getAttribute('data-node-id');
      if (!indexedDBNodeIds.has(nodeId)) {
        console.log(`📦 Including orphaned DOM node in renumbering: ${el.id} (${nodeId})`);
        orphanedNodes.push({
          node_id: nodeId,
          startLine: parseFloat(el.id) || 0,
          content: el.outerHTML,
          hyperlights: [],
          hypercites: [],
          footnotes: [],
          _domElement: el
        });
      }
    });

    if (orphanedNodes.length > 0) {
      console.log(`📦 Found ${orphanedNodes.length} orphaned DOM nodes to include in renumbering`);
    }

    // 3. Merge IndexedDB nodes with orphaned nodes, adding DOM references for sorting
    const allNodesWithDom = (indexedDBNodes || []).map(node => ({
      ...node,
      _domElement: document.querySelector(`[data-node-id="${node.node_id}"]`)
    }));

    const combinedNodes = [...allNodesWithDom, ...orphanedNodes];

    if (combinedNodes.length === 0) {
      console.warn('⚠️ RENUMBERING: No nodes found for book:', book);
      return false;
    }

    // 4. Sort by DOM order (preserves visual ordering)
    combinedNodes.sort((a, b) => {
      if (!a._domElement && !b._domElement) {
        // Neither in DOM, fall back to startLine
        return a.startLine - b.startLine;
      }
      if (!a._domElement) return 1;  // a not in DOM, put it after
      if (!b._domElement) return -1; // b not in DOM, put it after

      const position = a._domElement.compareDocumentPosition(b._domElement);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    console.log(`🔄 RENUMBERING: Processing ${combinedNodes.length} nodes (${indexedDBNodes?.length || 0} from IndexedDB, ${orphanedNodes.length} orphaned)`);

    // 5. Build mapping: node_id → new startLine (with 100-gaps)
    const updates: any[] = [];
    combinedNodes.forEach((node, index) => {
      const newStartLine = (index + 1) * 100; // 100, 200, 300, etc.
      const oldStartLine = node.startLine;

      // Update HTML content to reflect new ID (like paste.js does)
      const updatedContent = node.content.replace(
        /id="[\d.]+"/g,
        `id="${newStartLine}"`
      );

      updates.push({
        book: book,
        oldStartLine: oldStartLine,
        newStartLine: newStartLine,
        node_id: node.node_id,
        content: updatedContent,
        chunk_id: Math.floor(index / 100), // Recalculate chunk_id
        hyperlights: node.hyperlights || [],
        hypercites: node.hypercites || [],
        footnotes: node.footnotes || []
      });
    });

    console.log(`🔄 RENUMBERING: Generated ${updates.length} updates`);

    // Note: (window as any).renumberingInProgress already set at start of triggerRenumberingWithModal()

    // 7. Update DOM elements if they're currently visible (using node_id as stable reference)
    let domUpdateCount = 0;
    let missingElements = 0;

    updates.forEach(update => {
      const element = document.querySelector(`[data-node-id="${update.node_id}"]`);
      if (element) {
        const oldId = element.id;
        element.id = update.newStartLine.toString();
        domUpdateCount++;
        if (oldId.includes('.')) {
          console.log(`🔄 Updated decimal ID: ${oldId} → ${update.newStartLine}`);
        }
      } else {
        missingElements++;
      }
    });
    console.log(`✅ RENUMBERING: Updated ${domUpdateCount} DOM elements (${missingElements} not in DOM)`);

    // 5. Update IndexedDB with new startLines
    await renumberNodesInIndexedDB(updates, book);
    console.log('✅ RENUMBERING: IndexedDB updated');

    // 6. Sync to PostgreSQL using SAFE executeSyncPayload (UPDATE by node_id, no DELETE ALL)
    // This uses /api/db/unified-sync → bulkTargetedUpsert which does:
    // ON CONFLICT (book, node_id) DO UPDATE SET startLine = ...
    //
    // Only sync nodes whose startLine or chunk_id actually changed —
    // most renumbering runs only shift a handful of nodes while the
    // rest keep their 100-gap positions.
    const changedNodes = updates.filter(u => {
      const oldChunkId = indexedDBNodeMap.get(u.node_id);
      return u.oldStartLine !== u.newStartLine
        || (oldChunkId !== undefined && oldChunkId !== u.chunk_id);
    });

    console.log(`🔄 RENUMBERING: ${changedNodes.length}/${updates.length} nodes actually changed — syncing only changed`);

    const syncPayload = {
      book: book,
      updates: {
        nodes: changedNodes.map(u => ({
          book: u.book,
          startLine: u.newStartLine,
          chunk_id: u.chunk_id,
          node_id: u.node_id,
          content: u.content,
          hyperlights: u.hyperlights || [],
          hypercites: u.hypercites || [],
          footnotes: u.footnotes || []
        })),
        hypercites: [],
        hyperlights: [],
        footnotes: [],
        library: null
      },
      deletions: {
        nodes: [],
        hyperlights: [],
        hypercites: []
      }
    };

    // Save to historyLog WAL. If many nodes changed, we save as "pending"
    // and let retryFailedBatches send it in chunks so the server doesn't timeout.
    if (changedNodes.length > 0) {
      const logEntry = {
        timestamp: Date.now(),
        bookId: book,
        status: "pending",
        payload: syncPayload,
      };

      const walDb = await openDatabase();
      const walTx = walDb.transaction("historyLog", "readwrite");
      const walStore = walTx.objectStore("historyLog");
      const walId = await new Promise((resolve, reject) => {
        const request = walStore.add(logEntry);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e: any) => reject(e.target.error);
      });
      (logEntry as any).id = walId;
      await new Promise<void>((resolve, reject) => {
        walTx.oncomplete = () => resolve();
        walTx.onerror = () => reject(walTx.error);
      });
      console.log(`📦 RENUMBERING: WAL entry ${(logEntry as any).id} saved (${changedNodes.length} changed nodes, deferred sync)`);
      glowCloudLocalSave();
    } else {
      console.log('✅ RENUMBERING: No nodes changed — skipping WAL/sync');
    }

    // 7. Clear any pending syncs queued during the process (they have stale pre-renumber data)
    const clearedCount = clearPendingSyncsForBook(book);
    console.log(`✅ RENUMBERING: Cleared ${clearedCount} stale pending syncs`);

    // 8. Re-enable mutation observer
    (window as any).renumberingInProgress = false;
    console.log('🔓 RENUMBERING: Mutation observer re-enabled');

    // 8. Update lazy loader's in-memory cache (DOM is already updated in step 4)
    console.log('🔄 RENUMBERING: Updating lazy loader cache from IndexedDB');
    if (currentLazyLoader) {
      // Just update the in-memory nodes array - DOM elements already updated in step 4
      currentLazyLoader.nodes = await getAllNodesForBook(book);
      console.log('✅ RENUMBERING: Lazy loader cache updated with fresh data');
    } else {
      console.warn('⚠️ RENUMBERING: Could not update cache - currentLazyLoader not available');
    }

    // 9. Hide overlay and continue
    console.log('🎉 RENUMBERING COMPLETE');
    await ProgressOverlayConductor.hide();
    isRenumberingInProgress = false;
    renumberingPromise = null;

    // 10. Kick off chunked sync in the background (non-blocking).
    // retryFailedBatches will find the pending WAL entry and send it
    // in 500-node chunks so the server doesn't timeout.
    import('../pageLoad/index').then(({ setupOnlineSyncListener }) => {
      setupOnlineSyncListener();
    });

    return true;

  } catch (error) {
    console.error('❌ RENUMBERING FAILED:', error);
    // Show red error indicator + advise a refresh (renumber can leave IDs inconsistent).
    glowCloudRed({ error, savedLocally: false });
    // Hide overlay on error
    await ProgressOverlayConductor.hide();
    // Re-enable mutation observer even on failure
    (window as any).renumberingInProgress = false;
    console.log('🔓 RENUMBERING: Mutation observer re-enabled (after error)');
    return false;
  }
}

// Pure ID helpers live in the zero-import ./idHelpers leaf (edit-only code imports them without this
// module's heavy eager deps). Re-exported to preserve the public IDfunctions API.
export * from './idHelpers';
