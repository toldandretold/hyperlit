/**
 * Transient node-ROOT classes — render-only UI state that must NEVER persist.
 *
 * Unlike the navigation classes stripped inside contentProcessor/chunkRender
 * (arrow-target / hypercite-target / hypercite-dimmed), which only ever land on
 * DESCENDANT elements (<a>, <u>, <sup>, <span>), these classes are painted onto
 * the node ROOT element itself — the same <p data-node-id> that carries the
 * persisted content:
 *   - `audio-reading`  — the audio player's currently-reading highlight
 *     (components/audioPlayer/playbackController.ts).
 *   - `cascade-origin` — the highlight-cascade navigation marker
 *     (lazyLoader/index.ts, hyperlights/.../deletion.ts).
 *
 * A node edited (or otherwise re-saved) while it carries one of these classes
 * captures it into `outerHTML` → IndexedDB → Postgres. The descendant-only
 * `querySelectorAll` in the existing strippers can't reach the root, so this
 * leaf exists as the single source of truth used by BOTH the save path
 * (contentProcessor) and the render path (chunkRender), keeping them in sync —
 * the same save/render-mirror concern called out in utilities/stripInlineStyle.
 */

export const TRANSIENT_NODE_CLASSES = ['audio-reading', 'cascade-origin'] as const;

/**
 * Remove every {@link TRANSIENT_NODE_CLASSES} token from `root` AND all of its
 * `[class]` descendants, deleting any now-empty `class` attribute. Returns
 * `true` if at least one transient class was removed (the caller uses this to
 * decide whether a render-time self-heal re-save is warranted).
 */
export function stripTransientNodeClasses(root: Element): boolean {
  let changed = false;

  const strip = (el: Element): void => {
    for (const cls of TRANSIENT_NODE_CLASSES) {
      if (el.classList.contains(cls)) {
        el.classList.remove(cls);
        changed = true;
      }
    }
    // Drop the empty class attribute so we don't persist `class=""`
    // (mirrors the e2ee image cleanup in contentProcessor).
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  };

  strip(root);
  root.querySelectorAll('[class]').forEach(strip);

  return changed;
}
