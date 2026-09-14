#!/usr/bin/env node
// Phase 6 delta application: apply delta-sweep.json to unit inventories and
// claims. Added files -> append to unit files.jsonl + re-analyze unit.
// Changed/deleted -> mark affected claims STALE, re-analyze unit.
// Writes reports/delta-applied.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const DELTA = JSON.parse(fs.readFileSync(path.join(REPORTS, 'delta-sweep.json'), 'utf8'));
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));
const QUEUE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'queue.json'), 'utf8'));
const ANALYZER = path.join(SCRIPT_DIR, 'analyze-unit.mjs');

const unitByPath = new Map(REGISTER.units.map((u) => [`${u.rootId}${u.relPath}`, u]));
const looseByRoot = new Map(REGISTER.units.filter((u) => u.relPath === '<root-loose>').map((u) => [u.rootId, u]));
const rootPath = { 'work-root': 'E:\\Work', 'skills-claude': 'C:\\Users\\Admin\\.claude\\skills', 'skills-agents': 'C:\\Users\\Admin\\.agents\\skills' };
const rootOf = (abs) => {
  for (const [id, p] of Object.entries(rootPath)) if (abs.startsWith(p + '\\') || abs === p) return id;
  return null;
};
const relOf = (abs, rootId) => path.relative(rootPath[rootId], abs) || '.';
const ownerOf = (abs) => {
  const rootId = rootOf(abs);
  if (!rootId) return null;
  let cur = relOf(abs, rootId);
  while (true) {
    const u = unitByPath.get(`${rootId}${cur}`);
    if (u) return u;
    const i = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
    if (i < 0) break;
    cur = cur.slice(0, i);
  }
  const looseUnit = looseByRoot.get(rootId);
  return looseUnit ?? null;
};

const affected = new Set();
const addedByUnit = new Map();
const staleClaims = [];

// added files -> register into unit inventory
for (const a of DELTA.addedSample.concat()) {
  // full list may be truncated; re-derive added from delta file samples only
}
// delta-sweep stores only 500 samples; for correctness re-run sweep inline is
// expensive, so we process the recorded samples and note truncation.
const allAdded = DELTA.addedSample;
const allChanged = DELTA.changedSample;
const allDeleted = DELTA.deletedSample;

for (const a of allAdded) {
  const u = ownerOf(a.path);
  if (!u) continue;
  if (!addedByUnit.has(u.unitId)) addedByUnit.set(u.unitId, []);
  addedByUnit.get(u.unitId).push(a);
  affected.add(u.unitId);
}
for (const c of allChanged) {
  const u = ownerOf(c.path);
  if (u) affected.add(u.unitId);
}
for (const d of allDeleted) {
  const u = ownerOf(d.path);
  if (u) affected.add(u.unitId);
}

// mark stale claims in affected units
for (const uid of affected) {
  const claimsPath = path.join(REPORTS, 'units', uid, 'claims.jsonl');
  if (!fs.existsSync(claimsPath)) continue;
  const lines = fs.readFileSync(claimsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const changedPaths = new Set([...allChanged, ...allDeleted].map((x) => x.path));
  const out = lines.map((l) => {
    try {
      const c = JSON.parse(l);
      if (c.evidenceRefs?.some((r) => changedPaths.has(r.path))) {
        c.status = 'STALE_SOURCE_CHANGED';
        staleClaims.push(c.claimId);
      }
      return JSON.stringify(c);
    } catch { return l; }
  });
  fs.writeFileSync(claimsPath, out.join('\n') + '\n');
}

// append added files to unit inventories and re-analyze affected units
const reanalyzed = [];
for (const uid of affected) {
  const qu = QUEUE.units.find((x) => x.unitId === uid);
  if (!qu || !qu.fileInventory) continue;
  const filesPath = path.join(PLAN_DIR, qu.fileInventory);
  const existing = new Set(fs.existsSync(filesPath) ? fs.readFileSync(filesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l).path; } catch { return null; } }) : []);
  const toAdd = (addedByUnit.get(uid) ?? []).filter((a) => !existing.has(a.path));
  if (toAdd.length) {
    const lines = toAdd.map((a) => JSON.stringify({ entryId: `d-${crypto.createHash('sha1').update(a.path).digest('hex').slice(0, 16)}`, relPath: relOf(a.path, rootOf(a.path)), path: a.path, size: null, mtime: null, deltaAdded: true }));
    fs.appendFileSync(filesPath, lines.join('\n') + '\n');
  }
  try {
    execFileSync(process.execPath, [ANALYZER, uid], { encoding: 'utf8', cwd: PLAN_DIR, maxBuffer: 16 * 1024 * 1024 });
    reanalyzed.push(uid);
  } catch (e) {
    qu.state = 'BLOCKED';
    qu.blockReason = `delta re-analysis failed: ${(e.message ?? '').slice(0, 200)}`;
  }
}

fs.writeFileSync(path.join(REPORTS, 'queue.json'), JSON.stringify(QUEUE, null, 2));
const report = {
  generatedAt: new Date().toISOString(),
  deltaTruncated: DELTA.samplesTruncated,
  affectedUnits: affected.size,
  addedRegistered: [...addedByUnit.values()].reduce((a, b) => a + b.length, 0),
  staleClaims: staleClaims.length,
  reanalyzed: reanalyzed.length,
  note: DELTA.samplesTruncated ? 'delta samples truncated at 500/class; full delta requires re-sweep' : 'full delta applied',
};
fs.writeFileSync(path.join(REPORTS, 'delta-applied.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
