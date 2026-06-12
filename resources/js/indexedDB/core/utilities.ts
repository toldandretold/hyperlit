/**
 * Database Utility Functions
 * Helper functions used across database operations
 */

import type { BookId, NodeRecord, PublicChunk } from '../types';

/**
 * Parse node ID to appropriate numeric format
 * Converts string IDs like "1.5" to numbers, preserving decimals
 *
 * NOTE: garbage input maps to 0, never NaN — validate ids BEFORE calling this
 * (see NUMERIC_NODE_ID in nodes/batch.js).
 */
export function parseNodeId(id: string | number): number {
  if (typeof id === "number") return id;
  const parsed = parseFloat(id);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Create a composite key for nodes store
 */
export function createNodeChunksKey(bookId: BookId, startLine: string | number): [BookId, number] {
  return [bookId, parseNodeId(startLine)];
}

/**
 * Get localStorage key with book context
 */
export function getLocalStorageKey(baseKey: string, bookId: BookId = "latest"): string {
  return `${baseKey}_${bookId}`;
}

/**
 * Convert internal chunk format to public-facing format — the on-the-wire
 * node shape (see UnifiedSyncPayload in types.ts). Legacy records may lack
 * the array fields / chunk_id, hence the runtime fallbacks.
 */
export function toPublicChunk(chunk: NodeRecord | PublicChunk | null | undefined): PublicChunk | null {
  if (!chunk) return null;

  const result: PublicChunk = {
    book: chunk.book,
    startLine: chunk.startLine,
    node_id: chunk.node_id ?? null, // ✅ Include node_id for renumbering support
    content: chunk.content,
    hyperlights: chunk.hyperlights || [],
    hypercites: chunk.hypercites || [],
    footnotes: chunk.footnotes || [],
    chunk_id: chunk.chunk_id ?? 0  // ✅ Default to 0 when undefined (PostgreSQL NOT NULL constraint)
  };

  return result;
}
