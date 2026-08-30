import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';

describe('ChromeProfileSyncManager Invariants', () => {
  it('deterministically discovers Chrome profiles across Local State, Default fallback, and missing paths', () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const origPath = (manager as any).chromeUserDataPath;
    const origActiveProfileId = manager.activeProfileId;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-chrome-test-'));

    try {
      (manager as any).chromeUserDataPath = tempDir;
      // Case 1: Missing Local State directory -> returns []
      manager.invalidateCache();
      const emptyProfiles = manager.getAvailableProfiles(true);
      assert.deepStrictEqual(emptyProfiles, [], 'Missing Local State must return empty array');

      // Case 2: Default directory exists, Local State with empty info_cache -> returns Default fallback
      fs.mkdirSync(path.join(tempDir, 'Default'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'Local State'),
        JSON.stringify({ profile: { info_cache: {} } }),
        'utf8'
      );
      manager.invalidateCache();
      const defaultProfiles = manager.getAvailableProfiles(true);
      assert.strictEqual(defaultProfiles.length, 1);
      assert.strictEqual(defaultProfiles[0]?.id, 'Default');
      assert.strictEqual(defaultProfiles[0]?.name, 'Default Profile');
      assert.strictEqual(defaultProfiles[0]?.active, true);

      // Case 3: Local State with multi-profile info_cache
      fs.writeFileSync(
        path.join(tempDir, 'Local State'),
        JSON.stringify({
          profile: {
            info_cache: {
              'Profile 1': { name: 'Work Profile', avatar_icon: 'chrome://theme/IDR_PROFILE_AVATAR_0' },
              'Profile 2': { name: 'Personal Profile', avatar_icon: 'chrome://theme/IDR_PROFILE_AVATAR_1' },
            },
          },
        }),
        'utf8'
      );
      manager.activeProfileId = 'Profile 2';
      manager.invalidateCache();
      const multiProfiles = manager.getAvailableProfiles(true);
      assert.strictEqual(multiProfiles.length, 2);
      const p1 = multiProfiles.find((p) => p.id === 'Profile 1');
      const p2 = multiProfiles.find((p) => p.id === 'Profile 2');
      assert.ok(p1 && p2);
      assert.strictEqual(p1.name, 'Work Profile');
      assert.strictEqual(p1.active, false);
      assert.strictEqual(p2.name, 'Personal Profile');
      assert.strictEqual(p2.active, true);
    } finally {
      (manager as any).chromeUserDataPath = origPath;
      manager.activeProfileId = origActiveProfileId;
      manager.invalidateCache();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('safely copies locked files without throwing EBUSY and handles missing source gracefully', () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const tmpSrc = path.join(os.tmpdir(), `test-lock-src-${Date.now()}.txt`);
    const tmpDst = path.join(os.tmpdir(), `test-lock-dst-${Date.now()}.txt`);

    fs.writeFileSync(tmpSrc, 'test cookie data content', 'utf8');
    const ok = manager.safeCopyLockedFile(tmpSrc, tmpDst);

    assert.strictEqual(ok, true);
    assert.strictEqual(fs.existsSync(tmpDst), true);
    assert.strictEqual(fs.readFileSync(tmpDst, 'utf8'), 'test cookie data content');

    // Non-existent source returns false gracefully without crashing
    const missingOk = manager.safeCopyLockedFile(path.join(os.tmpdir(), 'non-existent-source-file-12345.txt'), tmpDst);
    assert.strictEqual(missingOk, false);

    try { fs.unlinkSync(tmpSrc); } catch {}
    try { fs.unlinkSync(tmpDst); } catch {}
  });
});
