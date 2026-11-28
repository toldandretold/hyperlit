/** Shared mutable state for sub-book loaders — isolated to guarantee no TDZ. */
export const subBookLoaders = new Map<string, any>();
export const enrichedSubBooks = new Set<string>();

/** A node a read-mode sub-book rendered from its parent record's `preview_nodes`. */
export interface PreviewSourceNode {
  node_id: string;
  content: string;
}

/**
 * The preview nodes a sub-book is STILL showing, or null once it is not a preview.
 *
 * A read-mode sub-book (subBookLoader's preview branch) renders from the parent
 * record's `preview_nodes`, which never pass through IndexedDB — so until enrichment
 * lands the full nodes (or never, when the server holds no such sub-book: a tab
 * carrying a footnote record from a superseded conversion), those DOM nodes are
 * legitimately absent from IDB. The integrity sweep uses this to tell an untouched
 * preview apart from a lost edit. `previewNodeIds` is cleared by "[read more]",
 * after which the loader renders real IDB nodes and this returns null.
 */
export function previewSourceFor(subBookId: string): PreviewSourceNode[] | null {
  const loader = subBookLoaders.get(subBookId)?.loader;
  const ids: unknown = loader?.previewNodeIds;
  if (!Array.isArray(ids) || ids.length === 0 || !Array.isArray(loader?.nodes)) return null;
  const wanted = new Set(ids);
  const nodes = (loader.nodes as any[])
    .filter((n) => n && wanted.has(n.node_id) && typeof n.content === 'string')
    .map((n) => ({ node_id: String(n.node_id), content: n.content as string }));
  return nodes.length ? nodes : null;
}
