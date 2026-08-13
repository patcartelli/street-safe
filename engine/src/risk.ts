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
}

export type RiskSurface = NodeRisk[];
