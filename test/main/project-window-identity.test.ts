/**
 * Project-window identity: the three decisions that keep one project's window, rows
 * and terminals from being confused with another's now that every project owns a
 * window (`project:<id>`) and `'unassigned'` is the shared Terminal Manager.
 *
 *   1. `purgeSavedTabsFileForProject` — the removal path's durable work. It drops one
 *      project's own owner record and nothing else, and it fails closed: an unreadable
 *      file or a failed write must surface, never read as "nothing to remove".
 *   2. The owner key a terminal carries when it is minted from a window
 *      (`resolveTerminalCreationTarget` -> `terminalMintOwnerKey`): the asking window's
 *      key, the popout session's own key when it has one (agent-held rows included),
 *      and `'unassigned'` for the Terminal Manager or a shell with no resolved owner.
 *   3. `isKnownProjectId` — the admission chain: an open registry project, a project
 *      one validated capsule claims, or a project with a live window; never a closed
 *      project, an ambiguous claim or the control plane's default lease.
 *
 * The real NativeTabHost, TerminalManager and `src/main/index` run here. Only the
 * Electron module is faked; every persistence path points at a scratch directory.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before the host or src/main/index load.
installElectronStub();

import { ownerKey, type ProjectWindowShell, type WindowOwner } from '../../src/main/browser/project-window-shell';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { WorkspaceCapsuleManager } from '../../src/main/project/workspace-capsule';
import { CONTROL_PLANE_DEFAULT_PROJECT_ID } from '../../src/shared/control-plane-contracts';
import type { ShellDouble } from '../support/project-window-shell-double';

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-project-window-identity-'));
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;
process.env.ANTIFAN_USER_DATA = path.join(SCRATCH_DIR, 'user-data');
delete process.env.ANTIFAN_USER_DATA_DIR;
fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });

// `import * as fs` compiles to an interop copy whose member descriptors are captured when
// the host module initializes, so the rename fault is installed on the real module BEFORE
// the host is required. It stays inert until a test arms it.
let armedRenameFault: Error | null = null;
const realFs = require('node:fs') as { renameSync: typeof fs.renameSync };
const untouchedRenameSync = realFs.renameSync;
realFs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
  if (armedRenameFault) throw armedRenameFault;
  return untouchedRenameSync(...args);
}) as typeof fs.renameSync;

// A popout terminal window is resolved through BrowserWindow.fromWebContents, which the
// shared stub's bare class does not carry.
const popoutWindowIds = new WeakMap<object, number>();
const electronStub = require('electron') as { BrowserWindow: Record<string, unknown> };
electronStub.BrowserWindow.fromWebContents = (sender: unknown) => {
  const id = sender && typeof sender === 'object' ? popoutWindowIds.get(sender) : undefined;
  return id === undefined ? null : { id };
};

const hostModule = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { NativeTabHost, purgeSavedTabsFileForProject } = hostModule;
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const indexModule = require('../../src/main/index') as typeof import('../../src/main/index');
const {
  isKnownProjectId,
  installShellForTesting,
  setCapsuleManagerForTesting,
  projectRegistry: sharedProjectRegistry,
} = indexModule;

type AnyRecord = Record<string, any>;

after(() => {
  realFs.renameSync = untouchedRenameSync;
  try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// 1. purgeSavedTabsFileForProject
// ---------------------------------------------------------------------------

describe('purgeSavedTabsFileForProject', () => {
  let dir = '';
  let file = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(SCRATCH_DIR, 'purge-'));
    file = path.join(dir, 'saved-tabs.json');
  });

  afterEach(() => {
    armedRenameFault = null;
  });

  function row(id: string, projectId?: string): AnyRecord {
    return { id, url: `https://example.test/${id}`, title: id, ...(projectId ? { projectId } : {}) };
  }

  function seed(document: AnyRecord): string {
    const bytes = JSON.stringify(document);
    fs.writeFileSync(file, bytes, 'utf8');
    return bytes;
  }

  function readDocument(): AnyRecord {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AnyRecord;
  }

  it('drops only the named project\'s own record and reports the rows it carried', async () => {
    seed({
      version: 3,
      bookmarks: [{ url: 'https://example.test/bm', title: 'bm' }],
      mutedSites: ['muted.test'],
      owners: {
        'project:proj-a': { updatedAt: 1, activeTabId: 'a2', tabs: [row('a1', 'proj-a'), row('a2', 'proj-a')] },
        'project:proj-b': { updatedAt: 2, activeTabId: 'b1', tabs: [row('b1', 'proj-b')] },
        unassigned: { updatedAt: 3, tabs: [row('u1')] },
      },
    });

    const removed = await purgeSavedTabsFileForProject(file, 'proj-a');

    assert.equal(removed, 2, 'the count is the rows the dropped record carried');
    const document = readDocument();
    assert.equal(document.owners['project:proj-a'], undefined, 'the whole record — rows and active pointer — leaves the file');
    assert.deepEqual(document.owners['project:proj-b'].tabs.map((tab: AnyRecord) => tab.id), ['b1'], 'another project\'s record is untouched');
    assert.equal(document.owners['project:proj-b'].activeTabId, 'b1');
    assert.deepEqual(document.owners.unassigned.tabs.map((tab: AnyRecord) => tab.id), ['u1'], 'the Terminal Manager\'s record is untouched');
    assert.equal(document.version, 3, 'the document keeps its schema version');
    assert.deepEqual(document.mutedSites, ['muted.test'], 'document-level preferences survive a project removal');
    assert.equal(document.bookmarks.length, 1);
  });

  it('matches the owner key exactly, so a project whose id extends the removed one survives', async () => {
    seed({
      version: 3,
      owners: {
        'project:proj-a': { updatedAt: 1, tabs: [row('a1')] },
        'project:proj-a2': { updatedAt: 1, tabs: [row('a2-1')] },
        'project:xproj-a': { updatedAt: 1, tabs: [row('x1')] },
      },
    });

    assert.equal(await purgeSavedTabsFileForProject(file, '  proj-a  '), 1, 'the id is trimmed before it is matched');

    assert.deepEqual(Object.keys(readDocument().owners).sort(), ['project:proj-a2', 'project:xproj-a']);
  });

  it('never rewrites the file when the project has no record, and treats a blank id as nothing to remove', async () => {
    const bytes = seed({
      version: 3,
      owners: { 'project:proj-b': { updatedAt: 1, tabs: [row('b1')] } },
    });

    assert.equal(await purgeSavedTabsFileForProject(file, 'proj-a'), 0);
    assert.equal(await purgeSavedTabsFileForProject(file, ''), 0);
    assert.equal(await purgeSavedTabsFileForProject(file, '   '), 0);

    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'no matching record means no write and no reformat churn');
    assert.deepEqual(fs.readdirSync(dir), ['saved-tabs.json'], 'and no temp file is left behind');
  });

  it('answers 0 for an absent file and creates nothing', async () => {
    assert.equal(fs.existsSync(file), false, 'precondition: no file');
    assert.equal(await purgeSavedTabsFileForProject(file, 'proj-a'), 0);
    assert.equal(fs.existsSync(file), false, 'a purge must not materialize a document to remove nothing from');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('fails closed on a file that cannot be read back instead of reporting a clean purge', async () => {
    fs.writeFileSync(file, 'this is not json', 'utf8');
    await assert.rejects(
      purgeSavedTabsFileForProject(file, 'proj-a'),
      /unreadable or corrupt/,
      'an unreadable document cannot prove the project\'s tabs are gone',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'this is not json', 'a refused purge rewrites nothing');

    // A parseable document that is not an object is just as unusable.
    fs.writeFileSync(file, '[]', 'utf8');
    await assert.rejects(purgeSavedTabsFileForProject(file, 'proj-a'), /unreadable or corrupt/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[]');
  });

  it('fails closed when the document cannot be written, leaving the source intact and the queue usable', async () => {
    const bytes = seed({
      version: 3,
      owners: {
        'project:proj-a': { updatedAt: 1, tabs: [row('a1')] },
        'project:proj-b': { updatedAt: 1, tabs: [row('b1')] },
      },
    });

    armedRenameFault = new Error('rename refused');
    await assert.rejects(
      purgeSavedTabsFileForProject(file, 'proj-a'),
      /rename refused/,
      'a failed write must fail the removal, not report the rows as purged',
    );
    armedRenameFault = null;

    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the original document is untouched');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name !== 'saved-tabs.json'),
      [],
      'the abandoned temp file is removed rather than mistaken for the document later',
    );

    // The failure must not wedge the per-file chain: the retry lands.
    assert.equal(await purgeSavedTabsFileForProject(file, 'proj-a'), 1);
    assert.deepEqual(Object.keys(readDocument().owners), ['project:proj-b']);
  });

  it('serializes concurrent purges of different projects so neither drops the other\'s result', async () => {
    seed({
      version: 3,
      owners: {
        'project:proj-a': { updatedAt: 1, tabs: [row('a1')] },
        'project:proj-b': { updatedAt: 1, tabs: [row('b1'), row('b2')] },
        'project:proj-c': { updatedAt: 1, tabs: [row('c1')] },
      },
    });

    const [a, b] = await Promise.all([
      purgeSavedTabsFileForProject(file, 'proj-a'),
      purgeSavedTabsFileForProject(file, 'proj-b'),
    ]);

    assert.deepEqual([a, b], [1, 2]);
    assert.deepEqual(Object.keys(readDocument().owners), ['project:proj-c'], 'both removals are in the final file');
  });
});

// ---------------------------------------------------------------------------
// 2. Terminal mint owner key
// ---------------------------------------------------------------------------

describe('terminal mint owner key', () => {
  const tm = TerminalManager.getInstance() as AnyRecord;
  const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'proj-a' };
  const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'proj-b' };
  const UNASSIGNED: WindowOwner = { kind: 'unassigned' };

  function freshWorkspace(name: string): string {
    const dir = path.join(SCRATCH_DIR, `ws-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * A host with its real methods; the constructor is bypassed because it builds a real
   * BrowserWindow. Only the fields the exercised members read are seeded.
   */
  function createHost(owner?: WindowOwner): AnyRecord {
    const host = Object.create(NativeTabHost.prototype) as AnyRecord;
    host.tabs = new Map<string, AnyRecord>();
    host.tabOrder = [];
    host.terminalWindows = new Map<number, unknown>();
    host.terminalWindowMeta = new Map<number, { sessionId?: string; isPopout?: boolean }>();
    host.windowWorkspaceAffiliation = null;
    host.capsuleManager = {
      list: () => [],
      getActive: () => null,
      create: () => ({ id: 'capsule-created', name: 'Created', workspacePath: process.cwd() }),
      switchTo: () => {},
    };
    const shell = createShellDouble({ isSidebarOpen: false, sidebarWidth: 380 });
    shell.sidebarView = null;
    // Reason: the shell double carries the presentation members the host reads; the owner
    // is the one identity field this suite supplies per host (absent = unresolved owner).
    if (owner) (shell as unknown as { owner: WindowOwner }).owner = owner;
    host.shell = shell as unknown as ShellDouble;
    return host;
  }

  function popoutSender(windowId: number): object {
    const sender = {};
    popoutWindowIds.set(sender, windowId);
    return sender;
  }

  function seedSession(id: string, cwd: string, sessionOwnerKey?: string): void {
    const record: AnyRecord = {
      id,
      name: id,
      cwd,
      capsuleId: 'capsule-popout',
      state: 'running',
      sessionGeneration: 1,
      buffer: '',
      bufferBytes: 0,
      lastSeq: 0,
      disposed: false,
      pty: null,
    };
    if (sessionOwnerKey !== undefined) record.ownerKey = sessionOwnerKey;
    tm.sessions.set(id, record);
  }

  afterEach(() => {
    tm.sessions.clear();
  });

  it('stamps a project window\'s own key on every mint source, with or without a verified workspace', () => {
    const workspace = freshWorkspace('mint-project');
    const host = createHost(PROJECT_A);

    const processDefault = host.resolveTerminalCreationTarget();
    assert.equal(processDefault.source, 'process-default');
    assert.equal(processDefault.ownerKey, ownerKey(PROJECT_A), 'a window with no workspace still owns what it mints');

    assert.equal(host.setWindowWorkspaceAffiliation({ workspacePath: workspace, capsuleId: 'capsule-a' }), true);
    const windowWorkspace = host.resolveTerminalCreationTarget();
    assert.equal(windowWorkspace.source, 'window-workspace');
    assert.equal(windowWorkspace.ownerKey, ownerKey(PROJECT_A));

    // A popout bound to a row that carries no owner is attributed to the window presenting it.
    seedSession('session-popout-unowned', workspace);
    host.terminalWindowMeta.set(31, { sessionId: 'session-popout-unowned', isPopout: true });
    const unowned = host.resolveTerminalCreationTarget(popoutSender(31));
    assert.equal(unowned.source, 'popout-session');
    assert.equal(unowned.ownerKey, ownerKey(PROJECT_A));
  });

  it('keeps two project windows on one folder apart by owner key', () => {
    const shared = freshWorkspace('mint-shared-folder');
    const hostA = createHost(PROJECT_A);
    const hostB = createHost(PROJECT_B);
    hostA.setWindowWorkspaceAffiliation({ workspacePath: shared });
    hostB.setWindowWorkspaceAffiliation({ workspacePath: shared });

    const targetA = hostA.resolveTerminalCreationTarget();
    const targetB = hostB.resolveTerminalCreationTarget();

    assert.equal(targetA.cwd, targetB.cwd, 'precondition: both windows resolve the same folder');
    assert.equal(targetA.ownerKey, ownerKey(PROJECT_A));
    assert.equal(targetB.ownerKey, ownerKey(PROJECT_B));
    assert.notEqual(targetA.ownerKey, targetB.ownerKey);
  });

  it('mints under the Terminal Manager\'s sentinel, never a project key, even with a workspace affiliation', () => {
    const workspace = freshWorkspace('mint-manager');
    const host = createHost(UNASSIGNED);

    assert.equal(host.resolveTerminalCreationTarget().ownerKey, ownerKey(UNASSIGNED));
    assert.equal(ownerKey(UNASSIGNED), 'unassigned');

    host.setWindowWorkspaceAffiliation({ workspacePath: workspace });
    const target = host.resolveTerminalCreationTarget();
    assert.equal(target.source, 'window-workspace');
    assert.equal(target.ownerKey, 'unassigned', 'the manager does not invent a project owner from the folder it mints in');
  });

  it('fails closed to the Terminal Manager\'s key for a shell whose owner is unresolved', () => {
    const host = createHost();

    assert.equal(host.windowOwnerKey(), 'unassigned');
    assert.equal(host.resolveTerminalCreationTarget().ownerKey, 'unassigned');
  });

  it('keeps an agent-held popout session\'s own key instead of re-attributing it to the presenting window', () => {
    const workspace = freshWorkspace('mint-agent');
    const agentKey = 'agent:tab-agent-1';

    // Presented from a project window and from the Terminal Manager alike: the session the
    // popout shows decides, so a terminal opened there stays with the agent that holds it.
    for (const owner of [PROJECT_A, UNASSIGNED]) {
      const host = createHost(owner);
      host.setWindowWorkspaceAffiliation({ workspacePath: workspace });
      seedSession('session-agent-held', workspace, agentKey);
      host.terminalWindowMeta.set(41, { sessionId: 'session-agent-held', isPopout: true });

      const target = host.resolveTerminalCreationTarget(popoutSender(41));
      assert.equal(target.source, 'popout-session');
      assert.equal(target.ownerKey, agentKey, `an agent-held row keeps its key when presented from ${ownerKey(owner)}`);

      // A sender that is not one of this host's terminal windows is the window's own mint.
      assert.equal(host.resolveTerminalCreationTarget(popoutSender(99)).ownerKey, ownerKey(owner));
      tm.sessions.clear();
    }
  });

  it('falls back to the window key when the popout\'s session no longer exists', () => {
    const workspace = freshWorkspace('mint-popout-gone');
    const host = createHost(PROJECT_B);
    host.setWindowWorkspaceAffiliation({ workspacePath: workspace });
    host.terminalWindowMeta.set(51, { sessionId: 'session-closed', isPopout: true });

    const target = host.resolveTerminalCreationTarget(popoutSender(51));

    assert.equal(target.source, 'window-workspace');
    assert.equal(target.ownerKey, ownerKey(PROJECT_B));
  });
});

