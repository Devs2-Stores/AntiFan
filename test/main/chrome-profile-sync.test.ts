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

  it('synchronizes bookmarks cleanly and reports companion extension integration', async () => {
    const manager = ChromeProfileSyncManager.getInstance();
    const origPath = (manager as any).chromeUserDataPath;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-chrome-bm-test-'));

    try {
      (manager as any).chromeUserDataPath = tempDir;
      const defaultDir = path.join(tempDir, 'Default');
      fs.mkdirSync(defaultDir, { recursive: true });
      fs.writeFileSync(
        path.join(defaultDir, 'Bookmarks'),
        JSON.stringify({
          roots: {
            bookmark_bar: {
              children: [
                { type: 'url', name: 'Google', url: 'https://www.google.com' },
                { type: 'url', name: 'Gmail', url: 'https://mail.google.com' },
              ],
            },
          },
        }),
        'utf8'
      );

      const bms = manager.getChromeBookmarks('Default');
      assert.strictEqual(bms.length, 2);
      assert.strictEqual(bms[0]?.title, 'Google');
      assert.strictEqual(bms[1]?.title, 'Gmail');

      const res = await manager.syncProfile('Default');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.bookmarksCount, 2);
      assert.match(res.message, /AntiFan Chrome Extension/);
    } finally {
      (manager as any).chromeUserDataPath = origPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
