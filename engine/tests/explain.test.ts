import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRoute } from '../src/explain.js';
import { route } from '../src/router.js';
import { loadGraph } from '../src/graph.js';
import type { NodeRisk } from '../src/risk.js';

const g = loadGraph({
  nodes: [
    { id: 'A', lat: 40.740, lon: -74.262, signal: false, crossing: null },
    { id: 'B', lat: 40.740, lon: -74.260, signal: false, crossing: null },
    { id: 'C', lat: 40.740, lon: -74.258, signal: false, crossing: null },
  ],
  edges: [
    { from: 'A', to: 'B', wayId: 'w1', name: 'Main St', highway: 'residential', lengthM: 170,
      lts: 2, ltsReasons: [{ reason: 'residential (base 2)', source: 'tagged' }], steps: false, geometry: [] },
    { from: 'B', to: 'C', wayId: 'w2', name: 'Main St', highway: 'residential', lengthM: 170,
      lts: 2, ltsReasons: [{ reason: 'residential (base 2)', source: 'tagged' }], steps: false, geometry: [] },
  ],
});
const risk = new Map<string, NodeRisk>([['B', {
  nodeId: 'B', crashN: 4, stress: 12, injuryN: 1, vruN: 0,
  dominantCause: 'Backing unsafely', causeDistribution: { 'Backing unsafely': 3 },
  clusterIds: [7], snapDistM: 8, name: 'Main St × Oak',
}]]);

test('explainRoute merges same-name segments and flags risk nodes', () => {
  const raw = route(g, risk, 'A', 'C', 1)!;
  const res = explainRoute(g, risk, raw, 1);
  assert.equal(res.lambda, 1);
  assert.equal(res.distance_m, 340);
  assert.equal(res.segments.length, 1);            // merged by way_name
  assert.equal(res.segments[0].way_name, 'Main St');
  assert.equal(res.segments[0].length_m, 340);
  assert.ok(res.segments[0].stress_contribution_m > 0); // LTS 2 → (2−1)/3 per meter
  const flagged = res.flagged_nodes.find((n) => n.node_id === 'B')!;
  assert.equal(flagged.dominant_cause, 'Backing unsafely');
  assert.equal(flagged.name, 'Main St × Oak');
  assert.equal(flagged.crash_n, 4);
  // B continues along 'Main St' with no cross street: crossing penalty is pure and
  // excludes bump, so it is legitimately 0 even though B is risk-flagged.
  assert.equal(flagged.crossing_penalty_m, 0);
});
