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

test('snapRisk: merge clusters to same node, recompute dominant cause', () => {
  // Two clusters both snap to node A within 30 m
  // Cluster 2: 'Backing unsafely' ×1 (dominant in isolation)
  // Cluster 3: 'Driver inattention' ×2 (dominant in merged distribution)
  const mergeHotspots = [
    { cluster: 2, lat: 40.740004, lon: -74.2600, n: 1, stress: 5, injury_n: 0, vru_n: 1, location: 'MERGE ST', cross: 'Z AVE' },   // ~4 m from A
    { cluster: 3, lat: 40.74001, lon: -74.2600, n: 2, stress: 3, injury_n: 1, vru_n: 0, location: 'MERGE ST', cross: 'Z AVE' },    // ~11 m from A
  ];
  const mergePoints = [
    { lat: 40.740004, lon: -74.26001, kind: 'pdo', case: 'C-2022-000003' },     // → cluster 2
    { lat: 40.74001, lon: -74.25999, kind: 'injury', case: 'C-2022-000004' },   // → cluster 3
    { lat: 40.74001, lon: -74.26001, kind: 'pdo', case: 'C-2022-000005' },      // → cluster 3
  ];
  const mergeCauses = new Map([
    ['C2022000003', ['Backing unsafely']],
    ['C2022000004', ['Driver inattention']],
    ['C2022000005', ['Driver inattention']],
  ]);
  const { risk, report } = snapRisk(graph, mergeHotspots, mergePoints, mergeCauses);
  assert.equal(risk.length, 1);
  const r = risk[0];
  assert.equal(r.nodeId, 'A');
  assert.equal(r.crashN, 3);                      // 1 + 2
  assert.equal(r.stress, 8);                      // 5 + 3
  assert.equal(r.injuryN, 1);                     // 0 + 1
  assert.equal(r.vruN, 1);                        // 1 + 0
  assert.equal(r.clusterIds.length, 2);
  assert.ok(r.clusterIds.includes(2) && r.clusterIds.includes(3));
  assert.ok(r.snapDistM < 4.5);                   // min of both snap distances (cluster 2 is ~4m)
  assert.equal(r.causeDistribution['Backing unsafely'], 1);
  assert.equal(r.causeDistribution['Driver inattention'], 2);
  assert.equal(r.dominantCause, 'Driver inattention');  // recomputed from merged, not kept from cluster 2
  assert.equal(report.unsnapped.length, 0);
  assert.equal(report.assignmentMismatches.length, 0);
});

test('snapRisk: assignment mismatch when assigned count deviates > ±30%', () => {
  // Cluster with expected n=10 but only 2 assignable points within 25 m
  const mismatchHotspots = [
    { cluster: 4, lat: 40.74015, lon: -74.2600, n: 10, stress: 20, injury_n: 5, vru_n: 2, location: 'MISMATCH ST', cross: 'M AVE' },   // ~17 m from A
  ];
  const mismatchPoints = [
    { lat: 40.74015, lon: -74.26001, kind: 'pdo', case: 'C-2022-000006' },      // → cluster 4
    { lat: 40.74016, lon: -74.25999, kind: 'injury', case: 'C-2022-000007' },   // → cluster 4
  ];
  const mismatchCauses = new Map([
    ['C2022000006', ['Speeding']],
    ['C2022000007', ['Speeding']],
  ]);
  const { risk, report } = snapRisk(graph, mismatchHotspots, mismatchPoints, mismatchCauses);
  assert.equal(risk.length, 1);
  assert.equal(report.unsnapped.length, 0);
  assert.equal(report.assignmentMismatches.length, 1);
  const mismatch = report.assignmentMismatches[0];
  assert.equal(mismatch.cluster, 4);
  assert.equal(mismatch.expected, 10);
  assert.equal(mismatch.assigned, 2);
  // |2 - 10| / 10 = 0.8 = 80% > 30% threshold
});
