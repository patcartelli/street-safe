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

/** Two graph nodes ~16 m apart; one OSM signal 6 m from node 25, 12 m from node 24.
 *  Old 20 m radius marked both; nearest-only must mark exactly node 25.
 *  Way 303 (25–27) forces node 25 to intersection status so it materializes as
 *  its own graph node rather than being swallowed into edge geometry between 24 and 26
 *  (verified against buildGraph's isIntersection logic: without it, 25 is an interior,
 *  singly-used node on way 302 and never becomes a graph node).
 */
const SIG = { elements: [
  { type: 'node', id: 21, lat: 40.7400, lon: -74.2620 },
  { type: 'node', id: 24, lat: 40.7400, lon: -74.2600 },
  { type: 'node', id: 25, lat: 40.74014, lon: -74.2600 },
  { type: 'node', id: 26, lat: 40.7403, lon: -74.2600 },
  { type: 'node', id: 27, lat: 40.7400, lon: -74.2580 },
  { type: 'node', id: 28, lat: 40.74008, lon: -74.26001, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 29, lat: 40.74011, lon: -74.25999, tags: { crossing: 'marked' } },
  { type: 'way', id: 301, nodes: [21, 24, 27], tags: { highway: 'residential', name: 'Low St' } },
  { type: 'way', id: 302, nodes: [24, 25, 26], tags: { highway: 'residential', name: 'Up Ave' } },
  { type: 'way', id: 303, nodes: [25, 27], tags: { highway: 'service' } },
] } as any;

test('signal and crossing tags assign to exactly one nearest node', () => {
  const { graph } = buildGraph(SIG);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const signalled = graph.nodes.filter((n) => n.signal).map((n) => n.id);
  assert.deepEqual(signalled, ['25']); // nearest only — node 24 must NOT be marked
  const crossed = graph.nodes.filter((n) => n.crossing !== null).map((n) => n.id);
  assert.deepEqual(crossed, ['25']); // crossing node 29 is ~4 m from 25, ~13 m from 24; 10 m cap excludes 24 anyway
  assert.equal(byId.get('25')!.crossing, 'marked');
});
