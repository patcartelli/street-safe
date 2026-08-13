# V1 Safety-Weighted Routing Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pedestrian graph + LTS stress model + directed-edge A* router with explainability payloads and a scripted validation harness, per `docs/superpowers/specs/2026-08-12-v1-routing-engine-design.md`.

**Architecture:** Offline build pipeline (`engine/build/`, runs via tsx) turns a committed Overpass snapshot + crash CSVs into two committed artifacts (`graph.json`, `risk.json`). A zero-dependency runtime (`engine/src/`) loads the artifacts and runs A* in directed-edge space with `cost = distance + λ·stress`. Tests use `node:test` via `tsx --test`.

**Tech Stack:** TypeScript. devDeps: `tsx`, `typescript` (typecheck only — a deliberate one-package addition to the spec's "tsx sole devDep" shorthand). Runtime dependencies: **zero**.

## Global Constraints

- `engine/src/` must import nothing outside `engine/src/` and use no network, no `node:fs` (artifacts are passed in as parsed JSON) — it must stay browser-portable.
- `engine/build/` may use `node:fs` and (only in `fetch-osm.ts` / `fetch-osrm-baseline.ts`) the network.
- The build never reads `so-crash-stress-map.html` except in the one-time `extract-points.ts`.
- `south_orange_vehicles_joined.csv` is **NOT committed to the repo** (public GitHub; per-vehicle records stay local). It is read from `~/Documents/Claude/Projects/Linear/` (override via env `SAFE_ROUTES_DATA_DIR`). Only aggregated cause distributions land in `risk.json`.
- Constants from spec (copy verbatim): `BASE_PENALTY_M = 25`; crash bump `k = 1/log1p(42)`, bump capped at `BASE_PENALTY_M`; signal/crossing association radius 20 m; sidewalk collapse match ≤ 25 m and ≤ 20°; cluster snap max 30 m; point→cluster assignment ≤ 25 m; join coverage assert ≥ 98%; connectivity assert ≥ 95%; λ sweep {0, 0.5, 1, 2, 3, 5}; endpoint exposure buffer 100 m; hotspot proximity 30 m; OSRM alarm ±25%.
- Every LTS reason carries `source: "tagged" | "default"`. Defaults are never rendered as facts.
- Commit after every task. No Linear state changes; progress comments only, and only via the checkpoint in Task 12.

---

### Task 1: Scaffolding + one-time point extraction (Stage 0)

**Files:**
- Create: `package.json`, `tsconfig.json`, `engine/build/extract-points.ts`, `engine/tests/extract.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `engine/data/so_points_clustered.csv` (columns `lat,lon,kind,year,date,crash_type,loc,case`, 632 rows), `engine/data/so_hotspots.csv` (copied verbatim: `cluster,lat,lon,n,stress,injury_n,vru_n,location,cross`), npm scripts `test`, `extract`.
- Produces: `parseDataLine(html: string): { points: RawPoint[] }` exported from `extract-points.ts`; `RawPoint = { la: number; lo: number; k: string; y: string; d: string; t: string; loc: string; c: string }`.

- [ ] **Step 1: Scaffold npm + tsconfig + gitignore**

```bash
cd ~/dev/street-safe
npm init -y
npm install --save-dev tsx typescript
```

(If npm prompts to approve esbuild build scripts for tsx, approve.) Then overwrite `package.json` fields so it reads:

```json
{
  "name": "street-safe",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "tsx --test engine/tests/*.test.ts",
    "typecheck": "tsc --noEmit",
    "extract": "tsx engine/build/extract-points.ts",
    "fetch-osm": "tsx engine/build/fetch-osm.ts",
    "fetch-osrm": "tsx engine/build/fetch-osrm-baseline.ts",
    "build-engine": "tsx engine/build/build.ts",
    "validate": "tsx engine/build/validate.ts"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

(Keep the versions npm actually installed.) Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["engine/**/*.ts"]
}
```

`tsc --noEmit` needs node types: `npm install --save-dev @types/node`. Append to `.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Write the failing test**

Create `engine/tests/extract.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../build/extract-points.js`.

- [ ] **Step 4: Write the extraction script**

Create `engine/build/extract-points.ts`:

```ts
/**
 * ONE-TIME extraction (spec Stage 0). so-crash-stress-map.html is the live
 * STC-211 spot-check tool, not a data file — after this script has run and
 * its CSV outputs are committed, nothing in the build may read the HTML again.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface RawPoint {
  la: number; lo: number; k: string; y: string;
  d: string; t: string; loc: string; c: string;
}

export function parseDataLine(html: string): { points: RawPoint[] } {
  const line = html.split('\n').find((l) => l.trimStart().startsWith('const DATA = '));
  if (!line) throw new Error('DATA line not found in map HTML');
  const json = line.slice(line.indexOf('const DATA = ') + 'const DATA = '.length).replace(/;\s*$/, '');
  return JSON.parse(json);
}

const DATA_DIR = process.env.SAFE_ROUTES_DATA_DIR
  ?? join(process.env.HOME!, 'Documents/Claude/Projects/Linear');
const OUT_DIR = fileURLToPath(new URL('../data/', import.meta.url));

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(join(DATA_DIR, 'so-crash-stress-map.html'), 'utf8');
  const { points } = parseDataLine(html);
  if (points.length !== 632) throw new Error(`Expected 632 points, got ${points.length}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const header = 'lat,lon,kind,year,date,crash_type,loc,case\n';
  const rows = points.map((p) =>
    [p.la, p.lo, p.k, p.y, p.d, p.t, p.loc, p.c].map((v) => csvEscape(String(v))).join(','));
  writeFileSync(join(OUT_DIR, 'so_points_clustered.csv'), header + rows.join('\n') + '\n');
  copyFileSync(join(DATA_DIR, 'so_hotspots.csv'), join(OUT_DIR, 'so_hotspots.csv'));
  console.log(`Wrote ${points.length} points and copied so_hotspots.csv to engine/data/`);
}
```

- [ ] **Step 5: Run tests, then run the extraction**

Run: `npm test` → both tests PASS.
Run: `npm run extract`
Expected: `Wrote 632 points and copied so_hotspots.csv to engine/data/`. Verify: `wc -l engine/data/*.csv` → 633 and 53 lines.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore engine/
git commit -m "feat(engine): scaffold + one-time crash point extraction (Stage 0)"
```

---

### Task 2: Overpass fetch with versioned re-fetch guard

**Files:**
- Create: `engine/build/fetch-osm.ts`

**Interfaces:**
- Produces: `engine/data/osm-raw.json` — raw Overpass response `{ elements: Array<{type:'node',id,lat,lon,tags?} | {type:'way',id,nodes:number[],tags}> }`, committed. Later tasks read only this snapshot.

- [ ] **Step 1: Write the fetch script**

Create `engine/build/fetch-osm.ts`:

```ts
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

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  body: 'data=' + encodeURIComponent(query),
});
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
```

- [ ] **Step 2: Run it**

Run: `npm run fetch-osm`
Expected: `Snapshot written: <N> ways, <M> nodes.` with N in the low thousands. If Overpass rate-limits (429), wait a minute and retry once; if it persists, switch the URL to `https://overpass.kumi.systems/api/interpreter` and retry.

- [ ] **Step 3: Sanity-check the snapshot**

Run: `node -e "const j=require('./engine/data/osm-raw.json'); const names=new Set(j.elements.filter(e=>e.tags&&e.tags.name).map(e=>e.tags.name)); for (const n of ['South Orange Avenue','Vose Avenue','Valley Street']) console.log(n, names.has(n));"`
Expected: all three `true`. If any is `false`, print nearby name variants (`[...names].filter(n=>/orange|vose|valley/i.test(n))`) and record the actual OSM spellings — Task 12's corridor matcher and validation depend on real names, and misspelled assumptions here are exactly the silent failure the spec forbids.

- [ ] **Step 4: Commit**

```bash
git add engine/build/fetch-osm.ts engine/data/osm-raw.json
git commit -m "feat(engine): committed Overpass snapshot with versioned re-fetch guard"
```

---

### Task 3: Geometry + CSV utilities

**Files:**
- Create: `engine/src/geo.ts`, `engine/build/csv.ts`
- Test: `engine/tests/geo.test.ts`, `engine/tests/csv.test.ts`

**Interfaces:**
- Produces (`engine/src/geo.ts`): `haversineM(lat1,lon1,lat2,lon2): number` · `bearingDeg(lat1,lon1,lat2,lon2): number` (0–360) · `bearingDiffDeg(a,b): number` (0–90, direction-insensitive: parallel and antiparallel both ≈ 0) · `pointSegDistM(plat,plon,alat,alon,blat,blon): number`.
- Produces (`engine/build/csv.ts`): `parseCsv(text: string): Record<string,string>[]` (quoted fields, embedded commas/quotes, CRLF).

- [ ] **Step 1: Write failing tests**

Create `engine/tests/geo.test.ts`:

```ts
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
```

Create `engine/tests/csv.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../build/csv.js';

test('parseCsv handles quoted commas, escaped quotes, CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,plain,\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: '1', b: 'x, y', c: 'he said "hi"' });
  assert.deepEqual(rows[1], { a: '2', b: 'plain', c: '' });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `engine/src/geo.ts`:

```ts
const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings treating opposite directions as equal (0–90). */
export function bearingDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Equirectangular point-to-segment distance — fine at town scale. */
export function pointSegDistM(
  plat: number, plon: number,
  alat: number, alon: number,
  blat: number, blon: number,
): number {
  const kx = Math.cos(toRad(alat)) * 111320; // m per deg lon at this latitude
  const ky = 110540;                          // m per deg lat
  const px = (plon - alon) * kx, py = (plat - alat) * ky;
  const bx = (blon - alon) * kx, by = (blat - alat) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}
