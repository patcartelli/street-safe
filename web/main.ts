/**
 * Street Safe — browser entry point.
 *
 * Wires the existing demo DOM (index.html) to the real routing engine
 * (engine/src). Replaces the old OSRM/mock-crash prototype (app.js,
 * data/mock-crashes.js — deleted by this change) with the real graph +
 * risk surface built by `npm run build-engine`.
 *
 * Honest limits (see README): walking time is a flat-pace estimate
 * (minutesAt80), not a real duration model. Elevation is not factored in.
 */

import type { Graph, GraphNode, SerializedGraph } from '../engine/src/graph.js';
import { loadGraph, nearestNode } from '../engine/src/graph.js';
import type { RawRoute } from '../engine/src/router.js';
import { route } from '../engine/src/router.js';
import type { RouteResult } from '../engine/src/explain.js';
import { explainRoute } from '../engine/src/explain.js';
import type { NodeRisk, RiskSurface } from '../engine/src/risk.js';
import { DESTINATIONS } from './destinations.js';
import { avoidedComplexes, dedupeFlagged, minutesAt80 } from './helpers.js';

declare const L: any;

const GRAPH_URL = 'engine/artifacts/graph.json';
const RISK_URL = 'engine/artifacts/risk.json';
const DEFAULT_START_ID = 'station';
const DEFAULT_END_ID = 'south-mountain-elem';
const SAFEST_LAMBDA = 2;
const FASTEST_LAMBDA = 0;

