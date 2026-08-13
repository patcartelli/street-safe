import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, bearingDeg, bearingDiffDeg, pointSegDistM } from '../src/geo.js';

test('haversineM: 0.001° lat ≈ 111 m', () => {
  const d = haversineM(40.74, -74.26, 40.741, -74.26);
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});

test('bearingDeg: due north ≈ 0, due east ≈ 90', () => {
  assert.ok(Math.abs(bearingDeg(40.74, -74.26, 40.75, -74.26)) < 1);
  assert.ok(Math.abs(bearingDeg(40.74, -74.26, 40.74, -74.25) - 90) < 1);
});

test('bearingDiffDeg is direction-insensitive', () => {
  assert.ok(bearingDiffDeg(10, 190) < 1);   // antiparallel ≈ parallel
  assert.ok(Math.abs(bearingDiffDeg(10, 100) - 90) < 1);
  assert.ok(bearingDiffDeg(355, 5) < 11);
});

test('pointSegDistM: point beside a segment', () => {
  // Segment runs E–W at lat 40.74; point 0.0002° (~22 m) north of its middle.
  const d = pointSegDistM(40.7402, -74.255, 40.74, -74.26, 40.74, -74.25);
  assert.ok(Math.abs(d - 22.2) < 1.5, `got ${d}`);
  // Point beyond segment end clamps to endpoint distance.
  const d2 = pointSegDistM(40.74, -74.27, 40.74, -74.26, 40.74, -74.25);
  assert.ok(Math.abs(d2 - 844) < 10, `got ${d2}`);
});
