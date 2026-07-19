/**
 * virtualMap — the custom scrollbar's whole-book coordinate space.
 *
 * The DOM only ever holds a sliding window of chunks (MAX_LOADED_CHUNKS in
 * lazyLoader/utilities/windowChunks.ts), so the scroll container's geometry can
 * never represent "position in book". This module builds a VIRTUAL pixel space
 * covering every downloaded node from `instance.nodes` alone — no DOM reads, no
 * rendering — by ESTIMATING each node's height from its tag + text length.
 *
 * Estimates only need to be proportional, not exact: the thumb-sync in index.ts
 * re-anchors real→virtual at every chunk boundary, so per-node error never
 * accumulates into drift. The same pass precomputes the minimap render list
 * (shape kind, line count, heading text, mark counts) so the canvas popup never
 * touches node HTML at draw time.
 *
 * Pure + DOM-free on purpose: unit-tested in tests/javascript/customScrollbar/.
 */

import type { NodeRecord } from '../../indexedDB/types';

export interface VirtualMapMetrics {
  /** Rendered line-height of body text, px. */
  lineHeight: number;
  /** Estimated characters per body-text line at the current content width/font. */
  charsPerLine: number;
  /** Vertical margin around a block element (≈1em), px. */
  blockMargin: number;
}

export type MinimapKind =
  | 'heading'
  | 'para'
  | 'quote'
  | 'list'
  | 'table'
  | 'figure'
  | 'code'
  | 'rule';

export interface MinimapNode {
  kind: MinimapKind;
  /** Heading level 1-6 (headings only). */
  level?: number;
  /** Tag-stripped, truncated heading text (h1-h3 only) — drawn as mini text. */
  headingText?: string;
  /** Estimated rendered line count (rows of shape-lines in the minimap). */
  lineCount: number;
  lightCount: number;
  citeCount: number;
}

export interface ChunkBound {
  /** Index into the sorted node arrays of the chunk's first node. */
  startIdx: number;
  /** Exclusive end index. */
  endIdx: number;
  /** Virtual top of the chunk's first node. */
  vStart: number;
  /** Virtual bottom of the chunk's last node. */
  vEnd: number;
}

export interface VirtualMap {
  /** length n+1; offsets[i] = virtual top of node i, offsets[n] = totalHeight. */
  offsets: Float64Array;
  /** String(startLine) per node — the DOM id to jump to. */
  nodeIds: string[];
  /** chunk_id per node (plain number; decimal-capable). */
  chunkOf: Float64Array;
  chunkBounds: Map<number, ChunkBound>;
  /** Ascending chunk ids — neighbour lookup for jump preloading. */
  chunkIdsSorted: number[];
  minimap: MinimapNode[];
  totalHeight: number;
  metrics: VirtualMapMetrics;
  /** Staleness probes: the nodes array (reference + length) this map was built from. */
  sourceRef: readonly NodeRecord[];
  sourceLength: number;
}

const LEADING_TAG_RE = /^\s*<([a-z][a-z0-9]*)/i;
const HEADING_RE = /^\s*<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i;
const STRIP_TAGS_RE = /<[^>]+>/g;
const HEADING_TEXT_MAX = 48;

/** Font-size scale per heading level (index 0 unused). */
const HEADING_SCALE = [0, 2.0, 1.5, 1.3, 1.15, 1.15, 1.15];

const FIGURE_HEIGHT = 320;
const RULE_HEIGHT = 40;
const MIN_METRIC = 1e-6;

interface NodeEstimate {
  height: number;
  mini: MinimapNode;
}

function textLength(content: string): number {
  return content.replace(STRIP_TAGS_RE, '').length;
}

