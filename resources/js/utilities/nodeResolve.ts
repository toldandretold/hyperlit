/**
 * nodeResolve — zero-import leaf for mapping an inner DOM element back to the
 * TRUE top-level node element that owns it.
 *
 * A NodeRecord is rendered as a single top-level element (a direct child of a
 * `.chunk`) carrying both the numeric `id` and the stable `data-node-id`.
 *
 * Backend conversion defects can leave PHANTOM nested elements inside a node —
 * e.g. a `<p>` / `<button>` nested inside a `<figure>` (or `<a>`) that wrongly
 * carries its own `id` + `data-node-id`. A plain `closest('[data-node-id]')`
 * then resolves to the INNERMOST phantom instead of the real node, so edits and
 * deletions target a ghost record while the real node is never touched (the
 * broken-image-delete bug: the image returned on refresh).
 *
 * `resolveTopLevelNode` walks to the OUTERMOST `[data-node-id]` ancestor that is
 * still inside `container`, i.e. the real NodeRecord element. With no phantoms
 * present it returns exactly what `closest('[data-node-id]')` would.
 */
export function resolveTopLevelNode(
  el: Element | null,
  container: Element | null = null,
): HTMLElement | null {
  if (!el) return null;

  let outermost: HTMLElement | null = null;
  let current: Element | null = el.closest('[data-node-id]');

  while (current && (!container || container.contains(current))) {
    outermost = current as HTMLElement;
    const parent = current.parentElement;
    current = parent ? parent.closest('[data-node-id]') : null;
  }

  return outermost;
}

/** Pure-numeric (decimal-shaped) DOM id, e.g. "1" or "100.5" — a line id. */
const NUMERIC_LINE_ID = /^\d+(\.\d+)?$/;

/**
 * Strip PHANTOM identity attributes (numeric `id`, any `data-node-id`) from the
 * descendants of a resolved top-level node, leaving the node element itself
 * untouched. Meaningful descendant ids (footnote anchors `Fn…`, `hypercite_…`,
 * etc.) are kept — only pure-numeric ids are removed, mirroring the backend's
 * `id.isdigit()` strip. Use after structurally editing a node (e.g. deleting a
 * broken image) so the persisted content is a single clean node.
 */
export function stripPhantomDescendantIds(node: HTMLElement | null): void {
  if (!node) return;
  node.querySelectorAll('[id], [data-node-id]').forEach((desc) => {
    if (desc === node) return;
    const id = desc.getAttribute('id');
    if (id && NUMERIC_LINE_ID.test(id)) desc.removeAttribute('id');
    desc.removeAttribute('data-node-id');
  });
}
