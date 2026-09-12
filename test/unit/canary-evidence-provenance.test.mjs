/**
 * Provenance invariants: mint the bundle identity once, verify the entry the tab
 * was actually served, report drift without re-identifying, resolve artifacts
 * through the published pointer, and reclaim a campaign lock only from a holder
 * the process-identity adapter can prove dead.
 *
 * Every fixture is a fresh temp directory and every path is passed explicitly:
 * the real campaign artifacts are never read or written, and the host's
 * `.canary/state/canary-instance.json` / session file plays no part.
 *
 * Run: node --test test/unit/canary-evidence-provenance.test.mjs
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { removeRecordIf, writeRecordAtomic } from '../../scripts/lib/atomic-record.mjs';
import { acquireCampaignLock, LOCK_CODES } from '../../scripts/lib/campaign-lock.mjs';
import {
  PAGE_POINTER_FILE,
  PROVENANCE_CODES,
  detectBundleDrift,
  loadInstanceIdentity,
  mintBundleIdentity,
  readPagePointer,
  resolvePageArtifacts,
  selectCandidateEntryForViewport,
  verifyServedEntry,
  writePagePointer,
} from '../../scripts/lib/evidence-provenance.mjs';
import { proveHolderDead } from '../../scripts/lib/process-identity.mjs';

const fixtures = [];

/** A fresh fixture directory; removed wholesale once the file finishes. */
function fixtureDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `canary-${label}-`));
  fixtures.push(dir);
  return dir;
}

function writeEntry(entryPath, html) {
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, html);
  return entryPath;
}

/** An independent digest, computed without the module under test. */
const digestOf = (value) => crypto.createHash('sha256').update(value).digest('hex');

after(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

describe('minted bundle identity', () => {
  it('records the digest and byte count of the entry the build wrote', () => {
    const dir = fixtureDir('mint');
    const entry = writeEntry(path.join(dir, 'attempts', 'a1', 'clone', 'index.html'), '<html><body>attempt one</body></html>\n');
    const evidenceRoot = path.join(dir, 'attempts', 'a1', 'evidence');
    const identity = mintBundleIdentity({
      entryPath: entry,
      sourceUrl: 'https://example.test/product',
      attemptId: 'a1',
      evidenceRoot,
    });

    const bytes = fs.readFileSync(entry);
    assert.equal(identity.entrySha256, digestOf(bytes));
    assert.equal(identity.entryBytes, bytes.length);
    assert.equal(identity.entryPath, path.resolve(entry));
    assert.equal(identity.attemptId, 'a1');
    assert.equal(identity.evidenceRoot, path.resolve(evidenceRoot));
    assert.equal(identity.sourceUrl, 'https://example.test/product');
    assert.equal(typeof identity.generatedAt, 'string');

    const servedFromDisk = verifyServedEntry(identity, entry);
    assert.equal(servedFromDisk.ok, true);
    assert.equal(servedFromDisk.sha256, identity.entrySha256);
    assert.equal(servedFromDisk.bytes, identity.entryBytes);

    const servedFromBytes = verifyServedEntry(identity, bytes);
    assert.equal(servedFromBytes.ok, true);
    assert.equal(servedFromBytes.sha256, identity.entrySha256);
  });

  it('refuses a served entry that is not the minted one, and names both digests', () => {
    const dir = fixtureDir('mismatch');
    const entry = writeEntry(path.join(dir, 'clone', 'index.html'), '<html>the minted entry</html>');
    const identity = mintBundleIdentity({ entryPath: entry, attemptId: 'a2' });
    const foreign = writeEntry(path.join(dir, 'other-attempt', 'clone', 'index.html'), '<html>a different bundle entirely</html>');

    const refused = verifyServedEntry(identity, foreign);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, PROVENANCE_CODES.IDENTITY_MISMATCH);
    assert.equal(refused.expected, identity.entrySha256);
    assert.equal(refused.observed, digestOf(fs.readFileSync(foreign)));
    assert.notEqual(refused.observed, refused.expected);

    const absent = verifyServedEntry(identity, path.join(dir, 'clone', 'deleted.html'));
    assert.equal(absent.ok, false);
    assert.equal(absent.code, PROVENANCE_CODES.IDENTITY_MISMATCH);

    const nothingServed = verifyServedEntry(identity, null);
    assert.equal(nothingServed.ok, false);
    assert.equal(nothingServed.code, PROVENANCE_CODES.IDENTITY_MISMATCH);
  });

  it('refuses when no identity was carried into the case', () => {
    const dir = fixtureDir('no-identity');
    const entry = writeEntry(path.join(dir, 'clone', 'index.html'), '<html>unidentified</html>');

    const noIdentity = verifyServedEntry(null, entry);
    assert.equal(noIdentity.ok, false);
    assert.equal(noIdentity.code, PROVENANCE_CODES.IDENTITY_MISSING);

    const digestless = verifyServedEntry({ entryPath: entry }, entry);
    assert.equal(digestless.ok, false);
    assert.equal(digestless.code, PROVENANCE_CODES.IDENTITY_MISSING);
  });
});

