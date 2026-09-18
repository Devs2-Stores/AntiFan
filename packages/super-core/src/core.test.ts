// Core acceptance tests: restart, idempotency, platform isolation, abstention,
// learning lifecycle, rollback, revocation. Uses a fixture reports dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openCore, type Core, CORE_NAMESPACES } from './index.js';
import { SCHEMA_VERSION, NAMESPACE_BACKFILL_SQL } from './schema.js';

function fixtureReports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-fixture-'));
  const units = path.join(dir, 'units', 'u-test');
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-register.json'), JSON.stringify({
    runId: 'test', units: [
      { unitId: 'u-test', rootId: 'work-root', relPath: 'apps\\demo', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['manifest:package.json'] },
      { unitId: 'u-other', rootId: 'work-root', relPath: 'apps\\other', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: [] },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'skills-register.json'), JSON.stringify({ skills: [
    { skillId: 'sk-1', name: 'my-skill', namespace: 'my-skill', rootId: 'skills-claude', location: 'my-skill', akDisposition: 'ELIGIBLE', analysisState: 'PENDING', unitId: 'u-test' },
    { skillId: 'sk-2', name: 'ak-cook', namespace: 'ak-cook', rootId: 'skills-agents', location: 'ak-cook', akDisposition: 'EXCLUDED_AK_SKILL', analysisState: 'EXCLUDED', unitId: null },
  ] }));
  fs.writeFileSync(path.join(dir, 'lineage.jsonl'), JSON.stringify({ id: 'ln-1', kind: 'same-package-name', name: 'demo', units: [{ unitId: 'u-test' }], evidence: 'name equality', strength: 'candidate' }) + '\n');
  fs.writeFileSync(path.join(dir, 'conflicts.jsonl'), JSON.stringify({ id: 'cf-1', kind: 'version-divergence', subject: 'demo', positions: [{ version: '1.0' }, { version: '2.0' }], state: 'UNRESOLVED', note: 'test' }) + '\n');
  fs.writeFileSync(path.join(units, 'content-ledger.jsonl'), [
    JSON.stringify({ entryId: 'e1', relPath: 'apps\\demo\\package.json', path: 'E:\\Work\\apps\\demo\\package.json', size: 100, mtime: '2026-01-01T00:00:00Z', sha256: 'abc', disposition: 'ANALYZED_WITH_CLAIMS', observedAt: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ entryId: 'e2', relPath: 'apps\\demo\\secret.env', path: 'E:\\Work\\apps\\demo\\secret.env', size: 10, mtime: '2026-01-01T00:00:00Z', sha256: 'def', disposition: 'ANALYZED_WITH_CLAIMS', observedAt: '2026-01-01T00:00:00Z' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(units, 'claims.jsonl'), [
    JSON.stringify({ claimId: 'c1', unitId: 'u-test', statement: 'package.json declares name=demo version=1.0.0', kind: 'MANIFEST', status: 'OBSERVED', extractorVersion: 't', context: { platform: 'haravan' }, evidenceRefs: [{ entryId: 'e1', revision: 'abc', path: 'apps\\demo\\package.json', anchor: 'root fields' }] }),
    JSON.stringify({ claimId: 'c2', unitId: 'u-test', statement: 'theme uses settings.html for config', kind: 'THEME', status: 'OBSERVED', extractorVersion: 't', context: { platform: 'haravan' }, evidenceRefs: [{ entryId: 'e1', revision: 'abc', path: 'apps\\demo\\package.json', anchor: 'settings' }] }),
    JSON.stringify({ claimId: 'c3', unitId: 'u-test', statement: 'secret credential value', kind: 'SECRET', status: 'OBSERVED', extractorVersion: 't', context: { platform: 'haravan' }, evidenceRefs: [{ entryId: 'e2', revision: 'def', path: 'apps\\demo\\secret.env', anchor: 'value' }] }),
  ].join('\n') + '\n');
  return dir;
}

// Multi-platform fixture: haravan + sapo + untagged claims sharing the terms
// "settings schema", per-platform conflicts resolvable via positions->skills,
// and a stale-only platform (shopify) for gap classification.
function fixturePlatforms() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-plat-'));
  for (const uid of ['u-har', 'u-sapo', 'u-gen', 'u-old']) {
    fs.mkdirSync(path.join(dir, 'units', uid), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'project-register.json'), JSON.stringify({
    runId: 't', units: [
      { unitId: 'u-har', rootId: 'work-root', relPath: 'themes\\har', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['theme-project'] },
      { unitId: 'u-sapo', rootId: 'work-root', relPath: 'themes\\sapo', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['theme-project'] },
      { unitId: 'u-gen', rootId: 'work-root', relPath: 'docs\\gen', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: [] },
      { unitId: 'u-old', rootId: 'work-root', relPath: 'themes\\old', kind: 'package', disposition: 'ELIGIBLE', parentId: null, markers: ['theme-project'] },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'skills-register.json'), JSON.stringify({ skills: [
    { skillId: 'sk-har', name: 'haravan-theme', namespace: 'haravan-theme', rootId: 'work-root', location: 'haravan-theme', akDisposition: 'ELIGIBLE', analysisState: 'DONE', unitId: 'u-har' },
    { skillId: 'sk-sapo', name: 'sapo-theme', namespace: 'sapo-theme', rootId: 'work-root', location: 'sapo-theme', akDisposition: 'ELIGIBLE', analysisState: 'DONE', unitId: 'u-sapo' },
  ] }));
  fs.writeFileSync(path.join(dir, 'conflicts.jsonl'), [
    JSON.stringify({ id: 'cf-har', kind: 'version-divergence', subject: 'haravan settings schema', positions: [{ skillId: 'sk-har' }], state: 'UNRESOLVED', note: 'haravan conflict' }),
    JSON.stringify({ id: 'cf-sapo', kind: 'version-divergence', subject: 'sapo widget', positions: [{ skillId: 'sk-sapo' }], state: 'UNRESOLVED', note: 'sapo conflict' }),
    JSON.stringify({ id: 'cf-global', kind: 'version-divergence', subject: 'unscoped thing', positions: [], state: 'UNRESOLVED', note: 'global conflict' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), [
    JSON.stringify({ decisionId: 'd-sapo', unitId: 'u-sapo', statement: 'sapo settings schema decision', platform: 'sapo' }),
    JSON.stringify({ decisionId: 'd-har', unitId: 'u-har', statement: 'haravan settings schema decision' }),
  ].join('\n') + '\n');
  const ledger = (uid: string) => fs.writeFileSync(path.join(dir, 'units', uid, 'content-ledger.jsonl'),
    JSON.stringify({ entryId: `e-${uid}`, relPath: `x\\${uid}.json`, path: `E:\\x\\${uid}.json`, size: 1, mtime: '2026-01-01T00:00:00Z', sha256: 'h', disposition: 'ANALYZED_WITH_CLAIMS', observedAt: '2026-01-01T00:00:00Z' }) + '\n');
  for (const uid of ['u-har', 'u-sapo', 'u-gen', 'u-old']) ledger(uid);
  const claim = (cid: string, platform: string | null, stmt: string, createdAt?: string) =>
    JSON.stringify({
      claimId: cid, statement: stmt, kind: 'RULE', status: 'OBSERVED', extractorVersion: 't',
      context: platform ? { platform } : {}, createdAt,
      evidenceRefs: [{ entryId: `e-UNIT`, revision: 'r1', path: 'p', anchor: 'a' }],
    });
  const writeClaims = (uid: string, rows: string[]) =>
    fs.writeFileSync(path.join(dir, 'units', uid, 'claims.jsonl'), rows.map((r) => r.replace('e-UNIT', `e-${uid}`)).join('\n') + '\n');
  writeClaims('u-har', [
    claim('c-har-1', 'haravan', 'haravan theme settings schema rule'),
    claim('c-har-2', 'haravan', 'haravan settings schema liquid rule'),
  ]);
  writeClaims('u-sapo', [
    claim('c-sapo-1', 'sapo', 'sapo theme settings schema rule'),
    claim('c-sapo-2', 'sapo', 'sapo settings schema card rule'),
  ]);
  writeClaims('u-gen', [claim('c-gen-1', null, 'generic settings schema note')]);
  writeClaims('u-old', [claim('c-old-1', 'shopify', 'shopify settings schema ancient rule', '2020-01-01T00:00:00Z')]);
  return dir;
}

test('import is idempotent and restart preserves records', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const s1 = core.importScout(dir);
  const s2 = core.importScout(dir);
  assert.equal(s2.claims, s1.claims, 're-import must not duplicate claims');
  core.close();
  const core2 = openCore(dbPath);
  const s3 = core2.stats();
  assert.equal(s3.claims, s1.claims, 'restart preserves claims');
  assert.equal(s3.artifacts, s1.artifacts, 'restart preserves artifacts');
  core2.close();
});

test('platform filter isolates wrong-platform claims', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const haravan = core.query({ text: 'settings', platform: 'haravan' });
  assert.ok(haravan.length > 0, 'haravan query returns claims');
  const shopify = core.query({ text: 'settings', platform: 'shopify' });
  assert.equal(shopify.filter((c) => c.contextPlatform === 'haravan').length, 0, 'no haravan-only claims under shopify filter');
  core.close();
});

test('no-match query abstains (empty result, not fabricated)', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const res = core.query({ text: 'zzz-nonexistent-term-qqq' });
  assert.equal(res.length, 0);
  core.close();
});

test('revocation removes claims from packs', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const before = core.contextPack({ task: 'credential' });
  assert.ok(before.claims.some((c) => c.claimId === 'c3'), 'secret claim present before revocation');
  core.revoke({ path: 'apps\\demo\\secret.env' });
  const after = core.contextPack({ task: 'credential' });
  assert.equal(after.claims.filter((c) => c.claimId === 'c3').length, 0, 'revoked claim absent from pack');
  core.close();
});

test('learning lifecycle: outcome -> case -> candidate -> adjudication -> rollback', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const rel = core.snapshot('pre-learning');
  const { caseId, candidateId, status } = core.ingestOutcome({ task: 'fix header', outcome: 'passed QA', verificationRef: 'rcpt-1', unitId: 'u-test' });
  assert.equal(status, 'PENDING');
  assert.ok(caseId && candidateId);
  // self-promotion must not happen: candidate stays PENDING until adjudicated
  const pending = core.query({ text: 'passed QA' });
  assert.equal(pending.length, 0, 'candidate not in claim space');
  core.adjudicate({ candidateId, decision: 'PROMOTE', authority: 'test-authority', rationale: 'acceptance store proof' });
  const stats = core.stats();
  assert.equal(stats.adjudications, 1);
  // rollback restores pre-learning state
  core.rollback(rel.releaseId);
  const after = core.stats();
  assert.equal(after.candidates, 0, 'rollback removes post-release candidates');
  core.close();
});

