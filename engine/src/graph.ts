import { haversineM } from './geo.js';
import type { Lts, LtsReason } from './lts.js';

export interface GraphNode { id: string; lat: number; lon: number; signal: boolean; crossing: string | null }
export interface GraphEdge {
  from: string; to: string; wayId: string; name: string | null; highway: string;
  lengthM: number; lts: Lts; ltsReasons: LtsReason[]; steps: boolean;
  geometry: [number, number][];
}
export interface SerializedGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Graph { nodes: Map<string, GraphNode>; edges: GraphEdge[]; adj: Map<string, number[]> }

export function loadGraph(g: SerializedGraph): Graph {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, number[]>();
  g.edges.forEach((e, i) => {
    for (const id of [e.from, e.to]) {
      if (!adj.has(id)) adj.set(id, []);
      adj.get(id)!.push(i);
    }
  });
  return { nodes, edges: g.edges, adj };
}

export function nearestNode(g: Graph, lat: number, lon: number): GraphNode {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const n of g.nodes.values()) {
    const d = haversineM(lat, lon, n.lat, n.lon);
    if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) throw new Error('empty graph');
  return best;
}

/** Road identity for crossing exclusion. OSM splits streets into many ways;
 *  name-based identity keeps "continue along X" from pricing as "cross X". */
export function roadKey(e: GraphEdge): string {
  return e.name ?? `way:${e.wayId}`;
}
