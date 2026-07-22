/**
 * measure — real node heights for the custom scrollbar's virtual axis.
 *
 * The height ESTIMATOR (virtualMap.ts) runs ~±20% off reality, which made the
 * thumb proportions approximate and forced the minimap's landing band to
 * under-promise. This module replaces estimates with REAL pixel heights from
 * two collectors, cached in memory (nothing stays rendered — memory flat):
 *
 *  1. Live harvest — chunks the reader has actually rendered are measured in
 *     place (free, exact, includes loaded images).
 *  2. Idle offscreen sweep — unvisited chunks are rendered ONCE into a hidden
 *     body-level container at the live column width, measured, and discarded.
 *
 * HARD CONSTRAINT on the sweep: append → render → measure → remove happens
 * SYNCHRONOUSLY within one task. Destructive document-global queries exist
 * (`document.querySelectorAll('.main-content').forEach(el => el.remove())` in
 * contentSwapHelpers/homepageHero, and app boot reads `.main-content` dataset)
 * — the hidden copy must never survive into a turn of the event loop.
 *
 * Image-bearing nodes are never measured offscreen (a hidden <img src> still
 * fetches, and unloaded images measure wrong): their src attributes are
 * neutered in the offscreen copy and their measurements discarded — the
 * estimator keeps covering them until the live harvest sees them rendered.
 */

import type { NodeRecord } from '../../indexedDB/types';
import { verbose } from '../../utilities/logger';

/** measured height per node, keyed by (startLine, content length, layout width/font). */
const cache = new Map<string, number>();

/**
 * Chunks the offscreen sweep has already rendered+measured, keyed
 * `${widthKey}|${chunkId}`. A chunk whose node(s) yield no measurement (empty
 * render, zero height) would otherwise qualify as "unmeasured" on every
 * restarted sweep and be re-rendered forever — one attempt per layout is
 * enough; unmeasured nodes stay covered by the estimator (like image nodes).
 */
const sweptChunks = new Set<string>();

export function makeWidthKey(contentWidth: number, fontSize: number): string {
  return `${Math.round(contentWidth)}x${Math.round(fontSize * 10)}`;
}

function nodeKey(node: NodeRecord, widthKey: string): string {
  const len = typeof node.content === 'string' ? node.content.length : 0;
  return `${node.startLine}|${len}|${widthKey}`;
}

export function heightLookup(widthKey: string): (node: NodeRecord) => number | undefined {
  return (node) => cache.get(nodeKey(node, widthKey));
}

export function measuredCount(): number {
  return cache.size;
}

export function clearMeasurements(): void {
  cache.clear();
  sweptChunks.clear();
}

interface NodeSpan {
  node: NodeRecord;
  /** The node's sibling elements in the chunk (first carries id=startLine). */
  elements: HTMLElement[];
  top: number;
}

/**
 * Group a rendered chunk's children into per-node spans. A node's FIRST
 * element carries id=startLine; its remaining elements follow as id-less
 * siblings until the next id-bearing child.
 */
function groupNodeSpans(chunkEl: HTMLElement, nodes: readonly NodeRecord[]): NodeSpan[] {
  const byId = new Map<string, NodeRecord>();
  for (const n of nodes) byId.set(String(n.startLine), n);

  const chunkTop = chunkEl.getBoundingClientRect().top;
  const spans: NodeSpan[] = [];
  let current: NodeSpan | null = null;
  for (const child of Array.from(chunkEl.children) as HTMLElement[]) {
    const node = child.id ? byId.get(child.id) : undefined;
    if (node) {
      current = { node, elements: [child], top: child.getBoundingClientRect().top - chunkTop };
      spans.push(current);
    } else if (current) {
      current.elements.push(child);
    }
  }
  return spans;
}

/**
 * Store per-node heights from successive span tops (captures inter-node
 * margins, which is what the stacked virtual axis needs). Returns entries
 * added; `skipIncompleteImages` nodes are left for a later retry.
 */
function storeSpanHeights(
  spans: NodeSpan[],
  chunkHeight: number,
  widthKey: string,
  opts: { skipImageNodes?: boolean; skipIncompleteImages?: boolean },
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (!span) continue;
    const hasImg = span.elements.some((el) => el.querySelector('img') || el.tagName === 'IMG');
    if (hasImg && opts.skipImageNodes) {
      skipped++;
      continue;
    }
    if (
      hasImg &&
      opts.skipIncompleteImages &&
      span.elements.some((el) =>
        Array.from(el.querySelectorAll<HTMLImageElement>('img')).some((img) => !img.complete),
      )
    ) {
      skipped++;
      continue;
    }
    const nextTop = spans[i + 1]?.top ?? chunkHeight;
    const height = nextTop - span.top;
    if (height > 0 && Number.isFinite(height)) {
      cache.set(nodeKey(span.node, widthKey), height);
      added++;
    }
  }
  return { added, skipped };
}

