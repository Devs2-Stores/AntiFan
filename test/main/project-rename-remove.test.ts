/**
 * Project rename/remove — the durable halves of the Phase-10 project manager.
 *
 * What is pinned here:
 *   1. `renameProjectEntry` writes the new name through the registry record (the
 *      capsule store is covered by `WorkspaceCapsuleManager.rename` and the sync
 *      re-check below) and refuses ids Main cannot resolve.
 *   2. `removeProjectEntry` closes the registry record, and a project that no
 *      longer has any record is gone from `isKnownProjectId` — removal removes the
 *      project, never a byte of the workspace on disk.
 *   3. `WorkspaceCapsuleManager.clearAffiliation` severs the project claim while
 *      keeping the capsule (name, path, brief) and persistence intact, so a synced
 *      pass never re-registers the removed project at boot.
 *   4. Live terminals gate removal: a project whose sessions still run answers
 *      CONFIRM_REQUIRED, and `PROJECT_REMOVE_ANSWER` is the channel the modal's
 *      confirm strip rides — confirmed removes close the sessions it reported.
 *
 * The close-coordinator leg (`attemptClose` refusing a window that still has live
 * use) is already covered by `project-close-coordinator.test.ts`; this file seeds
 * no live shells, so the window close path reports `no live shell` and the remove
 * proceeds directly to records and sessions.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: an import that throws
// registers no case, and a file with no registered case still reports as one passing test.
installElectronStub();

import { ProjectRegistry } from '../../src/main/project/project-registry';
import { WorkspaceCapsuleManager } from '../../src/main/project/workspace-capsule';
import {
  hasValidatedAffiliation,
  isKnownProjectId,
  renameProjectEntry,
  removeProjectEntry,
  synchronizeCapsulesWithRegistry,
  projectRegistry as sharedProjectRegistry,
} from '../../src/main/index';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const PROJECT_A = 'project-00000000-0000-4000-8000-0000000000a1';
const WORKSPACE_A = 'workspace-00000000-0000-4000-8000-0000000000a1';
const PROJECT_B = 'project-00000000-0000-4000-8000-0000000000b2';
const WORKSPACE_B = 'workspace-00000000-0000-4000-8000-0000000000b2';
const PROJECT_C = 'project-00000000-0000-4000-8000-0000000000c3';
const WORKSPACE_C = 'workspace-00000000-0000-4000-8000-0000000000c3';
const PROJECT_D = 'project-00000000-0000-4000-8000-0000000000d4';
const WORKSPACE_D = 'workspace-00000000-0000-4000-8000-0000000000d4';
const PROJECT_GHOST = 'project-00000000-0000-4000-8000-000000000000';

let tmpDir = '';
let workspaceAPath = '';

/** A fake terminal manager: the sessions Main would see and the closes it would issue. */
function installFakeTerminalManager(sessions: Array<{ id: string; state: string; ownerKey?: string; capsuleId?: string; splitOf?: string }>) {
  const closed: string[] = [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const fake = {
    listSessions: () => sessions.map((s) => ({ id: s.id, state: s.state, splitOf: s.splitOf })),
    sessionOwnerKey: (id: string) => byId.get(id)?.ownerKey,
    sessionCapsuleId: (id: string) => byId.get(id)?.capsuleId,
    closeSession: async (id: string) => { closed.push(id); return true; },
  };
  const holder = TerminalManager as unknown as { instance?: unknown };
  const previous = holder.instance;
  holder.instance = fake;
  return {
    closed,
    restore: () => { holder.instance = previous; },
  };
}

function seedProject(projectId: string, workspaceId: string, name: string): void {
  sharedProjectRegistry.ensureInitialWorkspace(projectId, workspaceId, workspaceAPath, tmpDir);
  const record = sharedProjectRegistry.getProject(projectId);
  sharedProjectRegistry.registerProject({ ...record, name });
}

function unseedProject(projectId: string): void {
  try {
    const record = sharedProjectRegistry.getProject(projectId);
    sharedProjectRegistry.registerProject({ ...record, state: 'closed' });
  } catch {
    // already gone
  }
}

describe('Project rename/remove', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p10-test-'));
    workspaceAPath = path.join(tmpDir, 'workspace-alpha');
    fs.mkdirSync(workspaceAPath, { recursive: true });
    fs.writeFileSync(path.join(workspaceAPath, 'keep.txt'), 'do not delete', 'utf8');
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('renameProjectEntry rewrites the registry name and refuses unknown or empty input', () => {
    seedProject(PROJECT_A, WORKSPACE_A, 'Original Name');
    try {
      const renamed = renameProjectEntry({ projectId: PROJECT_A, name: 'Renamed Alpha' });
      assert.deepStrictEqual(renamed, { status: 'RENAMED', projectId: PROJECT_A, name: 'Renamed Alpha' });
      assert.strictEqual(sharedProjectRegistry.getProject(PROJECT_A).name, 'Renamed Alpha');

      // The same rename idempotently reports RENAMED — the record already carries it.
      assert.strictEqual(renameProjectEntry({ projectId: PROJECT_A, name: 'Renamed Alpha' }).status, 'RENAMED');

      assert.strictEqual(renameProjectEntry({ projectId: PROJECT_A, name: '   ' }).status, 'FAILED');
      assert.strictEqual(renameProjectEntry({ projectId: 'not-an-id', name: 'x' }).status, 'FAILED');
      assert.strictEqual(renameProjectEntry({ projectId: PROJECT_GHOST, name: 'Ghost' }).status, 'UNKNOWN_PROJECT');
    } finally {
      unseedProject(PROJECT_A);
    }
  });

  it('a capsule rename survives a fresh sync pass — the capsule is the name authority', () => {
    const capsuleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p10-capsule-'));
    try {
      const wsPath = path.join(capsuleDir, 'ws-beta');
      fs.mkdirSync(wsPath, { recursive: true });
      const statePath = path.join(capsuleDir, 'workspace-capsules.json');
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        activeCapsuleId: 'capsule-beta',
        capsules: [{
          id: 'capsule-beta',
          name: 'Beta Old',
          workspacePath: wsPath,
          state: {},
          createdAt: 1000,
          updatedAt: 1000,
          projectId: PROJECT_B,
          workspaceId: WORKSPACE_B,
          migrationMarker: 'explicit',
        }],
      }, null, 2), 'utf8');

      const registry = new ProjectRegistry();
      const manager = new WorkspaceCapsuleManager({ filePath: statePath, affiliationAuthority: { projectRegistry: registry } });
      synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(registry.getProject(PROJECT_B).name, 'Beta Old');

      const renamed = manager.rename('capsule-beta', 'Beta New');
      assert.strictEqual(renamed.name, 'Beta New');
      assert.ok(renamed.updatedAt >= 1000);

      // A fresh boot's pass re-reads the capsule store and re-registers the new name —
      // persistence is what "rename durable across restart" reduces to.
      const reloaded = new WorkspaceCapsuleManager({ filePath: statePath, affiliationAuthority: { projectRegistry: registry } });
      synchronizeCapsulesWithRegistry(reloaded, registry, tmpDir);
      assert.strictEqual(registry.getProject(PROJECT_B).name, 'Beta New');
    } finally {
      fs.rmSync(capsuleDir, { recursive: true, force: true });
    }
  });

  it('removeProjectEntry closes the record, keeps the files, and drops the id from the known inventory', async () => {
    seedProject(PROJECT_C, WORKSPACE_C, 'Soon Removed');
    try {
      const tm = installFakeTerminalManager([]);
      try {
        const first = await removeProjectEntry({ projectId: PROJECT_C });
        assert.deepStrictEqual(first, { status: 'REMOVED', projectId: PROJECT_C });
        assert.strictEqual(tm.closed.length, 0, 'nothing to close: no sessions were ever claimed');
      } finally {
        // The project is already removed; restore the manager anyway for order.
        tm.restore();
      }

      assert.strictEqual(sharedProjectRegistry.getProject(PROJECT_C).state, 'closed');
      assert.strictEqual(isKnownProjectId(PROJECT_C), false, 'a removed project is no longer openable');
      // Removal is a list operation, never a filesystem one.
      assert.strictEqual(fs.readFileSync(path.join(workspaceAPath, 'keep.txt'), 'utf8'), 'do not delete');

      // Removing it again answers UNKNOWN_PROJECT, not another REMOVED.
      const second = await removeProjectEntry({ projectId: PROJECT_C });
      assert.strictEqual(second.status, 'UNKNOWN_PROJECT');
    } finally {
      unseedProject(PROJECT_C);
    }
  });

  it('live terminals gate removal behind CONFIRM_REQUIRED, and the confirmed answer closes them', async () => {
    seedProject(PROJECT_D, WORKSPACE_D, 'With Terminals');
    try {
      const tm = installFakeTerminalManager([
        { id: 'session-live', state: 'running', ownerKey: `project:${PROJECT_D}` },
        { id: 'session-done', state: 'exited', ownerKey: `project:${PROJECT_D}` },
        { id: 'session-foreign', state: 'running', ownerKey: 'project:other' },
      ]);
      try {
        const ask = await removeProjectEntry({ projectId: PROJECT_D });
        assert.deepStrictEqual(ask, { status: 'CONFIRM_REQUIRED', projectId: PROJECT_D, liveSessions: 1 });
        assert.strictEqual(tm.closed.length, 0, 'an unconfirmed ask never touches sessions');
        assert.strictEqual(sharedProjectRegistry.getProject(PROJECT_D).state, 'open', 'unconfirmed removal changes nothing');

        const confirmed = await removeProjectEntry({ projectId: PROJECT_D, confirmed: true });
        assert.deepStrictEqual(confirmed, { status: 'REMOVED', projectId: PROJECT_D });
        assert.deepStrictEqual(
          [...tm.closed].sort(),
          ['session-done', 'session-live'],
          'the confirmed remove closes every session the project owns, live or just exited',
        );
        assert.strictEqual(isKnownProjectId(PROJECT_D), false);
      } finally {
        tm.restore();
      }
    } finally {
      unseedProject(PROJECT_D);
    }
  });


  it('clearAffiliation severs the claim, keeps the capsule, and survives the next sync pass', () => {
    const capsuleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p10-clear-'));
    try {
      const wsPath = path.join(capsuleDir, 'ws-gamma');
      fs.mkdirSync(wsPath, { recursive: true });
      fs.writeFileSync(path.join(wsPath, 'notes.txt'), 'still here', 'utf8');
      const statePath = path.join(capsuleDir, 'workspace-capsules.json');
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        activeCapsuleId: 'capsule-gamma',
        capsules: [{
          id: 'capsule-gamma',
          name: 'Gamma',
          workspacePath: wsPath,
          state: {},
          createdAt: 1000,
          updatedAt: 1000,
          projectId: PROJECT_B,
          workspaceId: WORKSPACE_B,
          migrationMarker: 'explicit',
        }],
      }, null, 2), 'utf8');

      const registry = new ProjectRegistry();
      const manager = new WorkspaceCapsuleManager({ filePath: statePath, affiliationAuthority: { projectRegistry: registry } });
      synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(registry.getProject(PROJECT_B).state, 'open');

      const cleared = manager.clearAffiliation('capsule-gamma');
      assert.strictEqual(cleared.projectId, undefined);
      assert.strictEqual(cleared.workspaceId, undefined);
      // The capsule itself is untouched: name, path and marker survive for a re-open.
      assert.strictEqual(cleared.name, 'Gamma');
      assert.strictEqual(cleared.workspacePath, path.resolve(wsPath));
      assert.strictEqual(hasValidatedAffiliation(manager.get('capsule-gamma')), false);

      // The remove half of the durable change: close the registry record, then a fresh
      // sync — as the next boot would run it — must NOT resurrect the project.
      registry.closeProject(PROJECT_B);
      const reloaded = new WorkspaceCapsuleManager({ filePath: statePath, affiliationAuthority: { projectRegistry: registry } });
      const sync = synchronizeCapsulesWithRegistry(reloaded, registry, tmpDir);
      assert.strictEqual(sync.registeredProjects, 0);
      assert.strictEqual(registry.getProject(PROJECT_B).state, 'closed');

      // Persisted state carries no affiliation either, and the files are untouched.
      const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.strictEqual(onDisk.capsules[0].projectId, undefined);
      assert.strictEqual(fs.readFileSync(path.join(wsPath, 'notes.txt'), 'utf8'), 'still here');
    } finally {
      fs.rmSync(capsuleDir, { recursive: true, force: true });
    }
  });
});
