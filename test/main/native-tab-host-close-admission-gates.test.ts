/**
 * The terminal RPC routes are the host's PTY-minting surface: a session switch, a wake,
 * a set-active, a restart or a per-session write can each materialize a shell inside the
 * daemon after the call has already resolved. Each of those routes must assert and
 * register its admission in the synchronous step BEFORE the daemon call, hold it across
 * the round-trip and release in `finally` — and refuse, fail-closed, while the asking
 * window's own close is reserved or a quit holds application admission.
 *
 * These rows drive the real CHROME_ROUTES table through the route harness: the sender
 * resolves to this host as `sidebar`, the route reads its owner key off the same
 * `shellOwnerKeyForSender` production dispatch calls, and a recording TerminalManager
 * stands behind `getInstance()`, so a refusal is told from a call that reached the
 * manager. The `on` channel exercises the production wrapper too: a refused
 * fire-and-forget send is logged and swallowed, never thrown back at the renderer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { WebContentsView } from 'electron';
import type { NativeTabHost, TabHostCloseAdmission } from '../../src/main/browser/native-tab-host';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
import type { PageCloseReservations } from '../../src/main/browser/project-close-coordinator';
import type { ChromeRouteHarness } from '../support/chrome-route-harness';
import { installElectronStub } from '../support/electron-stub';

installElectronStub();

// Reason: the stub's BrowserWindow carries no statics, and SWITCH_SESSION asks it for the
// sender's window — a miss reads as "not a terminal window", the only metadata branch the
// admitted rows would otherwise have to feed.
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
const { ownerKey } = require('../../src/main/browser/project-window-shell') as typeof import('../../src/main/browser/project-window-shell');
const { TERMINAL_CHANNELS } = require('../../src/shared/contracts') as typeof import('../../src/shared/contracts');
const { CapabilityError } = require('../../src/shared/control-plane-contracts') as typeof import('../../src/shared/control-plane-contracts');
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const { createChromeRouteHarness } = require('../support/chrome-route-harness') as typeof import('../support/chrome-route-harness');

const PROJECT_OWNER = { kind: 'project', projectId: 'proj-1' } as const;
const PROJECT_KEY = ownerKey(PROJECT_OWNER);

/** The manager face the gated routes call; every member records instead of spawning a PTY. */
class RecordingTerminalManager {
  public readonly calls: string[] = [];

  public async switchSession(id: string): Promise<boolean> {
    this.calls.push(`switchSession:${id}`);
    return true;
  }

  public async wakeSession(id: string): Promise<boolean> {
    this.calls.push(`wakeSession:${id}`);
    return true;
  }

  public async writeTo(id: string, _input: string): Promise<boolean> {
    this.calls.push(`writeTo:${id}`);
    return true;
  }

  public async restart(cwd?: string): Promise<void> {
    this.calls.push(`restart:${cwd ?? ''}`);
  }

  /**
   * The scope seam the host reads before it lets any route name a session. These rows seed
   * no capsule: every session is untagged, and a host with no verified workspace admits
   * exactly those, so the gate under test here stays the admission, not the scope.
   */
  public sessionCapsuleId(_sessionId: string): string | undefined {
    return undefined;
  }

  /** One session, already the active one, so an implicit route has something to aim at. */
  public getActiveSessionId(): string {
    return 'sess-own';
  }

  public getSession(id: string): { id: string } | undefined {
    return id === 'sess-own' ? { id } : undefined;
  }

  public getSessionState(): { activeSessionId: string; sessions: Array<{ id: string }>; snapshot: string; snapshotThroughSeq: number } {
    return { activeSessionId: 'sess-own', sessions: [{ id: 'sess-own' }], snapshot: '', snapshotThroughSeq: 0 };
  }

  public readonly setCapsuleDeferreds: Array<PromiseWithResolvers<void>> = [];

  /** The full call, for rows that have to prove which workspace the terminal was pointed at. */
  public readonly setCapsuleArgs: Array<{ capsuleId: string; workspacePath?: string; sessionId?: string }> = [];

  public setCapsule(capsuleId: string, workspacePath?: string, sessionId?: string): Promise<void> {
    this.calls.push(`setCapsule:${capsuleId}`);
    this.setCapsuleArgs.push({ capsuleId, workspacePath, sessionId });
    const deferred = Promise.withResolvers<void>();
    this.setCapsuleDeferreds.push(deferred);
    return deferred.promise;
  }
}

