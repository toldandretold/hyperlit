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
export function createNodeKey(bookId: BookId, startLine: string | number): [BookId, number] {
  return [bookId, parseNodeId(startLine)];
}

/**
 * Get localStorage key with book context
 */
export function getLocalStorageKey(baseKey: string, bookId: BookId = LATEST): string {
  return `${baseKey}_${bookId}`;
}

/** The three cron-generated homepage feed books. */
const HOMEPAGE_FEED_BOOKS = new Set(['most-recent', 'most-connected', 'most-lit']);

/** Shelf renders are `shelf_{uuid}_{sort}[_pub]` — anchored on the uuid so a
 *  hypothetical username like "shelf_x" can't false-positive. */
const SHELF_FEED_RE = /^shelf_[0-9a-fA-F-]{36}_/;

/** User-home sorted variants are `{sanitizedUsername}_{visibility}_{sort}`
 *  ('recent' never mints one — it short-circuits to the base book). */
const SORTED_FEED_RE = /_(public|private|all)_(connected|lit|title|author)$/;

/**
 * True for any SERVER-GENERATED synthetic feed book (homepage feeds, shelf
 * renders, user-home sorted variants). These are rebuilt wholesale on the
 * server: never sync them back, never offer them as offline books.
 */
export function isSyntheticFeedBook(bookId: string | null | undefined): boolean {
  if (!bookId) return false;
  return HOMEPAGE_FEED_BOOKS.has(bookId) || SHELF_FEED_RE.test(bookId) || SORTED_FEED_RE.test(bookId);
}

/**
 * True for the current user's regenerated home-book variants
 * ({u}All / {u}Private / {u}Account). These ARE legitimately edited and
 * synced — exclude them only from surfaces where they'd read as ordinary
 * books (e.g. the offline-books list), not from the sync queue.
 */
export function isUserHomeVariantBook(bookId: string | null | undefined, userBaseBook: string | null | undefined): boolean {
  if (!bookId || !userBaseBook) return false;
  return bookId === userBaseBook + 'All'
    || bookId === userBaseBook + 'Private'
    || bookId === userBaseBook + 'Account';
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