describe('drift after the mint', () => {
  it('reports a post-mint rewrite as drift and leaves the published identity untouched', () => {
    const dir = fixtureDir('drift');
    const entry = writeEntry(path.join(dir, 'clone', 'index.html'), '<html>as built</html>');
    const identity = mintBundleIdentity({ entryPath: entry, attemptId: 'a3', evidenceRoot: path.join(dir, 'evidence') });
    writePagePointer(dir, { identity, cloneDir: path.dirname(entry), viewports: ['1440x900'] });

    const rewritten = '<html>rewritten after the build returned</html>';
    fs.writeFileSync(entry, rewritten);

    const drift = detectBundleDrift(identity);
    assert.equal(drift.drifted, true);
    assert.equal(drift.expected, identity.entrySha256);
    assert.equal(drift.observed, digestOf(rewritten));
    assert.equal(drift.entryPath, identity.entryPath);

    const pointer = readPagePointer(dir);
    assert.equal(pointer.entrySha256, identity.entrySha256);
    assert.equal(pointer.entryBytes, identity.entryBytes);
    assert.equal(pointer.attemptId, 'a3');
  });
});

describe('published pointer', () => {
  it('resolves the newest attempt and ignores a half-written pointer', () => {
    const pageDir = fixtureDir('pointer');
    const cloneA = path.join(pageDir, 'attempts', 'a', 'clone');
    const evidenceA = path.join(pageDir, 'attempts', 'a', 'evidence');
    const identityA = mintBundleIdentity({
      entryPath: writeEntry(path.join(cloneA, 'index.html'), '<html>attempt A</html>'),
      attemptId: 'a',
      evidenceRoot: evidenceA,
    });
    writePagePointer(pageDir, { identity: identityA, cloneDir: cloneA, viewports: ['1440x900'] });
    assert.equal(readPagePointer(pageDir).attemptId, 'a');

    // A writer that died between its temp write and its rename leaves only a
    // dot-prefixed temp file; readers must still see the whole of A.
    const residue = path.join(pageDir, `.${PAGE_POINTER_FILE}.tmp-999999-deadbeef`);
    fs.writeFileSync(residue, `{"attemptId":"b","entrySha256":`);
    const duringInterruption = resolvePageArtifacts(pageDir);
    assert.equal(duringInterruption.legacy, false);
    assert.equal(duringInterruption.attemptId, 'a');
    assert.equal(duringInterruption.cloneDir, path.resolve(cloneA));
    assert.equal(duringInterruption.evidenceDir, path.resolve(evidenceA));
    assert.equal(readPagePointer(pageDir).attemptId, 'a');
    fs.unlinkSync(residue);

    const cloneB = path.join(pageDir, 'attempts', 'b', 'clone');
    const identityB = mintBundleIdentity({
      entryPath: writeEntry(path.join(cloneB, 'index.html'), '<html>attempt B</html>'),
      attemptId: 'b',
      evidenceRoot: path.join(pageDir, 'attempts', 'b', 'evidence'),
    });
    writePagePointer(pageDir, { identity: identityB, cloneDir: cloneB, viewports: ['1440x900'] });

    const published = readPagePointer(pageDir);
    assert.equal(published.attemptId, 'b');
    assert.equal(published.entrySha256, identityB.entrySha256);
    assert.equal(published.entryBytes, identityB.entryBytes);
    assert.notEqual(published.entrySha256, identityA.entrySha256);
  });

  it('falls back to the legacy page layout when nothing was published', () => {
    const pageDir = fixtureDir('legacy');
    const artifacts = resolvePageArtifacts(pageDir);
    assert.equal(artifacts.legacy, true);
    assert.equal(artifacts.attemptId, null);
    assert.equal(artifacts.pointer, null);
    assert.equal(artifacts.evidenceDir, path.resolve(pageDir, 'evidence'));
    assert.equal(artifacts.cloneDir, path.resolve(pageDir, 'clone'));
    assert.equal(artifacts.mobileCloneDir, path.resolve(pageDir, 'clone', 'mobile'));
  });

  it('publishes and resolves a unified responsive candidate across all viewports without mobileCloneDir', () => {
    const pageDir = fixtureDir('unified');
    const cloneDir = path.join(pageDir, 'attempts', 'unified-attempt', 'clone');
    const evidenceDir = path.join(pageDir, 'attempts', 'unified-attempt', 'evidence');
    const entryPath = writeEntry(path.join(cloneDir, 'index.html'), '<html lang="vi"><head><style>@media(max-width:767px){body{font-size:14px}}</style></head><body>unified storefront</body></html>');
    const identity = mintBundleIdentity({
      entryPath,
      attemptId: 'unified-attempt',
      evidenceRoot: evidenceDir,
      sourceUrl: 'https://example.com/storefront',
    });

    // Unified publication: single candidate entry, mobileCloneDir is null
    writePagePointer(pageDir, {
      identity,
      cloneDir,
      mobileCloneDir: null,
      viewports: {
        '1440': { verdict: 'PASS', status: 'COMPLETED' },
        '1024': { verdict: 'PASS', status: 'COMPLETED' },
        '390': { verdict: 'PASS', status: 'COMPLETED' },
      },
    });

    const published = readPagePointer(pageDir);
    assert.equal(published.attemptId, 'unified-attempt');
    assert.equal(published.mobileCloneDir, null);
    assert.equal(published.entryPath, entryPath);
    assert.equal(published.entrySha256, identity.entrySha256);

    const resolved = resolvePageArtifacts(pageDir);
    assert.equal(resolved.legacy, false);
    assert.equal(resolved.attemptId, 'unified-attempt');
    assert.equal(resolved.cloneDir, path.resolve(cloneDir));
    assert.equal(resolved.mobileCloneDir, null);

    // Strict candidate selection & provenance: every viewport selects the exact same candidate
    for (const [vpLabel, width] of [['1440', 1440], ['1024', 1024], ['390', 390]]) {
      const selection = selectCandidateEntryForViewport({
        bundleIdentity: identity,
        cloneDir,
        viewport: { label: vpLabel, width },
      });
      assert.equal(selection.ok, true, `viewport ${vpLabel} must select candidate successfully`);
      assert.equal(selection.entryPath, entryPath);

      const verified = verifyServedEntry(identity, selection.entryPath);
      assert.equal(verified.ok, true, `viewport ${vpLabel} must verify against the minted candidate identity`);
      assert.equal(verified.sha256, identity.entrySha256);
    }

    // If a runner or caller attempts to supply or substitute a different entry for mobile, it is refused
    const foreignMobile = writeEntry(path.join(cloneDir, 'mobile', 'index.html'), '<html>separate mobile</html>');
    const foreignSelection = selectCandidateEntryForViewport({
      bundleIdentity: identity,
      cloneDir,
      viewport: { label: '390', width: 390 },
      candidateEntry: foreignMobile,
    });
    assert.equal(foreignSelection.ok, false);
    assert.equal(foreignSelection.code, PROVENANCE_CODES.IDENTITY_MISMATCH);

    const foreignCheck = verifyServedEntry(identity, foreignMobile);
    assert.equal(foreignCheck.ok, false);
    assert.equal(foreignCheck.code, PROVENANCE_CODES.IDENTITY_MISMATCH);
  });
});