/** Run one route with the shared manager replaced; the real one is put back afterwards. */
function withRecordingManager<T>(manager: RecordingTerminalManager, run: () => T): T {
  const previous = TerminalManagerRuntime.getInstance();
  TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
  try {
    return run();
  } finally {
    TerminalManagerRuntime.setInstance(previous);
  }
}

/** The refusal a route raised, or a readable failure when nothing was refused. */
async function refusalOf(run: () => unknown): Promise<InstanceType<typeof CapabilityError>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CapabilityError) return error;
    throw error;
  }
  throw new Error('expected a refusal, but the call resolved');
}

function asSeam(reservations: PageCloseReservations): TabHostCloseAdmission {
  return reservations as unknown as TabHostCloseAdmission;
}

function buildGateHost(admission: TabHostCloseAdmission, shell: unknown): NativeTabHost {
  const host = Object.create(NativeTabHostRuntime.prototype) as Record<string, unknown>;
  host.closeAdmission = admission;
  host.shell = shell;
  host.popoutWindow = null;
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.tabs = new Map();
  host.automationTabId = null;
  host.isDisposed = false;
  return host as unknown as NativeTabHost;
}

/**
 * One window's host, its shell and the route harness that speaks for its sidebar. The
 * harness mints the sender first, then the double's CURRENT views are what make that
 * sender chrome — exactly how production learns it.
 */
function gateFixture(): { reservations: PageCloseReservations; invoke: ChromeRouteHarness['invoke']; host: NativeTabHost } {
  const reservations = new PageCloseReservationsRuntime();
  const shell = createShellDouble();
  Object.assign(shell, { owner: PROJECT_OWNER });
  const host = buildGateHost(asSeam(reservations), shell);
  const harness = createChromeRouteHarness({ host });
  // Reason: the harness's fake WebContents exposes its sender id; that is the only member
  // the row needs, to seat it as this shell's sidebar.
  const sender = harness.sender as { id: number };
  shell.sidebarView = {
    webContents: { id: sender.id, isDestroyed: () => false, send: () => {} },
    setBounds: () => {},
  } as unknown as WebContentsView;
  return { reservations, host, invoke: (channel, ...args) => harness.invoke(channel, ...args) };
}

