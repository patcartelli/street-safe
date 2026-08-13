import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadGraph, nearestNode, type SerializedGraph } from '../src/graph.js';
import { route } from '../src/router.js';
import { explainRoute } from '../src/explain.js';
import type { NodeRisk } from '../src/risk.js';
import { VALIDATION_PAIR } from '../build/validation-pair.js';

/** Exercises the real, committed artifacts end to end (not a synthetic fixture): loads
 *  engine/artifacts/graph.json + risk.json, routes the validation harness's fixed
 *  station-to-school pair at λ=1, and checks the route + cost decomposition are sound. */
const ART = fileURLToPath(new URL('../artifacts/', import.meta.url));

test('real-graph integration: route + decomposition close over committed artifacts', () => {
  const graph: SerializedGraph = JSON.parse(readFileSync(join(ART, 'graph.json'), 'utf8'));
  const riskArr: NodeRisk[] = JSON.parse(readFileSync(join(ART, 'risk.json'), 'utf8'));
  const risk = new Map(riskArr.map((r) => [r.nodeId, r]));

  const g = loadGraph(graph);
  const o = nearestNode(g, VALIDATION_PAIR.from.lat, VALIDATION_PAIR.from.lon);
  const d = nearestNode(g, VALIDATION_PAIR.to.lat, VALIDATION_PAIR.to.lon);

  const r = route(g, risk, o.id, d.id, 1);
  assert.ok(r !== null, 'expected a route between the validation pair at λ=1');
  assert.ok(r!.distanceM > 0);
  assert.ok(r!.geometry.length > 10);

  const explained = explainRoute(g, risk, r!, 1);
  const segTotal = explained.segments.reduce((s, seg) => s + seg.stress_contribution_m, 0);
  const crossingTotal = r!.moves.reduce((s, m) => s + m.crossingPenaltyM, 0);
  assert.ok(
    Math.abs(segTotal + crossingTotal - r!.stressCostM) < 1e-6,
    `decomposition did not close: segments ${segTotal} + crossings ${crossingTotal} vs stressCostM ${r!.stressCostM}`,
  );
});
