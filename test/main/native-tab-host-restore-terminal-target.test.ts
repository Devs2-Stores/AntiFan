/**
 * Restoring a window's terminals is not provenance-free.
 *
 * `restoreTabs()` used to boot the shared manager with `startTerminal()` and no target. That is
 * not a passive boot: `TerminalManager.startTerminal(cwd?, capsuleId?, ownerKey?)` passes a `cwd`
 * straight into the process-wide `currentCwd` — which another window's workspace switch may have
 * set — and without a `capsuleId` and an `ownerKey` stamps the session with the ambient creation
 * capsule and the manager's own default owner key, so a restored window could come back as a
 * `'default'`-capsule PTY in another project's directory. A `'default'` session is filtered out of
 * a project window's own sidebar projection, and so is a session whose owner key names no window,
 * so the result is an invisible orphaned shell that still shows up through `listSessions()`.
 *
 * The rows below drive the real `restoreTabs()` and the real `resolveTerminalCreationTarget()`
 * over a window affiliation, and judge the one call the fix is about: what the boot asks the
 * manager for. `TerminalManager.getInstance()` is replaced for the duration, so nothing here
 * spawns a process.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost, SAVED_TABS_SCHEMA_VERSION } from '../../src/main/browser/native-tab-host';
import { TerminalManager, DEFAULT_TERMINAL_OWNER_KEY } from '../../src/main/browser/terminal-manager';
import { ownerKey } from '../../src/main/browser/project-window-shell';

const PROJECT_ID = 'project-00000000-0000-4000-8000-0000000007e1';
const WINDOW_CAPSULE_ID = 'capsule-window-own';
/** Where another window's workspace switch left the process-wide working directory. */
const OTHER_WINDOW_CWD = path.join(os.tmpdir(), 'antifan-other-window-workspace');
const SAVED_SESSION_ID = 'term-saved-1';

/** One boot the restore path asked for, after the manager's own provenance rules. */
interface TerminalBoot {
  cwd: string;
  capsuleId: string;
  ownerKey: string;
  provenance: 'argument' | 'ambient';
  ownerProvenance: 'argument' | 'ambient';
}

/**
 * `TerminalManager.getInstance()` as the boot path uses it, implementing the two provenance
 * rules of the real `startTerminal(cwd?, capsuleId?, ownerKey?)`: an argument wins, and an
 * absent argument keeps whatever the process-wide state already holds.
 */
class RecordingTerminalManager {
  public currentCwd = OTHER_WINDOW_CWD;
  public creationCapsuleId = 'default';
  /** What a caller that names no window leaves behind: the manager's own default owner key. */
  public creationOwnerKey = DEFAULT_TERMINAL_OWNER_KEY;
  public readonly boots: TerminalBoot[] = [];

  public listSessions(): unknown[] {
    return [];
  }

  public startTerminal(cwd?: string, capsuleId?: string, ownerKey?: string): boolean {
    if (cwd) this.currentCwd = cwd;
    this.boots.push({
      cwd: cwd || this.currentCwd,
      capsuleId: capsuleId || this.creationCapsuleId,
      ownerKey: ownerKey || this.creationOwnerKey,
      provenance: capsuleId ? 'argument' : 'ambient',
      ownerProvenance: ownerKey ? 'argument' : 'ambient',
    });
    return true;
  }
}

interface Fixture {
  host: Record<string, unknown>;
  workspaceRoot: string;
  opened: { popout: unknown[]; window: unknown[] };
  cleanup: () => void;
}

