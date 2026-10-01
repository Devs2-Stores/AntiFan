/**
 * `antifan:terminal:new-in-folder` mints a shell bound to ONE folder — and touches nothing
 * else. The route exists because `antifan:capsule:pick-folder` answers the same chooser and
 * then re-points the process-global capsule AND types `Set-Location` into a live shell: one
 * project's agent used to land inside another folder that way.
 *
 * These rows drive the real CHROME_ROUTES table through the route harness over a recording
 * TerminalManager and a recording capsule store, so each property under test is a call the
 * route made — or a call it provably did not:
 *   1. The minted session runs at the realpath of the chosen folder and rides the capsule
 *      already recording it (one is created only when none does).
 *   2. `capsuleManager.switchTo`, `TerminalManager.setCapsule` and every other session's
 *      cwd are left exactly as they were — proven by them never being invoked.
 *   3. A project window may mint into its own workspace root only; any other folder is
 *      `FOLDER_NOT_OWNED`, and the shared manager names any real directory.
 *   4. A cancelled chooser mints nothing, and a daemon-mode `createSession` answer (a
 *      Promise) resolves to the same shape as an in-process string id.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebContentsView } from 'electron';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
import type { PageCloseReservations } from '../../src/main/browser/project-close-coordinator';
import type { ProjectWindowShell } from '../../src/main/browser/project-window-shell';
import type { ChromeRouteHarness } from '../support/chrome-route-harness';
import { installElectronStub } from '../support/electron-stub';

installElectronStub();

const electronStub = require('electron') as {
  BrowserWindow: { fromWebContents?: (sender: unknown) => unknown };
  dialog: { showOpenDialog?: (window: unknown, options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }> };
};
electronStub.BrowserWindow.fromWebContents = () => null;

const { NativeTabHost: NativeTabHostRuntime } =
  require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { TerminalManager: TerminalManagerRuntime } =
  require('../../src/main/browser/terminal-manager') as typeof import('../../src/main/browser/terminal-manager');
const { PageCloseReservations: PageCloseReservationsRuntime } =
  require('../../src/main/browser/project-close-coordinator') as typeof import('../../src/main/browser/project-close-coordinator');
const { ownerKey } =
  require('../../src/main/browser/project-window-shell') as typeof import('../../src/main/browser/project-window-shell');
const { TERMINAL_CHANNELS } =
  require('../../src/shared/contracts') as typeof import('../../src/shared/contracts');
const { canonicalFolderKey } =
  require('../../src/main/project/workspace-capsule') as typeof import('../../src/main/project/workspace-capsule');
const { createShellDouble } =
  require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const { createChromeRouteHarness } =
  require('../support/chrome-route-harness') as typeof import('../support/chrome-route-harness');

const PROJECT_OWNER = { kind: 'project', projectId: 'proj-own' } as const;
const UNASSIGNED_OWNER = { kind: 'unassigned' } as const;

/** The capsule face the route is allowed to touch: lookup and create record, the rest must not. */
class RecordingCapsuleManager {
  public readonly calls: string[] = [];
  public created: Array<{ name: string; workspacePath: string }> = [];
  private nextId = 1;

  public constructor(private readonly capsules: Array<Record<string, unknown>> = []) {}

  public list(): Array<Record<string, unknown>> {
    return this.capsules.map((capsule) => ({ ...capsule }));
  }

  public getActive(): Record<string, unknown> | null {
    this.calls.push('getActive');
    return this.capsules[0] ?? null;
  }

  public create(name: string, workspacePath: string): Record<string, unknown> {
    this.calls.push(`create:${workspacePath}`);
    const capsule = { id: `capsule-new-${this.nextId++}`, name, workspacePath };
    this.created.push({ name, workspacePath });
    this.capsules.push(capsule);
    return capsule;
  }

  public uniqueAffiliationByRoot(_root: string): undefined {
    this.calls.push('uniqueAffiliationByRoot');
    return undefined;
  }

  /** The global re-point this route exists to avoid: it must never be asked for. */
  public switchTo(_id: string): void {
    this.calls.push('switchTo');
    throw new Error('new-in-folder must never switch the active capsule');
  }
}

