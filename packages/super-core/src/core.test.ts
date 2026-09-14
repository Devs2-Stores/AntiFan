// Core acceptance tests: restart, idempotency, platform isolation, abstention,
// learning lifecycle, rollback, revocation. Uses a fixture reports dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openCore } from './index.js';

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
