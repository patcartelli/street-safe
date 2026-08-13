/**
 * ONE-TIME extraction (spec Stage 0). so-crash-stress-map.html is the live
 * STC-211 spot-check tool, not a data file — after this script has run and
 * its CSV outputs are committed, nothing in the build may read the HTML again.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface RawPoint {
  la: number; lo: number; k: string; y: string;
  d: string; t: string; loc: string; c: string;
}

export function parseDataLine(html: string): { points: RawPoint[] } {
  const line = html.split('\n').find((l) => l.trimStart().startsWith('const DATA = '));
  if (!line) throw new Error('DATA line not found in map HTML');
  const json = line.slice(line.indexOf('const DATA = ') + 'const DATA = '.length).replace(/;\s*$/, '');
  return JSON.parse(json);
}

const DATA_DIR = process.env.SAFE_ROUTES_DATA_DIR
  ?? join(process.env.HOME!, 'Documents/Claude/Projects/Linear');
const OUT_DIR = fileURLToPath(new URL('../data/', import.meta.url));

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(join(DATA_DIR, 'so-crash-stress-map.html'), 'utf8');
  const { points } = parseDataLine(html);
  if (points.length !== 632) throw new Error(`Expected 632 points, got ${points.length}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const header = 'lat,lon,kind,year,date,crash_type,loc,case\n';
  const rows = points.map((p) =>
    [p.la, p.lo, p.k, p.y, p.d, p.t, p.loc, p.c].map((v) => csvEscape(String(v))).join(','));
  writeFileSync(join(OUT_DIR, 'so_points_clustered.csv'), header + rows.join('\n') + '\n');
  copyFileSync(join(DATA_DIR, 'so_hotspots.csv'), join(OUT_DIR, 'so_hotspots.csv'));
  console.log(`Wrote ${points.length} points and copied so_hotspots.csv to engine/data/`);
}
