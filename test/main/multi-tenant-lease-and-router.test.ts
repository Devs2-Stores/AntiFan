import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProjectRegistry } from '../../src/main/project/project-registry';
import { WorkspaceRegistry } from '../../src/main/project/workspace-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { registerFileCapabilities } from '../../src/main/tools/file-capabilities';
import {
  makeControlPlaneId,
  issueRuntimeLease,
  CapabilityError,
  AuthenticatedCapabilityContext,
  CapabilityRequestContext,
} from '../../src/shared/control-plane-contracts';

describe('Multi-Tenant Lease Issuance & Dynamic Workspace Router (Phase 01)', () => {
  it('ensureInitialWorkspace succeeds for fresh workspace and is idempotent for attached workspace', () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);

    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-ws-'));

    try {
      const ws1 = workspaces.ensureInitialWorkspace(projectId, workspaceId, tempDir, path.join(tempDir, 'data'));
      assert.strictEqual(ws1.id, workspaceId);
      assert.strictEqual(ws1.projectId, projectId);
      assert.strictEqual(ws1.state, 'attached');

      // Idempotent second call returns existing record
      const ws2 = workspaces.ensureInitialWorkspace(projectId, workspaceId, tempDir, path.join(tempDir, 'data'));
      assert.strictEqual(ws2.id, workspaceId);
      assert.strictEqual(ws2.projectId, projectId);
      assert.strictEqual(ws2.state, 'attached');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ensureInitialWorkspace fails closed on cross-project ID collision, detached workspace, and closed project', () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);

    const projectA = makeControlPlaneId('project');
    const projectB = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-ws-collision-'));

    try {
      // 1. Attach workspaceId to Project A
      workspaces.ensureInitialWorkspace(projectA, workspaceId, tempDir, path.join(tempDir, 'dataA'));

      // 2. Attempt to initialize the SAME workspaceId for Project B -> MUST throw error
      assert.throws(
        () => workspaces.ensureInitialWorkspace(projectB, workspaceId, tempDir, path.join(tempDir, 'dataB')),
        /already registered to another project/
      );

      // 3. Detach workspace from Project A
      workspaces.detach(workspaceId, projectA);

      // 4. Attempt to initialize detached workspaceId -> MUST fail closed
      assert.throws(
        () => workspaces.ensureInitialWorkspace(projectA, workspaceId, tempDir, path.join(tempDir, 'dataA')),
        /workspace is detached/
      );

      // 5. Close Project A and attempt to initialize a new workspace on closed Project A -> MUST fail closed
      projects.closeProject(projectA);
      const newWs = makeControlPlaneId('workspace');
      assert.throws(
        () => workspaces.ensureInitialWorkspace(projectA, newWs, tempDir, path.join(tempDir, 'dataA')),
        /Cannot initialize a Workspace on a closed Project/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('CapabilityCatalogue resolves multi-workspace dynamically and enforces tenant boundaries', async () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);

    const projectA = makeControlPlaneId('project');
    const projectB = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const wsB = makeControlPlaneId('workspace');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-b-'));

    try {
      workspaces.ensureInitialWorkspace(projectA, wsA, dirA, path.join(dirA, 'data'));
      workspaces.ensureInitialWorkspace(projectB, wsB, dirB, path.join(dirB, 'data'));

      const runtimeLeaseA = issueRuntimeLease(projectA, wsA, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: projectA,
        workspaceId: wsA,
        runtimeId: runtimeLeaseA.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => runtimeLeaseA,
        workspaceRegistry: workspaces,
      });

      // 1. Resolve workspace for Project A
      const resolvedA = catalogue.resolveAuthoritativeWorkspace(projectA, wsA);
      assert.strictEqual(resolvedA.id, wsA);
      assert.strictEqual(resolvedA.projectId, projectA);

      // 2. Resolve workspace for Project B
      const resolvedB = catalogue.resolveAuthoritativeWorkspace(projectB, wsB);
      assert.strictEqual(resolvedB.id, wsB);
      assert.strictEqual(resolvedB.projectId, projectB);

      // 3. Cross-project mismatch: requesting wsB under projectA MUST throw PROJECT_MISMATCH
      assert.throws(
        () => catalogue.resolveAuthoritativeWorkspace(projectA, wsB),
        (err: unknown) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH'
      );

      // 4. Non-existent workspace MUST throw WORKSPACE_MISMATCH
      assert.throws(
        () => catalogue.resolveAuthoritativeWorkspace(projectA, makeControlPlaneId('workspace')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH'
      );
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('Dual Dispatch: dispatchAuthenticated uses attachment-issued token and dispatchTrusted validates active lease', async () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);

    const projectA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projectB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dual-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dual-b-'));

    try {
      workspaces.ensureInitialWorkspace(projectA, wsA, dirA, path.join(dirA, 'data'));
      workspaces.ensureInitialWorkspace(projectB, wsB, dirB, path.join(dirB, 'data'));

      const activeLeaseA = issueRuntimeLease(projectA, wsA, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: projectA,
        workspaceId: wsA,
        runtimeId: activeLeaseA.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => activeLeaseA,
        workspaceRegistry: workspaces,
      });

      catalogue.register({
        name: 'test.action',
        description: 'Test action',
        risk: 'write',
        inputSchema: { type: 'object' },
        execute: async (p: Record<string, unknown>, ctx) => ({
          targetProject: ctx.projectId,
          targetWorkspace: ctx.workspaceId,
          payload: p.data,
        }),
      });

      // 1. dispatchTrusted for Primary Workspace (Project A)
      const trustedContextA: CapabilityRequestContext = {
        lease: activeLeaseA,
        leaseToken: activeLeaseA.token,
        projectId: projectA,
        workspaceId: wsA,
        grant: 'write',
      };
      const resTrustedA = (await catalogue.dispatchTrusted('test.action', { data: 'trusted-a' }, trustedContextA)) as {
        targetProject: string;
        targetWorkspace: string;
        payload: string;
      };
      assert.strictEqual(resTrustedA.targetProject, projectA);
      assert.strictEqual(resTrustedA.targetWorkspace, wsA);
      assert.strictEqual(resTrustedA.payload, 'trusted-a');

      // 2. dispatchTrusted with forged token on Project A MUST throw UNAUTHENTICATED
      const forgedLeaseA = { ...activeLeaseA, token: 'forged-token-00000000000000000000000000000000000000000000000000' };
      const forgedContextA: CapabilityRequestContext = {
        lease: forgedLeaseA,
        leaseToken: forgedLeaseA.token,
        projectId: projectA,
        workspaceId: wsA,
        grant: 'write',
      };
      await assert.rejects(
        () => catalogue.dispatchTrusted('test.action', { data: 'forged' }, forgedContextA),
        (err: unknown) => err instanceof CapabilityError && err.code === 'UNAUTHENTICATED'
      );

      // 3. dispatchAuthenticated for Secondary Tenant (Project B) using its session-issued lease
      const sessionLeaseB = issueRuntimeLease(projectB, wsB, 60_000, 1);
      sessionLeaseB.runtimeId = activeLeaseA.runtimeId; // bound to same runtime
      const authContextB: AuthenticatedCapabilityContext = {
        attachmentId: 'binding-12345678901234567890',
        runId: 'run-12345678901234567890',
        attemptId: 'attempt-12345678901234567890',
        projectId: projectB,
        workspaceId: wsB,
        backendId: 'cli',
        hostEpoch: 1,
        invocationId: 'inv-1',
        lease: sessionLeaseB,
        leaseToken: sessionLeaseB.token,
        grant: 'write',
      };
      const resAuthB = (await catalogue.dispatchAuthenticated('test.action', { data: 'auth-b' }, authContextB)) as {
        targetProject: string;
        targetWorkspace: string;
        payload: string;
      };
      assert.strictEqual(resAuthB.targetProject, projectB);
      assert.strictEqual(resAuthB.targetWorkspace, wsB);
      assert.strictEqual(resAuthB.payload, 'auth-b');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('File capabilities dynamically resolve workspace root per context', async () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);

    const projectA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projectB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-file-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-file-b-'));

    try {
      workspaces.ensureInitialWorkspace(projectA, wsA, dirA, path.join(dirA, 'data'));
      workspaces.ensureInitialWorkspace(projectB, wsB, dirB, path.join(dirB, 'data'));

      fs.writeFileSync(path.join(dirA, 'file-a.txt'), 'content-a', 'utf8');
      fs.writeFileSync(path.join(dirB, 'file-b.txt'), 'content-b', 'utf8');

      const leaseA = issueRuntimeLease(projectA, wsA, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: projectA,
        workspaceId: wsA,
        runtimeId: leaseA.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => leaseA,
        workspaceRegistry: workspaces,
      });

      const files = new WorkspaceFilePort();
      registerFileCapabilities(catalogue, files, () => dirA);

      // 1. Read file in Project A
      const ctxA: CapabilityRequestContext = {
        lease: leaseA,
        leaseToken: leaseA.token,
        projectId: projectA,
        workspaceId: wsA,
        grant: 'read',
      };
      const readA = (await catalogue.dispatch('file.read', { path: 'file-a.txt' }, ctxA)) as { content: string };
      assert.strictEqual(readA.content, 'content-a');

      // 2. Read file in Project B via authenticated context
      const leaseB = issueRuntimeLease(projectB, wsB, 30_000, 1);
      leaseB.runtimeId = leaseA.runtimeId;
      const ctxB: AuthenticatedCapabilityContext = {
        attachmentId: 'binding-22222222222222222222',
        runId: 'run-22222222222222222222',
        attemptId: 'attempt-22222222222222222222',
        projectId: projectB,
        workspaceId: wsB,
        backendId: 'cli',
        hostEpoch: 1,
        invocationId: 'inv-2',
        lease: leaseB,
        leaseToken: leaseB.token,
        grant: 'read',
      };
      const readB = (await catalogue.dispatch('file.read', { path: 'file-b.txt' }, ctxB)) as { content: string };
      assert.strictEqual(readB.content, 'content-b');

      // 3. Traversal across project roots is blocked
      assert.throws(
        () => files.read(dirA, '../file-b.txt'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
      );
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('ControlPlaneRuntime dynamically creates CLI session for secondary tenant and cwd', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-data-'));
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-ws-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-ws-b-'));

    const projectA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projectB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId: projectA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: dirA,
        hostEpoch: 1,
      });

      // Attach secondary project B
      runtime.projects.registerProject({
        id: projectB,
        name: 'Project-B',
        dataRoot: path.join(dataRoot, 'b'),
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: wsB,
        projectId: projectB,
        rootPath: dirB,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 1. Create CLI session for Project B explicitly
      const sessionB = runtime.createCliSession({
        projectId: projectB,
        workspaceId: wsB,
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
      });
      assert.strictEqual(sessionB.launch.projectId, projectB);
      assert.strictEqual(sessionB.launch.workspaceId, wsB);

      // 2. Create CLI session by cwd in Project B folder
      const sessionCwdB = runtime.createCliSession({
        cwd: path.join(dirB, 'subfolder'),
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
      });
      assert.strictEqual(sessionCwdB.launch.projectId, projectB);
      assert.strictEqual(sessionCwdB.launch.workspaceId, wsB);

      // 3. Sibling prefix must NOT match dirB (e.g. dirB + '-sibling' should fallback to default workspace A)
      const sessionSibling = runtime.createCliSession({
        cwd: dirB + '-sibling',
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
      });
      assert.strictEqual(sessionSibling.launch.projectId, projectA, 'Sibling prefix must not match project B');
      assert.strictEqual(sessionSibling.launch.workspaceId, wsA);

      // 4. Nested workspace root resolution: deepest nested attached root wins
      const wsBNested = makeControlPlaneId('workspace');
      const dirBNested = path.join(dirB, 'packages', 'nested-app');
      runtime.workspaces.register({
        id: wsBNested,
        projectId: projectB,
        rootPath: dirBNested,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const sessionNested = runtime.createCliSession({
        cwd: path.join(dirBNested, 'src', 'components'),
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
      });
      assert.strictEqual(sessionNested.launch.projectId, projectB);
      assert.strictEqual(sessionNested.launch.workspaceId, wsBNested, 'Deepest nested workspace root must be selected');

      // 5. Validate and dispatch using session B credentials
      const claimsB = {
        attachmentId: sessionB.launch.attachmentId,
        attachmentSecret: sessionB.launch.secret,
        runId: sessionB.run.id,
        attemptId: sessionB.attempt.id,
        projectId: projectB,
        workspaceId: wsB,
        invocationId: 'inv-b-1',
        ownerPid: process.pid,
      };
      const authContextB = runtime.runs.attachments.validateAttachment(claimsB);
      assert.strictEqual(authContextB.projectId, projectB);
      assert.strictEqual(authContextB.workspaceId, wsB);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});
