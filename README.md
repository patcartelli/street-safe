# Street Safe

A→B walking navigation that weighs safety alongside speed — for a small, walkable suburban town where most residents still default to driving.

**Status: early prototype.** This proves the core mechanic (safety-weighted routing + explainable results) works end to end before investing in real infrastructure. Tracked in Linear under "Safe Routes — Walking Safety Navigation."

## What this demo actually does

- Real walking routes via [OSRM](https://project-osrm.org/)'s public demo router (no API key required)
- Scores each route alternative against a **mock crash dataset** (`data/mock-crashes.js`) — invented severities/counts at plausible real intersections, standing in for real municipal crash data
- Picks the route with the lowest weighted crash exposure, not just the fastest one
- Shows the fastest alternative as a dashed reference line, so the tradeoff is visible, not hidden
- Explains *why* a route was chosen — not just "safer," but which flagged intersections it avoids and by how much
- Renders a per-segment risk strip along the chosen route

## What this demo honestly does NOT do yet

- **No real crash data.** `data/mock-crashes.js` says so in its own header. Confirming a real source is open (see Linear STC-149).
- **No elevation weighting.** The UI says this explicitly rather than pretending it's factored in. Elevation is real V1 scope, just not wired up yet.
- **No live road closures.** Static demo only.
- **Destinations are hardcoded**, not pulled from OpenStreetMap POI tags yet (Linear STC-154).
- Not a production routing backend — OSRM's public demo server is rate-limited and has no uptime guarantee. Fine for proving the concept, not for real traffic.

## Running it

No build step. Open `index.html` in a browser, or serve the folder locally:

```
npx serve .
```

## Why walking-first

Most navigation tools optimize for speed. This project's thesis is that in a hilly, walkable suburban town, the real barrier to walking isn't distance, it's that walking often isn't the cheapest, most convenient, or safest option relative to driving. Surfacing *why* a route is safer, not just presenting a black-box score, is the core differentiator and the reason "explainability" was treated as v1 scope rather than a nice-to-have.

## Roadmap

See the Linear project for the full phased plan (V1 → V1.5 → V2 multimodal → V3 contextual/temporal weighting). This repo currently covers a slice of V1: routing + explainability, proved out against mock data.
