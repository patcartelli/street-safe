# Model Rework Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three V1 model gaps (driveway crossing pricing, tag-association spill, multi-node risk snap) per `docs/superpowers/specs/2026-08-13-model-rework-bundle-design.md`, flipping the validation harness's hotspot-exposure assert green.

**Architecture:** Three surgical changes to existing modules (router.ts crossingAt, build-graph.ts tag association, snap-risk.ts complex duplication) + artifact regeneration + validation re-run. No new modules, no signature changes except optional fields.

**Tech Stack:** unchanged (TypeScript, tsx, node:test, zero runtime deps).

## Global Constraints

- Values verbatim from the spec: signals nearest-node ≤ 20 m single assignment; crossings nearest-node ≤ 10 m single assignment; complex duplication radius 20 m gated on shared incident `roadKey`; existing risk entries never overwritten.
- `engine/src/` imports only within engine/src, no node builtins.
- Working tree has pre-existing uncommitted `app.js` / `data/mock-crashes.js` edits — never stage or revert them.
- Assert-2 in validate.ts must not be weakened. Expected to pass after these fixes; if it still fails, that is a reported finding, not a tuning target.
- Commit after every task.

---

### Task 1: Exclude service ways from the crossed-road set

**Files:**
- Modify: `engine/src/router.ts` (crossingAt + the KNOWN MODEL GAP breadcrumb above it)
- Test: `engine/tests/router.test.ts`

**Interfaces:**
- Consumes: `GraphEdge.highway` (already on every edge).
- Produces: `crossingAt` skips edges with `highway === 'service'` when scanning for the crossed road. No signature change.

- [ ] **Step 1: Write the failing tests**

In `engine/tests/router.test.ts`, extend the `grid()` fixture: add node `P` at `40.7395, -74.2597` and a service edge at M:

```ts
      N('P', 40.7395, -74.2597),
```

and in the edges array:

```ts
      E('M', 'P', 'Depot Drive', 'service', 3, 60),
```

