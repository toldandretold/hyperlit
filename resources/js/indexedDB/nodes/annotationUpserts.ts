/**
 * Annotation upserts — writes measured <mark>/<u> positions into the
 * normalized hyperlights/hypercites stores during a batch node save.
 *
 * Extracted from batch.js (decompose-and-convert). Both twins share the same
 * shape: orphan recovery (clear _orphaned_* when the annotation reappears),
 * _deleted_nodes cleanup (purge dead nodes from node_id/charData), legacy
 * positional fields kept in sync, and per-node charData updates.
 *
 * Behavior pinned by batchUpdate.characterization.test.js (incl. the
 * orphan-recovery test) and batchDelete.characterization.test.js.
 */

import type { BookId, HyperciteRecord, HyperlightRecord } from '../types';
import type { CollectedHyperlight, CollectedHypercite } from './positionCollector';

const escapeCss = (s: string): string =>
  (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s;

/**
 * Update hyperlight records in IndexedDB
 * Called during node chunk updates (must run inside the batch's open transaction)
 */
export function updateHyperlightRecords(
  hyperlights: CollectedHyperlight[],
  store: IDBObjectStore,
  bookId: BookId,
  numericNodeId: number,
  syncArray: HyperlightRecord[],
  node: HTMLElement,
): void {
  hyperlights.forEach((hyperlight) => {
    const key = [bookId, hyperlight.highlightID];
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result as HyperlightRecord | undefined;

      // Find the mark element(s) to get text content. Query by CLASS, not id:
      // overlapping highlights render as multiple segments where only the class
      // is reliable (multi-coverage segments have id="HL_overlap", and a
      // fully-contained highlight has no mark with its id at all). Concatenate
      // segments so split highlights keep their full text. Falls back to the
      // legacy id lookup for old DOM that only carried the id.
      const markSegments = node.querySelectorAll(`mark.${escapeCss(hyperlight.highlightID)}`);
      const legacyMarkElement = markSegments.length === 0
        ? node.querySelector(`#${escapeCss(hyperlight.highlightID)}`)
        : null;
      const highlightedText = markSegments.length > 0
        ? Array.from(markSegments).map(m => m.textContent).join("")
        : (legacyMarkElement ? legacyMarkElement.textContent ?? "" : "");
      const highlightedHTML = markSegments.length > 0
        ? Array.from(markSegments).map(m => m.outerHTML).join("")
        : (legacyMarkElement ? legacyMarkElement.outerHTML : "");

      // ✅ NEW: Extract data-node-id from DOM for new schema
      const dataNodeID = node.getAttribute('data-node-id');

      if (existingRecord) {
        // ✅ NEW: Check if this was orphaned and now recovered
        if (existingRecord._orphaned_at) {
          console.log(`🎉 RECOVERED orphaned highlight ${hyperlight.highlightID} - found in DOM after node deletion`);
          delete existingRecord._orphaned_at;
          delete existingRecord._orphaned_from_node;
        }

        // ✅ NEW: Clean up deleted nodes if marked
        if (existingRecord._deleted_nodes && existingRecord._deleted_nodes.length > 0) {
          console.log(`🧹 Cleaning up ${existingRecord._deleted_nodes.length} deleted nodes from highlight ${hyperlight.highlightID}`);

          existingRecord._deleted_nodes.forEach(deletedDataNodeID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedDataNodeID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedDataNodeID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedDataNodeID]) {
              delete existingRecord.charData[deletedDataNodeID];
              console.log(`  🗑️ Removed ${deletedDataNodeID} from charData`);
            }
          });

          // Clear the tracking array
          delete existingRecord._deleted_nodes;
          console.log(`✅ Cleanup complete for highlight ${hyperlight.highlightID}`);
        }

        // Update existing record (per-node ranges go to charData below; startLine is a synced column)
        existingRecord.startLine = numericNodeId;
        existingRecord.highlightedText = highlightedText;
        existingRecord.highlightedHTML = highlightedHTML;

        // ✅ NEW: Update NEW schema (node_id array + charData object)
        if (dataNodeID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(dataNodeID)) {
            existingRecord.node_id.push(dataNodeID);
            console.log(`➕ Added node ${dataNodeID} to highlight ${hyperlight.highlightID}`);
          }

          // Update charData for this specific node
          existingRecord.charData[dataNodeID] = {
            charStart: hyperlight.charStart,
            charEnd: hyperlight.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hyperlight.highlightID}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${dataNodeID}`);
        }

        store.put(existingRecord);
        syncArray.push(existingRecord);

        console.log(`Updated hyperlight ${hyperlight.highlightID} positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      } else {
        // SAFETY: Check if this highlight already exists under a different book
        // (prevents duplicates when cross-book ID collisions cause marks to
        // appear in the wrong sub-book's DOM)
        const hlIndex = store.index('hyperlight_id');
        const existCheck = hlIndex.get(hyperlight.highlightID);
        existCheck.onsuccess = () => {
          if (existCheck.result) {
            console.warn(`⚠️ Skipping duplicate: ${hyperlight.highlightID} already exists under book ${existCheck.result.book}`);
            return; // Don't create duplicate
          }

          // Create new record
          const newRecord: HyperlightRecord = {
            book: bookId,
            hyperlight_id: hyperlight.highlightID,
            startLine: numericNodeId,
            highlightedText: highlightedText,
            highlightedHTML: highlightedHTML,
            annotation: "",
            // ✅ NEW: Initialize NEW schema fields
            node_id: dataNodeID ? [dataNodeID] : [],
            charData: dataNodeID ? {
              [dataNodeID]: {
                charStart: hyperlight.charStart,
                charEnd: hyperlight.charEnd
              }
            } : {}
          };

          store.put(newRecord);
          syncArray.push(newRecord);

          console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
          if (dataNodeID) {
            console.log(`✅ Initialized NEW schema: node_id=[${dataNodeID}], charData set`);
          }
        };
      }
    };
  });
}

