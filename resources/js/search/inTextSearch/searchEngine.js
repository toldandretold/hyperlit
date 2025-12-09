// searchEngine.js - Core search functionality for in-page search

import { verbose } from "../../utilities/logger.js";

/**
 * Strip HTML tags from content and return plain text
 * @param {string} html - HTML content string
 * @returns {string} Plain text without HTML tags
 */
export function stripHtml(html) {
  if (!html) return '';

  // Use DOM parsing for accurate text extraction
  const temp = document.createElement('div');
  temp.innerHTML = html;
  return temp.textContent || temp.innerText || '';
}

/**
 * Normalize text for search comparison
 * - Lowercase for case-insensitive search
 * - Collapse multiple whitespace to single space
 * - Trim leading/trailing whitespace
 * @param {string} text - Text to normalize
 * @returns {string} Normalized text
 */
export function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a search index from an array of nodes
 * @param {Array} nodes - Array of node objects from IndexedDB
 * @returns {Array} Search index with startLine, chunk_id, and normalized text
 */
export function buildSearchIndex(nodes) {
  if (!nodes || nodes.length === 0) {
    verbose.init('SearchEngine: No nodes to index', '/search/inTextSearch/searchEngine.js');
    return [];
  }

  const startTime = performance.now();

  const index = nodes.map(node => {
    const plainText = stripHtml(node.content);
    const normalizedText = normalizeText(plainText);

    return {
      startLine: node.startLine,
      chunk_id: node.chunk_id,
      text: normalizedText,
      originalLength: plainText.length
    };
  });

  const elapsed = performance.now() - startTime;
  verbose.init(`SearchEngine: Built index for ${nodes.length} nodes in ${elapsed.toFixed(1)}ms`, '/search/inTextSearch/searchEngine.js');

  return index;
}

/**
 * Find all occurrences of query in a single node's text
 * @param {string} text - Normalized text to search
 * @param {string} query - Normalized query string
 * @param {number} startLine - Node's startLine
 * @param {number} chunk_id - Node's chunk_id
 * @returns {Array} Array of match objects with charStart/charEnd
 */
function findMatchesInNode(text, query, startLine, chunk_id) {
  const matches = [];
  let pos = 0;

  while ((pos = text.indexOf(query, pos)) !== -1) {
    matches.push({
      startLine,
      chunk_id,
      charStart: pos,
      charEnd: pos + query.length
    });
    pos += 1; // Move forward to find overlapping matches
  }

  return matches;
}

/**
 * Search the index for matches with character positions
 * @param {Array} index - Search index built by buildSearchIndex
 * @param {string} query - Search query string
 * @returns {Array} Array of match objects with startLine, chunk_id, charStart, charEnd
 */
export function searchIndex(index, query) {
  if (!index || index.length === 0 || !query) {
    return [];
  }

  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    return [];
  }

  const allMatches = [];

  for (const entry of index) {
    const nodeMatches = findMatchesInNode(
      entry.text,
      normalizedQuery,
      entry.startLine,
      entry.chunk_id
    );
    allMatches.push(...nodeMatches);
  }

  verbose.init(`SearchEngine: Found ${allMatches.length} matches for "${query}"`, '/search/inTextSearch/searchEngine.js');

  return allMatches;
}
