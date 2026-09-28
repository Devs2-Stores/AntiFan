/**
 * Terminal → project handover: moving a terminal to another project (the tab context menu's
 * assignment action).
 *
 * One contract, four layers. They are asserted separately because each can be wrong alone:
 *
 *   1. `TerminalManager.transferSessionOwner` re-stamps the owner key and the workspace capsule
 *      together, clears the capsule for a workspace-less project, refuses invalid targets,
 *      and the re-stamped row is the row the restore path reads back off disk.
 *   2. The shared manager window — an Unassigned shell reading through its own chrome — is a
 *      superset VIEW: every row is visible to it, `agent:*` rows included. A project window still
 *      never sees another owner's row, a legacy key-less row keeps the capsule rule it was
 *      created under, and a sender that is not that window's chrome is not the manager.
 *   3. What that superset may DO with an `agent:` row is narrower than what it may read: the row
 *      is read-only, and the gate answers a typed refusal instead of throwing into an IPC path
 *      that has nowhere to put one.
 *   4. The route that carries the handover (`antifan:terminal:assign-project`) answers in the
 *      same typed vocabulary and reaches `transferSessionOwner` only when it may.
 *
 * Only the OS boundaries are doubled: the Electron module and the PTY spawn step. The manager,
 * the host, the route table and the scope rules under test are the real ones.
 */
import { describe, it, after, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installElectronStub } from '../support/electron-stub';
import { ownerKey, type WindowOwner } from '../../src/main/browser/window-owner';
import {
  TerminalManager,
  DEFAULT_TERMINAL_CAPSULE_ID,
  DEFAULT_TERMINAL_OWNER_KEY,
} from '../../src/main/browser/terminal-manager';
import { TERMINAL_CHANNELS } from '../../src/shared/contracts';
import type { NativeTabHost, TerminalProjectAssignment, TerminalProjectAssignResult } from '../../src/main/browser/native-tab-host';
import type { TerminalProjectLinkResult } from '../../src/main/browser/native-tab-host';
import type { PageCloseReservations } from '../../src/main/browser/project-close-coordinator';
import type { ChromeRouteHarness } from '../support/chrome-route-harness';
import type { ShellDouble } from '../support/project-window-shell-double';
import type { WorkspaceCapsule } from '../../src/main/project/workspace-capsule';

// The host module reaches for Electron while it is being loaded, so the fault has to be installed
// before the import runs. (`import type` above is erased and loads nothing.)
installElectronStub();

const { NativeTabHost: NativeTabHostRuntime } =
  require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { PageCloseReservations: PageCloseReservationsRuntime } =
  require('../../src/main/browser/project-close-coordinator') as typeof import('../../src/main/browser/project-close-coordinator');
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const { createChromeRouteHarness } = require('../support/chrome-route-harness') as typeof import('../support/chrome-route-harness');

const MANAGER: WindowOwner = { kind: 'unassigned' };
const MANAGER_OWNER_KEY = ownerKey(MANAGER);
const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'proj-a' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'proj-b' };
const AGENT_OWNER_KEY = 'agent:tab-9';
const PHUKIEN_CAPSULE = 'capsule-phukien';
const PHUKIEN_PROJECT = 'project-00000000-0000-4000-8000-0000000000a1';
const PHUKIEN_OWNER_KEY = ownerKey({ kind: 'project', projectId: PHUKIEN_PROJECT });
const WORKSPACELESS_PROJECT = 'project-00000000-0000-4000-8000-0000000000a3';
const WORKSPACELESS_OWNER_KEY = ownerKey({ kind: 'project', projectId: WORKSPACELESS_PROJECT });

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-assign-capsule-'));
process.env.ANTIFAN_CONFIG_DIR = SCRATCH_DIR;
const STATE_FILE = path.join(SCRATCH_DIR, 'terminal-sessions.json');

// ---------------------------------------------------------------------------
// Layer 1: the manager seam, over a real TerminalManager and an isolated state file
// ---------------------------------------------------------------------------

interface FakePty {
  pid: number | undefined;
  cols: number;
  rows: number;
  onData: () => { dispose: () => void };
  onExit: () => { dispose: () => void };
  kill: () => void;
  write: () => void;
  resize: (cols: number, rows: number) => void;
}

/** The fields of a live session record the manager reads back (`summarize`, `persist`, teardown). */
interface LiveSessionRow {
  id: string;
  name: string;
  cwd: string;
  pty: FakePty;
  buffer: string;
  bufferBytes: number;
  lastSeq: number;
  sessionGeneration: number;
  state: string;
  capsuleId: string;
  ownerKey: string;
  disposed: boolean;
  splitOf?: string;
}

type TerminalManagerInternals = {
  sessions: Map<string, LiveSessionRow>;
  activeSessionId: string;
  creationCapsuleId?: string;
  creationOwnerKey?: string;
  lastCols?: number;
  lastRows?: number;
  spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
  statePath: () => string;
  readSavedSessions: () => { sessions?: Array<Record<string, unknown>> };
};

const tm = TerminalManager.getInstance();
const tmInternal = tm as unknown as TerminalManagerInternals;
const managerPrototype = TerminalManager.prototype as unknown as TerminalManagerInternals;
const originalSpawn = managerPrototype.spawn;
const originalStatePath = managerPrototype.statePath;

// The real state file lives in the developer's config directory; every row here writes into the
// scratch directory instead.
managerPrototype.statePath = () => STATE_FILE;
// The PTY boundary is the one thing the OS owns. Every row below drives the real manager with a
// double standing in for the shell it would spawn, and the record it hands back carries exactly the
// fields a real one does — `spawn` returns the RECORD, not the pty.
managerPrototype.spawn = function fakeSpawn(id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = 8): LiveSessionRow {
  const pty: FakePty = {
    pid: undefined,
    cols: Math.max(40, initialCols || tmInternal.lastCols || 120),
    rows: Math.max(minimumRows, initialRows || tmInternal.lastRows || 30),
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    kill: () => {},
    write: () => {},
    resize: (nextCols: number, nextRows: number) => { pty.cols = nextCols; pty.rows = nextRows; },
  };
  const session: LiveSessionRow = {
    id,
    name: `Terminal ${id.replace('terminal-', '')}`,
    cwd,
    buffer: restoredBuffer || '',
    bufferBytes: Buffer.byteLength(restoredBuffer || '', 'utf8'),
    lastSeq: 0,
    sessionGeneration: 1,
    state: 'running',
    capsuleId: tmInternal.creationCapsuleId || DEFAULT_TERMINAL_CAPSULE_ID,
    ownerKey: DEFAULT_TERMINAL_OWNER_KEY,
    pty,
    disposed: false,
  };
  tmInternal.sessions.set(id, session);
  return session;
};

