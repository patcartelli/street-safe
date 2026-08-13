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
  tagCoverage: { sidewalk: number; maxspeed: number; lanes: number; crossing: number };
  signalNodes: number;
}

const SIGNAL_RADIUS_M = 20;
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
    let matched: OsmWay | null = null;
    for (const rw of roadWaysAll) {
      for (let i = 1; i < rw.nodes.length; i++) {
        const p = osmNodes.get(rw.nodes[i - 1]), q = osmNodes.get(rw.nodes[i]);
        if (!p || !q) continue;
        if (pointSegDistM(midLat, midLon, p.lat, p.lon, q.lat, q.lon) <= 25 &&
            bearingDiffDeg(swBearing, bearingDeg(p.lat, p.lon, q.lat, q.lon)) <= 20) {
          matched = rw; break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      collapsedIds.add(sw.id);
      sidewalkCollapsed++;
      if (!matched.tags.sidewalk || matched.tags.sidewalk === 'no' || matched.tags.sidewalk === 'none') {
        matched.tags = { ...matched.tags, sidewalk: 'yes' };
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

  // Node records with signal/crossing association within 20 m.
  const signals: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.highway === 'traffic_signals');
  const crossings: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.crossing);
  const nodeIds = new Set<string>();
  for (const e of keptEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const on = osmNodes.get(Number(id))!;
    const signal = signals.some((s) => haversineM(on.lat, on.lon, s.lat, s.lon) <= SIGNAL_RADIUS_M);
    const cx = crossings.find((c) => haversineM(on.lat, on.lon, c.lat, c.lon) <= SIGNAL_RADIUS_M);
    return { id, lat: on.lat, lon: on.lon, signal, crossing: cx?.tags?.crossing ?? null };
  });

  // Tag coverage over road (non-pedestrian-only) kept ways.
  const roadWays = keptAfterCollapse.filter((w) => !PEDESTRIAN_ONLY.has(w.tags.highway));
  const frac = (key: string) => roadWays.length ? roadWays.filter((w) => w.tags[key] != null).length / roadWays.length : 0;

  return {
    graph: { nodes, edges: keptEdges },
    report: {
      waysTotal: ways.length, waysExcluded,
      sidewalkSeparateWays: sidewalkWays.length, sidewalkCollapsed, sidewalkUnmatched: sidewalkWays.length - sidewalkCollapsed,
      nodesTotal: nodes.length, largestComponentPct,
      // crossing coverage = graph nodes with a non-null crossing association ÷ graph nodes.
      tagCoverage: { sidewalk: frac('sidewalk'), maxspeed: frac('maxspeed'), lanes: frac('lanes'), crossing: nodes.filter((n) => n.crossing !== null).length / Math.max(1, nodes.length) },
      signalNodes: nodes.filter((n) => n.signal).length,
    },
  };
}
