export interface NodeRisk {
  nodeId: string;
  crashN: number;
  stress: number;
  injuryN: number;
  vruN: number;
  dominantCause: string | null;
  causeDistribution: Record<string, number>;
  clusterIds: number[];
  snapDistM: number;
  name: string;
  /** Present on intersection-complex duplicates; names the primary node this
   *  entry's payload was copied from. Absent on primaries and non-complex nodes. */
  complexOf?: string;
}

export type RiskSurface = NodeRisk[];