/**
 * Measure a chunk the reader has ALREADY rendered, in place. Exact (real
 * layout, loaded images). Returns {added, skipped} — skipped > 0 means some
 * images were still loading; harvest again later.
 */
export function harvestLiveChunk(
  chunkEl: HTMLElement,
  nodes: readonly NodeRecord[],
  widthKey: string,
): { added: number; skipped: number } {
  const spans = groupNodeSpans(chunkEl, nodes);
  return storeSpanHeights(spans, chunkEl.getBoundingClientRect().height, widthKey, {
    skipIncompleteImages: true,
  });
}

const IMG_SRC_RE = /(<img\b[^>]*?)\s(?:src|srcset)=("[^"]*"|'[^']*')/gi;

function neuterImageSources(content: string): string {
  return content.replace(IMG_SRC_RE, '$1 data-measure-src=$2');
}

// ── idle offscreen sweep ────────────────────────────────────────────────────

export interface SweepOptions {
  nodes: readonly NodeRecord[];
  /** Ascending chunk ids (virtualMap.chunkIdsSorted). */
  chunkIdsSorted: readonly number[];
  /** Sweep outward from here (the current reading chunk). */
  currentChunkId: number;
  bookId: string;
  /** Live main-content border-box width, px — the hidden copy's width. */
  containerWidth: number;
  widthKey: string;
  /** Called after each measured chunk with the running total of new entries. */
  onProgress: (addedSoFar: number) => void;
}

let sweepGeneration = 0;

export function stopIdleSweep(): void {
  sweepGeneration++;
}

function idle(fn: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}

/**
 * Sweep every not-yet-measured chunk, one per idle slice, nearest-first.
 * Each slice is fully synchronous (see module header for why).
 */
export async function startIdleSweep(opts: SweepOptions): Promise<void> {
  const generation = ++sweepGeneration;

  // Load the real render path up front so the slices themselves stay sync.
  const { createChunkElement } = await import('../../lazyLoader/chunkRender');
  if (generation !== sweepGeneration) return;

  const byChunk = new Map<number, NodeRecord[]>();
  for (const n of opts.nodes) {
    const id = Number(n.chunk_id);
    const list = byChunk.get(id);
    if (list) list.push(n);
    else byChunk.set(id, [n]);
  }

  const queue = [...opts.chunkIdsSorted].sort(
    (a, b) => Math.abs(a - opts.currentChunkId) - Math.abs(b - opts.currentChunkId),
  );
  const lookup = heightLookup(opts.widthKey);
  let addedTotal = 0;

  const step = (): void => {
    if (generation !== sweepGeneration) return;
    // Next not-yet-swept chunk with at least one unmeasured, non-image node.
    let chunkNodes: NodeRecord[] | null = null;
    let chunkKey: string | null = null;
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      const key = `${opts.widthKey}|${id}`;
      if (sweptChunks.has(key)) continue;
      const candidates = byChunk.get(id);
      if (!candidates) continue;
      if (
        candidates.some(
          (n) => lookup(n) === undefined && !(typeof n.content === 'string' && n.content.includes('<img')),
        )
      ) {
        chunkNodes = candidates;
        chunkKey = key;
        break;
      }
    }
    if (!chunkNodes) {
      verbose.content(`height sweep done: ${addedTotal} nodes measured (${cache.size} cached)`, 'components/customScrollbar/measure');
      return;
    }

    // ── synchronous slice: mount, render, measure, unmount ──
    const root = document.createElement('div');
    root.className = 'main-content';
    root.style.cssText = `position:absolute;left:-99999px;top:0;width:${opts.containerWidth}px;visibility:hidden;contain:layout style;`;
    let added = 0;
    try {
      const neutered = chunkNodes.map((n) => ({
        ...n,
        content: typeof n.content === 'string' ? neuterImageSources(n.content) : n.content,
      }));
      // offscreen: throwaway copy — render must be side-effect-free (no footnote
      // self-heal write-backs; see chunkRender's applyDynamicFootnoteNumbers call).
      const chunkEl = createChunkElement(neutered as NodeRecord[], { bookId: opts.bookId, offscreen: true }) as HTMLElement;
      chunkEl.removeAttribute('data-chunk-id');
      root.appendChild(chunkEl);
      document.body.appendChild(root);
      const spans = groupNodeSpans(chunkEl, chunkNodes);
      ({ added } = storeSpanHeights(spans, chunkEl.getBoundingClientRect().height, opts.widthKey, {
        skipImageNodes: true, // srcs are neutered — an unloaded <img> measures wrong
      }));
      addedTotal += added;
    } finally {
      root.remove(); // NEVER survives the task — destructive .main-content queries exist
      if (chunkKey) sweptChunks.add(chunkKey); // attempted, measured or not — never re-render it
    }

    if (added > 0) opts.onProgress(addedTotal); // a no-gain slice must not schedule another rebuild→sweep round
    idle(step);
  };

  idle(step);
}
