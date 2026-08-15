import type { RouteResult } from '../engine/src/explain.js';

export interface FlaggedDisplay {
  name: string; dominantCause: string | null; crashN: number; crossingPenaltyM: number;
}

const groupKey = (nodeId: string, cx: Map<string, string>) => cx.get(nodeId) ?? nodeId;

export function dedupeFlagged(
  flagged: RouteResult['flagged_nodes'],
  complexOfByNode: Map<string, string>,
): FlaggedDisplay[] {
  const best = new Map<string, RouteResult['flagged_nodes'][number]>();
  for (const fl of flagged) {
    const key = groupKey(fl.node_id, complexOfByNode);
    const prev = best.get(key);
    if (!prev || fl.crash_n > prev.crash_n) best.set(key, fl);
  }
  return [...best.values()].map((fl) => ({
    name: fl.name, dominantCause: fl.dominant_cause,
    crashN: fl.crash_n, crossingPenaltyM: fl.crossing_penalty_m,
  }));
}

export function minutesAt80(distanceM: number): number {
  return Math.round(distanceM / 80);
}

export function avoidedComplexes(
  fast: RouteResult['flagged_nodes'],
  safe: RouteResult['flagged_nodes'],
  complexOfByNode: Map<string, string>,
): number {
  const safeKeys = new Set(safe.map((fl) => groupKey(fl.node_id, complexOfByNode)));
  const fastKeys = new Set(fast.map((fl) => groupKey(fl.node_id, complexOfByNode)));
  return [...fastKeys].filter((k) => !safeKeys.has(k)).length;
}

const PERSONA_DETENTS: Array<{ lambda: number; label: string }> = [
  { lambda: 0.5, label: 'confident walker' },
  { lambda: 2, label: 'with a stroller' },
  { lambda: 3, label: 'with a child' },
];

/** Persona presets are UNVALIDATED starting points (spec'd in V1, never calibrated). */
export function personaLabel(lambda: number): string | null {
  for (const d of PERSONA_DETENTS) {
    if (Math.abs(lambda - d.lambda) <= 0.05 + 1e-9) return d.label;
  }
  return null;
}
