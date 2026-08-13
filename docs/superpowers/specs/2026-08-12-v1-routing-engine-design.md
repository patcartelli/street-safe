# V1 Routing Engine — Design Spec

**Date:** 2026-08-12 · **Linear:** STC-152 (In Progress) · **Repo:** `~/dev/street-safe`
**Consumes:** STC-185 risk surface (52 hotspot clusters + 632 points) · **Feeds:** STC-151 explainability payloads, STC-156 tradeoff UI

## Goal

Replace the prototype's OSRM-rescoring approach with a real safety-weighted router: a pedestrian graph of South Orange where every edge carries an intrinsic stress score, crash data modulates it, and `cost = distance + λ·stress` makes the fastest-vs-lowest-stress tradeoff a searchable, explainable quantity.

## Decisions (settled — do not relitigate)

| Decision | Choice | Why |
|---|---|---|
| Home | Extend `street-safe`, new `engine/` module | Keeps the explainability UI shell and public GitHub artifact; OSRM path survives as validation baseline |
| Stack | TypeScript only, zero runtime deps, `tsx` sole devDep | ~2.8 sq mi town → small graph artifact, browser-searchable; matches eventual Astro embed |
| Stress model | LTS prior from OSM tags; crashes modulate, bounded | Crash-only leaves ~90% of town zero-stress and inverts arterial-vs-cul-de-sac reality; structural prior owns the zero-deaths-but-stressful thesis |
| Aggregation | Crash clusters snap to intersection nodes | Settled in STC-185; robust to position noise, matches SS4A/SOPD framing |

The LTS-prior decision **inverts the handoff's task 2** ("derive edge stress from adjacent node scores"): edges carry intrinsic stress, snapped nodes modulate it. Surface this in the STC-152 progress comment.

## Architecture

```
engine/
  src/
    graph.ts       # types, adjacency, artifact loader
    lts.ts         # OSM tags → pedestrian LTS (segment + crossing scores)
    stress.ts      # LTS prior + crash modulation → edge/node stress
    router.ts      # A* in directed-edge space, cost = distance + λ·stress
    explain.ts     # per-segment contributions, dominant conflict type
  build/
    extract-points.ts  # ONE-TIME: DATA.points out of so-crash-stress-map.html → CSVs
    fetch-osm.ts       # Overpass → data/osm-raw.json (committed snapshot)
    build-graph.ts     # snapshot → pedestrian graph, sidewalk handling, signal association
    causes.ts          # vehicles CSV → normalized cause labels by case number
    snap-risk.ts       # clusters + points + causes → node crash surface (always re-runs)
  data/
    osm-raw.json           # committed Overpass snapshot (versioned input)
    so_points_clustered.csv # canonical, recreated from HTML (one-time)
    so_hotspots.csv         # copied from ~/Documents/Claude/Projects/Linear/
    osrm-baselines.json     # cached OSRM responses for validation pairs
  artifacts/
    graph.json     # built graph (generated, committed)
    risk.json      # node crash surface (generated, committed)
```

Runtime (`src/`) has zero dependencies and no network access. Build (`build/`) runs via `tsx`, offline except `fetch-osm.ts`.

## Data pipeline

### Stage 0 — one-time extraction (brittleness guard)

`so_points_clustered.csv` and `south_orange_crashes.csv` from the handoff **do not exist on disk**. The 632 points live embedded in `so-crash-stress-map.html` as `const DATA = {points: [{la, lo, k, y, d, t, loc, c}]}`. That file is the live STC-211 spot-check tool and may be edited or regenerated at any time.

Rule: `extract-points.ts` runs **once**, writes canonical CSVs into `engine/data/`, and the HTML is never read by the build again. The map file goes back to being a UI, not a database. Extraction is committed with a row-count assertion (632 points; fail loudly on drift).

### Stage 1 — OSM fetch (versioned input)

Overpass query over the South Orange bbox plus ~300 m buffer into Maplewood/Orange. Ways where `highway` ∈ {footway, path, pedestrian, steps, living_street, residential, unclassified, service, tertiary, secondary, primary, cycleway}; exclude `foot=no` and `access=private` unless `foot=yes`. Response written to `data/osm-raw.json` and committed.

Re-fetching is an **explicit versioned action**, never implicit: it emits a diff report (nodes gained/lost, hotspot snaps that moved >10 m) before the new snapshot is accepted. Normal builds read only the committed snapshot — reproducible, no Overpass dependency.

### Stage 2 — graph build

