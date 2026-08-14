# Street Safe

A→B walking navigation that weighs safety alongside speed — for a small, walkable suburban town where most residents still default to driving.

**Status: early prototype.** This proves the core mechanic (safety-weighted routing + explainable results) works end to end before investing in real infrastructure. Tracked in Linear under "Safe Routes — Walking Safety Navigation."

## What this demo actually does

- **A real, standalone walking-route engine (`engine/`)**, built from actual OpenStreetMap street/sidewalk geometry for South Orange, NJ, weighted by a real crash-derived risk surface and a pedestrian-comfort structural prior:
  - **Risk surface** (`engine/artifacts/risk.json`): 52 clusters snapped from real 2022–23 NJDOT crash point data (recovered from the state's crash-map HTML — the CSV export was unavailable; see extraction notes in `engine/build/extract-points.ts`), each carrying crash counts, injury/VRU counts, dominant cause, and a computed stress score.
  - **Pedestrian-LTS structural prior** (`engine/src/lts.ts`): every street/crossing carries an intrinsic stress rating derived from road class, speed, lane count, and crossing control — independent of whether a crash was ever recorded there. This is a **project-defined adaptation**, not the canonical Mekuria & Furth LTS methodology; it borrows the concept, not the published rubric.
  - **λ-weighted router** (`engine/src/router.ts`): a single tunable knob (λ) trades route distance for lower structural (LTS) stress **and validated hotspot avoidance** — on the station→South Mountain Elementary validation pair, all top-10 crash hotspots are avoided at λ≥2 for a +264 m detour (see `npm run validate` below).
  - **Explainability** (`engine/src/explain.ts`): per-segment stress attribution and flagged high-risk nodes along the chosen route, with dominant crash cause where available.
  - **Validation harness** (`engine/build/validate.ts`, run via `npm run validate`): sweeps λ across a fixed station-to-school pair, asserting distance/stress trend correctly, checking hotspot exposure and safety-corridor overlap, and sanity-checking output distance against a cached OSRM foot-routing baseline. Hotspot exposure is counted per physical intersection complex (deduped, not per graph node) and excludes hotspots within 100 m of the route's own endpoints; a second, unasserted pair documents one intersection (Valley×Third) that's structurally unavoidable when it sits directly on the destination's corridor.
- **The browser demo** (`index.html` / `web/main.ts`) runs the real engine **in the browser**: it fetches the committed `engine/artifacts/{graph,risk}.json`, snaps a curated set of 8 real destinations onto the graph with `nearestNode`, and calls the same `route()` / `explainRoute()` the engine tests and validation harness exercise. There is no server and no mock data — for the same start/end pair, the demo and `npm run validate` are evaluating the same router.
  - Two tiers are drawn: **safest** (`route(λ=2)`, solid) and **fastest** (`route(λ=0)`, dashed, only when its edge sequence actually differs from safest's). This mirrors the validated λ≥2 hotspot-avoidance tier from `npm run validate` — there is no slider or arbitrary λ in the UI (Linear STC-156).
  - The readout panel is built entirely from real `RouteResult` fields: distance delta, `avoidedComplexes` (physical-intersection-deduped, matching the validation harness's counting), flagged hazard nodes with their actual NJDOT-coded dominant cause, and `stress_cost_m`. Nothing in the readout is invented.

## What this demo honestly does NOT do yet

- **No elevation weighting**, in the engine or the UI. Elevation is real V1 scope, just not implemented yet.
- **No live road closures.** Static demo only.
- **No POI search.** Destinations are a curated, hardcoded set of 8 real places (`web/destinations.ts`), not pulled from OpenStreetMap POI tags (Linear STC-154).
- **No λ slider or personas.** The UI only ever shows the two validated tiers, λ=2 (safest) and λ=0 (fastest); free λ selection and persona-based weighting are future scope (Linear STC-156).
- **Walking time is a flat-pace estimate**, not a real duration model: `minutesAt80` divides route distance by a fixed 80 m/min walking pace. The UI labels this with "≈" and calls out the assumption in the readout copy; it is not derived from street type, grade, or crossing delay.
- The pedestrian-LTS rubric is **project-defined**, adapted from the general LTS concept rather than reproducing Mekuria & Furth's published thresholds — treat comfort scores as directional, not a certified LTS classification.
- Not a production routing backend — the underlying OSM extract and crash join cover one town; nothing here is validated at scale.

## Running it

The browser demo (`index.html` / `web/main.ts`, wired to the real engine) needs no build step to view — the compiled bundle is committed:

```
npx serve .
```

If you change anything under `web/` or `engine/src`, rebuild the bundle before reloading — there's no watch mode:

```
npm run build-web
```

The engine (`engine/`) is a separate, standalone TypeScript pipeline:

```
npm install
npm test              # unit + integration tests
npm run build-engine  # rebuild engine/artifacts/{graph,risk,build-report}.json from source data
npm run validate      # sweep λ, sanity-check against an OSRM baseline
```

`npm run build-engine` **requires** the local, uncommitted `south_orange_vehicles_joined.csv`
(crash-cause data) at `~/Documents/Claude/Projects/Linear/`, or set `SAFE_ROUTES_DATA_DIR` to
point elsewhere. It's deliberately not in the repo for privacy. A clean clone can't rebuild the
artifacts from scratch, but the committed artifacts in `engine/artifacts/` make everything else
(routing, explainability, tests, validation) work without it.

`npm run validate` **passes (exit 0)** — it is the acceptance gate for the routing/risk model:
it asserts distance/stress trend correctly across the λ sweep and that all top-10 crash
hotspots are avoided by λ≥2. See `engine/build/validate.ts` for the deduped, physical-complex
exposure metric and the documented (unasserted) unavoidable-junction counter-example.

## Why walking-first

Most navigation tools optimize for speed. This project's thesis is that in a hilly, walkable suburban town, the real barrier to walking isn't distance, it's that walking often isn't the cheapest, most convenient, or safest option relative to driving. Surfacing *why* a route is safer, not just presenting a black-box score, is the core differentiator and the reason "explainability" was treated as v1 scope rather than a nice-to-have.

## Roadmap

See the Linear project for the full phased plan (V1 → V1.5 → V2 multimodal → V3 contextual/temporal weighting). This repo currently covers a slice of V1: routing + explainability, built on real crash and street-geometry data in `engine/` and wired end to end into the browser demo. POI search (STC-154) and a λ slider/persona model (STC-156) are the next scoped increments.