/** The terminal face: `createSession` records its full provenance and resolves like the daemon proxy. */
class RecordingTerminalManager {
  public readonly calls: string[] = [];
  public boots: Array<{ cwd: string; capsuleId: string; ownerKey: string }> = [];

  public async createSession(cwd: string, capsuleId: string, ownerKey: string): Promise<string> {
    this.calls.push(`createSession:${capsuleId}`);
    this.boots.push({ cwd, capsuleId, ownerKey });
    return 'sess-minted-1';
  }

  /** The other half of the old bug: minting a session must never write a live shell's cwd. */
  public setCapsule(): void {
    this.calls.push('setCapsule');
    throw new Error('new-in-folder must never re-point a live shell');
  }
}

interface Fixture {
  host: NativeTabHost;
  invoke: ChromeRouteHarness['invoke'];
  capsuleManager: RecordingCapsuleManager;
  manager: RecordingTerminalManager;
  reservations: PageCloseReservations;
  cleanup: () => void;
}

function withRecordingManager<T>(manager: RecordingTerminalManager, run: () => T): T {
  const previous = TerminalManagerRuntime.getInstance();
  TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
  try {
    return run();
  } finally {
    TerminalManagerRuntime.setInstance(previous);
}
}

function buildHost(owner: { kind: string; projectId?: string }, workspaceRoot?: string): {
  host: NativeTabHost;
  shell: ProjectWindowShell;
} {
  const host = Object.create(NativeTabHostRuntime.prototype) as Record<string, unknown>;
  host.closeAdmission = new PageCloseReservationsRuntime();
  const shell = createShellDouble();
  Object.assign(shell, { owner });
  host.shell = shell;
  host.popoutWindow = null;
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.tabs = new Map();
  host.automationTabId = null;
  host.isDisposed = false;
  host.folderFactsCache = new Map();
  host.windowWorkspaceAffiliation = workspaceRoot ? { workspacePath: workspaceRoot } : null;
  return { host: host as unknown as NativeTabHost, shell };
}

/** A fixture whose sender is this shell's sidebar: chrome, exactly as production learns it. */
function folderFixture(options: {
  owner: { kind: string; projectId?: string };
  workspaceRoot?: string;
  capsules?: Array<Record<string, unknown>>;
}): Fixture {
  const { host, shell } = buildHost(options.owner, options.workspaceRoot);
  const capsuleManager = new RecordingCapsuleManager(options.capsules ?? []);
  (host as unknown as Record<string, unknown>).capsuleManager = capsuleManager;
  const manager = new RecordingTerminalManager();
  const harness = createChromeRouteHarness({ host });
  const sender = harness.sender as { id: number };
  shell.sidebarView = {
    webContents: { id: sender.id, isDestroyed: () => false, send: () => {} },
    setBounds: () => {},
  } as unknown as WebContentsView;
  return {
    host,
    invoke: (channel, ...args) => harness.invoke(channel, ...args),
    capsuleManager,
    manager,
    reservations: host['closeAdmission' as keyof NativeTabHost] as unknown as PageCloseReservations,
    cleanup: () => {},
  };
}

function tempDir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

