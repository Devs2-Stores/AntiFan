#!/usr/bin/env node
// Sequential deep-analysis runner over all ELIGIBLE units.
// Clears decisions.jsonl/dependencies.jsonl first (idempotent re-run).
// Usage: node deep-analyze-all.mjs [--limit N] [--only <unitId,...>]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(',')) : null;

// clear shared append-only outputs for idempotent re-run
for (const f of ['decisions.jsonl', 'dependencies.jsonl']) {
  const p = path.join(REPORTS, f);
  if (fs.existsSync(p)) fs.writeFileSync(p, '');
}

const eligible = REGISTER.units.filter((u) => u.disposition === 'ELIGIBLE' && (!ONLY || ONLY.has(u.unitId)));
const results = [];
let done = 0;
const t0 = Date.now();

for (const u of eligible.slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
  try {
    const out = execFileSync('node', [path.join(SCRIPT_DIR, 'deep-analyze-unit.mjs'), u.unitId], { encoding: 'utf8', timeout: 120000 });
    const r = JSON.parse(out.trim().split('\n').pop());
    results.push(r);
    done += 1;
    if (done % 20 === 0) console.log(`[${done}/${eligible.length}] ${u.relPath} claims=${r.claims}`);
  } catch (e) {
    results.push({ unitId: u.unitId, relPath: u.relPath, error: String(e.message ?? e).slice(0, 200) });
    console.error(`[ERR] ${u.relPath}: ${String(e.message ?? e).slice(0, 120)}`);
  }
}

const totals = results.reduce((a, r) => ({
  claims: a.claims + (r.claims ?? 0),
  decisions: a.decisions + (r.decisions ?? 0),
  dependencies: a.dependencies + (r.dependencies ?? 0),
  errors: a.errors + (r.error ? 1 : 0),
}), { claims: 0, decisions: 0, dependencies: 0, errors: 0 });

fs.writeFileSync(path.join(REPORTS, 'deep-analysis-summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), units: done, ...totals, results }, null, 2));
console.log(JSON.stringify({ units: done, ...totals, ms: Date.now() - t0 }));
