import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageLocations } from '../../src/main/config/storage-locations';

describe('StorageLocations Configuration & Path Resolution', () => {
  const originalEnv = process.env.ANTIFAN_DATA_ROOT;
  let tempTestRoot: string;

  beforeEach(() => {
    StorageLocations.resetCache();
    tempTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-storage-test-'));
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.ANTIFAN_DATA_ROOT = originalEnv;
    } else {
      delete process.env.ANTIFAN_DATA_ROOT;
    }
    StorageLocations.resetCache();
    try {
      fs.rmSync(tempTestRoot, { recursive: true, force: true });
    } catch {}
  });

  it('respects explicit ANTIFAN_DATA_ROOT override', () => {
    process.env.ANTIFAN_DATA_ROOT = tempTestRoot;
    assert.strictEqual(StorageLocations.getDataRoot(), path.resolve(tempTestRoot));
    assert.strictEqual(StorageLocations.getProfileDir(), path.join(path.resolve(tempTestRoot), 'Profile'));
    assert.strictEqual(StorageLocations.getCacheDir(), path.join(path.resolve(tempTestRoot), 'Profile-cache'));
    assert.strictEqual(StorageLocations.getNetworkCacheDir(), path.join(path.resolve(tempTestRoot), 'Profile-cache', 'network'));
    assert.strictEqual(StorageLocations.getGpuCacheDir(), path.join(path.resolve(tempTestRoot), 'Profile-cache', 'gpu'));
    assert.strictEqual(StorageLocations.getConfigDir(), path.join(path.resolve(tempTestRoot), 'config'));
    assert.strictEqual(StorageLocations.getSessionsDir(), path.join(path.resolve(tempTestRoot), 'sessions'));
    assert.strictEqual(StorageLocations.getControlPlaneDir(), path.join(path.resolve(tempTestRoot), 'control-plane-v2'));
  });

  it('creates all required directories on ensureDirectories()', () => {
    process.env.ANTIFAN_DATA_ROOT = tempTestRoot;
    StorageLocations.ensureDirectories();

    assert.strictEqual(fs.existsSync(StorageLocations.getDataRoot()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getProfileDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getCacheDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getNetworkCacheDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getGpuCacheDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getConfigDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getSessionsDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getControlPlaneDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getArtifactsDir()), true);
    assert.strictEqual(fs.existsSync(StorageLocations.getRuntimeDir()), true);
  });
});
