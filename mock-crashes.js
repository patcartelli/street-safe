/**
 * MOCK crash/incident dataset for the Street Safe prototype.
 *
 * This stands in for real municipal crash data (see Linear STC-149,
 * "Confirm crash data source" — not yet resolved). Coordinates are
 * placed near real intersections in South Orange, NJ for a plausible
 * demo, but severity/count values are invented, not sourced.
 *
 * Per the project's data-scoping decision: incident type is NOT filtered
 * to pedestrian-involved only. A car-on-car crash at an intersection
 * still signals a high-conflict location relevant to someone walking
 * or biking through it (situational awareness, not just direct risk).
 *
 * severity: 1 (minor) - 3 (severe), count: incidents in the mock window
 */
const MOCK_CRASHES = [
  { lat: 40.7488, lng: -74.2999, label: "South Orange Ave & Scotland Rd", count: 6, severity: 3, note: "Multi-vehicle crashes, high traffic volume corridor" },
  { lat: 40.7466, lng: -74.2960, label: "Valley St & Irvington Ave", count: 4, severity: 2, note: "Frequent rear-end collisions, limited sightlines" },
  { lat: 40.7501, lng: -74.2935, label: "South Orange Ave & Vose Ave", count: 3, severity: 2, note: "Turning-vehicle conflicts near school hours" },
  { lat: 40.7440, lng: -74.2990, label: "Prospect St & Irvington Ave", count: 5, severity: 3, note: "Crash cluster, no dedicated turn signal" },
  { lat: 40.7520, lng: -74.2905, label: "Ridgewood Rd & Wyoming Ave", count: 2, severity: 1, note: "Occasional low-speed incidents" },
  { lat: 40.7477, lng: -74.2875, label: "South Orange Ave & Meadowbrook Ln", count: 3, severity: 2, note: "Reduced visibility at curve" }
];

/**
 * MOCK points of interest, standing in for OpenStreetMap POI-tag results
 * (see Linear STC-154, "Build V1: quick-select destinations from
 * OpenStreetMap" — not yet built). Same idea: schools, transit, parks,
 * commercial areas as quick-select destinations rather than free text.
 */
const MOCK_DESTINATIONS = [
  { id: "seton-hall", label: "Seton Hall University", lat: 40.7440, lng: -74.2960 },
  { id: "south-orange-station", label: "South Orange Train Station", lat: 40.7495, lng: -74.2996 },
  { id: "meadowland-park", label: "Meadowland Park", lat: 40.7472, lng: -74.2861 },
  { id: "south-orange-ms", label: "South Orange Middle School", lat: 40.7517, lng: -74.2922 },
  { id: "downtown", label: "Downtown South Orange (Main St)", lat: 40.7498, lng: -74.2993 },
  { id: "cameron-field", label: "Cameron Field & Rec Center", lat: 40.7458, lng: -74.2937 }
];
