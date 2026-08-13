import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseCsv } from './csv.js';
import { buildGraph } from './build-graph.js';
import { loadCauses, joinCauses } from './causes.js';
import { snapRisk, type HotspotRow, type PointRow } from './snap-risk.js';
import { loadGraph } from '../src/graph.js';
import { haversineM } from '../src/geo.js';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../artifacts/', import.meta.url));
const VEHICLES_DIR = process.env.SAFE_ROUTES_DATA_DIR
  ?? join(process.env.HOME!, 'Documents/Claude/Projects/Linear');

const osm = JSON.parse(readFileSync(join(DATA, 'osm-raw.json'), 'utf8'));
const { graph, report } = buildGraph(osm);
if (report.largestComponentPct < 0.95) {
  throw new Error(`Connectivity ${(report.largestComponentPct * 100).toFixed(1)}% < 95% floor`);
}

// Build-time invariant guards: a future OSM re-fetch must not silently regress these.
const shortGeom = graph.edges.filter((e) => e.geometry.length < 2);
if (shortGeom.length > 0) {
  throw new Error(`${shortGeom.length} edge(s) have geometry.length < 2 (router requires >= 2 points per edge)`);
}
const EPS_M = 1e-6;
const inadmissible = graph.edges.filter((e) => {
  const first = e.geometry[0], last = e.geometry[e.geometry.length - 1];
  return e.lengthM < haversineM(first[0], first[1], last[0], last[1]) - EPS_M;
});
if (inadmissible.length > 0) {
  throw new Error(`${inadmissible.length} edge(s) have lengthM < haversine(first, last) geometry point — A* admissibility precondition violated`);
}

const g = loadGraph(graph);

const hotspots: HotspotRow[] = parseCsv(readFileSync(join(DATA, 'so_hotspots.csv'), 'utf8')).map((r) => ({
  cluster: Number(r.cluster), lat: Number(r.lat), lon: Number(r.lon), n: Number(r.n),
  stress: Number(r.stress), injury_n: Number(r.injury_n), vru_n: Number(r.vru_n),
  location: r.location, cross: r.cross,
}));
const points: PointRow[] = parseCsv(readFileSync(join(DATA, 'so_points_clustered.csv'), 'utf8')).map((r) => ({
  lat: Number(r.lat), lon: Number(r.lon), kind: r.kind, case: r.case,
}));
const causes = loadCauses(readFileSync(join(VEHICLES_DIR, 'south_orange_vehicles_joined.csv'), 'utf8'));
const joined = joinCauses(points.map((p) => p.case), causes);
const { risk, report: snapReport } = snapRisk(g, hotspots, points, joined.byCase);

mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(join(ARTIFACTS, 'graph.json'), JSON.stringify(graph));
writeFileSync(join(ARTIFACTS, 'risk.json'), JSON.stringify(risk));
const full = { ...report, snap: snapReport, joinCoveragePct: joined.matchedPct * 100, riskNodes: risk.length };
writeFileSync(join(ARTIFACTS, 'build-report.json'), JSON.stringify(full, null, 2));
console.log(JSON.stringify(full, null, 2));