/** A window whose saved record names one terminal window (popout or docked). */
function createFixture(record: Record<string, unknown>): Fixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restore-target-'));
  const workspaceRoot = path.join(tempRoot, 'project-alpha');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const tabsPath = path.join(tempRoot, 'tabs.json');
  fs.writeFileSync(
    tabsPath,
    JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        [ownerKey({ kind: 'project', projectId: PROJECT_ID })]: {
          tabs: [],
          updatedAt: Date.now(),
          ...record,
        },
      },
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const opened = { popout: [] as unknown[], window: [] as unknown[] };
  const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
  host.shell = { owner: { kind: 'project', projectId: PROJECT_ID }, isSidebarOpen: false, sidebarWidth: 380 };
  host.getTabsStoragePath = () => tabsPath;
  host.applyTerminalTabPrefs = () => {};
  host.restoreMutedSites = () => {};
  host.createTab = () => 'tab-fallback';
  host.openNewTerminalWindow = (...args: unknown[]) => { opened.window.push(args); };
  host.togglePopoutTerminal = (...args: unknown[]) => { opened.popout.push(args); return true; };
  // The real resolution the fix must use, over the window's own verified affiliation.
  host.windowWorkspaceAffiliation = { workspacePath: workspaceRoot, capsuleId: WINDOW_CAPSULE_ID };

  return {
    host,
    workspaceRoot,
    opened,
    cleanup: () => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Run one restore with the shared manager replaced; the real one is put back afterwards. */
function withRecordingManager<T>(manager: RecordingTerminalManager, run: () => T): T {
  const previous = TerminalManager.getInstance();
  TerminalManager.setInstance(manager as unknown as TerminalManager);
  try {
    return run();
  } finally {
    TerminalManager.setInstance(previous);
  }
}

function assertBootWasThisWindow(boot: TerminalBoot | undefined, workspaceRoot: string): void {
  assert.ok(boot, 'the restore path never booted the terminal manager');
  assert.equal(
    boot!.cwd,
    path.normalize(workspaceRoot),
    `the restored terminal spawned on '${boot!.cwd}' instead of this window's workspace root ` +
    `(a bare startTerminal() keeps the process-wide cwd, which another window may have set: '${OTHER_WINDOW_CWD}')`,
  );
  assert.equal(
    boot!.provenance,
    'argument',
    'the boot passed no capsule, so the session was stamped with the ambient creation capsule',
  );
  assert.notEqual(boot!.capsuleId, 'default', 'the restored session was minted as a default-capsule session');
  assert.equal(boot!.capsuleId, WINDOW_CAPSULE_ID);
  assert.equal(
    boot!.ownerProvenance,
    'argument',
    'the boot passed no owner key, so the restored session would belong to no window and its own sidebar would hide it',
  );
  assert.equal(
    boot!.ownerKey,
    ownerKey({ kind: 'project', projectId: PROJECT_ID }),
    `the restored terminal was minted for '${boot!.ownerKey}' instead of the window restoring it`,
  );
}

describe('NativeTabHost restore — terminal creation target', () => {
  it('boots a saved terminal window on this window\'s workspace and capsule', () => {
    const fixture = createFixture({
      wasSidebarOpenBeforePopout: true,
      terminalWindows: [{ sessionId: SAVED_SESSION_ID, isPopout: false, bounds: { width: 720, height: 420 } }],
    });
    const manager = new RecordingTerminalManager();
    try {
      withRecordingManager(manager, () => (fixture.host.restoreTabs as () => void)());
    } finally {
      fixture.cleanup();
    }

    assert.equal(fixture.opened.window.length, 1, 'the saved docked terminal window was not reopened');
    assert.equal(manager.boots.length, 1, `the restore booted the manager ${manager.boots.length} time(s)`);
    assertBootWasThisWindow(manager.boots[0], fixture.workspaceRoot);
  });

  it('boots a saved terminal popout on this window\'s workspace and capsule', () => {
    const fixture = createFixture({
      isTerminalPopoutOpen: true,
      wasSidebarOpenBeforePopout: true,
      popoutSessionId: SAVED_SESSION_ID,
    });
    const manager = new RecordingTerminalManager();
    try {
      withRecordingManager(manager, () => (fixture.host.restoreTabs as () => void)());
    } finally {
      fixture.cleanup();
    }

    assert.equal(fixture.opened.popout.length, 1, 'the saved popout was not reopened');
    assert.equal(manager.boots.length, 1, `the restore booted the manager ${manager.boots.length} time(s)`);
    assertBootWasThisWindow(manager.boots[0], fixture.workspaceRoot);
  });

  it('boots nothing when the saved record has no terminal window', () => {
    const fixture = createFixture({ wasSidebarOpenBeforePopout: true });
    const manager = new RecordingTerminalManager();
    try {
      withRecordingManager(manager, () => (fixture.host.restoreTabs as () => void)());
    } finally {
      fixture.cleanup();
    }

    assert.deepEqual(manager.boots, []);
    assert.deepEqual(fixture.opened, { popout: [], window: [] });
  });
});
