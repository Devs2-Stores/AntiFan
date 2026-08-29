import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasPersistentProfileState, preparePersistentProfile, ProfileMigrationError, ProfileOwnership, ProfileOwnershipError } from '../../src/main/browser/profile-ownership';

describe('ProfileOwnership', () => {
  it('allows one owner and rejects a live second owner', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-'));
    try {
      const first = new ProfileOwnership({ pid: process.pid, hostname: 'test-host', now: () => 100 }).acquire(profile);
      assert.throws(() => new ProfileOwnership({ pid: process.pid + 1, hostname: 'test-host', now: () => 110 }).acquire(profile), (error: unknown) => error instanceof ProfileOwnershipError && error.code === 'PROFILE_LOCKED');
      first.markCleanShutdown();
      first.release();
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  it('recovers a stale lease and detects an unclean prior shutdown', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-'));
    try {
      fs.writeFileSync(path.join(profile, 'antifan-profile.lock'), JSON.stringify({ pid: 999999, host: 'test-host', startedAt: 1, profilePath: profile }));
      fs.writeFileSync(path.join(profile, 'antifan-recovery.json'), JSON.stringify({ cleanShutdown: false, startedAt: 1, safeStartRecommended: true }));
      const lease = new ProfileOwnership({ pid: 41003, hostname: 'test-host', now: () => 200 }).acquire(profile);
      assert.equal(lease.recovery.safeStartRecommended, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'antifan-recovery.json'), 'utf8')).cleanShutdown, false);
      lease.markCleanShutdown();
      lease.release();
      assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'antifan-recovery.json'), 'utf8')).cleanShutdown, true);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  it('uses one canonical profile and migrates the richest complete legacy profile as a whole', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-migration-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const older = path.join(appDataPath, 'antifan-browser-desktop', 'Chromium-dev');
    const newer = path.join(appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    const canonical = path.join(appDataPath, 'antifan-browser-desktop', 'Profile');
    try {
      fs.mkdirSync(path.join(older, 'Network'), { recursive: true });
      fs.writeFileSync(path.join(older, 'Network', 'Cookies'), 'older-cookie-db');
      fs.utimesSync(path.join(older, 'Network', 'Cookies'), new Date(1000), new Date(1000));

      fs.mkdirSync(path.join(newer, 'Network'), { recursive: true });
      fs.mkdirSync(path.join(newer, 'Local Storage', 'leveldb'), { recursive: true });
      fs.mkdirSync(path.join(newer, 'IndexedDB'), { recursive: true });
      fs.writeFileSync(path.join(newer, 'Network', 'Cookies'), 'newer-cookie-db');
      fs.writeFileSync(path.join(newer, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001');
      fs.writeFileSync(path.join(newer, 'IndexedDB', 'CURRENT'), 'MANIFEST-000001');
      fs.writeFileSync(path.join(newer, 'antifan-profile.lock'), JSON.stringify({ pid: 999999, host: 'stale', startedAt: 1, profilePath: newer }));
      fs.writeFileSync(path.join(newer, 'antifan-recovery.json'), JSON.stringify({ cleanShutdown: false, safeStartRecommended: true }));

      const result = preparePersistentProfile({ appDataPath, appPath, pid: 41001, now: () => 200, isProcessAlive: () => false });
      assert.equal(result.profilePath, canonical);
      assert.equal(result.migratedFrom, newer);
      assert.equal(fs.readFileSync(path.join(canonical, 'Network', 'Cookies'), 'utf8'), 'newer-cookie-db');
      assert.equal(fs.readFileSync(path.join(canonical, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8'), 'MANIFEST-000001');
      assert.equal(fs.readFileSync(path.join(canonical, 'IndexedDB', 'CURRENT'), 'utf8'), 'MANIFEST-000001');
      assert.equal(fs.existsSync(path.join(canonical, 'antifan-profile.lock')), false);
      assert.equal(fs.existsSync(path.join(canonical, 'antifan-recovery.json')), false);
      assert.equal(hasPersistentProfileState(canonical), true);

      const secondLaunch = preparePersistentProfile({ appDataPath, appPath, pid: 41002, isProcessAlive: () => false });
      assert.deepEqual(secondLaunch, { profilePath: canonical });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers durable authenticated state over a newer sparse profile and supports a legacy app-data root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-richness-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const legacyRoot = path.join(appDataPath, 'antifan-browser-desktop');
    const sparse = path.join(appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    const canonical = path.join(legacyRoot, 'Profile');
    try {
      fs.mkdirSync(path.join(legacyRoot, 'Network'), { recursive: true });
      fs.mkdirSync(path.join(legacyRoot, 'Local Storage', 'leveldb'), { recursive: true });
      fs.mkdirSync(path.join(legacyRoot, 'IndexedDB'), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, 'Network', 'Cookies'), 'established-authenticated-cookie-database');
      fs.writeFileSync(path.join(legacyRoot, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001');
      fs.writeFileSync(path.join(legacyRoot, 'IndexedDB', 'CURRENT'), 'MANIFEST-000001');
      fs.mkdirSync(path.join(legacyRoot, 'Chromium-dev-cache', 'Cache_Data'), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, 'Chromium-dev-cache', 'Cache_Data', 'index'), 'cache-only');

      fs.mkdirSync(path.join(sparse, 'Network'), { recursive: true });
      fs.writeFileSync(path.join(sparse, 'Network', 'Cookies'), 'new-empty-cookie-database');
      fs.utimesSync(path.join(sparse, 'Network', 'Cookies'), new Date(5000), new Date(5000));

      const result = preparePersistentProfile({ appDataPath, appPath, pid: 41004, now: () => 6000, isProcessAlive: () => false });
      assert.equal(result.migratedFrom, legacyRoot);
      assert.equal(fs.readFileSync(path.join(canonical, 'Network', 'Cookies'), 'utf8'), 'established-authenticated-cookie-database');
      assert.equal(fs.readFileSync(path.join(canonical, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8'), 'MANIFEST-000001');
      assert.equal(fs.existsSync(path.join(canonical, 'Chromium-dev-cache')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to copy a Chromium profile held by a live process', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-live-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const source = path.join(appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    try {
      fs.mkdirSync(path.join(source, 'Network'), { recursive: true });
      fs.writeFileSync(path.join(source, 'Network', 'Cookies'), 'locked-cookie-db');
      fs.writeFileSync(path.join(source, 'antifan-profile.lock'), JSON.stringify({ pid: 42001, host: 'test-host', startedAt: 1, profilePath: source }));

      assert.throws(
        () => preparePersistentProfile({ appDataPath, appPath, pid: 42002, isProcessAlive: (pid) => pid === 42001 }),
        (error: unknown) => error instanceof ProfileMigrationError && error.code === 'PROFILE_IN_USE'
      );
      assert.equal(fs.existsSync(path.join(appDataPath, 'antifan-browser-desktop', 'Profile')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects a non-empty canonical directory without recognized Chromium state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-invalid-canonical-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const canonical = path.join(appDataPath, 'antifan-browser-desktop', 'Profile');
    try {
      fs.mkdirSync(canonical, { recursive: true });
      fs.writeFileSync(path.join(canonical, 'unrecognized.txt'), 'not Chromium state');
      assert.throws(
        () => preparePersistentProfile({ appDataPath, appPath }),
        (error: unknown) => error instanceof ProfileMigrationError && error.code === 'PROFILE_MIGRATION_FAILED'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans the staging path when atomic profile migration fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-rollback-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const source = path.join(appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    const staging = path.join(appDataPath, '.antifan-profile-migration-43001-7000');
    const canonical = path.join(appDataPath, 'antifan-browser-desktop', 'Profile');
    try {
      fs.mkdirSync(path.join(source, 'Network'), { recursive: true });
      fs.writeFileSync(path.join(source, 'Network', 'Cookies'), 'cookie-db');
      fs.mkdirSync(appDataPath, { recursive: true });
      fs.writeFileSync(staging, 'blocks directory copy');
      assert.throws(
        () => preparePersistentProfile({ appDataPath, appPath, pid: 43001, now: () => 7000, isProcessAlive: () => false }),
        (error: unknown) => error instanceof ProfileMigrationError && error.code === 'PROFILE_MIGRATION_FAILED'
      );
      assert.equal(fs.existsSync(staging), false);
      assert.equal(fs.existsSync(canonical), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates a valid legacy candidate with a corrupt stale lock file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-corrupt-lock-'));
    const appDataPath = path.join(root, 'roaming');
    const appPath = path.join(root, 'app');
    const source = path.join(appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev');
    const canonical = path.join(appDataPath, 'antifan-browser-desktop', 'Profile');
    try {
      fs.mkdirSync(path.join(source, 'Network'), { recursive: true });
      fs.writeFileSync(path.join(source, 'Network', 'Cookies'), 'cookie-db');
      fs.writeFileSync(path.join(source, 'antifan-profile.lock'), '{ corrupt json');
      const result = preparePersistentProfile({ appDataPath, appPath, pid: 43002, now: () => 7100, isProcessAlive: () => false });
      assert.equal(result.migratedFrom, source);
      assert.equal(fs.readFileSync(path.join(canonical, 'Network', 'Cookies'), 'utf8'), 'cookie-db');
      assert.equal(fs.existsSync(path.join(canonical, 'antifan-profile.lock')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps explicit user-data overrides isolated for tests and benchmarks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-override-'));
    try {
      const overridePath = path.join(root, 'isolated-profile');
      const result = preparePersistentProfile({ appDataPath: path.join(root, 'roaming'), appPath: path.join(root, 'app'), customUserData: overridePath });
      assert.deepEqual(result, { profilePath: path.resolve(overridePath) });
      assert.equal(fs.existsSync(overridePath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