// ---------------------------------------------------------------------------
// 3. isKnownProjectId
// ---------------------------------------------------------------------------

describe('isKnownProjectId', () => {
  const SUFFIX = '0000-4000-8000';
  const idOf = (tail: string) => `project-00000000-${SUFFIX}-${tail}`;
  const OPEN = idOf('0000000000b1');
  const CLOSED = idOf('0000000000b2');
  const CLAIMED = idOf('0000000000b3');
  const AMBIGUOUS = idOf('0000000000b4');
  const UNVALIDATED = idOf('0000000000b5');
  const WINDOWED = idOf('0000000000b6');
  const NEVER_SEEN = idOf('0000000000b7');
  const WORKSPACE_ID = `workspace-00000000-${SUFFIX}-0000000000c1`;
  const WORKSPACE_DEFAULT = `workspace-00000000-${SUFFIX}-0000000000c9`;

  let workspacePath = '';
  const releases: Array<() => void> = [];

  before(() => {
    workspacePath = path.join(SCRATCH_DIR, 'ws-admission');
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    setCapsuleManagerForTesting(null);
    while (releases.length > 0) releases.pop()?.();
  });

  function openProject(projectId: string, workspaceId: string): void {
    sharedProjectRegistry.ensureInitialWorkspace(projectId, workspaceId, workspacePath, SCRATCH_DIR);
    const record = sharedProjectRegistry.getProject(projectId);
    sharedProjectRegistry.registerProject({ ...record, state: 'open' });
  }

  function closeProject(projectId: string): void {
    const record = sharedProjectRegistry.getProject(projectId);
    sharedProjectRegistry.registerProject({ ...record, state: 'closed' });
  }

  /**
   * A capsule store as it is persisted on disk: the claim is written the way the loader
   * trusts it, so a project the registry knows nothing about can still be claimed.
   */
  function installCapsules(name: string, claims: Array<{ id: string; projectId: string; workspaceId?: string; marker?: string }>): void {
    const filePath = path.join(SCRATCH_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      activeCapsuleId: null,
      capsules: claims.map((claim) => ({
        id: claim.id,
        name: claim.id,
        workspacePath,
        state: {},
        createdAt: 1,
        updatedAt: 1,
        projectId: claim.projectId,
        ...(claim.workspaceId ? { workspaceId: claim.workspaceId } : {}),
        ...(claim.marker ? { migrationMarker: claim.marker } : {}),
      })),
    }), 'utf8');
    setCapsuleManagerForTesting(new WorkspaceCapsuleManager({ filePath }));
  }

  function liveShell(owner: WindowOwner, destroyed = false): ProjectWindowShell {
    return { owner, window: { isDestroyed: () => destroyed } } as unknown as ProjectWindowShell;
  }

  it('admits an open registry project', () => {
    openProject(OPEN, WORKSPACE_ID);
    assert.equal(isKnownProjectId(OPEN), true);
  });

  it('refuses a project the registry closed — a stored record is not an open one', () => {
    openProject(CLOSED, `workspace-00000000-${SUFFIX}-0000000000c2`);
    assert.equal(isKnownProjectId(CLOSED), true, 'precondition: open until removed');
    closeProject(CLOSED);

    assert.equal(sharedProjectRegistry.getProject(CLOSED).state, 'closed', 'the record is still stored after close');
    assert.equal(isKnownProjectId(CLOSED), false);
  });

  it('refuses an id no registry, capsule or window holds', () => {
    assert.throws(() => sharedProjectRegistry.getProject(NEVER_SEEN), 'precondition: the registry never held it');
    assert.equal(isKnownProjectId(NEVER_SEEN), false);
  });

  it('admits a registry-absent project exactly one validated capsule claims', () => {
    installCapsules('capsules-one-claim', [
      { id: 'capsule-00000000-0000-4000-8000-0000000000e1', projectId: CLAIMED, workspaceId: WORKSPACE_ID, marker: 'explicit' },
    ]);

    assert.throws(() => sharedProjectRegistry.getProject(CLAIMED), 'precondition: the registry knows nothing of it');
    assert.equal(isKnownProjectId(CLAIMED), true, 'a single validated claim is sufficient evidence');
  });

  it('refuses a project two capsules claim — ambiguity is not evidence', () => {
    installCapsules('capsules-two-claims', [
      { id: 'capsule-00000000-0000-4000-8000-0000000000e2', projectId: AMBIGUOUS, workspaceId: WORKSPACE_ID, marker: 'explicit' },
      { id: 'capsule-00000000-0000-4000-8000-0000000000e3', projectId: AMBIGUOUS, workspaceId: WORKSPACE_ID, marker: 'explicit' },
    ]);

    assert.equal(isKnownProjectId(AMBIGUOUS), false);
  });

  it('refuses a claim whose affiliation is not validated (explicit marker without a workspace id)', () => {
    installCapsules('capsules-unvalidated', [
      { id: 'capsule-00000000-0000-4000-8000-0000000000e4', projectId: UNVALIDATED, marker: 'explicit' },
    ]);

    assert.equal(isKnownProjectId(UNVALIDATED), false, 'an incomplete record cannot authorize an open the registry knows nothing about');
  });

  it('admits a registry-absent project with a live window, and stops once that window is gone', () => {
    assert.equal(isKnownProjectId(WINDOWED), false, 'precondition: unknown to registry and capsules');

    const release = installShellForTesting(liveShell({ kind: 'project', projectId: WINDOWED }));
    releases.push(release);
    assert.equal(isKnownProjectId(WINDOWED), true, 'a window already open for the project is evidence');

    release();
    assert.equal(isKnownProjectId(WINDOWED), false, 'a released window no longer vouches for it');
  });

  it('does not let a destroyed window or another owner\'s window vouch for a project', () => {
    releases.push(installShellForTesting(liveShell({ kind: 'project', projectId: WINDOWED }, true)));
    releases.push(installShellForTesting(liveShell({ kind: 'unassigned' })));
    releases.push(installShellForTesting(liveShell({ kind: 'project', projectId: NEVER_SEEN })));

    assert.equal(isKnownProjectId(WINDOWED), false, 'a destroyed window is not live');
    assert.equal(isKnownProjectId(UNVALIDATED), false, 'the Terminal Manager and unrelated project windows name no other project');
  });

  it('never admits the control plane\'s default lease, even when the registry holds it open', () => {
    try {
      openProject(CONTROL_PLANE_DEFAULT_PROJECT_ID, WORKSPACE_DEFAULT);
    } catch {
      // Already registered by the process: the open-state check below still guards the premise.
    }
    assert.equal(sharedProjectRegistry.getProject(CONTROL_PLANE_DEFAULT_PROJECT_ID).state, 'open', 'precondition: the registry arm alone would admit it');

    assert.equal(isKnownProjectId(CONTROL_PLANE_DEFAULT_PROJECT_ID), false);

    releases.push(installShellForTesting(liveShell({ kind: 'project', projectId: CONTROL_PLANE_DEFAULT_PROJECT_ID })));
    assert.equal(isKnownProjectId(CONTROL_PLANE_DEFAULT_PROJECT_ID), false, 'a window cannot launder it either');
  });
});
