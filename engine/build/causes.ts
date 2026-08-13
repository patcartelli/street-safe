import { parseCsv } from './csv.js';

const UNINFORMATIVE = new Set(['', 'None', 'Unknown']);

export function normalizeCase(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function loadCauses(vehiclesCsvText: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of parseCsv(vehiclesCsvText)) {
    const key = normalizeCase(row['Department Case Number'] ?? '');
    if (!key) continue;
    // Every case key is recorded — a crash with only uninformative causes must
    // still count as JOINED for the 98% coverage floor; it just has no labels.
    if (!out.has(key)) out.set(key, []);
    const label = row.cc_label?.trim() ?? '';
    if (!UNINFORMATIVE.has(label)) out.get(key)!.push(label);
  }
  return out;
}

export function joinCauses(
  pointCases: string[],
  causes: Map<string, string[]>,
): { matchedPct: number; unmatched: string[]; byCase: Map<string, string[]> } {
  // NOTE on the 98% assert: a point whose crash has only uninformative causes is
  // still "matched" for coverage purposes — coverage measures join integrity,
  // not cause informativeness. So we track ALL case keys seen in the file too.
  const byCase = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const raw of pointCases) {
    const key = normalizeCase(raw);
    const labels = causes.get(key);
    if (labels) byCase.set(key, labels);
    else unmatched.push(key);
  }
  const matchedPct = pointCases.length ? (pointCases.length - unmatched.length) / pointCases.length : 1;
  if (matchedPct < 0.98) {
    throw new Error(
      `Cause join coverage ${(matchedPct * 100).toFixed(1)}% is below the 98% floor. ` +
      `Unmatched cases:\n${unmatched.join('\n')}`,
    );
  }
  return { matchedPct, unmatched, byCase };
}
