# Model Rework Bundle — Design Spec

**Date:** 2026-08-13 · **Linear:** STC-152 · **Follows:** V1 engine (PR #1, merged)
**Scope:** the three model gaps breadcrumbed in code by the V1 final review. No new features, no λ retuning.

## Decisions (settled with Patrick 2026-08-13)

| Gap | Decision |
|---|---|
| Driveways price as street crossings | `highway=service` edges are **excluded from the crossed-road set** in `crossingAt`. Structurally zero: on a sidewalk you don't "cross" a driveway the way you cross a street. Real backing/parking conflict risk (5.9% of local causes) is carried by crash bumps where it actually occurred. Service edges keep their own segment LTS when walked along. |
| Signal/crossing 20 m association spills onto neighbors | **Nearest-node single assignment.** Each OSM `highway=traffic_signals` node associates to its ONE nearest graph node within 20 m; each `crossing=*` node to its ONE nearest graph node within 10 m (if two crossing nodes map to the same graph node, the nearer wins). No node receives a tag it isn't the nearest host for. |
| Risk snap misses multi-node intersection complexes | **Duplicate across the complex.** After primary snapping, each risk node's full payload is duplicated onto graph nodes within 20 m that share ≥1 incident `roadKey` with it (marked `complexOf: <primary nodeId>`). A walker traverses one node of the Valley×Third complex — each member carrying full risk is the physically correct reading. Nodes that already carry their own cluster risk are never overwritten. |

## Contract changes

- `NodeRisk` gains optional `complexOf?: string` (absent on primary entries). `risk.json` grows; `explainRoute` passes risk through unchanged — STC-151 payload shape is unaffected.
- `SnapReport` gains `complexMembers: number` (count of duplicated entries).
- Build report: `signalNodes` becomes the single-assigned count (expected ≈ raw 66, down from 307); `signalNodesRaw`, `crossingRaw` unchanged.

## Acceptance

- Existing movement-aware router tests still pass; new tests pin: service exclusion (a higher-LTS service edge is never the crossed road; service-only nodes charge zero crossing), nearest-only tag assignment (a signal within 20 m of two nodes marks exactly one), complex duplication (same-road neighbor within 20 m inherits `complexOf`; different-road neighbor doesn't; existing risk never overwritten).
- Artifacts regenerated; the real-graph integration test still passes.
- `npm run validate`: **assert-2 (hotspot exposure drops at λ≥2) is expected to flip green.** If it does: update the validate.ts breadcrumb and the README hedge accordingly, and remove the router.ts driveway breadcrumb (replaced by a model-decision comment). If it still fails: that is a new finding — report with the λ table, change nothing else.

## Honest limits

The complex-duplication rule double-counts risk if a route passes through two member nodes of the same complex (each charges full bump). Accepted for V1.1: routes rarely traverse multiple members, and under-counting was the failure mode that broke validation. Revisit if flagged_nodes show duplicate complex entries in practice — dedup by `complexOf` in the explain layer is the natural fix.
