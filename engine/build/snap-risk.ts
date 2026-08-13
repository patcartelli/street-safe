import { haversineM } from '../src/geo.js';
import { nearestNode, type Graph } from '../src/graph.js';
import { normalizeCase } from './causes.js';
import type { NodeRisk, RiskSurface } from '../src/risk.js';

export interface HotspotRow {
  cluster: number;
  lat: number;
  lon: number;
  n: number;
  stress: number;
  injury_n: number;
  vru_n: number;
  location: string;
  cross: string;
}

export interface PointRow {
  lat: number;
  lon: number;
  kind: string;
  case: string;
}

export interface SnapReport {
  unsnapped: Array<{ cluster: number; name: string; distM: number }>;
  assignmentMismatches: Array<{ cluster: number; expected: number; assigned: number }>;
}

const SNAP_MAX_M = 30;
const ASSIGN_MAX_M = 25;

export function snapRisk(
  graph: Graph,
  hotspots: HotspotRow[],
  points: PointRow[],
  causesByCase: Map<string, string[]>,
): { risk: RiskSurface; report: SnapReport } {
  // Point → nearest cluster centroid within 25 m (membership approximation).
  const byCluster = new Map<number, PointRow[]>();
  for (const p of points) {
    let best: HotspotRow | null = null;
    let bestD = Infinity;
    for (const h of hotspots) {
      const d = haversineM(p.lat, p.lon, h.lat, h.lon);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best && bestD <= ASSIGN_MAX_M) {
      if (!byCluster.has(best.cluster)) byCluster.set(best.cluster, []);
      byCluster.get(best.cluster)!.push(p);
    }
  }

  const report: SnapReport = { unsnapped: [], assignmentMismatches: [] };
  const byNode = new Map<string, NodeRisk>();

  for (const h of hotspots) {
    const name = `${h.location} × ${h.cross}`;
    const node = nearestNode(graph, h.lat, h.lon);
    const distM = haversineM(h.lat, h.lon, node.lat, node.lon);
    if (distM > SNAP_MAX_M) {
      report.unsnapped.push({ cluster: h.cluster, name, distM });
      continue;
    }
    const assigned = byCluster.get(h.cluster) ?? [];
    if (h.n > 0 && Math.abs(assigned.length - h.n) / h.n > 0.3) {
      report.assignmentMismatches.push({ cluster: h.cluster, expected: h.n, assigned: assigned.length });
    }
    const dist: Record<string, number> = {};
    for (const p of assigned) {
      for (const label of causesByCase.get(normalizeCase(p.case)) ?? []) {
        dist[label] = (dist[label] ?? 0) + 1;
      }
    }
    const dominant = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const existing = byNode.get(node.id);
    if (existing) {
      existing.crashN += h.n;
      existing.stress += h.stress;
      existing.injuryN += h.injury_n;
      existing.vruN += h.vru_n;
      existing.clusterIds.push(h.cluster);
      existing.snapDistM = Math.min(existing.snapDistM, distM);
      for (const [k, v] of Object.entries(dist)) {
        existing.causeDistribution[k] = (existing.causeDistribution[k] ?? 0) + v;
      }
      const top = Object.entries(existing.causeDistribution).sort((a, b) => b[1] - a[1])[0];
      existing.dominantCause = top?.[0] ?? null;
    } else {
      byNode.set(node.id, {
        nodeId: node.id,
        crashN: h.n,
        stress: h.stress,
        injuryN: h.injury_n,
        vruN: h.vru_n,
        dominantCause: dominant,
        causeDistribution: dist,
        clusterIds: [h.cluster],
        snapDistM: distM,
        name,
      });
    }
  }
  return { risk: [...byNode.values()], report };
}
