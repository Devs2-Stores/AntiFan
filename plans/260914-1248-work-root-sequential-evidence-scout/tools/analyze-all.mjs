#!/usr/bin/env node
// Phase 4 driver: run analyze-unit.mjs for every PENDING unit in queue order,
// sequentially (one active work unit). Writes reports/units/<id>/ artifacts
// and updates queue.json state per unit. Resumable: skips units already DONE.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const QUEUE = path.join(REPORTS, 'queue.json');
const ANALYZER = path.join(SCRIPT_DIR, 'analyze-unit.mjs');
const PROGRESS = path.join(REPORTS, 'units', 'analysis-progress.json');

const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const pending = queue.units.filter((u) => u.state === 'PENDING');
const total = pending.length;
let done = 0;
let failed = 0;
const startedAt = new Date().toISOString();

for (const qu of pending) {
  const outDir = path.join(REPORTS, 'units', qu.unitId);
  const dossier = path.join(outDir, 'dossier.md');
  if (fs.existsSync(dossier)) { qu.state = 'DONE'; done += 1; continue; }
  try {
    const out = execFileSync(process.execPath, [ANALYZER, qu.unitId], { encoding: 'utf8', cwd: PLAN_DIR, maxBuffer: 16 * 1024 * 1024 });
    const res = JSON.parse(out.trim().split('\n').pop());
    qu.state = 'DONE';
    qu.analyzedAt = new Date().toISOString();
    qu.result = res;
    done += 1;
  } catch (e) {
    qu.state = 'BLOCKED';
    qu.blockReason = (e.message ?? String(e)).slice(0, 300);
    failed += 1;
  }
  if ((done + failed) % 10 === 0) {
    fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
    fs.writeFileSync(PROGRESS, JSON.stringify({ runId: queue.runId, startedAt, updatedAt: new Date().toISOString(), total, done, failed, current: qu.unitId }, null, 2));
    fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
  }
}
fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
fs.writeFileSync(PROGRESS, JSON.stringify({ runId: queue.runId, startedAt, updatedAt: new Date().toISOString(), total, done, failed, finished: true }, null, 2));
console.log(JSON.stringify({ total, done, failed }));
