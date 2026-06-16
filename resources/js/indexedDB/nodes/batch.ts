/**
 * Node Batch Operations Module
 * Handles bulk updates and deletes of node chunks with highlights and hypercites
 */

import { openDatabase } from '../core/connection';
import { parseNodeId } from '../core/utilities';
import { verbose } from '../../utilities/logger';
import { syncFirstNodeToTitle, updateBookTimestamp } from '../core/library';
// debounce comes from the zero-import leaf, NOT divEditor/saveQueue.js —
// importing it via saveQueue welded this module into the editor import cycle
// (the circular-import TDZ landmine).
import { debounce } from '../../utilities/debounce';
import { withPending } from '../../utilities/operationState';
import { queueForSync } from '../syncQueue/queue';
import { reportIntegrityFailure } from '../../integrity/reporter';
import { INLINE_SKIP_TAGS } from '../../utilities/blockElements';
// Pure helper extracted so the DOM-walk + fallback chain can be unit-tested
// in isolation. Tests: tests/javascript/indexedDB/batch.test.js
import { resolveBookIdForBatch } from './bookIdResolver';
// Direct leaf imports (not the indexedDB/index barrel) — read/rebuild don't import batch, so these
// are one-way and need no dynamic-import cycle-breaker.
import { getNodeChunksFromIndexedDB } from './read';
import { rebuildNodeArrays, getNodesByDataNodeIDs } from '../hydration/rebuild';
import { processNodeContentHighlightsAndCites, determineChunkIdFromDOM } from './contentProcessor';
import { updateHyperlightRecords, updateHyperciteRecords } from './annotationUpserts';
import type { BookId, HyperciteRecord, HyperlightRecord, NodeRecord } from '../types';

export { resolveBookIdForBatch };

/** A record handed to the batch writer: a DOM node id, optionally with html/chunk overrides. */
export interface BatchRecord {
  id: string | number;
  html?: string;
  chunk_id?: number;
}

export interface BatchUpdateOptions {
  /** Skip auto-renumbering (caller handles it) */
  skipFootnoteRenumber?: boolean;
  /** Skip clearing redo history (for automatic operations like undo/redo) */
  skipRedoClear?: boolean;
  /** Skip timestamp + sync queueing (internal ops, e.g. marker restoration) */
  skipHistory?: boolean;
  /** Explicit book override (sub-book support) */
  bookId?: BookId;
}

// A valid node id is purely numeric (optionally one decimal, e.g. "100" or "100.5").
// Validate with this BEFORE parseNodeId — parseNodeId maps garbage to 0 (never NaN),
// so an isNaN check on its result can never fire.
const NUMERIC_NODE_ID = /^\d+(\.\d+)?$/;

// Dependencies that change per-book
let book: BookId | null | undefined;

// Initialization function to inject dependencies
export function initNodeBatchDependencies(deps: { book: BookId | null | undefined }): void {
  book = deps.book;
}

// Debounced title sync - only runs 500ms after user stops typing
const debouncedTitleSync = debounce((bookId: BookId, nodeContent: string) => {
  syncFirstNodeToTitle(bookId, nodeContent).catch(error => {
    console.error('❌ Error in debounced title sync:', error);
  });
}, 500);

/**
 * Update a single IndexedDB record from DOM changes.
 * Wrapper around batchUpdateIndexedDBRecords for single-record convenience.
 *
 * @param {Object} record - Record object with id and html
 * @returns {Promise<void>}
 */
export function updateSingleIndexedDBRecord(record: BatchRecord, options: BatchUpdateOptions = {}): Promise<void> {
  return batchUpdateIndexedDBRecords([record], options);
}

