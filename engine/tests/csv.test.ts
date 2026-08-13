import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../build/csv.js';

test('parseCsv handles quoted commas, escaped quotes, CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,plain,\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: '1', b: 'x, y', c: 'he said "hi"' });
  assert.deepEqual(rows[1], { a: '2', b: 'plain', c: '' });
});
