import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCase, loadCauses, joinCauses } from '../build/causes.js';

test('normalizeCase collapses the five observed formats', () => {
  assert.equal(normalizeCase('C-2020-003108'), 'C2020003108');
  assert.equal(normalizeCase('I-2021-022853'), 'I2021022853');
  assert.equal(normalizeCase('2022-023704'), '2022023704');
  assert.equal(normalizeCase('22-012691'), '22012691');
  assert.equal(normalizeCase('C21048235'), 'C21048235');
  assert.equal(normalizeCase(' c-2020-003108 '), 'C2020003108');
});

test('loadCauses excludes uninformative labels but keeps the case key', () => {
  const csv = 'Department Case Number,cc_label\nC-2020-000001,Driver inattention\nC-2020-000001,None\nC-2020-000002,Unknown\n';
  const m = loadCauses(csv);
  assert.deepEqual(m.get('C2020000001'), ['Driver inattention']);
  // A crash whose only causes are uninformative still JOINS (coverage measures
  // join integrity, not cause informativeness) — it just carries no labels.
  assert.deepEqual(m.get('C2020000002'), []);
});

test('joinCauses throws loudly below 98% coverage', () => {
  const causes = new Map([['C2020000001', ['Driver inattention']]]);
  assert.throws(
    () => joinCauses(['C-2020-000001', 'MISSING-1', 'MISSING-2'], causes),
    /coverage 33\.3%.*MISSING1/s,
  );
});

test('joinCauses passes at full coverage', () => {
  const causes = new Map([['C2020000001', ['Driver inattention']]]);
  const r = joinCauses(['C-2020-000001'], causes);
  assert.equal(r.matchedPct, 1);
  assert.deepEqual(r.byCase.get('C2020000001'), ['Driver inattention']);
});