describe('record removal', () => {
  it('removes only the record the predicate matches', () => {
    const dir = fixtureDir('remove');
    const recordPath = path.join(dir, 'record.json');
    writeRecordAtomic(recordPath, { pid: 4242, processStartToken: 'token-a' });
    const before = fs.readFileSync(recordPath, 'utf8');

    const refused = removeRecordIf(recordPath, (record) => record.pid === 999999);
    assert.equal(refused.removed, false);
    assert.equal(refused.reason, 'NOT_OWNER');
    assert.equal(fs.readFileSync(recordPath, 'utf8'), before);

    const removed = removeRecordIf(recordPath, (record) => record.processStartToken === 'token-a');
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(recordPath), false);
  });
});

describe('instance identity', () => {
  it('maps the session document and returns null when it is absent', () => {
    const dir = fixtureDir('session');
    const sessionPath = path.join(dir, 'state', 'canary-session.json');
    writeRecordAtomic(sessionPath, {
      instancePid: 4242,
      instanceStartedAt: '2026-09-10T15:20:00.540Z',
      instanceProcessStartToken: '2026-09-10T15:20:00.5408760Z',
      instanceProcessStartTokenFormat: 'win32:CreationDate',
      bridgePort: 20131,
    });

    const identity = loadInstanceIdentity(sessionPath);
    assert.equal(identity.pid, 4242);
    assert.equal(identity.startedAt, '2026-09-10T15:20:00.540Z');
    assert.equal(identity.processStartToken, '2026-09-10T15:20:00.5408760Z');
    assert.equal(identity.processStartTokenFormat, 'win32:CreationDate');
    assert.equal(identity.bridgePort, 20131);

    assert.equal(loadInstanceIdentity(path.join(dir, 'state', 'absent.json')), null);
  });
});

