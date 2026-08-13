const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings treating opposite directions as equal (0–90). */
export function bearingDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Equirectangular point-to-segment distance — fine at town scale. */
export function pointSegDistM(
  plat: number, plon: number,
  alat: number, alon: number,
  blat: number, blon: number,
): number {
  const kx = Math.cos(toRad(alat)) * 111320; // m per deg lon at this latitude
  const ky = 110540;                          // m per deg lat
  const px = (plon - alon) * kx, py = (plat - alat) * ky;
  const bx = (blon - alon) * kx, by = (blat - alat) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}