function headingText(content: string): string | undefined {
  const m = HEADING_RE.exec(content);
  if (!m) return undefined;
  const text = (m[2] ?? '').replace(STRIP_TAGS_RE, '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > HEADING_TEXT_MAX ? `${text.slice(0, HEADING_TEXT_MAX - 1)}…` : text;
}

function countMatches(content: string, re: RegExp): number {
  const m = content.match(re);
  return m ? m.length : 0;
}

/** Estimate one node's rendered height + its minimap shape. Proportional, not exact. */
export function estimateNode(node: NodeRecord, metrics: VirtualMapMetrics): NodeEstimate {
  const lineHeight = Math.max(MIN_METRIC, metrics.lineHeight);
  const cpl = Math.max(1, metrics.charsPerLine);
  const margin = Math.max(0, metrics.blockMargin);
  const content = typeof node.content === 'string' ? node.content : '';
  const tag = (LEADING_TAG_RE.exec(content)?.[1] ?? 'p').toLowerCase();
  const len = textLength(content);
  const lightCount = Array.isArray(node.hyperlights) ? node.hyperlights.length : 0;
  const citeCount = Array.isArray(node.hypercites) ? node.hypercites.length : 0;

  const mini = (kind: MinimapKind, lineCount: number, extra?: Partial<MinimapNode>): MinimapNode => ({
    kind,
    lineCount: Math.max(1, Math.round(lineCount)),
    lightCount,
    citeCount,
    ...extra,
  });

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const scale = HEADING_SCALE[level] ?? 1.15;
    const lines = Math.max(1, Math.ceil(len / Math.max(1, cpl / scale)));
    return {
      height: lines * lineHeight * scale + 2 * margin,
      mini: mini('heading', lines, {
        level,
        headingText: level <= 3 ? headingText(content) : undefined,
      }),
    };
  }

  // Any embedded image dominates the node's height regardless of the wrapper tag.
  if (tag === 'figure' || content.includes('<img')) {
    return { height: FIGURE_HEIGHT + margin, mini: mini('figure', FIGURE_HEIGHT / lineHeight) };
  }

  switch (tag) {
    case 'hr':
      return { height: RULE_HEIGHT, mini: mini('rule', 1) };
    case 'pre': {
      const lines = countMatches(content, /\n/g) + 1;
      return { height: lines * lineHeight + margin, mini: mini('code', lines) };
    }
    case 'table': {
      const rows = Math.max(1, countMatches(content, /<tr/gi));
      return { height: rows * lineHeight * 1.4 + margin, mini: mini('table', rows) };
    }
    case 'ul':
    case 'ol': {
      const items = countMatches(content, /<li/gi);
      const lines = Math.max(items, Math.ceil(len / cpl), 1);
      return { height: lines * lineHeight + margin, mini: mini('list', lines) };
    }
    case 'blockquote': {
      const lines = Math.max(1, Math.ceil(len / Math.max(1, cpl * 0.85)));
      return { height: lines * lineHeight + margin, mini: mini('quote', lines) };
    }
    default: {
      const lines = Math.max(1, Math.ceil(len / cpl));
      return { height: lines * lineHeight + margin, mini: mini('para', lines) };
    }
  }
}

/**
 * Build the whole-book virtual space from the loader's node array.
 *
 * Sorts a COPY by startLine: the background download and server-fallback paths
 * `push()` fetched chunks in COMPLETION order, so `instance.nodes` is not
 * reliably document-ordered.
 */
export function buildVirtualMap(
  nodes: readonly NodeRecord[],
  metrics: VirtualMapMetrics,
): VirtualMap {
  const sorted = [...nodes].sort((a, b) => Number(a.startLine) - Number(b.startLine));
  const n = sorted.length;

  const offsets = new Float64Array(n + 1);
  const nodeIds = new Array<string>(n);
  const chunkOf = new Float64Array(n);
  const minimap = new Array<MinimapNode>(n);
  const chunkBounds = new Map<number, ChunkBound>();

  let v = 0;
  sorted.forEach((node, i) => {
    const vTop = v;
    offsets[i] = vTop;
    nodeIds[i] = String(node.startLine);
    const chunkId = Number(node.chunk_id);
    chunkOf[i] = chunkId;
    const { height, mini } = estimateNode(node, metrics);
    minimap[i] = mini;
    v = vTop + height;

    const bound = chunkBounds.get(chunkId);
    if (bound) {
      // Nodes of one chunk are contiguous after the sort; extend defensively anyway.
      bound.endIdx = i + 1;
      bound.vEnd = v;
    } else {
      chunkBounds.set(chunkId, { startIdx: i, endIdx: i + 1, vStart: vTop, vEnd: v });
    }
  });
  offsets[n] = v;

  return {
    offsets,
    nodeIds,
    chunkOf,
    chunkBounds,
    chunkIdsSorted: [...chunkBounds.keys()].sort((a, b) => a - b),
    minimap,
    totalHeight: v,
    metrics,
    sourceRef: nodes,
    sourceLength: nodes.length,
  };
}

/** Index of the node whose virtual span contains y (clamped to [0, n-1]; -1 for an empty map). */
export function indexAtVirtual(map: VirtualMap, y: number): number {
  const n = map.nodeIds.length;
  if (n === 0) return -1;
  if (y <= 0) return 0;
  if (y >= map.totalHeight) return n - 1;
  // Largest i with offsets[i] <= y.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((map.offsets[mid] ?? Infinity) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Virtual top of node i (clamped). */
export function virtualOfIndex(map: VirtualMap, i: number): number {
  const n = map.nodeIds.length;
  if (n === 0) return 0;
  return map.offsets[Math.min(Math.max(i, 0), n)] ?? 0;
}

/** Has the loader's node array changed identity or size since this map was built? */
export function isMapStale(map: VirtualMap, nodes: readonly NodeRecord[]): boolean {
  return map.sourceRef !== nodes || map.sourceLength !== nodes.length;
}
