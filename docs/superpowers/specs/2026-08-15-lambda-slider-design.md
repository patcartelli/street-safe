# λ Tradeoff Slider — Design Spec

**Date:** 2026-08-15 · **Linear:** STC-156 (V1.5 tradeoff-visibility UI) · **Follows:** UI wiring (PR #3, merged)
**Scope:** the λ dial only. The tradeoff *sentence* (STC-156's literal example) already shipped in PR #3; this makes the tradeoff explorable.

## Decisions (settled with Patrick 2026-08-15)

| Decision | Choice |
|---|---|
| Control | Continuous slider, λ 0–5 step 0.1, default 2, with labeled detent marks at 0.5 / 2 / 3 ("confident walker" / "with a stroller" / "with a child") and endpoint labels faster ↔ calmer. Personas are annotations on a continuum, presented as presets — never clinical claims |
| Liveness | Reroute live on every input, rAF-throttled. The solid safe route, risk strip, and full readout update continuously; the λ=0 fastest dashed reference is computed once per pair and pinned while dragging |
| Scope | Slider only. No chart, no copy redesign (STC-151 owns copy) |

## Behavior

- The safe route is always `route(λ = slider value)`; the reference is always `route(λ=0)` for the current pair, recomputed only when the pair changes (Find safe route click), never while dragging.
- At λ=0 (or whenever edge sequences match) the existing same-route copy applies and the dashed line is hidden — the current `sameEdgeSequence` logic already handles this; the slider just makes it reachable by drag.
- The visible λ value updates live (one decimal). When the thumb sits within ±0.05 of a persona detent, the persona label shows next to the value; otherwise no persona is claimed.
- Dragging before any route has been computed does nothing except update the value display; the slider is enabled with the rest of the controls after artifacts load.
- Honest labeling: a small caption under the slider — "presets are starting points, not safety guarantees" — consistent with the README's unvalidated-knobs stance.

## Implementation shape

- `web/helpers.ts` gains `personaLabel(lambda: number): string | null` (pure, tested): ±0.05 of 0.5 → "confident walker", 2 → "with a stroller", 3 → "with a child", else null.
- `web/main.ts`: module state `currentLambda` (init 2) + `pinnedFast: {raw, result} | null` per pair; slider `input` handler sets `currentLambda`, updates the value/persona display, and (if a pair is active) schedules a rAF reroute — at most one `route()` per frame, latest value wins.
- `index.html`: slider block between the controls row and the readout; native `<input type="range" min="0" max="5" step="0.1">` + `<output>` + tick labels (CSS-positioned; native `datalist` ticks are inconsistently rendered, so ticks are styled spans). Proper `<label>` + `aria-describedby` for the caption.
- `style.css`: dark-theme styling consistent with existing controls; tick marks aligned to 0.5/2/3 positions (10% / 40% / 60% of track).
- Bundle rebuilt (`npm run build-web`); the bundle-currency test enforces it.

## Acceptance

- `personaLabel` unit-tested; full suite green (48+ tests), typecheck, validate exit 0 (engine untouched — `engine/` must have zero diffs this increment).
- Controller live-verifies: drag from 0 → 5 morphs the route with no console errors; λ=0 collapses to same-route copy; readout numbers at λ=2 match the pre-slider demo exactly; persona label appears only near detents; screenshot captured.
- README: one bullet documenting the slider + persona-preset honesty line.

## Honest limits

Persona λ values remain unvalidated presets (spec'd in V1, never calibrated); the caption says so. Live dragging recomputes only the safe route — flagged-node avoidance counts compare against the pinned λ=0 reference, so the "avoids N" number is always relative to fastest, which is the intended meaning.