describe('lock holder proof', () => {
  it('treats a record without a start token as unverifiable and an invalid pid as dead', async () => {
    const unverifiable = await proveHolderDead({ pid: process.pid });
    assert.equal(unverifiable.dead, false);
    assert.equal(unverifiable.reason, 'UNVERIFIABLE');

    const invalidPid = await proveHolderDead({ pid: -7 });
    assert.equal(invalidPid.dead, true);
    assert.equal(invalidPid.reason, 'PID_INVALID');

    const nonNumericPid = await proveHolderDead({ pid: 'not-a-pid' });
    assert.equal(nonNumericPid.dead, true);
    assert.equal(nonNumericPid.reason, 'PID_INVALID');
  });
});

describe('campaign lock', () => {
  it('refuses a second acquisition while the live holder owns it, and writes nothing', async () => {
    const dir = fixtureDir('lock-live');
    const lockPath = path.join(dir, '.campaign.lock');

    const first = await acquireCampaignLock({ lockPath, runId: 'run-live', attemptId: 'attempt-live' });
    assert.equal(first.ok, true);
    assert.equal(first.code, LOCK_CODES.ACQUIRED);
    assert.equal(first.holder.pid, process.pid);
    const held = fs.readFileSync(lockPath, 'utf8');

    const second = await acquireCampaignLock({ lockPath, runId: 'run-live-second' });
    assert.equal(second.ok, false);
    assert.equal(second.code, LOCK_CODES.RUN_IN_PROGRESS);
    assert.equal(second.holder.pid, process.pid);
    assert.equal(second.holder.runId, 'run-live');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), held);
  });

  it('never reclaims a lock whose pid is alive and whose start token matches', async () => {
    const dir = fixtureDir('lock-owned');
    const lockPath = path.join(dir, '.campaign.lock');

    const first = await acquireCampaignLock({ lockPath, runId: 'run-owned' });
    assert.equal(first.code, LOCK_CODES.ACQUIRED);

    const second = await acquireCampaignLock({ lockPath, runId: 'run-owned-second' });
    assert.equal(second.ok, false);
    assert.equal(second.code, LOCK_CODES.RUN_IN_PROGRESS);
    assert.equal(second.reclaimedFrom, undefined);
    assert.equal(second.proof.reason, 'ALIVE');
    assert.equal(second.proof.dead, false);
  });

  it('reclaims a lock whose recorded pid is gone', async (t) => {
    const dir = fixtureDir('lock-dead');
    const lockPath = path.join(dir, '.campaign.lock');

    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = child.pid;
    await once(child, 'exit');
    writeRecordAtomic(lockPath, { runId: 'run-dead', pid: deadPid, startedAt: '1970-01-01T00:00:00.000Z' });

    const proof = await proveHolderDead({ pid: deadPid });
    if (proof.reason !== 'PID_ABSENT') {
      t.skip(`pid ${deadPid} is not observable as absent on this host (${proof.reason}); the OS reused it`);
      return;
    }

    const acquired = await acquireCampaignLock({ lockPath, runId: 'run-after-death' });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.code, LOCK_CODES.RECLAIMED);
    assert.equal(acquired.reclaimedFrom.holder.pid, deadPid);
    assert.equal(acquired.reclaimedFrom.proof.reason, 'PID_ABSENT');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).runId, 'run-after-death');
  });

  it('reclaims a lock whose live pid now carries a different start token', async () => {
    const dir = fixtureDir('lock-reuse');
    const lockPath = path.join(dir, '.campaign.lock');

    const first = await acquireCampaignLock({ lockPath, runId: 'run-reuse' });
    assert.equal(first.code, LOCK_CODES.ACQUIRED);

    // Same live pid, same token format, foreign start token: the pid was reused.
    const recorded = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    writeRecordAtomic(lockPath, { ...recorded, processStartToken: 'not-the-real-token' });

    const second = await acquireCampaignLock({ lockPath, runId: 'run-reuse-next' });
    assert.equal(second.ok, true);
    assert.equal(second.code, LOCK_CODES.RECLAIMED);
    assert.equal(second.reclaimedFrom.holder.pid, process.pid);
    assert.equal(second.reclaimedFrom.proof.reason, 'START_TOKEN_MISMATCH');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).runId, 'run-reuse-next');
  });
});
