import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDataLine } from '../build/extract-points.js';

test('parseDataLine finds and parses the DATA object', () => {
  const html = [
    '<script>',
    'const DATA = {"points":[{"la":40.75,"lo":-74.26,"k":"pdo","y":"2022","d":"01/02/2022","t":"Rear-end","loc":"A \\u00d7 B","c":"C-2022-000001"}]};',
    '</script>',
  ].join('\n');
  const data = parseDataLine(html);
  assert.equal(data.points.length, 1);
  assert.equal(data.points[0].la, 40.75);
  assert.equal(data.points[0].c, 'C-2022-000001');
  assert.equal(data.points[0].loc, 'A × B');
});

test('parseDataLine throws when DATA line is missing', () => {
  assert.throws(() => parseDataLine('<html>no data here</html>'), /DATA line not found/);
});
