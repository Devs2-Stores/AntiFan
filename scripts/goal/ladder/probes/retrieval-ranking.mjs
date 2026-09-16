#!/usr/bin/env node
/**
 * Ladder probe: #26 Retrieval precision (owner phase 2).
 *
 * Acceptance signal: retrieval ranks by relevance — a claim that matches the
 * query terms strongly dominates a claim that barely matches. This exercises
 * the BM25 fix (rank magnitude saturating via
 * rankMagnitude/(rankMagnitude+BM25_HALF_SATURATION), TEXT_NEUTRAL=0.5) and
 * proves the deterministic re-rank is applied rather than inverted or flat.
 *
 * Method: seed a throwaway reports dir (fixtureReports() shape from
 * packages/super-core/src/core.test.ts) with ONE unit and TWO claims quoting
 * the same distinctive phrase — c-strong repeats it 5x, c-weak carries it
 * once inside unrelated padding. Import into a temp core.db, then query the
 * phrase and assert: non-empty results, c-strong strictly above c-weak,
 * monotonically non-increasing scores, and a discriminating (non-tie) top.
 * A nonsense query must return zero rows — the store must not fabricate.
 *
 * Protocol: last stdout line is one JSON object
 *   {"verdict":"PASS|FAIL|NOT_IMPLEMENTED|BLOCKED","reason":<string|null>,"evidence":{...}}
 * Exit code encodes the same verdict: 0/1/3/4.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXIT = { PASS: 0, FAIL: 1, NOT_IMPLEMENTED: 3, BLOCKED: 4 };

// Probe-owned state; declared before emit so every exit path can clean up.
let reportsDir;
let core;

function emit(verdict, reason, evidence) {
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

const PHRASE = 'quixotic zephyr';
const NONSENSE = 'zzqwxv blorptastic';
// c-strong: the phrase IS the statement (5 repetitions, 10 tokens).
// c-weak: one occurrence diluted by unrelated padding (17 tokens).
const STRONG_STATEMENT = Array(5).fill(PHRASE).join(' ');
const WEAK_STATEMENT = `${PHRASE} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore`;
const FIXED_CREATED = '2026-09-01T00:00:00Z';

// Same JSON shapes as fixtureReports() in packages/super-core/src/core.test.ts:
// project-register.json + skills-register.json + lineage.jsonl +
// conflicts.jsonl + units/<unitId>/content-ledger.jsonl + claims.jsonl.
function buildReports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rank-'));
  const units = path.join(dir, 'units', 'u-rank');
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-register.json'), JSON.stringify({
    runId: 'probe-rank',
    units: [
      { unitId: 'u-rank', rootId: 'work-root', relPath: 'packages\\rank', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['manifest:package.json'] },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'skills-register.json'), JSON.stringify({
    skills: [
      { skillId: 'sk-rank', name: 'rank-skill', namespace: 'rank-skill', rootId: 'skills-claude', location: 'rank-skill', akDisposition: 'ELIGIBLE', analysisState: 'DONE', unitId: 'u-rank' },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'lineage.jsonl'),
    `${JSON.stringify({ id: 'ln-rank', kind: 'same-package-name', name: 'rank', units: [{ unitId: 'u-rank' }], evidence: 'name equality', strength: 'candidate' })}\n`);
  // One unrelated unresolved conflict: exercises the conflictSubjects path
  // without penalizing either claim (neither carries this subject).
  fs.writeFileSync(path.join(dir, 'conflicts.jsonl'),
    `${JSON.stringify({ id: 'cf-rank', kind: 'version-divergence', subject: 'unrelated divergence', positions: [], state: 'UNRESOLVED', note: 'probe' })}\n`);
  fs.writeFileSync(path.join(units, 'content-ledger.jsonl'),
    `${JSON.stringify({ entryId: 'e-rank', relPath: 'packages\\rank\\claims.txt', path: 'E:\\probe\\rank\\claims.txt', size: 64, mtime: FIXED_CREATED, sha256: 'r', disposition: 'ANALYZED_WITH_CLAIMS', observedAt: FIXED_CREATED })}\n`);
  // Identical kind/status/evidence-count/createdAt on both claims: every
  // non-text score component is equal, so only the BM25 text term can
  // separate them.
  const claim = (claimId, statement) => JSON.stringify({
    claimId, unitId: 'u-rank', statement, kind: 'RULE', status: 'OBSERVED',
    extractorVersion: 'probe', context: {}, createdAt: FIXED_CREATED,
    evidenceRefs: [{ entryId: 'e-rank', revision: 'r', path: 'packages\\rank\\claims.txt', anchor: 'statement' }],
  });
  fs.writeFileSync(path.join(units, 'claims.jsonl'), [
    claim('c-strong', STRONG_STATEMENT),
    claim('c-weak', WEAK_STATEMENT),
  ].join('\n') + '\n');
  return dir;
}

const evidence = { query: PHRASE, nonsenseQuery: NONSENSE };

try {
  reportsDir = buildReports();
  core = openCore(path.join(reportsDir, 'core.db'));
} catch (e) {
  emit('FAIL', `fixture setup failed: ${e?.message ?? e}`, { ...evidence, error: String(e?.stack ?? e) });
}

try {
  if (typeof core.importScout !== 'function') {
    emit('NOT_IMPLEMENTED', 'core.importScout missing', { ...evidence, absent: 'Core#importScout' });
  }
  if (typeof core.query !== 'function') {
    emit('NOT_IMPLEMENTED', 'core.query missing', { ...evidence, absent: 'Core#query' });
  }

  const imported = core.importScout(reportsDir);
  evidence.importedClaims = imported?.claims ?? null;
  if ((imported?.claims ?? 0) !== 2) {
    emit('FAIL', `importScout imported ${imported?.claims} claims, expected 2`, evidence);
  }

  const rows = core.query({ text: PHRASE });
  evidence.ordered = rows.map((r) => ({ claimId: r.claimId, score: r.score, rank: r.rank ?? null }));

  if (rows.length === 0) {
    emit('FAIL', 'query returned zero results for a phrase present in both seeded claims', evidence);
  }

  const ids = rows.map((r) => r.claimId);
  const idxStrong = ids.indexOf('c-strong');
  const idxWeak = ids.indexOf('c-weak');
  if (idxStrong === -1) {
    emit('FAIL', `c-strong missing from ${rows.length} result(s): [${ids.join(', ')}]`, evidence);
  }
  if (idxWeak === -1) {
    emit('FAIL', `c-weak missing from ${rows.length} result(s): [${ids.join(', ')}]`, evidence);
  }
  evidence.strongScore = rows[idxStrong].score;
  evidence.weakScore = rows[idxWeak].score;

  if (idxStrong >= idxWeak) {
    emit('FAIL', `c-strong ranked at index ${idxStrong}, expected strictly above c-weak at index ${idxWeak}`, evidence);
  }

  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i - 1].score < rows[i].score) {
      emit('FAIL', `scores not monotonically non-increasing at index ${i}: ${rows[i - 1].score} < ${rows[i].score}`, evidence);
    }
  }

  if (!(rows[0].score > rows[rows.length - 1].score)) {
    emit('FAIL', `flat score tie: top score ${rows[0].score} equals last score ${rows[rows.length - 1].score} — ordering is not discriminating`, evidence);
  }

  // Abstain counterpart: a nonsense term must yield zero claims; the store
  // must not fabricate a hit.
  const nonsense = core.query({ text: NONSENSE });
  evidence.nonsenseCount = nonsense.length;
  if (nonsense.length !== 0) {
    emit('FAIL', `nonsense query '${NONSENSE}' fabricated ${nonsense.length} result(s): [${nonsense.map((r) => r.claimId).join(', ')}]`, evidence);
  }

  emit('PASS', null, evidence);
} catch (e) {
  emit('FAIL', `probe raised: ${e?.message ?? e}`, { ...evidence, error: String(e?.stack ?? e) });
}