- **Sidewalk representation detection.** OSM maps sidewalks either as tags on the road (`sidewalk=both/left/right`) or as parallel `footway=sidewalk` ways; suburban NJ is typically a mix. The build measures both counts and reports them. Handling: `footway=sidewalk` ways are **collapsed onto their parent road edge** (matched by proximity + parallel bearing within 25 m / 20°), upgrading that edge's sidewalk attribute; they are not kept as parallel graph edges in V1. Rationale: parallel sidewalk edges only connect at mapped crossings, which in patchy data silently produces walk-in-the-road routes or phantom crossings. Unmatched sidewalk ways are reported, not dropped silently. `footway=crossing` ways are kept and marked as crossings.
- **Signal association.** `highway=traffic_signals` nodes are associated to intersection nodes within a **20 m radius**, not by exact node identity — signals are routinely mapped a few meters off the intersection node.
- **Connectivity assert:** largest connected component must hold ≥95% of nodes; build fails otherwise.
- Node metadata retained: incident ways (with LTS), signal presence, crossing tags. Edge metadata: length, way ref, all tags consumed by the LTS rubric.

### Stage 3 — cause join (loud failure)

`south_orange_vehicles_joined.csv` case numbers come in at least five formats (`C-2020-003108`, `I-2021-022853`, `2022-023704`, `22-012691`, `C21048235`). The original session's normalization achieving the claimed 100% join is undocumented. `causes.ts` normalizes (strip prefixes/hyphens, zero-pad, year-disambiguate) and **asserts ≥98% join coverage against the 632 points, printing every unmatched case number**. Silent partial joins are the failure mode being designed against.

### Stage 4 — risk snapping (always re-runs)

`snap-risk.ts` snaps the 52 clusters to nearest intersection nodes with a **30 m max snap distance**; clusters beyond it (mid-block backing/parking clusters are mid-block by mechanism) are listed in the build report as unsnapped, never silently attached to the wrong corner. Output `risk.json` keys on graph node IDs, so this stage **re-runs on every graph rebuild** — it is a pipeline stage, not a frozen artifact. Per-node payload: `crash_n`, `stress`, `injury_n`, `vru_n`, `dominant_cause`, `cause_distribution`, `cluster_id`, `snap_dist_m`.

## Pedestrian LTS rubric

Scored 1 (any walker comfortable) → 4 (confident adults only). Two scores per the model's core claim: pedestrian stress concentrates at **crossings**, not along segments.

**Segment LTS** (walking along an edge):

| Input | Effect |
|---|---|
| `highway` footway/path/pedestrian/living_street | base 1 |
| residential/unclassified/service | base 2 |
| tertiary/secondary | base 3 |
| primary | base 4 |
| `steps` | base 1, flagged `steps: true` (stroller/wheelchair handling deferred with elevation) |
| `sidewalk=both` | −1 |
| `sidewalk=no` on ≥ residential | +1 |
| `maxspeed` ≥ 35 mph | +1 |
| `maxspeed` ≤ 20 mph | −1 |
| `lanes` ≥ 4 | +1 |

Clamped 1–4.

**Crossing LTS** (traversing a node): driven by the highest segment-LTS road being crossed, discounted by crossing quality at the node: signal associated → −1; `crossing=marked/zebra` → −0.5; unmarked or untagged → full penalty. Crossing LTS is clamped 1–4 after discounts (a discounted crossing never yields a negative penalty). Crossing penalty in meters: `penalty_m = base_penalty · (crossing_lts − 1)`, `base_penalty = 25 m` (tunable).

**Provenance (truthfulness guard):** every rubric input records whether it came from a tag or a default. `lts_reasons` entries are `{reason, source: "tagged" | "default"}` — "no sidewalk (tagged)" vs "sidewalk unknown, assumed absent (default)". STC-151 must render these differently; the explainability layer never states a default as fact. The build report breaks out tag coverage per input — `crossing=*` and `sidewalk=*` specifically, since thin coverage there collapses the model's differentiation and we need to see that number.

## Crash modulation (bounded)

`bump = k · log1p(cluster.stress)`, applied to the snapped node's crossing penalty and at half weight to edges incident to it. Log, not linear: cluster stress spans 42 → single digits; linear would let S Orange Ave × Vose dictate every route in town. **`k` is bounded so the maximum bump ≤ +1 LTS-equivalent** (i.e., ≤ `base_penalty` meters at the node). Default `k = 1 / log1p(42)`. `k` and the persona presets below are **unvalidated tuning knobs** and labeled as such in code and payload.

## Cost function and λ

Search in **directed-edge space** (state = incoming directed edge), because crossing cost depends on the movement through a node, not the node itself:

```
move_cost(e_in → e_out at v) =
    length(e_out)
  + λ · length(e_out) · (segment_lts(e_out) − 1) / 3
  + λ · crossing_penalty_m(v, e_in, e_out)
```

