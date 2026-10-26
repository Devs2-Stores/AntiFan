/**
 * The rule index of a theme QA report: which rules the critical findings belong to, so a reader
 * of `summary` can see what `criticalCount` is made of without opening the findings lists or the
 * receipt. Pure; fed the same entries the receipt lists, so the two cannot disagree.
 */

/** The part of a listed finding the index reads. */
export interface QaReportIndexEntry {
  rule: string;
  severity: 'critical' | 'warning';
}

export interface QaReportIndex {
  /** Distinct rules with at least one critical finding, most findings first, ties by name. */
  criticalCodes: string[];
  /** Critical findings per rule; the values add up to the number of critical entries given. */
  byRule: Record<string, number>;
}

export function buildQaReportIndex(entries: ReadonlyArray<QaReportIndexEntry>): QaReportIndex {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry || entry.severity !== 'critical' || typeof entry.rule !== 'string' || entry.rule.length === 0) continue;
    counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    criticalCodes: ordered.map(([rule]) => rule),
    byRule: Object.fromEntries(ordered),
  };
}
