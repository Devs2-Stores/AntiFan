/**
 * Artifact pruning for a finished run.
 *
 * A multi-day unattended run emits full-page PNGs and DOM dumps per unit; keeping
 * every PASS path would eat the disk headroom the health gate is trying to
 * protect. The rule: FAIL and BLOCKED paths keep everything (they are the
 * evidence a human will need), PASS paths keep only `summary.json`.
 *
 * The function returns measured bytes before/after per entry — the plan requires
 * pruning to prove itself by measurement, not by having been installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeRecordAtomic } from '../lib/atomic-record.mjs';

const SUMMARY_NAME = 'summary.json';

/** Is `candidate` the root itself or a descendant of it? */
export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function dirBytes(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

/**
 * Prune one run's artifact entries.
 * `entries`: `[{ dir, verdict, summary? }]` — verdict in the four-valued
 * vocabulary; `summary` is written as `summary.json` when the unit left none.
 *
 * `root` bounds the operation: pruning recursively deletes, and the entry dirs
 * originate from receipts, so anything resolving outside the run's artifact root
 * is refused rather than deleted.
 *
 * Returns `{ beforeBytes, afterBytes, freedBytes, entries: [...] }`.
 */
export function pruneRunArtifacts(entries, { root = null } = {}) {
  const report = { beforeBytes: 0, afterBytes: 0, freedBytes: 0, entries: [] };
  const bound = root === null ? null : path.resolve(root);
  for (const entry of entries) {
    const dir = entry.dir;
    if (bound !== null && !isInside(bound, path.resolve(dir))) {
      report.entries.push({ dir, action: 'refused-outside-root', freedBytes: 0 });
      continue;
    }
    const before = dirBytes(dir);
    let action = 'kept';
    if (entry.verdict === 'PASS') {
      const summaryPath = path.join(dir, SUMMARY_NAME);
      if (!fs.existsSync(summaryPath)) {
        writeRecordAtomic(summaryPath, entry.summary ?? { verdict: 'PASS' });
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === SUMMARY_NAME) continue;
        fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      }
      action = 'pruned-to-summary';
    }
    const after = dirBytes(dir);
    report.beforeBytes += before;
    report.afterBytes += after;
    report.entries.push({ dir, verdict: entry.verdict, action, beforeBytes: before, afterBytes: after });
  }
  report.freedBytes = report.beforeBytes - report.afterBytes;
  return report;
}