test('receipt binds evidence revisions', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const pack = core.contextPack({ task: 'demo' });
  const r = core.receipt({ task: 'demo', packId: pack.packId, recommendation: 'use settings.html' });
  assert.ok(r.receiptId.startsWith('rcpt-'));
  assert.ok(Array.isArray(r.evidenceRevisions));
  core.close();
});

// ---- Phase 2: retrieval integrity -------------------------------------------

test('platform policy excludes untagged and wrong-platform claims; includeGlobal opts in', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const sapo = core.query({ text: 'settings schema', platform: 'sapo' });
  // Positive control first: a broken search returning [] must FAIL here.
  assert.ok(sapo.length > 0, 'positive control: sapo query returns sapo claims');
  assert.ok(sapo.every((c) => c.contextPlatform === 'sapo'), 'no haravan/untagged claims under sapo filter');
  const withGlobal = core.query({ text: 'settings schema', platform: 'sapo', includeGlobal: true });
  assert.ok(withGlobal.some((c) => c.contextPlatform === 'sapo'), 'positive control: includeGlobal keeps sapo claims');
  assert.ok(withGlobal.some((c) => c.contextPlatform === null), 'includeGlobal admits untagged claims');
  assert.equal(withGlobal.filter((c) => c.contextPlatform === 'haravan').length, 0, 'includeGlobal still excludes wrong platform');
  core.close();
});

test('contextPack dedupes on (taskHash, platform, sessionId)', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const p1 = core.contextPack({ task: 'settings schema', platform: 'sapo', sessionId: 's1' });
  assert.ok(p1.claims.length > 0, 'positive control: pack is non-empty');
  const packsAfterFirst = core.stats().packs;
  const p2 = core.contextPack({ task: 'settings schema', platform: 'sapo', sessionId: 's1' });
  assert.equal(p2.packId, p1.packId, 'same identity returns same packId');
  assert.equal(core.stats().packs, packsAfterFirst, 'repeat call adds no pack row');
  const p3 = core.contextPack({ task: 'settings schema', platform: 'sapo', sessionId: 's2' });
  assert.notEqual(p3.packId, p1.packId, 'different session produces a different pack');
  core.close();
});

test('abstain gate: <2 quality claims yields UNKNOWN + reasonCode; enough evidence does not abstain', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  // 'card' matches exactly one sapo claim -> below the quality floor.
  const thin = core.contextPackV2({ task: 'card', platform: 'sapo' });
  assert.ok(thin.claims.length > 0, 'positive control: the thin query still returns its claim');
  assert.equal(thin.confidence, 'UNKNOWN');
  assert.equal(thin.reasonCode, 'INSUFFICIENT_PLATFORM_EVIDENCE');
  assert.ok(thin.abstained);
  // An abstention must not ship a confident-looking composite beside it.
  assert.equal(thin.confidenceScore, null, 'an abstained pack publishes no score');
  const rec = core.recommend({ task: 'card', platform: 'sapo' });
  assert.ok(rec.abstained, 'recommend abstains under the same gate');
  assert.equal(rec.reasonCode, 'INSUFFICIENT_PLATFORM_EVIDENCE');
  // Positive control: two quality sapo claims -> no abstention.
  const rich = core.contextPackV2({ task: 'settings schema', platform: 'sapo' });
  assert.ok(rich.qualityClaims >= 2, 'positive control: enough quality claims');
  assert.notEqual(rich.confidence, 'UNKNOWN');
  assert.equal(rich.reasonCode, null);
  core.close();
});

test('unresolved conflict lowers confidence; resolving restores it', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const before = core.contextPackV2({ task: 'settings schema', platform: 'sapo' });
  assert.ok(before.conflicts.some((c) => c.id === 'cf-sapo'), 'positive control: sapo conflict is in scope');
  core.resolveConflict({ id: 'cf-sapo', classification: 'GENERAL_RULE' });
  const after = core.contextPackV2({ task: 'settings schema', platform: 'sapo' });
  const beforeScore = before.confidenceScore;
  const afterScore = after.confidenceScore;
  // An abstained pack carries no score, so the comparison is only meaningful
  // once both packs are proven to have answered.
  assert.ok(
    typeof beforeScore === 'number' && typeof afterScore === 'number',
    'neither pack abstained, so both carry a score',
  );
  assert.ok(afterScore > beforeScore, 'resolving the conflict raises the score');
  assert.equal(after.conflicts.filter((c) => c.id === 'cf-sapo').length, 0, 'resolved conflict leaves scope');
  core.close();
});

