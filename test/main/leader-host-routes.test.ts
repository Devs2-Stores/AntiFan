/**
 * The host half of the Leader feature, against the real NativeTabHost prototype and route table:
 * the `antifan:terminal:leader-set` route (the only way a terminal becomes a Leader), the Leader
 * stamps on a window's session projection, the registry prune on a closed session, and the
 * placement of a Leader's worker terminal in the project that owns the folder.
 *
 * Only the OS boundaries are doubled: the Electron module and the terminal manager's PTYs.
 */
import { describe, it, after, afterEach, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installElectronStub } from '../support/electron-stub';
import { ownerKey, type WindowOwner } from '../../src/main/browser/window-owner';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { TERMINAL_CHANNELS, type TerminalLeaderSetResult } from '../../src/shared/contracts';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { PageCloseReservations } from '../../src/main/browser/project-close-coordinator';
import type { ChromeRouteHarness } from '../support/chrome-route-harness';
import type { ShellDouble } from '../support/project-window-shell-double';
import { LeaderRegistry } from '../../src/main/leader/leader-registry';

// The host module reaches for Electron while it is being loaded, so the fault has to be installed
// before the import runs.
installElectronStub();

const { NativeTabHost: NativeTabHostRuntime } =
  require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { PageCloseReservations: PageCloseReservationsRuntime } =
  require('../../src/main/browser/project-close-coordinator') as typeof import('../../src/main/browser/project-close-coordinator');
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const { createChromeRouteHarness } = require('../support/chrome-route-harness') as typeof import('../support/chrome-route-harness');

const MANAGER: WindowOwner = { kind: 'unassigned' };
const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'proj-a' };

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-leader-host-'));
const PREVIOUS_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
fs.mkdirSync(process.env.ANTIFAN_CONFIG_DIR, { recursive: true });
const REGISTRY_FILE = path.join(process.env.ANTIFAN_CONFIG_DIR, 'leader-terminals.json');
const PROJECT_FOLDER = path.join(SCRATCH_DIR, 'project-folder');
fs.mkdirSync(PROJECT_FOLDER, { recursive: true });

interface RecordedRow {
  id: string;
  name: string;
  cwd: string;
  sessionGeneration: number;
  state: string;
  ownerKey?: string;
  capsuleId?: string;
  splitOf?: string;
}

const row = (id: string, extra: Partial<RecordedRow> = {}): RecordedRow => ({
  id,
  name: id,
  cwd: 'E:/Work/a',
  sessionGeneration: 1,
  state: 'running',
  ownerKey: ownerKey(PROJECT_A),
  capsuleId: 'capsule-a',
  ...extra,
});
const LEAD_ROW = row('terminal-lead');
const WORK_ROW = row('terminal-work', { cwd: 'E:/Work/b' });
const SPLIT_ROW = row('split-lead', { splitOf: 'terminal-lead' });
const FOREIGN_ROW = row('terminal-foreign', { ownerKey: ownerKey({ kind: 'project', projectId: 'proj-b' }), capsuleId: 'capsule-b' });

/** The manager face the host reads; every mutating member records instead of spawning a shell. */
class RecordingTerminalManager {
  public readonly calls: string[] = [];
  public activeSessionId: string;
  private minted = 0;

  constructor(public readonly rows: RecordedRow[]) {
    this.activeSessionId = rows[0]?.id ?? '';
  }

  public getSession(sessionId: string): RecordedRow | undefined { return this.rows.find((entry) => entry.id === sessionId); }
  public getActiveSessionId(): string { return this.activeSessionId; }
  public getSessionState(): Record<string, unknown> {
    return {
      activeSessionId: this.activeSessionId,
      sessions: this.rows.map((entry) => ({ ...entry, active: entry.id === this.activeSessionId, buffer: '', bufferLength: 0, snapshotThroughSeq: 0 })),
      snapshot: '',
      snapshotThroughSeq: 0,
    };
  }
  public listSessions(): RecordedRow[] { return [...this.rows]; }
  public sessionOwnerKey(sessionId: string): string | undefined { return this.rows.find((entry) => entry.id === sessionId)?.ownerKey; }
  public sessionCapsuleId(sessionId: string): string | undefined { return this.rows.find((entry) => entry.id === sessionId)?.capsuleId; }
  public async createSession(cwd: string, capsuleId: string, ownerKeyValue?: string): Promise<string> {
    this.minted += 1;
    const id = `terminal-minted-${this.minted}`;
    this.calls.push(`createSession:${cwd}:${capsuleId}:${ownerKeyValue}`);
    this.rows.push(row(id, { cwd, capsuleId, ownerKey: ownerKeyValue }));
    return id;
  }
  public renameSession(sessionId: string, name: string): boolean {
    this.calls.push(`renameSession:${sessionId}:${name}`);
    const target = this.rows.find((entry) => entry.id === sessionId);
    if (target) target.name = name;
    return Boolean(target);
  }
}