(LTS 3 is deliberately contrived — higher than Side St's 2 — so the test proves exclusion rather than tie-breaking.) Add two tests:

```ts
test('service ways are never the crossed road', () => {
  const g = loadGraph(grid());
  const r0 = route(g, noRisk, 'O', 'D', 0)!;
  const mMove = r0.moves.find((m) => m.nodeId === 'M')!;
  // Without the service exclusion, Depot Drive (LTS 3) would win the max scan.
  assert.equal(mMove.crossedRoad, 'Side St');
});

test('a node whose only cross-ways are service charges zero crossing', () => {
  // Sub-fixture: straight residential street through node B with only a service way crossing.
  const g2 = loadGraph({
    nodes: [
      { id: 'A', lat: 40.7400, lon: -74.2620, signal: false, crossing: null },
      { id: 'B', lat: 40.7400, lon: -74.2600, signal: false, crossing: null },
      { id: 'C', lat: 40.7400, lon: -74.2580, signal: false, crossing: null },
      { id: 'S', lat: 40.7395, lon: -74.2600, signal: false, crossing: null },
    ],
    edges: [
      { from: 'A', to: 'B', wayId: 'w1', name: 'Main St', highway: 'residential', lengthM: 170, lts: 2, ltsReasons: [], steps: false, geometry: [] },
      { from: 'B', to: 'C', wayId: 'w2', name: 'Main St', highway: 'residential', lengthM: 170, lts: 2, ltsReasons: [], steps: false, geometry: [] },
      { from: 'S', to: 'B', wayId: 'w3', name: null, highway: 'service', lengthM: 60, lts: 2, ltsReasons: [], steps: false, geometry: [] },
    ],
  });
  const r = route(g2, noRisk, 'A', 'C', 1)!;
  const bMove = r.moves.find((m) => m.nodeId === 'B')!;
  assert.equal(bMove.crossedRoad, null);
  assert.equal(bMove.crossingPenaltyM, 0);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` — the first new test fails with `crossedRoad === 'Depot Drive'`; the second with a non-null crossedRoad.

- [ ] **Step 3: Implement**

In `engine/src/router.ts` `crossingAt`, add the class filter to the incident-edge loop:

```ts
    if (e.highway === 'service') continue; // model decision 2026-08-13, see comment above
```

Replace the KNOWN MODEL GAP breadcrumb block above `crossingAt` with:

```ts
/** MODEL DECISION 2026-08-13 (STC-152 rework): highway=service ways (driveways,
 *  parking aisles) are excluded from the crossed-road set — on a sidewalk you do
 *  not "cross" a driveway the way you cross a street, and pricing them as
 *  residential crossings made most flagged_nodes spurious and drove route choice
 *  at λ≥1. Real backing/parking conflict risk is carried by crash bumps where it
 *  actually occurred. Service edges still carry their own segment LTS when
 *  walked along. */
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all pass (37 existing + 2 new). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add engine/src/router.ts engine/tests/router.test.ts
git commit -m "fix(engine): exclude service ways from the crossed-road set"
```

---

### Task 2: Nearest-node single assignment for signal and crossing tags

**Files:**
- Modify: `engine/build/build-graph.ts` (tag-association block + its radius-spill comment)
- Test: `engine/tests/build-graph.test.ts`

**Interfaces:**
- Produces: each OSM signal node marks exactly one graph node (nearest, ≤ 20 m); each crossing-tagged OSM node marks exactly one graph node (nearest, ≤ 10 m; if several crossing nodes elect the same graph node, the nearest wins). `BuildReport` shape unchanged (`signalNodes` now reflects single assignment).

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/build-graph.test.ts` (new fixture; two intersections ~16 m apart sharing one signal):

```ts
/** Two graph nodes ~16 m apart; one OSM signal 6 m from node 25, 12 m from node 24.
 *  Old 20 m radius marked both; nearest-only must mark exactly node 25. */
const SIG = { elements: [
  { type: 'node', id: 21, lat: 40.7400, lon: -74.2620 },
  { type: 'node', id: 24, lat: 40.7400, lon: -74.2600 },
  { type: 'node', id: 25, lat: 40.74014, lon: -74.2600 },
  { type: 'node', id: 26, lat: 40.7403, lon: -74.2600 },
  { type: 'node', id: 27, lat: 40.7400, lon: -74.2580 },
  { type: 'node', id: 28, lat: 40.74008, lon: -74.26001, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 29, lat: 40.74011, lon: -74.25999, tags: { crossing: 'marked' } },
  { type: 'way', id: 301, nodes: [21, 24, 27], tags: { highway: 'residential', name: 'Low St' } },
  { type: 'way', id: 302, nodes: [24, 25, 26], tags: { highway: 'residential', name: 'Up Ave' } },
] } as any;

test('signal and crossing tags assign to exactly one nearest node', () => {
  const { graph } = buildGraph(SIG);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const signalled = graph.nodes.filter((n) => n.signal).map((n) => n.id);
  assert.deepEqual(signalled, ['25']); // nearest only — node 24 must NOT be marked
  const crossed = graph.nodes.filter((n) => n.crossing !== null).map((n) => n.id);
  assert.deepEqual(crossed, ['25']); // crossing node 29 is ~4 m from 25, ~13 m from 24; 10 m cap excludes 24 anyway
  assert.equal(byId.get('25')!.crossing, 'marked');
});
```

(Node 25 is a graph node because it's interior to way 302 — verify with the fixture that it survives as an intersection/endpoint; it is `24,25,26`'s interior node used once, so make it shared: if the built graph drops it, add `{ type: 'way', id: 303, nodes: [25, 27], tags: { highway: 'service' } }` to force it to intersection status and adjust expectations — the implementer verifies which nodes materialize and pins the test to real geometry, keeping the essential assertions: exactly one signalled node, and it is the nearest.)

- [ ] **Step 2: Run test to verify failure**

Run: `npm test` — fails: both 24 and 25 (old radius logic) carry the signal.

- [ ] **Step 3: Implement**

In `engine/build/build-graph.ts`, replace the per-node radius scan (`const signal = signals.some(...)`, `const cx = crossings.find(...)`) with post-construction nearest-only assignment. Build `nodes` first with `signal: false, crossing: null`, then:

```ts
  // Nearest-node single assignment (spec 2026-08-13): each tagged OSM node marks
  // exactly one graph node. The previous 20 m any-node radius spilled onto
  // neighbors (48% of graph nodes have another within 20 m), systematically
  // over-discounting crossings; raw-vs-associated counts stay in the report.
  const SIGNAL_ASSIGN_M = 20;
  const CROSSING_ASSIGN_M = 10;
  const nearestGraphNode = (lat: number, lon: number): { node: GraphNode; d: number } | null => {
    let best: GraphNode | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = haversineM(lat, lon, n.lat, n.lon);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { node: best, d: bestD } : null;
  };
  for (const s of signals) {
    const hit = nearestGraphNode(s.lat, s.lon);
    if (hit && hit.d <= SIGNAL_ASSIGN_M) hit.node.signal = true;
  }
  const crossingDist = new Map<string, number>();
  for (const c of crossings) {
    const hit = nearestGraphNode(c.lat, c.lon);
    if (!hit || hit.d > CROSSING_ASSIGN_M) continue;
    const prev = crossingDist.get(hit.node.id);
    if (prev === undefined || hit.d < prev) {
      crossingDist.set(hit.node.id, hit.d);
      hit.node.crossing = c.tags?.crossing ?? null;
    }
  }
```

Keep `signalNodesRaw`/`crossingRaw` exactly as they are. Update the old radius-spill comment to describe the new policy (it is no longer a KNOWN gap).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all pass, including Task 5/6's originals (their fixture signal sits exactly on node 5 — nearest-only still marks it). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add engine/build/build-graph.ts engine/tests/build-graph.test.ts
git commit -m "fix(engine): nearest-node single assignment for signal and crossing tags"
```

---

### Task 3: Duplicate risk across intersection complexes

**Files:**
- Modify: `engine/src/risk.ts` (add `complexOf?: string`), `engine/build/snap-risk.ts`
- Test: `engine/tests/snap-risk.test.ts`

**Interfaces:**
- Produces: `NodeRisk.complexOf?: string` (absent on primaries); `SnapReport.complexMembers: number`; duplication rule: graph nodes within 20 m of a primary risk node sharing ≥1 incident `roadKey`, full payload copied, existing entries never overwritten. `roadKey` imported from `../src/graph.js`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/snap-risk.test.ts` (extend the existing fixture graph with a same-street neighbor and a different-street neighbor):

```ts
const complexGraph = loadGraph({
  nodes: [
    { id: 'A', lat: 40.7400, lon: -74.2600, signal: false, crossing: null },
    { id: 'B', lat: 40.74013, lon: -74.2600, signal: false, crossing: null }, // ~14 m from A, same street
    { id: 'C', lat: 40.7400, lon: -74.26017, signal: false, crossing: null }, // ~14 m from A, different street
  ],
  edges: [
    { from: 'A', to: 'B', wayId: '1', name: 'Test St', highway: 'residential', lengthM: 14, lts: 2, ltsReasons: [], steps: false, geometry: [[40.74, -74.26], [40.74013, -74.26]] },
    { from: 'A', to: 'C', wayId: '2', name: 'Cross Ave', highway: 'residential', lengthM: 14, lts: 2, ltsReasons: [], steps: false, geometry: [[40.74, -74.26], [40.74, -74.26017]] },
  ],
});

test('risk duplicates onto same-road complex members only', () => {
  const hs = [{ cluster: 0, lat: 40.74001, lon: -74.26, n: 5, stress: 20, injury_n: 1, vru_n: 0, location: 'TEST ST', cross: 'CROSS AVE' }];
  const { risk, report } = snapRisk(complexGraph, hs, [], new Map());
  const byNode = new Map(risk.map((r) => [r.nodeId, r]));
  const primary = byNode.get('A')!;
  assert.equal(primary.complexOf, undefined);
  const member = byNode.get('B')!;           // B shares 'Test St' with A → duplicated
  assert.equal(member.complexOf, 'A');
  assert.equal(member.stress, 20);           // full payload, not split
  // C shares 'Cross Ave' with A — also a member. Both B and C qualify here;
  // the different-street NEGATIVE case needs a node with NO shared roadKey:
  assert.equal(report.complexMembers, 2);
});

test('complex duplication never overwrites a node\'s own cluster risk', () => {
  const hs = [
    { cluster: 0, lat: 40.74001, lon: -74.26, n: 5, stress: 20, injury_n: 1, vru_n: 0, location: 'TEST ST', cross: 'CROSS AVE' },
    { cluster: 1, lat: 40.74014, lon: -74.26, n: 2, stress: 7, injury_n: 0, vru_n: 0, location: 'TEST ST', cross: 'UPPER' },
  ];
  const { risk } = snapRisk(complexGraph, hs, [], new Map());
  const b = risk.find((r) => r.nodeId === 'B')!;
  assert.equal(b.complexOf, undefined);      // B's own cluster 1 wins
  assert.equal(b.stress, 7);
});
```

Note on the first test: with this 3-node graph every neighbor shares a road with A, so the negative case (no shared roadKey → no duplication) is covered by adding a fourth node `D` at `40.74013, -74.26017` (~20 m diagonal) connected only to `B` via a way named `'Far St'` (`from: 'B', to: 'D'`): D is within 20 m of A but shares no roadKey with A — assert `byNode.has('D') === false` and adjust `complexMembers` accordingly. The implementer works out the exact haversine distances and pins assertions to them.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test` — fails: no `complexOf` field, `complexMembers` undefined.

- [ ] **Step 3: Implement**

`engine/src/risk.ts`: add `complexOf?: string;` to `NodeRisk` (doc comment: present on intersection-complex duplicates, names the primary node). `engine/build/snap-risk.ts`: add `complexMembers: number` to `SnapReport` (init 0); import `roadKey` from `../src/graph.js`; after the primary snapping loop:

```ts
  // Intersection-complex spread (spec 2026-08-13): a cluster snapped to one node
  // of a multi-node intersection (dual carriageways, split signals) was invisible
  // to routes traversing a sibling node 10–20 m away — the V1 assert-2 finding.
  // Duplicate the full payload onto nearby same-road nodes; a walker traverses
  // one member, so full (not split) risk per member is the physical reading.
  const keysAt = (nodeId: string): Set<string> => {
    const out = new Set<string>();
    for (const idx of graph.adj.get(nodeId) ?? []) out.add(roadKey(graph.edges[idx]));
    return out;
  };
  const COMPLEX_RADIUS_M = 20;
  for (const primary of [...byNode.values()]) {
    if (primary.complexOf) continue;
    const pNode = graph.nodes.get(primary.nodeId)!;
    const pKeys = keysAt(primary.nodeId);
    for (const node of graph.nodes.values()) {
      if (node.id === primary.nodeId || byNode.has(node.id)) continue; // own risk always wins
      if (haversineM(pNode.lat, pNode.lon, node.lat, node.lon) > COMPLEX_RADIUS_M) continue;
      if (![...keysAt(node.id)].some((k) => pKeys.has(k))) continue;
      byNode.set(node.id, {
        ...primary,
        nodeId: node.id,
        complexOf: primary.nodeId,
        causeDistribution: { ...primary.causeDistribution },
        clusterIds: [...primary.clusterIds],
      });
      report.complexMembers++;
    }
  }
```

(Iterate `[...byNode.values()]` — a snapshot — so freshly added members are not re-expanded; the `primary.complexOf` guard is belt-and-braces.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test` → all pass (existing snap-risk tests unaffected: their graphs' nodes are >20 m apart except merge-test clusters, which snap to the same node and are `byNode.has` guarded). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add engine/src/risk.ts engine/build/snap-risk.ts engine/tests/snap-risk.test.ts
git commit -m "fix(engine): duplicate cluster risk across intersection complexes"
```

---

### Task 4: Regenerate artifacts, re-run validation, update docs to match reality

**Files:**
- Modify: `engine/artifacts/*` (regenerated), `engine/build/validate.ts` (breadcrumb), `README.md` (λ bullet + validate note)

- [ ] **Step 1: Rebuild and test**

Run: `npm run build-engine` — read the report: `signalNodes` should drop to ≈66–74, `complexMembers` > 0, `riskNodes` grows by the member count, connectivity/join floors unchanged. Then `npm test` (the real-graph integration test runs against the new artifacts — decomposition must still close).

- [ ] **Step 2: Run the harness**

Run: `npm run validate` — capture full output. Expected: exposure at λ≥2 now drops below λ=0 and **assert-2 passes** (exit 0). The λ table will shift (service crossings no longer charged; signal discounts rarer) — distance/stress monotonicity must still hold.

**If assert-2 still fails:** stop, do not tune. Report DONE_WITH_CONCERNS with the table and which hotspots remain within 30 m of the high-λ route — that is the next diagnosis, not a failure of this task.

- [ ] **Step 3: Update the two breadcrumbs to match the new reality (only if assert-2 passed)**

- `engine/build/validate.ts`: replace the KNOWN FAILURE block above assert-2 with a short comment: resolved 2026-08-13 by the intersection-complex risk spread + service-crossing exclusion (STC-152 rework); assert kept as the regression gate.
- `README.md`: update the λ bullet — higher λ now trades distance for lower structural stress *and validated crash-cluster avoidance*; update the `npm run validate` note (no longer exits 1; it is the acceptance gate). Remove the driveway-overcharge caveat sentence.

- [ ] **Step 4: Commit (artifacts + docs, harness output in the body)**

```bash
git add engine/artifacts/ engine/build/validate.ts README.md
git commit -m "feat(engine): regenerated artifacts — hotspot-exposure validation now passes"
```

(Include the full harness output in the commit message body.)

---

## Self-Review

1. **Spec coverage:** service exclusion → Task 1; nearest-only association → Task 2; complex duplication + contract fields → Task 3; acceptance (artifacts, assert-2, breadcrumb/README updates, still-fails-protocol) → Task 4. Covered.
2. **Placeholders:** none; the two fixture-geometry notes explicitly delegate distance-pinning to the implementer with the essential assertions named — deliberate, since hand-computed haversines in a plan invite copy-paste errors.
3. **Type consistency:** `complexOf?` optional keeps risk.json backward-compatible with `explainRoute` (reads via `r?.`); `SnapReport.complexMembers` is additive; `roadKey` import direction (build → src) is allowed.
