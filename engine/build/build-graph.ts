import { haversineM, bearingDeg, bearingDiffDeg, pointSegDistM } from '../src/geo.js';
import { segmentLts } from '../src/lts.js';
import type { GraphEdge, GraphNode, SerializedGraph } from '../src/graph.js';

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> }
export type OsmElement = OsmNode | OsmWay;
export interface OsmJson { elements: OsmElement[] }

export interface BuildReport {
  waysTotal: number; waysExcluded: number;
  sidewalkSeparateWays: number; sidewalkCollapsed: number; sidewalkUnmatched: number;
  nodesTotal: number; largestComponentPct: number;
  tagCoverage: { sidewalk: number; maxspeed: number; lanes: number; crossing: number; crossingRaw: number };
  signalNodes: number;
  signalNodesRaw: number;
}

const PEDESTRIAN_ONLY = new Set(['footway', 'path', 'pedestrian', 'steps']);

function excluded(tags: Record<string, string>): boolean {
  if (tags.foot === 'no') return true;
  if (tags.access === 'private' && tags.foot !== 'yes') return true;
  return false;
}

export function buildGraph(osm: OsmJson): { graph: SerializedGraph; report: BuildReport } {
  const osmNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of osm.elements) {
    if (el.type === 'node') osmNodes.set(el.id, el);
    else ways.push(el);
  }
  const kept = ways.filter((w) => !excluded(w.tags));
  const waysExcluded = ways.length - kept.length;

  // Sidewalk representation handling (spec Stage 2): collapse footway=sidewalk
  // ways onto their parallel parent road; keep unmatched ones as footway edges.
  const sidewalkWays = kept.filter((w) => w.tags.footway === 'sidewalk');
  const roadWaysAll = kept.filter((w) => !PEDESTRIAN_ONLY.has(w.tags.highway));
  let sidewalkCollapsed = 0;
  const collapsedIds = new Set<number>();
  for (const sw of sidewalkWays) {
    const pts = sw.nodes.map((n) => osmNodes.get(n)).filter((n): n is OsmNode => !!n);
    if (pts.length < 2) continue;
    const mi = Math.floor(pts.length / 2) - (pts.length % 2 === 0 ? 1 : 0);
    const a = pts[mi], b = pts[Math.min(mi + 1, pts.length - 1)];
    const midLat = (a.lat + b.lat) / 2, midLon = (a.lon + b.lon) / 2;
    const swBearing = bearingDeg(a.lat, a.lon, b.lat, b.lon);
    let bestDist = Infinity, bestWay: OsmWay | null = null;
    for (const rw of roadWaysAll) {
      for (let i = 1; i < rw.nodes.length; i++) {
        const p = osmNodes.get(rw.nodes[i - 1]), q = osmNodes.get(rw.nodes[i]);
        if (!p || !q) continue;
        const dist = pointSegDistM(midLat, midLon, p.lat, p.lon, q.lat, q.lon);
        if (dist <= 25 &&
            bearingDiffDeg(swBearing, bearingDeg(p.lat, p.lon, q.lat, q.lon)) <= 20) {
          if (dist < bestDist) {
            bestDist = dist;
            bestWay = rw;
          }
        }
      }
    }
    if (bestWay) {
      collapsedIds.add(sw.id);
      sidewalkCollapsed++;
      if (!bestWay.tags.sidewalk || bestWay.tags.sidewalk === 'no' || bestWay.tags.sidewalk === 'none') {
        bestWay.tags = { ...bestWay.tags, sidewalk: 'yes' };
      }
    }
  }
  const keptAfterCollapse = kept.filter((w) => !collapsedIds.has(w.id));

  // Intersections: nodes used by ≥2 kept ways, or way endpoints.
  const useCount = new Map<number, number>();
  for (const w of keptAfterCollapse) for (const id of new Set(w.nodes)) useCount.set(id, (useCount.get(id) ?? 0) + 1);
  const isIntersection = (id: number, w: OsmWay) =>
    (useCount.get(id) ?? 0) >= 2 || id === w.nodes[0] || id === w.nodes[w.nodes.length - 1];

  // Split ways at intersections into edges, keeping interior geometry.
  const edges: GraphEdge[] = [];
  const usedNodeIds = new Set<number>();
  for (const w of keptAfterCollapse) {
    const { lts, reasons, steps } = segmentLts(w.tags);
    let chain: number[] = [];
    for (const id of w.nodes) {
      chain.push(id);
      if (chain.length > 1 && isIntersection(id, w)) {
        const pts = chain.map((n) => osmNodes.get(n)!).filter(Boolean);
        if (pts.length === chain.length) {
          let len = 0;
          for (let i = 1; i < pts.length; i++) len += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
          edges.push({
            from: String(chain[0]), to: String(chain[chain.length - 1]),
            wayId: String(w.id), name: w.tags.name ?? null, highway: w.tags.highway,
            lengthM: len, lts, ltsReasons: reasons, steps,
            geometry: pts.map((p) => [p.lat, p.lon] as [number, number]),
          });
          usedNodeIds.add(chain[0]);
          usedNodeIds.add(chain[chain.length - 1]);
        }
        chain = [id];
      }
    }
  }

  // Largest connected component (union-find).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  for (const id of usedNodeIds) parent.set(String(id), String(id));
  for (const e of edges) parent.set(find(e.from), find(e.to));
  const compSize = new Map<string, number>();
  for (const id of usedNodeIds) {
    const r = find(String(id));
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  const mainRoot = [...compSize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const keptEdges = edges.filter((e) => find(e.from) === mainRoot);
  const largestComponentPct = usedNodeIds.size ? (compSize.get(mainRoot!) ?? 0) / usedNodeIds.size : 0;

  // Node records with signal/crossing nearest-node single assignment (spec 2026-08-13):
  // each tagged OSM node marks exactly one graph node — the nearest one, not every graph
  // node within a radius. The previous 20 m any-node radius spilled onto neighbors (48% of
  // graph nodes have another within 20 m), systematically over-discounting crossings; the
  // raw-vs-associated tagCoverage/signalNodes counts below stay as the honest exact-node
  // signal (crossingRaw/signalNodesRaw), now joined by a materially tighter associated figure.
  const signals: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.highway === 'traffic_signals');
  const crossings: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.crossing);
  const nodeIds = new Set<string>();
  for (const e of keptEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const on = osmNodes.get(Number(id))!;
    return { id, lat: on.lat, lon: on.lon, signal: false, crossing: null };
  });

  const SIGNAL_ASSIGN_M = 20;
  const CROSSING_ASSIGN_M = 10;
  const nearestGraphNode = (lat: number, lon: number): { node: GraphNode; d: number } | null => {
    let best: GraphNode | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = haversineM(lat, lon, n.lat, n.lon);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { node: best, d: bestD } : null;
  };
  for (const s of signals) {
    const hit = nearestGraphNode(s.lat, s.lon);
    if (hit && hit.d <= SIGNAL_ASSIGN_M) hit.node.signal = true;
  }
  const crossingDist = new Map<string, number>();
  for (const c of crossings) {
    const hit = nearestGraphNode(c.lat, c.lon);
    if (!hit || hit.d > CROSSING_ASSIGN_M) continue;
    const prev = crossingDist.get(hit.node.id);
    if (prev === undefined || hit.d < prev) {
      crossingDist.set(hit.node.id, hit.d);
      hit.node.crossing = c.tags?.crossing ?? null;
    }
  }

  // Tag coverage over road (non-pedestrian-only) kept ways.
  const roadWays = keptAfterCollapse.filter((w) => !PEDESTRIAN_ONLY.has(w.tags.highway));
  const frac = (key: string) => roadWays.length ? roadWays.filter((w) => w.tags[key] != null).length / roadWays.length : 0;

  return {
    graph: { nodes, edges: keptEdges },
    report: {
      waysTotal: ways.length, waysExcluded,
      sidewalkSeparateWays: sidewalkWays.length, sidewalkCollapsed, sidewalkUnmatched: sidewalkWays.length - sidewalkCollapsed,
      nodesTotal: nodes.length, largestComponentPct,
      // crossing coverage = graph nodes with a non-null crossing association (nearest-node
      // single assignment, ≤10 m, see above) ÷ graph nodes. crossingRaw is the exact-node-
      // identity figure: graph nodes whose OWN OSM node carries a crossing tag ÷ graph nodes,
      // no distance involved — the two now track much closer than under the old 20 m radius.
      tagCoverage: {
        sidewalk: frac('sidewalk'), maxspeed: frac('maxspeed'), lanes: frac('lanes'),
        crossing: nodes.filter((n) => n.crossing !== null).length / Math.max(1, nodes.length),
        crossingRaw: [...nodeIds].filter((id) => osmNodes.get(Number(id))?.tags?.crossing != null).length / Math.max(1, nodes.length),
      },
      signalNodes: nodes.filter((n) => n.signal).length,
      // signalNodesRaw mirrors crossingRaw: exact-node-identity count (graph nodes whose OWN
      // OSM node carries highway=traffic_signals), no 20 m radius involved.
      signalNodesRaw: [...nodeIds].filter((id) => osmNodes.get(Number(id))?.tags?.highway === 'traffic_signals').length,
    },
  };
}
