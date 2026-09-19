/**
 * Guarded dead-store cleaner tests (real fs, no Electron).
 *
 * Every case here defends a deletion decision: what the guard must refuse, and
 * what the pass must actually reclaim. The fixture is a real temporary tree, so
 * a passing case means directories and files are gone or present on disk, not
 * that a mock was called.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeadPartitionName, pruneDeadStores } from '../../src/main/browser/dead-store-cleaner';

const LEGACY_CAPSULE = 'capsule-capsule-4f9c1b2e-77aa-4c6f-9d10-8b2c5e0a1f33';
const REPREFIXED_COPY = 'profile-capsule-9a1d0c33-1111-4222-8333-444455556666';
const LIVE_PROFILE = 'profile-profile-2';

let root: string;
let profileDir: string;
let configDir: string;

/** Two days ago: older than every quiet period the cleaner applies. */
const QUIET_MTIME = new Date(Date.now() - 48 * 60 * 60 * 1000);

function writeFile(target: string, content: string, mtime?: Date): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mtime) fs.utimesSync(target, mtime, mtime);
}

function makePartition(name: string, bytes: number): string {
  const dir = path.join(profileDir, 'Partitions', name);
  writeFile(path.join(dir, 'Cookies'), 'x'.repeat(bytes));
  return dir;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dead-store-'));
  profileDir = path.join(root, 'Profile');
  configDir = path.join(root, 'config');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isDeadPartitionName', () => {
  it('matches only the two unreachable namespaces', () => {
    assert.strictEqual(isDeadPartitionName(LEGACY_CAPSULE), true);
    assert.strictEqual(isDeadPartitionName(REPREFIXED_COPY), true);
    // Live shapes a resolver derives, and Chromium's own stores.
    assert.strictEqual(isDeadPartitionName(LIVE_PROFILE), false);
    assert.strictEqual(isDeadPartitionName('profile-default'), false);
    assert.strictEqual(isDeadPartitionName('profile-profile-10'), false);
    assert.strictEqual(isDeadPartitionName('ephemeral-abc'), false);
    assert.strictEqual(isDeadPartitionName('capsule-capsule'), false);
    assert.strictEqual(isDeadPartitionName('capsule-capsule-'), false);
  });
});

