import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';
import { loadGraph, type SerializedGraph } from '../src/graph.js';
import type { NodeRisk } from '../src/risk.js';

/** Ladder: origin O and dest D connected by
 *  (a) direct path along "Big Ave" (primary, LTS 4): O–M–D, 400 m
 *  (b) detour via quiet "Calm St" (residential w/ sidewalk, LTS 1): O–Q1–Q2–D, 600 m
 *  Plus "Side St" (residential, LTS 2) crossing Big Ave at M — used for the
 *  movement-aware crossing test.
 */
function grid(): SerializedGraph {
  const N = (id: string, lat: number, lon: number, signal = false) =>
    ({ id, lat, lon, signal, crossing: null });
  const E = (from: string, to: string, name: string, highway: string, lts: 1|2|3|4, lengthM: number) => ({
    from, to, wayId: name, name, highway, lengthM, lts,
    ltsReasons: [], steps: false,
    geometry: [] as [number, number][],
  });
  return {
    nodes: [
      N('O', 40.7400, -74.2620), N('M', 40.7400, -74.2600), N('D', 40.7400, -74.2580),
      N('Q1', 40.7410, -74.2620), N('Q2', 40.7410, -74.2580),
      N('S1', 40.7390, -74.2600), N('S2', 40.7410, -74.2600),
    ],
    edges: [
      E('O', 'M', 'Big Ave', 'primary', 4, 200), E('M', 'D', 'Big Ave', 'primary', 4, 200),
      E('O', 'Q1', 'Calm St', 'residential', 1, 120), E('Q1', 'Q2', 'Calm St', 'residential', 1, 360),
      E('Q2', 'D', 'Calm St', 'residential', 1, 120),
      E('S1', 'M', 'Side St', 'residential', 2, 110), E('M', 'S2', 'Side St', 'residential', 2, 110),
    ],
  };
}
const noRisk = new Map<string, NodeRisk>();

test('λ=0 picks the shortest path', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 0)!;
  assert.equal(r.distanceM, 400);
  assert.deepEqual(r.nodeIds, ['O', 'M', 'D']);
  assert.equal(r.stressCostM, 0);
});

test('high λ diverts to the quiet route', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 3)!;
  assert.deepEqual(r.nodeIds, ['O', 'Q1', 'Q2', 'D']);
  assert.equal(r.distanceM, 600);
});

test('movement-aware crossing: continuing along Big Ave charges Side St, not Big Ave', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 1)!;
  // Whatever route wins, inspect the O→M→D moves when forced: use λ=0 (which takes Big Ave).
  const r0 = route(g, noRisk, 'O', 'D', 0)!;
  const mMove = r0.moves.find((m) => m.nodeId === 'M')!;
  assert.equal(mMove.crossedRoad, 'Side St'); // crossing the side street, NOT Big Ave
});

test('walking Side St across Big Ave charges Big Ave crossing', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'S1', 'S2', 1)!;
  assert.deepEqual(r.nodeIds, ['S1', 'M', 'S2']);
  const mMove = r.moves.find((m) => m.nodeId === 'M')!;
  assert.equal(mMove.crossedRoad, 'Big Ave');
  // Unsignalized LTS-4 crossing: penalty = 25·(4−1) = 75, λ=1.
  assert.equal(mMove.crossingPenaltyM, 75);
});

test('crash bump at a node adds cost', () => {
  const g = loadGraph(grid());
  const risky = new Map<string, NodeRisk>([['M', {
    nodeId: 'M', crashN: 10, stress: 42, injuryN: 2, vruN: 1,
    dominantCause: 'Driver inattention', causeDistribution: { 'Driver inattention': 5 },
    clusterIds: [0], snapDistM: 5, name: 'Big × Side',
  }]]);
  const clean = route(g, noRisk, 'S1', 'S2', 1)!;
  const bumped = route(g, risky, 'S1', 'S2', 1)!;
  const cleanCost = clean.distanceM + clean.stressCostM;
  const bumpedCost = bumped.distanceM + bumped.stressCostM;
  assert.ok(bumpedCost > cleanCost, `${bumpedCost} vs ${cleanCost}`);
});
