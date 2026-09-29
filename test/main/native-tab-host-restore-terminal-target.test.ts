/**
 * Terminals no longer get windows of their own per browser window: every "own window" entry
 * opens the one shared Terminal Manager. A saved record written before that change still
 * names popouts and docked terminal windows; restoring it must neither resurrect those
 * windows nor boot a terminal on the window's behalf (a boot without a target would also
 * stamp the session with the ambient process-wide cwd and capsule).
 *
 * The rows drive the real `restoreTabs()` with `TerminalManager.getInstance()` replaced, so
 * nothing here spawns a process or a window.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost, SAVED_TABS_SCHEMA_VERSION } from '../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ownerKey } from '../../src/main/browser/project-window-shell';

const PROJECT_ID = 'project-00000000-0000-4000-8000-0000000007e1';
const SAVED_SESSION_ID = 'term-saved-1';

class RecordingTerminalManager {
  public readonly boots: unknown[][] = [];

  public listSessions(): unknown[] {
    return [];
  }

  public startTerminal(...args: unknown[]): boolean {
    this.boots.push(args);
    return true;
  }
}

function restoreWith(record: Record<string, unknown>, owner: Record<string, unknown> = { kind: 'project', projectId: PROJECT_ID }): { boots: unknown[][]; created: string[] } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-target-'));
  const tabsPath = path.join(tempRoot, 'saved-tabs.json');
  fs.writeFileSync(
    tabsPath,
    JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        [ownerKey(owner as never)]: { tabs: [], updatedAt: Date.now(), ...record },
      },
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
  host.shell = { owner, isSidebarOpen: false, sidebarWidth: 380 };
  const created: string[] = [];
  host.createTab = (url: string) => { created.push(url); return 'tab-fallback'; };
  host.getTabsStoragePath = () => tabsPath;
  host.applyTerminalTabPrefs = () => {};
  host.restoreMutedSites = () => {};
  // Layout touches real views; the restore paths under test only need it to be a no-op.
  host.updateLayout = () => {};
  host.getToolbarHeight = () => 0;

  const manager = new RecordingTerminalManager();
  const previous = TerminalManager.getInstance();
  TerminalManager.setInstance(manager as unknown as TerminalManager);
  try {
    (host.restoreTabs as () => void)();
  } finally {
    TerminalManager.setInstance(previous);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return { boots: manager.boots, created };
}

describe('NativeTabHost restore — legacy terminal windows', () => {
  it('does not reopen a saved docked terminal window or boot a terminal for it', () => {
    const result = restoreWith({
      wasSidebarOpenBeforePopout: true,
      terminalWindows: [{ sessionId: SAVED_SESSION_ID, isPopout: false, bounds: { width: 720, height: 420 } }],
    });
    assert.deepEqual(result.boots, [], 'restore booted a terminal for a window that no longer exists');
  });

  it('does not reopen a saved popout or boot a terminal for it', () => {
    const result = restoreWith({
      isTerminalPopoutOpen: true,
      wasSidebarOpenBeforePopout: true,
      popoutSessionId: SAVED_SESSION_ID,
      terminalWindows: [{ sessionId: SAVED_SESSION_ID, isPopout: true }],
    });
    assert.deepEqual(result.boots, [], 'restore booted a terminal for a popout that no longer exists');
  });

  it('restores the Terminal Manager with no pages even when tabs were saved under it', () => {
    const result = restoreWith(
      { tabs: [{ id: 'old-1', url: 'https://example.com/', title: 'Old' }], activeTabId: 'old-1' },
      { kind: 'unassigned' },
    );
    assert.deepEqual(result.created, [], 'the terminals-only window minted a page');
  });
  it('folds tabs saved under legacy project: owner keys into the web hub record', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-migrate-'));
    const tabsPath = path.join(tempRoot, 'saved-tabs.json');
    fs.writeFileSync(
      tabsPath,
      JSON.stringify({
        version: SAVED_TABS_SCHEMA_VERSION,
        owners: {
          'project:project-legacy-a': {
            tabs: [
              { id: 'dup-id', url: 'https://a.example/', title: 'A' },
              { id: 'old-a', url: 'https://a-unique.example/', title: 'A unique' },
            ],
            activeTabId: 'old-a',
            updatedAt: 1000,
          },
          'project:project-legacy-b': {
            tabs: [{ id: 'old-b', url: 'https://b.example/', title: 'B' }],
            updatedAt: 2000,
          },
          // A live web record merges too: its tab wins over a duplicate id, and its
          // activeTabId is never overwritten by a legacy record's.
          web: {
            tabs: [{ id: 'dup-id', url: 'https://a-current.example/', title: 'A current' }],
            activeTabId: 'web-active',
            updatedAt: 500,
          },
        },
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
    host.shell = { owner: { kind: 'web' } };
    host.getTabsStoragePath = () => tabsPath;

    type Doc = { owners: Record<string, { tabs: Array<Record<string, unknown>>; activeTabId?: string }> };
    try {
      const document = (host.loadSavedTabsDocument as () => Doc)();

      const webRecord = document.owners.web;
      assert.ok(webRecord, 'the fold produced no web owner record');
      const webTabs = webRecord.tabs;
      assert.equal(document.owners['project:project-legacy-a'], undefined, 'the legacy owner key survived the fold');
      assert.equal(document.owners['project:project-legacy-b'], undefined, 'the second legacy owner key survived the fold');
      // legacy-a's 'dup-id' tab duplicates web's by id, so the live copy wins; legacy-a's
      // unique tab still arrives stamped, and legacy-b's tab follows: 3 tabs total.
      assert.equal(webTabs.length, 3, 'duplicate ids must not double the merged record: ' + JSON.stringify(webTabs));
      assert.deepEqual(
        webTabs.map((t) => [t.url, t.projectId]),
        [
          ['https://a-current.example/', undefined],
          ['https://a-unique.example/', 'project-legacy-a'],
          ['https://b.example/', 'project-legacy-b'],
        ],
        'merged tabs must carry the project id their old owner key named',
      );
      assert.equal(webRecord.activeTabId, 'web-active', 'a live web record lost its active tab to a legacy record');

      // The merge is durable: the file itself already shows one 'web' record, so a second
      // launch finds nothing left to fold.
      const onDisk = JSON.parse(fs.readFileSync(tabsPath, 'utf8')) as Doc;
      assert.equal(onDisk.owners['project:project-legacy-a'], undefined, 'the persisted file still carries the legacy owner key');
      assert.ok(onDisk.owners.web, 'the persisted file lost the web owner record');
      assert.equal(onDisk.owners.web.tabs.length, 3, 'the persisted file does not show the merged record');

      const second = (host.loadSavedTabsDocument as () => Doc)();
      assert.ok(second.owners.web);
      assert.equal(second.owners.web.tabs.length, 3, 'a second load re-merged records instead of converging');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('leaves legacy project: owner records alone when a non-web host loads the document', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-noweb-'));
    const tabsPath = path.join(tempRoot, 'saved-tabs.json');
    const raw = {
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        'project:project-legacy-a': { tabs: [{ id: 'old-a', url: 'https://a.example/' }], updatedAt: 1000 },
      },
      updatedAt: Date.now(),
    };
    fs.writeFileSync(tabsPath, JSON.stringify(raw), 'utf8');

    const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
    host.shell = { owner: { kind: 'unassigned' } };
    host.getTabsStoragePath = () => tabsPath;

    type Doc = { owners: Record<string, { tabs: Array<Record<string, unknown>> }> };
    try {
      const document = (host.loadSavedTabsDocument as () => Doc)();
      // The Terminal Manager has no page area: folding its way would only hide the
      // legacy record for the web hub's own fold later. Untouched, unread, unwritten.
      assert.ok(document.owners['project:project-legacy-a'], 'a non-web load consumed the legacy record');
      assert.equal(document.owners.web, undefined, 'a non-web load invented a web record');
      const onDisk = JSON.parse(fs.readFileSync(tabsPath, 'utf8')) as Doc;
      assert.ok(onDisk.owners['project:project-legacy-a'], 'a non-web load rewrote the legacy file');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it('still gives a project window its default page when nothing was saved', () => {
    const result = restoreWith({});
    assert.equal(result.created.length, 1, 'a browser window must never come back empty');
  });
});