describe('pruneDeadStores', () => {
  it('reclaims dead partitions and leaves live ones untouched, then reports zero on a second pass', () => {
    const legacy = makePartition(LEGACY_CAPSULE, 2048);
    const copy = makePartition(REPREFIXED_COPY, 1024);
    const live = makePartition(LIVE_PROFILE, 4096);

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: ['persist:' + LIVE_PROFILE] });

    assert.strictEqual(fs.existsSync(legacy), false);
    assert.strictEqual(fs.existsSync(copy), false);
    assert.strictEqual(fs.existsSync(path.join(live, 'Cookies')), true);
    assert.deepStrictEqual(report.deletedPartitions.sort(), [LEGACY_CAPSULE, REPREFIXED_COPY].sort());
    assert.strictEqual(report.deletedFiles.length, 0);
    assert.strictEqual(report.reclaimedBytes, 3072);
    assert.deepStrictEqual(report.errors, []);

    const second = pruneDeadStores({ profileDir, configDir, livePartitions: ['persist:' + LIVE_PROFILE] });
    assert.deepStrictEqual(second.deletedPartitions, []);
    assert.strictEqual(second.reclaimedBytes, 0);
    assert.strictEqual(second.scannedCount, 0);
  });

  it('refuses to delete a dead-named partition a tab still owns', () => {
    const legacy = makePartition(LEGACY_CAPSULE, 512);

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [`persist:${LEGACY_CAPSULE}`] });

    assert.strictEqual(fs.existsSync(path.join(legacy, 'Cookies')), true);
    assert.deepStrictEqual(report.deletedPartitions, []);
    assert.deepStrictEqual(report.skippedPartitions, [LEGACY_CAPSULE]);
    assert.strictEqual(report.reclaimedBytes, 0);
  });

  it('reports the inventory without deleting anything in dry-run mode', () => {
    const legacy = makePartition(LEGACY_CAPSULE, 256);

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [], dryRun: true });

    assert.strictEqual(fs.existsSync(path.join(legacy, 'Cookies')), true);
    assert.deepStrictEqual(report.deletedPartitions, [LEGACY_CAPSULE]);
    assert.strictEqual(report.dryRun, true);
    assert.strictEqual(report.reclaimedBytes, 256);

    pruneDeadStores({ profileDir, configDir, livePartitions: [] });
  });

  it('reclaims the stale state duplicate only while the live state file exists', () => {
    const liveState = path.join(profileDir, 'saved-tabs.json');
    const staleState = path.join(configDir, 'saved-tabs.json');
    writeFile(staleState, '{"tabs":[1]}');

    // Live copy absent: the config copy is the only record, so it must survive.
    fs.rmSync(liveState, { force: true });
    assert.strictEqual(pruneDeadStores({ profileDir, configDir, livePartitions: [] }).deletedFiles.length, 0);
    assert.strictEqual(fs.existsSync(staleState), true);

    writeFile(liveState, '{"tabs":[1,2]}');
    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [] });
    assert.strictEqual(fs.existsSync(staleState), false);
    assert.strictEqual(fs.existsSync(liveState), true);
    assert.ok(report.deletedFiles.includes(staleState));
  });

  it('reclaims a torn atomic-write temp whose final file exists, and keeps a recent one', () => {
    const liveState = path.join(profileDir, 'saved-tabs.json');
    writeFile(liveState, '{"tabs":[]}');
    const torn = path.join(profileDir, 'saved-tabs.json.tmp.1789467266030.3lipqk');
    writeFile(torn, 'x'.repeat(128), QUIET_MTIME);
    const recent = path.join(profileDir, 'saved-tabs.json.tmp.9999999999999.abcdef');
    writeFile(recent, 'y'.repeat(64));
    // No final file on disk: a temp whose write never landed may be the only copy.
    const orphanNoTarget = path.join(configDir, 'never-written.json.tmp.123.zzz');
    writeFile(orphanNoTarget, 'z', QUIET_MTIME);

    const report = pruneDeadStores({ profileDir, configDir, livePartitions: [] });

    assert.strictEqual(fs.existsSync(torn), false);
    assert.strictEqual(fs.existsSync(recent), true);
    assert.strictEqual(fs.existsSync(orphanNoTarget), true);
    assert.ok(report.deletedFiles.includes(torn));
    assert.ok(!report.deletedFiles.includes(recent));
    assert.ok(!report.deletedFiles.includes(orphanNoTarget));
  });

  it('never deletes the default cache while a tab lives on the default session', () => {
    const cacheDir = path.join(profileDir, 'Cache');
    writeFile(path.join(cacheDir, 'data_0'), 'x'.repeat(4096));
    fs.utimesSync(cacheDir, QUIET_MTIME, QUIET_MTIME);

    const guarded = pruneDeadStores({ profileDir, configDir, livePartitions: ['default'] });
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'data_0')), true);
    assert.ok(!guarded.deletedFiles.includes(cacheDir));

    const swept = pruneDeadStores({ profileDir, configDir, livePartitions: ['persist:profile-2'] });
    assert.strictEqual(fs.existsSync(cacheDir), false);
    assert.ok(swept.deletedFiles.includes(cacheDir));
    assert.ok(swept.reclaimedBytes >= 4096);
  });

  it('tolerates a missing profile and partitions directory', () => {
    const emptyRoot = path.join(root, 'absent');
    const report = pruneDeadStores({ profileDir: emptyRoot, configDir: path.join(emptyRoot, 'config'), livePartitions: [] });
    assert.deepStrictEqual(report.deletedPartitions, []);
    assert.deepStrictEqual(report.deletedFiles, []);
    assert.deepStrictEqual(report.errors, []);
  });
});