test('pack conflicts are platform-scoped and unit-scoped', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const pack = core.contextPack({ task: 'settings schema', platform: 'sapo' });
  assert.ok(pack.conflicts.some((c) => c.id === 'cf-sapo'), 'positive control: sapo conflict present');
  const ids = pack.conflicts.map((c) => c.id);
  assert.ok(!ids.includes('cf-har'), 'haravan conflict excluded');
  assert.ok(!ids.includes('cf-global'), 'untagged conflict excluded by default');
  const scoped = core.contextPack({ task: 'settings schema', platform: 'sapo', unitIds: ['u-har'] });
  assert.ok(scoped.conflicts.some((c) => c.id === 'cf-har'), 'explicit unitIds widen conflict scope');
  core.close();
});

test('importScout scopes conflicts via positions->skills->unit and backfills platform', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const pack = core.contextPack({ task: 'settings schema', platform: 'sapo' });
  const sapoConflict = pack.conflicts.find((c) => c.id === 'cf-sapo') as { unitId?: string; platform?: string } | undefined;
  assert.ok(sapoConflict, 'positive control: cf-sapo present');
  assert.equal(sapoConflict.unitId, 'u-sapo', 'unitId derived from positions skillId');
  assert.equal(sapoConflict.platform, 'sapo', 'platform backfilled from unit claims');
  // cf-global has no positions and no platform keyword: stays untagged, excluded.
  assert.equal(pack.conflicts.filter((c) => c.id === 'cf-global').length, 0, 'underivable conflict stays untagged and excluded');
  core.close();
});

test('findSimilar applies platform policy to all six collections', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  core.ingestOutcome({ task: 'sapo settings schema fix', outcome: 'worked', platform: 'sapo' });
  core.ingestOutcome({ task: 'haravan settings schema fix', outcome: 'worked', platform: 'haravan' });
  core.recordAntiPattern({ name: 'sapo settings schema pitfall', affectedPlatform: 'sapo' });
  core.recordAntiPattern({ name: 'haravan settings schema pitfall', affectedPlatform: 'haravan' });
  core.recordWorkaround({ problem: 'sapo settings schema issue', platform: 'sapo' });
  core.recordWorkaround({ problem: 'haravan settings schema issue', platform: 'haravan' });
  core.recordFixPattern({ before: 'sapo settings schema bad', platform: 'sapo' });
  core.recordFixPattern({ before: 'haravan settings schema bad', platform: 'haravan' });
  const sim = core.findSimilar({ task: 'settings schema', platform: 'sapo' });
  const cols: Array<[string, Array<Record<string, unknown>>]> = [
    ['claims', sim.claims], ['cases', sim.cases], ['decisions', sim.decisions],
    ['antiPatterns', sim.antiPatterns], ['workarounds', sim.workarounds], ['fixPatterns', sim.fixPatterns],
  ];
  for (const [name, rows] of cols) {
    assert.ok(rows.length > 0, `positive control: ${name} returns sapo rows`);
    for (const r of rows) {
      const p = (r.contextPlatform ?? r.affectedPlatform ?? r.platform) as string | null;
      assert.equal(p, 'sapo', `${name} leaked a non-sapo row`);
    }
  }
  core.close();
});

test('content policy holds on findSimilar, not only query', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);
  // Positive controls: while the artifact is ALLOWED the claim is reachable on
  // both paths, so the assertions below cannot pass by returning nothing.
  assert.ok(core.query({ text: 'credential' }).some((c) => c.claimId === 'c3'), 'positive control: query reaches c3');
  assert.ok(
    core.findSimilar({ task: 'credential' }).claims.some((c) => String(c.claimId) === 'c3'),
    'positive control: findSimilar reaches c3',
  );
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare("UPDATE artifacts SET contentPolicy = 'BLOCKED' WHERE entryId = 'e2'").run();
  } finally { raw.close(); }
  assert.equal(core.query({ text: 'credential' }).filter((c) => c.claimId === 'c3').length, 0, 'query excludes BLOCKED-artifact claims');
  // findSimilar feeds contextPackV2/receiptV2 and, through the bridge, every
  // prompt: a second retrieval path that skips the policy is a data-exposure path.
  assert.equal(
    core.findSimilar({ task: 'credential' }).claims.filter((c) => String(c.claimId) === 'c3').length, 0,
    'findSimilar applies the same eligible-content policy as query',
  );
  core.close();
});

test('health-surface evaluation records nothing; a real gate run still records', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);
  const counts = () => {
    const handle = new DatabaseSync(dbPath);
    try {
      const rowFor = (sql: string) => {
        const row = handle.prepare(sql).get() as { n: number };
        return row.n;
      };
      return { gates: rowFor('SELECT COUNT(*) AS n FROM phase_gates'), audits: rowFor('SELECT COUNT(*) AS n FROM corpus_audit') };
    } finally { handle.close(); }
  };
  const before = counts();
  // The default call shape is what the MCP surface invokes: no options at all.
  // It must compute without appending — a read that writes is the defect.
  core.corpusAudit();
  core.checkPhaseGate('health-surface', 'coverage');
  core.corpusAudit({ record: false });
  core.checkPhaseGate('health-surface', 'coverage', { record: false });
  core.checkPhaseGate('health-surface', 'evidence', { record: false });
  assert.deepEqual(counts(), before, 'a read-shaped health evaluation leaves the store unchanged');
  // The recording form is what a real gate run uses, and it still persists.
  core.corpusAudit({ record: true });
  core.checkPhaseGate('phase-01', 'coverage', { record: true });
  const after = counts();
  assert.equal(after.audits, before.audits + 1, 'a recorded audit appends one row');
  assert.equal(after.gates, before.gates + 1, 'a recorded gate check appends one row');
  core.close();
});

