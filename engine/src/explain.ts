import type { Graph } from './graph.js';
import type { NodeRisk } from './risk.js';
import type { RawRoute } from './router.js';
import type { LtsReason, Lts } from './lts.js';
import { BASE_PENALTY_M } from './stress.js';

export interface RouteResult {
  lambda: number;
  distance_m: number;
  stress_cost_m: number;
  segments: Array<{
    way_name: string | null; length_m: number; lts: Lts;
    stress_contribution_m: number; lts_reasons: LtsReason[];
  }>;
  flagged_nodes: Array<{
    node_id: string; name: string;
    crossing_penalty_m: number; crossed_way: string | null;
    crash_n: number; dominant_cause: string | null;
    cause_distribution: Record<string, number>;
  }>;
}

export function explainRoute(
  graph: Graph, risk: Map<string, NodeRisk>, raw: RawRoute, lambda: number,
): RouteResult {
  const segments: RouteResult['segments'] = [];
  for (let i = 0; i < raw.edgeIdxs.length; i++) {
    const e = graph.edges[raw.edgeIdxs[i]];
    const move = raw.moves[i];
    // segPenaltyM (pure λ-weighted LTS length penalty) + bumpHalfM (arrival-side
    // half-bump at this edge's head) + nodeBumpM (departure-side half-bump at this
    // edge's tail) — this is every stress cost NOT attributable to a crossing.
    // Summed over every move plus every move's crossingPenaltyM === raw.stressCostM
    // exactly, so segment contributions + crossing penalties is a clean decomposition.
    const contribution = move.segPenaltyM + move.bumpHalfM + move.nodeBumpM;
    const prev = segments[segments.length - 1];
    if (prev && prev.way_name === e.name) {
      prev.length_m += e.lengthM;
      prev.stress_contribution_m += contribution;
      if (e.lts > prev.lts) { prev.lts = e.lts; prev.lts_reasons = e.ltsReasons; }
    } else {
      segments.push({
        way_name: e.name, length_m: e.lengthM, lts: e.lts,
        stress_contribution_m: contribution, lts_reasons: e.ltsReasons,
      });
    }
  }

  const flagged: RouteResult['flagged_nodes'] = [];
  const seen = new Set<string>();
  for (const move of raw.moves) {
    if (!move.nodeId || seen.has(move.nodeId)) continue;
    const r = risk.get(move.nodeId);
    const bigCrossing = lambda > 0 && move.crossingPenaltyM >= lambda * BASE_PENALTY_M;
    if (!r && !bigCrossing) continue;
    seen.add(move.nodeId);
    const node = graph.nodes.get(move.nodeId)!;
    flagged.push({
      node_id: move.nodeId,
      name: r?.name ?? `${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}`,
      crossing_penalty_m: move.crossingPenaltyM,
      crossed_way: move.crossedRoad,
      crash_n: r?.crashN ?? 0,
      dominant_cause: r?.dominantCause ?? null,
      cause_distribution: r?.causeDistribution ?? {},
    });
  }

  return {
    lambda,
    distance_m: raw.distanceM,
    stress_cost_m: raw.stressCostM,
    segments,
    flagged_nodes: flagged,
  };
}
