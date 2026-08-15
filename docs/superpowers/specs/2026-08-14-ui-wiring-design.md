# UI Wiring — Design Spec

**Date:** 2026-08-14 · **Linear:** STC-152 · **Follows:** model rework bundle (PR #2, merged)
**Scope:** the browser demo runs the real engine. The legacy OSRM/mock-crash path is deleted.

## Decisions (settled with Patrick 2026-08-14)

| Decision | Choice |
|---|---|
| Patrick's local edits | Dark CARTO tiles kept (committed on main as `d754b51`); his mock-crash additions dropped — the file itself is deleted by this increment |
| Routing tiers in the UI | Safest = `route(λ=2)` (validated avoidance tier) drawn solid; fastest = `route(λ=0)` drawn as the dashed reference. No slider, no personas — that is STC-156 |
| Destinations | Curated real set of ~8 places (station, South Mountain Elementary, library, SOPAC, Meadowland Park/Flood's Hill, Village Hall, Marshall Elementary, Grove Park), snapped via `nearestNode` at load. POI search stays STC-154 |

## Architecture

- `web/main.ts` — the only new module. Imports `loadGraph`/`nearestNode` (graph.js), `route` (router.js), `explainRoute` (explain.js) straight from `engine/src` (browser-portable by constraint), fetches `engine/artifacts/graph.json` + `risk.json`, and drives the existing DOM ids in `index.html`.
- Build: `esbuild` (new explicit devDep) via `npm run build-web` → `web/bundle.js` (iife, es2020, not minified). **The bundle is committed** so `npx serve .` keeps working with no build step — same policy as the committed artifacts.
- `index.html` swaps its two script tags (`data/mock-crashes.js`, `app.js`) for `web/bundle.js`. `app.js` and `data/mock-crashes.js` are deleted.
- Runtime stays zero-dependency; Leaflet stays the CDN global (`L`) it already is; `web/main.ts` may reference it via a minimal `declare const L: any`.

## UI mapping (existing DOM, real payloads)

- **Map lines:** safest solid `#3FA796` weight 5; fastest dashed `#8A94A6` (drawn only when its edge sequence differs from the safest). Geometry comes from `RawRoute.geometry` (lat/lon pairs, ready for Leaflet).
- **Why this route:** distance delta vs fastest; count of distinct flagged *physical* hotspots on the fastest route that the safest avoids; stress cost in meters-equivalent. Sourced from the two `RouteResult`s — never recomputed.
- **Hazard list:** safest route's `flagged_nodes`, **deduped by physical complex** (`complexOf` → primary; show each physical intersection once, keeping the highest-`crash_n` entry) — the dedup the rework spec's honest-limits predicted. Each row: name, `dominant_cause`, `crash_n`, and crossing penalty when > 0.
- **Risk strip:** colored from the safest route's per-edge `lts` (1–2 low, 3 med, 4 high), walked along `segments` in route order.
- **Tradeoff line:** minutes at 80 m/min walking pace (the engine has no durations; say "≈" and note the assumption in the UI, honestly).
- **Loading state:** artifacts are ~MB-scale; the route button is disabled with a "loading network…" label until both fetches resolve; fetch failure shows a visible error, not a dead button.
- **Crash layer:** the old mock-crash dots are replaced by the real risk surface: one circle marker per *primary* risk node (52), radius scaled by `log1p(stress)`, tooltip = name + crash_n + dominant cause.

## Destinations

Candidate coordinates are approximate; the implementer snap-checks each against the graph (printed street names must make sense) and adjusts before pinning:
station 40.7459,-74.2602 · South Mountain Elem 40.7472,-74.2760 · Library (Scotland Rd) 40.7495,-74.2560 · SOPAC 40.7464,-74.2610 · Meadowland Park/Flood's Hill 40.7452,-74.2555 · Village Hall 40.7488,-74.2565 · Marshall Elem (Grove Rd) 40.7418,-74.2510 · Grove Park 40.7420,-74.2570. Defaults: station → South Mountain Elementary (the validated pair).

## Acceptance

- Pure helpers (`dedupeFlagged`, `minutesAt80`, destination snap resolution) unit-tested with `node:test`; DOM behavior verified in the browser by the controller (screenshot proof): both routes render, hazard list shows real causes, no console errors, offline-from-CDN failure degrades visibly.
- `npm test` / `npm run typecheck` / `npm run build-web` / `npm run validate` all green; README's demo section rewritten (the "UI not wired" caveats come out).

## Honest limits

Walking minutes are a flat-pace estimate, labeled as such. The demo still requires the committed bundle to be rebuilt manually after engine changes (`npm run build-web` — no watch mode). Leaflet and basemap tiles come from CDNs; the engine itself runs fully local.
