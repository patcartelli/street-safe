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

/** Two parallel roads (Far St listed first in array), nearer one is 10 m from
 *  sidewalk, farther one is 20 m — sidewalk should collapse onto nearer.
 *  Far St is listed first in elements array, but Near St is matched (distance priority).
 *  Connector way ensures both roads stay in main component. */
const F2 = { elements: [
  { type: 'node', id: 10, lat: 40.7400, lon: -74.262 },
  { type: 'node', id: 11, lat: 40.7400, lon: -74.258 },
  { type: 'node', id: 12, lat: 40.7401, lon: -74.262 },
  { type: 'node', id: 13, lat: 40.7401, lon: -74.258 },
  { type: 'node', id: 14, lat: 40.7402, lon: -74.262 },
  { type: 'node', id: 15, lat: 40.7402, lon: -74.258 },
  // Far St (farther from sidewalk): listed first in array.
  { type: 'way', id: 301, nodes: [10, 11], tags: { highway: 'residential', name: 'Far St' } },
  // Near St (nearer to sidewalk): listed second.
  { type: 'way', id: 302, nodes: [12, 13], tags: { highway: 'residential', name: 'Near St' } },
  // Sidewalk way parallel to both roads (will be collapsed onto Near St).
  { type: 'way', id: 303, nodes: [14, 15], tags: { highway: 'footway', footway: 'sidewalk' } },
  // Connector between Far St and Near St keeps them in main component
  // even after sidewalk removal.
  { type: 'way', id: 304, nodes: [11, 13], tags: { highway: 'residential' } },
] } as any;

test('sidewalk collapses onto nearest qualifying road, not first in array', () => {
  const { graph, report } = buildGraph(F2);
  assert.equal(report.sidewalkSeparateWays, 1);
  assert.equal(report.sidewalkCollapsed, 1);
  assert.equal(report.sidewalkUnmatched, 0);
  // Near St should have the sidewalk tag upgrade.
  const nearSt = graph.edges.find((e) => e.name === 'Near St')!;
  assert.ok(nearSt, 'Near St edge should exist');
  assert.ok(nearSt.ltsReasons.some((r) => /sidewalk/.test(r.reason) && r.source === 'tagged'),
    'Near St should have sidewalk ltsReason with tagged source');
  // Far St should NOT have the sidewalk tag upgrade.
  const farSt = graph.edges.find((e) => e.name === 'Far St')!;
  assert.ok(farSt, 'Far St edge should exist');
  assert.ok(!farSt.ltsReasons.some((r) => /sidewalk/.test(r.reason) && r.source === 'tagged'),
    'Far St should NOT have sidewalk ltsReason');
});
