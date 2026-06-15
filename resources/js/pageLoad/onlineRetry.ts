import { log, verbose } from '../utilities/logger.js';

import {
  openDatabase,
  updateHistoryLog,
  executeSyncPayload,
} from "../indexedDB/index.js";

let isRetrying = false; // Prevents multiple retries at once

async function retryFailedBatches() {
  if (isRetrying || !navigator.onLine) {
    return;
  }
  isRetrying = true;

  try {
    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    // Get both "failed" and "pending" batches (pending = saved while offline)
    const [failedLogs, pendingLogs] = await Promise.all([
      new Promise<any[]>((resolve, reject) => {
        const request = index.getAll("failed");
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }),
      new Promise<any[]>((resolve, reject) => {
        const request = index.getAll("pending");
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      })
    ]);

    const logsToRetry = [...failedLogs, ...pendingLogs];

    if (logsToRetry.length === 0) {
      isRetrying = false;
      return;
    }

    verbose.content(`Retrying ${logsToRetry.length} pending sync batches (${failedLogs.length} failed, ${pendingLogs.length} pending)`, 'initializePage.js');

    const CHUNK_SIZE = 500; // Max nodes per request to stay under server timeout

    let successCount = 0;
    for (const log of logsToRetry) {
      try {
        // --- START: Build a clean payload for syncing ---
        const historyPayload = log.payload;
        const allNodes = historyPayload.updates.nodes || [];
        const baseDeletions = {
          nodes: (historyPayload.deletions.nodes || []).filter(
            (d: any) => !(historyPayload.updates.nodes || []).some((u: any) => u.startLine === d.startLine)
          ),
          hypercites: (historyPayload.deletions.hypercites || []).filter(
            (d: any) => !(historyPayload.updates.hypercites || []).some((u: any) => u.hyperciteId === d.hyperciteId)
          ),
          hyperlights: (historyPayload.deletions.hyperlights || []).filter(
            (d: any) => !(historyPayload.updates.hyperlights || []).some((u: any) => u.hyperlight_id === d.hyperlight_id)
          ),
        };
        // --- END: Build a clean payload for syncing ---

        if (allNodes.length <= CHUNK_SIZE) {
          // Small batch — send in one go (normal edits)
          const syncPayload = {
            book: historyPayload.book,
            updates: {
              nodes: allNodes,
              hypercites: historyPayload.updates.hypercites || [],
              hyperlights: historyPayload.updates.hyperlights || [],
              footnotes: historyPayload.updates.footnotes || [],
              library: historyPayload.updates.library || null,
            },
            deletions: baseDeletions,
          };
          await executeSyncPayload(syncPayload);
        } else {
          // Large batch (e.g. renumbering) — chunk to avoid server timeout
          console.log(`📦 Chunking large batch ${log.id}: ${allNodes.length} nodes in chunks of ${CHUNK_SIZE}`);
          for (let i = 0; i < allNodes.length; i += CHUNK_SIZE) {
            const nodeChunk = allNodes.slice(i, i + CHUNK_SIZE);
            const isFirstChunk = i === 0;
            const syncPayload = {
              book: historyPayload.book,
              updates: {
                nodes: nodeChunk,
                // Only include non-node data in the first chunk to avoid duplicates
                hypercites: isFirstChunk ? (historyPayload.updates.hypercites || []) : [],
                hyperlights: isFirstChunk ? (historyPayload.updates.hyperlights || []) : [],
                footnotes: isFirstChunk ? (historyPayload.updates.footnotes || []) : [],
                library: isFirstChunk ? (historyPayload.updates.library || null) : null,
              },
              deletions: isFirstChunk ? baseDeletions : { nodes: [], hypercites: [], hyperlights: [] },
            };
            console.log(`  📤 Chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(allNodes.length / CHUNK_SIZE)}: ${nodeChunk.length} nodes`);
            await executeSyncPayload(syncPayload);
          }
          console.log(`✅ All chunks synced for batch ${log.id}`);
        }

        log.status = "synced";
        await updateHistoryLog(log);
        successCount++;
      } catch (error: any) {
        verbose.content(`Retry for batch ${log.id} failed`, 'initializePage.js', error);
        break;
      }
    }

    // 📡 Show green glow if we successfully synced any batches
    if (successCount > 0) {
      console.log(`✅ Successfully synced ${successCount} pending batches after coming online`);
      try {
        const { glowCloudSyncSuccess } = await import('../components/editIndicator.js');
        glowCloudSyncSuccess();
      } catch (e) {
        // Edit indicator might not be loaded if user hasn't edited
      }
    }
  } catch (error: any) {
    log.error('Critical error during retry process', 'initializePage.js', error);
  } finally {
    isRetrying = false;
  }
}

// Track if online listener is attached
let onlineListenerAttached = false;

// ✅ STEP 3: A setup function to attach the event listeners
export function setupOnlineSyncListener() {
  // Immediately check for failed batches when the app loads
  retryFailedBatches();

  // Only add listener if not already attached
  if (!onlineListenerAttached) {
    window.addEventListener("online", retryFailedBatches);
    onlineListenerAttached = true;
  }
}

// Cleanup function to remove online listener
export function cleanupOnlineSyncListener() {
  if (onlineListenerAttached) {
    window.removeEventListener("online", retryFailedBatches);
    onlineListenerAttached = false;
  }
}

export { retryFailedBatches };