interface HostUnderTest {
  shell: ShellDouble & { owner?: WindowOwner };
  capsuleManager: unknown;
  admitsSessionForWindow(sessionId: string, senderId?: number): boolean;
  placeLeaderTerminal(request: { cwd: string; name?: string }): Promise<{ ok: boolean; sessionId?: string; ownerKey?: string; capsuleId?: string; reason?: string }>;
  terminalStateForWindow(state: unknown, includeSessionId?: string, senderId?: number): { sessions: Array<Record<string, unknown>> };
  pruneLeaderRegistry(closedId: string): void;
}

function buildHost(options: { owner: WindowOwner; capsuleManager: unknown }): HostUnderTest & Record<string, unknown> {
  const host: HostUnderTest & Record<string, unknown> = Object.create(NativeTabHostRuntime.prototype);
  host.broadcastState = () => {};
  host.updateLayout = () => {};
  host.schedulePersist = () => {};
  host.isDisposed = false;
  host.isPersistingTabs = false;
  host.hasPendingPersist = false;
  host.persistTimer = null;
  host.tabs = new Map<string, unknown>();
  host.tabOrder = [];
  host.activeTabId = '';
  host.automationTabId = null;
  host.tabByWebContents = new WeakMap<object, string>();
  host.terminalAgentAffinity = new Map<string, Record<string, unknown>>();
  host.sessionTabPools = new Map<string, Record<string, unknown>>();
  host.closedTabAnchors = new Map<string, unknown>();
  host.terminalWindows = new Map<number, unknown>();
  host.terminalWindowMeta = new Map<number, { sessionId?: string; isPopout?: boolean }>();
  host.terminalDataBatches = new Map<string, Record<string, unknown>>();
  host.terminalDataFlushTimer = null;
  host.terminalFanoutMessages = 0;
  host.windowSelectedSession = new Map<number, string>();
  host.previewWatcherPool = { retain: () => () => {} };
  host.tabPreviewUnsubscribers = new Map<string, () => void>();
  host.closeAdmission = new PageCloseReservationsRuntime();
  host.capsuleManager = options.capsuleManager;
  host.popoutWindow = null;
  const shell = createShellDouble({ isSidebarOpen: false, sidebarWidth: 380 });
  Object.assign(shell, { owner: options.owner });
  host.shell = shell as ShellDouble & { owner?: WindowOwner };
  host.windowWorkspaceAffiliation = null;
  return host;
}

interface CapsuleRow { id: string; name: string; workspacePath: string; projectId?: string; workspaceId?: string }

function capsuleRegistry(rows: CapsuleRow[], affiliationsByRoot: Record<string, { projectId: string; workspaceId: string }> = {}): Record<string, unknown> {
  return {
    list: () => [...rows],
    getActive: () => rows[0] ?? null,
    get: (id: string) => {
      const found = rows.find((entry) => entry.id === id);
      if (!found) throw new Error(`Capsule not found: ${id}`);
      return found;
    },
    uniqueAffiliationByRoot: (root: string) => (root in affiliationsByRoot ? affiliationsByRoot[root] : undefined),
    create: (name: string, workspacePath: string) => {
      const created = { id: `capsule-created-${rows.length + 1}`, name, workspacePath };
      rows.push(created);
      return created;
    },
    switchTo: () => {},
  };
}

interface WindowFixture {
  host: HostUnderTest & Record<string, unknown>;
  recording: RecordingTerminalManager;
  harness: ChromeRouteHarness;
  senderId: number;
}

