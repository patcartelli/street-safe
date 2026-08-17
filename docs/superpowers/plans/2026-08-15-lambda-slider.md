# λ Tradeoff Slider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose λ as a live continuous slider per `docs/superpowers/specs/2026-08-15-lambda-slider-design.md` — drag between fastest and calmest and watch the route morph.

**Architecture:** `personaLabel` pure helper (tested) + slider markup/CSS + `web/main.ts` state (`currentLambda`, pinned λ=0 reference per pair, rAF-throttled reroute). Engine untouched.

**Tech Stack:** unchanged.

## Global Constraints

- `engine/` has zero diffs this increment (`git diff --stat` on engine/ must be empty at the end).
- Slider: `min=0 max=5 step=0.1`, default 2; detents 0.5/2/3 labeled "confident walker" / "with a stroller" / "with a child"; endpoint labels "faster" / "calmer"; caption "presets are starting points, not safety guarantees"; persona label shown only within ±0.05 of a detent.
- Live reroute is rAF-throttled: at most one `route()` per animation frame, latest slider value wins; the λ=0 reference is computed once per pair, never while dragging.
- All displayed numbers keep coming from `RouteResult`/`RawRoute` fields.
- Bundle rebuilt and committed (the bundle-currency test enforces staleness).
- Commit after every task.

---

### Task 1: personaLabel helper (TDD)

**Files:**
- Modify: `web/helpers.ts`
- Test: `engine/tests/web-helpers.test.ts`

**Interfaces:**
- Produces: `export function personaLabel(lambda: number): string | null` — within ±0.05 (inclusive) of 0.5 → `'confident walker'`; of 2 → `'with a stroller'`; of 3 → `'with a child'`; else `null`.

- [ ] **Step 1: Write failing tests** — append to `engine/tests/web-helpers.test.ts`:

```ts
test('personaLabel matches detents within ±0.05 only', () => {
  assert.equal(personaLabel(0.5), 'confident walker');
  assert.equal(personaLabel(0.55), 'confident walker');
  assert.equal(personaLabel(0.56), null);
  assert.equal(personaLabel(2), 'with a stroller');
  assert.equal(personaLabel(1.95), 'with a stroller');
  assert.equal(personaLabel(3.04), 'with a child');
  assert.equal(personaLabel(0), null);
  assert.equal(personaLabel(5), null);
  assert.equal(personaLabel(1.2), null);
});
```

(Add `personaLabel` to the import line.)

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (not exported). NOTE: the bundle-currency test will pass in this task because `helpers.ts` additions don't change `main.ts`'s bundle only if the bundle doesn't inline unused exports — esbuild tree-shakes IIFE entry output, so an unused export added to helpers.ts typically leaves the bundle byte-identical. If the currency test DOES fail here, run `npm run build-web` and commit the bundle in this task too.

- [ ] **Step 3: Implement** — append to `web/helpers.ts`:

```ts
const PERSONA_DETENTS: Array<{ lambda: number; label: string }> = [
  { lambda: 0.5, label: 'confident walker' },
  { lambda: 2, label: 'with a stroller' },
  { lambda: 3, label: 'with a child' },
];

/** Persona presets are UNVALIDATED starting points (spec'd in V1, never calibrated). */
export function personaLabel(lambda: number): string | null {
  for (const d of PERSONA_DETENTS) {
    if (Math.abs(lambda - d.lambda) <= 0.05 + 1e-9) return d.label;
  }
  return null;
}
```

