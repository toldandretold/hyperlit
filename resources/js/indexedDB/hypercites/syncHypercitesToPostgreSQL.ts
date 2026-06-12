/**
 * Hypercites PostgreSQL Sync Module
 * Syncs hypercite operations from IndexedDB to PostgreSQL
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CRITICAL ARCHITECTURE: DUAL STORAGE & ATOMIC TRANSACTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DUAL STORAGE PATTERN:
 * Hypercites are stored in TWO places in PostgreSQL for performance:
 *
 * 1. `hypercites` table - Standalone records
 *    - Columns: book, hyperciteId, citedIN (array), relationshipStatus
 *    - Used for: Direct hypercite lookups, citation queries
 *
 * 2. `node_chunks` table - Embedded in JSON `hypercites` array
 *    - Structure: Each nodeChunk has `hypercites: [{hyperciteId, citedIN, relationshipStatus, ...}]`
 *    - Used for: Fast lazy loading without JOIN operations
 *
 * This denormalization trades storage for performance during document rendering.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY UNIFIED ATOMIC TRANSACTIONS ARE REQUIRED:
 * ───────────────────────────────────────────────────────────────────────────
 *
 * When a hypercite relationship changes (citation added/removed), BOTH storage
 * locations must update atomically. Using separate API calls creates race conditions:
 *
 * ❌ WRONG: Separate API Calls
 *    POST /api/db/hypercites/upsert        → Updates hypercites table
 *    POST /api/db/node-chunks/targeted-upsert → Updates node_chunks table
 *    Problem: If first succeeds but second fails, data becomes inconsistent
 *
 * ✅ CORRECT: Unified Transaction
 *    POST /api/db/unified-sync with BOTH hypercite + nodeChunk
 *    → UnifiedSyncController wraps in DB::transaction()
 *    → Both tables update or both rollback (atomic)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHEN TO USE IMMEDIATE SYNC vs DEBOUNCED SYNC:
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Use IMMEDIATE sync for:
 * ✅ Citation pasting (bidirectional linking must work cross-device immediately)
 * ✅ Citation deletion (prevents users clicking on dead links after deletion)
 * ✅ Any operation requiring instant cross-device consistency
 *
 * Use DEBOUNCED sync for:
 * ✅ Content editing (text changes don't need instant server sync)
 * ✅ Highlight creation (local-first, sync in background)
 * ✅ Bulk operations (batch many changes into one request)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FUNCTION GUIDE:
 * ───────────────────────────────────────────────────────────────────────────
 *
 * syncHyperciteWithNodeChunkImmediately(book, hypercite, nodeChunk)
 *   → Use for: Paste operations, deletion operations
 *   → Endpoint: POST /api/db/unified-sync
 *   → Transaction: Atomic (both tables or neither)
 *   → Timing: Immediate (bypasses 3-second debounce)
 *
 * syncHyperciteToPostgreSQL(hypercites)
 *   → Use for: Batch operations during debounced sync
 *   → Endpoint: POST /api/db/hypercites/upsert
 *   → Transaction: Hypercites table only
 *   → Timing: Called by debouncedMasterSync
 *
 * syncHyperciteUpdateImmediately(book, hyperciteId, updatedFields)
 *   → Use for: DEPRECATED - only updates hypercites table
 *   → Problem: Does not update node_chunks, causes inconsistency
 *   → Migration: Replace with syncHyperciteWithNodeChunkImmediately()
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BookId, HyperciteRecord, NodeRecord, PublicChunk } from '../types';

interface HyperciteSyncResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

/**
 * Sync hypercites to PostgreSQL.
 * NOTE: regenerates each record's hypercitedHTML from id + relationshipStatus
 * + hypercitedText (pinned in hypercites.test.js — stale stored HTML is replaced).
 */
export async function syncHyperciteToPostgreSQL(hypercites: HyperciteRecord[]): Promise<HyperciteSyncResult> {
  if (!hypercites || hypercites.length === 0) return { success: true };

  // All hypercites in a batch should be from the same book
  const bookId = hypercites[0]!.book;

  const payload = {
    book: bookId,
    data: hypercites.map(hc => ({
      ...hc,
      hypercitedHTML: `<u id="${hc.hyperciteId}" class="${hc.relationshipStatus}">${hc.hypercitedText}</u>`
    }))
  };

  console.log(`🔄 Syncing ${hypercites.length} hypercites…`);
  console.log('🔍 Payload being sent:', JSON.stringify(payload, null, 2));

  const res = await fetch("/api/db/hypercites/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrfToken()
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Hypercite synced:", out);
  return out;
}

/**
 * Sync a single hypercite update immediately (bypass queue)
 * Used for critical updates that need immediate persistence
 *
 * @deprecated only updates the hypercites table — use
 * syncHyperciteWithNodeChunkImmediately() so node_chunks stays consistent.
 */
export async function syncHyperciteUpdateImmediately(
  book: BookId,
  hyperciteId: string,
  updatedFields: Partial<HyperciteRecord>,
): Promise<HyperciteSyncResult> {
  console.log(`🚀 IMMEDIATE sync for hypercite ${hyperciteId}...`);

  const payload = {
    book,
    data: [{
      ...updatedFields,
      hyperciteId,
      book,
      hypercitedHTML: updatedFields.hypercitedHTML || `<u id="${hyperciteId}" class="${updatedFields.relationshipStatus}">${updatedFields.hypercitedText}</u>`
    }]
  };

  const res = await fetch("/api/db/hypercites/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrfToken()
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Immediate hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Immediate hypercite sync completed:", out);
  return out;
}

/**
 * Sync hypercite AND its parent nodeChunk in one atomic transaction
 * Uses the unified sync endpoint to ensure both tables update together.
 *
 * NOTE: this payload is NARROWER than master.js's executeSyncPayload — it has
 * no footnotes/footnoteDeletions/bibliography/bibliographyDeletions keys
 * (pinned in hypercites.test.js).
 */
export async function syncHyperciteWithNodeChunkImmediately(
  book: BookId,
  hypercite: HyperciteRecord,
  nodeChunk: NodeRecord | PublicChunk,
): Promise<HyperciteSyncResult> {
  console.log(`🚀 UNIFIED IMMEDIATE sync for hypercite ${hypercite.hyperciteId} with nodeChunk ${nodeChunk.startLine}...`);

  // Prepare hypercite payload
  const hypercitePayload = {
    ...hypercite,
    hypercitedHTML: hypercite.hypercitedHTML || `<u id="${hypercite.hyperciteId}" class="${hypercite.relationshipStatus}">${hypercite.hypercitedText}</u>`
  };

  // Prepare unified sync payload (same format as executeSyncPayload in master.js)
  const unifiedPayload = {
    book,
    nodes: [nodeChunk],
    hypercites: [hypercitePayload],
    hyperlights: [],
    hyperlightDeletions: [],
    library: null
  };

  console.log('🔍 Unified payload:', JSON.stringify(unifiedPayload, null, 2));

  const res = await fetch("/api/db/unified-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrfToken()
    },
    credentials: "include",
    body: JSON.stringify(unifiedPayload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Unified immediate sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Unified immediate sync completed (hypercite + nodeChunk in one transaction):", out);
  return out;
}
