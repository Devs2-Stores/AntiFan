/**
 * The host half of `terminal.close { removeMintedProject: true }`. A project the Leader's placement minted is
 * removed only while nobody uses it: a project the user opened, saved tabs for, or customised is left alone,
 * and anything the host cannot read refuses the removal instead of assuming the project is unused.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { WorkspaceCapsuleManager } from '../../src/main/project/workspace-capsule';
import {
  installShellForTesting,
  isKnownProjectId,
  projectRegistry as sharedProjectRegistry,
  removeLeaderMintedCapsule,
  removeLeaderMintedProject,
  setCapsuleManagerForTesting,
  synchronizeCapsulesWithRegistry,
} from '../../src/main/index';
import type { ProjectWindowShell } from '../../src/main/browser/project-window-shell';
import type { WorkspaceRecord } from '../../src/shared/control-plane-contracts';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const PROJECT = 'project-00000000-0000-4000-8000-0000000000b1';
const WORKSPACE = 'workspace-00000000-0000-4000-8000-0000000000b1';
const CAPSULE = 'capsule-minted';

let tmpDir = '';
let scratchRoot = '';
let previousScratchRoots: string | undefined;
let capsuleFolder = '';
let manager: WorkspaceCapsuleManager;
let restoreTerminals: () => void = () => undefined;
let appearance: { color?: string; starred?: boolean } = {};

function savedTabsPath(): string {
  return path.join(process.env.ANTIFAN_USER_DATA ?? '', 'saved-tabs.json');
}

function seedSavedTabs(projectId: string, rows: Array<Record<string, unknown>>): void {
  const owners = { [`project:${projectId}`]: { updatedAt: 1, tabs: rows.map((row) => ({ ...row, projectId })) } };
  fs.writeFileSync(savedTabsPath(), JSON.stringify({ version: 3, owners }), 'utf8');
}

function installNoTerminals(): () => void {
  const fake = { listSessions: () => [], sessionOwnerKey: () => undefined, sessionCapsuleId: () => undefined, closeSession: async () => true };
  const holder = TerminalManager as unknown as { instance?: unknown };
  const previous = holder.instance;
  holder.instance = fake;
  return () => { holder.instance = previous; };
}

function seedCapsule(): void {
  fs.writeFileSync(
    path.join(tmpDir, 'workspace-capsules.json'),
    JSON.stringify({
      version: 1,
      activeCapsuleId: CAPSULE,
      capsules: [{
        id: CAPSULE,
        name: 'Minted',
        workspacePath: capsuleFolder,
        state: {},
        createdAt: 1000,
        updatedAt: 1000,
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        migrationMarker: 'explicit',
      }],
    }),
    'utf8',
  );
  manager = new WorkspaceCapsuleManager({ filePath: path.join(tmpDir, 'workspace-capsules.json'), affiliationAuthority: { projectRegistry: sharedProjectRegistry } });
  setCapsuleManagerForTesting(manager);
  synchronizeCapsulesWithRegistry(manager, sharedProjectRegistry, tmpDir);
}

function fakeShell(visible: boolean): ProjectWindowShell {
  return {
    owner: { kind: 'project', projectId: PROJECT },
    window: { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false },
  } as unknown as ProjectWindowShell;
}

describe('removeLeaderMintedProject', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-minted-removal-'));
    process.env.ANTIFAN_USER_DATA = path.join(tmpDir, 'user-data');
    fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
    scratchRoot = path.join(tmpDir, 'leader-scratch');
    previousScratchRoots = process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
    process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = scratchRoot;
    sharedProjectRegistry.attachAppearanceStore({
      get: () => ({ ...appearance }),
      set: () => ({ ...appearance }),
      remove: () => true,
    });
  });

  after(() => {
    delete process.env.ANTIFAN_USER_DATA;
    if (previousScratchRoots === undefined) delete process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
    else process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = previousScratchRoots;
    setCapsuleManagerForTesting(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    appearance = {};
    capsuleFolder = path.join(scratchRoot, 'job');
    fs.mkdirSync(capsuleFolder, { recursive: true });
    fs.rmSync(savedTabsPath(), { force: true });
    seedCapsule();
    restoreTerminals = installNoTerminals();
  });

  afterEach(() => {
    restoreTerminals();
    try {
      const record = sharedProjectRegistry.getProject(PROJECT);
      sharedProjectRegistry.registerProject({ ...record, state: 'closed' });
    } catch {
      // never registered
    }
  });

  it('removes a minted project nobody has taken up', async () => {
    const result = await removeLeaderMintedProject(CAPSULE);

    assert.deepStrictEqual(result, { status: 'REMOVED', projectId: PROJECT });
    assert.strictEqual(isKnownProjectId(PROJECT), false);
  });

  it('refuses a project that has saved tabs', async () => {
    seedSavedTabs(PROJECT, [{ id: 't1', url: 'https://example.test/t1' }]);

    const result = await removeLeaderMintedProject(CAPSULE);

    assert.deepStrictEqual(result, { status: 'REFUSED', reason: 'PROJECT_HAS_SAVED_TABS', projectId: PROJECT });
    assert.strictEqual(JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8')).owners[`project:${PROJECT}`].tabs.length, 1, 'the saved tabs were not dropped');
    assert.strictEqual(isKnownProjectId(PROJECT), true);
  });

  it('refuses when the saved-tabs file cannot be read', async () => {
    fs.writeFileSync(savedTabsPath(), 'not json', 'utf8');

    const result = await removeLeaderMintedProject(CAPSULE);

    assert.deepStrictEqual(result, { status: 'REFUSED', reason: 'SAVED_TABS_UNREADABLE', projectId: PROJECT });
    assert.strictEqual(fs.readFileSync(savedTabsPath(), 'utf8'), 'not json');
  });

  it('refuses a project whose window is on screen and leaves the window open', async () => {
    const release = installShellForTesting(fakeShell(true));
    try {
      const result = await removeLeaderMintedProject(CAPSULE);

      assert.deepStrictEqual(result, { status: 'REFUSED', reason: 'PROJECT_WINDOW_OPEN', projectId: PROJECT });
      assert.strictEqual(isKnownProjectId(PROJECT), true);
    } finally {
      release();
    }
  });

  it('refuses a project the user gave a colour or a star', async () => {
    appearance = { color: '#ff8800' };
    sharedProjectRegistry.registerProject({ ...sharedProjectRegistry.getProject(PROJECT) });

    const result = await removeLeaderMintedProject(CAPSULE);

    assert.deepStrictEqual(result, { status: 'REFUSED', reason: 'PROJECT_CUSTOMIZED', projectId: PROJECT });
  });

  it('refuses instead of assuming the project is unused when its workspaces cannot be read', async () => {
    const registry = sharedProjectRegistry as unknown as { listWorkspaces: (projectId: string) => WorkspaceRecord[] };
    const original = registry.listWorkspaces;
    registry.listWorkspaces = () => { throw new Error('registry offline'); };
    try {
      const result = await removeLeaderMintedProject(CAPSULE);

      assert.deepStrictEqual(result, { status: 'REFUSED', reason: 'WORKSPACES_UNREADABLE', projectId: PROJECT });
      assert.strictEqual(isKnownProjectId(PROJECT), true);
    } finally {
      registry.listWorkspaces = original;
    }
  });
});

const ORPHAN = 'capsule-orphan';
const ACTIVE = 'capsule-active';

describe('removeLeaderMintedCapsule', () => {
  let orphanFolder = '';

  function seedCapsules(orphan: Record<string, unknown> = {}, active: string = ACTIVE): void {
    const base = { createdAt: 1000, updatedAt: 1000, migrationMarker: 'legacy' };
    fs.writeFileSync(
      path.join(tmpDir, 'workspace-capsules.json'),
      JSON.stringify({
        version: 2,
        activeCapsuleId: active,
        capsules: [
          { ...base, id: ACTIVE, name: 'Active', workspacePath: path.join(tmpDir, 'active-folder'), state: {} },
          { ...base, id: ORPHAN, name: 'Orphan', workspacePath: orphanFolder, state: {}, ...orphan },
        ],
      }),
      'utf8',
    );
    manager = new WorkspaceCapsuleManager({ filePath: path.join(tmpDir, 'workspace-capsules.json'), affiliationAuthority: { projectRegistry: sharedProjectRegistry } });
    setCapsuleManagerForTesting(manager);
  }

  function installTerminals(rows: Array<{ id: string; state: string; capsuleId?: string }>): () => void {
    const fake = {
      listSessions: () => rows,
      sessionOwnerKey: () => 'unassigned',
      sessionCapsuleId: (id: string) => rows.find((row) => row.id === id)?.capsuleId,
      closeSession: async () => true,
    };
    const holder = TerminalManager as unknown as { instance?: unknown };
    const previous = holder.instance;
    holder.instance = fake;
    return () => { holder.instance = previous; };
  }

  function liveHost(facts: { affiliation?: string; tabCapsuleIds?: string[] }): { shell: ProjectWindowShell; host: never } {
    const host = {
      getWindowWorkspaceAffiliation: () => (facts.affiliation ? { capsuleId: facts.affiliation } : null),
      getTabList: () => (facts.tabCapsuleIds ?? []).map((_, index) => ({ id: `tab-${index}` })),
      getTabCapsuleId: (tabId: string) => (facts.tabCapsuleIds ?? [])[Number(tabId.slice(4))],
    };
    return { shell: fakeShell(true), host: host as never };
  }

  const stillThere = (): boolean => manager.list().some((capsule) => capsule.id === ORPHAN);

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-minted-capsule-'));
    process.env.ANTIFAN_USER_DATA = path.join(tmpDir, 'user-data');
    fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
    scratchRoot = path.join(tmpDir, 'leader-scratch');
    previousScratchRoots = process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
    process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = scratchRoot;
  });

  after(() => {
    delete process.env.ANTIFAN_USER_DATA;
    if (previousScratchRoots === undefined) delete process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
    else process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = previousScratchRoots;
    setCapsuleManagerForTesting(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    // Deliberately outside the scratch root: the orphan branch must not depend on it.
    orphanFolder = path.join(tmpDir, 'customizes', 'Orphan');
    fs.mkdirSync(orphanFolder, { recursive: true });
    fs.rmSync(savedTabsPath(), { force: true });
    seedCapsules();
    restoreTerminals = installNoTerminals();
  });

  afterEach(() => {
    restoreTerminals();
  });

  it('removes a capsule no project claims once nothing else uses it, keeping the folder and every other capsule', async () => {
    const result = await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' });

    assert.deepStrictEqual(result, { status: 'REMOVED_CAPSULE', capsuleId: ORPHAN });
    assert.strictEqual(stillThere(), false);
    assert.deepStrictEqual(manager.list().map((capsule) => capsule.id), [ACTIVE]);
    assert.strictEqual(fs.existsSync(orphanFolder), true, 'the folder on disk is never touched');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'workspace-capsules.json'), 'utf8')) as { capsules: Array<{ id: string }> };
    assert.deepStrictEqual(onDisk.capsules.map((capsule) => capsule.id), [ACTIVE], 'the removal is persisted');
  });

  it('leaves a capsule that has a project, or is unknown, to the project path', async () => {
    seedCapsules({ projectId: PROJECT, workspaceId: WORKSPACE, migrationMarker: 'explicit' });
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'NOT_ORPHAN' });
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: 'capsule-nobody', mintedBy: 'caller' }), { status: 'NOT_ORPHAN' });
    assert.strictEqual(stillThere(), true);
  });

  it('refuses a capsule that another Leader minted, or whose minter the record does not name', async () => {
    for (const [mintedBy, reason] of [['other', 'MINTED_BY_ANOTHER_LEADER'], ['unknown', 'MINT_OWNER_UNKNOWN']] as const) {
      assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy }), { status: 'REFUSED', reason, capsuleId: ORPHAN });
    }
    assert.strictEqual(stillThere(), true);
  });

  it('refuses the active capsule', async () => {
    seedCapsules({}, ORPHAN);
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'CAPSULE_IS_ACTIVE', capsuleId: ORPHAN });
    assert.strictEqual(stillThere(), true);
  });

  it('refuses a capsule that still keeps a saved browser tab, a saved terminal tab, a brief or a Chrome profile', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: { browserTabs: [{ id: 'tab-1', url: 'https://example.com/' }] } }, 'CAPSULE_HAS_SAVED_BROWSER_TABS'],
      [{ state: { terminalTabs: [{ id: 'terminal-1', name: 't', cwd: orphanFolder }] } }, 'CAPSULE_HAS_SAVED_TERMINAL_TABS'],
      [{ brief: { storefrontUrl: 'https://shop.example.com/' } }, 'CAPSULE_HAS_BRIEF'],
      [{ state: { chromeProfileId: 'profile-1' } }, 'CAPSULE_HAS_CHROME_PROFILE'],
    ];
    for (const [overrides, reason] of cases) {
      seedCapsules(overrides);
      assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason, capsuleId: ORPHAN }, reason);
      assert.strictEqual(stillThere(), true, reason);
    }
  });

  it('refuses while the saved-tabs file holds a tab of the capsule, or cannot be read', async () => {
    fs.writeFileSync(savedTabsPath(), JSON.stringify({ version: 3, owners: { unassigned: { updatedAt: 1, tabs: [{ id: 't', url: 'https://example.com/', capsuleId: ORPHAN }] } } }), 'utf8');
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'CAPSULE_HAS_SAVED_TABS', capsuleId: ORPHAN });
    fs.writeFileSync(savedTabsPath(), 'not json', 'utf8');
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'SAVED_TABS_UNREADABLE', capsuleId: ORPHAN });
    assert.strictEqual(fs.readFileSync(savedTabsPath(), 'utf8'), 'not json');
    assert.strictEqual(stillThere(), true);
  });

  it('ignores a saved tab that belongs to another capsule', async () => {
    fs.writeFileSync(savedTabsPath(), JSON.stringify({ version: 3, owners: { unassigned: { updatedAt: 1, tabs: [{ id: 't', url: 'https://example.com/', capsuleId: ACTIVE }] } } }), 'utf8');
    assert.strictEqual((await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' })).status, 'REMOVED_CAPSULE');
  });

  it('refuses while an open window carries the capsule, by its affiliation or by a live tab', async () => {
    for (const facts of [{ affiliation: ORPHAN }, { tabCapsuleIds: [ACTIVE, ORPHAN] }]) {
      const { shell, host } = liveHost(facts);
      const release = installShellForTesting(shell, host);
      try {
        assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'CAPSULE_IN_OPEN_WINDOW', capsuleId: ORPHAN });
      } finally {
        release();
      }
    }
    assert.strictEqual(stillThere(), true);
  });

  it('refuses while another terminal, running or sleeping, is attributed to the capsule, and ignores closed ones and other capsules', async () => {
    for (const state of ['running', 'sleeping']) {
      restoreTerminals();
      restoreTerminals = installTerminals([{ id: 'terminal-1', state: 'closed', capsuleId: ORPHAN }, { id: 'terminal-2', state: 'running', capsuleId: ACTIVE }, { id: 'terminal-3', state, capsuleId: ORPHAN }]);
      assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'CAPSULE_HAS_OTHER_TERMINALS', capsuleId: ORPHAN }, state);
    }
    restoreTerminals();
    restoreTerminals = installTerminals([{ id: 'terminal-1', state: 'closed', capsuleId: ORPHAN }, { id: 'terminal-2', state: 'running', capsuleId: ACTIVE }]);
    assert.strictEqual((await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' })).status, 'REMOVED_CAPSULE');
  });

  it('refuses when the terminal list cannot be read', async () => {
    restoreTerminals();
    const holder = TerminalManager as unknown as { instance?: unknown };
    const previous = holder.instance;
    holder.instance = { listSessions: () => { throw new Error('daemon gone'); } };
    restoreTerminals = () => { holder.instance = previous; };
    assert.deepStrictEqual(await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' }), { status: 'REFUSED', reason: 'TERMINALS_UNREADABLE', capsuleId: ORPHAN });
    assert.strictEqual(stillThere(), true);
  });

  it('keeps the capsule, in memory and on disk, when the store cannot be written', async () => {
    const storePath = path.join(tmpDir, 'workspace-capsules.json');
    fs.rmSync(storePath, { force: true });
    fs.mkdirSync(storePath);
    const result = await removeLeaderMintedCapsule({ capsuleId: ORPHAN, mintedBy: 'caller' });
    fs.rmSync(storePath, { recursive: true, force: true });

    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(stillThere(), true);
  });
});