function windowFixture(options: { owner: WindowOwner; rows: RecordedRow[]; capsuleManager?: unknown }): WindowFixture {
  const host = buildHost({ owner: options.owner, capsuleManager: options.capsuleManager ?? capsuleRegistry([]) });
  const recording = new RecordingTerminalManager(options.rows.map((entry) => ({ ...entry })));
  TerminalManager.setInstance(recording as unknown as TerminalManager);
  const harness = createChromeRouteHarness({ host: host as unknown as NativeTabHost });
  const sender = harness.sender;
  if (!sender || typeof sender !== 'object' || !('id' in sender) || typeof sender.id !== 'number') {
    throw new Error('the chrome route harness must report a webContents sender');
  }
  const senderId = sender.id;
  host.shell.sidebarView = {
    webContents: { id: senderId, isDestroyed: () => false, send: () => {} },
    setBounds: () => {},
    setBackgroundColor: () => {},
  };
  return { host, recording, harness, senderId };
}

const setLeader = async (harness: ChromeRouteHarness, sessionId: string, leader: boolean): Promise<TerminalLeaderSetResult> =>
  (await harness.invoke(TERMINAL_CHANNELS.LEADER_SET, { sessionId, leader })) as TerminalLeaderSetResult;

after(() => {
  LeaderRegistry.resetInstance();
  if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
  else process.env.ANTIFAN_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

describe('Leader host: the leader-set route', () => {
  beforeEach(() => {
    LeaderRegistry.resetInstance();
    fs.rmSync(REGISTRY_FILE, { force: true });
  });
  afterEach(() => {
    (TerminalManager as unknown as { instance?: unknown }).instance = undefined;
  });

  it('marks and clears a base terminal the window shows, and persists it', async () => {
    const { harness } = windowFixture({ owner: MANAGER, rows: [LEAD_ROW, WORK_ROW, SPLIT_ROW] });
    const changes: number[] = [];
    LeaderRegistry.getInstance().on('change', () => changes.push(1));

    assert.deepEqual(await setLeader(harness, 'terminal-lead', true), { ok: true, leader: true });
    assert.equal(LeaderRegistry.getInstance().isLeader('terminal-lead'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).leaders, ['terminal-lead']);
    assert.deepEqual(await setLeader(harness, 'terminal-lead', true), { ok: true, leader: true }, 'a repeat is answered, not an error');
    assert.equal(changes.length, 1, 'only a real change notifies the windows');

    assert.deepEqual(await setLeader(harness, 'terminal-lead', false), { ok: true, leader: false });
    assert.equal(LeaderRegistry.getInstance().isLeader('terminal-lead'), false);
    assert.equal(changes.length, 2);
  });

  it('refuses a malformed payload, a split pane and an unknown terminal, and flips nothing', async () => {
    const { harness } = windowFixture({
      owner: MANAGER,
      rows: [LEAD_ROW, SPLIT_ROW, row('terminal-closed', { state: 'closed' }), row('terminal-agent', { ownerKey: 'agent:tab-x' })],
    });
    assert.deepEqual(await harness.invoke(TERMINAL_CHANNELS.LEADER_SET, { sessionId: 'terminal-lead' }), { ok: false, leader: false, error: 'INVALID_PAYLOAD' });
    assert.deepEqual(await harness.invoke(TERMINAL_CHANNELS.LEADER_SET, { sessionId: '', leader: true }), { ok: false, leader: false, error: 'INVALID_PAYLOAD' });
    assert.deepEqual(await harness.invoke(TERMINAL_CHANNELS.LEADER_SET, 'terminal-lead'), { ok: false, leader: false, error: 'INVALID_PAYLOAD' });
    assert.deepEqual(await setLeader(harness, 'split-lead', true), { ok: false, leader: false, error: 'SPLIT_NOT_ALLOWED' });
    assert.deepEqual(await setLeader(harness, 'terminal-nowhere', true), { ok: false, leader: false, error: 'UNKNOWN_SESSION' });
    assert.deepEqual(await setLeader(harness, 'terminal-closed', true), { ok: false, leader: false, error: 'UNKNOWN_SESSION' });
    assert.deepEqual(await setLeader(harness, 'terminal-agent', true), { ok: false, leader: false, error: 'AGENT_OWNED' });
    assert.deepEqual(LeaderRegistry.getInstance().leaders(), []);
  });

  it("never lets a project window reach another project's terminal", async () => {
    const { harness } = windowFixture({ owner: PROJECT_A, rows: [LEAD_ROW, FOREIGN_ROW] });
    await assert.rejects(async () => harness.invoke(TERMINAL_CHANNELS.LEADER_SET, { sessionId: 'terminal-foreign', leader: true }), /terminal-foreign/);
    assert.equal(LeaderRegistry.getInstance().isLeader('terminal-foreign'), false);
  });
});

describe('Leader host: projection, prune and placement', () => {
  beforeEach(() => {
    LeaderRegistry.resetInstance();
    fs.rmSync(REGISTRY_FILE, { force: true });
  });
  afterEach(() => {
    (TerminalManager as unknown as { instance?: unknown }).instance = undefined;
  });

  it('stamps leader, workerOf and workerTitle on the rows a window is shown, and nothing on the others', () => {
    const { host, recording, senderId } = windowFixture({ owner: MANAGER, rows: [LEAD_ROW, WORK_ROW, FOREIGN_ROW] });
    const registry = LeaderRegistry.getInstance();
    registry.setLeader('terminal-lead', true);
    registry.assignWorker('terminal-work', 'terminal-lead', 'Hàng 12');

    const projected = host.terminalStateForWindow(recording.getSessionState(), undefined, senderId).sessions;
    const byId = new Map(projected.map((entry) => [entry.id as string, entry]));
    assert.equal(byId.get('terminal-lead')?.leader, true);
    assert.equal(byId.get('terminal-lead')?.workerOf, undefined);
    assert.equal(byId.get('terminal-work')?.workerOf, 'terminal-lead');
    assert.equal(byId.get('terminal-work')?.workerTitle, 'Hàng 12');
    assert.equal(byId.get('terminal-work')?.leader, undefined);
    const plain = byId.get('terminal-foreign');
    assert.ok(plain);
    assert.equal('leader' in plain, false, 'an ordinary row carries no Leader fields at all');
    assert.equal('workerOf' in plain, false);
    assert.equal('workerTitle' in plain, false);
  });

  it('drops the Leader and its workers when the Leader session closes', () => {
    const { host, recording } = windowFixture({ owner: MANAGER, rows: [LEAD_ROW, WORK_ROW] });
    const registry = LeaderRegistry.getInstance();
    registry.setLeader('terminal-lead', true);
    registry.assignWorker('terminal-work', 'terminal-lead');

    // The manager may still list the closing session while the event is delivered.
    host.pruneLeaderRegistry('terminal-work');
    assert.equal(registry.workerOf('terminal-work'), undefined, 'a closed worker is dropped');
    assert.equal(registry.isLeader('terminal-lead'), true);

    registry.assignWorker('terminal-work', 'terminal-lead');
    host.pruneLeaderRegistry('terminal-lead');
    assert.equal(registry.isLeader('terminal-lead'), false, 'the Leader lost its rights with its terminal');
    assert.equal(registry.workerOf('terminal-work'), undefined, 'and its workers were released with it');
    assert.deepEqual(recording.calls, []);
  });

  it("places a Leader's terminal in the project that owns the folder, files it as the Manager does, and names it", async () => {
    const real = fs.realpathSync.native(PROJECT_FOLDER);
    const capsules = capsuleRegistry(
      [{ id: 'capsule-p', name: 'project-folder', workspacePath: real, projectId: 'proj-p', workspaceId: 'ws-p' }],
      { [real]: { projectId: 'proj-p', workspaceId: 'ws-p' } }
    );
    const { host, recording } = windowFixture({ owner: MANAGER, rows: [LEAD_ROW], capsuleManager: capsules });

    const placed = await host.placeLeaderTerminal({ cwd: PROJECT_FOLDER, name: 'Hàng 7' });
    assert.equal(placed.ok, true);
    assert.equal(placed.sessionId, 'terminal-minted-1');
    assert.equal(placed.capsuleId, 'capsule-p');
    assert.equal(placed.ownerKey, 'project:proj-p', 'the terminal lands in the owning project so its user can operate it');
    assert.deepEqual(recording.calls, [`createSession:${real}:capsule-p:project:proj-p`, 'renameSession:terminal-minted-1:Hàng 7']);
    assert.equal(recording.getSession('terminal-minted-1')?.name, 'Hàng 7');
  });

  it('refuses a folder that is not a directory without minting anything', async () => {
    const { host, recording } = windowFixture({ owner: MANAGER, rows: [LEAD_ROW] });
    const refused = await host.placeLeaderTerminal({ cwd: path.join(SCRATCH_DIR, 'no-such-folder') });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'FOLDER_INVALID');
    assert.deepEqual(recording.calls, []);
  });
});
