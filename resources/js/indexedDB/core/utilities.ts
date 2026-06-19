/**
 * Database Utility Functions
 * Helper functions used across database operations
 */

import { LATEST, type BookId, type NodeRecord, type PublicNode } from '../types';

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
export function getLocalStorageKey(baseKey: string, bookId: BookId = LATEST): string {
  return `${baseKey}_${bookId}`;
}

/**
 * Convert an internal NodeRecord to its public-facing, on-the-wire NODE shape
 * (see UnifiedSyncPayload in types.ts). Legacy records may lack the array fields /
 * chunk_id, hence the runtime fallbacks.
 */
export function toPublicNode(node: NodeRecord | PublicNode | null | undefined): PublicNode | null {
  if (!node) return null;

  const result: PublicNode = {
    book: node.book,
    startLine: node.startLine,
    node_id: node.node_id ?? null, // ✅ Include node_id for renumbering support
    content: node.content,
    hyperlights: node.hyperlights || [],
    hypercites: node.hypercites || [],
    footnotes: node.footnotes || [],
    chunk_id: node.chunk_id ?? 0  // ✅ Default to 0 when undefined (PostgreSQL NOT NULL constraint)
  };

  return result;
}