```

Create `engine/build/csv.ts`:

```ts
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field.replace(/\r$/, '')); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS. Run `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add engine/src/geo.ts engine/build/csv.ts engine/tests/geo.test.ts engine/tests/csv.test.ts
git commit -m "feat(engine): geometry and CSV utilities"
```

---

### Task 4: Pedestrian LTS rubric

**Files:**
- Create: `engine/src/lts.ts`
- Test: `engine/tests/lts.test.ts`

**Interfaces:**
- Produces: `type Source = 'tagged' | 'default'` · `interface LtsReason { reason: string; source: Source }` · `type Lts = 1 | 2 | 3 | 4` · `segmentLts(tags: Record<string,string>): { lts: Lts; reasons: LtsReason[]; steps: boolean }` · `crossingLts(maxCrossedLts: number, signal: boolean, crossing: string | null): number` (clamped 1–4, may be fractional after the 0.5 marked-crossing discount).

- [ ] **Step 1: Write failing tests**

Create `engine/tests/lts.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentLts, crossingLts } from '../src/lts.js';

test('base classes per spec table', () => {
  assert.equal(segmentLts({ highway: 'footway' }).lts, 1);
  assert.equal(segmentLts({ highway: 'residential' }).lts, 2);
  assert.equal(segmentLts({ highway: 'tertiary' }).lts, 3);
  assert.equal(segmentLts({ highway: 'primary' }).lts, 4);
});

test('sidewalk adjustments with provenance', () => {
  const both = segmentLts({ highway: 'tertiary', sidewalk: 'both' });
  assert.equal(both.lts, 2);
  assert.ok(both.reasons.some((r) => r.source === 'tagged' && /sidewalk/.test(r.reason)));
  const none = segmentLts({ highway: 'residential', sidewalk: 'no' });
  assert.equal(none.lts, 3);
  const unknown = segmentLts({ highway: 'residential' });
  assert.equal(unknown.lts, 2); // default: no adjustment, but reason recorded
  assert.ok(unknown.reasons.some((r) => r.source === 'default' && /sidewalk unknown/.test(r.reason)));
});

test('speed and lanes adjustments, clamping', () => {
  assert.equal(segmentLts({ highway: 'residential', maxspeed: '40 mph' }).lts, 3);
  assert.equal(segmentLts({ highway: 'residential', maxspeed: '20 mph' }).lts, 1);
  assert.equal(segmentLts({ highway: 'primary', maxspeed: '45 mph', lanes: '4', sidewalk: 'no' }).lts, 4); // clamped
  assert.equal(segmentLts({ highway: 'footway', maxspeed: '20 mph' }).lts, 1); // clamp floor
});

test('steps flagged', () => {
  const s = segmentLts({ highway: 'steps' });
  assert.equal(s.lts, 1);
  assert.equal(s.steps, true);
});

test('crossingLts discounts and clamps', () => {
  assert.equal(crossingLts(4, true, null), 3);        // signal −1
  assert.equal(crossingLts(4, false, 'marked'), 3.5); // marked −0.5
  assert.equal(crossingLts(4, false, null), 4);       // unmarked: full
  assert.equal(crossingLts(1, true, null), 1);        // clamp floor — never negative penalty
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `engine/src/lts.ts`:

```ts
export type Source = 'tagged' | 'default';
export interface LtsReason { reason: string; source: Source }
export type Lts = 1 | 2 | 3 | 4;

const BASE: Record<string, number> = {
  footway: 1, path: 1, pedestrian: 1, living_street: 1, steps: 1,
  residential: 2, unclassified: 2, service: 2, cycleway: 2,
  tertiary: 3, secondary: 3, primary: 4,
};
const PEDESTRIAN_ONLY = new Set(['footway', 'path', 'pedestrian', 'steps']);

function parseMph(maxspeed: string | undefined): number | null {
  if (!maxspeed) return null;
  const m = maxspeed.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null; // NJ default unit is mph
}

export function segmentLts(tags: Record<string, string>): { lts: Lts; reasons: LtsReason[]; steps: boolean } {
  const hw = tags.highway ?? 'unclassified';
  let score = BASE[hw] ?? 2;
  const reasons: LtsReason[] = [{ reason: `${hw} (base ${score})`, source: 'tagged' }];
  const isRoad = !PEDESTRIAN_ONLY.has(hw);

  const sw = tags.sidewalk;
  if (isRoad) {
    if (sw === 'both' || sw === 'yes') { score -= 1; reasons.push({ reason: 'sidewalk present', source: 'tagged' }); }
    else if (sw === 'left' || sw === 'right') { reasons.push({ reason: 'sidewalk one side only', source: 'tagged' }); }
    else if (sw === 'no' || sw === 'none') {
      if (score >= 2) { score += 1; reasons.push({ reason: 'no sidewalk', source: 'tagged' }); }
    } else reasons.push({ reason: 'sidewalk unknown, assumed absent', source: 'default' });
  }

  const mph = parseMph(tags.maxspeed);
  if (mph !== null) {
    if (mph >= 35) { score += 1; reasons.push({ reason: `${mph} mph`, source: 'tagged' }); }
    else if (mph <= 20) { score -= 1; reasons.push({ reason: `${mph} mph`, source: 'tagged' }); }
    else reasons.push({ reason: `${mph} mph`, source: 'tagged' });
  } else if (isRoad) {
    reasons.push({ reason: 'speed unknown, class default assumed', source: 'default' });
  }

  const lanes = parseInt(tags.lanes ?? '', 10);
  if (lanes >= 4) { score += 1; reasons.push({ reason: `${lanes} lanes`, source: 'tagged' }); }

  const lts = Math.min(4, Math.max(1, score)) as Lts;
  return { lts, reasons, steps: hw === 'steps' };
}

/** Crossing LTS: highest-LTS road being crossed, discounted by crossing quality.
 *  Clamped 1–4 after discounts (spec: a discount never yields a negative penalty). */
