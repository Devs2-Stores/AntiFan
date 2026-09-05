import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { ChromeProfileSyncManager } from '../../src/main/browser/chrome-profile-sync';

describe('NativeTabHost Session Restore Profile Behavior', () => {
  it('restores activeChromeProfileId synchronously with zero calls to syncProfile', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-test-'));
    const tabsJsonPath = path.join(tempDir, 'tabs.json');

    const persistedData = {
      activeTabId: 'tab-1',
      tabs: [],
      bookmarks: [
        { id: 'bm-1', title: 'Test Bookmark', url: 'https://example.com', createdAt: Date.now() },
      ],
      activeChromeProfileId: 'Profile 42',
      updatedAt: Date.now(),
    };
    fs.writeFileSync(tabsJsonPath, JSON.stringify(persistedData), 'utf8');

    const host = Object.create(NativeTabHost.prototype) as any;
    host.tabs = new Map();
    host.tabOrder = [];
    host.getTabsStoragePath = () => tabsJsonPath;
    host.createTab = () => 'tab-restored';
    host.broadcastState = () => {};

    const syncManager = ChromeProfileSyncManager.getInstance();
    const origProfileId = syncManager.activeProfileId;
    syncManager.activeProfileId = 'Default';

    let syncProfileCallCount = 0;
    const origSyncProfile = syncManager.syncProfile;
    syncManager.syncProfile = async (profileId?: string) => {
      syncProfileCallCount++;
      return origSyncProfile.call(syncManager, profileId);
    };

    try {
      // Exercise restoreTabs
      host.restoreTabs();

      // Invariant 1: activeProfileId was restored synchronously
      assert.strictEqual(syncManager.activeProfileId, 'Profile 42');

      // Invariant 2: syncProfile was NOT called (zero unobserved async disk reads)
      assert.strictEqual(syncProfileCallCount, 0, 'restoreTabs must not invoke syncProfile');

      // Invariant 3: Bookmarks were restored from persisted session
      assert.strictEqual(host.bookmarks.length, 1);
      assert.strictEqual(host.bookmarks[0].title, 'Test Bookmark');
    } finally {
      syncManager.syncProfile = origSyncProfile;
      syncManager.activeProfileId = origProfileId;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
