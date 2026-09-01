import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import type { ExecutionBackend } from '../../src/main/agent/execution-backend';
describe('ControlPlaneRuntime Main Launch Owner & Attachment Authority', () => {
  it('issues attempt attachments bound to authoritative runtime lease and host epoch', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
        hostEpoch: 5,
      });

      runtime.projects.registerProject({
        id: projectId,
        name: 'Project',
        dataRoot,
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: workspaceId,
        projectId,
        rootPath: workspaceRoot,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const chat = runtime.chats.create(projectId, workspaceId, 'Test Chat');
      const run = runtime.runs.createRun(projectId, workspaceId, chat.id, 'codex');

      let activeAttemptId = '';
      let finishBackend: () => void;
      const backendPromise = new Promise<void>((r) => { finishBackend = r; });
      let startedResolve: () => void;
      const startedPromise = new Promise<void>((r) => { startedResolve = r; });

      const backend: ExecutionBackend = {
        id: 'codex',
        startRun: async function* (input) {
          activeAttemptId = input.attemptId;
          yield { type: 'text', runId: input.runId, attemptId: input.attemptId, stream: 'stdout', text: 'started' };
          yield {
            type: 'session/ref',
            runId: input.runId,
            attemptId: input.attemptId,
            sessionRef: { backendId: 'codex', opaqueRef: `${input.runId}:${input.attemptId}`, processPid: process.pid, createdAt: Date.now() },
          };
          startedResolve();
          await backendPromise;
          yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' };
        },
        cancel: async () => {},
      };
      const runPromise = runtime.runs.start(run.id, 'prompt', backend, { cwd: workspaceRoot });
      await startedPromise;

      const { launch, record } = runtime.issueAttemptAttachment(run.id, activeAttemptId, {
        backendId: 'codex',
        chatId: chat.id,
        grant: 'execute',
      });

      assert.ok(launch.attachmentId.startsWith('binding-'));
      assert.strictEqual(launch.runId, run.id);
      assert.strictEqual(launch.attemptId, activeAttemptId);
      assert.strictEqual(launch.hostEpoch, 5);
      assert.strictEqual(record.grant, 'execute');
      assert.strictEqual(record.lease?.hostEpoch, 5);

      // Validate attachment against the runtime's runs attachment registry
      const validated = runtime.runs.attachments.validateAttachment({
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId: run.id,
        attemptId: activeAttemptId,
        projectId,
        workspaceId,
        invocationId: 'inv-runtime-1',
        ownerPid: process.pid,
      });

      assert.strictEqual(validated.attachmentId, launch.attachmentId);
      assert.strictEqual(validated.grant, 'execute');
      assert.strictEqual(validated.hostEpoch, 5);

      finishBackend!();
      await runPromise;
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('maintains valid CLI session and attachment dispatch across runtime lease renewal boundaries (>20s)', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-renewal-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-renewal-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
        hostEpoch: 1,
      });

      // Register a test capability
      runtime.capabilities.register({
        name: 'test.echo',
        description: 'Test echo capability',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 10_000,
          retentionPolicy: 'run-durable',
          cancellationBehavior: 'abort-immediate',
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: async (params: Record<string, unknown>) => ({ echo: params.msg }),
      });

      // 1. Create a CLI session (default ttl 300,000ms)
      const cliSession = runtime.createCliSession({
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
        ttlMs: 300_000,
      });

      const initialLease = runtime.getLease();
      const initialToken = initialLease.token;

      // 2. Validate attachment and dispatch before renewal
      const claims1 = {
        attachmentId: cliSession.launch.attachmentId,
        attachmentSecret: cliSession.launch.secret,
        runId: cliSession.run.id,
        attemptId: cliSession.attempt.id,
        projectId,
        workspaceId,
        invocationId: 'inv-before-renewal',
        ownerPid: process.pid,
      };
      const authContext1 = runtime.runs.attachments.validateAttachment(claims1);
      const result1 = await runtime.capabilities.dispatch('test.echo', { msg: 'hello-1' }, authContext1) as { echo: string };
      assert.strictEqual(result1.echo, 'hello-1');

      // 3. Simulate crossing the 20s renewal threshold and the original 30s lease expiry
      const internalRuntime = runtime as unknown as { leaseState: { expiresAt: number } };
      internalRuntime.leaseState.expiresAt = Date.now() + 5_000; // only 5s left
      const renewedLease = runtime.getLease();
      assert.strictEqual(renewedLease.token, initialToken, 'Authoritative lease token must remain stable across renewals');
      assert.ok(renewedLease.expiresAt > Date.now() + 20_000, 'Renewed lease expiresAt must advance');
      const claims2 = {
        attachmentId: cliSession.launch.attachmentId,
        attachmentSecret: cliSession.launch.secret,
        runId: cliSession.run.id,
        attemptId: cliSession.attempt.id,
        projectId,
        workspaceId,
        invocationId: 'inv-after-renewal',
        ownerPid: process.pid,
      };
      const authContext2 = runtime.runs.attachments.validateAttachment(claims2);
      const result2 = await runtime.capabilities.dispatch('test.echo', { msg: 'hello-2' }, authContext2) as { echo: string };
      assert.strictEqual(result2.echo, 'hello-2');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('elevates effective lease expiry to cover active attachment lifetime even when embedded lease.expiresAt is in the past', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-effective-lease-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-effective-lease-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
        hostEpoch: 1,
      });

      runtime.capabilities.register({
        name: 'test.ping',
        description: 'Test ping capability',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 10_000,
          retentionPolicy: 'run-durable',
          cancellationBehavior: 'abort-immediate',
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: async () => ({ pong: true }),
      });

      const cliSession = runtime.createCliSession({
        backendId: 'cli',
        grant: 'write',
        ownerPid: process.pid,
        ttlMs: 300_000,
      });

      // Manually set embedded record.lease.expiresAt to the past (simulating expired initial 30s lease)
      const registryInternal = runtime.runs.attachments as unknown as {
        records: Map<string, { lease: { expiresAt: number }; expiresAt: number }>;
      };
      const record = registryInternal.records.get(cliSession.launch.attachmentId);
      if (!record || !record.lease) {
        assert.fail('Expected attachment record and embedded lease to exist');
      }
      record.lease.expiresAt = Date.now() - 5_000; // past!
      assert.ok(record.expiresAt > Date.now() + 200_000); // attachment still active
      // Validate attachment: must return effectiveLease with expiresAt >= record.expiresAt
      const claims = {
        attachmentId: cliSession.launch.attachmentId,
        attachmentSecret: cliSession.launch.secret,
        runId: cliSession.run.id,
        attemptId: cliSession.attempt.id,
        projectId,
        workspaceId,
        invocationId: 'inv-elevated-lease',
        ownerPid: process.pid,
      };
      const authContext = runtime.runs.attachments.validateAttachment(claims);
      assert.ok(authContext.lease.expiresAt > Date.now(), 'Effective lease expiresAt must be in the future');
      assert.strictEqual(authContext.lease.expiresAt, record.expiresAt, 'Effective lease expiresAt must match record.expiresAt');

      // Dispatch capability through capability catalogue: must succeed without throwing LEASE_EXPIRED
      const res = await runtime.capabilities.dispatch('test.ping', {}, authContext) as { pong: boolean };
      assert.strictEqual(res.pong, true);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
