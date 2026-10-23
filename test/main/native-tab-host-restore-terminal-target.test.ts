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
  host.mutedSites = new Set<string>();
  host.bookmarks = [];
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

  it('still gives a project window its default page when nothing was saved', () => {
    const result = restoreWith({});
    assert.equal(result.created.length, 1, 'a browser window must never come back empty');
  });
});