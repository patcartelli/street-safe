/** Single source of truth for the validation harness's fixed station-to-school pair.
 *  Both validate.ts (live sweep) and fetch-osrm-baseline.ts (cached OSRM comparison)
 *  must route the SAME two points or the cached baseline compares a different route. */
export const VALIDATION_PAIR = {
  name: 'station-to-south-mountain',
  from: { lat: 40.7459, lon: -74.2602 },
  to: { lat: 40.7472, lon: -74.2760 },
};

/** Reported-only secondary pair: documents the known unavoidable-junction case (destination
 *  sits on the Valley St corridor, so the Valley×Third intersection complex is structurally
 *  on the only reasonable route at any λ). Not asserted against — printed for visibility. */
export const SECONDARY_PAIR = {
  name: 'station-to-hixon-valley',
  from: { lat: 40.7459, lon: -74.2602 },
  to: { lat: 40.7378, lon: -74.2658 },
};
