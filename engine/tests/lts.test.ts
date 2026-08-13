import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentLts, crossingLts } from '../src/lts.js';

test('base classes per spec table', () => {
  assert.equal(segmentLts({ highway: 'footway' }).lts, 1);
  assert.equal(segmentLts({ highway: 'residential' }).lts, 2);
  assert.equal(segmentLts({ highway: 'tertiary' }).lts, 3);
  assert.equal(segmentLts({ highway: 'primary' }).lts, 4);
});

test('sidewalk adjustments with provenance', () => {
  const both = segmentLts({ highway: 'tertiary', sidewalk: 'both' });
  assert.equal(both.lts, 2);
  assert.ok(both.reasons.some((r) => r.source === 'tagged' && /sidewalk/.test(r.reason)));
  const none = segmentLts({ highway: 'residential', sidewalk: 'no' });
  assert.equal(none.lts, 3);
  const unknown = segmentLts({ highway: 'residential' });
  assert.equal(unknown.lts, 2); // default: no adjustment, but reason recorded
  assert.ok(unknown.reasons.some((r) => r.source === 'default' && /sidewalk unknown/.test(r.reason)));
});

test('speed and lanes adjustments, clamping', () => {
  assert.equal(segmentLts({ highway: 'residential', maxspeed: '40 mph' }).lts, 3);
  assert.equal(segmentLts({ highway: 'residential', maxspeed: '20 mph' }).lts, 1);
  assert.equal(segmentLts({ highway: 'primary', maxspeed: '45 mph', lanes: '4', sidewalk: 'no' }).lts, 4); // clamped
  assert.equal(segmentLts({ highway: 'footway', maxspeed: '20 mph' }).lts, 1); // clamp floor
});

test('steps flagged', () => {
  const s = segmentLts({ highway: 'steps' });
  assert.equal(s.lts, 1);
  assert.equal(s.steps, true);
});

test('crossingLts discounts and clamps', () => {
  assert.equal(crossingLts(4, true, null), 3);        // signal −1
  assert.equal(crossingLts(4, false, 'marked'), 3.5); // marked −0.5
  assert.equal(crossingLts(4, false, null), 4);       // unmarked: full
  assert.equal(crossingLts(1, true, null), 1);        // clamp floor — never negative penalty
});
