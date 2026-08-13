export type Source = 'tagged' | 'default';
export interface LtsReason { reason: string; source: Source }
export type Lts = 1 | 2 | 3 | 4;

const BASE: Record<string, number> = {
  footway: 1, path: 1, pedestrian: 1, living_street: 1, steps: 1,
  residential: 2, unclassified: 2, service: 2, cycleway: 2,
  tertiary: 3, secondary: 3, primary: 4,
};
const PEDESTRIAN_ONLY = new Set(['footway', 'path', 'pedestrian', 'steps']);

function parseMph(maxspeed: string | undefined): number | null {
  if (!maxspeed) return null;
  const m = maxspeed.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null; // NJ default unit is mph
}

export function segmentLts(tags: Record<string, string>): { lts: Lts; reasons: LtsReason[]; steps: boolean } {
  const hw = tags.highway ?? 'unclassified';
  let score = BASE[hw] ?? 2;
  const reasons: LtsReason[] = [];
  let hwSource: Source = 'tagged';

  if (!tags.highway) {
    reasons.push({ reason: 'highway unknown, assumed unclassified (base 2)', source: 'default' });
    hwSource = 'default';
  } else if (!(hw in BASE)) {
    reasons.push({ reason: `${hw} not in rubric, assumed base 2`, source: 'default' });
    hwSource = 'default';
  } else {
    reasons.push({ reason: `${hw} (base ${score})`, source: 'tagged' });
  }

  const isRoad = !PEDESTRIAN_ONLY.has(hw);

  const sw = tags.sidewalk;
  if (isRoad) {
    if (sw === 'both' || sw === 'yes') { score -= 1; reasons.push({ reason: 'sidewalk present', source: 'tagged' }); }
    else if (sw === 'left' || sw === 'right') { reasons.push({ reason: 'sidewalk one side only', source: 'tagged' }); }
    else if (sw === 'no' || sw === 'none') {
      if (score >= 2) { score += 1; reasons.push({ reason: 'no sidewalk', source: 'tagged' }); }
    } else reasons.push({ reason: 'sidewalk unknown, assumed absent', source: 'default' });
  }

  const mph = parseMph(tags.maxspeed);
  if (mph !== null) {
    if (mph >= 35) { score += 1; reasons.push({ reason: `${mph} mph`, source: 'tagged' }); }
    else if (mph <= 20) { score -= 1; reasons.push({ reason: `${mph} mph`, source: 'tagged' }); }
    else reasons.push({ reason: `${mph} mph`, source: 'tagged' });
  } else if (isRoad) {
    reasons.push({ reason: 'speed unknown, class default assumed', source: 'default' });
  }

  const lanes = parseInt(tags.lanes ?? '', 10);
  if (lanes >= 4) { score += 1; reasons.push({ reason: `${lanes} lanes`, source: 'tagged' }); }

  const lts = Math.min(4, Math.max(1, score)) as Lts;
  return { lts, reasons, steps: hw === 'steps' };
}

/** Crossing LTS: highest-LTS road being crossed, discounted by crossing quality.
 *  Clamped 1–4 after discounts (spec: a discount never yields a negative penalty). */
export function crossingLts(maxCrossedLts: number, signal: boolean, crossing: string | null): number {
  let lts = maxCrossedLts;
  if (signal || crossing === 'traffic_signals') lts -= 1;
  else if (crossing === 'marked' || crossing === 'zebra' || crossing === 'uncontrolled') lts -= 0.5; // uncontrolled is OSM's legacy tag for marked, unsignalized crossing
  return Math.min(4, Math.max(1, lts));
}
