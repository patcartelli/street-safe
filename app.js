/**
 * Street Safe — prototype routing + safety scoring.
 *
 * Real-data gaps, called out honestly rather than faked:
 *  - Crash data is MOCK (see data/mock-crashes.js header). Swap in a real
 *    feed once Linear STC-149 is resolved.
 *  - Elevation weighting is NOT implemented here. The routing engine
 *    below scores on crash proximity only. Elevation is real project
 *    scope (V1) but needs its own data source decision before it's
 *    worth building against mock numbers.
 *  - Routing itself is real: OSRM's public demo router, walking profile.
 *    Good enough to prove the concept; not a production routing backend
 *    (no SLA, rate-limited, not for real traffic).
 */

const CENTER = { lat: 40.7484, lng: -74.2960 }; // South Orange, NJ (placeholder town)
const NEAR_THRESHOLD_METERS = 90; // "this crash is relevant to this route" cutoff

let map, startMarker, endMarker;
let routeLayers = [];

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([CENTER.lat, CENTER.lng], 14);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  MOCK_CRASHES.forEach(c => {
    L.circleMarker([c.lat, c.lng], {
      radius: 5 + c.severity * 1.5,
      color: '#E4572E',
      weight: 1,
      fillColor: '#E4572E',
      fillOpacity: 0.35
    }).addTo(map).bindTooltip(`${c.label} — ${c.count} incidents`, { direction: 'top' });
  });
}

function populateSelects() {
  const startSel = document.getElementById('start-select');
  const endSel = document.getElementById('end-select');
  MOCK_DESTINATIONS.forEach(d => {
    const opt1 = document.createElement('option');
    opt1.value = d.id; opt1.textContent = d.label;
    startSel.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = d.id; opt2.textContent = d.label;
    endSel.appendChild(opt2);
  });
  startSel.value = 'south-orange-station';
  endSel.value = 'south-orange-ms';
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Nearest distance from a crash point to any vertex along a route's coordinates.
// Vertex-based rather than true segment projection — fine at this coordinate density,
// worth revisiting if real routes come back with sparse geometry.
function nearestDistanceToRoute(crash, coords) {
  let min = Infinity;
  for (const [lng, lat] of coords) {
    const d = haversineMeters(crash.lat, crash.lng, lat, lng);
    if (d < min) min = d;
  }
  return min;
}

function scoreRoute(coords) {
  const nearby = [];
  let weightedExposure = 0;
  for (const crash of MOCK_CRASHES) {
    const dist = nearestDistanceToRoute(crash, coords);
    if (dist <= NEAR_THRESHOLD_METERS) {
      nearby.push({ ...crash, dist });
      weightedExposure += crash.severity * crash.count;
    }
  }
  nearby.sort((a, b) => (b.severity * b.count) - (a.severity * a.count));
  return { weightedExposure, nearby };
}

async function fetchRoutes(start, end) {
  const url = `https://router.project-osrm.org/route/v1/foot/${start.lng},${start.lat};${end.lng},${end.lat}` +
              `?alternatives=true&overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Routing service unavailable');
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error('No route found');
  return data.routes;
}

function clearRouteLayers() {
  routeLayers.forEach(l => map.removeLayer(l));
  routeLayers = [];
}

function riskLevelForSegment(midLat, midLng) {
  let worst = 'low';
  for (const c of MOCK_CRASHES) {
    const d = haversineMeters(midLat, midLng, c.lat, c.lng);
    if (d <= NEAR_THRESHOLD_METERS && c.severity >= 3) return 'high';
    if (d <= NEAR_THRESHOLD_METERS && c.severity >= 2) worst = 'med';
  }
  return worst;
}

function renderRiskStrip(coords) {
  const strip = document.getElementById('risk-strip');
  strip.innerHTML = '';
  const BUCKETS = 24;
  const step = Math.max(1, Math.floor(coords.length / BUCKETS));
  for (let i = 0; i < coords.length; i += step) {
    const [lng, lat] = coords[i];
    const level = riskLevelForSegment(lat, lng);
    const seg = document.createElement('div');
    seg.className = `risk-seg risk-${level}`;
    strip.appendChild(seg);
  }
}

function metersToWalkMinutes(durationSeconds) {
  return Math.round(durationSeconds / 60);
}

function renderReadout(safest, fastest, safestScore, fastestScore) {
  document.getElementById('readout-empty').classList.add('hidden');
  document.getElementById('readout-content').classList.remove('hidden');

  // Why this route
  const whyList = document.getElementById('why-list');
  whyList.innerHTML = '';
  const points = [];

  if (safestScore.nearby.length < fastestScore.nearby.length) {
    points.push(`Passes near ${safestScore.nearby.length} flagged intersection${safestScore.nearby.length === 1 ? '' : 's'}, vs ${fastestScore.nearby.length} on the fastest alternative.`);
  } else if (safestScore.nearby.length === fastestScore.nearby.length && safestScore.nearby.length > 0) {
    points.push(`No lower-exposure alternative found — this route and the fastest option pass similar flagged intersections.`);
  } else {
    points.push(`No flagged intersections within ${NEAR_THRESHOLD_METERS}m of this route in the mock dataset.`);
  }

  points.push(`Weighted crash exposure score: ${safestScore.weightedExposure} (lower is safer) — based on incident count × severity for nearby locations, not filtered to pedestrian-involved crashes only.`);
  points.push(`Elevation is not yet factored into this score — flagged as open project scope, not silently assumed.`);

  points.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p;
    whyList.appendChild(li);
  });

  // Tradeoff
  const extraMin = metersToWalkMinutes(safest.duration) - metersToWalkMinutes(fastest.duration);
  const tradeoffEl = document.getElementById('tradeoff-text');
  if (safest === fastest) {
    tradeoffEl.textContent = `The safest route and the fastest route are the same here — no tradeoff to make.`;
  } else if (extraMin <= 0) {
    tradeoffEl.textContent = `This route is also the fastest available — no time tradeoff, and it avoids more flagged exposure.`;
  } else {
    tradeoffEl.textContent = `${extraMin} minute${extraMin === 1 ? '' : 's'} longer than the fastest option, avoiding ${Math.max(0, fastestScore.nearby.length - safestScore.nearby.length)} additional flagged intersection${(fastestScore.nearby.length - safestScore.nearby.length) === 1 ? '' : 's'}.`;
  }

  // Hazard list
  const hazardList = document.getElementById('hazard-list');
  hazardList.innerHTML = '';
  if (safestScore.nearby.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'None flagged along this route.';
    hazardList.appendChild(li);
  } else {
    safestScore.nearby.forEach(c => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${c.label}</strong><br><span class="hazard-note">${c.note} — ${c.count} incidents (mock data)</span>`;
      hazardList.appendChild(li);
    });
  }
}