// Module state, populated by init() once artifacts resolve.
let graph: Graph;
let risk: Map<string, NodeRisk>;
let complexOfByNode: Map<string, string>;
let destNodeById: Map<string, GraphNode>;
let map: any;
let routeLayers: any[] = [];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function sameEdgeSequence(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function riskClassForLts(lts: number): string {
  if (lts >= 4) return 'risk-high';
  if (lts === 3) return 'risk-med';
  return 'risk-low';
}

function populateSelects(startSel: HTMLSelectElement, endSel: HTMLSelectElement): void {
  for (const d of DESTINATIONS) {
    const opt1 = document.createElement('option');
    opt1.value = d.id;
    opt1.textContent = d.label;
    startSel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = d.id;
    opt2.textContent = d.label;
    endSel.appendChild(opt2);
  }
  startSel.value = DEFAULT_START_ID;
  endSel.value = DEFAULT_END_ID;
}

function initMap(): void {
  const latSum = DESTINATIONS.reduce((s, d) => s + d.lat, 0);
  const lonSum = DESTINATIONS.reduce((s, d) => s + d.lon, 0);
  const center: [number, number] = [latSum / DESTINATIONS.length, lonSum / DESTINATIONS.length];

  map = L.map('map', { zoomControl: true }).setView(center, 15);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

/** One circle marker per primary risk node (complexOf entries are duplicates
 *  of a primary and are skipped so the same physical intersection isn't
 *  drawn twice). Radius scales with log1p(stress); tooltip carries the real
 *  name/crash count/dominant cause instead of the old mock label. */
function drawRiskMarkers(riskSurface: RiskSurface): void {
  for (const r of riskSurface) {
    if (r.complexOf) continue;
    const node = graph.nodes.get(r.nodeId);
    if (!node) continue;
    const radius = 4 + 3 * Math.log1p(r.stress);
    L.circleMarker([node.lat, node.lon], {
      radius,
      color: '#E4572E',
      weight: 1,
      fillColor: '#E4572E',
      fillOpacity: 0.35,
    })
      .addTo(map)
      .bindTooltip(
        `${r.name} — ${r.crashN} crash${r.crashN === 1 ? '' : 'es'} — ${r.dominantCause ?? 'cause unknown'}`,
        { direction: 'top' },
      );
  }
}

function showFetchError(message: string): void {
  const emptyEl = el<HTMLDivElement>('readout-empty');
  emptyEl.innerHTML = '';

  const p = document.createElement('p');
  p.textContent = 'Could not load the street network.';
  emptyEl.appendChild(p);

  const sub = document.createElement('p');
  sub.className = 'readout-empty-sub';
  sub.style.color = '#E4572E';
  sub.textContent = message;
  emptyEl.appendChild(sub);
}

/** Resets to the empty state with a visible message, whether this is the
 *  first click (readout-content still hidden) or a later failure after a
 *  prior successful route (readout-content visible with stale lines/lists
 *  that must not linger). */
function showNoRoute(): void {
  routeLayers.forEach((l) => map.removeLayer(l));
  routeLayers = [];

  el<HTMLDivElement>('readout-content').classList.add('hidden');

  const emptyEl = el<HTMLDivElement>('readout-empty');
  emptyEl.classList.remove('hidden');
  emptyEl.innerHTML = '';

  const p = document.createElement('p');
  p.textContent = 'No route could be found between these two points.';
  emptyEl.appendChild(p);
}

function drawRouteLines(safeRaw: RawRoute, fastRaw: RawRoute): void {
  routeLayers.forEach((l) => map.removeLayer(l));
  routeLayers = [];

  if (!sameEdgeSequence(safeRaw.edgeIdxs, fastRaw.edgeIdxs)) {
    const fastLine = L.polyline(fastRaw.geometry, {
      color: '#8A94A6',
      weight: 3,
      dashArray: '6 6',
      opacity: 0.7,
    }).addTo(map);
    routeLayers.push(fastLine);
  }

  const safeLine = L.polyline(safeRaw.geometry, { color: '#3FA796', weight: 5 }).addTo(map);
  routeLayers.push(safeLine);
  map.fitBounds(safeLine.getBounds(), { padding: [40, 40] });
}

function renderRiskStrip(strip: HTMLElement, safeRaw: RawRoute): void {
  strip.innerHTML = '';
  for (const idx of safeRaw.edgeIdxs) {
    const e = graph.edges[idx];
    const seg = document.createElement('div');
    seg.className = `risk-seg ${riskClassForLts(e.lts)}`;
    seg.style.flexGrow = String(Math.max(e.lengthM, 0.001));
    strip.appendChild(seg);
  }
}

function renderWhyList(list: HTMLElement, safe: RouteResult, fast: RouteResult): void {
  list.innerHTML = '';
  const items: string[] = [];

  const deltaM = Math.round(safe.distance_m - fast.distance_m);
  const safeMin = minutesAt80(safe.distance_m);
  const fastMin = minutesAt80(fast.distance_m);
  if (deltaM > 0) {
    items.push(
      `${deltaM} m longer than the fastest route (≈${safeMin} min vs ≈${fastMin} min, assuming an 80 m/min walking pace).`,
    );
  } else if (deltaM < 0) {
    items.push(
      `${Math.abs(deltaM)} m shorter than the fastest route (≈${safeMin} min vs ≈${fastMin} min, assuming an 80 m/min walking pace).`,
    );
  } else {
    items.push(`Same distance as the fastest route (≈${safeMin} min, assuming an 80 m/min walking pace).`);
  }

  const avoided = avoidedComplexes(fast.flagged_nodes, safe.flagged_nodes, complexOfByNode);
  items.push(
    avoided > 0
      ? `Avoids ${avoided} flagged intersection${avoided === 1 ? '' : 's'} that the fastest route passes through.`
      : `No flagged intersections avoided vs. the fastest route — both pass similar exposure.`,
  );

  items.push(
    `Added stress cost: ${Math.round(safe.stress_cost_m)} m-equivalent (lower is safer — weighted for crossing difficulty and crash history).`,
  );

  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

function renderTradeoff(textEl: HTMLElement, safeRaw: RawRoute, fastRaw: RawRoute, safe: RouteResult, fast: RouteResult): void {
  if (sameEdgeSequence(safeRaw.edgeIdxs, fastRaw.edgeIdxs)) {
    textEl.textContent = 'The safest route and the fastest route are the same here — no tradeoff to make.';
    return;
  }
  const safeMin = minutesAt80(safe.distance_m);
  const fastMin = minutesAt80(fast.distance_m);
  const extraMin = safeMin - fastMin;
  if (extraMin <= 0) {
    textEl.textContent =
      'This route is also about as fast as the fastest option — no meaningful time tradeoff, and it avoids more flagged exposure.';
  } else {
    textEl.textContent = `${extraMin} minute${extraMin === 1 ? '' : 's'} longer than the fastest option (≈${safeMin} min vs ≈${fastMin} min, assuming an 80 m/min walking pace).`;
  }
}

function renderHazardList(list: HTMLElement, safe: RouteResult): void {
  list.innerHTML = '';
  const flagged = dedupeFlagged(safe.flagged_nodes, complexOfByNode);

  if (flagged.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'None flagged along this route.';
    list.appendChild(li);
    return;
  }

  for (const f of flagged) {
    const li = document.createElement('li');

    const strong = document.createElement('strong');
    strong.textContent = f.name;
    li.appendChild(strong);
    li.appendChild(document.createElement('br'));

    const note = document.createElement('span');
    note.className = 'hazard-note';
    const cause = f.dominantCause ?? 'no dominant cause on record';
    const crossing = f.crossingPenaltyM > 0 ? ` · crossing penalty ${Math.round(f.crossingPenaltyM)} m` : '';
    note.textContent = `${cause} — ${f.crashN} crash${f.crashN === 1 ? '' : 'es'} on record${crossing}`;
    li.appendChild(note);

    list.appendChild(li);
  }
}

function findRoute(): void {
  const startSel = el<HTMLSelectElement>('start-select');
  const endSel = el<HTMLSelectElement>('end-select');
  const startId = startSel.value;
  const endId = endSel.value;

  if (startId === endId) {
    alert('Pick two different locations.');
    return;
  }

  const originNode = destNodeById.get(startId);
  const destNode = destNodeById.get(endId);
  if (!originNode || !destNode) return;

  const safeRaw = route(graph, risk, originNode.id, destNode.id, SAFEST_LAMBDA);
  const fastRaw = route(graph, risk, originNode.id, destNode.id, FASTEST_LAMBDA);

  if (!safeRaw || !fastRaw) {
    showNoRoute();
    return;
  }

  const safe = explainRoute(graph, risk, safeRaw, SAFEST_LAMBDA);
  const fast = explainRoute(graph, risk, fastRaw, FASTEST_LAMBDA);

  el<HTMLDivElement>('readout-empty').classList.add('hidden');
  el<HTMLDivElement>('readout-content').classList.remove('hidden');

  drawRouteLines(safeRaw, fastRaw);
  renderRiskStrip(el<HTMLDivElement>('risk-strip'), safeRaw);
  renderWhyList(el<HTMLUListElement>('why-list'), safe, fast);
  renderTradeoff(el<HTMLParagraphElement>('tradeoff-text'), safeRaw, fastRaw, safe, fast);
  renderHazardList(el<HTMLUListElement>('hazard-list'), safe);
}

async function init(): Promise<void> {
  const btn = el<HTMLButtonElement>('route-btn');
  const startSel = el<HTMLSelectElement>('start-select');
  const endSel = el<HTMLSelectElement>('end-select');

  btn.disabled = true;
  btn.textContent = 'Loading street network…';
  populateSelects(startSel, endSel);
  initMap();

  let graphData: SerializedGraph;
  let riskData: RiskSurface;
  try {
    const [graphRes, riskRes] = await Promise.all([fetch(GRAPH_URL), fetch(RISK_URL)]);
    if (!graphRes.ok || !riskRes.ok) {
      throw new Error(`fetch failed (graph ${graphRes.status}, risk ${riskRes.status})`);
    }
    [graphData, riskData] = await Promise.all([graphRes.json(), riskRes.json()]);
  } catch (err) {
    btn.textContent = 'Street network unavailable';
    showFetchError(
      `Could not fetch the street network or risk data (${err instanceof Error ? err.message : String(err)}). ` +
        `Check your connection and reload.`,
    );
    return;
  }

  graph = loadGraph(graphData);
  risk = new Map(riskData.map((r) => [r.nodeId, r]));
  complexOfByNode = new Map(riskData.map((r) => [r.nodeId, r.complexOf ?? r.nodeId]));
  destNodeById = new Map(DESTINATIONS.map((d) => [d.id, nearestNode(graph, d.lat, d.lon)]));

  drawRiskMarkers(riskData);

  btn.disabled = false;
  btn.textContent = 'Find safe route';
  btn.addEventListener('click', findRoute);
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error(err);
    showFetchError('Something went wrong loading the demo. Reload to try again.');
  });
});
