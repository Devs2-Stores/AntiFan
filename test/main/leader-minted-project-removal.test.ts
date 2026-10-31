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