describe('antifan:terminal:new-in-folder', () => {
  it('mints at the folder realpath on the capsule already recording it — and re-points nothing', async () => {
    const dir = tempDir('antifan-new-in-folder-');
    try {
      const existing = { id: 'capsule-x', name: 'X', workspacePath: dir.root };
      const fixture = folderFixture({ owner: UNASSIGNED_OWNER, capsules: [existing] });
      const result = await withRecordingManager(fixture.manager, () =>
        fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: dir.root })
      ) as { ok: true; sessionId: string; capsuleId: string };

      assert.equal(result.ok, true);
      assert.equal(result.sessionId, 'sess-minted-1');
      assert.equal(result.capsuleId, 'capsule-x', 'the capsule recording this folder is reused, never duplicated');
      assert.equal(fixture.capsuleManager.created.length, 0, 'no second capsule for one folder');
      assert.equal(fixture.capsuleManager.calls.includes('switchTo'), false, 'the active capsule must not move');
      assert.equal(fixture.manager.calls.includes('setCapsule'), false, 'no live shell may be re-pointed');
      assert.equal(fixture.manager.boots.length, 1);
      assert.equal(
        canonicalFolderKey(fixture.manager.boots[0]!.cwd),
        canonicalFolderKey(fs.realpathSync.native(dir.root)),
        'the session runs at the realpath of the folder it was asked for',
      );
      assert.equal(
        fixture.manager.boots[0]!.ownerKey,
        ownerKey(UNASSIGNED_OWNER),
        'the minted session belongs to the window that asked for it',
      );
    } finally {
      dir.cleanup();
    }
  });

  it('creates a capsule named for the folder when none records it', async () => {
    const dir = tempDir('antifan-new-in-folder-');
    try {
      const fixture = folderFixture({ owner: UNASSIGNED_OWNER });
      const result = await withRecordingManager(fixture.manager, () =>
        fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: dir.root })
      ) as { ok: true; sessionId: string; capsuleId: string };

      assert.equal(result.ok, true);
      assert.equal(fixture.capsuleManager.created.length, 1);
      assert.equal(
        canonicalFolderKey(fixture.capsuleManager.created[0]!.workspacePath),
        canonicalFolderKey(fs.realpathSync.native(dir.root)),
      );
      assert.equal(fixture.manager.boots[0]!.capsuleId, result.capsuleId, 'the session rides the capsule the folder just minted');
      assert.equal(fixture.capsuleManager.calls.includes('switchTo'), false);
    } finally {
      dir.cleanup();
    }
  });

  it('lets a project window mint inside its own workspace only', async () => {
    const own = tempDir('antifan-own-root-');
    const foreign = tempDir('antifan-foreign-');
    try {
      const fixture = folderFixture({ owner: PROJECT_OWNER, workspaceRoot: own.root });

      const refused = await withRecordingManager(fixture.manager, () =>
        fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: foreign.root })
      ) as { ok: false; reason: string; message: string };
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'FOLDER_NOT_OWNED', 'a project window may not mint into a folder it does not own');
      assert.equal(fixture.manager.boots.length, 0, 'a refused folder mints nothing');

      const allowed = await withRecordingManager(fixture.manager, () =>
        fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: own.root })
      ) as { ok: boolean };
      assert.equal(allowed.ok, true, 'the window\'s own workspace folder mints');
      assert.equal(fixture.manager.boots.length, 1);
      assert.equal(fixture.manager.boots[0]!.ownerKey, ownerKey(PROJECT_OWNER));
    } finally {
      own.cleanup();
      foreign.cleanup();
    }
  });

  it('answers CANCELLED for a chooser the user closed, minting nothing', async () => {
    const fixture = folderFixture({ owner: UNASSIGNED_OWNER });
    const previousDialog = electronStub.dialog.showOpenDialog;
    const seen: unknown[] = [];
    electronStub.dialog.showOpenDialog = async (_window: unknown, options: unknown) => {
      seen.push(options);
      return { canceled: true, filePaths: [] };
    };
    try {
      const result = await withRecordingManager(fixture.manager, () =>
        fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, {})
      ) as { ok: false; reason: string };
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'CANCELLED');
      assert.equal(fixture.manager.boots.length, 0, 'a closed chooser must never mint');
      const options = seen[0] as { defaultPath?: string };
      assert.ok(typeof options?.defaultPath === 'string' && options.defaultPath.length > 0, 'the chooser still opens at the workspace root it was given');
      assert.equal(options.defaultPath!.includes('/'), false, 'defaultPath is the normalized backslash form the Windows dialog accepts');
    } finally {
      electronStub.dialog.showOpenDialog = previousDialog;
    }
  });

  it('refuses a folder that does not exist and a payload that names nothing real', async () => {
    const fixture = folderFixture({ owner: UNASSIGNED_OWNER });

    const missing = await withRecordingManager(fixture.manager, () =>
      fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: path.join(os.tmpdir(), 'antifan-not-here-zz') })
    ) as { ok: false; reason: string };
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'FOLDER_INVALID');

    const blank = await withRecordingManager(fixture.manager, () =>
      fixture.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, { folder: '   ' })
    ) as { ok: false; reason: string };
    assert.equal(blank.ok, false);
    assert.equal(blank.reason, 'INVALID_PAYLOAD', 'naming the field at all asks for a filesystem answer, not a dialog');
    assert.equal(fixture.manager.boots.length, 0);
  });
});