/**
 * Update hypercite records in IndexedDB
 * Called during node chunk updates (must run inside the batch's open transaction)
 */
export function updateHyperciteRecords(
  hypercites: CollectedHypercite[],
  store: IDBObjectStore,
  bookId: BookId,
  syncArray: HyperciteRecord[],
  node: HTMLElement,
): void {
  hypercites.forEach((hypercite) => {
    const key = [bookId, hypercite.hyperciteId];
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result as HyperciteRecord | undefined;

      // Find the actual u element to get text content
      const uElement = node.querySelector(`#${escapeCss(hypercite.hyperciteId)}`);
      const hypercitedText = uElement ? uElement.textContent ?? "" : "";
      const hypercitedHTML = uElement ? uElement.outerHTML : "";

      // ✅ NEW: Extract data-node-id from DOM for new schema
      const dataNodeID = node.getAttribute('data-node-id');

      if (existingRecord) {
        // ✅ NEW: Check if this was orphaned and now recovered
        if (existingRecord._orphaned_at) {
          console.log(`🎉 RECOVERED orphaned hypercite ${hypercite.hyperciteId} - found in DOM after node deletion`);
          delete existingRecord._orphaned_at;
          delete existingRecord._orphaned_from_node;
        }

        // ✅ NEW: Clean up deleted nodes if marked
        if (existingRecord._deleted_nodes && existingRecord._deleted_nodes.length > 0) {
          console.log(`🧹 Cleaning up ${existingRecord._deleted_nodes.length} deleted nodes from hypercite ${hypercite.hyperciteId}`);

          existingRecord._deleted_nodes.forEach(deletedDataNodeID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedDataNodeID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedDataNodeID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedDataNodeID]) {
              delete existingRecord.charData[deletedDataNodeID];
              console.log(`  🗑️ Removed ${deletedDataNodeID} from charData`);
            }
          });

          // Clear the tracking array
          delete existingRecord._deleted_nodes;
          console.log(`✅ Cleanup complete for hypercite ${hypercite.hyperciteId}`);
        }

        // Update existing record (per-node ranges go to charData below)
        existingRecord.hypercitedText = hypercitedText;
        existingRecord.hypercitedHTML = hypercitedHTML;

        // ✅ NEW: Update NEW schema (node_id array + charData object)
        if (dataNodeID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(dataNodeID)) {
            existingRecord.node_id.push(dataNodeID);
            console.log(`➕ Added node ${dataNodeID} to hypercite ${hypercite.hyperciteId}`);
          }

          // Update charData for this specific node
          existingRecord.charData[dataNodeID] = {
            charStart: hypercite.charStart,
            charEnd: hypercite.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hypercite.hyperciteId}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${dataNodeID}`);
        }

        store.put(existingRecord);
        syncArray.push(existingRecord);

        console.log(`Updated hypercite ${hypercite.hyperciteId} positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      } else {
        // Create new record
        const newRecord: HyperciteRecord = {
          book: bookId,
          hyperciteId: hypercite.hyperciteId,
          hypercitedText: hypercitedText,
          hypercitedHTML: hypercitedHTML,
          citedIN: [],
          relationshipStatus: "single",
          time_since: hypercite.time_since || Math.floor(Date.now() / 1000),
          // ✅ NEW: Initialize NEW schema fields
          node_id: dataNodeID ? [dataNodeID] : [],
          charData: dataNodeID ? {
            [dataNodeID]: {
              charStart: hypercite.charStart,
              charEnd: hypercite.charEnd
            }
          } : {}
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
        if (dataNodeID) {
          console.log(`✅ Initialized NEW schema: node_id=[${dataNodeID}], charData set`);
        }
      }
    };
  });
}
