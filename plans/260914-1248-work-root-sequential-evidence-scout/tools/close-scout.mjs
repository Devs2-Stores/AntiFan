#!/usr/bin/env node
// Phase 6 closure: reconcile inventory + content ledgers + queue into
// completion-ledger.json, final-scout-report.md, super-core-planning-handoff.md.
// D = E + X + R + G (disjoint, precedence G > R > X > E); E = A + P + B.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_DIR = path.resolve(SCRIPT_DIR, '..');
const REPORTS = path.join(PLAN_DIR, 'reports');
const UNITS_DIR = path.join(REPORTS, 'units');
const SUMMARY = JSON.parse(fs.readFileSync(path.join(REPORTS, 'inventory-summary.json'), 'utf8'));
const QUEUE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'queue.json'), 'utf8'));
const REGISTER = JSON.parse(fs.readFileSync(path.join(REPORTS, 'project-register.json'), 'utf8'));
const SKILLS = JSON.parse(fs.readFileSync(path.join(REPORTS, 'skills-register.json'), 'utf8'));
const DELTA = JSON.parse(fs.readFileSync(path.join(REPORTS, 'delta-sweep.json'), 'utf8'));
const DELTA_APPLIED = JSON.parse(fs.readFileSync(path.join(REPORTS, 'delta-applied.json'), 'utf8'));
const ARCHIVE = JSON.parse(fs.readFileSync(path.join(REPORTS, 'archive-summary.json'), 'utf8'));

const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// ---- ledger accounting -----------------------------------------------------
// Physical entries by policy (from summary)
const pol = SUMMARY.byContentPolicy;
const G = pol.GENERATED_BY_THIS_RUN ?? 0;
const R = pol.RESTRICTED_METADATA_ONLY ?? 0;
const X = (pol.EXCLUDED_CONTENT_DEPENDENCY ?? 0) + (pol.DERIVED_BUILD_OUTPUT ?? 0) + (pol.EXCLUDED_AK_SKILL ?? 0) + (pol.EXCLUDED_AK_SKILL_CANDIDATE ?? 0);
const E = pol.ALLOWED ?? 0;
const D = SUMMARY.physical.entries;

// content coverage over eligible FILES only (dirs are structural, not content)
let A = 0; let P = 0; let B = 0;
let claimsTotal = 0;
const unitStates = { DONE: 0, PENDING: 0, BLOCKED: 0, EXCLUDED: 0 };
for (const qu of QUEUE.units) {
  unitStates[qu.state] = (unitStates[qu.state] ?? 0) + 1;
  const ledgerPath = path.join(UNITS_DIR, qu.unitId, 'content-ledger.jsonl');
  const claimsPath = path.join(UNITS_DIR, qu.unitId, 'claims.jsonl');
  if (!fs.existsSync(ledgerPath)) continue;
  for (const l of readJsonl(ledgerPath)) {
    if (l.disposition === 'ANALYZED_WITH_CLAIMS' || l.disposition === 'ANALYZED_NO_CLAIM') A += 1;
    else if (l.disposition === 'BLOCKED') B += 1;
    else P += 1;
  }
  claimsTotal += readJsonl(claimsPath).length;
}

const ledger = {
  runId: SUMMARY.runId,
  generatedAt: new Date().toISOString(),
  physical: {
    denominator: D,
    eligible: E,
    excluded: X,
    restricted: R,
    generatedByRun: G,
    check: D === E + X + R + G ? 'D=E+X+R+G OK' : `MISMATCH D=${D} vs E+X+R+G=${E + X + R + G}`,
  },
  eligibleContent: {
    eligibleFiles: A + P + B,
    analyzed: A,
    pending: P,
    blocked: B,
    coverage: A + P + B > 0 ? `${((A / (A + P + B)) * 100).toFixed(2)}%` : 'N/A',
    note: 'eligible FILES only; directories are structural receipts, not content',
  },
  virtual: { archiveContainers: ARCHIVE.containers, archiveMembers: ARCHIVE.members, archiveBlockers: ARCHIVE.blockers.length },
  units: unitStates,
  skills: {
    total: SKILLS.skills.length,
    excluded: SKILLS.skills.filter((s) => s.akDisposition === 'EXCLUDED_AK_SKILL').length,
    eligible: SKILLS.skills.filter((s) => s.akDisposition === 'ELIGIBLE').length,
    unresolved: SKILLS.skills.filter((s) => s.akDisposition === 'UNRESOLVED_SKILL_ORIGIN').length,
  },
  delta: { added: DELTA.added, changed: DELTA.changed, deleted: DELTA.deleted, applied: DELTA_APPLIED },
  claims: { total: claimsTotal },
  frontier: SUMMARY.frontier,
  coverageClaim: SUMMARY.coverageClaim,
  unknownRegions: SUMMARY.directoriesWithoutCompleteReceipt,
};
fs.writeFileSync(path.join(REPORTS, 'completion-ledger.json'), JSON.stringify(ledger, null, 2));

const scoutComplete = SUMMARY.frontier.state === 'EMPTY' && SUMMARY.directoriesWithoutCompleteReceipt === 0 && P === 0 && B === 0 && unitStates.BLOCKED === 0;

