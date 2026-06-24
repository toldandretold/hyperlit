import { parseChunkId, type ChunkId, type BookId, type NodeRecord } from '../indexedDB/types';
import { renderMathElements, normalizeHyperciteElements, ensureNoDeleteMarkerForBook } from './chunkRender';
import { renderCharts } from './chartRenderer';
import { handleBrokenImages } from './imageState';
import { applyDynamicFootnoteNumbers } from './footnoteSelfHeal';
import { verbose, log } from '../utilities/logger';

/**
 * Adopt the server-rendered first chunk instead of re-rendering it (Phase 2).
 *
 * `reader.blade.php` injects the chunk the server determined the client will load first, as the
 * REAL chunk element: `<div class="chunk" data-chunk-id="N" data-prerendered="true">…nodes…</div>`.
 * Because `renderBlockToHtml()` is a pure pass-through, that DOM IS exactly what the client would
 * have produced for the node CONTENT — what it lacks is the per-user, client-only layer that
 * `createChunkElement` normally adds: annotations (gate-filtered, so they MUST stay client-side),
 * dynamic footnote numbers, KaTeX/charts/broken-image handling, and listeners.
 *
 * So we ADOPT: keep the server DOM, run only those client-only passes on top, register the chunk
 * as loaded (`currentlyLoadedChunks`) so `loadChunkInternal` skips re-rendering it, and let the
 * lazy loader continue from there. Mirrors the post-insert half of `loadChunkInternal`.
 *
 * Best-effort: on ANY failure the prerendered element is removed and we return null, so the normal
 * render path takes over cleanly (no duplicate DOM). Returns the adopted chunk id, or null if there
 * was nothing to adopt / adoption failed.
 */
export async function adoptPrerenderedChunk(instance: any, bookId: BookId): Promise<ChunkId | null> {
  const container: HTMLElement | null = instance?.container ?? null;
  if (!container) return null;

  const el = container.querySelector(':scope > .chunk[data-prerendered]') as HTMLElement | null
    || container.querySelector('.chunk[data-prerendered]') as HTMLElement | null;
  if (!el) return null;

  try {
    const chunkId = parseChunkId(el.getAttribute('data-chunk-id')!);

    // The node records for this chunk (carry hyperlights/hypercites arrays already — set by the
    // IDB-cache hydration or the initial fetch before initializeLazyLoader runs).
    const chunkNodes: NodeRecord[] = (instance.nodes || [])
      .filter((n: any) => n.chunk_id === chunkId)
      .sort((a: any, b: any) => Number(a.startLine) - Number(b.startLine));

    if (chunkNodes.length === 0) {
      // No matching records — can't safely annotate/register. Discard, render normally.
      el.remove();
      return null;
    }

    // Ensure each node element carries id=startLine + data-node-id (usually already baked into
    // the stored content; mirror createChunkElement's defensive set). Positional zip when the
    // child count lines up; otherwise rely on ids already present in the content.
    const childEls = Array.from(el.children) as HTMLElement[];
    if (childEls.length === chunkNodes.length) {
      childEls.forEach((child, i) => {
        const node: any = chunkNodes[i];
        if (!child.getAttribute('id')) child.setAttribute('id', String(node.startLine));
        if (node.node_id && !child.getAttribute('data-node-id')) {
          child.setAttribute('data-node-id', node.node_id);
        }
      });
    }

    // 1) Apply per-user annotations (highlights + hypercites) onto the live DOM. This is the
    //    same function the annotation-only refresh uses; it reads each node's hyperlights/
    //    hypercites from the passed records, wraps <mark>/<u>, and re-attaches their listeners.
    const nodeIds = chunkNodes.map((n: any) => String(n.startLine));
    const { reprocessHighlightsForNodes } = await import('../hyperlights/deletion');
    await reprocessHighlightsForNodes(bookId, nodeIds, chunkNodes as any);

    // 2) Dynamic footnote numbers (idempotent), per node element.
    childEls.forEach((child) => {
      applyDynamicFootnoteNumbers(child, { startLine: child.getAttribute('id') || undefined, bookId });
    });

    // 3) Client-only rendering passes (run once, exactly as on a normal render).
    renderMathElements(el);
    renderCharts(el);
    handleBrokenImages(el);
    normalizeHyperciteElements(el);

    // 4) Listeners scoped to this chunk (idempotent — remove+re-add), matching loadChunkInternal.
    instance.attachMarkListeners?.(el);
    instance.attachUnderlineClickListeners?.(el);

    // 5) No-delete marker contract (async, fire-and-forget — same as loadChunkInternal).
    ensureNoDeleteMarkerForBook(el, instance.nodes).catch((err: any) =>
      console.error('Failed to ensure no-delete-id marker (adopted chunk):', err)
    );

    // 6) Register as loaded so loadChunkInternal early-exits for it (no re-render), and the
    //    IntersectionObserver lazy-loads the neighbours normally.
    instance.currentlyLoadedChunks.add(chunkId);
    el.removeAttribute('data-prerendered');

    // 7) Fire the first-chunk callback once (mirrors loadChunkInternal).
    if (typeof instance.onFirstChunkLoadedCallback === 'function') {
      instance.onFirstChunkLoadedCallback();
      instance.onFirstChunkLoadedCallback = null;
    }

    log.content(`Adopted server-rendered chunk #${chunkId} (${chunkNodes.length} nodes, no re-render)`, 'adoptPrerenderedChunk.ts');
    return chunkId;
  } catch (err) {
    // Any failure → discard the server DOM and let the normal render path run.
    verbose.content(`Adoption failed, falling back to normal render: ${(err as any)?.message}`, 'adoptPrerenderedChunk.ts');
    try { el.remove(); } catch { /* already detached */ }
    return null;
  }
}
