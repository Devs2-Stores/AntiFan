#!/usr/bin/env node
/**
 * Ladder probe: #27 Historical reuse (owner phases 2 and 8).
 *
 * Acceptance signal: the user-approved reuse metric
 * `found + injected + outcome-linked` is computable from the store by real
 * queries:
 *   found          — claims the store returns for the task's query
 *                    (Core#query over claims_fts/claims).
 *   injected       — claims actually written into the task's context pack
 *                    (packs.claimIdsJson, keyed by packId).
 *   outcome-linked — injected claims reachable from a recorded outcome via
 *                    cases.verificationRef -> receipts.receiptId ->
 *                    receipts.packId -> packs.claimIdsJson. receipt() refuses
 *                    an unknown packId, so the chain is store-enforced.
 *
 * Method: seed a throwaway reports dir (fixtureReports() shape from
 * packages/super-core/src/core.test.ts) with ONE unit and FIVE claims sharing
 * a distinctive token. Import into a temp core.db, then drive the real
 * lifecycle: query (found=5), contextPack with limit=2 (injected=2, a strict
 * subset of found), receipt bound to the pack, ingestOutcome citing the
 * receipt as verificationRef. A second pack for the same task under a
 * different sessionId is left un-receipted as the discrimination control:
 * its outcome-linked count must be 0, proving the join is not an echo of
 * injected.
 *
 * The store has no dedicated reuse-metric export; the probe reports whether
 * the documented composition of existing surfaces witnesses all three counts.
 *
 * Protocol: last stdout line is one JSON object
 *   {"verdict":"PASS|FAIL|NOT_IMPLEMENTED|BLOCKED","reason":<string|null>,"evidence":{...}}
 * Exit code encodes the same verdict: 0/1/3/4.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EXIT = { PASS: 0, FAIL: 1, NOT_IMPLEMENTED: 3, BLOCKED: 4 };

// Probe-owned state; declared before emit so every exit path can clean up.
let reportsDir;
let core;
let reader;

function emit(verdict, reason, evidence) {
  try { reader?.close(); } catch { /* best-effort */ }
  try { core?.close(); } catch { /* best-effort */ }
  try { if (reportsDir) fs.rmSync(reportsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.stdout.write(`${JSON.stringify({ verdict, reason: reason ?? null, evidence: evidence ?? {} })}\n`);
  process.exit(EXIT[verdict]);
}

// The store import is the documented prerequisite: a missing build is a
// BLOCKED predecessor, not a probe failure.
let openCore;
try {
  ({ openCore } = await import('../../../../packages/super-core/dist/index.js'));
} catch (e) {
  emit('BLOCKED', `super-core dist import failed: ${e?.message ?? e}`, { predecessor: 'packages/super-core/dist not built' });
}
if (typeof openCore !== 'function') {
  emit('NOT_IMPLEMENTED', 'openCore export missing from super-core dist', { absent: 'packages/super-core/dist/index.js export openCore' });
}

const PHRASE = 'zephyrquixotic';
const SESSION = 'probe-reuse-session';
const SESSION_CONTROL = 'probe-reuse-session-control';
const FIXED_CREATED = '2026-09-01T00:00:00Z';
const SEEDED_CLAIMS = ['c-reuse-1', 'c-reuse-2', 'c-reuse-3', 'c-reuse-4', 'c-reuse-5'];
const PACK_LIMIT = 2;

// Same JSON shapes as fixtureReports() in packages/super-core/src/core.test.ts:
// project-register.json + skills-register.json + lineage.jsonl +
// conflicts.jsonl + units/<unitId>/content-ledger.jsonl + claims.jsonl.
function buildReports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reuse-'));
  const units = path.join(dir, 'units', 'u-reuse');
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-register.json'), JSON.stringify({
    runId: 'probe-reuse',
    units: [
      { unitId: 'u-reuse', rootId: 'work-root', relPath: 'packages\\reuse', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['manifest:package.json'] },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'skills-register.json'), JSON.stringify({
    skills: [
      { skillId: 'sk-reuse', name: 'reuse-skill', namespace: 'reuse-skill', rootId: 'skills-claude', location: 'reuse-skill', akDisposition: 'ELIGIBLE', analysisState: 'DONE', unitId: 'u-reuse' },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'lineage.jsonl'),
    `${JSON.stringify({ id: 'ln-reuse', kind: 'same-package-name', name: 'reuse', units: [{ unitId: 'u-reuse' }], evidence: 'name equality', strength: 'candidate' })}\n`);
  fs.writeFileSync(path.join(dir, 'conflicts.jsonl'),
    `${JSON.stringify({ id: 'cf-reuse', kind: 'version-divergence', subject: 'unrelated divergence', positions: [], state: 'UNRESOLVED', note: 'probe' })}\n`);
  fs.writeFileSync(path.join(units, 'content-ledger.jsonl'),
    `${JSON.stringify({ entryId: 'e-reuse', relPath: 'packages\\reuse\\claims.txt', path: 'E:\\probe\\reuse\\claims.txt', size: 64, mtime: FIXED_CREATED, sha256: 'r', disposition: 'ANALYZED_WITH_CLAIMS', observedAt: FIXED_CREATED })}\n`);
  // Five claims share the token so `found` (5) strictly exceeds `injected`
  // (PACK_LIMIT=2): the two counts can only diverge if both are real.
  const claim = (claimId, n) => JSON.stringify({
    claimId, unitId: 'u-reuse', statement: `${PHRASE} reuse rule number ${n}`, kind: 'RULE', status: 'OBSERVED',
    extractorVersion: 'probe', context: {}, createdAt: FIXED_CREATED,
    evidenceRefs: [{ entryId: 'e-reuse', revision: 'r', path: 'packages\\reuse\\claims.txt', anchor: `rule ${n}` }],
  });
  fs.writeFileSync(path.join(units, 'claims.jsonl'),
    SEEDED_CLAIMS.map((cid, i) => claim(cid, i + 1)).join('\n') + '\n');
  return dir;
}

const evidence = { task: PHRASE, metric: 'found + injected + outcome-linked' };

try {
  reportsDir = buildReports();
  core = openCore(path.join(reportsDir, 'core.db'));
} catch (e) {
  emit('FAIL', `fixture setup failed: ${e?.message ?? e}`, { ...evidence, error: String(e?.stack ?? e) });
}

try {
  for (const m of ['importScout', 'query', 'contextPack', 'receipt', 'ingestOutcome', 'stats']) {
    if (typeof core[m] !== 'function') {
      emit('NOT_IMPLEMENTED', `core.${m} missing — reuse metric cannot be composed`, { ...evidence, absent: `Core#${m}` });
    }
  }

  const imported = core.importScout(reportsDir);
  evidence.importedClaims = imported?.claims ?? null;
  if ((imported?.claims ?? 0) !== SEEDED_CLAIMS.length) {
    emit('FAIL', `importScout imported ${imported?.claims} claims, expected ${SEEDED_CLAIMS.length}`, evidence);
  }

  // Step 2 of the acceptance check: is there a dedicated reuse-metric export?
  // Recorded for the ladder report; the metric itself is computed below from
  // real rows either way.
  evidence.dedicatedSurface = ['reuseMetric', 'reuseMetrics', 'historicalReuse', 'reuseStats']
    .find((m) => typeof core[m] === 'function') ?? null;

  // Read side-channel on the same store file (WAL permits a second reader).
  // The metric must be witnessed by rows, not by trusting return values.
  try {
    reader = new DatabaseSync(core.dbPath);
  } catch (e) {
    emit('FAIL', `could not open read side-channel on temp store: ${e?.message ?? e}`, evidence);
  }

  // Column existence gate: a missing column means the corresponding count has
  // no witness surface at all — that is NOT_IMPLEMENTED, not FAIL.
  const REQUIRED = {
    packs: ['packId', 'task', 'claimIdsJson', 'sessionId'],
    receipts: ['receiptId', 'packId', 'taskContext'],
    cases: ['caseId', 'task', 'verificationRef'],
    observations: ['id', 'kind', 'payload'],
  };
  for (const [table, cols] of Object.entries(REQUIRED)) {
    let info;
    try {
      info = reader.prepare(`PRAGMA table_info(${table})`).all();
    } catch (e) {
      emit('NOT_IMPLEMENTED', `table ${table} unreadable: ${e?.message ?? e}`, { ...evidence, absent: `table ${table}` });
    }
    const have = new Set(info.map((r) => r.name));
    for (const col of cols) {
      if (!have.has(col)) {
        emit('NOT_IMPLEMENTED', `column ${table}.${col} missing — a reuse count has no witness`, { ...evidence, absent: `${table}.${col}` });
      }
    }
  }

  // ---- found: claims the store returns for the task query -----------------
  const foundRows = core.query({ text: PHRASE, limit: 200 });
  const foundIds = foundRows.map((r) => r.claimId).sort();
  evidence.found = { value: foundRows.length, witness: `query({text:'${PHRASE}',limit:200})`, claimIds: foundIds };
  if (foundRows.length !== SEEDED_CLAIMS.length) {
    emit('FAIL', `found=${foundRows.length}, expected ${SEEDED_CLAIMS.length} seeded claims to match`, evidence);
  }

  // ---- injected: claims written into the task's pack ----------------------
  const pack = core.contextPack({ task: PHRASE, limit: PACK_LIMIT, sessionId: SESSION });
  evidence.packId = pack.packId;
  const packRow = reader.prepare('SELECT packId, task, sessionId, claimIdsJson FROM packs WHERE packId = ?').get(pack.packId);
  if (!packRow) {
    emit('FAIL', `packs row ${pack.packId} absent after contextPack — injected has no witness`, evidence);
  }
  const injectedIds = JSON.parse(packRow.claimIdsJson).sort();
  evidence.injected = { value: injectedIds.length, witness: `packs.claimIdsJson for ${pack.packId}`, claimIds: injectedIds };
  if (injectedIds.length !== PACK_LIMIT) {
    emit('FAIL', `injected=${injectedIds.length}, expected ${PACK_LIMIT} (contextPack limit)`, evidence);
  }
  if (!injectedIds.every((cid) => foundIds.includes(cid))) {
    emit('FAIL', `injected claims [${injectedIds.join(', ')}] are not a subset of found [${foundIds.join(', ')}]`, evidence);
  }

  // Discrimination control: a second pack for the same task under a different
  // sessionId is injected but never receipted — its outcome-linked count must
  // stay 0 or the join is not measuring linkage.
  const packControl = core.contextPack({ task: PHRASE, limit: PACK_LIMIT, sessionId: SESSION_CONTROL });

  // ---- outcome-linked: injected claims reachable from a recorded outcome --
  const rcpt = core.receipt({ task: PHRASE, packId: pack.packId, recommendation: 'apply seeded reuse rules' });
  evidence.receiptId = rcpt.receiptId;
  const outcome = core.ingestOutcome({
    task: PHRASE,
    outcome: 'probe outcome verified',
    verificationRef: rcpt.receiptId,
    unitId: 'u-reuse',
  });
  evidence.caseId = outcome.caseId;
  evidence.observationId = outcome.observationId;

  const linkRows = reader.prepare(
    `SELECT p.claimIdsJson AS ids, c.caseId AS caseId, c.verificationRef AS verificationRef, r.receiptId AS receiptId, r.packId AS packId
     FROM cases c
     JOIN receipts r ON r.receiptId = c.verificationRef
     JOIN packs p ON p.packId = r.packId
     WHERE c.task = ? AND p.packId = ?`,
  ).all(PHRASE, pack.packId);
  const linkedIds = [...new Set(linkRows.flatMap((row) => JSON.parse(row.ids)))].sort();
  const outcomeLinkedIds = linkedIds.filter((cid) => injectedIds.includes(cid));
  const obsRow = reader.prepare('SELECT id, kind FROM observations WHERE id = ?').get(outcome.observationId);
  evidence.outcomeLinked = {
    value: outcomeLinkedIds.length,
    witness: 'cases.verificationRef -> receipts.receiptId -> receipts.packId -> packs.claimIdsJson',
    claimIds: outcomeLinkedIds,
    caseId: outcome.caseId,
    receiptId: rcpt.receiptId,
    observation: obsRow ?? null,
  };
  if (!obsRow) {
    emit('FAIL', `ingestOutcome returned observationId ${outcome.observationId} but no observations row exists`, evidence);
  }
  if (outcomeLinkedIds.length !== injectedIds.length) {
    emit('FAIL', `outcome-linked=${outcomeLinkedIds.length}, expected ${injectedIds.length} injected claims linked via receipt ${rcpt.receiptId}`, evidence);
  }

  // Step 3: the metric must be reachable as a surface, not only reproducible inside
  // a probe. It is cross-checked against the row-witnessed counts below, once the
  // control pack is the task's latest pack.

  const controlRows = reader.prepare(
    `SELECT p.claimIdsJson AS ids
     FROM cases c
     JOIN receipts r ON r.receiptId = c.verificationRef
     JOIN packs p ON p.packId = r.packId
     WHERE c.task = ? AND p.packId = ?`,
  ).all(PHRASE, packControl.packId);
  const controlLinked = controlRows.flatMap((row) => JSON.parse(row.ids)).length;
  const controlPackRow = reader.prepare('SELECT claimIdsJson FROM packs WHERE packId = ?').get(packControl.packId);
  evidence.control = {
    packId: packControl.packId,
    injected: controlPackRow ? JSON.parse(controlPackRow.claimIdsJson).length : null,
    outcomeLinked: controlLinked,
    note: 'same task, different sessionId, never receipted',
  };
  if (controlLinked !== 0) {
    emit('FAIL', `control pack ${packControl.packId} reports ${controlLinked} outcome-linked claims with no receipt — join is not discriminating`, evidence);
  }

  // Step 3: the metric must be reachable as a surface, not only reproducible inside
  // a probe. The control pack is now the task's latest, so the surface must follow
  // it and report the same row-witnessed numbers — including the zero linkage that
  // distinguishes "measured" from "echoed injected".
  if (!evidence.dedicatedSurface) {
    emit('NOT_IMPLEMENTED', 'the reuse metric is computable but not surfaced: no store method exposes it', {
      ...evidence,
      absent: 'store method reuseMetric({ task })',
    });
  }
  const surface = core.reuseMetric({ task: PHRASE });
  const controlInjected = evidence.control.injected;
  evidence.dedicatedSurfaceReport = {
    method: evidence.dedicatedSurface,
    packId: surface.packId,
    found: surface.found.value,
    injected: surface.injected.value,
    outcomeLinked: surface.outcomeLinked.value,
  };
  if (surface.packId !== packControl.packId) {
    emit('FAIL', `surface followed pack ${surface.packId}, rows witness the later pack ${packControl.packId}`, evidence);
  }
  if (surface.found.value !== foundIds.length) {
    emit('FAIL', `surface found=${surface.found.value}, rows witness ${foundIds.length}`, evidence);
  }
  if (surface.injected.value !== controlInjected) {
    emit('FAIL', `surface injected=${surface.injected.value}, rows witness ${controlInjected}`, evidence);
  }
  if (surface.outcomeLinked.value !== 0) {
    emit('FAIL', `surface outcomeLinked=${surface.outcomeLinked.value}, rows witness 0 for an unreceipted pack`, evidence);
  }

  emit('PASS', null, evidence);
} catch (e) {
  emit('FAIL', `probe raised: ${e?.message ?? e}`, { ...evidence, error: String(e?.stack ?? e) });
}