export function crossingLts(maxCrossedLts: number, signal: boolean, crossing: string | null): number {
  let lts = maxCrossedLts;
  if (signal) lts -= 1;
  else if (crossing === 'marked' || crossing === 'zebra' || crossing === 'uncontrolled' || crossing === 'traffic_signals') lts -= 0.5;
  return Math.min(4, Math.max(1, lts));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/lts.ts engine/tests/lts.test.ts
git commit -m "feat(engine): pedestrian LTS rubric with tagged/default provenance"
```

---

### Task 5: Graph build core (parse → filter → intersections → edges → components)

**Files:**
- Create: `engine/src/graph.ts`, `engine/build/build-graph.ts`
- Test: `engine/tests/build-graph.test.ts`

**Interfaces:**
- Produces (`engine/src/graph.ts`):

```ts
import type { Lts, LtsReason } from './lts.js';

export interface GraphNode { id: string; lat: number; lon: number; signal: boolean; crossing: string | null }
export interface GraphEdge {
  from: string; to: string; wayId: string; name: string | null; highway: string;
  lengthM: number; lts: Lts; ltsReasons: LtsReason[]; steps: boolean;
  geometry: [number, number][]; // [lat, lon] from `from` to `to`
}
export interface SerializedGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Graph { nodes: Map<string, GraphNode>; edges: GraphEdge[]; adj: Map<string, number[]> }
export function loadGraph(g: SerializedGraph): Graph;         // builds nodes Map + adjacency
export function nearestNode(g: Graph, lat: number, lon: number): GraphNode;
export function roadKey(e: GraphEdge): string;                // e.name ?? `way:${e.wayId}` — see note below
```

- Produces (`engine/build/build-graph.ts`): `buildGraph(osm: OsmJson): { graph: SerializedGraph; report: BuildReport }` where `OsmJson = { elements: OsmElement[] }`, `OsmElement = { type:'node'; id:number; lat:number; lon:number; tags?:Record<string,string> } | { type:'way'; id:number; nodes:number[]; tags:Record<string,string> }`, and

```ts
export interface BuildReport {
  waysTotal: number; waysExcluded: number;
  sidewalkSeparateWays: number; sidewalkCollapsed: number; sidewalkUnmatched: number; // filled in Task 6
  nodesTotal: number; largestComponentPct: number;
  tagCoverage: { sidewalk: number; maxspeed: number; lanes: number; crossing: number }; // fraction of road edges tagged
  signalNodes: number;
}
```

- **`roadKey` note (movement-aware crossing depends on this):** OSM splits one street into many ways; excluding crossed roads by `wayId` would misprice "continuing along S Orange Ave" as "crossing S Orange Ave" wherever the way id changes across an intersection. Road identity = `name`, falling back to `way:<id>` only for unnamed ways.

- [ ] **Step 1: Write failing tests with a synthetic OSM fixture**

Create `engine/tests/build-graph.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../build/build-graph.js';
import { loadGraph, nearestNode, roadKey } from '../src/graph.js';

/** Fixture: a + shaped intersection at node 5.
 *  Main Ave (primary, E–W): 1 —— 5 —— 2 (two separate ways, same name)
 *  Vose Ave (residential, N–S): 3 —— 5 —— 4
 *  Plus a disconnected stub: 6 —— 7, and a foot=no way: 8 —— 5.
 */
const F = { elements: [
  { type: 'node', id: 1, lat: 40.740, lon: -74.262 },
  { type: 'node', id: 2, lat: 40.740, lon: -74.258 },
  { type: 'node', id: 3, lat: 40.742, lon: -74.260 },
  { type: 'node', id: 4, lat: 40.738, lon: -74.260 },
  { type: 'node', id: 5, lat: 40.740, lon: -74.260, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 6, lat: 40.750, lon: -74.250 },
  { type: 'node', id: 7, lat: 40.751, lon: -74.250 },
  { type: 'node', id: 8, lat: 40.740, lon: -74.264 },
  { type: 'way', id: 101, nodes: [1, 5], tags: { highway: 'primary', name: 'Main Ave' } },
  { type: 'way', id: 102, nodes: [5, 2], tags: { highway: 'primary', name: 'Main Ave' } },
  { type: 'way', id: 103, nodes: [3, 5, 4], tags: { highway: 'residential', name: 'Vose Ave' } },
  { type: 'way', id: 104, nodes: [6, 7], tags: { highway: 'residential', name: 'Nowhere St' } },
  { type: 'way', id: 105, nodes: [8, 5], tags: { highway: 'residential', name: 'Closed St', foot: 'no' } },
] } as any;

test('buildGraph: filtering, intersection splitting, components', () => {
  const { graph, report } = buildGraph(F);
  const g = loadGraph(graph);
  // foot=no excluded; disconnected 6–7 dropped by largest-component filter.
  const names = new Set(graph.edges.map((e) => e.name));
  assert.ok(!names.has('Closed St'));
  assert.ok(!names.has('Nowhere St'));
  // Way 103 splits at intersection node 5 into two edges (3–5, 5–4).
  const vose = graph.edges.filter((e) => e.name === 'Vose Ave');
  assert.equal(vose.length, 2);
  // Signal on node 5 (exact node here; radius association also covers offsets).
  assert.equal(g.nodes.get('5')!.signal, true);
  assert.equal(report.waysExcluded, 1);
  assert.ok(report.largestComponentPct > 0.6);
});

test('roadKey: same street across the intersection shares a key despite way split', () => {
  const { graph } = buildGraph(F);
  const main = graph.edges.filter((e) => e.name === 'Main Ave');
  assert.equal(main.length, 2);
  assert.equal(roadKey(main[0]), roadKey(main[1]));
});

test('nearestNode snaps', () => {
  const { graph } = buildGraph(F);
  const g = loadGraph(graph);
  assert.equal(nearestNode(g, 40.7401, -74.2601).id, '5');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement `engine/src/graph.ts`**

```ts
import { haversineM } from './geo.js';
import type { Lts, LtsReason } from './lts.js';

export interface GraphNode { id: string; lat: number; lon: number; signal: boolean; crossing: string | null }
export interface GraphEdge {
  from: string; to: string; wayId: string; name: string | null; highway: string;
  lengthM: number; lts: Lts; ltsReasons: LtsReason[]; steps: boolean;
  geometry: [number, number][];
}
export interface SerializedGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface Graph { nodes: Map<string, GraphNode>; edges: GraphEdge[]; adj: Map<string, number[]> }

export function loadGraph(g: SerializedGraph): Graph {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, number[]>();
  g.edges.forEach((e, i) => {
    for (const id of [e.from, e.to]) {
      if (!adj.has(id)) adj.set(id, []);
      adj.get(id)!.push(i);
    }
  });
  return { nodes, edges: g.edges, adj };
}

export function nearestNode(g: Graph, lat: number, lon: number): GraphNode {
  let best: GraphNode | null = null;
  let bestD = Infinity;
  for (const n of g.nodes.values()) {
    const d = haversineM(lat, lon, n.lat, n.lon);
    if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) throw new Error('empty graph');
  return best;
}

/** Road identity for crossing exclusion. OSM splits streets into many ways;
 *  name-based identity keeps "continue along X" from pricing as "cross X". */
export function roadKey(e: GraphEdge): string {
  return e.name ?? `way:${e.wayId}`;
}
```

- [ ] **Step 4: Implement `engine/build/build-graph.ts`**

```ts
import { haversineM } from '../src/geo.js';
import { segmentLts } from '../src/lts.js';
import type { GraphEdge, GraphNode, SerializedGraph } from '../src/graph.js';

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags: Record<string, string> }
export type OsmElement = OsmNode | OsmWay;
export interface OsmJson { elements: OsmElement[] }

export interface BuildReport {
  waysTotal: number; waysExcluded: number;
  sidewalkSeparateWays: number; sidewalkCollapsed: number; sidewalkUnmatched: number;
  nodesTotal: number; largestComponentPct: number;
  tagCoverage: { sidewalk: number; maxspeed: number; lanes: number; crossing: number };
  signalNodes: number;
}

const SIGNAL_RADIUS_M = 20;
const PEDESTRIAN_ONLY = new Set(['footway', 'path', 'pedestrian', 'steps']);

function excluded(tags: Record<string, string>): boolean {
  if (tags.foot === 'no') return true;
  if (tags.access === 'private' && tags.foot !== 'yes') return true;
  return false;
}

export function buildGraph(osm: OsmJson): { graph: SerializedGraph; report: BuildReport } {
  const osmNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of osm.elements) {
    if (el.type === 'node') osmNodes.set(el.id, el);
    else ways.push(el);
  }
  const kept = ways.filter((w) => !excluded(w.tags));
  const waysExcluded = ways.length - kept.length;

  // Intersections: nodes used by ≥2 kept ways, or way endpoints.
  const useCount = new Map<number, number>();
  for (const w of kept) for (const id of new Set(w.nodes)) useCount.set(id, (useCount.get(id) ?? 0) + 1);
  const isIntersection = (id: number, w: OsmWay) =>
    (useCount.get(id) ?? 0) >= 2 || id === w.nodes[0] || id === w.nodes[w.nodes.length - 1];

  // Split ways at intersections into edges, keeping interior geometry.
  const edges: GraphEdge[] = [];
  const usedNodeIds = new Set<number>();
  for (const w of kept) {
    const { lts, reasons, steps } = segmentLts(w.tags);
    let chain: number[] = [];
    for (const id of w.nodes) {
      chain.push(id);
      if (chain.length > 1 && isIntersection(id, w)) {
        const pts = chain.map((n) => osmNodes.get(n)!).filter(Boolean);
        if (pts.length === chain.length) {
          let len = 0;
          for (let i = 1; i < pts.length; i++) len += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
          edges.push({
            from: String(chain[0]), to: String(chain[chain.length - 1]),
            wayId: String(w.id), name: w.tags.name ?? null, highway: w.tags.highway,
            lengthM: len, lts, ltsReasons: reasons, steps,
            geometry: pts.map((p) => [p.lat, p.lon] as [number, number]),
          });
          usedNodeIds.add(chain[0]);
          usedNodeIds.add(chain[chain.length - 1]);
        }
        chain = [id];
      }
    }
  }

  // Largest connected component (union-find).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  for (const id of usedNodeIds) parent.set(String(id), String(id));
  for (const e of edges) parent.set(find(e.from), find(e.to));
  const compSize = new Map<string, number>();
  for (const id of usedNodeIds) {
    const r = find(String(id));
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  const mainRoot = [...compSize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const keptEdges = edges.filter((e) => find(e.from) === mainRoot);
  const largestComponentPct = usedNodeIds.size ? (compSize.get(mainRoot!) ?? 0) / usedNodeIds.size : 0;

  // Node records with signal/crossing association within 20 m.
  const signals: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.highway === 'traffic_signals');
  const crossings: OsmNode[] = [...osmNodes.values()].filter((n) => n.tags?.crossing);
  const nodeIds = new Set<string>();
  for (const e of keptEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const on = osmNodes.get(Number(id))!;
    const signal = signals.some((s) => haversineM(on.lat, on.lon, s.lat, s.lon) <= SIGNAL_RADIUS_M);
    const cx = crossings.find((c) => haversineM(on.lat, on.lon, c.lat, c.lon) <= SIGNAL_RADIUS_M);
    return { id, lat: on.lat, lon: on.lon, signal, crossing: cx?.tags?.crossing ?? null };
  });

  // Tag coverage over road (non-pedestrian-only) kept ways.
  const roadWays = kept.filter((w) => !PEDESTRIAN_ONLY.has(w.tags.highway));
  const frac = (key: string) => roadWays.length ? roadWays.filter((w) => w.tags[key] != null).length / roadWays.length : 0;

  return {
    graph: { nodes, edges: keptEdges },
    report: {
      waysTotal: ways.length, waysExcluded,
      sidewalkSeparateWays: 0, sidewalkCollapsed: 0, sidewalkUnmatched: 0, // Task 6 fills these
      nodesTotal: nodes.length, largestComponentPct,
      // crossing coverage = crossing-tagged nodes per graph node — the spec
      // explicitly wants this number visible (thin coverage collapses the
      // crossing-quality discounts into a uniform penalty).
      tagCoverage: { sidewalk: frac('sidewalk'), maxspeed: frac('maxspeed'), lanes: frac('lanes'), crossing: crossings.length / Math.max(1, nodes.length) },
      signalNodes: nodes.filter((n) => n.signal).length,
    },
  };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test` → all PASS. `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add engine/src/graph.ts engine/build/build-graph.ts engine/tests/build-graph.test.ts
git commit -m "feat(engine): pedestrian graph build — filter, split, components, signal association"
```

---

### Task 6: Sidewalk-way collapsing

**Files:**
- Modify: `engine/build/build-graph.ts` (add collapse pass before edge construction)
- Test: `engine/tests/sidewalk.test.ts`

**Interfaces:**
- Consumes: `buildGraph` internals from Task 5; `pointSegDistM`, `bearingDeg`, `bearingDiffDeg` from Task 3.
- Produces: `footway=sidewalk` ways within 25 m and 20° of a parallel road way are **dropped** and the road way's `sidewalk` tag upgraded (`both` if collapsed from an untagged state — one collapse means at least one side exists; we deliberately upgrade to `yes` not `both`); unmatched sidewalk ways stay as ordinary footway edges. Report fields `sidewalkSeparateWays`, `sidewalkCollapsed`, `sidewalkUnmatched` filled.

- [ ] **Step 1: Write failing test**

Create `engine/tests/sidewalk.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../build/build-graph.js';

/** Tertiary road E–W with a parallel sidewalk way ~11 m north of it,
 *  plus a far-away sidewalk way that must NOT collapse. */
const F = { elements: [
  { type: 'node', id: 1, lat: 40.7400, lon: -74.262 },
  { type: 'node', id: 2, lat: 40.7400, lon: -74.258 },
  { type: 'node', id: 3, lat: 40.7401, lon: -74.262 },
  { type: 'node', id: 4, lat: 40.7401, lon: -74.258 },
  { type: 'node', id: 5, lat: 40.7500, lon: -74.262 },
  { type: 'node', id: 6, lat: 40.7500, lon: -74.258 },
  { type: 'way', id: 201, nodes: [1, 2], tags: { highway: 'tertiary', name: 'Centre St' } },
  { type: 'way', id: 202, nodes: [3, 4], tags: { highway: 'footway', footway: 'sidewalk' } },
  { type: 'way', id: 203, nodes: [5, 6], tags: { highway: 'footway', footway: 'sidewalk' } },
] } as any;

test('parallel sidewalk collapses onto road; distant one survives', () => {
  const { graph, report } = buildGraph(F);
  assert.equal(report.sidewalkSeparateWays, 2);
  assert.equal(report.sidewalkCollapsed, 1);
  assert.equal(report.sidewalkUnmatched, 1);
  const centre = graph.edges.find((e) => e.name === 'Centre St')!;
  // Collapsed sidewalk upgrades the road: tertiary(3) − sidewalk(1) = 2.
  assert.equal(centre.lts, 2);
  assert.ok(centre.ltsReasons.some((r) => /sidewalk/.test(r.reason) && r.source === 'tagged'));
  // The far sidewalk way remains its own footway edge... in the OTHER component,
  // so after largest-component filtering only one component survives. Assert on
  // report counts (above) rather than edge presence.
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test` → FAIL (`sidewalkSeparateWays` is 0 from Task 5's stub).

- [ ] **Step 3: Implement the collapse pass**

In `engine/build/build-graph.ts`, after computing `kept` and before intersection counting, insert:

```ts
  // Sidewalk representation handling (spec Stage 2): collapse footway=sidewalk
  // ways onto their parallel parent road; keep unmatched ones as footway edges.
  const sidewalkWays = kept.filter((w) => w.tags.footway === 'sidewalk');
  const roadWaysAll = kept.filter((w) => !PEDESTRIAN_ONLY.has(w.tags.highway));
  let sidewalkCollapsed = 0;
  const collapsedIds = new Set<number>();
  for (const sw of sidewalkWays) {
    const pts = sw.nodes.map((n) => osmNodes.get(n)).filter((n): n is OsmNode => !!n);
    if (pts.length < 2) continue;
    const mi = Math.floor(pts.length / 2) - (pts.length % 2 === 0 ? 1 : 0);
    const a = pts[mi], b = pts[Math.min(mi + 1, pts.length - 1)];
    const midLat = (a.lat + b.lat) / 2, midLon = (a.lon + b.lon) / 2;
    const swBearing = bearingDeg(a.lat, a.lon, b.lat, b.lon);
    let matched: OsmWay | null = null;
    for (const rw of roadWaysAll) {
      for (let i = 1; i < rw.nodes.length; i++) {
        const p = osmNodes.get(rw.nodes[i - 1]), q = osmNodes.get(rw.nodes[i]);
        if (!p || !q) continue;
        if (pointSegDistM(midLat, midLon, p.lat, p.lon, q.lat, q.lon) <= 25 &&
            bearingDiffDeg(swBearing, bearingDeg(p.lat, p.lon, q.lat, q.lon)) <= 20) {
          matched = rw; break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      collapsedIds.add(sw.id);
      sidewalkCollapsed++;
      if (!matched.tags.sidewalk || matched.tags.sidewalk === 'no' || matched.tags.sidewalk === 'none') {
        matched.tags = { ...matched.tags, sidewalk: 'yes' };
      }
    }
  }
  const keptAfterCollapse = kept.filter((w) => !collapsedIds.has(w.id));
```

Add imports at top: `import { bearingDeg, bearingDiffDeg, pointSegDistM } from '../src/geo.js';`. Replace all later uses of `kept` (intersection counting, edge construction, tag coverage) with `keptAfterCollapse`, and fill the report:

```ts
      sidewalkSeparateWays: sidewalkWays.length,
      sidewalkCollapsed,
      sidewalkUnmatched: sidewalkWays.length - sidewalkCollapsed,
```

Mutating `matched.tags` before `segmentLts` runs (edge construction happens after this pass) is what makes the upgrade take effect.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS, including Tasks 3–5 suites (regression check: the Task 5 fixture has no sidewalk ways, so its report shows `0/0/0`).

- [ ] **Step 5: Commit**

```bash
git add engine/build/build-graph.ts engine/tests/sidewalk.test.ts
git commit -m "feat(engine): collapse parallel footway=sidewalk ways onto parent roads"
```

---

### Task 7: Cause join with loud coverage failure

**Files:**
- Create: `engine/build/causes.ts`
- Test: `engine/tests/causes.test.ts`

**Interfaces:**
- Consumes: `parseCsv` (Task 3).
- Produces: `normalizeCase(raw: string): string` · `loadCauses(vehiclesCsvText: string): Map<string, string[]>` (normalized case → informative cc_labels, "None"/"Unknown"/empty excluded) · `joinCauses(pointCases: string[], causes: Map<string, string[]>): { matchedPct: number; unmatched: string[]; byCase: Map<string, string[]> }` — **throws** listing every unmatched case when `matchedPct < 0.98`.

- [ ] **Step 1: Write failing tests**

Create `engine/tests/causes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement**

Create `engine/build/causes.ts`:

```ts
import { parseCsv } from './csv.js';

const UNINFORMATIVE = new Set(['', 'None', 'Unknown']);

export function normalizeCase(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function loadCauses(vehiclesCsvText: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of parseCsv(vehiclesCsvText)) {
    const key = normalizeCase(row['Department Case Number'] ?? '');
    if (!key) continue;
    // Every case key is recorded — a crash with only uninformative causes must
    // still count as JOINED for the 98% coverage floor; it just has no labels.
    if (!out.has(key)) out.set(key, []);
    const label = row.cc_label?.trim() ?? '';
    if (!UNINFORMATIVE.has(label)) out.get(key)!.push(label);
  }
  return out;
}

export function joinCauses(
  pointCases: string[],
  causes: Map<string, string[]>,
): { matchedPct: number; unmatched: string[]; byCase: Map<string, string[]> } {
  // NOTE on the 98% assert: a point whose crash has only uninformative causes is
  // still "matched" for coverage purposes — coverage measures join integrity,
  // not cause informativeness. So we track ALL case keys seen in the file too.
  const byCase = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const raw of pointCases) {
    const key = normalizeCase(raw);
    const labels = causes.get(key);
    if (labels) byCase.set(key, labels);
    else unmatched.push(key);
  }
  const matchedPct = pointCases.length ? (pointCases.length - unmatched.length) / pointCases.length : 1;
  if (matchedPct < 0.98) {
    throw new Error(
      `Cause join coverage ${(matchedPct * 100).toFixed(1)}% is below the 98% floor. ` +
      `Unmatched cases:\n${unmatched.join('\n')}`,
    );
  }
  return { matchedPct, unmatched, byCase };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Reality-check against the actual files**

Run:

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
import { parseCsv } from './engine/build/csv.js';
import { loadCauses, joinCauses } from './engine/build/causes.js';
const dataDir = process.env.SAFE_ROUTES_DATA_DIR ?? process.env.HOME + '/Documents/Claude/Projects/Linear';
const causes = loadCauses(readFileSync(dataDir + '/south_orange_vehicles_joined.csv', 'utf8'));
const points = parseCsv(readFileSync('./engine/data/so_points_clustered.csv', 'utf8'));
const r = joinCauses(points.map(p => p.case), causes);
console.log('coverage', (r.matchedPct * 100).toFixed(1) + '%, unmatched:', r.unmatched.length);
"
```

Expected: coverage ≥ 98%. **If it throws:** the unmatched list is the work item — extend `normalizeCase` (e.g., year-prefix disambiguation for bare `22012691`-style keys) until the floor passes, adding each new format to the unit test. Do not lower the floor.

- [ ] **Step 6: Commit**

```bash
git add engine/build/causes.ts engine/tests/causes.test.ts
git commit -m "feat(engine): cause-label join with normalization and 98% coverage floor"
```

---

### Task 8: Risk snapping (clusters → nodes, causes → clusters)

**Files:**
- Create: `engine/build/snap-risk.ts`, `engine/src/risk.ts`
- Test: `engine/tests/snap-risk.test.ts`

**Interfaces:**
- Consumes: `Graph`/`loadGraph`/`nearestNode` (Task 5), `haversineM` (Task 3), `joinCauses` output (Task 7), `parseCsv` (Task 3).
- Produces (`engine/src/risk.ts`):

```ts
export interface NodeRisk {
  nodeId: string; crashN: number; stress: number; injuryN: number; vruN: number;
  dominantCause: string | null; causeDistribution: Record<string, number>;
  clusterIds: number[]; snapDistM: number; name: string;
}
export type RiskSurface = NodeRisk[];
```

- Produces (`engine/build/snap-risk.ts`): `snapRisk(graph: Graph, hotspots: HotspotRow[], points: PointRow[], causesByCase: Map<string, string[]>): { risk: RiskSurface; report: SnapReport }` where `HotspotRow = { cluster: number; lat: number; lon: number; n: number; stress: number; injury_n: number; vru_n: number; location: string; cross: string }`, `PointRow = { lat: number; lon: number; kind: string; case: string }`, `SnapReport = { unsnapped: Array<{ cluster: number; name: string; distM: number }>; assignmentMismatches: Array<{ cluster: number; expected: number; assigned: number }> }`.
- Behavior locked by spec: cluster snap ≤ 30 m else reported unsnapped; point→cluster assignment = nearest centroid ≤ 25 m (approximation — the original DBSCAN membership was lost with the missing CSV; per-cluster assigned counts are compared against the hotspot CSV's `n` and mismatches > ±30% reported, never silently patched); clusters snapping to the same node merge (sum `crashN`/`stress`/`injuryN`/`vruN`, merge distributions, keep min `snapDistM`).

- [ ] **Step 1: Write failing test**

Create `engine/tests/snap-risk.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapRisk } from '../build/snap-risk.js';
import { loadGraph } from '../src/graph.js';

const graph = loadGraph({
  nodes: [
    { id: 'A', lat: 40.7400, lon: -74.2600, signal: false, crossing: null },
    { id: 'B', lat: 40.7450, lon: -74.2600, signal: false, crossing: null },
  ],
  edges: [{
    from: 'A', to: 'B', wayId: '1', name: 'Test St', highway: 'residential',
    lengthM: 556, lts: 2, ltsReasons: [], steps: false,
    geometry: [[40.74, -74.26], [40.745, -74.26]],
  }],
});

const hotspots = [
  { cluster: 0, lat: 40.74005, lon: -74.2600, n: 2, stress: 10, injury_n: 1, vru_n: 0, location: 'TEST ST', cross: 'X AVE' },   // ~6 m from A → snaps
  { cluster: 1, lat: 40.7420, lon: -74.2600, n: 3, stress: 5, injury_n: 0, vru_n: 0, location: 'FAR ST', cross: 'Y AVE' },      // ~220 m from anything → unsnapped
];
const points = [
  { lat: 40.74006, lon: -74.26001, kind: 'injury', case: 'C-2022-000001' }, // → cluster 0
  { lat: 40.74004, lon: -74.25999, kind: 'pdo', case: 'C-2022-000002' },    // → cluster 0
];
const causes = new Map([
  ['C2022000001', ['Driver inattention', 'Failed to yield ROW']],
  ['C2022000002', ['Driver inattention']],
]);

test('snapRisk: snap, dominant cause, unsnapped report', () => {
  const { risk, report } = snapRisk(graph, hotspots, points, causes);
  assert.equal(risk.length, 1);
  const r = risk[0];
  assert.equal(r.nodeId, 'A');
  assert.equal(r.crashN, 2);
  assert.equal(r.dominantCause, 'Driver inattention');
  assert.equal(r.causeDistribution['Driver inattention'], 2);
  assert.equal(r.causeDistribution['Failed to yield ROW'], 1);
  assert.equal(r.name, 'TEST ST × X AVE');
  assert.equal(report.unsnapped.length, 1);
  assert.equal(report.unsnapped[0].cluster, 1);
  // cluster 0 expected n=2, assigned 2 → no mismatch entry
  assert.equal(report.assignmentMismatches.length, 0);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement**

Create `engine/src/risk.ts` with the interfaces above (pure types, no logic). Create `engine/build/snap-risk.ts`:

```ts
import { haversineM } from '../src/geo.js';
import { nearestNode, type Graph } from '../src/graph.js';
import { normalizeCase } from './causes.js';
import type { NodeRisk, RiskSurface } from '../src/risk.js';

export interface HotspotRow {
  cluster: number; lat: number; lon: number; n: number; stress: number;
  injury_n: number; vru_n: number; location: string; cross: string;
}
export interface PointRow { lat: number; lon: number; kind: string; case: string }
export interface SnapReport {
  unsnapped: Array<{ cluster: number; name: string; distM: number }>;
  assignmentMismatches: Array<{ cluster: number; expected: number; assigned: number }>;
}

const SNAP_MAX_M = 30;
const ASSIGN_MAX_M = 25;

export function snapRisk(
  graph: Graph,
  hotspots: HotspotRow[],
  points: PointRow[],
  causesByCase: Map<string, string[]>,
): { risk: RiskSurface; report: SnapReport } {
  // Point → nearest cluster centroid within 25 m (membership approximation).
  const byCluster = new Map<number, PointRow[]>();
  for (const p of points) {
    let best: HotspotRow | null = null;
    let bestD = Infinity;
    for (const h of hotspots) {
      const d = haversineM(p.lat, p.lon, h.lat, h.lon);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best && bestD <= ASSIGN_MAX_M) {
      if (!byCluster.has(best.cluster)) byCluster.set(best.cluster, []);
      byCluster.get(best.cluster)!.push(p);
    }
  }

  const report: SnapReport = { unsnapped: [], assignmentMismatches: [] };
  const byNode = new Map<string, NodeRisk>();

  for (const h of hotspots) {
    const name = `${h.location} × ${h.cross}`;
    const node = nearestNode(graph, h.lat, h.lon);
    const distM = haversineM(h.lat, h.lon, node.lat, node.lon);
    if (distM > SNAP_MAX_M) {
      report.unsnapped.push({ cluster: h.cluster, name, distM });
      continue;
    }
    const assigned = byCluster.get(h.cluster) ?? [];
    if (h.n > 0 && Math.abs(assigned.length - h.n) / h.n > 0.3) {
      report.assignmentMismatches.push({ cluster: h.cluster, expected: h.n, assigned: assigned.length });
    }
    const dist: Record<string, number> = {};
    for (const p of assigned) {
      for (const label of causesByCase.get(normalizeCase(p.case)) ?? []) {
        dist[label] = (dist[label] ?? 0) + 1;
      }
    }
    const dominant = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const existing = byNode.get(node.id);
    if (existing) {
      existing.crashN += h.n; existing.stress += h.stress;
      existing.injuryN += h.injury_n; existing.vruN += h.vru_n;
      existing.clusterIds.push(h.cluster);
      existing.snapDistM = Math.min(existing.snapDistM, distM);
      for (const [k, v] of Object.entries(dist)) {
        existing.causeDistribution[k] = (existing.causeDistribution[k] ?? 0) + v;
      }
      const top = Object.entries(existing.causeDistribution).sort((a, b) => b[1] - a[1])[0];
      existing.dominantCause = top?.[0] ?? null;
    } else {
      byNode.set(node.id, {
        nodeId: node.id, crashN: h.n, stress: h.stress, injuryN: h.injury_n, vruN: h.vru_n,
        dominantCause: dominant, causeDistribution: dist,
        clusterIds: [h.cluster], snapDistM: distM, name,
      });
    }
  }
  return { risk: [...byNode.values()], report };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/risk.ts engine/build/snap-risk.ts engine/tests/snap-risk.test.ts
git commit -m "feat(engine): snap crash clusters to graph nodes with cause distributions"
```

---

### Task 9: Stress model constants (crash bump, crossing penalty)

**Files:**
- Create: `engine/src/stress.ts`
- Test: `engine/tests/stress.test.ts`

**Interfaces:**
- Consumes: `crossingLts` (Task 4).
- Produces: `BASE_PENALTY_M = 25` · `crashBumpM(clusterStress: number): number` (0 for 0, capped at `BASE_PENALTY_M`) · `crossingPenaltyM(maxCrossedLts: number, signal: boolean, crossing: string | null, bumpM: number): number` = `BASE_PENALTY_M · (crossingLts − 1) + bumpM`. All three are the spec's **unvalidated tuning knobs** — say so in the doc comment.

- [ ] **Step 1: Write failing tests**

Create `engine/tests/stress.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement**

Create `engine/src/stress.ts`:

```ts
import { crossingLts } from './lts.js';

/** UNVALIDATED TUNING KNOBS (spec): BASE_PENALTY_M sets how many meters of
 *  walking one crossing-LTS step is "worth"; K calibrates the crash bump so the
 *  worst observed cluster (stress 42) contributes exactly one LTS-step. */
export const BASE_PENALTY_M = 25;
const K = 1 / Math.log1p(42);

export function crashBumpM(clusterStress: number): number {
  return Math.min(BASE_PENALTY_M, BASE_PENALTY_M * K * Math.log1p(clusterStress));
}

export function crossingPenaltyM(
  maxCrossedLts: number,
  signal: boolean,
  crossing: string | null,
  bumpM: number,
): number {
  return BASE_PENALTY_M * (crossingLts(maxCrossedLts, signal, crossing) - 1) + bumpM;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/stress.ts engine/tests/stress.test.ts
git commit -m "feat(engine): bounded crash bump and crossing penalty model"
```

---

### Task 10: Directed-edge A* router

**Files:**
- Create: `engine/src/router.ts`
- Test: `engine/tests/router.test.ts`

**Interfaces:**
- Consumes: `Graph`, `roadKey`, `nearestNode` (Task 5); `haversineM` (Task 3); `crossingPenaltyM`, `crashBumpM` (Task 9); `NodeRisk` (Task 8).
- Produces:

```ts
export interface MoveDetail {
  edgeIdx: number; nodeId: string;             // node traversed BEFORE this edge ('' for the first move)
  segPenaltyM: number;                          // λ-weighted LTS length penalty for this edge
  crossingPenaltyM: number; crossedRoad: string | null;
  bumpHalfM: number;                            // λ·0.5·bump at the edge's head node
}
export interface RawRoute {
  nodeIds: string[]; edgeIdxs: number[];
  distanceM: number; stressCostM: number;       // totalCost − distanceM
  moves: MoveDetail[];
  geometry: [number, number][];                 // concatenated, correctly oriented
}
export function route(graph: Graph, risk: Map<string, NodeRisk>, originNodeId: string, destNodeId: string, lambda: number): RawRoute | null;
```

- Cost model (spec, verbatim): `moveCost = lengthM·(1 + λ·(lts−1)/3) + λ·crossingPenaltyM(v, e_in, e_out) + λ·0.5·bumpM(headNode)`. Crossing penalty at node `v` uses the max segment-LTS incident edge whose `roadKey` is **not** the roadKey of `e_in` or `e_out`; no crossing penalty at the origin node; bump at `v` is included inside `crossingPenaltyM` via its `bumpM` argument. U-turns (immediately re-traversing the same edge) are skipped. Heuristic: `haversineM(head, dest)` — admissible since every move costs ≥ its length.

- [ ] **Step 1: Write failing tests**

Create `engine/tests/router.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';
import { loadGraph, type SerializedGraph } from '../src/graph.js';
import type { NodeRisk } from '../src/risk.js';

/** Ladder: origin O and dest D connected by
 *  (a) direct path along "Big Ave" (primary, LTS 4): O–M–D, 400 m
 *  (b) detour via quiet "Calm St" (residential w/ sidewalk, LTS 1): O–Q1–Q2–D, 600 m
 *  Plus "Side St" (residential, LTS 2) crossing Big Ave at M — used for the
 *  movement-aware crossing test.
 */
function grid(): SerializedGraph {
  const N = (id: string, lat: number, lon: number, signal = false) =>
    ({ id, lat, lon, signal, crossing: null });
  const E = (from: string, to: string, name: string, highway: string, lts: 1|2|3|4, lengthM: number) => ({
    from, to, wayId: name, name, highway, lengthM, lts,
    ltsReasons: [], steps: false,
    geometry: [] as [number, number][],
  });
  return {
    nodes: [
      N('O', 40.7400, -74.2620), N('M', 40.7400, -74.2600), N('D', 40.7400, -74.2580),
      N('Q1', 40.7410, -74.2620), N('Q2', 40.7410, -74.2580),
      N('S1', 40.7390, -74.2600), N('S2', 40.7410, -74.2600),
    ],
    edges: [
      E('O', 'M', 'Big Ave', 'primary', 4, 200), E('M', 'D', 'Big Ave', 'primary', 4, 200),
      E('O', 'Q1', 'Calm St', 'residential', 1, 120), E('Q1', 'Q2', 'Calm St', 'residential', 1, 360),
      E('Q2', 'D', 'Calm St', 'residential', 1, 120),
      E('S1', 'M', 'Side St', 'residential', 2, 110), E('M', 'S2', 'Side St', 'residential', 2, 110),
    ],
  };
}
const noRisk = new Map<string, NodeRisk>();

test('λ=0 picks the shortest path', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 0)!;
  assert.equal(r.distanceM, 400);
  assert.deepEqual(r.nodeIds, ['O', 'M', 'D']);
  assert.equal(r.stressCostM, 0);
});

test('high λ diverts to the quiet route', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 3)!;
  assert.deepEqual(r.nodeIds, ['O', 'Q1', 'Q2', 'D']);
  assert.equal(r.distanceM, 600);
});

test('movement-aware crossing: continuing along Big Ave charges Side St, not Big Ave', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'O', 'D', 1)!;
  // Whatever route wins, inspect the O→M→D moves when forced: use λ=0 (which takes Big Ave).
  const r0 = route(g, noRisk, 'O', 'D', 0)!;
  const mMove = r0.moves.find((m) => m.nodeId === 'M')!;
  assert.equal(mMove.crossedRoad, 'Side St'); // crossing the side street, NOT Big Ave
});

