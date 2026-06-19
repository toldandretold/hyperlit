/**
 * chunkSelection — pure, decimal-aware chunk navigation (zero-import leaf).
 *
 * chunk_id can be a DECIMAL: a chunk inserted between two others gets a fractional
 * id (5.5 between 5 and 6) to preserve order until the next renumber. So "the next
 * chunk" is NEVER `currentId + 1` — it's the next entry in the ordered manifest, or
 * (when fully loaded) the smallest chunk_id strictly greater than current. Mirror
 * for previous. Extracted from lazyLoader/index.ts so the decimal behaviour is
 * pinned by tests rather than assumed.
 */

// Type-only import (erased at runtime) — keeps this a zero-runtime-import leaf.
import type { ChunkId } from '../../indexedDB/types';

interface ChunkManifestEntry { chunk_id: ChunkId }
interface NodeLike { chunk_id: ChunkId | string }

/** The chunk_id immediately after `currentId`, or null if none. */
export function selectNextChunkId(
  manifest: ChunkManifestEntry[] | null | undefined,
  nodes: NodeLike[],
  currentId: ChunkId,
): ChunkId | null {
  if (manifest) {
    const idx = manifest.findIndex(m => m.chunk_id === currentId);
    return (idx >= 0 && idx < manifest.length - 1) ? manifest[idx + 1]!.chunk_id : null;
  }
  let next: ChunkId | null = null;
  for (const node of nodes) {
    const c = parseFloat(String(node.chunk_id)) as ChunkId;
    if (c > currentId && (next === null || c < next)) next = c;
  }
  return next;
}

/** The chunk_id immediately before `currentId`, or null if none. */
export function selectPrevChunkId(
  manifest: ChunkManifestEntry[] | null | undefined,
  nodes: NodeLike[],
  currentId: ChunkId,
): ChunkId | null {
  if (manifest) {
    const idx = manifest.findIndex(m => m.chunk_id === currentId);
    return (idx > 0) ? manifest[idx - 1]!.chunk_id : null;
  }
  let prev: ChunkId | null = null;
  for (const node of nodes) {
    const c = parseFloat(String(node.chunk_id)) as ChunkId;
    if (c < currentId && (prev === null || c > prev)) prev = c;
  }
  return prev;
}