async function handleFindRoute() {
  const startId = document.getElementById('start-select').value;
  const endId = document.getElementById('end-select').value;
  if (startId === endId) {
    alert('Pick two different locations.');
    return;
  }
  const start = MOCK_DESTINATIONS.find(d => d.id === startId);
  const end = MOCK_DESTINATIONS.find(d => d.id === endId);

  const btn = document.getElementById('route-btn');
  btn.disabled = true;
  btn.textContent = 'Finding route…';

  try {
    const routes = await fetchRoutes(start, end);
    const scored = routes.map(r => ({
      route: r,
      score: scoreRoute(r.geometry.coordinates)
    }));

    scored.sort((a, b) => {
      if (a.score.weightedExposure !== b.score.weightedExposure) {
        return a.score.weightedExposure - b.score.weightedExposure;
      }
      return a.route.duration - b.route.duration;
    });
    const safestEntry = scored[0];

    const fastestEntry = [...scored].sort((a, b) => a.route.duration - b.route.duration)[0];

    clearRouteLayers();

    // Draw fastest (if different) as a muted dashed reference line
    if (fastestEntry !== safestEntry) {
      const fastestLatLngs = fastestEntry.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const fastestLine = L.polyline(fastestLatLngs, { color: '#8A94A6', weight: 3, dashArray: '6 6', opacity: 0.7 }).addTo(map);
      routeLayers.push(fastestLine);
    }

    // Draw safest as the primary solid line
    const safestLatLngs = safestEntry.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const safestLine = L.polyline(safestLatLngs, { color: '#3FA796', weight: 5 }).addTo(map);
    routeLayers.push(safestLine);
    map.fitBounds(safestLine.getBounds(), { padding: [40, 40] });

    renderRiskStrip(safestEntry.route.geometry.coordinates);
    renderReadout(safestEntry.route, fastestEntry.route, safestEntry.score, fastestEntry.score);

  } catch (err) {
    console.error(err);
    alert('Could not fetch a route from the demo routing service. It is public and rate-limited — try again in a moment.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find safe route';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  populateSelects();
  document.getElementById('route-btn').addEventListener('click', handleFindRoute);
});