test('health() reports a reason-coded status from real gate outcomes and records nothing', () => {
  // An empty store cannot support a judgement. Reporting HEALTHY here would
  // launder "no evidence" into "no problems", which is the one reading a health
  // surface exists to prevent.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-health-empty-'));
  const empty = openCore(path.join(emptyDir, 'core.db'));
  const emptyHealth = empty.health() as { status: string; reasonCode: string };
  assert.equal(emptyHealth.status, 'UNKNOWN');
  assert.equal(emptyHealth.reasonCode, 'EMPTY_STORE');
  empty.close();
  fs.rmSync(emptyDir, { recursive: true, force: true });

  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);

  const countRows = () => {
    const handle = new DatabaseSync(dbPath);
    try {
      const n = (sql: string) => (handle.prepare(sql).get() as { n: number }).n;
      return { gates: n('SELECT COUNT(*) AS n FROM phase_gates'), audits: n('SELECT COUNT(*) AS n FROM corpus_audit') };
    } finally {
      handle.close();
    }
  };

  // The fixture carries one unresolved conflict and no passing regression run,
  // so the degraded branch must name every failed gate — and name the same set
  // on every run, not whichever ran last.
  const before = countRows();
  const degraded = core.health() as { status: string; reasonCode: string; gates: Record<string, { passed: boolean; detail: string }> };
  assert.equal(degraded.status, 'DEGRADED');
  assert.equal(degraded.reasonCode, 'GATE_CONFLICT_FAILED+GATE_REGRESSION_FAILED');
  assert.equal(degraded.gates.conflict.passed, false);
  assert.match(degraded.gates.conflict.detail, /unresolved conflict/);
  assert.deepEqual(countRows(), before, 'reading health leaves the store unchanged');

  const second = core.health() as { status: string; reasonCode: string };
  assert.equal(second.reasonCode, degraded.reasonCode, 'the named gate is stable across reads');

  // Drive every gate green through real state changes rather than by stubbing a
  // gate result, then confirm the status follows the state.
  core.resolveConflict({ id: 'cf-1', classification: 'GENERAL_RULE' });
  const regression = core.recordRegression({ checks: [{ kind: 'claim-status', claimId: 'c1', expect: 'LIVE' }] }) as { regressionId: string };
  const replay = core.replayRegression(regression.regressionId) as { replayResult: string };
  assert.equal(replay.replayResult, 'PASS', 'the recorded check re-executes against live state and passes');

  const healthy = core.health() as { status: string; reasonCode: string; gates: Record<string, { passed: boolean }>; uncertainty: { level: string; reason: string } };
  const failing = Object.entries(healthy.gates).filter(([, g]) => !g.passed).map(([name]) => name);
  assert.deepEqual(failing, [], `expected every gate to pass, still failing: ${failing.join(',')}`);
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.reasonCode, 'ALL_GATES_PASSED');
  // The consumer that renders this payload branches on uncertainty.level, so the
  // shape it maps has to be the shape emitted here. Uncertainty is scoped to a
  // task or claim, so the corpus-wide level is UNKNOWN by construction — a
  // consumer test that supplied a confident level would be asserting a state
  // this method cannot reach. Pin it here so the two cannot drift apart.
  assert.equal(healthy.uncertainty.level, 'UNKNOWN');
  assert.match(healthy.uncertainty.reason, /unscoped/);
  core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reuseMetric separates found from injected from outcome-linked on real rows', () => {
  // A reuse number is only meaningful if it can tell "the store had material" from
  // "the material reached the agent" from "the outcome was tied back to it". A
  // metric that echoes one count into the other three measures nothing, so each
  // transition below is asserted separately.
  type ReuseReport = {
    packId: string | null;
    found: { value: number; claimIds: string[] };
    injected: { value: number; claimIds: string[] };
    outcomeLinked: { value: number; claimIds: string[] };
  };

  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const task = 'settings schema';

  // No pack exists yet: injected and outcome-linked are honestly zero rather than
  // back-filled from `found`.
  const bare = core.reuseMetric({ task }) as ReuseReport;
  assert.ok(bare.found.value > 0, `expected the task query to match the seeded claims, got ${bare.found.value}`);
  assert.equal(bare.packId, null, 'no pack has been written for this task yet');
  assert.equal(bare.injected.value, 0, 'nothing has been injected yet');
  assert.equal(bare.outcomeLinked.value, 0, 'nothing can be linked to an outcome yet');

  const pack = core.contextPack({ task, platform: 'haravan', includeGlobal: true, sessionId: 's-reuse', limit: 2 }) as { packId: string };
  const injectedReport = core.reuseMetric({ task }) as ReuseReport;
  assert.equal(injectedReport.packId, pack.packId, 'the metric follows the pack actually written for the task');
  assert.ok(injectedReport.injected.value > 0, 'the pack wrote claims into context');
  assert.deepEqual(
    injectedReport.injected.claimIds.filter((id) => !injectedReport.found.claimIds.includes(id)),
    [],
    'injected claims must be a subset of what the task query found',
  );
  assert.equal(injectedReport.outcomeLinked.value, 0, 'a receipt-less pack links no outcome yet');

  const receipt = core.receipt({ task, packId: pack.packId, recommendation: 'apply the seeded reuse rules' }) as { receiptId: string };
  core.ingestOutcome({ task, outcome: 'reuse verified', verificationRef: receipt.receiptId, unitId: 'u-har' });

  const linked = core.reuseMetric({ task }) as ReuseReport;
  assert.equal(linked.outcomeLinked.value, linked.injected.value, 'every injected claim is reachable from the recorded outcome');
  assert.deepEqual(linked.outcomeLinked.claimIds, linked.injected.claimIds);

  // A later pack for the same task that is never receipted must not inherit the
  // linkage: otherwise the join is echoing `injected` instead of measuring it.
  const control = core.contextPack({ task, platform: 'haravan', includeGlobal: true, sessionId: 's-control', limit: 2 }) as { packId: string };
  assert.notEqual(control.packId, pack.packId, 'a different session produces a distinct pack');
  const afterControl = core.reuseMetric({ task }) as ReuseReport;
  assert.equal(afterControl.packId, control.packId, 'the metric follows the latest pack for the task');
  assert.ok(afterControl.injected.value > 0, 'the control pack injected claims');
  assert.equal(afterControl.outcomeLinked.value, 0, 'an unreceipted pack must not report outcome linkage');

  core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('knowledgeGaps distinguishes never/stale/conflicted per platform', () => {
  const dir = fixturePlatforms();
  const core = openCore(path.join(dir, 'core.db'));
  core.importScout(dir);
  const gaps = core.knowledgeGaps({ staleDays: 90 });
  const byP: Record<string, { kind: string }> = {};
  for (const g of gaps.gaps) byP[g.platform] = g;
  assert.equal(byP['sapo'].kind, 'CONFLICTED', 'sapo: fresh claims + unresolved conflict');
  assert.equal(byP['shopify'].kind, 'STALE', 'shopify: claims exist but all old');
  core.recordPlatformSemantic({ platform: 'magento', semanticRole: 'x' });
  const gaps2 = core.knowledgeGaps({ staleDays: 90 });
  const magento = gaps2.gaps.find((g) => g.platform === 'magento');
  assert.equal(magento?.kind, 'NO_EVIDENCE', 'magento: known platform, no claims');
  core.resolveConflict({ id: 'cf-sapo', classification: 'GENERAL_RULE' });
  const gaps3 = core.knowledgeGaps({ staleDays: 90 });
  assert.equal(gaps3.gaps.find((g) => g.platform === 'sapo')?.kind, 'NONE', 'sapo covered once conflict resolved');
  core.close();
});

