"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // engine/src/geo.ts
  var R = 6371e3;
  var toRad = (d) => d * Math.PI / 180;
  function haversineM(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // engine/src/graph.ts
  function loadGraph(g) {
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    const adj = /* @__PURE__ */ new Map();
    g.edges.forEach((e, i) => {
      for (const id of [e.from, e.to]) {
        if (!adj.has(id)) adj.set(id, []);
        adj.get(id).push(i);
      }
    });
    return { nodes, edges: g.edges, adj };
  }
  function nearestNode(g, lat, lon) {
    let best = null;
    let bestD = Infinity;
    for (const n of g.nodes.values()) {
      const d = haversineM(lat, lon, n.lat, n.lon);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (!best) throw new Error("empty graph");
    return best;
  }
  function roadKey(e) {
    return e.name ?? `way:${e.wayId}`;
  }

  // engine/src/lts.ts
  function crossingLts(maxCrossedLts, signal, crossing) {
    let lts = maxCrossedLts;
    if (signal || crossing === "traffic_signals") lts -= 1;
    else if (crossing === "marked" || crossing === "zebra" || crossing === "uncontrolled") lts -= 0.5;
    return Math.min(4, Math.max(1, lts));
  }

  // engine/src/stress.ts
  var BASE_PENALTY_M = 25;
  var K = 1 / Math.log1p(42);
  function crashBumpM(clusterStress) {
    return Math.min(BASE_PENALTY_M, BASE_PENALTY_M * K * Math.log1p(clusterStress));
  }
  function crossingPenaltyM(maxCrossedLts, signal, crossing, bumpM) {
    return BASE_PENALTY_M * (crossingLts(maxCrossedLts, signal, crossing) - 1) + bumpM;
  }

  // engine/src/router.ts
  var Heap = class {
    constructor() {
      __publicField(this, "a", []);
    }
    get size() {
      return this.a.length;
    }
    push(p, v) {
      const a = this.a;
      a.push([p, v]);
      let i = a.length - 1;
      while (i > 0) {
        const par = i - 1 >> 1;
        if (a[par][0] <= a[i][0]) break;
        [a[par], a[i]] = [a[i], a[par]];
        i = par;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (; ; ) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  };
  var head = (e, fwd) => fwd ? e.to : e.from;
  var tail = (e, fwd) => fwd ? e.from : e.to;
  function crossingAt(graph2, nodeId, excludeKeys) {
    let maxLts = 0;
    let crossedRoad = null;
    for (const idx of graph2.adj.get(nodeId) ?? []) {
      const e = graph2.edges[idx];
      if (e.highway === "service") continue;
      const key = roadKey(e);
      if (excludeKeys.has(key)) continue;
      if (e.lts > maxLts) {
        maxLts = e.lts;
        crossedRoad = e.name ?? key;
      }
    }
    return { maxLts, crossedRoad };
  }
  function route(graph2, risk2, originNodeId, destNodeId, lambda) {
    if (lambda < 0) throw new Error("lambda must be >= 0");
    if (originNodeId === destNodeId) {
      return { nodeIds: [originNodeId], edgeIdxs: [], distanceM: 0, stressCostM: 0, moves: [], geometry: [] };
    }
    const E = graph2.edges.length;
    const dest = graph2.nodes.get(destNodeId);
    const bump = (nodeId) => crashBumpM(risk2.get(nodeId)?.stress ?? 0);
    const segCost = (e) => e.lengthM * (1 + lambda * (e.lts - 1) / 3);
    const h = (nodeId) => {
      const n = graph2.nodes.get(nodeId);
      return haversineM(n.lat, n.lon, dest.lat, dest.lon);
    };
    const g = new Float64Array(2 * E).fill(Infinity);
    const cameFrom = new Int32Array(2 * E).fill(-1);
    const detail = new Array(2 * E).fill(null);
    const open = new Heap();
    for (const idx of graph2.adj.get(originNodeId) ?? []) {
      const e = graph2.edges[idx];
      const fwd = e.from === originNodeId;
      const d = idx * 2 + (fwd ? 0 : 1);
      const hd = head(e, fwd);
      const bumpHalf = lambda * 0.5 * bump(hd);
      const cost = segCost(e) + bumpHalf;
      if (cost < g[d]) {
        g[d] = cost;
        detail[d] = {
          edgeIdx: idx,
          nodeId: "",
          segPenaltyM: segCost(e) - e.lengthM,
          crossingPenaltyM: 0,
          crossedRoad: null,
          nodeBumpM: 0,
          bumpHalfM: bumpHalf
        };
        open.push(cost + h(hd), d);
      }
    }
    let goal = -1;
    const closed = new Uint8Array(2 * E);
    while (open.size) {
      const [, d] = open.pop();
      if (closed[d]) continue;
      closed[d] = 1;
      const e = graph2.edges[d >> 1];
      const fwd = (d & 1) === 0;
      const v = head(e, fwd);
      if (v === destNodeId) {
        goal = d;
        break;
      }
      const inKey = roadKey(e);
      for (const outIdx of graph2.adj.get(v) ?? []) {
        if (outIdx === d >> 1) continue;
        const oe = graph2.edges[outIdx];
        const ofwd = oe.from === v;
        if (tail(oe, ofwd) !== v) continue;
        const od = outIdx * 2 + (ofwd ? 0 : 1);
        if (closed[od]) continue;
        const exclude = /* @__PURE__ */ new Set([inKey, roadKey(oe)]);
        const { maxLts, crossedRoad } = crossingAt(graph2, v, exclude);
        const vNode = graph2.nodes.get(v);
        const pureCrossing = maxLts > 0 ? crossingPenaltyM(maxLts, vNode.signal, vNode.crossing, 0) : 0;
        const nodeBump = lambda * 0.5 * bump(v);
        const hd = head(oe, ofwd);
        const bumpHalf = lambda * 0.5 * bump(hd);
        const cost = g[d] + segCost(oe) + lambda * pureCrossing + nodeBump + bumpHalf;
        if (cost < g[od]) {
          g[od] = cost;
          cameFrom[od] = d;
          detail[od] = {
            edgeIdx: outIdx,
            nodeId: v,
            segPenaltyM: segCost(oe) - oe.lengthM,
            crossingPenaltyM: lambda * pureCrossing,
            crossedRoad,
            nodeBumpM: nodeBump,
            bumpHalfM: bumpHalf
          };
          open.push(cost + h(hd), od);
        }
      }
    }
    if (goal === -1) return null;
    const moves = [];
    const edgeIdxs = [];
    const dirs = [];
    for (let d = goal; d !== -1; d = cameFrom[d]) {
      moves.unshift(detail[d]);
      edgeIdxs.unshift(d >> 1);
      dirs.unshift((d & 1) === 0);
    }
    const nodeIds = [tail(graph2.edges[edgeIdxs[0]], dirs[0])];
    const geometry = [];
    edgeIdxs.forEach((idx, i) => {
      const e = graph2.edges[idx];
      nodeIds.push(head(e, dirs[i]));
      const geo = dirs[i] ? e.geometry : [...e.geometry].reverse();
      geometry.push(...i === 0 ? geo : geo.slice(1));
    });
    const distanceM = edgeIdxs.reduce((s, idx) => s + graph2.edges[idx].lengthM, 0);
    return { nodeIds, edgeIdxs, distanceM, stressCostM: g[goal] - distanceM, moves, geometry };
  }

  // engine/src/explain.ts
  function explainRoute(graph2, risk2, raw, lambda) {
    const segments = [];
    for (let i = 0; i < raw.edgeIdxs.length; i++) {
      const e = graph2.edges[raw.edgeIdxs[i]];
      const move = raw.moves[i];
      const contribution = move.segPenaltyM + move.bumpHalfM + move.nodeBumpM;
      const prev = segments[segments.length - 1];
      if (prev && prev.way_name === e.name) {
        prev.length_m += e.lengthM;
        prev.stress_contribution_m += contribution;
        if (e.lts > prev.lts) {
          prev.lts = e.lts;
          prev.lts_reasons = e.ltsReasons;
        }
      } else {
        segments.push({
          way_name: e.name,
          length_m: e.lengthM,
          lts: e.lts,
          stress_contribution_m: contribution,
          lts_reasons: e.ltsReasons
        });
      }
    }
    const flagged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const move of raw.moves) {
      if (!move.nodeId || seen.has(move.nodeId)) continue;
      const r = risk2.get(move.nodeId);
      const bigCrossing = lambda > 0 && move.crossingPenaltyM >= lambda * BASE_PENALTY_M;
      if (!r && !bigCrossing) continue;
      seen.add(move.nodeId);
      const node = graph2.nodes.get(move.nodeId);
      flagged.push({
        node_id: move.nodeId,
        name: r?.name ?? `${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}`,
        crossing_penalty_m: move.crossingPenaltyM,
        crossed_way: move.crossedRoad,
        crash_n: r?.crashN ?? 0,
        dominant_cause: r?.dominantCause ?? null,
        cause_distribution: r?.causeDistribution ?? {}
      });
    }
    return {
      lambda,
      distance_m: raw.distanceM,
      stress_cost_m: raw.stressCostM,
      segments,
      flagged_nodes: flagged
    };
  }

  // web/destinations.ts
  var DESTINATIONS = [
    { id: "station", label: "Station", lat: 40.7459, lon: -74.2602 },
    { id: "south-mountain-elem", label: "South Mountain Elementary", lat: 40.7472, lon: -74.276 },
    { id: "library", label: "Library (Scotland Rd)", lat: 40.7495, lon: -74.256 },
    { id: "sopac", label: "SOPAC", lat: 40.7464, lon: -74.261 },
    { id: "meadowland-park", label: "Meadowland Park / Flood's Hill", lat: 40.7452, lon: -74.2555 },
    { id: "village-hall", label: "Village Hall", lat: 40.7488, lon: -74.2565 },
    { id: "marshall-elem", label: "Marshall Elementary (Grove Rd)", lat: 40.7418, lon: -74.251 },
    { id: "grove-park", label: "Grove Park", lat: 40.742, lon: -74.257 }
  ];

  // web/helpers.ts
  var groupKey = (nodeId, cx) => cx.get(nodeId) ?? nodeId;
  function dedupeFlagged(flagged, complexOfByNode2) {
    const best = /* @__PURE__ */ new Map();
    for (const fl of flagged) {
      const key = groupKey(fl.node_id, complexOfByNode2);
      const prev = best.get(key);
      if (!prev || fl.crash_n > prev.crash_n) best.set(key, fl);
    }
    return [...best.values()].map((fl) => ({
      name: fl.name,
      dominantCause: fl.dominant_cause,
      crashN: fl.crash_n,
      crossingPenaltyM: fl.crossing_penalty_m
    }));
  }
  function minutesAt80(distanceM) {
    return Math.round(distanceM / 80);
  }
  function avoidedComplexes(fast, safe, complexOfByNode2) {
    const safeKeys = new Set(safe.map((fl) => groupKey(fl.node_id, complexOfByNode2)));
    const fastKeys = new Set(fast.map((fl) => groupKey(fl.node_id, complexOfByNode2)));
    return [...fastKeys].filter((k) => !safeKeys.has(k)).length;
  }

  // web/main.ts
  var GRAPH_URL = "engine/artifacts/graph.json";
  var RISK_URL = "engine/artifacts/risk.json";
  var DEFAULT_START_ID = "station";
  var DEFAULT_END_ID = "south-mountain-elem";
  var SAFEST_LAMBDA = 2;
  var FASTEST_LAMBDA = 0;
  var graph;
  var risk;
  var complexOfByNode;
  var destNodeById;
  var map;
  var routeLayers = [];
  function el(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  }
  function sameEdgeSequence(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  function riskClassForLts(lts) {
    if (lts >= 4) return "risk-high";
    if (lts === 3) return "risk-med";
    return "risk-low";
  }
  function populateSelects(startSel, endSel) {
    for (const d of DESTINATIONS) {
      const opt1 = document.createElement("option");
      opt1.value = d.id;
      opt1.textContent = d.label;
      startSel.appendChild(opt1);
      const opt2 = document.createElement("option");
      opt2.value = d.id;
      opt2.textContent = d.label;
      endSel.appendChild(opt2);
    }
    startSel.value = DEFAULT_START_ID;
    endSel.value = DEFAULT_END_ID;
  }
  function initMap() {
    const latSum = DESTINATIONS.reduce((s, d) => s + d.lat, 0);
    const lonSum = DESTINATIONS.reduce((s, d) => s + d.lon, 0);
    const center = [latSum / DESTINATIONS.length, lonSum / DESTINATIONS.length];
    map = L.map("map", { zoomControl: true }).setView(center, 15);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19
    }).addTo(map);
  }
  function drawRiskMarkers(riskSurface) {
    for (const r of riskSurface) {
      if (r.complexOf) continue;
      const node = graph.nodes.get(r.nodeId);
      if (!node) continue;
      const radius = 4 + 3 * Math.log1p(r.stress);
      L.circleMarker([node.lat, node.lon], {
        radius,
        color: "#E4572E",
        weight: 1,
        fillColor: "#E4572E",
        fillOpacity: 0.35
      }).addTo(map).bindTooltip(
        `${r.name} \u2014 ${r.crashN} crash${r.crashN === 1 ? "" : "es"} \u2014 ${r.dominantCause ?? "cause unknown"}`,
        { direction: "top" }
      );
    }
  }
  function showFetchError(message) {
    const emptyEl = el("readout-empty");
    emptyEl.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = "Could not load the street network.";
    emptyEl.appendChild(p);
    const sub = document.createElement("p");
    sub.className = "readout-empty-sub";
    sub.style.color = "#E4572E";
    sub.textContent = message;
    emptyEl.appendChild(sub);
  }
  function drawRouteLines(safeRaw, fastRaw) {
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers = [];
    if (!sameEdgeSequence(safeRaw.edgeIdxs, fastRaw.edgeIdxs)) {
      const fastLine = L.polyline(fastRaw.geometry, {
        color: "#8A94A6",
        weight: 3,
        dashArray: "6 6",
        opacity: 0.7
      }).addTo(map);
      routeLayers.push(fastLine);
    }
    const safeLine = L.polyline(safeRaw.geometry, { color: "#3FA796", weight: 5 }).addTo(map);
    routeLayers.push(safeLine);
    map.fitBounds(safeLine.getBounds(), { padding: [40, 40] });
  }
  function renderRiskStrip(strip, safeRaw) {
    strip.innerHTML = "";
    for (const idx of safeRaw.edgeIdxs) {
      const e = graph.edges[idx];
      const seg = document.createElement("div");
      seg.className = `risk-seg ${riskClassForLts(e.lts)}`;
      seg.style.flexGrow = String(Math.max(e.lengthM, 1e-3));
      strip.appendChild(seg);
    }
  }
  function renderWhyList(list, safe, fast) {
    list.innerHTML = "";
    const items = [];
    const deltaM = Math.round(safe.distance_m - fast.distance_m);
    const safeMin = minutesAt80(safe.distance_m);
    const fastMin = minutesAt80(fast.distance_m);
    if (deltaM > 0) {
      items.push(
        `${deltaM} m longer than the fastest route (\u2248${safeMin} min vs \u2248${fastMin} min, assuming an 80 m/min walking pace).`
      );
    } else if (deltaM < 0) {
      items.push(
        `${Math.abs(deltaM)} m shorter than the fastest route (\u2248${safeMin} min vs \u2248${fastMin} min, assuming an 80 m/min walking pace).`
      );
    } else {
      items.push(`Same distance as the fastest route (\u2248${safeMin} min, assuming an 80 m/min walking pace).`);
    }
    const avoided = avoidedComplexes(fast.flagged_nodes, safe.flagged_nodes, complexOfByNode);
    items.push(
      avoided > 0 ? `Avoids ${avoided} flagged intersection${avoided === 1 ? "" : "s"} that the fastest route passes through.` : `No flagged intersections avoided vs. the fastest route \u2014 both pass similar exposure.`
    );
    items.push(
      `Added stress cost: ${Math.round(safe.stress_cost_m)} m-equivalent (lower is safer \u2014 weighted for crossing difficulty and crash history).`
    );
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    }
  }
  function renderTradeoff(textEl, safeRaw, fastRaw, safe, fast) {
    if (sameEdgeSequence(safeRaw.edgeIdxs, fastRaw.edgeIdxs)) {
      textEl.textContent = "The safest route and the fastest route are the same here \u2014 no tradeoff to make.";
      return;
    }
    const safeMin = minutesAt80(safe.distance_m);
    const fastMin = minutesAt80(fast.distance_m);
    const extraMin = safeMin - fastMin;
    if (extraMin <= 0) {
      textEl.textContent = "This route is also about as fast as the fastest option \u2014 no meaningful time tradeoff, and it avoids more flagged exposure.";
    } else {
      textEl.textContent = `${extraMin} minute${extraMin === 1 ? "" : "s"} longer than the fastest option (\u2248${safeMin} min vs \u2248${fastMin} min, assuming an 80 m/min walking pace).`;
    }
  }
  function renderHazardList(list, safe) {
    list.innerHTML = "";
    const flagged = dedupeFlagged(safe.flagged_nodes, complexOfByNode);
    if (flagged.length === 0) {
      const li = document.createElement("li");
      li.textContent = "None flagged along this route.";
      list.appendChild(li);
      return;
    }
    for (const f of flagged) {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = f.name;
      li.appendChild(strong);
      li.appendChild(document.createElement("br"));
      const note = document.createElement("span");
      note.className = "hazard-note";
      const cause = f.dominantCause ?? "no dominant cause on record";
      const crossing = f.crossingPenaltyM > 0 ? ` \xB7 crossing penalty ${Math.round(f.crossingPenaltyM)} m` : "";
      note.textContent = `${cause} \u2014 ${f.crashN} crash${f.crashN === 1 ? "" : "es"} on record${crossing}`;
      li.appendChild(note);
      list.appendChild(li);
    }
  }
  function findRoute() {
    const startSel = el("start-select");
    const endSel = el("end-select");
    const startId = startSel.value;
    const endId = endSel.value;
    if (startId === endId) {
      alert("Pick two different locations.");
      return;
    }
    const originNode = destNodeById.get(startId);
    const destNode = destNodeById.get(endId);
    if (!originNode || !destNode) return;
    const safeRaw = route(graph, risk, originNode.id, destNode.id, SAFEST_LAMBDA);
    const fastRaw = route(graph, risk, originNode.id, destNode.id, FASTEST_LAMBDA);
    if (!safeRaw || !fastRaw) {
      el("tradeoff-text").textContent = "No route could be found between these two points.";
      return;
    }
    const safe = explainRoute(graph, risk, safeRaw, SAFEST_LAMBDA);
    const fast = explainRoute(graph, risk, fastRaw, FASTEST_LAMBDA);
    el("readout-empty").classList.add("hidden");
    el("readout-content").classList.remove("hidden");
    drawRouteLines(safeRaw, fastRaw);
    renderRiskStrip(el("risk-strip"), safeRaw);
    renderWhyList(el("why-list"), safe, fast);
    renderTradeoff(el("tradeoff-text"), safeRaw, fastRaw, safe, fast);
    renderHazardList(el("hazard-list"), safe);
  }
  async function init() {
    const btn = el("route-btn");
    const startSel = el("start-select");
    const endSel = el("end-select");
    btn.disabled = true;
    btn.textContent = "Loading street network\u2026";
    populateSelects(startSel, endSel);
    initMap();
    let graphData;
    let riskData;
    try {
      const [graphRes, riskRes] = await Promise.all([fetch(GRAPH_URL), fetch(RISK_URL)]);
      if (!graphRes.ok || !riskRes.ok) {
        throw new Error(`fetch failed (graph ${graphRes.status}, risk ${riskRes.status})`);
      }
      [graphData, riskData] = await Promise.all([graphRes.json(), riskRes.json()]);
    } catch (err) {
      btn.textContent = "Street network unavailable";
      showFetchError(
        `Could not fetch the street network or risk data (${err instanceof Error ? err.message : String(err)}). Check your connection and reload.`
      );
      return;
    }
    graph = loadGraph(graphData);
    risk = new Map(riskData.map((r) => [r.nodeId, r]));
    complexOfByNode = new Map(riskData.map((r) => [r.nodeId, r.complexOf ?? r.nodeId]));
    destNodeById = new Map(DESTINATIONS.map((d) => [d.id, nearestNode(graph, d.lat, d.lon)]));
    drawRiskMarkers(riskData);
    btn.disabled = false;
    btn.textContent = "Find safe route";
    btn.addEventListener("click", findRoute);
  }
  window.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => {
      console.error(err);
      showFetchError("Something went wrong loading the demo. Reload to try again.");
    });
  });
})();