/** Drop every live row and the state file, the way a fresh process starts. */
function resetManagerState(): void {
  tmInternal.sessions.clear();
  tmInternal.activeSessionId = '';
  tmInternal.creationCapsuleId = DEFAULT_TERMINAL_CAPSULE_ID;
  tmInternal.creationOwnerKey = DEFAULT_TERMINAL_OWNER_KEY;
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
}

/** The row as the state file carries it, read the way a consumer of that file would read it. */
function savedRow(sessionId: string): Record<string, unknown> | undefined {
  const document: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!document || typeof document !== 'object' || !('sessions' in document) || !Array.isArray(document.sessions)) return undefined;
  return (document.sessions as Array<Record<string, unknown>>).find((row) => row?.id === sessionId);
}

afterEach(() => {
  // Every other row installs a recording manager over the shared singleton; whatever a row left
  // behind is put back here so the next one starts from the real manager.
  if (TerminalManager.getInstance() !== tm) TerminalManager.setInstance(tm);
});

after(async () => {
  await tm.dispose();
  managerPrototype.spawn = originalSpawn;
  managerPrototype.statePath = originalStatePath;
  try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch {}
});

describe('Terminal project handover — TerminalManager.transferSessionOwner', () => {
  it('moves the owner key and the capsule together, in one call', () => {
    resetManagerState();
    const id = tm.createSession(SCRATCH_DIR, 'capsule-comnieu', ownerKey({ kind: 'project', projectId: 'proj-comnieu' }));

    assert.equal(tm.transferSessionOwner(id, PHUKIEN_OWNER_KEY, PHUKIEN_CAPSULE), true, 'a live session belongs to the capsule it is handed to');

    // The two halves are one write: a consumer reading them off the seam must never see a row
    // owned by the target project while it is still attributed to the source workspace.
    assert.equal(tm.sessionOwnerKey(id), PHUKIEN_OWNER_KEY, 'the new owner is on the row');
    assert.equal(tm.sessionCapsuleId(id), PHUKIEN_CAPSULE, 'and so is the new capsule');
  });

  it('re-stamps one record and adopts nothing: the next mint still lands where it would have', () => {
    resetManagerState();
    const moved = tm.createSession(SCRATCH_DIR, 'capsule-comnieu', MANAGER_OWNER_KEY);
    tm.transferSessionOwner(moved, PHUKIEN_OWNER_KEY, PHUKIEN_CAPSULE);

    const next = tm.createSession(SCRATCH_DIR);
    assert.notEqual(next, moved, 'the mint under test is a new row');
    assert.equal(tm.sessionCapsuleId(next), DEFAULT_TERMINAL_CAPSULE_ID, 'the handover must not make the moved capsule ambient');
    assert.equal(tm.sessionOwnerKey(next), DEFAULT_TERMINAL_OWNER_KEY, 'and it must not make the new owner ambient either');
  });

  it('survives the restore path: the re-stamped row is what a fresh process reads back', () => {
    resetManagerState();
    const id = tm.createSession(SCRATCH_DIR, 'capsule-comnieu', ownerKey({ kind: 'project', projectId: 'proj-comnieu' }));
    tm.transferSessionOwner(id, PHUKIEN_OWNER_KEY, PHUKIEN_CAPSULE);
    tm.persistSync();

    const onDisk = savedRow(id);
    assert.ok(onDisk, 'the moved row reached the state file');
    assert.equal(onDisk.ownerKey, PHUKIEN_OWNER_KEY, 'the file carries the new owner, not the one it was minted with');
    assert.equal(onDisk.capsuleId, PHUKIEN_CAPSULE, 'and the new capsule');

    // A fresh process: no live rows, and the boot restores from the file.
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';
    assert.equal(tm.startTerminal(SCRATCH_DIR), true, 'the boot restores the saved row');

    assert.ok(tm.listSessions().some((session) => session.id === id), 'the row comes back');
    assert.equal(tm.sessionOwnerKey(id), PHUKIEN_OWNER_KEY, 'ownership survives the restart');
    assert.equal(tm.sessionCapsuleId(id), PHUKIEN_CAPSULE, 'and so does the workspace it was handed to');
  });

  it('clears a workspace capsule when handing a tab and its panes to a workspace-less project', () => {
    resetManagerState();
    const base = tm.createSession(SCRATCH_DIR, PHUKIEN_CAPSULE, PHUKIEN_OWNER_KEY);
    const pane = tm.createSession(SCRATCH_DIR, PHUKIEN_CAPSULE, PHUKIEN_OWNER_KEY);
    const paneRow = tmInternal.sessions.get(pane);
    assert.ok(paneRow, 'the pane was minted');
    paneRow.splitOf = base;

    assert.equal(tm.transferSessionOwner(pane, WORKSPACELESS_OWNER_KEY), true);
    tm.persistSync();
    for (const sessionId of [base, pane]) {
      assert.equal(tm.sessionOwnerKey(sessionId), WORKSPACELESS_OWNER_KEY);
      assert.equal(tm.sessionCapsuleId(sessionId), undefined);
      const onDisk = savedRow(sessionId);
      assert.ok(onDisk);
      assert.equal(onDisk.ownerKey, WORKSPACELESS_OWNER_KEY);
      assert.equal(onDisk.capsuleId, undefined, 'no previous workspace stamp survives persistence');
    }
  });

  it('refuses an unknown, closed or empty-keyed target with `false`, never with a throw', async () => {
    resetManagerState();
    const live = tm.createSession(SCRATCH_DIR, 'capsule-comnieu', MANAGER_OWNER_KEY);

    assert.equal(tm.transferSessionOwner('terminal-does-not-exist', PHUKIEN_OWNER_KEY, PHUKIEN_CAPSULE), false, 'an unknown session is an answer, not an error');

    // A row being torn down is not a row to hand over: the new owner would be handed a tab whose
    // shell is already gone.
    await tm.closeSession(live);
    assert.equal(tm.transferSessionOwner(live, PHUKIEN_OWNER_KEY, PHUKIEN_CAPSULE), false, 'a closed session is refused');

    const other = tm.createSession(SCRATCH_DIR, 'capsule-comnieu', MANAGER_OWNER_KEY);
    assert.equal(tm.transferSessionOwner(other, '', PHUKIEN_CAPSULE), false, 'an empty owner would file the row under nothing');
    assert.equal(tm.transferSessionOwner(other, '   ', PHUKIEN_CAPSULE), false, 'and so would a blank one');
    assert.equal(tm.transferSessionOwner(other, PHUKIEN_OWNER_KEY, ''), false, 'an empty capsule would attribute the row to nothing');

    assert.equal(tm.sessionOwnerKey(other), MANAGER_OWNER_KEY, 'a refusal leaves the row exactly where it was');
    assert.equal(tm.sessionCapsuleId(other), 'capsule-comnieu');
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the window scope — the shared manager reads everything, nobody else does
// ---------------------------------------------------------------------------

interface RecordedRow {
  id: string;
  name: string;
  cwd: string;
  sessionGeneration: number;
  state: string;
  ownerKey?: string;
  capsuleId?: string;
}

const OWN_ROW: RecordedRow = { id: 'terminal-own', name: 'own', cwd: 'E:/Work/a', sessionGeneration: 1, state: 'running', ownerKey: ownerKey(PROJECT_A), capsuleId: 'capsule-a' };
const OTHER_ROW: RecordedRow = { id: 'terminal-other', name: 'other', cwd: 'E:/Work/b', sessionGeneration: 1, state: 'running', ownerKey: ownerKey(PROJECT_B), capsuleId: 'capsule-b' };
const AGENT_ROW: RecordedRow = { id: 'terminal-agent', name: 'agent', cwd: 'E:/Work/a', sessionGeneration: 1, state: 'running', ownerKey: AGENT_OWNER_KEY, capsuleId: 'capsule-a' };
const UNCLAIMED_ROW: RecordedRow = { id: 'terminal-unclaimed', name: 'unclaimed', cwd: 'E:/Work/a', sessionGeneration: 1, state: 'running', ownerKey: DEFAULT_TERMINAL_OWNER_KEY, capsuleId: DEFAULT_TERMINAL_CAPSULE_ID };
const LEGACY_ROW: RecordedRow = { id: 'terminal-legacy', name: 'legacy', cwd: 'E:/Work/a', sessionGeneration: 1, state: 'running', capsuleId: 'capsule-a' };
const LEGACY_OTHER_ROW: RecordedRow = { id: 'terminal-legacy-sibling', name: 'legacy sibling', cwd: 'E:/Work/b', sessionGeneration: 1, state: 'running', capsuleId: 'capsule-b' };
const LEGACY_UNTAGGED_ROW: RecordedRow = { id: 'terminal-legacy-untagged', name: 'legacy untagged', cwd: 'E:/Work/a', sessionGeneration: 1, state: 'running' };
/** A directory that exists only so the window's workspace root resolves; no row is filed under it. */
const UNVERIFIED_ROOT = path.join(SCRATCH_DIR, 'no-such-workspace');

/**
 * The manager face the host reads. Every member records instead of spawning a shell, so a row
 * that reached the shared manager is told from one that was refused before it.
 */
class RecordingTerminalManager {
  public readonly calls: string[] = [];
  public activeSessionId: string;

  constructor(public readonly rows: RecordedRow[], activeSessionId?: string) {
    this.activeSessionId = activeSessionId ?? rows[0]?.id ?? '';
  }

  public sessionOwnerKey(sessionId: string): string | undefined { return this.rows.find((row) => row.id === sessionId)?.ownerKey; }
  public sessionCapsuleId(sessionId: string): string | undefined { return this.rows.find((row) => row.id === sessionId)?.capsuleId; }
  public getSession(sessionId: string): RecordedRow | undefined { return this.rows.find((row) => row.id === sessionId); }
  public getActiveSessionId(): string { return this.activeSessionId; }
  public getSessionState(): Record<string, unknown> {
    return {
      activeSessionId: this.activeSessionId,
      sessions: this.rows.map((row) => ({ ...row, active: row.id === this.activeSessionId, buffer: '', bufferLength: 0, snapshotThroughSeq: 0 })),
      snapshot: '',
      snapshotThroughSeq: 0,
    };
  }
  public listSessions(): RecordedRow[] { return [...this.rows]; }
  public getFullBuffer(sessionId: string): Record<string, unknown> {
    this.calls.push(`getFullBuffer:${sessionId}`);
    return { sessionId, buffer: `buffer-of-${sessionId}`, snapshotThroughSeq: 1 };
  }
  public transferSessionOwner(sessionId: string, ownerKeyValue: string, capsuleId?: string): boolean {
    this.calls.push(`transferSessionOwner:${sessionId}:${ownerKeyValue}:${capsuleId}`);
    const row = this.rows.find((entry) => entry.id === sessionId);
    if (!row) return false;
    row.ownerKey = ownerKeyValue;
    row.capsuleId = capsuleId;
    return true;
  }
  public writeTo(sessionId: string): boolean { this.calls.push(`writeTo:${sessionId}`); return true; }
  public closeSession(sessionId: string): boolean { this.calls.push(`closeSession:${sessionId}`); return true; }
  public sleepSession(sessionId: string): boolean { this.calls.push(`sleepSession:${sessionId}`); return true; }
  public wakeSession(sessionId: string): boolean { this.calls.push(`wakeSession:${sessionId}`); return true; }
  public renameSession(sessionId: string, name: string): boolean { this.calls.push(`renameSession:${sessionId}:${name}`); return true; }
  public createSplitSession(parentId: string): string { this.calls.push(`createSplitSession:${parentId}`); return 'terminal-split'; }
  public getDiagnostics(): Record<string, unknown> {
    return { sessions: this.rows.map((row) => ({ sessionId: row.id, ownerKey: row.ownerKey, capsuleId: row.capsuleId })), subscribers: [], activeSessionId: this.activeSessionId };
  }
  public callsFor(member: string): string[] { return this.calls.filter((entry) => entry.startsWith(`${member}:`)); }
}

/**
 * The host members these rows drive. The instance is built on the real prototype, so every method
 * below is production's; only the fields it reads are seeded, which is how the other host harnesses
 * in this lane build a window without Electron.
 */
interface HostUnderTest {
  shell: ShellDouble & { owner?: WindowOwner };
  capsuleManager: unknown;
  closeAdmission: PageCloseReservations;
  terminalWindowMeta: Map<number, { sessionId?: string; isPopout?: boolean }>;
  admitsSessionForWindow(sessionId: string, senderId?: number): boolean;
  visibleTerminalSessions(): Array<{ id: string }>;
  assertManagerMayOperate(sessionId: string, senderId?: number): true | { ok: false; reason: string; message: string };
  shellOwnerKeyForSender(senderId: number | undefined): string | undefined;
  setOwnerWindowPresence(presence: ((ownerKeyValue: string) => boolean) | null): void;
  setProjectAssignmentResolver(resolver: ((projectId: string) => TerminalProjectAssignment | undefined) | null): void;
  setTerminalLinkOpener(opener: ((ownerKey: string, url: string) => Promise<boolean> | boolean) | null): void;
}

function buildHost(options: { owner: WindowOwner; capsuleManager?: unknown; affiliation?: { capsuleId: string; workspacePath: string } }): HostUnderTest & Record<string, unknown> {
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
  host.previewWatcherPool = { retain: () => () => {} };
  host.tabPreviewUnsubscribers = new Map<string, () => void>();
  host.closeAdmission = new PageCloseReservationsRuntime();
  host.capsuleManager = options.capsuleManager ?? capsuleRegistry({});
  host.popoutWindow = null;

  const shell = createShellDouble({ isSidebarOpen: false, sidebarWidth: 380 });
  // The shell double carries the presentation members the host reads; the owner is the one identity
  // field a harness must supply, and a window with no owner is the shared manager.
  Object.assign(shell, { owner: options.owner });
  host.shell = shell as ShellDouble & { owner?: WindowOwner };
  // A window whose workspace the host can verify carries that workspace's capsule tag; one whose
  // affiliation is unknown carries none, which is what the legacy (key-less) rows are read against.
  host.windowWorkspaceAffiliation = options.affiliation
    ? { capsuleId: options.affiliation.capsuleId, workspacePath: options.affiliation.workspacePath }
    : null;
  return host;
}

/** The host as the modules under test type it: a prototype-built instance, widened for the harness. */
function asHost(host: Record<string, unknown>): NativeTabHost {
  // Reason: the harness only ever reads the members this table names, and the instance is the real
  // prototype, which carries every one of them.
  return host as unknown as NativeTabHost;
}

/** The webContents the harness reports as its sender, read back as the id the host resolves. */
function senderWebContentsId(harness: ChromeRouteHarness): number {
  const sender = harness.sender;
  if (sender && typeof sender === 'object' && 'id' in sender && typeof sender.id === 'number') return sender.id;
  throw new Error('the chrome route harness must report a webContents sender');
}

interface WindowFixture {
  host: HostUnderTest & Record<string, unknown>;
  recording: RecordingTerminalManager;
  harness: ChromeRouteHarness;
  senderId: number;
}

/**
 * One window's host, its manager and the harness that speaks for its own chrome.
 *
 * The recording manager is installed as the process-wide one for the whole row, because that is
 * what the window under test is: the host resolves every row's ownership through the singleton, so
 * a fixture that left the real manager installed would be describing a window whose manager cannot
 * name a single one of these rows. The sender is minted first and then seated as this shell's
 * sidebar view — which is how production learns the sender is that window's own chrome renderer.
 *
 * The rows are copied per fixture: a handover re-stamps the row it moved, and a test that moved one
 * must not leave a later test looking at a row some other window now owns.
 */
function windowFixture(options: { owner: WindowOwner; rows: RecordedRow[]; capsuleManager?: unknown; affiliation?: { capsuleId: string; workspacePath: string } }): WindowFixture {
  const host = buildHost(options);
  const recording = new RecordingTerminalManager(options.rows.map((row) => ({ ...row })));
  TerminalManager.setInstance(recording);
  const harness = createChromeRouteHarness({ host: asHost(host) });
  const senderId = senderWebContentsId(harness);
  host.shell.sidebarView = {
    webContents: { id: senderId, isDestroyed: () => false, send: () => {} },
    setBounds: () => {},
    setBackgroundColor: () => {},
  };
  return { host, recording, harness, senderId };
}

function capsuleRegistry(rows: Record<string, { id: string; name: string; workspacePath: string; projectId?: string; workspaceId?: string }>, affiliationsByRoot: Record<string, { projectId: string; workspaceId: string }> = {}): Record<string, unknown> {
  return {
    list: () => Object.values(rows),
    getActive: () => Object.values(rows)[0] ?? null,
    // Production's own registry throws for a capsule it does not hold; the route has to turn that
    // into its typed refusal, so the double keeps that shape.
    get: (id: string) => {
      const row = rows[id];
      if (!row) throw new Error(`Capsule not found: ${id}`);
      return row;
    },
    // A capsule carrying no project id is a legacy record, and only its directory can name one.
    uniqueAffiliationByRoot: (root: string) => (root in affiliationsByRoot ? affiliationsByRoot[root] : undefined),
    switchTo: () => {},
    create: () => { throw new Error('create is not part of this contract'); },
  };
}

describe("Terminal project handover — the shared manager's scope", () => {
  const ROWS = [OWN_ROW, OTHER_ROW, AGENT_ROW, UNCLAIMED_ROW, LEGACY_ROW, LEGACY_UNTAGGED_ROW];

  it('shows the manager every row there is, `agent:` rows included', () => {
    const { host } = windowFixture({ owner: MANAGER, rows: ROWS });

    for (const row of ROWS) {
      assert.equal(host.admitsSessionForWindow(row.id), true, `the shared manager must see ${row.id}`);
    }
    assert.deepEqual(
      host.visibleTerminalSessions().map((session) => session.id).sort(),
      ROWS.map((row) => row.id).sort(),
      'the list the manager bootstraps from is the process-wide one'
    );
  });

  it("keeps a project window to its own owner: another project's, an agent's and the unclaimed rows stay out", () => {
    const { host } = windowFixture({ owner: PROJECT_A, rows: ROWS });

    assert.equal(host.admitsSessionForWindow(OWN_ROW.id), true, 'its own mint is its own');
    assert.equal(host.admitsSessionForWindow(OTHER_ROW.id), false, "another project's terminal is not this window's");
    assert.equal(host.admitsSessionForWindow(AGENT_ROW.id), false, 'an agent row belongs to no window');
    assert.equal(host.admitsSessionForWindow(UNCLAIMED_ROW.id), false, 'and neither does what no window claimed');
    // A window whose workspace the host cannot verify carries no tags, so it shows exactly what no
    // window claimed: a record that predates tags reads as unclaimed, one tagged with a capsule
    // reads as that capsule's, and an unverified window is not it.
    assert.equal(host.admitsSessionForWindow(LEGACY_UNTAGGED_ROW.id), true, 'a legacy record with no tag is unclaimed, and this window claims nothing');
    assert.equal(host.admitsSessionForWindow(LEGACY_ROW.id), false, "a row on a capsule this window cannot verify is not this window's");
    assert.deepEqual(
      host.visibleTerminalSessions().map((session) => session.id).sort(),
      [OWN_ROW.id, LEGACY_UNTAGGED_ROW.id].sort(),
      'the project window presents its own rows and nothing of its sibling'
    );
  });

  it("reads a key-less row through the window's capsule, which is the rule it was created under", () => {
    const { host } = windowFixture({
      owner: PROJECT_A,
      rows: [LEGACY_ROW, LEGACY_OTHER_ROW, LEGACY_UNTAGGED_ROW],
      affiliation: { capsuleId: 'capsule-a', workspacePath: UNVERIFIED_ROOT },
    });

    assert.equal(host.admitsSessionForWindow(LEGACY_ROW.id), true, "a key-less row on this window's capsule is still this window's");
    assert.equal(host.admitsSessionForWindow(LEGACY_OTHER_ROW.id), false, "the sibling capsule's legacy row is not");
    assert.equal(
      host.admitsSessionForWindow(LEGACY_UNTAGGED_ROW.id),
      false,
      'and a window that can name its own workspace no longer shows what nothing claimed'
    );
  });

  it("does not widen a foreign caller: the manager's width is its own chrome", () => {
    const { host, senderId } = windowFixture({ owner: MANAGER, rows: ROWS });

    assert.equal(host.shellOwnerKeyForSender(senderId), MANAGER_OWNER_KEY, "the manager's own chrome answers for the manager");
    assert.equal(host.shellOwnerKeyForSender(undefined), undefined, 'a caller naming no window names no owner');
    assert.equal(host.shellOwnerKeyForSender(senderId + 5000), undefined, 'and neither does a webContents this shell does not present');

    assert.equal(host.admitsSessionForWindow(AGENT_ROW.id, senderId), true, 'its own chrome is the manager');
    assert.equal(host.admitsSessionForWindow(AGENT_ROW.id, senderId + 5000), false, 'an unplaceable sender is not');
  });
});

// ---------------------------------------------------------------------------
// Layer 3: what the manager may do with an agent row
// ---------------------------------------------------------------------------

describe('Terminal project handover — what the manager may do with an agent row', () => {
  const ROWS = [OWN_ROW, OTHER_ROW, AGENT_ROW];

  it('answers a typed read-only refusal for an `agent:` row, and nothing else', () => {
    const { host } = windowFixture({ owner: MANAGER, rows: ROWS });

    const refusal = host.assertManagerMayOperate(AGENT_ROW.id);
    if (refusal === true) throw new Error('an agent row must be refused for the shared manager, not allowed');
    assert.equal(refusal.ok, false);
    assert.equal(refusal.reason, 'MANAGER_AGENT_SESSION_READ_ONLY', 'the refusal names its reason rather than throwing');
    assert.match(refusal.message, /read-only/);

    assert.equal(host.assertManagerMayOperate(OWN_ROW.id), true, "every other row is the manager's to operate");
    assert.equal(host.assertManagerMayOperate(OTHER_ROW.id), true, "including another project's row: that is what control means");
  });

  it("leaves the gate with the manager: a project window operates its own rows without asking", () => {
    const { host } = windowFixture({ owner: PROJECT_A, rows: ROWS });
    assert.equal(host.assertManagerMayOperate(OWN_ROW.id), true);
    assert.equal(host.assertManagerMayOperate(AGENT_ROW.id), true, "the gate is the manager's privilege, not a second ownership rule");
  });

  it('reads an agent row through the real routes, and refuses to write to it', async () => {
    const { harness, recording } = windowFixture({ owner: MANAGER, rows: ROWS });

    // The buffer is the read the manager keeps: the agent's own transcript, not a refusal.
    const buffer = await harness.invoke(TERMINAL_CHANNELS.GET_FULL_BUFFER, AGENT_ROW.id);
    assert.deepEqual(buffer, { sessionId: AGENT_ROW.id, buffer: `buffer-of-${AGENT_ROW.id}`, snapshotThroughSeq: 1 });
    assert.deepEqual(recording.callsFor('getFullBuffer'), [`getFullBuffer:${AGENT_ROW.id}`]);

    // Every mutation it has is refused, and never reaches the shared manager.
    assert.equal(await harness.invoke('antifan:terminal:close-session', AGENT_ROW.id), false, 'a close resolves the refusal');
    assert.equal(await harness.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, { id: AGENT_ROW.id }), false, 'and so does a sleep');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      // Fire-and-forget: this channel has no reply, so the refusal is a drop plus the line it logged.
      harness.invoke('antifan:terminal:input-session', { id: AGENT_ROW.id, input: 'echo hi\r' });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(recording.callsFor('closeSession'), [], 'a refused close never reaches the shared manager');
    assert.deepEqual(recording.callsFor('sleepSession'), []);
    assert.deepEqual(recording.callsFor('writeTo'), [], "and neither does a refused write into an agent's running shell");
    assert.ok(
      warnings.some((entry) => entry.includes('MANAGER_AGENT_SESSION_READ_ONLY')),
      `the dropped write reports its reason, got: ${warnings.join(' | ')}`
    );

    // The same close on another project's row does go through: the gate withholds agent shells,
    // not the manager's control over the rows it was given.
    assert.equal(await harness.invoke('antifan:terminal:close-session', OTHER_ROW.id), true);
    assert.deepEqual(recording.callsFor('closeSession'), [`closeSession:${OTHER_ROW.id}`]);
  });

  it('refuses a bridge-style caller that names no window before any route runs', async () => {
    const host = buildHost({ owner: MANAGER });
    const recording = new RecordingTerminalManager(ROWS);
    TerminalManager.setInstance(recording);
    // No sender resolves to this host at all: the shape of a caller with no window — an MCP or
    // bridge call. The manager's width must not be reachable from there.
    const harness = createChromeRouteHarness({ host: asHost(host), refuseSender: true });

    const invocations: Array<[string, unknown[]]> = [
      ['antifan:terminal:close-session', [AGENT_ROW.id]],
      [TERMINAL_CHANNELS.GET_FULL_BUFFER, [AGENT_ROW.id]],
      [TERMINAL_CHANNELS.ASSIGN_PROJECT, [{ sessionId: OWN_ROW.id, projectId: PHUKIEN_PROJECT }]],
    ];
    for (const [channel, args] of invocations) {
      await assert.rejects(
        // Async so the router's synchronous throw is observed as a rejection; a sync throw inside a
        // plain lambda escapes `assert.rejects` instead of failing it.
        async () => harness.invoke(channel, ...args),
        (error: unknown) => (error as { code?: string })?.code === 'UNKNOWN_CHROME_SENDER',
        `${channel} must refuse a caller that names no window`
      );
    }
    assert.deepEqual(recording.calls, [], 'a refused caller never reached the shared manager');
  });
});

// ---------------------------------------------------------------------------
// Terminal link ownership — a URL click names its session's owner, never the window that happens
// to be focused.
// ---------------------------------------------------------------------------

type OpenLinkSuccess = Extract<TerminalProjectLinkResult, { ok: true }>;
type OpenLinkFailure = Extract<TerminalProjectLinkResult, { ok: false }>;

function readLinkOutcome(value: unknown): OpenLinkSuccess | OpenLinkFailure {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error(`open-link must answer an outcome, got ${JSON.stringify(value)}`);
  if (value.ok === true) {
    const { sessionId, ownerKey: openedOwner } = value as { sessionId?: unknown; ownerKey?: unknown };
    if (typeof sessionId !== 'string' || typeof openedOwner !== 'string') throw new Error(`open-link must name the session and owner, got ${JSON.stringify(value)}`);
    return value as OpenLinkSuccess;
  }
  if (value.ok !== false) throw new Error(`open-link must answer ok true or false, got ${JSON.stringify(value)}`);
  const { reason, message } = value as { reason?: unknown; message?: unknown };
  if (typeof reason !== 'string' || typeof message !== 'string') throw new Error(`open-link must name its refusal, got ${JSON.stringify(value)}`);
  return value as OpenLinkFailure;
}

const openLink = (harness: ChromeRouteHarness, sessionId: string, url: string): Promise<OpenLinkSuccess | OpenLinkFailure> =>
  Promise.resolve(harness.invoke(TERMINAL_CHANNELS.OPEN_LINK, { sessionId, url })).then(readLinkOutcome);

function linkFixture(options: { owner?: WindowOwner; rows?: RecordedRow[]; opener?: ((ownerKey: string, url: string) => Promise<boolean> | boolean) | null } = {}): WindowFixture & { opened: Array<{ ownerKey: string; url: string }> } {
  const fixture = windowFixture({ owner: options.owner ?? MANAGER, rows: options.rows ?? [OWN_ROW, OTHER_ROW, AGENT_ROW] });
  const opened: Array<{ ownerKey: string; url: string }> = [];
  fixture.host.setTerminalLinkOpener(options.opener === undefined
    ? async (ownerKey, url) => { opened.push({ ownerKey, url }); return true; }
    : options.opener);
  return { ...fixture, opened };
}

describe('Terminal project handover — project-owned link opens', () => {
  it('asks Main to open a URL in the session owner, for the pane the user actually clicked', async () => {
    const { harness, opened } = linkFixture();

    const result = await Promise.resolve(openLink(harness, OTHER_ROW.id, 'https://example.com/project-b'));

    assert.deepEqual(result, { ok: true, sessionId: OTHER_ROW.id, ownerKey: ownerKey(PROJECT_B) });
    assert.deepEqual(opened, [{ ownerKey: ownerKey(PROJECT_B), url: 'https://example.com/project-b' }], 'a foreign project row never borrows the calling window');
  });

  it('refuses an unknown session, unaffiliated URL, missing opener and a refused target without external fallback', async () => {
    const unknown = linkFixture();
    const unknownResult = await Promise.resolve(openLink(unknown.harness, 'terminal-gone', 'https://example.com/valid'));
    assert.equal(unknownResult.ok === false && unknownResult.reason, 'UNKNOWN_SESSION');
    assert.deepEqual(unknown.opened, []);

    const invalid = linkFixture();
    const invalidResult = await Promise.resolve(openLink(invalid.harness, OWN_ROW.id, 'javascript:alert(1)'));
    assert.equal(invalidResult.ok === false && invalidResult.reason, 'INVALID_PAYLOAD');
    assert.deepEqual(invalid.opened, []);

    // The manager reads the agent row but may not operate it: its read-only gate answers first,
    // before the owner check ever runs.
    const agent = linkFixture();
    const agentResult = await Promise.resolve(openLink(agent.harness, AGENT_ROW.id, 'https://example.com/agent'));
    assert.equal(agentResult.ok === false && agentResult.reason, 'MANAGER_AGENT_SESSION_READ_ONLY');
    assert.deepEqual(agent.opened, []);

    const boundToAgent = linkFixture({ owner: PROJECT_A });
    boundToAgent.host.terminalWindowMeta.set(9, { sessionId: AGENT_ROW.id });
    const boundAgent = await Promise.resolve(openLink(boundToAgent.harness, AGENT_ROW.id, 'https://example.com/agent'));
    assert.equal(boundAgent.ok === false && boundAgent.reason, 'TERMINAL_OWNER_UNAVAILABLE');
    assert.deepEqual(boundToAgent.opened, [], 'an agent-owned link has no project window to claim it');

    for (const opener of [null, async () => false, async () => { throw new Error('window failed'); }]) {
      const fixture = linkFixture({ opener });
      const result = await Promise.resolve(openLink(fixture.harness, OWN_ROW.id, 'https://example.com/phukien'));
      assert.equal(result.ok === false && result.reason, 'TARGET_WINDOW_ABSENT');
      assert.deepEqual(fixture.opened, []);
    }
  });

  it("keeps a project window's click within a row it can see", async () => {
    const { recording, harness, opened } = linkFixture({ owner: PROJECT_A });

    const result = await Promise.resolve(openLink(harness, OTHER_ROW.id, 'https://example.com/project-b'));

    assert.equal(result.ok === false && result.reason, 'SESSION_NOT_VISIBLE');
    assert.deepEqual(opened, []);
    assert.deepEqual(recording.calls, []);
  });
});

// ---------------------------------------------------------------------------
// Layer 4: the route the tab context menu's handover goes through
// ---------------------------------------------------------------------------

const PHUKIEN_CAPSULE_ROW: WorkspaceCapsule = {
  id: PHUKIEN_CAPSULE,
  name: 'Phukienmymoc',
  workspacePath: 'E:/Work/phukienmymoc',
  projectId: PHUKIEN_PROJECT,
  workspaceId: 'workspace-00000000-0000-4000-8000-0000000000a1',
  state: { browserTabs: [], terminalTabs: [], sidebarOpen: false, sidebarWidth: 380, appZoomFactor: 1, devicePresetId: 'responsive' },
  createdAt: 1,
  updatedAt: 1,
};
const FOLDER_ONLY_CAPSULE_ROW: WorkspaceCapsule = {
  ...PHUKIEN_CAPSULE_ROW, id: 'capsule-folder', name: 'Folder only', workspacePath: 'E:/Work/loose-folder', projectId: undefined, workspaceId: undefined,
};
const LEGACY_CAPSULE_ROW: WorkspaceCapsule = {
  ...PHUKIEN_CAPSULE_ROW, id: 'capsule-legacy', name: 'Comnieu (pre-affiliation record)', workspacePath: 'E:/Work/comnieu', projectId: undefined, workspaceId: undefined,
};
const LEGACY_PROJECT = 'project-00000000-0000-4000-8000-0000000000a2';
const LEGACY_WINDOW_KEY = ownerKey({ kind: 'project', projectId: LEGACY_PROJECT });
const CANONICAL_COMNIEU_ROW: WorkspaceCapsule = {
  ...LEGACY_CAPSULE_ROW, id: 'capsule-comnieu', projectId: LEGACY_PROJECT, workspaceId: 'workspace-00000000-0000-4000-8000-0000000000a2',
};
const CAPSULE_ROWS: Record<string, WorkspaceCapsule> = {
  [PHUKIEN_CAPSULE]: PHUKIEN_CAPSULE_ROW,
  'capsule-folder': FOLDER_ONLY_CAPSULE_ROW,
  'capsule-legacy': LEGACY_CAPSULE_ROW,
  [CANONICAL_COMNIEU_ROW.id]: CANONICAL_COMNIEU_ROW,
};
const AFFILIATIONS_BY_ROOT = { 'E:/Work/comnieu': { projectId: LEGACY_PROJECT, workspaceId: 'workspace-00000000-0000-4000-8000-0000000000a2' } };

type AssignSuccess = Extract<TerminalProjectAssignResult, { ok: true }>;
type AssignFailure = Extract<TerminalProjectAssignResult, { ok: false }>;

/**
 * Read a route reply as the union it declares. Every field the rows assert is checked here, so a
 * reply that grows into a different shape fails loudly instead of passing a `deepEqual` against a
 * re-built object.
 */
function readAssignOutcome(value: unknown, channel: string): AssignSuccess | AssignFailure {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error(`${channel} must answer an outcome, got ${JSON.stringify(value)}`);
  if (value.ok === true) {
    const { sessionId, projectId, capsuleId, ownerKey: movedTo } = value as { sessionId?: unknown; projectId?: unknown; capsuleId?: unknown; ownerKey?: unknown };
    if (typeof sessionId !== 'string' || typeof projectId !== 'string' || (capsuleId !== undefined && typeof capsuleId !== 'string') || typeof movedTo !== 'string') {
      throw new Error(`${channel} must name the session, project, optional capsule and owner it moved to, got ${JSON.stringify(value)}`);
    }
    return value as AssignSuccess;
  }
  if (value.ok !== false) throw new Error(`${channel} must answer ok true or false, got ${JSON.stringify(value)}`);
  const { reason, message } = value as { reason?: unknown; message?: unknown };
  if (typeof reason !== 'string' || typeof message !== 'string') {
    throw new Error(`${channel} must name the reason it refused, got ${JSON.stringify(value)}`);
  }
  return value as AssignFailure;
}

/**
 * The resolver Main installs on a real host, re-spelled for the harness: a project id resolves to
 * the single validated capsule claiming it, a project with no claim resolves to a bare assignment
 * when the registry knows it (the workspace-less default-window case), and anything ambiguous or
 * unknown resolves to nothing — the route must refuse all three the same way Main refuses them.
 */
function assignmentResolverFor(capsules: Record<string, WorkspaceCapsule>, knownProjects: readonly string[]): (projectId: string) => TerminalProjectAssignment | undefined {
  const KNOWN: Record<string, true> = Object.fromEntries(knownProjects.map((id) => [id, true]));
  const VALID_ID = /^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return (projectId) => {
    const claims = Object.values(capsules).filter((capsule) => capsule.projectId === projectId);
    if (claims.length > 1) return undefined;
    if (claims.length === 1) {
      const only = claims[0]!;
      return VALID_ID.test(only.projectId || '') && VALID_ID.test(only.workspaceId || '') && only.id
        ? { capsuleId: only.id }
        : undefined;
    }
    return KNOWN[projectId] ? {} : undefined;
  };
}

const assign = (harness: ChromeRouteHarness, sessionId: string, projectId: string): AssignSuccess | AssignFailure =>
  readAssignOutcome(harness.invoke(TERMINAL_CHANNELS.ASSIGN_PROJECT, { sessionId, projectId }), TERMINAL_CHANNELS.ASSIGN_PROJECT);

function assignRouteFixture(options: { owner?: WindowOwner; rows?: RecordedRow[]; windows?: (ownerKeyValue: string) => boolean; capsules?: Record<string, WorkspaceCapsule> } = {}): WindowFixture {
  const capsules = options.capsules ?? CAPSULE_ROWS;
  const fixture = windowFixture({
    owner: options.owner ?? MANAGER,
    rows: options.rows ?? [OWN_ROW, AGENT_ROW],
    capsuleManager: capsuleRegistry(capsules, AFFILIATIONS_BY_ROOT),
  });
  fixture.host.setOwnerWindowPresence(options.windows ?? ((ownerKeyValue: string) => ownerKeyValue === PHUKIEN_OWNER_KEY));
  fixture.host.setProjectAssignmentResolver(assignmentResolverFor(capsules, [WORKSPACELESS_PROJECT]));
  return fixture;
}

describe('Terminal project handover — the assign route', () => {
  it("hands the row to the project's unique validated canonical capsule and reports its owner", () => {
    const { recording, harness } = assignRouteFixture();

    const result = assign(harness, OWN_ROW.id, PHUKIEN_PROJECT);

    assert.deepEqual(
      result,
      { ok: true, sessionId: OWN_ROW.id, projectId: PHUKIEN_PROJECT, capsuleId: PHUKIEN_CAPSULE, ownerKey: PHUKIEN_OWNER_KEY },
      'the renderer is told where the session went'
    );
    assert.deepEqual(
      recording.calls,
      [`transferSessionOwner:${OWN_ROW.id}:${PHUKIEN_OWNER_KEY}:${PHUKIEN_CAPSULE}`],
      "the manager re-stamps the row onto the target capsule's window, in one call"
    );
  });

  it('accepts a known workspace-less project and clears the previous capsule', () => {
    resetManagerState();
    const sessionId = tm.createSession(SCRATCH_DIR, PHUKIEN_CAPSULE, MANAGER_OWNER_KEY);
    const { harness } = assignRouteFixture({ windows: () => true });
    TerminalManager.setInstance(tm);

    const result = assign(harness, sessionId, WORKSPACELESS_PROJECT);

    assert.deepEqual(result, { ok: true, sessionId, projectId: WORKSPACELESS_PROJECT, ownerKey: WORKSPACELESS_OWNER_KEY });
    assert.equal(tm.sessionOwnerKey(sessionId), WORKSPACELESS_OWNER_KEY);
    assert.equal(tm.sessionCapsuleId(sessionId), undefined);
  });

  it('uses the project canonical capsule instead of a stale renderer legacy capsule', () => {
    resetManagerState();
    const sessionId = tm.createSession(SCRATCH_DIR, PHUKIEN_CAPSULE, MANAGER_OWNER_KEY);
    const { harness } = assignRouteFixture({ windows: () => true });
    TerminalManager.setInstance(tm);

    const result = readAssignOutcome(harness.invoke(TERMINAL_CHANNELS.ASSIGN_PROJECT, {
      sessionId, projectId: LEGACY_PROJECT, capsuleId: LEGACY_CAPSULE_ROW.id,
    }), TERMINAL_CHANNELS.ASSIGN_PROJECT);

    assert.deepEqual(result, { ok: true, sessionId, projectId: LEGACY_PROJECT, capsuleId: CANONICAL_COMNIEU_ROW.id, ownerKey: LEGACY_WINDOW_KEY });
    assert.equal(tm.sessionOwnerKey(sessionId), LEGACY_WINDOW_KEY);
    assert.equal(tm.sessionCapsuleId(sessionId), CANONICAL_COMNIEU_ROW.id);
  });

  it('refuses duplicate claims that appeared after the project was selected', () => {
    const capsules = { ...CAPSULE_ROWS };
    const { recording, harness } = assignRouteFixture({ capsules });
    capsules['capsule-phukien-duplicate'] = { ...PHUKIEN_CAPSULE_ROW, id: 'capsule-phukien-duplicate' };

    const result = assign(harness, OWN_ROW.id, PHUKIEN_PROJECT);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'PROJECT_UNAVAILABLE');
    assert.deepEqual(recording.calls, [], 'neither duplicate may receive the terminal');
    assert.deepEqual(recording.getSession(OWN_ROW.id), OWN_ROW);
  });

  it('refuses an explicit capsule whose affiliation no longer validates', () => {
    const { recording, harness } = assignRouteFixture({
      capsules: { ...CAPSULE_ROWS, [PHUKIEN_CAPSULE]: { ...PHUKIEN_CAPSULE_ROW, workspaceId: 'workspace-invalid' } },
    });

    const result = assign(harness, OWN_ROW.id, PHUKIEN_PROJECT);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'PROJECT_UNAVAILABLE');
    assert.deepEqual(recording.calls, []);
    assert.deepEqual(recording.getSession(OWN_ROW.id), OWN_ROW);
  });

  it('fails closed when canonical authority is missing, unresolved or throws', () => {
    const resolvers: Array<((projectId: string) => TerminalProjectAssignment | undefined) | null> = [
      null,
      () => undefined,
      () => { throw new Error('capsule authority unavailable'); },
    ];
    for (const resolver of resolvers) {
      const { host, recording, harness } = assignRouteFixture();
      host.setProjectAssignmentResolver(resolver);

      const result = assign(harness, OWN_ROW.id, PHUKIEN_PROJECT);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, 'PROJECT_UNAVAILABLE');
      assert.deepEqual(recording.calls, [], 'an open target window alone cannot authorize a transfer');
      assert.deepEqual(recording.getSession(OWN_ROW.id), OWN_ROW);
    }
  });

  it('refuses an unknown project, an absent window and an unknown session', () => {
    const unknownProject = assignRouteFixture();
    const unknownProjectResult = assign(unknownProject.harness, OWN_ROW.id, 'project-00000000-0000-4000-8000-0000000000ff');
    assert.equal(unknownProjectResult.ok, false);
    assert.equal(unknownProjectResult.ok === false && unknownProjectResult.reason, 'PROJECT_UNAVAILABLE');
    assert.deepEqual(unknownProject.recording.calls, [], 'a refusal before the move never reaches the manager');

    // The project's window was closed between the renderer's open request and this call.
    const absentWindow = assignRouteFixture({ windows: () => false });
    const absentWindowResult = assign(absentWindow.harness, OWN_ROW.id, PHUKIEN_PROJECT);
    assert.equal(absentWindowResult.ok, false);
    assert.equal(absentWindowResult.ok === false && absentWindowResult.reason, 'TARGET_WINDOW_ABSENT');
    assert.deepEqual(absentWindow.recording.calls, []);

    // A row that is not there any more is an answer too, never a throw.
    const unknownSession = assignRouteFixture();
    const unknownSessionResult = assign(unknownSession.harness, 'terminal-gone', PHUKIEN_PROJECT);
    assert.equal(unknownSessionResult.ok, false);
    assert.equal(unknownSessionResult.ok === false && unknownSessionResult.reason, 'UNKNOWN_SESSION');
    assert.equal(unknownSession.recording.getSession('terminal-gone'), undefined);
  });

  it('refuses a malformed payload, and lets a committed quit throw the admission error it already has', () => {
    const { host, recording, harness } = assignRouteFixture();

    // Both ids come from a renderer, so a call that names only one is answered, not attempted.
    const malformed = readAssignOutcome(harness.invoke(TERMINAL_CHANNELS.ASSIGN_PROJECT, { projectId: PHUKIEN_PROJECT }), TERMINAL_CHANNELS.ASSIGN_PROJECT);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.ok === false && malformed.reason, 'INVALID_PAYLOAD');
    assert.deepEqual(recording.calls, []);
    const stalePayload = readAssignOutcome(harness.invoke(TERMINAL_CHANNELS.ASSIGN_PROJECT, { sessionId: OWN_ROW.id, capsuleId: PHUKIEN_CAPSULE }), TERMINAL_CHANNELS.ASSIGN_PROJECT);
    assert.equal(stalePayload.ok, false);
    assert.equal(stalePayload.ok === false && stalePayload.reason, 'INVALID_PAYLOAD', 'capsule-only requests cannot choose a project');
    assert.deepEqual(recording.calls, []);

    // The route answers its own refusals, but the admission it runs under is the window's: a
    // committed quit refuses it the way it refuses every other mutation, with a throw.
    const release = host.closeAdmission.reserveApplicationAdmission();
    try {
      assert.throws(
        () => assign(harness, OWN_ROW.id, PHUKIEN_PROJECT),
        (error: unknown) => (error as { code?: string })?.code === 'RUNTIME_DRAINING',
        'a mint during a quit is refused by the host, not answered by the route'
      );
    } finally {
      release();
    }
    assert.deepEqual(recording.calls, [], 'the row was never handed over');
  });

  it("refuses to move an agent's shell out from under it", () => {
    const { recording, harness } = assignRouteFixture();

    const result = assign(harness, AGENT_ROW.id, PHUKIEN_PROJECT);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'MANAGER_AGENT_SESSION_READ_ONLY');
    assert.deepEqual(recording.calls, [], "the agent's shell is not re-owned by anyone");
  });

  it("is the manager's control only: a project window may not hand over a row it cannot see", () => {
    const { recording, harness } = assignRouteFixture({ owner: PROJECT_A, rows: [OWN_ROW, OTHER_ROW] });

    const foreign = assign(harness, OTHER_ROW.id, PHUKIEN_PROJECT);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false && foreign.reason, 'SESSION_NOT_VISIBLE', "another project's row is not this window's to move");
    assert.deepEqual(recording.calls, []);

    // Its own row is still its own to move, which is what keeps the refusal a scope rule rather
    // than a blanket ban on the route.
    const own = assign(harness, OWN_ROW.id, PHUKIEN_PROJECT);
    assert.deepEqual(own, { ok: true, sessionId: OWN_ROW.id, projectId: PHUKIEN_PROJECT, capsuleId: PHUKIEN_CAPSULE, ownerKey: PHUKIEN_OWNER_KEY });
  });
});
