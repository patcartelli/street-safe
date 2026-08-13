import { crossingLts } from './lts.js';

/** UNVALIDATED TUNING KNOBS (spec): BASE_PENALTY_M sets how many meters of
 *  walking one crossing-LTS step is "worth"; K calibrates the crash bump so the
 *  worst observed cluster (stress 42) contributes exactly one LTS-step. */
export const BASE_PENALTY_M = 25;
const K = 1 / Math.log1p(42);

export function crashBumpM(clusterStress: number): number {
  return Math.min(BASE_PENALTY_M, BASE_PENALTY_M * K * Math.log1p(clusterStress));
}

export function crossingPenaltyM(
  maxCrossedLts: number,
  signal: boolean,
  crossing: string | null,
  bumpM: number,
): number {
  return BASE_PENALTY_M * (crossingLts(maxCrossedLts, signal, crossing) - 1) + bumpM;
}