- [ ] **Step 4: Verify pass** — `npm test` all green, `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add web/helpers.ts engine/tests/web-helpers.test.ts` (+ bundle if step 2's note applied) · `git commit -m "feat(web): personaLabel helper for slider detents"`

---

### Task 2: Slider UI + live reroute

**Files:**
- Modify: `index.html`, `style.css`, `web/main.ts`, `web/bundle.js` (rebuilt)

**Interfaces:**
- Consumes: `personaLabel` (Task 1); existing `main.ts` structure (`findRoute`, `drawRouteLines`, render fns, `routeLayers`).
- Produces, in `web/main.ts`:
  - Module state: `let currentLambda = 2;` and `let activePair: { originId: string; destId: string; fastRaw: RawRoute; fastResult: RouteResult } | null = null;`
  - `findRoute()` refactor: resolve the pair → compute and pin the λ=0 reference into `activePair` → call `rerouteSafe()`.
  - `rerouteSafe()`: computes `route(..., currentLambda)` + `explainRoute`, renders everything against `activePair`'s pinned reference. Both `findRoute` and the slider path funnel through it — no duplicated render logic.
  - Slider handler: on `input`, update `currentLambda` + the `<output>` (λ to one decimal, plus persona label from `personaLabel(currentLambda)` when non-null); if `activePair`, schedule `rerouteSafe()` via a rAF guard:

```ts
let rerouteScheduled = false;
function scheduleReroute(): void {
  if (rerouteScheduled || !activePair) return;
  rerouteScheduled = true;
  requestAnimationFrame(() => {
    rerouteScheduled = false;
    rerouteSafe();
  });
}
```

  - Changing either select clears `activePair` (stale reference must not survive a pair change without a recompute) — simplest: on select `change`, null it and leave the last drawing until the next Find click, matching current behavior.
- `index.html` (between the controls row and the readout column start — implementer places it in the panel where the FROM/TO controls live, matching existing structure):

```html
<div class="lambda-block">
  <div class="lambda-head">
    <label for="lambda-slider">Route preference</label>
    <output id="lambda-value" for="lambda-slider"></output>
  </div>
  <input type="range" id="lambda-slider" min="0" max="5" step="0.1" value="2"
         aria-describedby="lambda-caption" disabled />
  <div class="lambda-ticks" aria-hidden="true">
    <span class="lambda-end lambda-end-left">faster</span>
    <span class="lambda-tick" style="left: 10%">confident walker</span>
    <span class="lambda-tick" style="left: 40%">with a stroller</span>
    <span class="lambda-tick" style="left: 60%">with a child</span>
    <span class="lambda-end lambda-end-right">calmer</span>
  </div>
  <p id="lambda-caption" class="lambda-caption">Presets are starting points, not safety guarantees.</p>
</div>
```

  The slider starts `disabled` and is enabled alongside the route button when artifacts load. The `<output>` is initialized on load (λ = 2.0 · with a stroller).
- `style.css`: dark-theme styling for `.lambda-block/.lambda-head/.lambda-ticks/.lambda-tick/.lambda-end/.lambda-caption` using the existing CSS custom properties (match the muted/accent tones already defined; accent the range thumb with the safe-route teal `#3FA796`). Tick labels small (10px), muted, absolutely positioned over a relative container; caption smaller and dimmer. Keep it minimal — no new fonts, no layout reflow of existing blocks.

- [ ] **Step 1: Refactor `findRoute` → `rerouteSafe` split** (behavior-preserving at λ=2; verify `npm test` still green — node tests don't cover DOM, but the bundle-currency test pins the rebuild).
- [ ] **Step 2: Add slider markup + CSS + handler + enable-on-load + output init.**
- [ ] **Step 3: `npm run build-web`; `npm test` (bundle-currency now enforces the fresh bundle) + `npm run typecheck`.**
- [ ] **Step 4: Confirm `git diff --stat -- engine/` is empty.** State it in your report.
- [ ] **Step 5: Commit** — `git add index.html style.css web/main.ts web/bundle.js` · `git commit -m "feat(web): live λ tradeoff slider with persona detents (STC-156)"`

---

### Task 3: README bullet + suite

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** In the demo-does section, update the λ bullet: the demo exposes λ as a live slider (0–5) — drag between "faster" and "calmer" and the route, risk strip, and explanation update continuously against the pinned fastest reference; persona detents (confident walker 0.5 / stroller 2 / child 3) are unvalidated starting points and labeled as such in the UI.
- [ ] **Step 2:** Full suite: `npm test`, `npm run typecheck`, `npm run validate` (exit 0), `npm run build-web` byte-stable.
- [ ] **Step 3: Commit** — `git add README.md` · `git commit -m "docs: README documents the λ slider"`

Controller then live-verifies (drag morph, λ=0 collapse, λ=2 parity with pre-slider numbers, persona label behavior, console clean, screenshot) before final review and the merge decision.

## Self-Review

1. **Spec coverage:** helper → Task 1; control/liveness/pinning/a11y/styling → Task 2; README → Task 3; live verification is the controller's step. Covered.
2. **Placeholders:** Task 2 delegates exact code to the implementer against named handlers and provided markup/throttle snippets — same deliberate pattern as the UI-wiring plan; the reviewer checklist is the Interfaces block.
3. **Type consistency:** `personaLabel` signature matches its test; `activePair` holds both `RawRoute` and `RouteResult` for the pinned reference, which `rerouteSafe` renders against; tick positions 10/40/60% correspond to 0.5/2/3 over a 0–5 track.
