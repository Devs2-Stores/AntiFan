import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { registerFileCapabilities } from '../../src/main/tools/file-capabilities';
import { ProjectRegistry } from '../../src/main/project/project-registry';
import { WorkspaceRegistry } from '../../src/main/project/workspace-registry';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import {
  CapabilityError,
  CapabilityRequestContext,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

describe('File capabilities tenant isolation & missing reads', () => {
  it('fails closed when context is missing or lacks tenant identity', async () => {
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: 'project-test-01',
      workspaceId: 'workspace-test-01',
      runtimeId: 'runtime-test-01',
      hostEpoch: 1,
    });
    const files = new WorkspaceFilePort();
    registerFileCapabilities(catalogue, files, () => os.tmpdir());

    await assert.rejects(
      async () => catalogue.dispatch('file.read', { path: 'package.json' }, undefined as unknown as CapabilityRequestContext),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );

    const dummyProjectId = makeControlPlaneId('project');
    const dummyWorkspaceId = makeControlPlaneId('workspace');
    const partialCtx = {
      lease: issueRuntimeLease(dummyProjectId, dummyWorkspaceId, 30_000, 1),
      leaseToken: 'token',
      projectId: dummyProjectId,
      workspaceId: '',
    } as unknown as CapabilityRequestContext;
    await assert.rejects(
      async () => catalogue.dispatch('file.read', { path: 'package.json' }, partialCtx),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );
  });

  it('fails closed and rejects global fallback when workspace registry has unresolved tenant', async () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const globalFallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-global-fallback-'));

    try {
      const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
        workspaceRegistry: workspaces,
      });

      const files = new WorkspaceFilePort();
      // Even if a global fallback getter is provided, it must NEVER be used for an unresolved tenant in a registry-backed catalogue
      registerFileCapabilities(catalogue, files, () => globalFallbackDir);

      const ctx: CapabilityRequestContext = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
      };

      // Unregistered workspace must fail closed with WORKSPACE_MISMATCH or WORKSPACE_UNBOUND (never use global fallback)
      await assert.rejects(
        async () => catalogue.dispatch('file.read', { path: 'package.json' }, ctx),
        (err: unknown) => err instanceof CapabilityError && (err.code === 'WORKSPACE_MISMATCH' || err.code === 'WORKSPACE_UNBOUND')
      );
    } finally {
      fs.rmSync(globalFallbackDir, { recursive: true, force: true });
    }
  });

  it('underlying default fix: no dataRoot parent as workspace, unbound root remains empty, no string blacklist', async () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-'));
    // A legitimate user project path that happens to contain ".antifan-data" in its name
    const legitimateUserDir = path.join(tempRoot, 'my-.antifan-data-backup-repo');
    fs.mkdirSync(legitimateUserDir, { recursive: true });
    fs.writeFileSync(path.join(legitimateUserDir, 'package.json'), '{"name":"legitimate-user-project"}');

    try {
      // 1. Initial workspace with empty rootPath remains empty (not coerced to process.cwd)
      const unboundRecord = workspaces.ensureInitialWorkspace(projectId, workspaceId, '', path.join(tempRoot, 'internal-data'));
      assert.strictEqual(unboundRecord.rootPath, '', 'Unbound initial root must remain empty string without forcing process.cwd');

      // 2. Legitimate directory name containing ".antifan-data" is NOT rejected by string blacklist when registered with evidence
      const legitimateWsId = makeControlPlaneId('workspace');
      const legitimateRecord = workspaces.ensureInitialWorkspace(projectId, legitimateWsId, legitimateUserDir, path.join(tempRoot, 'internal-data'));
      assert.strictEqual(legitimateRecord.rootPath, path.resolve(legitimateUserDir), 'Legitimate user path must not be blocked by symptom string blacklist');

      const lease = issueRuntimeLease(projectId, legitimateWsId, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId: legitimateWsId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
        workspaceRegistry: workspaces,
      });
      const files = new WorkspaceFilePort();
      registerFileCapabilities(catalogue, files);

      const ctx: CapabilityRequestContext = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId: legitimateWsId,
      };

      // File read on the legitimate user workspace succeeds
      const result = await catalogue.dispatch('file.read', { path: 'package.json' }, ctx) as { content: string };
      assert.strictEqual(result.content, '{"name":"legitimate-user-project"}');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws FILE_NOT_FOUND on missing file (no empty-success) and INVALID_ARGUMENT on directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-files-missing-'));
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      workspaces.ensureInitialWorkspace(projectId, workspaceId, root, path.join(root, 'data'));
      const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
        workspaceRegistry: workspaces,
      });
      const files = new WorkspaceFilePort();
      registerFileCapabilities(catalogue, files);

      const ctx: CapabilityRequestContext = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
      };

      // 1. Missing file must throw FILE_NOT_FOUND
      await assert.rejects(
        async () => catalogue.dispatch('file.read', { path: 'missing-file.json' }, ctx),
        (err: unknown) => err instanceof CapabilityError && err.code === 'FILE_NOT_FOUND'
      );

      // 2. Directory read must throw INVALID_ARGUMENT
      fs.mkdirSync(path.join(root, 'subfolder'), { recursive: true });
      await assert.rejects(
        async () => catalogue.dispatch('file.read', { path: 'subfolder' }, ctx),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
      );

      // 3. Existing file read succeeds
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"my-app"}', 'utf8');
      const result = await catalogue.dispatch('file.read', { path: 'package.json' }, ctx) as { path: string; content: string; truncated: boolean };
      assert.strictEqual(result.content, '{"name":"my-app"}');
      assert.strictEqual(result.truncated, false);

      // 4. file.assert_not_contains handles missing file without throwing
      const assertMissing = await catalogue.dispatch('file.assert_not_contains', { path: 'absent.txt', pattern: 'forbidden' }, ctx) as { ok: boolean; missing?: boolean };
      assert.strictEqual(assertMissing.ok, true);
      assert.strictEqual(assertMissing.missing, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('solo dev local: auto-binds verified explicit terminal CWD, rejects arbitrary request path, and migrates wrong defaults', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-solodev-'));
    const projectDir = path.join(tempDir, 'my-project');
    const arbitraryDir = path.join(tempDir, 'arbitrary-unverified');
    const internalData = path.join(tempDir, 'internal-data', 'control-plane');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(arbitraryDir, { recursive: true });
    fs.mkdirSync(internalData, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"solo-dev-project"}', 'utf8');

    try {
      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');

      // Mock TerminalManager that knows about projectDir
      const mockTerminal = {
        getCurrentCwd: () => projectDir,
        getActiveSessionId: () => 'term-1',
        getSession: (id: string) => (id === 'term-1' ? { id: 'term-1', cwd: projectDir } : undefined),
        listSessions: () => [{ id: 'term-1', cwd: projectDir, name: 'bash' }],
      } as unknown as TerminalManager;

      // Runtime initialized without explicit workspaceRoot
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot: internalData,
        terminal: mockTerminal,
      });

      // 1. Initial default workspace is unbound (''), NOT dataRoot or dataRoot parent
      const defaultWsBefore = runtime.workspaces.get(workspaceId, projectId);
      assert.strictEqual(defaultWsBefore.rootPath, '', 'Default workspace must initially be unbound (no dataRoot parent fallback)');

      // 2. Arbitrary request path (not registered in TerminalManager) must NOT auto-bind
      const sessionArbitrary = runtime.resolveWorkspaceForSession({ cwd: arbitraryDir });
      assert.strictEqual(sessionArbitrary.rootPath, '', 'Arbitrary request path without terminal evidence must not be auto-bound');

      // 3. Verified explicit terminal CWD auto-binds to the unbound default workspace
      const sessionVerified = runtime.resolveWorkspaceForSession({ cwd: projectDir });
      assert.strictEqual(sessionVerified.rootPath, path.resolve(projectDir), 'Verified terminal CWD must auto-bind default workspace');

      // 4. File capability read on the auto-bound workspace returns the real project file
      const lease = runtime.getLease();
      const ctx: CapabilityRequestContext = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
      };
      const readResult = await runtime.capabilities.dispatch('file.read', { path: 'package.json' }, ctx) as { content: string };
      assert.strictEqual(readResult.content, '{"name":"solo-dev-project"}');

      // 5. Evidence-aware migration: simulate an old persisted wrong default pointing to internalData or its parent
      const parentDir = path.resolve(internalData, '..');
      runtime.workspaces.register({ ...defaultWsBefore, rootPath: parentDir });
      runtime.setWorkspaceRoot(parentDir);
      assert.strictEqual(runtime.workspaces.get(workspaceId, projectId).rootPath, parentDir);
      // Resolving with verified terminal CWD migrates away from the old dataParent default to projectDir
      const migratedSession = runtime.resolveWorkspaceForSession({ cwd: projectDir });
      assert.strictEqual(migratedSession.rootPath, path.resolve(projectDir), 'Old persisted dataParent default must be migrated to verified terminal CWD');

      // 6. Explicit workspace ID query also migrates old wrong default before returning
      runtime.workspaces.register({ ...defaultWsBefore, rootPath: parentDir });
      const explicitMigrated = runtime.resolveWorkspaceForSession({ workspaceId, projectId });
      assert.strictEqual(explicitMigrated.rootPath, '', 'Explicit workspace ID query must migrate old persisted dataParent default to unbound');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
