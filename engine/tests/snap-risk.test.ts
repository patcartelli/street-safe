import test from 'node:test';
import assert from 'node:assert/strict';
import { snapRisk } from '../build/snap-risk.js';
import { loadGraph } from '../src/graph.js';

const graph = loadGraph({
  nodes: [
    { id: 'A', lat: 40.7400, lon: -74.2600, signal: false, crossing: null },
    { id: 'B', lat: 40.7450, lon: -74.2600, signal: false, crossing: null },
  ],
  edges: [{
    from: 'A', to: 'B', wayId: '1', name: 'Test St', highway: 'residential',
    lengthM: 556, lts: 2, ltsReasons: [], steps: false,
    geometry: [[40.74, -74.26], [40.745, -74.26]],
  }],
});

const hotspots = [
  { cluster: 0, lat: 40.74005, lon: -74.2600, n: 2, stress: 10, injury_n: 1, vru_n: 0, location: 'TEST ST', cross: 'X AVE' },   // ~6 m from A → snaps
  { cluster: 1, lat: 40.7420, lon: -74.2600, n: 3, stress: 5, injury_n: 0, vru_n: 0, location: 'FAR ST', cross: 'Y AVE' },      // ~220 m from anything → unsnapped
];
const points = [
  { lat: 40.74006, lon: -74.26001, kind: 'injury', case: 'C-2022-000001' }, // → cluster 0
  { lat: 40.74004, lon: -74.25999, kind: 'pdo', case: 'C-2022-000002' },    // → cluster 0
];
const causes = new Map([
  ['C2022000001', ['Driver inattention', 'Failed to yield ROW']],
  ['C2022000002', ['Driver inattention']],
]);

test('snapRisk: snap, dominant cause, unsnapped report', () => {
  const { risk, report } = snapRisk(graph, hotspots, points, causes);
  assert.equal(risk.length, 1);
  const r = risk[0];
  assert.equal(r.nodeId, 'A');
  assert.equal(r.crashN, 2);
  assert.equal(r.dominantCause, 'Driver inattention');
  assert.equal(r.causeDistribution['Driver inattention'], 2);
  assert.equal(r.causeDistribution['Failed to yield ROW'], 1);
  assert.equal(r.name, 'TEST ST × X AVE');
  assert.equal(report.unsnapped.length, 1);
  assert.equal(report.unsnapped[0].cluster, 1);
  // cluster 0 expected n=2, assigned 2 → no mismatch entry
  assert.equal(report.assignmentMismatches.length, 0);
});
