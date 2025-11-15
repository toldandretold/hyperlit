/**
 * Database Utility Functions
 * Helper functions used across database operations
 */

/**
 * Simple debounce utility
 * @param {Function} func - Function to debounce
 * @param {number} wait - Debounce delay in milliseconds
 * @returns {Function} Debounced function with flush method
 */
export function debounce(func, wait = 3000) {
  let timeout;
  const debounced = (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
  debounced.flush = () => {
    clearTimeout(timeout);
    func();
  };
  return debounced;
}

/**
 * Parse node ID to appropriate numeric format
 * Converts string IDs like "1.5" to numbers, preserving decimals
 *
 * @param {string|number} id - The node ID to parse
 * @returns {number} Parsed numeric ID
 */
export function parseNodeId(id) {
  if (typeof id === "number") return id;
  const parsed = parseFloat(id);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Create a composite key for nodes store
 * @param {string} bookId - The book identifier
 * @param {string|number} startLine - The starting line/node ID
 * @returns {Array} Composite key [bookId, startLine]
 */
export function createNodeChunksKey(bookId, startLine) {
  return [bookId, parseNodeId(startLine)];
}

/**
 * Get localStorage key with book context
 * @param {string} baseKey - Base key name
 * @param {string} bookId - Book identifier
 * @returns {string} Namespaced localStorage key
 */
export function getLocalStorageKey(baseKey, bookId = "latest") {
  return `${baseKey}_${bookId}`;
}

/**
 * Convert internal chunk format to public-facing format
 * @param {Object} chunk - Internal chunk object
 * @returns {Object} Public chunk format
 */
export function toPublicChunk(chunk) {
  if (!chunk) return null;

  return {
    book: chunk.book,
    startLine: chunk.startLine,
    node_id: chunk.node_id ?? null, // ✅ Include node_id for renumbering support
    content: chunk.content,
    hyperlights: chunk.hyperlights || [],
    hypercites: chunk.hypercites || [],
    footnotes: chunk.footnotes || null,
    chunk_id: chunk.chunk_id ?? 0  // ✅ Default to 0 when undefined (PostgreSQL NOT NULL constraint)
  };
}
