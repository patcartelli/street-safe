import { haversineM } from './geo.js';
import { roadKey, type Graph, type GraphEdge } from './graph.js';
import { crashBumpM, crossingPenaltyM } from './stress.js';
import type { NodeRisk } from './risk.js';

export interface MoveDetail {
  edgeIdx: number; nodeId: string;             // node traversed BEFORE this edge ('' for the first move)
  segPenaltyM: number;                          // λ-weighted LTS length penalty for this edge
  crossingPenaltyM: number;                     // λ·pureCrossing only (0 when crossedRoad is null)
  crossedRoad: string | null;
  nodeBumpM: number;                            // λ·0.5·bump at node v (through/turn node); 0 for the origin move
  bumpHalfM: number;                            // λ·0.5·bump at the edge's head node
}
export interface RawRoute {
  nodeIds: string[]; edgeIdxs: number[];
  distanceM: number; stressCostM: number;
  moves: MoveDetail[]; geometry: [number, number][];
}

/** Minimal binary min-heap of [priority, value]. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(p: number, v: number) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (a[par][0] <= a[i][0]) break;
      [a[par], a[i]] = [a[i], a[par]]; i = par;
    }
  }
  pop(): [number, number] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const head = (e: GraphEdge, fwd: boolean) => (fwd ? e.to : e.from);
const tail = (e: GraphEdge, fwd: boolean) => (fwd ? e.from : e.to);

function crossingAt(
  graph: Graph, nodeId: string, excludeKeys: Set<string>,
): { maxLts: number; crossedRoad: string | null } {
  let maxLts = 0;
  let crossedRoad: string | null = null;
  for (const idx of graph.adj.get(nodeId) ?? []) {
    const e = graph.edges[idx];
    const key = roadKey(e);
    if (excludeKeys.has(key)) continue;
    if (e.lts > maxLts) { maxLts = e.lts; crossedRoad = e.name ?? key; }
  }
  return { maxLts, crossedRoad };
}

export function route(
  graph: Graph,
  risk: Map<string, NodeRisk>,
  originNodeId: string,
  destNodeId: string,
  lambda: number,
): RawRoute | null {
  if (originNodeId === destNodeId) {
    return { nodeIds: [originNodeId], edgeIdxs: [], distanceM: 0, stressCostM: 0, moves: [], geometry: [] };
  }
  const E = graph.edges.length;
  const dest = graph.nodes.get(destNodeId)!;
  const bump = (nodeId: string) => crashBumpM(risk.get(nodeId)?.stress ?? 0);
  const segCost = (e: GraphEdge) => e.lengthM * (1 + (lambda * (e.lts - 1)) / 3);
  const h = (nodeId: string) => {
    const n = graph.nodes.get(nodeId)!;
    return haversineM(n.lat, n.lon, dest.lat, dest.lon);
  };

  // Directed-edge states: d = edgeIdx*2 + (forward ? 0 : 1).
  const g = new Float64Array(2 * E).fill(Infinity);
  const cameFrom = new Int32Array(2 * E).fill(-1);
  const detail: (MoveDetail | null)[] = new Array(2 * E).fill(null);
  const open = new Heap();

  for (const idx of graph.adj.get(originNodeId) ?? []) {
    const e = graph.edges[idx];
    const fwd = e.from === originNodeId;
    const d = idx * 2 + (fwd ? 0 : 1);
    const hd = head(e, fwd);
    const bumpHalf = lambda * 0.5 * bump(hd);
    const cost = segCost(e) + bumpHalf; // no crossing penalty at origin
    if (cost < g[d]) {
      g[d] = cost;
      detail[d] = {
        edgeIdx: idx, nodeId: '', segPenaltyM: segCost(e) - e.lengthM,
        crossingPenaltyM: 0, crossedRoad: null, nodeBumpM: 0, bumpHalfM: bumpHalf,
      };
      open.push(cost + h(hd), d);
    }
  }

  let goal = -1;
  const closed = new Uint8Array(2 * E);
  while (open.size) {
    const [, d] = open.pop();
    if (closed[d]) continue;
    closed[d] = 1;
    const e = graph.edges[d >> 1];
    const fwd = (d & 1) === 0;
    const v = head(e, fwd);
    if (v === destNodeId) { goal = d; break; }
    const inKey = roadKey(e);
    for (const outIdx of graph.adj.get(v) ?? []) {
      if (outIdx === d >> 1) continue; // no immediate U-turn
      const oe = graph.edges[outIdx];
      const ofwd = oe.from === v;
      if (tail(oe, ofwd) !== v) continue;
      const od = outIdx * 2 + (ofwd ? 0 : 1);
      if (closed[od]) continue;
      const exclude = new Set([inKey, roadKey(oe)]);
      const { maxLts, crossedRoad } = crossingAt(graph, v, exclude);
      const vNode = graph.nodes.get(v)!;
      // pureCrossing excludes the node's bump (bumpM=0) — bump is attributed separately below
      // so each intermediate node totals exactly 1x lambda*bump (0.5 on arrival, 0.5 on departure).
      const pureCrossing = maxLts > 0
        ? crossingPenaltyM(maxLts, vNode.signal, vNode.crossing, 0)
        : 0; // no crossed road: no crossing penalty (bump still applies at the node, see nodeBump)
      const nodeBump = lambda * 0.5 * bump(v);
      const hd = head(oe, ofwd);
      const bumpHalf = lambda * 0.5 * bump(hd);
      const cost = g[d] + segCost(oe) + lambda * pureCrossing + nodeBump + bumpHalf;
      if (cost < g[od]) {
        g[od] = cost;
        cameFrom[od] = d;
        detail[od] = {
          edgeIdx: outIdx, nodeId: v, segPenaltyM: segCost(oe) - oe.lengthM,
          crossingPenaltyM: lambda * pureCrossing, crossedRoad, nodeBumpM: nodeBump, bumpHalfM: bumpHalf,
        };
        open.push(cost + h(hd), od);
      }
    }
  }
  if (goal === -1) return null;

  // Reconstruct.
  const moves: MoveDetail[] = [];
  const edgeIdxs: number[] = [];
  const dirs: boolean[] = [];
  for (let d = goal; d !== -1; d = cameFrom[d]) {
    moves.unshift(detail[d]!);
    edgeIdxs.unshift(d >> 1);
    dirs.unshift((d & 1) === 0);
  }
  const nodeIds = [tail(graph.edges[edgeIdxs[0]], dirs[0])];
  const geometry: [number, number][] = [];
  edgeIdxs.forEach((idx, i) => {
    const e = graph.edges[idx];
    nodeIds.push(head(e, dirs[i]));
    const geo = dirs[i] ? e.geometry : [...e.geometry].reverse();
    geometry.push(...(i === 0 ? geo : geo.slice(1)));
  });
  const distanceM = edgeIdxs.reduce((s, idx) => s + graph.edges[idx].lengthM, 0);
  return { nodeIds, edgeIdxs, distanceM, stressCostM: g[goal] - distanceM, moves, geometry };
}