test('walking Side St across Big Ave charges Big Ave crossing', () => {
  const g = loadGraph(grid());
  const r = route(g, noRisk, 'S1', 'S2', 1)!;
  assert.deepEqual(r.nodeIds, ['S1', 'M', 'S2']);
  const mMove = r.moves.find((m) => m.nodeId === 'M')!;
  assert.equal(mMove.crossedRoad, 'Big Ave');
  // Unsignalized LTS-4 crossing: penalty = 25·(4−1) = 75, λ=1.
  assert.equal(mMove.crossingPenaltyM, 75);
});

test('crash bump at a node adds cost', () => {
  const g = loadGraph(grid());
  const risky = new Map<string, NodeRisk>([['M', {
    nodeId: 'M', crashN: 10, stress: 42, injuryN: 2, vruN: 1,
    dominantCause: 'Driver inattention', causeDistribution: { 'Driver inattention': 5 },
    clusterIds: [0], snapDistM: 5, name: 'Big × Side',
  }]]);
  const clean = route(g, noRisk, 'S1', 'S2', 1)!;
  const bumped = route(g, risky, 'S1', 'S2', 1)!;
  const cleanCost = clean.distanceM + clean.stressCostM;
  const bumpedCost = bumped.distanceM + bumped.stressCostM;
  assert.ok(bumpedCost > cleanCost, `${bumpedCost} vs ${cleanCost}`);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement**

Create `engine/src/router.ts`:

```ts
import { haversineM } from './geo.js';
import { roadKey, type Graph, type GraphEdge } from './graph.js';
import { crashBumpM, crossingPenaltyM } from './stress.js';
import type { NodeRisk } from './risk.js';

export interface MoveDetail {
  edgeIdx: number; nodeId: string;
  segPenaltyM: number; crossingPenaltyM: number; crossedRoad: string | null; bumpHalfM: number;
}
export interface RawRoute {
  nodeIds: string[]; edgeIdxs: number[];
  distanceM: number; stressCostM: number;
  moves: MoveDetail[]; geometry: [number, number][];
}

/** Minimal binary min-heap of [priority, value]. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(p: number, v: number) {
    const a = this.a; a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (a[par][0] <= a[i][0]) break;
      [a[par], a[i]] = [a[i], a[par]]; i = par;
    }
  }
  pop(): [number, number] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const head = (e: GraphEdge, fwd: boolean) => (fwd ? e.to : e.from);
const tail = (e: GraphEdge, fwd: boolean) => (fwd ? e.from : e.to);

function crossingAt(
  graph: Graph, nodeId: string, excludeKeys: Set<string>,
): { maxLts: number; crossedRoad: string | null } {
  let maxLts = 0;
  let crossedRoad: string | null = null;
  for (const idx of graph.adj.get(nodeId) ?? []) {
    const e = graph.edges[idx];
    const key = roadKey(e);
    if (excludeKeys.has(key)) continue;
    if (e.lts > maxLts) { maxLts = e.lts; crossedRoad = e.name ?? key; }
  }
  return { maxLts, crossedRoad };
}

export function route(
  graph: Graph,
  risk: Map<string, NodeRisk>,
  originNodeId: string,
  destNodeId: string,
  lambda: number,
): RawRoute | null {
  const E = graph.edges.length;
  const dest = graph.nodes.get(destNodeId)!;
  const bump = (nodeId: string) => crashBumpM(risk.get(nodeId)?.stress ?? 0);
  const segCost = (e: GraphEdge) => e.lengthM * (1 + (lambda * (e.lts - 1)) / 3);
  const h = (nodeId: string) => {
    const n = graph.nodes.get(nodeId)!;
    return haversineM(n.lat, n.lon, dest.lat, dest.lon);
  };

  // Directed-edge states: d = edgeIdx*2 + (forward ? 0 : 1).
  const g = new Float64Array(2 * E).fill(Infinity);
  const cameFrom = new Int32Array(2 * E).fill(-1);
  const detail: (MoveDetail | null)[] = new Array(2 * E).fill(null);
  const open = new Heap();

  for (const idx of graph.adj.get(originNodeId) ?? []) {
    const e = graph.edges[idx];
    const fwd = e.from === originNodeId;
    const d = idx * 2 + (fwd ? 0 : 1);
    const hd = head(e, fwd);
    const bumpHalf = lambda * 0.5 * bump(hd);
    const cost = segCost(e) + bumpHalf; // no crossing penalty at origin
    if (cost < g[d]) {
      g[d] = cost;
      detail[d] = {
        edgeIdx: idx, nodeId: '', segPenaltyM: segCost(e) - e.lengthM,
        crossingPenaltyM: 0, crossedRoad: null, bumpHalfM: bumpHalf,
      };
      open.push(cost + h(hd), d);
    }
  }

  let goal = -1;
  const closed = new Uint8Array(2 * E);
  while (open.size) {
    const [, d] = open.pop();
    if (closed[d]) continue;
    closed[d] = 1;
    const e = graph.edges[d >> 1];
    const fwd = (d & 1) === 0;
    const v = head(e, fwd);
    if (v === destNodeId) { goal = d; break; }
    const inKey = roadKey(e);
    for (const outIdx of graph.adj.get(v) ?? []) {
      if (outIdx === d >> 1) continue; // no immediate U-turn
      const oe = graph.edges[outIdx];
      const ofwd = oe.from === v;
      if (tail(oe, ofwd) !== v) continue;
      const od = outIdx * 2 + (ofwd ? 0 : 1);
      if (closed[od]) continue;
      const exclude = new Set([inKey, roadKey(oe)]);
      const { maxLts, crossedRoad } = crossingAt(graph, v, exclude);
      const vNode = graph.nodes.get(v)!;
      const xPenalty = maxLts > 0
        ? crossingPenaltyM(maxLts, vNode.signal, vNode.crossing, bump(v))
        : bump(v); // no crossed road: bump still applies at the node
      const hd = head(oe, ofwd);
      const bumpHalf = lambda * 0.5 * bump(hd);
      const cost = g[d] + segCost(oe) + lambda * xPenalty + bumpHalf;
      if (cost < g[od]) {
        g[od] = cost;
        cameFrom[od] = d;
        detail[od] = {
          edgeIdx: outIdx, nodeId: v, segPenaltyM: segCost(oe) - oe.lengthM,
          crossingPenaltyM: lambda * xPenalty, crossedRoad, bumpHalfM: bumpHalf,
        };
        open.push(cost + h(hd), od);
      }
    }
  }
  if (goal === -1) return null;

  // Reconstruct.
  const moves: MoveDetail[] = [];
  const edgeIdxs: number[] = [];
  const dirs: boolean[] = [];
  for (let d = goal; d !== -1; d = cameFrom[d]) {
    moves.unshift(detail[d]!);
    edgeIdxs.unshift(d >> 1);
    dirs.unshift((d & 1) === 0);
  }
  const nodeIds = [tail(graph.edges[edgeIdxs[0]], dirs[0])];
  const geometry: [number, number][] = [];
  edgeIdxs.forEach((idx, i) => {
    const e = graph.edges[idx];
    nodeIds.push(head(e, dirs[i]));
    const geo = dirs[i] ? e.geometry : [...e.geometry].reverse();
    geometry.push(...(i === 0 ? geo : geo.slice(1)));
  });
  const distanceM = edgeIdxs.reduce((s, idx) => s + graph.edges[idx].lengthM, 0);
  return { nodeIds, edgeIdxs, distanceM, stressCostM: g[goal] - distanceM, moves, geometry };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all PASS. If the movement-aware tests fail, debug `crossingAt` exclusion keys first — that's the spec's core mechanism.

- [ ] **Step 5: Commit**

```bash
git add engine/src/router.ts engine/tests/router.test.ts
git commit -m "feat(engine): directed-edge A* with movement-aware crossing penalties"
```

---

### Task 11: Explainability payload + pipeline entry + artifacts

**Files:**
- Create: `engine/src/explain.ts`, `engine/build/build.ts`
- Test: `engine/tests/explain.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces (`engine/src/explain.ts`) — this is the STC-151 contract, spec-verbatim:

```ts
import type { LtsReason } from './lts.js';
export interface RouteResult {
  lambda: number;
  distance_m: number;
  stress_cost_m: number;
  segments: Array<{
    way_name: string | null; length_m: number; lts: 1 | 2 | 3 | 4;
    stress_contribution_m: number;
    lts_reasons: LtsReason[];
  }>;
  flagged_nodes: Array<{
    node_id: string; name: string;
    crossing_penalty_m: number; crossed_way: string | null;
    crash_n: number; dominant_cause: string | null;
    cause_distribution: Record<string, number>;
  }>;
}
export function explainRoute(graph: Graph, risk: Map<string, NodeRisk>, raw: RawRoute, lambda: number): RouteResult;
```

- Segments = consecutive route edges merged by `way_name` (contribution and length summed; `lts` = max over merged edges; `lts_reasons` from the max-LTS edge). Flagged nodes = traversed nodes with a risk entry **or** `crossingPenaltyM ≥ λ·BASE_PENALTY_M` (i.e., at least one full LTS-step of crossing cost); when λ = 0 only risk-entry nodes flag.
- Produces (`engine/build/build.ts`): the pipeline entry. Reads `engine/data/osm-raw.json` + CSVs (+ vehicles CSV from `SAFE_ROUTES_DATA_DIR`), runs buildGraph → loadCauses/joinCauses → snapRisk, writes `engine/artifacts/graph.json` (`SerializedGraph`), `engine/artifacts/risk.json` (`RiskSurface`), `engine/artifacts/build-report.json` (BuildReport + SnapReport + join coverage), prints the report.

- [ ] **Step 1: Write failing test**

Create `engine/tests/explain.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRoute } from '../src/explain.js';
import { route } from '../src/router.js';
import { loadGraph } from '../src/graph.js';
import type { NodeRisk } from '../src/risk.js';

const g = loadGraph({
  nodes: [
    { id: 'A', lat: 40.740, lon: -74.262, signal: false, crossing: null },
    { id: 'B', lat: 40.740, lon: -74.260, signal: false, crossing: null },
    { id: 'C', lat: 40.740, lon: -74.258, signal: false, crossing: null },
  ],
  edges: [
    { from: 'A', to: 'B', wayId: 'w1', name: 'Main St', highway: 'residential', lengthM: 170,
      lts: 2, ltsReasons: [{ reason: 'residential (base 2)', source: 'tagged' }], steps: false, geometry: [] },
    { from: 'B', to: 'C', wayId: 'w2', name: 'Main St', highway: 'residential', lengthM: 170,
      lts: 2, ltsReasons: [{ reason: 'residential (base 2)', source: 'tagged' }], steps: false, geometry: [] },
  ],
});
const risk = new Map<string, NodeRisk>([['B', {
  nodeId: 'B', crashN: 4, stress: 12, injuryN: 1, vruN: 0,
  dominantCause: 'Backing unsafely', causeDistribution: { 'Backing unsafely': 3 },
  clusterIds: [7], snapDistM: 8, name: 'Main St × Oak',
}]]);

test('explainRoute merges same-name segments and flags risk nodes', () => {
  const raw = route(g, risk, 'A', 'C', 1)!;
  const res = explainRoute(g, risk, raw, 1);
  assert.equal(res.lambda, 1);
  assert.equal(res.distance_m, 340);
  assert.equal(res.segments.length, 1);            // merged by way_name
  assert.equal(res.segments[0].way_name, 'Main St');
  assert.equal(res.segments[0].length_m, 340);
  assert.ok(res.segments[0].stress_contribution_m > 0); // LTS 2 → (2−1)/3 per meter
  const flagged = res.flagged_nodes.find((n) => n.node_id === 'B')!;
  assert.equal(flagged.dominant_cause, 'Backing unsafely');
  assert.equal(flagged.name, 'Main St × Oak');
  assert.equal(flagged.crash_n, 4);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test` → FAIL.

- [ ] **Step 3: Implement `engine/src/explain.ts`**

```ts
import type { Graph } from './graph.js';
import type { NodeRisk } from './risk.js';
import type { RawRoute } from './router.js';
import type { LtsReason, Lts } from './lts.js';
import { BASE_PENALTY_M } from './stress.js';

export interface RouteResult {
  lambda: number;
  distance_m: number;
  stress_cost_m: number;
  segments: Array<{
    way_name: string | null; length_m: number; lts: Lts;
    stress_contribution_m: number; lts_reasons: LtsReason[];
  }>;
  flagged_nodes: Array<{
    node_id: string; name: string;
    crossing_penalty_m: number; crossed_way: string | null;
    crash_n: number; dominant_cause: string | null;
    cause_distribution: Record<string, number>;
  }>;
}

export function explainRoute(
  graph: Graph, risk: Map<string, NodeRisk>, raw: RawRoute, lambda: number,
): RouteResult {
  const segments: RouteResult['segments'] = [];
  for (let i = 0; i < raw.edgeIdxs.length; i++) {
    const e = graph.edges[raw.edgeIdxs[i]];
    const move = raw.moves[i];
    const contribution = move.segPenaltyM + move.bumpHalfM;
    const prev = segments[segments.length - 1];
    if (prev && prev.way_name === e.name) {
      prev.length_m += e.lengthM;
      prev.stress_contribution_m += contribution;
      if (e.lts > prev.lts) { prev.lts = e.lts; prev.lts_reasons = e.ltsReasons; }
    } else {
      segments.push({
        way_name: e.name, length_m: e.lengthM, lts: e.lts,
        stress_contribution_m: contribution, lts_reasons: e.ltsReasons,
      });
    }
  }

  const flagged: RouteResult['flagged_nodes'] = [];
  const seen = new Set<string>();
  for (const move of raw.moves) {
    if (!move.nodeId || seen.has(move.nodeId)) continue;
    const r = risk.get(move.nodeId);
    const bigCrossing = lambda > 0 && move.crossingPenaltyM >= lambda * BASE_PENALTY_M;
    if (!r && !bigCrossing) continue;
    seen.add(move.nodeId);
    const node = graph.nodes.get(move.nodeId)!;
    flagged.push({
      node_id: move.nodeId,
      name: r?.name ?? `${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}`,
      crossing_penalty_m: move.crossingPenaltyM,
      crossed_way: move.crossedRoad,
      crash_n: r?.crashN ?? 0,
      dominant_cause: r?.dominantCause ?? null,
      cause_distribution: r?.causeDistribution ?? {},
    });
  }

  return {
    lambda,
    distance_m: raw.distanceM,
    stress_cost_m: raw.stressCostM,
    segments,
    flagged_nodes: flagged,
  };
}
```

- [ ] **Step 4: Write `engine/build/build.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseCsv } from './csv.js';
import { buildGraph } from './build-graph.js';
import { loadCauses, joinCauses } from './causes.js';
import { snapRisk, type HotspotRow, type PointRow } from './snap-risk.js';
import { loadGraph } from '../src/graph.js';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../artifacts/', import.meta.url));
const VEHICLES_DIR = process.env.SAFE_ROUTES_DATA_DIR
  ?? join(process.env.HOME!, 'Documents/Claude/Projects/Linear');

const osm = JSON.parse(readFileSync(join(DATA, 'osm-raw.json'), 'utf8'));
const { graph, report } = buildGraph(osm);
if (report.largestComponentPct < 0.95) {
  throw new Error(`Connectivity ${(report.largestComponentPct * 100).toFixed(1)}% < 95% floor`);
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
```

- [ ] **Step 5: Run everything**

Run: `npm test` → all PASS. Then `npm run build-engine`.
Expected: a printed report with `largestComponentPct ≥ 0.95`, `joinCoveragePct ≥ 98`, `riskNodes` close to 52 (less merges and unsnapped), and non-empty tag coverage numbers. **Read the report before committing** — unsnapped clusters and assignment mismatches are findings to keep, not errors, but a join failure or connectivity failure blocks here by design. Record the report numbers in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add engine/src/explain.ts engine/build/build.ts engine/tests/explain.test.ts engine/artifacts/
git commit -m "feat(engine): explainability payload, pipeline entry, committed artifacts"
```

---

### Task 12: Validation harness, README, STC-152 progress comment

**Files:**
- Create: `engine/build/validate.ts`, `engine/build/fetch-osrm-baseline.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: artifacts from Task 11; `route` (Task 10); `explainRoute` (Task 11); `haversineM` (Task 3).
- Test pair (spec): NJT South Orange station ≈ `40.7461, -74.2606` → South Mountain Elementary ≈ `40.7380, -74.2679`. **Both approximate** — the harness prints each snapped node's nearest edge names; eyeball them on first run and correct the constants if they snapped somewhere silly.

- [ ] **Step 1: Write the OSRM baseline fetcher**

Create `engine/build/fetch-osrm-baseline.ts`:

```ts
/** One-shot cache of OSRM's foot route for the validation pair (spec: the
 *  public demo server is rate-limited; the harness must never call it live). */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAIRS = [
  { name: 'station-to-south-mountain', from: [40.7461, -74.2606], to: [40.7380, -74.2679] },
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
```

Run: `npm run fetch-osrm` → writes `engine/data/osrm-baselines.json`. Commit happens at task end.

- [ ] **Step 2: Write the harness**

Create `engine/build/validate.ts`:

```ts
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

const STATION = { lat: 40.7461, lon: -74.2606 };
const SCHOOL = { lat: 40.7380, lon: -74.2679 };
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
for (let i = 1; i < rows.length; i++) {
  if (rows[i].distanceM < rows[i - 1].distanceM - 1) throw new Error(`distance decreased at λ=${rows[i].lambda}`);
  if (rows[i].stressCostM > rows[i - 1].stressCostM + 1) throw new Error(`stress cost increased at λ=${rows[i].lambda}`);
}
// Assert 2 (spec): λ≥2 exposure strictly below λ=0 exposure when the latter > 0.
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
```

- [ ] **Step 3: Run the harness**

Run: `npm run validate`
Expected: snapped-node descriptions that make street-name sense (fix the coordinate constants if not), the λ table, both asserts passing, exposure dropping, corridor overlap trending down, OSRM ratio within alarm bounds, `validation complete`. **This step is the spec's acceptance gate — paste the full output into the commit message body.** If exposure does not drop at λ=2, that is a real finding about the model, not a test to weaken: inspect which hotspots the high-λ route still passes and why (likely candidates: bump too small vs structural LTS, or the only graph-viable paths share a corridor) and bring it to Patrick before touching constants.

- [ ] **Step 4: Update README**

Rewrite the "What this demo actually does / does NOT do" sections of `README.md` to reflect reality: real crash-derived risk surface (2022–23 NJDOT point data, 52 clusters) + pedestrian-LTS structural prior; real λ-weighted routing in `engine/`; OSRM demoted to a validation baseline; UI not yet wired to the new engine (still shows the old OSRM-rescoring flow); elevation still not implemented; mock-crashes file now legacy pending UI cutover. Keep the honest-limits tone; add one line noting the pedestrian LTS adaptation is project-defined, not canonical Mekuria & Furth.

- [ ] **Step 5: Commit**

```bash
git add engine/build/validate.ts engine/build/fetch-osrm-baseline.ts engine/data/osrm-baselines.json README.md
git commit -m "feat(engine): validation harness with λ sweep, exposure, and OSRM baseline"
```

- [ ] **Step 6: CHECKPOINT — STC-152 progress comment (main session only, human-in-the-loop)**

Draft a progress comment for Linear issue STC-152 covering: engine built (graph/LTS/router/validation summary numbers from the harness), the **LTS-prior inversion of the handoff's task 2** (edges carry intrinsic stress; snapped crash nodes modulate), the missing-CSV discovery (points recovered from the map HTML, extraction now one-time), join coverage achieved, and unsnapped-cluster findings. Show the draft to Patrick in chat; post it via the Linear MCP (`get_issue` STC-152 → `save_comment`) only after he's seen it. **Do not change issue state.**

---

## Self-Review (run after writing, fixes applied inline)

1. **Spec coverage:** Stage 0 → Task 1; Stage 1 → Task 2; Stage 2 (incl. sidewalk + signals) → Tasks 5–6; rubric → Task 4; Stage 3 → Task 7; Stage 4 → Task 8; modulation/cost → Task 9; router → Task 10; payload + artifacts → Task 11; harness + process → Task 12. Covered.
2. **Known deviations from spec, deliberate:** `typescript` added as a second devDep (typecheck); vehicles CSV kept out of the public repo (privacy of per-vehicle records; spec's data-dir listing adjusted); sidewalk collapse upgrades to `sidewalk=yes` (evidence of one side) rather than `both`.
3. **Type consistency:** `RawRoute.moves[i]` pairs with `edgeIdxs[i]`; `explainRoute` consumes exactly that; `RouteResult` field names match the spec interface (`way_name`, `stress_contribution_m`, snake_case) while internal types stay camelCase. `crossingLts` returns `number` (fractional allowed), only segment LTS is the `Lts` union.
