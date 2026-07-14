/**
 * Payload contract with HarvestNetworkController::data — shared by the pure
 * layout (unit-tested) and the Three.js scene.
 */

export interface NetworkNode {
  id: string;
  title: string;
  author: string | null;
  year: number | string | null;
  status: string;
  depth: number;
  book: string | null;
  cited_by_count: number | null;
  url: string | null;
  journal: string | null;
  publisher: string | null;
  type: string | null;
  reason: string | null;
}

export interface NetworkEdge {
  source: string;
  target: string;
}

export interface NetworkPayload {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export interface Position {
  x: number;
  y: number;
  z: number;
}
