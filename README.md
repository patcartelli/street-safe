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
- **The browser demo** (`index.html` / `app.js`) is the **old, pre-engine flow**: it still calls [OSRM](https://project-osrm.org/)'s public demo router directly and re-scores alternatives against `data/mock-crashes.js`, an invented dataset. It has **not yet been wired to the new `engine/`** — that cutover is future work.

## What this demo honestly does NOT do yet

- **The UI isn't wired to the real engine.** Everything in `engine/` (real crash risk, real LTS, real λ-weighted routing) runs and validates on its own, but `index.html`/`app.js` haven't been repointed at it. The page you can click through today is still the OSRM-rescoring prototype described above.
- **`data/mock-crashes.js` is legacy**, kept only because the UI still depends on it pending the engine cutover. `engine/artifacts/risk.json` is the real replacement.
- **OSRM is now a validation baseline, not a routing source for the engine.** `engine/build/fetch-osrm-baseline.ts` caches one OSRM foot-route distance/duration for the validation pair, so the harness can sanity-check the engine's output without hitting the live (rate-limited) OSRM server on every run.
- **No elevation weighting**, in the engine or the UI. Elevation is real V1 scope, just not implemented yet.
- **No live road closures.** Static demo only.
- **Destinations are hardcoded** in the UI, not pulled from OpenStreetMap POI tags yet (Linear STC-154).
- The pedestrian-LTS rubric is **project-defined**, adapted from the general LTS concept rather than reproducing Mekuria & Furth's published thresholds — treat comfort scores as directional, not a certified LTS classification.
- Not a production routing backend — the underlying OSM extract and crash join cover one town; nothing here is validated at scale.

## Running it

The browser demo (`index.html` / `app.js`, the legacy OSRM-rescoring prototype) needs no build step:

```
npx serve .
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

See the Linear project for the full phased plan (V1 → V1.5 → V2 multimodal → V3 contextual/temporal weighting). This repo currently covers a slice of V1: routing + explainability, now built on real crash and street-geometry data in `engine/`, with the browser UI still pending cutover from its original mock-data prototype.