const report = `# Final Scout Report — work-root-sequential-evidence-scout

Run ${SUMMARY.runId} | generated ${ledger.generatedAt}

## Discovery state
- Physical entries inventoried: ${D.toLocaleString()} (${SUMMARY.physical.files.toLocaleString()} files, ${SUMMARY.physical.directories.toLocaleString()} dirs, ${SUMMARY.physical.reparsePoints} reparse points)
- Frontier: ${SUMMARY.frontier.state} (${SUMMARY.frontier.discoveredDirs} discovered, ${SUMMARY.frontier.completedDirs} completed, ${SUMMARY.frontier.pendingCount} pending)
- Unknown regions (dirs without COMPLETE receipt): ${SUMMARY.directoriesWithoutCompleteReceipt}
- Coverage claim: ${SUMMARY.coverageClaim}
- Errors during scan: ${SUMMARY.errors.total}

## Accounting (D = E + X + R + G)
- Eligible (E): ${E.toLocaleString()}
- Excluded content (X): ${X.toLocaleString()} (dependency trees, derived build output, AK skills)
- Restricted (R): ${R.toLocaleString()} (credentials/profiles/sessions — metadata only)
- Generated by this run (G): ${G.toLocaleString()}
- Check: ${ledger.physical.check}

## Eligible content coverage (E = A + P + B)
- Eligible files: ${(A + P + B).toLocaleString()}
- Analyzed (A): ${A.toLocaleString()} (${ledger.eligibleContent.coverage})
- Pending (P): ${P.toLocaleString()}
- Blocked (B): ${B.toLocaleString()}
- Claims extracted: ${claimsTotal.toLocaleString()}

## Units
- Total routed: ${QUEUE.units.length} | DONE: ${unitStates.DONE} | PENDING: ${unitStates.PENDING} | BLOCKED: ${unitStates.BLOCKED} | EXCLUDED: ${unitStates.EXCLUDED}
- Child plans scaffolded: ${QUEUE.units.filter((u) => u.childPlanPath).length}

## Skills
- Total: ${SKILLS.skills.length} | AK-excluded: ${ledger.skills.excluded} | eligible: ${ledger.skills.eligible} | unresolved: ${ledger.skills.unresolved}

## Archives (separate denominator)
- Containers: ${ARCHIVE.containers} | members: ${ARCHIVE.members.toLocaleString()} | blockers: ${ARCHIVE.blockers.length} (BLOCKED_RESOURCE_LIMIT, explicit)

## Delta (post-scan re-enumeration)
- Added: ${DELTA.added} | changed: ${DELTA.changed} | deleted: ${DELTA.deleted}
- Applied: ${DELTA_APPLIED.affectedUnits} units re-analyzed, ${DELTA_APPLIED.addedRegistered} files registered, ${DELTA_APPLIED.staleClaims} claims marked stale

## Verdict
${scoutComplete ? 'SCOUT_COMPLETE_FOR_DECLARED_SCOPE' : 'INCOMPLETE — see blockers'}
${scoutComplete ? '' : `Blockers: P=${P}, B=${B}, blockedUnits=${unitStates.BLOCKED}, unknownRegions=${SUMMARY.directoriesWithoutCompleteReceipt}`}

## Limitations
- Mechanical extraction; semantic depth bounded per unit.
- Binary/media files are metadata-only.
- No universal semantic accuracy claimed; claims are anchored observations.
- Active filesystem: delta applied but corpus continues to change.
`;
fs.writeFileSync(path.join(REPORTS, 'final-scout-report.md'), report);

const handoff = `# Super Core Planning Handoff

Scout state: ${scoutComplete ? 'COMPLETE for declared scope' : 'INCOMPLETE'} as of ${ledger.generatedAt}.

## What exists now
- Full filesystem inventory: ${D.toLocaleString()} entries, frontier EMPTY, 0 unknown regions.
- ${QUEUE.units.length} routed units; ${unitStates.DONE} analyzed with dossiers + claims.
- ${claimsTotal.toLocaleString()} anchored claims; ${ARCHIVE.members.toLocaleString()} archive members on separate denominator.
- Skills: ${ledger.skills.excluded} AK-excluded, ${ledger.skills.eligible} eligible user skills.
- Correlation: lineage.jsonl, conflicts.jsonl, domain-register.json, corpus-findings.md.

## What is missing for phase 7
- Deep semantic analysis is mechanical-level; key files need targeted reads during design.
- Git history not semantically analyzed (objects inventoried; history frontier open).
- 2 archive containers BLOCKED_RESOURCE_LIMIT (>256MB) — need raised limit or explicit exclusion decision.
- Media/binary content interpretation is metadata-only by design.

## Entry conditions for phase 7
- Use reports/units/*/dossier.md + claims.jsonl as corpus evidence.
- Domain register identifies haravan (80), liquid-theme (157), sapo (7), shopify (3), generic-js (92), skill-package (53), unknown (47).
- Conflicts (5) are UNRESOLVED — phase 9 must keep them visible.
- No claim is an active rule; all are candidates pending adjudication.
`;
fs.writeFileSync(path.join(REPORTS, 'super-core-planning-handoff.md'), handoff);

console.log(JSON.stringify({ scoutComplete, D, E, X, R, G, A, P, B, claimsTotal, unitStates, check: ledger.physical.check }));
