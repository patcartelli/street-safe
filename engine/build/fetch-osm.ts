/** Stage 1 (spec). Re-fetching is an explicit versioned action: if a snapshot
 *  already exists, the new response is written to osm-raw.new.json with a diff
 *  report; promoting it is a manual rename. Normal builds never hit the network. */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BBOX = '40.7300,-74.2930,40.7710,-74.2360'; // South Orange + ~300 m buffer
const HIGHWAYS = 'footway|path|pedestrian|steps|living_street|residential|unclassified|service|tertiary|secondary|primary|cycleway';
const query = `[out:json][timeout:120];
way["highway"~"^(${HIGHWAYS})$"](${BBOX});
(._;>;);
out body;`;

let res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'User-Agent': 'street-safe-osm-fetch/1.0' },
  body: 'data=' + encodeURIComponent(query),
});

// Retry with fallback mirror if rate-limited or unavailable
if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
  console.log(`Primary endpoint returned ${res.status}, retrying with mirror...`);
  await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60s for rate limit
  res = await fetch('https://overpass.kumi.systems/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'street-safe-osm-fetch/1.0' },
    body: 'data=' + encodeURIComponent(query),
  });
}

if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
const json = await res.json();
const ways = json.elements.filter((e: { type: string }) => e.type === 'way').length;
const nodes = json.elements.filter((e: { type: string }) => e.type === 'node').length;
if (ways < 500) throw new Error(`Suspiciously few ways (${ways}) — bad bbox or filter?`);

const target = fileURLToPath(new URL('../data/osm-raw.json', import.meta.url));
if (existsSync(target)) {
  const old = JSON.parse(readFileSync(target, 'utf8'));
  const oldWays = old.elements.filter((e: { type: string }) => e.type === 'way').length;
  const oldNodes = old.elements.filter((e: { type: string }) => e.type === 'node').length;
  writeFileSync(target.replace(/\.json$/, '.new.json'), JSON.stringify(json));
  console.log(`Existing snapshot kept. Diff: ways ${oldWays} → ${ways}, nodes ${oldNodes} → ${nodes}.`);
  console.log('Review, then promote with: mv engine/data/osm-raw.new.json engine/data/osm-raw.json');
} else {
  writeFileSync(target, JSON.stringify(json));
  console.log(`Snapshot written: ${ways} ways, ${nodes} nodes.`);
}
