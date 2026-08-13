import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../build/build-graph.js';

/** Tertiary road E–W with a parallel sidewalk way ~11 m north of it,
 *  plus a far-away sidewalk way that must NOT collapse. */
const F = { elements: [
  { type: 'node', id: 1, lat: 40.7400, lon: -74.262 },
  { type: 'node', id: 2, lat: 40.7400, lon: -74.258 },
  { type: 'node', id: 3, lat: 40.7401, lon: -74.262 },
  { type: 'node', id: 4, lat: 40.7401, lon: -74.258 },
  { type: 'node', id: 5, lat: 40.7500, lon: -74.262 },
  { type: 'node', id: 6, lat: 40.7500, lon: -74.258 },
  { type: 'way', id: 201, nodes: [1, 2], tags: { highway: 'tertiary', name: 'Centre St' } },
  { type: 'way', id: 202, nodes: [3, 4], tags: { highway: 'footway', footway: 'sidewalk' } },
  { type: 'way', id: 203, nodes: [5, 6], tags: { highway: 'footway', footway: 'sidewalk' } },
] } as any;

test('parallel sidewalk collapses onto road; distant one survives', () => {
  const { graph, report } = buildGraph(F);
  assert.equal(report.sidewalkSeparateWays, 2);
  assert.equal(report.sidewalkCollapsed, 1);
  assert.equal(report.sidewalkUnmatched, 1);
  const centre = graph.edges.find((e) => e.name === 'Centre St')!;
  // Collapsed sidewalk upgrades the road: tertiary(3) − sidewalk(1) = 2.
  assert.equal(centre.lts, 2);
  assert.ok(centre.ltsReasons.some((r) => /sidewalk/.test(r.reason) && r.source === 'tagged'));
  // The far sidewalk way remains its own footway edge... in the OTHER component,
  // so after largest-component filtering only one component survives. Assert on
  // report counts (above) rather than edge presence.
});