/**
 * Batch update multiple IndexedDB records.
 * Core implementation used by updateSingleIndexedDBRecord wrapper.
 *
 * @param {Array} recordsToProcess - Array of record objects
 * @param {Object} options - Optional settings
 * @param {boolean} options.skipFootnoteRenumber - Skip auto-renumbering (caller handles it)
 * @param {boolean} options.skipRedoClear - Skip clearing redo history (for automatic operations like undo/redo)
 * @returns {Promise<void>}
 */
export async function batchUpdateIndexedDBRecords(recordsToProcess: BatchRecord[], options: BatchUpdateOptions = {}): Promise<void> {
  // ✅ FIX: When skipHistory is true (internal operations like no-delete-id markers),
  // don't use withPending which triggers the orange indicator, since no server sync will happen
  const wrapper: <T>(fn: () => Promise<T>) => Promise<T> = options.skipHistory ? (fn) => fn() : withPending;

  return wrapper(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    // During new book creation, global variable may not be updated yet
    const mainContent = document.querySelector('.main-content');
    const firstRecordEl = document.getElementById(String(recordsToProcess[0]?.id));
    const bookId = resolveBookIdForBatch({
      optionsBookId: options?.bookId,
      firstRecordEl,
      mainContent,
      globalBook: book,
    });
    console.log(
      `🔄 Batch updating ${recordsToProcess.length} IndexedDB records`,
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodes", "hyperlights", "hypercites", "bibliography"],
      "readwrite",
    );
    const chunksStore = tx.objectStore("nodes");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");

    const allSavedNodeChunks: NodeRecord[] = [];
    const allSavedHyperlights: HyperlightRecord[] = [];
    const allSavedHypercites: HyperciteRecord[] = [];
    const originalNodeChunkStates = new Map<number, NodeRecord>();

    // This is a critical step: Read all original states BEFORE any writes.
    const readPromises = recordsToProcess.map((record) => {
      return new Promise<void>((resolve) => {
        // ✅ FIX 1: Add a check for a valid record and ID before proceeding.
        if (!record || typeof record.id === "undefined" || record.id === null) {
          console.error(
            "Skipping invalid record in batch update (record or id is null/undefined):",
            record,
          );
          return resolve(); // Resolve the promise to not block the batch.
        }

        // ✅ FIX 2: The most important check. Ensure the id is a valid numeric node id.
        if (!NUMERIC_NODE_ID.test(String(record.id))) {
          console.error(
            `Skipping batch update for invalid node ID: '${record.id}'.`,
          );
          reportIntegrityFailure({
            bookId,
            mismatches: [],
            missingFromIDB: [String(record.id)],
            trigger: 'batch-invalid-id',
          });
          return resolve(); // Resolve and skip this invalid record.
        }
        const numericNodeId = parseNodeId(record.id);

        const getReq = chunksStore.get([bookId, numericNodeId]);
        getReq.onsuccess = () => {
          if (getReq.result) {
            originalNodeChunkStates.set(numericNodeId, { ...getReq.result });
          }
          resolve();
        };
        getReq.onerror = (err) => {
          console.error(
            `Error getting record for batch update: ID=${record.id}`,
            err,
          );
          resolve(); // Resolve even on error to not block the whole batch.
        };
      });
    });
    await Promise.all(readPromises);

    // Now, perform the updates
    const processPromises = recordsToProcess.map(async (record) => {
      // ✅ FIX 3: Repeat the same validation here to avoid processing bad data.
      if (!record || typeof record.id === "undefined" || record.id === null) {
        return;
      }
      if (!NUMERIC_NODE_ID.test(String(record.id))) {
        return;
      }
      const numericNodeId = parseNodeId(record.id);

      let IDnumerical = String(record.id);
      let node: HTMLElement | null = null;

      // Use node_id (data-node-id) for DOM lookup — unique across all books
      const existingForLookup = originalNodeChunkStates.get(numericNodeId);
      if (existingForLookup?.node_id) {
        node = document.querySelector(`[data-node-id="${existingForLookup.node_id}"]`) as HTMLElement | null;
      }

      // Fallback for new nodes (no existing record): scope to book container
      if (!node && bookId) {
        const bookContainer = document.querySelector(`[data-book-id="${bookId}"]`)
          || document.getElementById(bookId);
        if (bookContainer) {
          node = bookContainer.querySelector(`[id="${IDnumerical}"]`) as HTMLElement | null;
        }
      }

      // Final fallback: global lookup (main content, no collision risk)
      if (!node) {
        node = document.getElementById(IDnumerical);
      }

      // Skip inline formatting artifacts (e.g. <font id="1"> from copy-paste)
      if (node && INLINE_SKIP_TAGS.has(node.tagName)) {
        console.warn(`⚠️ Skipping batch update – inline element <${node.tagName}> for id ${IDnumerical}`);
        return;
      }

      while (node && !NUMERIC_NODE_ID.test(IDnumerical)) {
        node = node.parentElement;
        if (node?.id) IDnumerical = node.id;
      }

      if (!NUMERIC_NODE_ID.test(IDnumerical)) {
        console.log(
          `Skipping batch update – no valid parent for ${record.id}`,
        );
        return;
      }

      const finalNumericNodeId = parseNodeId(IDnumerical); // Use the final valid ID
      const existing = originalNodeChunkStates.get(finalNumericNodeId);
      const existingHypercites = existing?.hypercites || [];
      const processedData = node
        ? processNodeContentHighlightsAndCites(node, existingHypercites)
        : null;

      // ✅ EXTRACT node_id from data-node-id attribute
      const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

      // 🔍 DEBUG: Log node_id extraction
      verbose.content(`node_id extraction: record.id=${record.id}, finalNodeId=${IDnumerical}, node=${node?.tagName}, nodeIdFromDOM=${nodeIdFromDOM}`, 'indexedDB/nodes/batch');
      if (node && !nodeIdFromDOM) {
        console.warn(`⚠️ Node found but no data-node-id attribute! Element:`, node.outerHTML.substring(0, 200));
      }

      let toSave: NodeRecord;
      if (existing) {
        toSave = { ...existing };
        if (processedData) {
          toSave.content = processedData.content;
          // ✅ Update footnotes from extracted data (important for renumbering on delete)
          toSave.footnotes = processedData.footnotes || [];
          // ✅ Update citations from extracted data.
          // DELIBERATE: citations removed from the text are NOT cleaned out of the
          // bibliography store/table — keeping the reference record means undo or
          // re-pasting the citation works cleanly without a server round-trip.
          toSave.citations = processedData.citations || [];
          // ✅ NEW SYSTEM: Don't set arrays here - they'll be rebuilt from normalized tables
          // Keep existing arrays or initialize empty if missing
          if (!toSave.hyperlights) toSave.hyperlights = [];
          if (!toSave.hypercites) toSave.hypercites = [];
        } else {
          toSave.content = record.html || existing.content;
        }
        // ✅ FIX: Determine chunk_id from DOM if not provided
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
        } else {
          toSave.chunk_id = determineChunkIdFromDOM(IDnumerical);
        }
        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
        }
      } else {
        toSave = {
          book: bookId,
          startLine: finalNumericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : determineChunkIdFromDOM(IDnumerical),
          node_id: nodeIdFromDOM || null,
          content: processedData ? processedData.content : record.html || "",
          footnotes: processedData ? processedData.footnotes : [],
          citations: processedData ? processedData.citations : [],
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : [],
        };
      }

      // 🔍 DEBUG: Log what's being saved
      verbose.content(`Saving to IndexedDB: startLine=${toSave.startLine}, node_id=${toSave.node_id}, hasContent=${!!toSave.content}`, 'indexedDB/nodes/batch');
      chunksStore.put(toSave);
      allSavedNodeChunks.push(toSave);

      if (processedData) {
        updateHyperlightRecords(
          processedData.hyperlights,
          lightsStore,
          bookId,
          finalNumericNodeId,
          allSavedHyperlights,
          node!,
        );
        updateHyperciteRecords(
          processedData.hypercites,
          citesStore,
          bookId,
          allSavedHypercites,
          node!,
        );
      }
    });
    await Promise.all(processPromises);

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ Batch IndexedDB update complete");

        // Skip both timestamp update and queueForSync if skipHistory is true
        // (for automatic operations like marker restoration during page load)
        // This prevents spurious syncs that could trigger 409 stale data errors
        if (!options.skipHistory) {
          await updateBookTimestamp(bookId);
          allSavedNodeChunks.forEach((chunk) => {
            const originalChunk = originalNodeChunkStates.get(chunk.startLine);
            queueForSync(
              "nodes",
              chunk.startLine,
              "update",
              chunk,
              originalChunk,
              options.skipRedoClear || false,
            );
          });
          allSavedHyperlights.forEach((hl) => {
            queueForSync("hyperlights", hl.hyperlight_id, "update", hl, null, options.skipRedoClear || false);
          });
          allSavedHypercites.forEach((hc) => {
            queueForSync("hypercites", hc.hyperciteId, "update", hc, null, options.skipRedoClear || false);
          });
        } else {
          console.log(`⏭️ Skipping queueForSync - skipHistory option is true`);
        }

        // Auto-sync first node to library title (only if node 100 was updated)
        const firstNodeChunk = allSavedNodeChunks.find(chunk => chunk.startLine === 100);
        if (firstNodeChunk) {
          console.log('🔄 First node (100) was updated, triggering debounced title sync');
          debouncedTitleSync(bookId, firstNodeChunk.content);
        }

        // ✅ NEW SYSTEM: Rebuild node arrays from normalized tables for all affected nodes
        const affectedDataNodeIDs = allSavedNodeChunks
          .map(chunk => chunk.node_id)
          .filter((id): id is string => Boolean(id));

        if (affectedDataNodeIDs.length > 0) {
          try {
            const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../hydration/rebuild');
            const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
            // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
            // node when the same node_id exists in both parent and sub-book.
            const nodes = allNodes.filter(n => n.book === bookId);
            if (nodes.length > 0) {
              await rebuildNodeArrays(nodes);
              console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${nodes.length} nodes after batch update`);
            }
          } catch (error) {
            console.error('❌ NEW SYSTEM: Error rebuilding arrays after batch update:', error);
            // Don't fail the whole operation if rebuild fails
          }
        }

        // 📝 Trigger footnote renumbering after batch update if footnotes were affected
        // Skip if caller handles renumbering (e.g., footnoteInserter.js)
        if (!options.skipFootnoteRenumber) {
          // Compare before/after to detect both additions AND deletions
          const normalizeFootnoteIds = (arr?: NodeRecord['footnotes']) =>
            (arr || []).map(f => typeof f === 'string' ? f : f?.id).filter(Boolean).sort();
          const nodesWithFootnoteChanges = allSavedNodeChunks.filter(node => {
            const originalNode = originalNodeChunkStates.get(node.startLine);
            const oldIds = normalizeFootnoteIds(originalNode?.footnotes);
            const newIds = normalizeFootnoteIds(node.footnotes);
            // Trigger if footnote count changed (added or deleted) — ID-only comparison ignores format differences
            const changed = oldIds.length !== newIds.length ||
                   JSON.stringify(oldIds) !== JSON.stringify(newIds);
            if (changed) {
              console.log(`📝 Footnote change detected in node ${node.startLine}: ${oldIds.length} → ${newIds.length}`);
              // [diagnostic] include old/new IDs and bookId so we can see what triggered renumber
              console.log(`[diag][batch] footnote delta on ${bookId}/${node.startLine}: old=${JSON.stringify(oldIds)} new=${JSON.stringify(newIds)}`);
            }
            return changed;
          });

          if (nodesWithFootnoteChanges.length > 0) {
            console.log(`📝 Triggering footnote renumbering: ${nodesWithFootnoteChanges.length} nodes with footnote changes`);
            // [diagnostic] log caller context so we can see if this fires during
            // post-import hydration (no user edits) or only after explicit edits
            const __batchStack = new Error('batchUpdateIndexedDBRecords renumber trigger').stack;
            console.log(`[diag][batch] auto-renumber trigger for bookId=${bookId} affectedCount=${nodesWithFootnoteChanges.length}`);
            console.log(`[diag][batch] caller stack:\n${__batchStack}`);
            try {
              const { rebuildAndRenumber } = await import('../../footnotes/FootnoteNumberingService');
              const allNodes = await getNodeChunksFromIndexedDB(bookId);
              if (allNodes && allNodes.length > 0) {
                await rebuildAndRenumber(bookId, allNodes);
              }
            } catch (error) {
              console.error('❌ Error triggering footnote renumbering:', error);
              // Don't fail the whole operation if renumbering fails
            }
          }
        } else {
          console.log(`📝 Skipping auto-renumber (caller handles it)`);
        }

        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error("Batch transaction aborted"));
    });
  });
}

/**
 * Batch delete multiple IndexedDB records
 *
 * @param {Array} IDnumericals - Array of node IDs to delete
 * @param {Map} deletionMap - Map of IDnumerical -> data-node-id for deleted nodes
 * @param {string} bookId - Book ID to delete from (required for sub-book support)
 * @returns {Promise<void>}
 */
export async function batchDeleteIndexedDBRecords(
  IDnumericals: string[],
  deletionMap: Map<string, string | null | undefined> = new Map(),
  bookIdParam: BookId | null = null,
): Promise<void> {
  return withPending(async () => {
    // ✅ FIX: Accept bookId as parameter for sub-book support
    // Fallback to DOM lookup only if not provided (backwards compatibility)
    const bookId: BookId = bookIdParam
      || document.querySelector('.main-content')?.id
      || book
      || "latest";

    // ✅ OPTIMIZATION: Remove duplicates using Set
    const uniqueIDnumericals = [...new Set(IDnumericals)];
    const duplicatesSkipped = IDnumericals.length - uniqueIDnumericals.length;

    const startTime = Date.now();
    console.log(`🗑️ BATCH DELETE START: ${IDnumericals.length} nodes queued (${uniqueIDnumericals.length} unique${duplicatesSkipped > 0 ? `, ${duplicatesSkipped} duplicates skipped` : ''})`);

    try {
      const db = await openDatabase();

      const tx = db.transaction(
        ["nodes", "hyperlights", "hypercites"],
        "readwrite"
      );

      const chunksStore = tx.objectStore("nodes");
      const lightsStore = tx.objectStore("hyperlights");
      const citesStore = tx.objectStore("hypercites");

      // This object will collect the full data of everything we delete.
      const deletedData: {
        nodes: NodeRecord[];
        hyperlights: HyperlightRecord[];
        hypercites: HyperciteRecord[];
      } = {
        nodes: [],
        hyperlights: [],
        hypercites: []
      };

      let processedCount = 0;
      let errorCount = 0;

      // ✅ OPTIMIZATION: Build lookup sets ONCE for O(1) checks in cursor scans
      const deletedIDnumericals = new Set(
        uniqueIDnumericals.filter(id => NUMERIC_NODE_ID.test(String(id))).map(id => parseNodeId(id)),
      );
      const deletedDataNodeIDs = new Set(Array.from(deletionMap.values()).filter((v): v is string => Boolean(v)));

      verbose.content(`OPTIMIZATION: Will scan highlights/hypercites once for ${deletedIDnumericals.size} deleted nodes (${deletedDataNodeIDs.size} data-node-ids)`, 'indexedDB/nodes/batch');

      // Track which highlights/hypercites we've already processed (avoid N cursor scans)
      let highlightsProcessed = 0;
      let hypercitesProcessed = 0;

      // Process each node ID for deletion
      const deletePromises = uniqueIDnumericals.map(async (IDnumerical, index) => {
        if (!NUMERIC_NODE_ID.test(IDnumerical)) {
          console.warn(`❌ Skipping deletion – invalid node ID: ${IDnumerical}`);
          errorCount++;
          return;
        }

        const numericNodeId = parseNodeId(IDnumerical);
        const compositeKey = [bookId, numericNodeId];

        return new Promise<void>((resolve, reject) => {
          const getReq = chunksStore.get(compositeKey);

          getReq.onsuccess = () => {
            const existing = getReq.result as NodeRecord | undefined;

            if (existing) {
              // ✅ CHANGE 1: Store the original record for the history log.
              // We no longer need the `_deleted: true` flag.
              deletedData.nodes.push(existing); // This is the record to ADD BACK on UNDO

              const deleteReq = chunksStore.delete(compositeKey);
              deleteReq.onsuccess = () => {
                processedCount++;
                resolve();
              };
              deleteReq.onerror = () => {
                errorCount++;
                console.error(`❌ Failed to delete ${IDnumerical}:`, deleteReq.error);
                reject(deleteReq.error);
              };

              // ✅ OPTIMIZATION: Only scan highlights/hypercites ONCE for the first node
              // All subsequent nodes will be handled in the same scan via Set lookups
              if (index === 0) {
                try {
                  // ✅ OPTIMIZED: Single cursor scan for ALL hyperlights
                  const bookIndex = lightsStore.index("book");
                  const bookRange = IDBKeyRange.only(bookId);
                  const lightReq = bookIndex.openCursor(bookRange);

                  lightReq.onsuccess = () => {
                    const cursor = lightReq.result;
                    if (cursor) {
                      const highlight = cursor.value as HyperlightRecord;

                      // ✅ OPTIMIZATION: O(1) Set lookup instead of iterating through each deleted node
                      const affectsDeletedNode =
                        deletedIDnumericals.has(highlight.startLine) || // OLD schema check
                        (highlight.node_id && Array.isArray(highlight.node_id) &&
                         highlight.node_id.some(dataNodeID => deletedDataNodeIDs.has(dataNodeID))); // NEW schema check

                      if (affectsDeletedNode) {
                        highlightsProcessed++;

                        // Find which deleted data-node-id this affects (for tracking)
                        const affectedDataNodeID = highlight.node_id?.find(dataNodeID => deletedDataNodeIDs.has(dataNodeID));

                        // Check if multi-node highlight
                        if (highlight.node_id && highlight.node_id.length > 1) {
                          // Multi-node highlight - mark node for deletion cleanup
                          if (!highlight._deleted_nodes) {
                            highlight._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !highlight._deleted_nodes.includes(affectedDataNodeID)) {
                            highlight._deleted_nodes.push(affectedDataNodeID);
                          }

                          // Save updated highlight (don't delete it!)
                          cursor.update(highlight);
                        } else {
                          // Single-node highlight - OLD SYSTEM behavior (delete from OLD schema stores)
                          if (deletedIDnumericals.has(highlight.startLine)) {
                            deletedData.hyperlights.push(cursor.value); // Record for undo
                            cursor.delete();
                          } else {
                            // Single-node in NEW schema - mark as orphaned
                            highlight._orphaned_at = Date.now();
                            highlight._orphaned_from_node = affectedDataNodeID || highlight.startLine.toString();

                            // Track deleted node for cleanup
                            if (!highlight._deleted_nodes) {
                              highlight._deleted_nodes = [];
                            }
                            if (affectedDataNodeID && !highlight._deleted_nodes.includes(affectedDataNodeID)) {
                              highlight._deleted_nodes.push(affectedDataNodeID);
                            }

                            cursor.update(highlight);
                          }
                        }
                      }

                      cursor.continue();
                    } else {
                      // Cursor complete - log optimization results (verbose)
                      if (highlightsProcessed > 0) {
                        verbose.content(`OPTIMIZATION: Processed ${highlightsProcessed} highlights in single cursor scan`, 'indexedDB/nodes/batch');
                      }
                    }
                  };
                } catch (lightError) {
                  console.warn(`⚠️ Error updating hyperlights:`, lightError);
                }

                try {
                  // ✅ OPTIMIZED: Single cursor scan for ALL hypercites
                  const citeIndex = citesStore.index("book");
                  const citeRange = IDBKeyRange.only(bookId);
                  const citeReq = citeIndex.openCursor(citeRange);

                  citeReq.onsuccess = () => {
                    const cursor = citeReq.result;
                    if (cursor) {
                      const hypercite = cursor.value as HyperciteRecord & { startLine?: number };

                      // ✅ OPTIMIZATION: O(1) Set lookup
                      const affectsDeletedNode =
                        deletedIDnumericals.has(hypercite.startLine!) || // OLD schema check
                        (hypercite.node_id && Array.isArray(hypercite.node_id) &&
                         hypercite.node_id.some(dataNodeID => deletedDataNodeIDs.has(dataNodeID))); // NEW schema check

                      if (affectsDeletedNode) {
                        hypercitesProcessed++;

                        // Find which deleted data-node-id this affects
                        const affectedDataNodeID = hypercite.node_id?.find(dataNodeID => deletedDataNodeIDs.has(dataNodeID));

                        // Check if multi-node hypercite
                        if (hypercite.node_id && hypercite.node_id.length > 1) {
                          // Multi-node hypercite - mark node for deletion cleanup
                          if (!hypercite._deleted_nodes) {
                            hypercite._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !hypercite._deleted_nodes.includes(affectedDataNodeID)) {
                            hypercite._deleted_nodes.push(affectedDataNodeID);
                          }

                          // Save updated hypercite (don't delete it!)
                          cursor.update(hypercite);
                        } else if (deletedIDnumericals.has(hypercite.startLine!)) {
                          // OLD SYSTEM - hypercite only in old schema
                          deletedData.hypercites.push(cursor.value); // Record for undo
                          cursor.delete();
                        } else {
                          // Single-node hypercite in NEW schema - mark as orphaned
                          hypercite._orphaned_at = Date.now();
                          hypercite._orphaned_from_node = affectedDataNodeID || hypercite.startLine!.toString();

                          // Track deleted node for cleanup
                          if (!hypercite._deleted_nodes) {
                            hypercite._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !hypercite._deleted_nodes.includes(affectedDataNodeID)) {
                            hypercite._deleted_nodes.push(affectedDataNodeID);
                          }

                          cursor.update(hypercite);
                        }
                      }

                      cursor.continue();
                    } else {
                      // Cursor complete - log optimization results (verbose)
                      if (hypercitesProcessed > 0) {
                        verbose.content(`OPTIMIZATION: Processed ${hypercitesProcessed} hypercites in single cursor scan`, 'indexedDB/nodes/batch');
                      }
                    }
                  };
                } catch (citeError) {
                  console.warn(`⚠️ Error updating hypercites:`, citeError);
                }
              }
            } else {
              // Silently skip - node already deleted or never existed
              resolve();
            }
          };

          getReq.onerror = () => reject(getReq.error);
        });
      });

      await Promise.all(deletePromises);

      return new Promise<void>((resolve, reject) => {
        tx.oncomplete = async () => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`🗑️ BATCH DELETE COMPLETE: ${processedCount} deleted, ${errorCount} failed (${duration}s)`);
          await updateBookTimestamp(bookId);

          // Queue deleted records for PostgreSQL sync
          // ⚠️ DIAGNOSTIC: Log when many nodes are being queued for deletion
          if (deletedData.nodes.length > 10) {
            console.warn(`⚠️ MASS DELETION QUEUED: ${deletedData.nodes.length} nodes`, {
              stack: new Error().stack,
              nodeIds: deletedData.nodes.slice(0, 5).map(n => n.startLine),
              timestamp: Date.now()
            });
          }
          deletedData.nodes.forEach((record) => {
            queueForSync("nodes", record.startLine, "delete", record);
          });
          deletedData.hyperlights.forEach((record) => {
            queueForSync("hyperlights", record.hyperlight_id, "delete", record);
          });
          deletedData.hypercites.forEach((record) => {
            queueForSync("hypercites", record.hyperciteId, "delete", record);
          });

          // ✅ NEW SYSTEM: Rebuild arrays for remaining nodes affected by multi-node highlights/hypercites
          try {
            // Collect all remaining data-node-ids from deletionMap that weren't deleted
            const deletedDataNodeIDs = Array.from(deletionMap.values()).filter((v): v is string => Boolean(v));
            console.log(`🔄 NEW SYSTEM: Deleted data-node-ids:`, deletedDataNodeIDs);

            if (deletedDataNodeIDs.length > 0) {
              const db = await openDatabase();

              // Find nodes that might have been affected by the deleted nodes
              // (nodes that share highlights/hypercites with deleted nodes)
              const affectedDataNodeIDs = new Set<string>();

              // Query hyperlights to find which nodes are affected
              const lightTx = db.transaction('hyperlights', 'readonly');
              const lightStore = lightTx.objectStore('hyperlights');
              const allLights = await new Promise<HyperlightRecord[]>((resolve, reject) => {
                const req = lightStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              allLights.forEach(light => {
                if (light._deleted_nodes && light._deleted_nodes.some(dataNodeID => deletedDataNodeIDs.includes(dataNodeID))) {
                  // This highlight was affected - rebuild its remaining nodes
                  light.node_id.forEach(dataNodeID => {
                    if (!deletedDataNodeIDs.includes(dataNodeID)) {
                      affectedDataNodeIDs.add(dataNodeID);
                    }
                  });
                }
              });

              // Query hypercites similarly
              const citeTx = db.transaction('hypercites', 'readonly');
              const citeStore = citeTx.objectStore('hypercites');
              const allCites = await new Promise<HyperciteRecord[]>((resolve, reject) => {
                const req = citeStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              allCites.forEach(cite => {
                if (cite._deleted_nodes && cite._deleted_nodes.some(dataNodeID => deletedDataNodeIDs.includes(dataNodeID))) {
                  // This hypercite was affected - rebuild its remaining nodes
                  cite.node_id.forEach(dataNodeID => {
                    if (!deletedDataNodeIDs.includes(dataNodeID)) {
                      affectedDataNodeIDs.add(dataNodeID);
                    }
                  });
                }
              });

              if (affectedDataNodeIDs.size > 0) {
                console.log(`🔄 NEW SYSTEM: Rebuilding arrays for ${affectedDataNodeIDs.size} affected nodes`);
                const affectedNodes = await getNodesByDataNodeIDs([...affectedDataNodeIDs]);
                await rebuildNodeArrays(affectedNodes);
                console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} nodes after deletion`);
              } else {
                console.log(`ℹ️ NEW SYSTEM: No remaining nodes to rebuild (single-node deletions)`);
              }
            }
          } catch (hydrationError) {
            console.error('❌ NEW SYSTEM: Error rebuilding arrays after deletion:', hydrationError);
            // Don't fail the whole operation if hydration fails
          }

          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(new Error("Batch deletion transaction aborted"));
      });
    } catch (error) {
      console.error("❌ Error in batchDeleteIndexedDBRecords:", error);
      throw error;
    }
  });
}

// Note: batchUpdateMigratedNodes was removed - footnote migration is now handled
// server-side in DatabaseToIndexedDBController.php
