/** One-shot cache of OSRM's foot route for the validation pair (spec: the
 *  public demo server is rate-limited; the harness must never call it live). */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VALIDATION_PAIR, SECONDARY_PAIR } from './validation-pair.js';

const PAIRS = [
  { name: VALIDATION_PAIR.name, from: [VALIDATION_PAIR.from.lat, VALIDATION_PAIR.from.lon], to: [VALIDATION_PAIR.to.lat, VALIDATION_PAIR.to.lon] },
  { name: SECONDARY_PAIR.name, from: [SECONDARY_PAIR.from.lat, SECONDARY_PAIR.from.lon], to: [SECONDARY_PAIR.to.lat, SECONDARY_PAIR.to.lon] },
];
const out: Record<string, { distanceM: number; durationS: number }> = {};
for (const p of PAIRS) {
  const url = `https://router.project-osrm.org/route/v1/foot/${p.from[1]},${p.from[0]};${p.to[1]},${p.to[0]}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = await res.json();
  out[p.name] = { distanceM: json.routes[0].distance, durationS: json.routes[0].duration };
}
writeFileSync(fileURLToPath(new URL('../data/osrm-baselines.json', import.meta.url)), JSON.stringify(out, null, 2));
console.log(out);