describe('NativeTabHost close-admission gates', () => {
  it('refuses a session switch asked by a closing window, and admits it after the release', async () => {
    const { reservations, invoke } = gateFixture();
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
    const manager = new RecordingTerminalManager();

    const refusal = await withRecordingManager(manager, () => refusalOf(() => invoke(TERMINAL_CHANNELS.SWITCH_SESSION, 'sess-1')));

    assert.equal(refusal.code, 'TARGET_STALE');
    assert.match(refusal.message, /antifan:terminal:switch-session/);
    assert.match(refusal.message, /is closing/);
    assert.deepEqual(manager.calls, [], 'a refused switch must not reach the manager');
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'a refused call registers nothing');

    releaseOwner();

    assert.equal(
      await withRecordingManager(manager, () => invoke(TERMINAL_CHANNELS.SWITCH_SESSION, 'sess-1')),
      true,
      'the release admits the same call'
    );
    assert.deepEqual(manager.calls, ['switchSession:sess-1']);
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'the admission released with the call');
  });

  it('refuses a session wake asked by a closing window, and admits it after the release', async () => {
    const { reservations, invoke } = gateFixture();
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
    const manager = new RecordingTerminalManager();

    const refusal = await withRecordingManager(manager, () => refusalOf(() => invoke(TERMINAL_CHANNELS.WAKE_SESSION, 'sess-2')));

    assert.equal(refusal.code, 'TARGET_STALE');
    assert.match(refusal.message, /antifan:terminal:wake-session/);
    assert.match(refusal.message, /is closing/);
    assert.deepEqual(manager.calls, [], 'a refused wake must not reach the manager');
    assert.equal(reservations.snapshot().inFlightOperations, 0);

    releaseOwner();

    assert.equal(
      await withRecordingManager(manager, () => invoke(TERMINAL_CHANNELS.WAKE_SESSION, 'sess-2')),
      true,
      'the release admits the same call'
    );
    assert.deepEqual(manager.calls, ['wakeSession:sess-2']);
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });

  it('refuses a set-active asked by a closing window, and admits it after the release', async () => {
    const { reservations, invoke } = gateFixture();
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
    const manager = new RecordingTerminalManager();

    const refusal = await withRecordingManager(manager, () =>
      refusalOf(() => invoke(TERMINAL_CHANNELS.SET_ACTIVE_SESSION, { sessionId: 'sess-3' }))
    );

    assert.equal(refusal.code, 'TARGET_STALE');
    assert.match(refusal.message, /antifan:terminal:set-active-session/);
    assert.match(refusal.message, /is closing/);
    assert.deepEqual(manager.calls, [], 'a refused set-active must not reach the manager');
    assert.equal(reservations.snapshot().inFlightOperations, 0);

    releaseOwner();

    assert.equal(
      await withRecordingManager(manager, () => invoke(TERMINAL_CHANNELS.SET_ACTIVE_SESSION, { sessionId: 'sess-3' })),
      true,
      'the release admits the same call'
    );
    assert.deepEqual(manager.calls, ['switchSession:sess-3']);
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });

  it('logs and swallows a refused per-session write instead of reaching the manager', async () => {
    const { reservations, invoke } = gateFixture();
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
    const manager = new RecordingTerminalManager();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      // The 'on' dispatch has no rejection path back to the sender, so a refusal must be
      // logged where it happened — and the manager must see nothing.
      withRecordingManager(manager, () => {
        invoke('antifan:terminal:input-session', { id: 'sess-4', input: 'ls\n' });
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(manager.calls, [], 'a refused write must not reach the manager');
    assert.equal(warnings.length, 1, 'the refusal is logged once, not thrown');
    assert.match(warnings[0] ?? '', /antifan:terminal:input-session/);
    assert.match(warnings[0] ?? '', /is closing/);
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'a refused write registers nothing');

    releaseOwner();

    withRecordingManager(manager, () => {
      invoke('antifan:terminal:input-session', { id: 'sess-4', input: 'ls\n' });
    });
    await yieldToLoop();

    assert.deepEqual(manager.calls, ['writeTo:sess-4'], 'the release admits the write');
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'the admission released when the write settled');
  });

  it('refuses a restart while a window close or a quit holds admission, and admits it once open', async () => {
    const { reservations, invoke } = gateFixture();
    const manager = new RecordingTerminalManager();

    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
    const ownerRefusal = await withRecordingManager(manager, () => refusalOf(() => invoke(TERMINAL_CHANNELS.RESTART)));
    assert.equal(ownerRefusal.code, 'TARGET_STALE', 'a restart mints a PTY: the closing window must refuse it');
    releaseOwner();

    const releaseApplication = reservations.reserveApplicationAdmission();
    const quitRefusal = await withRecordingManager(manager, () => refusalOf(() => invoke(TERMINAL_CHANNELS.RESTART)));
    assert.equal(quitRefusal.code, 'RUNTIME_DRAINING', 'a quit in progress must refuse the restart outright');
    releaseApplication();

    assert.deepEqual(manager.calls, [], 'a refused restart must not reach the manager');
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'a refused restart registers nothing');

    assert.equal(
      await withRecordingManager(manager, () => invoke(TERMINAL_CHANNELS.RESTART)),
      true,
      'admission open: the same call runs'
    );
    assert.deepEqual(manager.calls, ['restart:']);
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'the admission released with the call');
  });

  it('refuses capsule:pick-folder before any capsule mutation, and only mutates inside the held admission once open', async () => {
    const { reservations, invoke, host } = gateFixture();
    const priorShowOpenDialog = electronStub.dialog.showOpenDialog;
    electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/picked/workspace'] });
    const mutations: string[] = [];
    let inFlightDuringCreate = -1;
    (host as unknown as Record<string, unknown>).capsuleManager = {
      create: (name: string) => {
        inFlightDuringCreate = reservations.snapshot().inFlightOperations;
        mutations.push(`create:${name}`);
        return { id: 'cap-picked' };
      },
      switchTo: (id: string) => { mutations.push(`switchTo:${id}`); },
      getActive: () => undefined,
      // No row records the picked folder yet, which is the case that must mint one.
      list: () => [],
    };
    const manager = new RecordingTerminalManager();
    const previous = TerminalManagerRuntime.getInstance();
    TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
    try {
      // The picker answers first; only then may the route touch the capsule manager, and
      // never before its owner-attributed admission is in hand.
      const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);
      const refusal = await refusalOf(() => invoke('antifan:capsule:pick-folder', {}));
      assert.equal(refusal.code, 'TARGET_STALE');
      assert.deepEqual(mutations, [], 'a refused pick must leave the capsule manager untouched');
      assert.deepEqual(manager.calls, [], 'a refused pick never reaches setCapsule');
      assert.equal(reservations.snapshot().inFlightOperations, 0);
      releaseOwner();

      const pendingPick = invoke('antifan:capsule:pick-folder', {}) as Promise<{ id: string }>;
      await yieldToLoop();
      assert.deepEqual(mutations, ['create:workspace', 'switchTo:cap-picked']);
      assert.equal(inFlightDuringCreate, 1, 'the capsule mutation itself runs inside the held admission');
      assert.deepEqual(manager.calls, ['setCapsule:cap-picked']);
      assert.equal(reservations.snapshot().inFlightOperations, 1, 'the pick stays measured until setCapsule settles');

      manager.setCapsuleDeferreds[0]!.resolve();
      const picked = await pendingPick;
      assert.equal(picked.id, 'cap-picked');
      assert.equal(reservations.snapshot().inFlightOperations, 0, 'the admission released when setCapsule settled');
    } finally {
      TerminalManagerRuntime.setInstance(previous);
      electronStub.dialog.showOpenDialog = priorShowOpenDialog;
    }
  });

  it('points the shell at the capsule a re-picked folder already has instead of minting another row', async () => {
    // Picking a folder the switcher already visited used to mint a second capsule for the same
    // directory, which is how one workspace accumulated a list of identically named rows.
    const { invoke, host } = gateFixture();
    const priorShowOpenDialog = electronStub.dialog.showOpenDialog;
    electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/picked/workspace'] });
    const mutations: string[] = [];
    (host as unknown as Record<string, unknown>).capsuleManager = {
      create: (name: string) => { mutations.push(`create:${name}`); return { id: 'cap-minted' }; },
      switchTo: (id: string) => { mutations.push(`switchTo:${id}`); },
      getActive: () => ({ id: 'cap-active' }),
      list: () => [
        { id: 'cap-active', workspacePath: '/picked/workspace', updatedAt: 20, projectId: '', workspaceId: '' },
      ],
    };
    const manager = new RecordingTerminalManager();
    const previous = TerminalManagerRuntime.getInstance();
    TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
    try {
      const pendingPick = invoke('antifan:capsule:pick-folder', {}) as Promise<{ id: string }>;
      await yieldToLoop();
      assert.deepEqual(mutations, [], 'a folder that already has a row neither mints nor re-switches');
      assert.deepEqual(manager.calls, ['setCapsule:cap-active'], 'the picked path reaches the adopted capsule');

      manager.setCapsuleDeferreds[0]!.resolve();
      assert.equal((await pendingPick).id, 'cap-active');
    } finally {
      TerminalManagerRuntime.setInstance(previous);
      electronStub.dialog.showOpenDialog = priorShowOpenDialog;
    }
  });

  it('switches to a matching row that is not the active one, and mints only when the folder has none', async () => {
    const { invoke, host } = gateFixture();
    const priorShowOpenDialog = electronStub.dialog.showOpenDialog;
    electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/picked/workspace'] });
    const mutations: string[] = [];
    (host as unknown as Record<string, unknown>).capsuleManager = {
      create: (name: string) => { mutations.push(`create:${name}`); return { id: 'cap-minted' }; },
      switchTo: (id: string) => { mutations.push(`switchTo:${id}`); },
      getActive: () => ({ id: 'cap-elsewhere' }),
      list: () => [
        { id: 'cap-elsewhere', workspacePath: '/other/workspace', updatedAt: 50, projectId: '', workspaceId: '' },
        { id: 'cap-free', workspacePath: '/picked/workspace', updatedAt: 10, projectId: '', workspaceId: '' },
      ],
    };
    const manager = new RecordingTerminalManager();
    const previous = TerminalManagerRuntime.getInstance();
    TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
    try {
      const pendingPick = invoke('antifan:capsule:pick-folder', {}) as Promise<{ id: string }>;
      await yieldToLoop();
      assert.deepEqual(mutations, ['switchTo:cap-free'], 'an existing row for the folder is switched to, never duplicated');
      assert.deepEqual(manager.calls, ['setCapsule:cap-free']);

      manager.setCapsuleDeferreds[0]!.resolve();
      assert.equal((await pendingPick).id, 'cap-free');
    } finally {
      TerminalManagerRuntime.setInstance(previous);
      electronStub.dialog.showOpenDialog = priorShowOpenDialog;
    }
  });

  it('adopts a row that already belongs to a project when it is the only row for the folder', async () => {
    // Adopting is deliberate: minting a free row instead would add the duplicate this route exists
    // to stop. The shell is only re-pointed — no affiliation moves — so the project keeps its row.
    const { invoke, host } = gateFixture();
    const priorShowOpenDialog = electronStub.dialog.showOpenDialog;
    electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/picked/workspace'] });
    const mutations: string[] = [];
    (host as unknown as Record<string, unknown>).capsuleManager = {
      create: (name: string) => { mutations.push(`create:${name}`); return { id: 'cap-minted' }; },
      switchTo: (id: string) => { mutations.push(`switchTo:${id}`); },
      getActive: () => ({ id: 'cap-elsewhere' }),
      list: () => [
        {
          id: 'cap-owned',
          workspacePath: '/picked/workspace',
          updatedAt: 10,
          projectId: 'project-00000000-0000-4000-8000-0000000000dd',
          workspaceId: 'workspace-00000000-0000-4000-8000-0000000000dd',
        },
      ],
    };
    const manager = new RecordingTerminalManager();
    const previous = TerminalManagerRuntime.getInstance();
    TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
    try {
      const pendingPick = invoke('antifan:capsule:pick-folder', {}) as Promise<{ id: string }>;
      await yieldToLoop();
      assert.deepEqual(mutations, ['switchTo:cap-owned']);
      assert.deepEqual(manager.calls, ['setCapsule:cap-owned']);

      manager.setCapsuleDeferreds[0]!.resolve();
      assert.equal((await pendingPick).id, 'cap-owned');
    } finally {
      TerminalManagerRuntime.setInstance(previous);
      electronStub.dialog.showOpenDialog = priorShowOpenDialog;
    }
  });

  it('recognizes a stored folder behind a junction alias instead of minting a second row for it', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pick-real-'));
    const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pick-link-'));
    const alias = path.join(linkBase, 'alias');
    const { invoke, host } = gateFixture();
    const priorShowOpenDialog = electronStub.dialog.showOpenDialog;
    try {
      fs.symlinkSync(real, alias, 'junction');
      // The store records the resolved folder; the chooser answers with the alias.
      electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [alias] });
      const mutations: string[] = [];
      (host as unknown as Record<string, unknown>).capsuleManager = {
        create: (name: string) => { mutations.push(`create:${name}`); return { id: 'cap-minted' }; },
        switchTo: (id: string) => { mutations.push(`switchTo:${id}`); },
        getActive: () => ({ id: 'cap-elsewhere' }),
        list: () => [
          { id: 'cap-stored', workspacePath: real, updatedAt: 10, projectId: '', workspaceId: '' },
        ],
      };
      const manager = new RecordingTerminalManager();
      const previous = TerminalManagerRuntime.getInstance();
      TerminalManagerRuntime.setInstance(manager as unknown as TerminalManager);
      try {
        const pendingPick = invoke('antifan:capsule:pick-folder', {}) as Promise<{ id: string }>;
        await yieldToLoop();
        assert.deepEqual(mutations, ['switchTo:cap-stored'], 'the alias resolves to the folder the store already records');
        assert.equal(
          manager.setCapsuleArgs[0]?.workspacePath,
          fs.realpathSync(real),
          'the terminal is pointed at the resolved folder, not the alias spelling',
        );

        manager.setCapsuleDeferreds[0]!.resolve();
        assert.equal((await pendingPick).id, 'cap-stored');
      } finally {
        TerminalManagerRuntime.setInstance(previous);
      }
    } finally {
      electronStub.dialog.showOpenDialog = priorShowOpenDialog;
      fs.rmSync(linkBase, { recursive: true, force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