`crossing_penalty_m(v, e_in, e_out)`: the crossing LTS of the **highest-LTS incident way at `v` excluding the ways of `e_in` and `e_out`**, with quality discounts and crash bump applied. So: continuing along S Orange Ave through Vose charges Vose's (cheap) crossing; walking up Vose across 510 charges the arterial. Known approximation bias, stated openly: corner turns (e_in and e_out on different ways) exclude both ways and often price at zero — under-charging turns that in reality require crossing one leg. Fixing that needs sidewalk-side state; deferred, documented.

**λ semantics:** at segment LTS 4, `(4−1)/3 = 1`, so a meter costs `(1+λ)` meters — *λ is the fraction of extra distance you'd walk to avoid the worst streets*. λ=0 is shortest path. Persona presets (unvalidated defaults): confident adult 0.5 · parent with stroller 2 · child 3.

## Router

A* over directed-edge states. Heuristic: haversine to destination — admissible because every move costs ≥ its length and all penalties are ≥ 0. Origin/destination snap to nearest graph node (V1; mid-edge insertion deferred). Returns the full explainability payload, plus the λ=0 route on request for comparison rendering.

## Explainability payload (STC-151 contract)

```ts
interface RouteResult {
  lambda: number;
  distance_m: number;
  stress_cost_m: number;         // total λ-weighted penalty in meters
  segments: Array<{
    way_name: string | null;
    length_m: number;
    lts: 1 | 2 | 3 | 4;
    stress_contribution_m: number;
    lts_reasons: Array<{ reason: string; source: "tagged" | "default" }>;
  }>;
  flagged_nodes: Array<{
    node_id: string;
    name: string;                 // "Valley St × 3rd St"
    crossing_penalty_m: number;
    crossed_way: string | null;
    crash_n: number;
    dominant_cause: string | null; // "Driver inattention", "Failed to yield ROW", …
    cause_distribution: Record<string, number>;
  }>;
}
```

Every number the UI might display traces to a field here; no recomputation in the view layer. A segment with zero crashes still explains itself structurally (`lts_reasons`) — richer than the handoff anticipated.

## Validation harness

Scripted (`tsx engine/build/validate.ts`), not manual clicking. Test pair: NJT South Orange station → South Mountain Elementary; λ sweep {0, 0.5, 1, 2, 3, 5}.

1. **Monotonicity:** distance **nondecreasing** and stress cost **nonincreasing** across the sweep (plateaus legal; strict monotonicity is not guaranteed for discrete route sets).
2. **Hotspot avoidance (relative, endpoint-buffered):** exposure = count of top-10 hotspot nodes within 30 m of the route, **excluding a 100 m buffer around origin and destination** — the station sits inside the S Orange Ave/Sloan St cluster zone, so absolute-zero exposure is unsatisfiable from there. Assert: λ≥2 exposure strictly below λ=0 exposure whenever λ=0 exposure > 0.
3. **SS4A corridor overlap:** fraction of route length on the top-10 corridors, reported per λ — expected to fall as λ rises (reported trend, not hard assert).
4. **Graph integrity vs OSRM:** λ=0 route length compared against the **cached** OSRM foot route (`data/osrm-baselines.json`, refreshed manually — the public demo server is rate-limited and would make the harness flake). Reported ratio; alarm threshold ±25% (profile differences alone can exceed 10%, so no hard assert).
5. **Build report:** connectivity %, sidewalk representation counts, tag coverage per rubric input, join coverage, unsnapped clusters.

## Out of scope (this increment)

Elevation · tradeoff UI (STC-156) · POI destination search (STC-154) · Astro embed · mid-edge origin snapping · sidewalk-side turn state · per-persona step/curb handling.

## Honest limits (carry into any writeup)

- Mekuria & Furth LTS is a **bicycle** framework; this pedestrian adaptation is ours and must be labeled as such, not cited as canonical.
- Most LTS inputs will rest on class defaults where OSM tags are thin; the provenance flags and coverage report exist so this is visible, never hidden.
- Vehicle-conflict density as walking-stress proxy remains an assumption; the structural prior deliberately limits how much of the model rests on it. Supporting evidence: SS4A VRU stats (5% of crashes, 56% of serious injuries).
- Two years of point data is thin; crash modulation is bounded partly for this reason. Both fatal crashes lack coordinates.
- No exposure data yet (STC-150): quiet-because-empty and safe-by-design remain indistinguishable in the crash channel; the LTS prior partially compensates but does not resolve it.

## Process

- Progress comment on STC-152 after each working increment (pipeline builds; router routes; validation passes). Include the LTS-prior inversion of task 2 in the first comment. **No Linear state changes without Patrick's sign-off.**
- Implementation order: Stage 0 extraction → OSM fetch + graph build → LTS rubric → cause join + risk snapping → router → explain payload → validation harness. Each stage lands with its build-report numbers.
