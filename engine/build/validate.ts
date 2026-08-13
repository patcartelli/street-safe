import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadGraph, nearestNode } from '../src/graph.js';
import { route } from '../src/router.js';
import { explainRoute } from '../src/explain.js';
import { haversineM } from '../src/geo.js';
import type { NodeRisk } from '../src/risk.js';

const ART = fileURLToPath(new URL('../artifacts/', import.meta.url));
const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const LAMBDAS = [0, 0.5, 1, 2, 3, 5];
const HOTSPOT_NEAR_M = 30;
const ENDPOINT_BUFFER_M = 100;
const CORRIDORS = [
  /irvington/i, /south orange av/i, /wyoming/i, /prospect/i, /sloan/i,
  /first st|1st st/i, /second st|2nd st/i, /third st|3rd st/i, /milligan/i,
  /centre st/i, /ridgewood/i, /academy/i, /vose/i, /valley/i,
];

const g = loadGraph(JSON.parse(readFileSync(join(ART, 'graph.json'), 'utf8')));
const riskArr: NodeRisk[] = JSON.parse(readFileSync(join(ART, 'risk.json'), 'utf8'));
const risk = new Map(riskArr.map((r) => [r.nodeId, r]));
const top10 = [...riskArr].sort((a, b) => b.stress - a.stress).slice(0, 10);

const STATION = { lat: 40.7459, lon: -74.2602 };
const SCHOOL = { lat: 40.7378, lon: -74.2658 };
const o = nearestNode(g, STATION.lat, STATION.lon);
const d = nearestNode(g, SCHOOL.lat, SCHOOL.lon);
const describe = (n: { id: string }) =>
  (g.adj.get(n.id) ?? []).map((i) => g.edges[i].name ?? g.edges[i].highway).join(' / ');
console.log(`origin snapped to ${o.id} (${describe(o)})`);
console.log(`dest   snapped to ${d.id} (${describe(d)})`);

function exposure(geometry: [number, number][]): number {
  let count = 0;
  for (const h of top10) {
    const hn = g.nodes.get(h.nodeId)!;
    if (haversineM(hn.lat, hn.lon, o.lat, o.lon) <= ENDPOINT_BUFFER_M) continue;
    if (haversineM(hn.lat, hn.lon, d.lat, d.lon) <= ENDPOINT_BUFFER_M) continue;
    if (geometry.some(([la, lo]) => haversineM(la, lo, hn.lat, hn.lon) <= HOTSPOT_NEAR_M)) count++;
  }
  return count;
}
function corridorOverlapPct(edgeIdxs: number[]): number {
  let on = 0, total = 0;
  for (const i of edgeIdxs) {
    const e = g.edges[i];
    total += e.lengthM;
    if (e.name && CORRIDORS.some((rx) => rx.test(e.name!))) on += e.lengthM;
  }
  return total ? (100 * on) / total : 0;
}

const rows: { lambda: number; distanceM: number; stressCostM: number; exposure: number; corridorPct: number }[] = [];
for (const lambda of LAMBDAS) {
  const r = route(g, risk, o.id, d.id, lambda);
  if (!r) throw new Error(`No route at λ=${lambda}`);
  const res = explainRoute(g, risk, r, lambda);
  rows.push({
    lambda, distanceM: Math.round(r.distanceM), stressCostM: Math.round(r.stressCostM),
    exposure: exposure(r.geometry), corridorPct: Math.round(corridorOverlapPct(r.edgeIdxs)),
  });
  if (lambda === 3) {
    console.log(`\nλ=3 flagged nodes:`);
    for (const f of res.flagged_nodes) console.log(` - ${f.name}: ${f.dominant_cause ?? 'n/a'} (crossing ${Math.round(f.crossing_penalty_m)} m)`);
  }
}
console.table(rows);

// Assert 1 (spec): distance nondecreasing, stress cost nonincreasing.
// stressCostM is lambda-weighted (segCost/crossing/bump all scale by lambda), so it is
// *always* exactly 0 at λ=0 and necessarily jumps positive at the next λ step for any
// route with real intersections — comparing it raw across λ tiers is not a meaningful
// check. What "nonincreasing" actually means here is the underlying raw (unweighted)
// excess stress the optimal route accepts, i.e. stressCostM / lambda, which is
// nonincreasing in λ by construction (concave lower envelope of route cost vs. λ) —
// verified against this harness's own λ-sweep data before landing this fix.
for (let i = 1; i < rows.length; i++) {
  if (rows[i].distanceM < rows[i - 1].distanceM - 1) throw new Error(`distance decreased at λ=${rows[i].lambda}`);
  if (rows[i].lambda > 0 && rows[i - 1].lambda > 0) {
    const prevRaw = rows[i - 1].stressCostM / rows[i - 1].lambda;
    const curRaw = rows[i].stressCostM / rows[i].lambda;
    if (curRaw > prevRaw + 1) throw new Error(`raw stress cost increased at λ=${rows[i].lambda}`);
  }
}
// Assert 2 (spec): λ≥2 exposure strictly below λ=0 exposure when the latter > 0.
// KNOWN FAILURE as of 2026-08-13 — exposure stays 1→1 because the Valley×Third risk
// cluster snapped to node 13198807872 while routes traverse sibling node 13198807866
// (~14.5 m away) which carries no risk record; a risk/graph topology join gap (single-
// node snap vs multi-node intersection complex), NOT a λ-tuning issue. Diagnosis:
// .git/sdd/task-12-report.md. Do not weaken this assert — fix the snap model (e.g.
// risk association radius) and re-run.
const e0 = rows[0].exposure;
const e2 = rows.find((r) => r.lambda === 2)!.exposure;
if (e0 > 0 && e2 >= e0) throw new Error(`hotspot exposure did not drop: λ=0 → ${e0}, λ=2 → ${e2}`);
console.log(`exposure λ=0: ${e0} → λ=2: ${e2} ✓`);

// Report 3: corridor overlap trend (no hard assert).
// Report 4: OSRM comparison, alarm at ±25%.
const baselinePath = join(DATA, 'osrm-baselines.json');
if (existsSync(baselinePath)) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'))['station-to-south-mountain'];
  const ratio = rows[0].distanceM / base.distanceM;
  const flag = Math.abs(ratio - 1) > 0.25 ? '  ⚠️ OUTSIDE ±25% — check graph connectivity/filtering' : ' ✓';
  console.log(`λ=0 vs OSRM foot: ${rows[0].distanceM} m vs ${Math.round(base.distanceM)} m (ratio ${ratio.toFixed(2)})${flag}`);
} else {
  console.log('⚠️ no OSRM baseline cached — run: npm run fetch-osrm');
}
console.log('validation complete');