test('populated core.db: baseline non-empty, migration v7, isolation, perf bound', { timeout: 300000 }, () => {
  const src = path.resolve(__dirname, '..', '..', '..', '.super-core', 'core.db');
  assert.ok(fs.existsSync(src), `populated core.db required at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-real-'));
  const dst = path.join(dir, 'core.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
  }
  const core = openCore(dst); // migration 5->6 runs on the COPY, never the source
  try {
    const stats = core.stats();
    assert.ok(stats.claims >= 20000, `baseline: claims ${stats.claims} >= 20000`);
    const raw = new DatabaseSync(dst);
    const haravanCount = (raw.prepare("SELECT COUNT(*) AS n FROM claims WHERE contextPlatform = 'haravan'").get() as { n: number }).n;
    assert.ok(haravanCount >= 13000, `baseline: haravan claims ${haravanCount} >= 13000`);
    const version = (raw.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value;
    // Compared against the constant rather than a literal, so a version bump cannot
    // leave this asserting the previous chain.
    assert.equal(version, String(SCHEMA_VERSION), 'the migration chain ran to the current schema version on a populated DB');
    // The quarantine migration runs here too, against the real populated store: no row
    // may still assert a replay result that no replay produced. This is the invariant
    // the regression gate depends on, and it holds for any row set.
    const asserted = (raw.prepare('SELECT COUNT(*) AS n FROM regressions WHERE replayResult IS NOT NULL AND replayedAt IS NULL').get() as { n: number }).n;
    assert.equal(asserted, 0, 'no regression row asserts a result without a replay timestamp');
    const conflictCols = raw.prepare('PRAGMA table_info(conflicts)').all().map((c) => (c as { name: string }).name);
    assert.ok(conflictCols.includes('platform') && conflictCols.includes('unitId'), 'conflicts gained scope columns');
    const regressionCols = raw.prepare('PRAGMA table_info(regressions)').all().map((c) => (c as { name: string }).name);
    assert.ok(regressionCols.includes('checksJson') && regressionCols.includes('replayedAt'), 'regressions gained replay columns');
    raw.close();
    const sapo = core.query({ platform: 'sapo', limit: 200 });
    assert.ok(sapo.length > 0, 'positive control: sapo claims exist on real DB');
    assert.ok(sapo.every((c) => c.contextPlatform === 'sapo'), 'no cross-platform or untagged leak on real DB');
    const haravanQ = core.query({ platform: 'haravan', limit: 200 });
    assert.ok(haravanQ.length >= 100, 'positive control: haravan recall saturated');
    const t0 = Date.now();
    core.decayCheck();
    core.corpusAudit();
    assert.ok(Date.now() - t0 < 30000, `health snapshot within 30s bound (took ${Date.now() - t0}ms)`);
  } finally {
    core.close();
    // The copy is a full multi-hundred-MB database plus its WAL: leaving it in
    // the temp dir leaks that on every run.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---- Phase 4: verified learning ---------------------------------------------
// CoreP4 keeps this suite compilable against a core built before the Phase-4
// surface existed, so the same tests yield runtime fail-before evidence.
type CoreP4 = Core & {
  recordObservation(opts: { source: string; kind: string; payload?: unknown }): { observationId: string };
  replayRegression(regressionId: string): { regressionId: string; replayResult: string; replayedAt: string; checks: Array<{ kind: string; pass: boolean; detail: string }> };
};


test('ingestOutcome writes a linked observation and never self-promotes', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath) as CoreP4;
  core.importScout(dir);
  const claimsBefore = core.stats().claims;
  const out = core.ingestOutcome({ task: 'fix header', outcome: 'passed QA', verificationRef: 'rcpt-1', unitId: 'u-test' }) as { caseId: string; candidateId: string; status: string; observationId: string };
  assert.equal(out.status, 'PENDING');
  const raw = new DatabaseSync(dbPath);
  try {
    const obs = raw.prepare('SELECT * FROM observations WHERE id = ?').get(out.observationId) as { source: string; kind: string; payload: string } | undefined;
    assert.ok(obs, 'outcome writes a raw observation row');
    assert.equal(obs.source, 'ingestOutcome');
    const payload = JSON.parse(obs.payload) as Record<string, unknown>;
    assert.equal(payload.caseId, out.caseId);
    assert.equal(payload.candidateId, out.candidateId);
    const caseRow = raw.prepare('SELECT unitId, platform FROM cases WHERE caseId = ?').get(out.caseId) as { unitId: string; platform: string };
    assert.equal(caseRow.unitId, 'u-test', 'case linked to its unit');
    assert.equal(caseRow.platform, 'haravan', 'platform derived from the unit claims');
    const cand = raw.prepare('SELECT status, evidenceJson FROM candidates WHERE candidateId = ?').get(out.candidateId) as { status: string; evidenceJson: string };
    assert.equal(cand.status, 'PENDING', 'machine candidate stays pending');
    const ev = JSON.parse(cand.evidenceJson) as Record<string, unknown>;
    assert.equal(ev.caseId, out.caseId);
    assert.equal(ev.unitId, 'u-test');
    assert.equal(ev.observationId, out.observationId);
    const taskNode = raw.prepare("SELECT nodeId FROM experience_nodes WHERE kind = 'TASK' AND refId = ?").get(out.caseId) as { nodeId: string } | undefined;
    const lessonNode = raw.prepare("SELECT nodeId FROM experience_nodes WHERE kind = 'LESSON' AND refId = ?").get(out.candidateId) as { nodeId: string } | undefined;
    assert.ok(taskNode && lessonNode, 'experience nodes recorded for task and lesson');
    const produced = raw.prepare("SELECT COUNT(*) AS n FROM experience_edges WHERE fromNodeId = ? AND toNodeId = ? AND kind = 'PRODUCED'").get(taskNode.nodeId, lessonNode.nodeId) as { n: number };
    assert.equal(produced.n, 1, 'task -> lesson edge recorded');
    const verNode = raw.prepare("SELECT nodeId FROM experience_nodes WHERE kind = 'VERIFICATION' AND refId = 'rcpt-1'").get() as { nodeId: string } | undefined;
    assert.ok(verNode, 'verification node recorded for verificationRef');
  } finally { raw.close(); }
  assert.equal(core.stats().claims, claimsBefore, 'no claim materialized without adjudication');
  assert.equal(core.query({ text: 'passed QA' }).length, 0, 'outcome invisible to retrieval until promoted');
  core.close();
});

test('recordObservation is the raw producer for task-end observations', () => {
  const dir = fixtureReports();
  const core = openCore(path.join(dir, 'core.db')) as CoreP4;
  const before = (core.stats() as Record<string, number>).observations;
  const { observationId } = core.recordObservation({ source: 'task-end', kind: 'TASK_OUTCOME', payload: { task: 't1', exit: 'ok' } });
  assert.ok(observationId.startsWith('obs-'));
  assert.equal((core.stats() as Record<string, number>).observations, before + 1);
  core.close();
});

test('adjudicate is the only promotion path; scope is explicit; claim is revision-bound', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);
  const { candidateId } = core.ingestOutcome({ task: 'fix header', outcome: 'passed QA', verificationRef: 'rcpt-1', unitId: 'u-test' });
  assert.throws(() => core.adjudicate({ candidateId, decision: 'PROMOTE', authority: 'test', scope: 'staging' as never }), /invalid scope/);
  const rej = core.ingestOutcome({ task: 'bad fix', outcome: 'broke layout', unitId: 'u-test' });
  core.adjudicate({ candidateId: rej.candidateId, decision: 'REJECT', authority: 'test-authority', scope: 'acceptance-test' });
  const adj = core.adjudicate({ candidateId, decision: 'PROMOTE', authority: 'test-authority', rationale: 'verified', scope: 'acceptance-test' });
  const raw = new DatabaseSync(dbPath);
  try {
    const claim = raw.prepare('SELECT status, sourceKind FROM claims WHERE claimId = ?').get(`claim-${candidateId}`) as { status: string; sourceKind: string };
    assert.equal(claim.status, 'PROMOTED');
    const ev = raw.prepare('SELECT revision, anchor FROM evidence WHERE claimId = ?').get(`claim-${candidateId}`) as { revision: string | null; anchor: string };
    assert.equal(ev.revision, 'rcpt-1', 'promoted claim bound to the verification revision');
    assert.match(ev.anchor, /^adjudication:adj-/, 'evidence anchored to the adjudication row');
    const adjRow = raw.prepare('SELECT scope, authority FROM adjudications WHERE id = ?').get(adj.adjudicationId) as { scope: string; authority: string };
    assert.equal(adjRow.scope, 'acceptance-test');
    const rejected = raw.prepare('SELECT status FROM candidates WHERE candidateId = ?').get(rej.candidateId) as { status: string };
    assert.equal(rejected.status, 'REJECTED');
    const promoted = core.query({ text: 'passed QA' });

    assert.ok(promoted.some((c) => c.claimId === `claim-${candidateId}`), 'promoted outcome now retrievable');
  } finally { raw.close(); }
  core.close();
});

test('candidates lists the adjudication queue: PENDING by default, every status on request', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);
  const kept = core.ingestOutcome({ task: 'kept pending', outcome: 'ok', unitId: 'u-test' }) as { candidateId: string };
  const promoted = core.ingestOutcome({ task: 'promoted outcome', outcome: 'ok', unitId: 'u-test' }) as { candidateId: string };
  const pending = core.candidates() as Array<{ candidateId: string; status: string }>;
  assert.equal(pending.length, 2, 'both ingested outcomes sit in the PENDING queue');
  assert.ok(pending.every((c) => c.status === 'PENDING'));
  core.adjudicate({ candidateId: promoted.candidateId, decision: 'PROMOTE', authority: 'test-authority' });
  const after = core.candidates() as Array<{ candidateId: string }>;
  assert.deepEqual(after.map((c) => c.candidateId), [kept.candidateId], 'adjudicated candidates leave the default queue');
  const all = core.candidates({ status: 'PROMOTED' }) as Array<{ candidateId: string; status: string }>;
  assert.deepEqual(all.map((c) => c.candidateId), [promoted.candidateId], 'a status filter reads the adjudicated rows');
  core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshot/rollback round-trips claims, candidates, and adjudications', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  core.importScout(dir);
  const base = core.stats();
  const pre = core.ingestOutcome({ task: 'pre-snapshot outcome', outcome: 'kept pending', unitId: 'u-test' });
  const rel = core.snapshot('baseline');
  const countLearning = () => {
    const handle = new DatabaseSync(dbPath);
    try {
      const rowFor = (sql: string) => {
        const row = handle.prepare(sql).get() as { n: number };
        return row.n;
      };
      return {
        observations: rowFor('SELECT COUNT(*) AS n FROM observations'),
        nodes: rowFor('SELECT COUNT(*) AS n FROM experience_nodes'),
        edges: rowFor('SELECT COUNT(*) AS n FROM experience_edges'),
      };
    } finally { handle.close(); }
  };
  const atSnapshot = countLearning();
  // Post-snapshot mutations: promote the pre-existing candidate, ingest a new
  // outcome, promote it too, and invalidate a live claim.
  core.adjudicate({ candidateId: pre.candidateId, decision: 'PROMOTE', authority: 'test-authority', scope: 'acceptance-test' });
  const post = core.ingestOutcome({ task: 'post-snapshot outcome', outcome: 'promoted then rolled back', unitId: 'u-test' });
  core.adjudicate({ candidateId: post.candidateId, decision: 'PROMOTE', authority: 'test-authority', scope: 'acceptance-test' });
  core.invalidate({ entryId: 'e2' });
  const mid = core.stats();
  assert.equal(mid.candidates, base.candidates + 2);
  assert.equal(mid.claims, base.claims + 2, 'two promoted claims materialized');
  core.rollback(rel.releaseId);
  const after = core.stats();
  assert.equal(after.claims, base.claims, 'post-snapshot claims removed');
  assert.equal(after.candidates, base.candidates + 1, 'post-snapshot candidate removed, pre-snapshot kept');
  assert.equal(after.cases, base.cases + 1);
  assert.equal(after.adjudications, 0, 'post-snapshot adjudications removed');
  const raw = new DatabaseSync(dbPath);
  try {
    const cand = raw.prepare('SELECT status FROM candidates WHERE candidateId = ?').get(pre.candidateId) as { status: string };
    assert.equal(cand.status, 'PENDING', 'pre-snapshot candidate restored to PENDING');
    const c3 = raw.prepare('SELECT status FROM claims WHERE claimId = ?').get('c3') as { status: string };
    assert.equal(c3.status, 'OBSERVED', 'invalidated claim restored to snapshot status');
    // Removing a claim must take its evidence with it: the pack's evidence gate
    // and the evidence-presence check both read this table, so a row left behind
    // would satisfy them for a claim that no longer exists.
    const orphans = raw.prepare('SELECT COUNT(*) AS n FROM evidence WHERE claimId NOT IN (SELECT claimId FROM claims)').get() as { n: number };
    assert.equal(orphans.n, 0, 'no evidence may outlive the claim it anchors');
  } finally { raw.close(); }
  // The append-only learning surfaces are snapshot-bounded: the outcome ingested
  // after the snapshot must not leave observations or experience rows behind.
  assert.deepEqual(countLearning(), atSnapshot, 'post-snapshot learning rows removed by rollback');
  core.close();
});

test('replayRegression re-executes recorded checks against live state', () => {
  const dir = fixtureReports();
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath) as CoreP4;
  core.importScout(dir);
  const { caseId } = core.ingestOutcome({ task: 'replay target', outcome: 'ok', unitId: 'u-test' });
  // A caller-supplied result is refused: only a real replay may write one.
  assert.throws(() => core.recordRegression({ replayResult: 'PASS' } as never), /replayResult/);
  core.recordRegression({ newKnowledge: 'recorded but never replayed' } as never);
  const gate0 = core.checkPhaseGate('p4', 'regression');
  assert.equal(gate0.passed, false, 'recorded-but-unreplayed regression does not pass the gate');
  const { regressionId } = core.recordRegression({
    newKnowledge: 'c1 must stay live; case must persist; settings query must hit c2',
    affectedRules: ['c1'],
    affectedCases: [caseId],
    checks: [{ kind: 'query-hit', text: 'settings', platform: 'haravan', claimId: 'c2' }],
  } as never);
  const raw = new DatabaseSync(dbPath);
  try {
    const stored = raw.prepare('SELECT replayResult, replayedAt FROM regressions WHERE regressionId = ?').get(regressionId) as { replayResult: string | null; replayedAt: string | null };
    assert.equal(stored.replayResult, null, 'no result claimed before a real replay');
    const r1 = core.replayRegression(regressionId);
    assert.equal(r1.replayResult, 'PASS');
    assert.ok(r1.replayedAt);
    assert.equal(r1.checks.length, 3);
    assert.ok(r1.checks.every((c) => c.pass));
    const gate1 = core.checkPhaseGate('p4', 'regression');
    assert.equal(gate1.passed, true, 'gate passes only after a real PASS replay');
    // Mutate live state: revoking e1 kills c1 and c2, then replay again.
    core.revoke({ entryId: 'e1' });
    const r2 = core.replayRegression(regressionId);
    assert.equal(r2.replayResult, 'FAIL', 'replay detects the now-broken invariant');
    const failed = r2.checks.filter((c) => !c.pass).map((c) => c.kind);
    assert.ok(failed.includes('claim-status') && failed.includes('query-hit'));
    assert.ok(r2.checks.find((c) => c.kind === 'case-present')?.pass, 'unaffected check still passes');
    const stored2 = raw.prepare('SELECT replayResult, replayedAt FROM regressions WHERE regressionId = ?').get(regressionId) as { replayResult: string; replayedAt: string };
    assert.equal(stored2.replayResult, 'FAIL');
    assert.ok(stored2.replayedAt, 'replayedAt written by the replay');
    const gate2 = core.checkPhaseGate('p4', 'regression');
    assert.equal(gate2.passed, false, 'gate fails closed on a FAIL replay');
  } finally { raw.close(); }
  core.close();
});

test('the store opens under the locked concurrent-access mode', () => {
  // The runner, the MCP server and the app all open this one file, so the mode is the
  // condition for them not to collide. Journal mode is a property of the file, so a
  // second connection can observe it without reaching inside the owner.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mode-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const writer = new DatabaseSync(dbPath);
  const reader = new DatabaseSync(dbPath);
  try {
    const mode = writer.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(mode.journal_mode, 'wal', 'WAL is what lets a reader run during a write');

    // The property that matters: an open write transaction does not block a second
    // connection, and that connection sees the last committed state.
    writer.exec('CREATE TABLE probe (v INTEGER)');
    writer.exec('BEGIN');
    writer.prepare('INSERT INTO probe VALUES (?)').run(1);
    const during = reader.prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number };
    assert.equal(during.n, 0, 'the reader sees the last committed state, not the in-flight write');
    writer.exec('COMMIT');
    const after = reader.prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number };
    assert.equal(after.n, 1, 'the committed write is visible to the next read');
  } finally {
    writer.close();
    reader.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the task's latest pack is the last issued, not the first created", () => {
  // A pack keeps its identity per (task, platform, session) and refreshes in place, so a
  // re-issued pack holds its first createdAt while lastIssuedAt moves. "Latest" has to
  // mean the re-issue for the reuse metric to report the pack the task actually uses.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-issue-order-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const raw = new DatabaseSync(dbPath);
  try {
    core.importScout(fixtureReports());
    const task = 'package.json declares name=demo';
    const first = core.contextPack({ task, sessionId: 's-first', platform: 'haravan' });
    const second = core.contextPack({ task, sessionId: 's-second', platform: 'haravan' });
    assert.notEqual(first.packId, second.packId, 'two sessions are two packs');

    // Pin the times so the result cannot depend on clock resolution: the re-issued pack
    // is the older row by createdAt and the newer one by lastIssuedAt.
    const pin = raw.prepare('UPDATE packs SET createdAt = ?, lastIssuedAt = ? WHERE packId = ?');
    pin.run('2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', first.packId);
    pin.run('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', second.packId);

    const metric = core.reuseMetric({ task });
    assert.equal(metric.packId, first.packId, 'the re-issued pack is the latest');
    assert.deepEqual(metric.injected.claimIds, first.claims.map((c) => c.claimId).sort());

    // Rows written before the column existed carry NULL and must fall back to createdAt.
    raw.prepare('UPDATE packs SET lastIssuedAt = NULL WHERE packId = ?').run(first.packId);
    assert.equal(core.reuseMetric({ task }).packId, second.packId, 'NULL lastIssuedAt falls back to createdAt');
  } finally {
    raw.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('reuseMetric deterministically tiebreaks packs with identical lastIssuedAt timestamps', () => {
  // When multiple packs for the same task tie on lastIssuedAt (or same-ms re-issue/creation),
  // reuseMetric must deterministically select the latest pack via stable tiebreaker
  // (rowid/packId), without ambiguity across sessions or platforms.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-tiebreak-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const raw = new DatabaseSync(dbPath);
  try {
    core.importScout(fixtureReports());
    const task = 'package.json declares name=demo';
    const first = core.contextPack({ task, sessionId: 's-first', platform: 'haravan' });
    const second = core.contextPack({ task, sessionId: 's-second', platform: 'shopify' });
    assert.notEqual(first.packId, second.packId, 'two sessions/platforms are two packs');

    // 1. Force identical lastIssuedAt across the two packs.
    // By insertion order, 'second' has the higher rowid.
    const pin = raw.prepare('UPDATE packs SET createdAt = ?, lastIssuedAt = ? WHERE packId = ?');
    const tiedTimestamp = '2025-06-01T12:00:00.000Z';
    pin.run('2025-01-01T00:00:00.000Z', tiedTimestamp, first.packId);
    pin.run('2025-02-01T00:00:00.000Z', tiedTimestamp, second.packId);

    // Repeated queries must deterministically return the same winning pack (stable tiebreak).
    for (let i = 0; i < 5; i++) {
      const metric = core.reuseMetric({ task });
      assert.equal(metric.packId, second.packId, 'identical lastIssuedAt tiebreaks deterministically to the latest inserted pack');
      assert.deepEqual(metric.injected.claimIds, second.claims.map((c) => c.claimId).sort());
    }

    // 2. Force identical createdAt AND identical lastIssuedAt (same-millisecond creation + re-issue).
    const pinAll = raw.prepare('UPDATE packs SET createdAt = ?, lastIssuedAt = ? WHERE task = ?');
    pinAll.run(tiedTimestamp, tiedTimestamp, task);

    for (let i = 0; i < 5; i++) {
      const metric = core.reuseMetric({ task });
      assert.equal(metric.packId, second.packId, 'identical createdAt and lastIssuedAt tiebreaks deterministically by rowid/packId');
    }

    // 3. Prove timestamp precedence: if the older row is re-issued even 1ms later, it wins over rowid.
    raw.prepare('UPDATE packs SET lastIssuedAt = ? WHERE packId = ?').run('2025-06-01T12:00:00.001Z', first.packId);
    assert.equal(core.reuseMetric({ task }).packId, first.packId, 'strictly newer lastIssuedAt wins over higher rowid');

    // 4. Invert: if second is re-issued later, second wins again.
    raw.prepare('UPDATE packs SET lastIssuedAt = ? WHERE packId = ?').run('2025-06-01T12:00:00.002Z', second.packId);
    assert.equal(core.reuseMetric({ task }).packId, second.packId, 'newer lastIssuedAt on second pack wins');
  } finally {
    raw.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('namespace is recorded and backfilled across claims, cases, and decisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ns-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const raw = new DatabaseSync(dbPath);
  try {
    // 1. Verify schemaVersion is bumped to 10
    const version = (raw.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value;
    assert.equal(version, '10', 'SCHEMA_VERSION is 10');

    // 2. Import scout fixtures
    core.importScout(fixtureReports());
    
    // Claims with contextPlatform='haravan' should have namespace='PLATFORM_KNOWLEDGE'
    const c1 = raw.prepare("SELECT namespace FROM claims WHERE claimId = 'c1'").get() as { namespace: string };
    assert.equal(c1.namespace, 'PLATFORM_KNOWLEDGE', 'platform-linked claim gets PLATFORM_KNOWLEDGE');

    // 3. Ingest outcome with learning loop
    const out = core.ingestOutcome({
      task: 'AntiFan desktop agent cursor stabilization',
      outcome: 'cursor click verified without focus loss',
      unitId: 'u-antifan-core',
    });
    const cCase = raw.prepare('SELECT namespace FROM cases WHERE caseId = ?').get(out.caseId) as { namespace: string };
    assert.equal(cCase.namespace, 'ANTIFAN_ENGINEERING', 'antifan engineering task gets ANTIFAN_ENGINEERING');

    // 4. Adjudicate candidate -> promoted claim inherits namespace
    core.adjudicate({ candidateId: out.candidateId, decision: 'PROMOTE', authority: 'test-qa' });
    const pClaim = raw.prepare('SELECT namespace FROM claims WHERE claimId = ?').get(`claim-${out.candidateId}`) as { namespace: string };
    assert.equal(pClaim.namespace, 'ANTIFAN_ENGINEERING', 'promoted claim inherits ANTIFAN_ENGINEERING');

    // 5. Personal principles get PERSONAL_PRACTICE
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt)
      VALUES ('c-prin-1', 'u-test', 'Never guess elided lines without reading fresh source', 'PRINCIPLE', 'ACTIVE', 'v1', ?)`).run(new Date().toISOString());
    raw.exec(NAMESPACE_BACKFILL_SQL);
    const prin = raw.prepare("SELECT namespace FROM claims WHERE claimId = 'c-prin-1'").get() as { namespace: string };
    assert.equal(prin.namespace, 'PERSONAL_PRACTICE', 'principles get PERSONAL_PRACTICE namespace');
  } finally {
    raw.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same-namespace matches are ranked above cross-namespace at equal similarity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ns-rank-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const raw = new DatabaseSync(dbPath);
  try {
    // Seed two claims with identical text match and status, but different namespaces
    const nowStr = new Date().toISOString();
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt, namespace)
      VALUES ('claim-plat', 'u-test', 'DOM tree snapshot serialization algorithm', 'RULE', 'ACTIVE', 'v1', ?, 'PLATFORM_KNOWLEDGE')`).run(nowStr);
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt, namespace)
      VALUES ('claim-eng', 'u-test', 'DOM tree snapshot serialization algorithm', 'RULE', 'ACTIVE', 'v1', ?, 'ANTIFAN_ENGINEERING')`).run(nowStr);
    
    // Add identical dummy evidence for both so evidenceScore matches
    raw.prepare("INSERT INTO evidence(id, claimId, revision) VALUES ('ev-1', 'claim-plat', 'rev1')").run();
    raw.prepare("INSERT INTO evidence(id, claimId, revision) VALUES ('ev-2', 'claim-eng', 'rev1')").run();

    // Index in FTS
    raw.prepare("INSERT INTO claims_fts(rowid, statement, kind, unitId, claimId) VALUES (1, 'DOM tree snapshot serialization algorithm', 'RULE', 'u-test', 'claim-plat')").run();
    raw.prepare("INSERT INTO claims_fts(rowid, statement, kind, unitId, claimId) VALUES (2, 'DOM tree snapshot serialization algorithm', 'RULE', 'u-test', 'claim-eng')").run();

    // Query targeting ANTIFAN_ENGINEERING
    const hitsEng = core.query({ text: 'DOM tree snapshot', namespace: 'ANTIFAN_ENGINEERING' });
    assert.equal(hitsEng.length, 2, 'both claims match text');
    assert.equal(hitsEng[0].claimId, 'claim-eng', 'same-namespace (ANTIFAN_ENGINEERING) ranked first');
    assert.equal(hitsEng[1].claimId, 'claim-plat', 'cross-namespace (PLATFORM_KNOWLEDGE) ranked second');
    assert.ok(hitsEng[0].score > hitsEng[1].score, 'same-namespace has higher score than cross-namespace');

    // Query targeting PLATFORM_KNOWLEDGE
    const hitsPlat = core.query({ text: 'DOM tree snapshot', namespace: 'PLATFORM_KNOWLEDGE' });
    assert.equal(hitsPlat.length, 2, 'both claims match text');
    assert.equal(hitsPlat[0].claimId, 'claim-plat', 'same-namespace (PLATFORM_KNOWLEDGE) ranked first');
    assert.equal(hitsPlat[1].claimId, 'claim-eng', 'cross-namespace (ANTIFAN_ENGINEERING) ranked second');
    assert.ok(hitsPlat[0].score > hitsPlat[1].score, 'same-namespace has higher score than cross-namespace');
  } finally {
    raw.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('low confidence or namespace mismatch triggers explicit abstention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ns-abstain-'));
  const dbPath = path.join(dir, 'core.db');
  const core = openCore(dbPath);
  const raw = new DatabaseSync(dbPath);
  try {
    const nowStr = new Date().toISOString();
    // Seed two claims in PLATFORM_KNOWLEDGE with platform 'haravan'
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt, contextPlatform, namespace)
      VALUES ('c-har-1', 'u-har', 'Liquid template rendering engine in Haravan', 'RULE', 'ACTIVE', 'v1', ?, 'haravan', 'PLATFORM_KNOWLEDGE')`).run(nowStr);
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt, contextPlatform, namespace)
      VALUES ('c-har-2', 'u-har', 'Liquid template rendering filters in Haravan', 'RULE', 'ACTIVE', 'v1', ?, 'haravan', 'PLATFORM_KNOWLEDGE')`).run(nowStr);

    raw.prepare("INSERT INTO evidence(id, claimId, revision) VALUES ('ev-h1', 'c-har-1', 'rev1')").run();
    raw.prepare("INSERT INTO evidence(id, claimId, revision) VALUES ('ev-h2', 'c-har-2', 'rev1')").run();

    raw.prepare("INSERT INTO claims_fts(rowid, statement, kind, unitId, claimId) VALUES (1, 'Liquid template rendering engine in Haravan', 'RULE', 'u-har', 'c-har-1')").run();
    raw.prepare("INSERT INTO claims_fts(rowid, statement, kind, unitId, claimId) VALUES (2, 'Liquid template rendering filters in Haravan', 'RULE', 'u-har', 'c-har-2')").run();

    // 1. Query for the matching platform knowledge task -> does NOT abstain
    const matchedPack = core.contextPackV2({ task: 'Liquid template rendering', platform: 'haravan', namespace: 'PLATFORM_KNOWLEDGE' });
    assert.equal(matchedPack.abstained, false, 'matching platform and namespace does not abstain');
    assert.ok(['HIGH', 'MEDIUM'].includes(matchedPack.confidence), 'confidence is high or medium for matched knowledge');

    // 2. Query targeting PERSONAL_PRACTICE when only PLATFORM_KNOWLEDGE exists -> NAMESPACE_MISMATCH abstention
    const mismatchPack = core.contextPackV2({ task: 'Liquid template rendering', namespace: 'PERSONAL_PRACTICE' });
    assert.equal(mismatchPack.abstained, true, 'namespace mismatch forces abstention');
    assert.equal(mismatchPack.reasonCode, 'NAMESPACE_MISMATCH', 'reasonCode is NAMESPACE_MISMATCH');
    assert.equal(mismatchPack.confidence, 'UNKNOWN', 'confidence is UNKNOWN on abstention');
    assert.equal(mismatchPack.confidenceScore, null, 'confidenceScore is null when abstaining');

    // 3. Recommend also triggers abstention on namespace mismatch
    const mismatchRec = core.recommend({ task: 'Liquid template rendering', namespace: 'PERSONAL_PRACTICE' });
    assert.equal(mismatchRec.abstained, true, 'recommend abstains on namespace mismatch');
    assert.equal(mismatchRec.reasonCode, 'NAMESPACE_MISMATCH');
    assert.ok(mismatchRec.recommendation.startsWith('ABSTAIN: NAMESPACE_MISMATCH'));

    // 4. Low scoring match triggers LOW_CONFIDENCE abstention
    // Seed a weak claim with OBSERVED status, no evidence, older date
    raw.prepare(`INSERT INTO claims(claimId, unitId, statement, kind, status, extractorVersion, createdAt, namespace)
      VALUES ('c-weak', 'u-weak', 'quantum entanglement in electron tunneling', 'OBSERVED', 'OBSERVED', 'v1', '2020-01-01T00:00:00.000Z', 'ANTIFAN_ENGINEERING')`).run();
    raw.prepare("INSERT INTO claims_fts(rowid, statement, kind, unitId, claimId) VALUES (3, 'quantum entanglement in electron tunneling', 'OBSERVED', 'u-weak', 'c-weak')").run();

    const weakPack = core.contextPackV2({ task: 'quantum entanglement', namespace: 'ANTIFAN_ENGINEERING' });
    assert.equal(weakPack.abstained, true, 'weak low-scoring match abstains');
    assert.ok(['LOW_CONFIDENCE', 'INSUFFICIENT_EVIDENCE'].includes(weakPack.reasonCode as string), 'abstain reason is LOW_CONFIDENCE or INSUFFICIENT_EVIDENCE');
  } finally {
    raw.close();
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
