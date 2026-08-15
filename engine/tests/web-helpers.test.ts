import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeFlagged, minutesAt80, avoidedComplexes, personaLabel } from '../../web/helpers.js';

const cx = new Map([['A', 'A'], ['A2', 'A'], ['B', 'B']]);
const f = (node_id: string, crash_n: number) => ({
  node_id, name: `node ${node_id}`, crossing_penalty_m: 0, crossed_way: null,
  crash_n, dominant_cause: 'Driver inattention', cause_distribution: {},
});

test('dedupeFlagged keeps one entry per physical complex, highest crashN', () => {
  const out = dedupeFlagged([f('A', 3), f('A2', 7), f('B', 2)], cx);
  assert.equal(out.length, 2);
  assert.equal(out.find((d) => d.name === 'node A2')!.crashN, 7); // A-group survivor
});

test('dedupeFlagged passes through nodes absent from the risk map', () => {
  const out = dedupeFlagged([f('Z', 0)], cx); // crossing-only flag, no risk entry
  assert.equal(out.length, 1);
});

test('minutesAt80 rounds', () => {
  assert.equal(minutesAt80(1473), 18);
  assert.equal(minutesAt80(0), 0);
});

test('avoidedComplexes counts distinct complexes on fast but not safe', () => {
  assert.equal(avoidedComplexes([f('A', 3), f('A2', 7), f('B', 1)], [f('B', 1)], cx), 1); // A-complex avoided
  assert.equal(avoidedComplexes([f('B', 1)], [f('B', 1)], cx), 0);
});

test('personaLabel matches detents within ±0.05 only', () => {
  assert.equal(personaLabel(0.5), 'confident walker');
  assert.equal(personaLabel(0.55), 'confident walker');
  assert.equal(personaLabel(0.56), null);
  assert.equal(personaLabel(2), 'with a stroller');
  assert.equal(personaLabel(1.95), 'with a stroller');
  assert.equal(personaLabel(3.04), 'with a child');
  assert.equal(personaLabel(0), null);
  assert.equal(personaLabel(5), null);
  assert.equal(personaLabel(1.2), null);
});
