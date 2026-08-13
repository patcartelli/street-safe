/** Single source of truth for the validation harness's fixed station-to-school pair.
 *  Both validate.ts (live sweep) and fetch-osrm-baseline.ts (cached OSRM comparison)
 *  must route the SAME two points or the cached baseline compares a different route. */
export const VALIDATION_PAIR = {
  name: 'station-to-south-mountain',
  from: { lat: 40.7459, lon: -74.2602 },
  to: { lat: 40.7378, lon: -74.2658 },
};
