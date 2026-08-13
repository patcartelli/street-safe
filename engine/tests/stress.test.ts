import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_PENALTY_M, crashBumpM, crossingPenaltyM } from '../src/stress.js';

test('crashBumpM: log-shaped, capped at BASE_PENALTY_M', () => {
  assert.equal(crashBumpM(0), 0);
  assert.equal(crashBumpM(42), BASE_PENALTY_M);          // max observed cluster stress → full bump
  assert.equal(crashBumpM(9999), BASE_PENALTY_M);        // cap holds beyond calibration point
  const b10 = crashBumpM(10);
  assert.ok(b10 > 0 && b10 < BASE_PENALTY_M);
  assert.ok(crashBumpM(10) > crashBumpM(5));             // monotone
  // log shape: doubling stress far less than doubles the bump
  assert.ok(crashBumpM(20) < 2 * crashBumpM(10) * 0.8);
});

test('crossingPenaltyM composes crossing LTS and bump', () => {
  assert.equal(crossingPenaltyM(4, false, null, 0), 75);   // (4−1)·25
  assert.equal(crossingPenaltyM(4, true, null, 0), 50);    // signal −1 → (3−1)·25
  assert.equal(crossingPenaltyM(1, false, null, 10), 10);  // no crossing stress, bump only
});
