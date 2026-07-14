/**
 * Payload contract with DocuverseController::data — shared by the pure layout
 * (unit-tested) and the Three.js scene.
 */

export type EdgeKind = 'hypercite' | 'citation_verified' | 'citation_auto';

export interface DocNode {
  id: string;
  /**
   * held      = CANONICAL SOURCE: verified on an external database, with
   *             source material in the library (one sphere even when many
   *             versions exist — `versions` lists them all)
   * book      = SOURCE: original to the hyperlit docuverse (no canonical id)
   * canonical = CITATION: verified citation with no source material yet
   */
  kind: 'book' | 'held' | 'canonical';
  title: string;
  author: string | null;
  year: number | string | null;
  cited_by_count: number | null;
  book: string | null; // primary openable library book id (null = not held anywhere)
  versions: { book: string; title: string }[]; // every caller-visible held version
  url: string | null;
}

export interface DocEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface DocuversePayload {
  nodes: DocNode[];
  edges: DocEdge[];
  layers: EdgeKind[];
  /** Node id of the focused work (/3d/{bookId} — its connected component), or null. */
  focus: string | null;
}
