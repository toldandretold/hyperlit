/**
 * merge.ts — PLANNED, not implemented.
 *
 * Joins the front-end graph (visualisation/js/collect.ts) with the future backend graph
 * (visualisation/php/) into ONE data-flow graph, stitched at the shared HTTP endpoint URL.
 *
 * The JS side already records each endpoint on its push/pull edges (ENDPOINT_TABLES in
 * js/collect.ts); the PHP side will key its routes by the same normalized URL. Match on it
 * and the endpoint becomes a real node with JS on one side, PHP route → controller → model →
 * table on the other — so `ENDPOINT_TABLES` stops being hand-maintained and is derived instead.
 *
 * See ../README.md ("Next: the PHP tier") and php/README.md for the design. Until the PHP
 * collector exists, `npm run viz:idb` runs js/collect.ts directly and this file is inert.
 */
import type { FlowViz } from './js/collect';

/** Placeholder for the future backend graph (routes/controllers/models). */
export interface BackendGraph {
  nodes: { id: string; label: string; kind: 'route' | 'controller' | 'model' }[];
  edges: { source: string; target: string; rel: string }[];
  /** normalized endpoint URL → route node id, the join key onto the JS graph's edges. */
  endpointToRoute: Record<string, string>;
}

/** Not implemented yet — see this file's header and ../README.md. */
export function mergeGraphs(_front: FlowViz, _back: BackendGraph): never {
  throw new Error('visualisation/merge.ts is a planned stub — the PHP collector (visualisation/php) is not built yet.');
}
