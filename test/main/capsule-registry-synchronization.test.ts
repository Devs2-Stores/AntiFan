import { describe, it } from 'node:test';
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
  synchronizeCapsulesWithRegistry,
  isKnownProjectId,
  resolveWindowRecord,
  hasValidatedAffiliation,
  uniqueValidatedClaim,
  projectRegistry as sharedProjectRegistry,
} from '../../src/main/index';

describe('Capsule store to ProjectRegistry synchronization', () => {
  it('names the default browsing project Tổng hợp without changing its identity or workspace', () => {
    const projectId = 'project-00000000-0000-4000-8000-000000000001';
    const workspaceId = 'workspace-00000000-0000-4000-8000-000000000001';
    sharedProjectRegistry.ensureInitialWorkspace(projectId, workspaceId, os.tmpdir(), os.tmpdir());
    const original = sharedProjectRegistry.getProject(projectId);
    try {
      const record = resolveWindowRecord({ kind: 'project', projectId });
      assert.strictEqual(record.title, 'Tổng hợp');
      assert.strictEqual(record.projectId, projectId);
      assert.strictEqual(record.workspaceId, workspaceId);
      assert.strictEqual(record.workspacePath, path.resolve(os.tmpdir()));
      sharedProjectRegistry.registerProject({ ...original, name: 'Personal browsing' });
      assert.strictEqual(resolveWindowRecord({ kind: 'project', projectId }).title, 'Personal browsing');
    } finally {
      sharedProjectRegistry.registerProject(original);
    }
  });
  it('a capsule-claimed project becomes openable and control-plane-resolvable after synchronization', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-1-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const wsPath = path.join(tmpDir, 'beta-workspace');
      fs.mkdirSync(wsPath, { recursive: true });

      const registry = new ProjectRegistry();
      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      const projectId = 'project-00000000-0000-4000-8000-0000000000d2';
      const workspaceId = 'workspace-00000000-0000-4000-8000-0000000000d2';

      // Seed explicit capsule into the file as the matrix harness does
      const capsuleData = {
        version: 1,
        activeCapsuleId: 'capsule-beta',
        capsules: [
          {
            id: 'capsule-beta',
            name: 'Matrix Beta',
            workspacePath: wsPath,
            state: {},
            createdAt: 1000,
            updatedAt: 1000,
            projectId,
            workspaceId,
            migrationMarker: 'explicit',
          },
        ],
      };
      fs.writeFileSync(statePath, JSON.stringify(capsuleData, null, 2), 'utf8');

      // Re-read with manager
      const reloadedManager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      // Before synchronization: registry knows nothing about beta
      assert.strictEqual(registry.listProjects().length, 0);
      assert.throws(
        () => registry.getWorkspace(workspaceId, projectId),
        /Workspace not found/,
      );

      // Run synchronization
      const syncResult = synchronizeCapsulesWithRegistry(reloadedManager, registry, tmpDir);
      assert.strictEqual(syncResult.registeredProjects, 1);
      assert.strictEqual(syncResult.registeredWorkspaces, 1);

      // After synchronization: project and workspace are registered and control-plane-resolvable
      const project = registry.getProject(projectId);
      assert.strictEqual(project.id, projectId);
      assert.strictEqual(project.name, 'Matrix Beta');
      assert.strictEqual(project.state, 'open');

      const workspace = registry.getWorkspace(workspaceId, projectId);
      assert.strictEqual(workspace.id, workspaceId);
      assert.strictEqual(workspace.projectId, projectId);
      assert.strictEqual(workspace.state, 'attached');
      assert.strictEqual(workspace.rootPath, path.resolve(wsPath));

      // Also verify shared registry instance
      synchronizeCapsulesWithRegistry(reloadedManager, sharedProjectRegistry, tmpDir);
      assert.strictEqual(isKnownProjectId(projectId), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a capsule with no affiliation registers nothing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-2-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const wsPath = path.join(tmpDir, 'unaffiliated-workspace');
      fs.mkdirSync(wsPath, { recursive: true });

      const registry = new ProjectRegistry();
      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      manager.create('Legacy Workspace', wsPath);

      // Run synchronization on unaffiliated capsule
      const syncResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(syncResult.registeredProjects, 0);
      assert.strictEqual(syncResult.registeredWorkspaces, 0);

      // Registry remains completely empty
      assert.strictEqual(registry.listProjects().length, 0);
      assert.strictEqual(registry.listAllWorkspaces().length, 0);

      // Unknown project is still refused
      assert.strictEqual(isKnownProjectId('project-00000000-0000-4000-8000-0000000000ff'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a persisted explicit marker without a workspace id authorizes nothing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-4-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const wsPath = path.join(tmpDir, 'explicit-marker-without-workspace');
      fs.mkdirSync(wsPath, { recursive: true });

      const registry = new ProjectRegistry();
      const projectId = 'project-00000000-0000-4000-8000-0000000000d4';

      // Reachable from disk: the loader honours a persisted marker without checking that the
      // record also carries the workspace id the marker implies.
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        activeCapsuleId: 'capsule-incomplete',
        capsules: [
          {
            id: 'capsule-incomplete',
            name: 'Marker Only',
            workspacePath: wsPath,
            state: {},
            createdAt: 1000,
            updatedAt: 1000,
            projectId,
            migrationMarker: 'explicit',
          },
        ],
      }, null, 2), 'utf8');

      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      const [loaded] = manager.list();
      assert.ok(loaded);
      assert.strictEqual(loaded.migrationMarker, 'explicit');
      assert.strictEqual(loaded.workspaceId, undefined);
      assert.strictEqual(hasValidatedAffiliation(loaded), false);

      const syncResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(syncResult.registeredProjects, 0);
      assert.strictEqual(syncResult.registeredWorkspaces, 0);
      assert.strictEqual(registry.listAllWorkspaces().length, 0);
      assert.strictEqual(
        uniqueValidatedClaim(manager.list(), projectId),
        undefined,
        'an incomplete record must not authorize an open: it names no workspace the registry could resolve',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('two capsules claiming one project stay unregistered and unauthorized', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-5-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const firstPath = path.join(tmpDir, 'claim-a');
      const secondPath = path.join(tmpDir, 'claim-b');
      fs.mkdirSync(firstPath, { recursive: true });
      fs.mkdirSync(secondPath, { recursive: true });

      const registry = new ProjectRegistry();
      const projectId = 'project-00000000-0000-4000-8000-0000000000d5';

      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        activeCapsuleId: 'capsule-claim-a',
        capsules: [
          {
            id: 'capsule-claim-a',
            name: 'Claim A',
            workspacePath: firstPath,
            state: {},
            createdAt: 1000,
            updatedAt: 1000,
            projectId,
            workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d5',
            migrationMarker: 'explicit',
          },
          {
            id: 'capsule-claim-b',
            name: 'Claim B',
            workspacePath: secondPath,
            state: {},
            createdAt: 1000,
            updatedAt: 1000,
            projectId,
            workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d6',
            migrationMarker: 'explicit',
          },
        ],
      }, null, 2), 'utf8');

      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      const syncResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(syncResult.registeredProjects, 0, 'two claims on one project is ambiguity, not a tiebreak');
      assert.strictEqual(syncResult.registeredWorkspaces, 0);
      assert.strictEqual(registry.listAllWorkspaces().length, 0);
      assert.strictEqual(
        uniqueValidatedClaim(manager.list(), projectId),
        undefined,
        'an ambiguous claim must not authorize an open: the registry holds no workspace for it',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a capsule whose claimed workspace id differs from its path registers the claimed id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-3-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const wsPath = path.join(tmpDir, 'folder-name-different-from-workspace-id');
      fs.mkdirSync(wsPath, { recursive: true });

      const registry = new ProjectRegistry();
      const projectId = 'project-00000000-0000-4000-8000-0000000000d3';
      const claimedWorkspaceId = 'workspace-custom-uuid-4000-8000-0000000000d3';

      const capsuleData = {
        version: 1,
        activeCapsuleId: 'capsule-gamma',
        capsules: [
          {
            id: 'capsule-gamma',
            name: 'Matrix Gamma',
            workspacePath: wsPath,
            state: {},
            createdAt: 1000,
            updatedAt: 1000,
            projectId,
            workspaceId: claimedWorkspaceId,
            migrationMarker: 'explicit',
          },
        ],
      };
      fs.writeFileSync(statePath, JSON.stringify(capsuleData, null, 2), 'utf8');

      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      const syncResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(syncResult.registeredProjects, 1);
      assert.strictEqual(syncResult.registeredWorkspaces, 1);

      // Verify the exact claimed workspaceId was registered, NOT an id derived from path or newly minted
      const workspace = registry.getWorkspace(claimedWorkspaceId, projectId);
      assert.strictEqual(workspace.id, claimedWorkspaceId);
      assert.strictEqual(workspace.projectId, projectId);
      assert.strictEqual(workspace.rootPath, path.resolve(wsPath));
      assert.strictEqual(workspace.state, 'attached');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('re-running the synchronizer twice changes nothing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-4-'));
    try {
      const statePath = path.join(tmpDir, 'workspace-capsules.json');
      const wsPath = path.join(tmpDir, 'delta-workspace');
      fs.mkdirSync(wsPath, { recursive: true });

      const registry = new ProjectRegistry();
      const projectId = 'project-00000000-0000-4000-8000-0000000000d4';
      const workspaceId = 'workspace-00000000-0000-4000-8000-0000000000d4';

      const capsuleData = {
        version: 1,
        activeCapsuleId: 'capsule-delta',
        capsules: [
          {
            id: 'capsule-delta',
            name: 'Matrix Delta',
            workspacePath: wsPath,
            state: {},
            createdAt: 1500,
            updatedAt: 1500,
            projectId,
            workspaceId,
            migrationMarker: 'explicit',
          },
        ],
      };
      fs.writeFileSync(statePath, JSON.stringify(capsuleData, null, 2), 'utf8');

      const manager = new WorkspaceCapsuleManager({
        filePath: statePath,
        affiliationAuthority: { projectRegistry: registry },
      });

      // First run
      const firstResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(firstResult.registeredProjects, 1);
      assert.strictEqual(firstResult.registeredWorkspaces, 1);

      const projectsSnapshot1 = registry.listProjects();
      const workspacesSnapshot1 = registry.listAllWorkspaces();

      // Second run
      const secondResult = synchronizeCapsulesWithRegistry(manager, registry, tmpDir);
      assert.strictEqual(secondResult.registeredProjects, 0);
      assert.strictEqual(secondResult.registeredWorkspaces, 0);

      const projectsSnapshot2 = registry.listProjects();
      const workspacesSnapshot2 = registry.listAllWorkspaces();

      // State is identical
      assert.deepStrictEqual(projectsSnapshot2, projectsSnapshot1);
      assert.deepStrictEqual(workspacesSnapshot2, workspacesSnapshot1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolveWindowRecord follows fallback order for registry-only project and never produces an empty root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-test-5-'));
    try {
      const registry = sharedProjectRegistry;
      const projectId = 'project-00000000-0000-4000-8000-0000000000e1';
      const workspaceId = 'workspace-00000000-0000-4000-8000-0000000000e1';
      const rootPath = path.join(tmpDir, 'registry-root');
      fs.mkdirSync(rootPath, { recursive: true });

      // Register only in ProjectRegistry (no capsule in capsule store)
      registry.ensureInitialWorkspace(projectId, workspaceId, rootPath, tmpDir);

      const record = resolveWindowRecord({ kind: 'project', projectId });
      // 1. Registry workspace root wins
      assert.strictEqual(record.workspacePath, path.resolve(rootPath));
      assert.strictEqual(record.workspaceId, workspaceId);
      assert.strictEqual(record.projectId, projectId);
      assert.ok(record.workspacePath && record.workspacePath.length > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
