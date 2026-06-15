/**
 * pageLoad/nodeGen — generate node chunks from a book's main-text.md.
 *
 * Self-contained (fetch + parse + persist); imports only convertMarkdown + the IndexedDB save.
 * Extracted out of loadHyperText so lazyLoaderRegistry can import it STATICALLY (downward) — the
 * old lazyLoaderRegistry↔loadHyperText mutual dependency forced a dynamic-import cycle-breaker.
 */
import { saveAllNodeChunksToIndexedDB } from '../indexedDB/index.js';
import { parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown.js';
import { verbose } from '../utilities/logger.js';

// Helper to add cache-busting parameter when needed
function buildUrl(path: string, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

async function fetchMainTextMarkdown(bookId: string, forceReload = false) {
  const response = await fetch(buildUrl(`/${bookId}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error(`Failed to fetch main-text.md for ${bookId}`);
  }
  return response.text();
}

export async function generateNodeChunksFromMarkdown(bookId: string, forceReload = false) {
  const markdown = await fetchMainTextMarkdown(bookId);

  // Parse markdown into nodes
  const nodes: any = parseMarkdownIntoChunksInitial(markdown);
  verbose.content(`Generated ${nodes.length} nodes from markdown`, 'pageLoad/nodeGen');

  // Pass the callback to the save function
  await saveAllNodeChunksToIndexedDB(nodes, bookId);
  return nodes;
}
