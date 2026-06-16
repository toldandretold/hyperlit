// chunkState — zero-import leaf of chunk bookkeeping. Deliberately OUTSIDE divEditor/ so the (lazy,
// edit-only) divEditor folder has NO module that eager/paste code must statically import — keeping the
// editor chunk a clean, purely-dynamically-reached lazy chunk. These are pure data/DOM-read primitives
// (a running node count, a constant, a caret→chunk lookup), not "editing". divEditor/chunkManager
// re-exports them for its internal callers.

// Running count of numeric-id nodes per chunk (mutated in place by chunkManager — shared singleton).
export const chunkNodeCounts: Record<string, number> = {};

// Max numeric-id nodes per chunk before it must be split.
export const NODE_LIMIT = 100;

// Returns the id STRING of the `.chunk` the caret is currently in, or null.
export function getCurrentChunk(): string | null {
  const selection = document.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const node: Node = range.startContainer;
    const el: Element | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const chunkElement = el?.closest<HTMLElement>(".chunk");
    return chunkElement ? (chunkElement.id || chunkElement.dataset.chunkId || null) : null;
  }
  return null;
}
