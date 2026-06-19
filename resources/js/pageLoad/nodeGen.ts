import { asBookId, LATEST, type BookId } from "../indexedDB/types";
/**
 * pageLoad/nodeGen — generate nodes from a book's main-text.md.
 *
 * Self-contained (fetch + parse + persist); imports only convertMarkdown + the IndexedDB save.
 * Extracted out of loadHyperText so lazyLoaderRegistry can import it STATICALLY (downward) — the
 * old lazyLoaderRegistry↔loadHyperText mutual dependency forced a dynamic-import cycle-breaker.
 */
import { saveAllNodesToIndexedDB } from '../indexedDB/index.js';
import { parseMarkdownIntoChunksInitial } from '../utilities/convertMarkdown';
import { verbose } from '../utilities/logger';

// Helper to add cache-busting parameter when needed
function buildUrl(path: string, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

async function fetchMainTextMarkdown(bookId: BookId, forceReload = false) {
  const response = await fetch(buildUrl(`/${bookId}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error(`Failed to fetch main-text.md for ${bookId}`);
  }
  return response.text();
}

export async function generateNodesFromMarkdown(bookId: BookId, forceReload = false) {
  const markdown = await fetchMainTextMarkdown(bookId);

  // Parse markdown into nodes
  const nodes: any = parseMarkdownIntoChunksInitial(markdown);
  verbose.content(`Generated ${nodes.length} nodes from markdown`, 'pageLoad/nodeGen');

  // Pass the callback to the save function
  await saveAllNodesToIndexedDB(nodes, bookId);
  return nodes;
}
