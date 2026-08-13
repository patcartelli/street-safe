import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../build/build-graph.js';
import { loadGraph, nearestNode, roadKey } from '../src/graph.js';

/** Fixture: a + shaped intersection at node 5.
 *  Main Ave (primary, E–W): 1 —— 5 —— 2 (two separate ways, same name)
 *  Vose Ave (residential, N–S): 3 —— 5 —— 4
 *  Plus a disconnected stub: 6 —— 7, and a foot=no way: 8 —— 5.
 */
const F = { elements: [
  { type: 'node', id: 1, lat: 40.740, lon: -74.262 },
  { type: 'node', id: 2, lat: 40.740, lon: -74.258 },
  { type: 'node', id: 3, lat: 40.742, lon: -74.260 },
  { type: 'node', id: 4, lat: 40.738, lon: -74.260 },
  { type: 'node', id: 5, lat: 40.740, lon: -74.260, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 6, lat: 40.750, lon: -74.250 },
  { type: 'node', id: 7, lat: 40.751, lon: -74.250 },
  { type: 'node', id: 8, lat: 40.740, lon: -74.264 },
  { type: 'way', id: 101, nodes: [1, 5], tags: { highway: 'primary', name: 'Main Ave' } },
  { type: 'way', id: 102, nodes: [5, 2], tags: { highway: 'primary', name: 'Main Ave' } },
  { type: 'way', id: 103, nodes: [3, 5, 4], tags: { highway: 'residential', name: 'Vose Ave' } },
  { type: 'way', id: 104, nodes: [6, 7], tags: { highway: 'residential', name: 'Nowhere St' } },
  { type: 'way', id: 105, nodes: [8, 5], tags: { highway: 'residential', name: 'Closed St', foot: 'no' } },
] } as any;

test('buildGraph: filtering, intersection splitting, components', () => {
  const { graph, report } = buildGraph(F);
  const g = loadGraph(graph);
  // foot=no excluded; disconnected 6–7 dropped by largest-component filter.
  const names = new Set(graph.edges.map((e) => e.name));
  assert.ok(!names.has('Closed St'));
  assert.ok(!names.has('Nowhere St'));
  // Way 103 splits at intersection node 5 into two edges (3–5, 5–4).
  const vose = graph.edges.filter((e) => e.name === 'Vose Ave');
  assert.equal(vose.length, 2);
  // Signal on node 5 (exact node here; radius association also covers offsets).
  assert.equal(g.nodes.get('5')!.signal, true);
  assert.equal(report.waysExcluded, 1);
  assert.ok(report.largestComponentPct > 0.6);
  // Fixture has no crossing-tagged nodes, so crossing coverage must be 0.
  assert.equal(report.tagCoverage.crossing, 0);
});

test('roadKey: same street across the intersection shares a key despite way split', () => {
  const { graph } = buildGraph(F);
  const main = graph.edges.filter((e) => e.name === 'Main Ave');
  assert.equal(main.length, 2);
  assert.equal(roadKey(main[0]), roadKey(main[1]));
});

test('nearestNode snaps', () => {
  const { graph } = buildGraph(F);
  const g = loadGraph(graph);
  assert.equal(nearestNode(g, 40.7401, -74.2601).id, '5');
});
