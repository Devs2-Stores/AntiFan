import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import {
  CapabilityError,
  ClientInvocationIntent,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

describe('Historical Authority & Invocation Replay (Phase 02)', () => {
  let tmpDir: string;
  let ledger: InvocationLedger;
  let registry: AttachmentRegistry;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-replay-test-'));
    ledger = new InvocationLedger({ dataRoot: tmpDir });
    await ledger.initialize();
    registry = new AttachmentRegistry();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Replays completed receipt even after attachment lease expires', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 1000, 1);

    const catalogue = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue.register({
      name: 'test.action',
      description: 'Test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ value: 'executed-result-123' }),
    });

    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      ttlMs: 500, // Short TTL
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-hist-1',
      idempotencyKey: 'idem-hist-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'test.action',
      params: { foo: 'bar' },
    };

    // 1. Initial invocation executes as OWNER and succeeds
    const resp1 = await transport.dispatchIntent(intent);
    assert.strictEqual(resp1.ok, true);
    assert.deepStrictEqual(resp1.data, { value: 'executed-result-123' });

    // 2. Fast-forward / expire lease and attachment TTL
    const record = registry.getAttachment(launch.attachmentId)!;
    record.expiresAt = Date.now() - 1000;
    if (record.lease) {
      record.lease.expiresAt = Date.now() - 1000;
    }

    // 3. Same idempotencyKey lookup -> REPLAY succeeds and discloses cached receipt without LEASE_EXPIRED error
    const respReplay = await transport.dispatchIntent(intent);
    assert.strictEqual(respReplay.ok, true);
    assert.strictEqual(respReplay.invocationId, resp1.invocationId);
    assert.deepStrictEqual(respReplay.data, { value: 'executed-result-123' });

    // 4. New, un-cached invocation with expired lease fails closed with ATTACHMENT_STALE
    const newIntent: ClientInvocationIntent = {
      ...intent,
      requestId: 'req-hist-2',
      idempotencyKey: 'idem-hist-2',
    };
    const respNew = await transport.dispatchIntent(newIntent);
    assert.strictEqual(respNew.ok, false);
    assert.strictEqual(respNew.error?.code, 'ATTACHMENT_STALE');
  });

  it('2. Denies historical replay when lineage or secret is invalid', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue.register({
      name: 'test.action',
      description: 'Test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ value: 'executed-result-123' }),
    });

    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-lineage-1',
      idempotencyKey: 'idem-lineage-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'test.action',
      params: {},
    };

    const resp = await transport.dispatchIntent(intent);
    assert.strictEqual(resp.ok, true);

    // Replay with wrong secret -> AUTHENTICATION_DENIED
    const respWrongSecret = await transport.dispatchIntent({
      ...intent,
      attachmentSecret: 'wrong-secret',
    });
    assert.strictEqual(respWrongSecret.ok, false);
    assert.strictEqual(respWrongSecret.error?.code, 'AUTHENTICATION_DENIED');

    // Replay with unknown authority revision -> AUTHENTICATION_DENIED
    const respWrongRev = await transport.dispatchIntent({
      ...intent,
      authorityRevision: 'rev-unknown-999',
    });
    assert.strictEqual(respWrongRev.ok, false);
    assert.strictEqual(respWrongRev.error?.code, 'AUTHENTICATION_DENIED');
  });

  it('3. Redacts historical receipt data when caller grant is downgraded below receiptReadPermission', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue.register({
      name: 'write.action',
      description: 'Sensitive write action',
      risk: 'write',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'idempotent-write',
        risk: 'write',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'event-wait',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'tenant-scoped',
        receiptReadPermission: 'write',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ secretKey: 'classified-data-999' }),
    });

    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    // Initial attachment with write grant
    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      grant: 'write',
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-downgrade-1',
      idempotencyKey: 'idem-downgrade-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'write.action',
      params: {},
    };

    const resp1 = await transport.dispatchIntent(intent);
    assert.strictEqual(resp1.ok, true);
    assert.deepStrictEqual(resp1.data, { secretKey: 'classified-data-999' });

    // Downgrade caller grant to read
    const downgradedRev = await registry.rotateAuthorityRevision(launch.attachmentId, { grant: 'read' });

    // Replay with downgraded grant -> receipt is disclosed but payload is redacted
    const respReplay = await transport.dispatchIntent({
      ...intent,
      authorityRevision: downgradedRev,
    });
    assert.strictEqual(respReplay.ok, true);
    assert.deepStrictEqual(respReplay.data, { state: 'completed', redacted: true });
  });

  it('4. Security revoked attachment denies all historical and new executions', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue.register({
      name: 'test.action',
      description: 'Test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ value: 'ok' }),
    });

    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-rev-1',
      idempotencyKey: 'idem-rev-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'test.action',
      params: {},
    };

    await transport.dispatchIntent(intent);

    // Explicitly revoke attachment
    const record = registry.getAttachment(launch.attachmentId)!;
    record.state = 'revoked';

    // Replay on revoked attachment -> fails closed with AUTHENTICATION_DENIED
    const respReplay = await transport.dispatchIntent(intent);
    assert.strictEqual(respReplay.ok, false);
    assert.strictEqual(respReplay.error?.code, 'AUTHENTICATION_DENIED');
  });

  it('5. Quarantined corrupted partition fails closed without claiming OWNER', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const partitionPath = path.join(tmpDir, 'invocations', `${attachmentId}.jsonl`);
    fs.mkdirSync(path.dirname(partitionPath), { recursive: true });

    // Write a corrupt frame (missing required fields / bad checksum)
    fs.writeFileSync(partitionPath, '{"formatVersion":1,"corrupt":true}\n', 'utf8');

    // Initializing ledger triggers quarantine of the partition
    const localLedger = new InvocationLedger({ dataRoot: tmpDir });
    await localLedger.initialize();

    const intent: ClientInvocationIntent = {
      requestId: 'req-quarantine-1',
      idempotencyKey: 'idem-quarantine-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-1',
      name: 'test.action',
      params: {},
    };

    const authority = {
      attachmentId,
      authorityRevision: 'rev-1',
      revisionNumber: 1,
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runId: 'run-1',
      attemptId: 'att-1',
      backendId: 'test-backend',
      grant: 'read' as const,
      hostEpoch: 1,
      runtimePid: process.pid,
      runtimeLeaseToken: 'tok-1',
      leaseExpiresAt: Date.now() + 30_000,
      issuedAt: Date.now(),
    };

    // Attempting to claim or observe on quarantined partition throws DURABILITY_FAILED
    await assert.rejects(
      async () => localLedger.observe(intent, authority),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );

    await assert.rejects(
      async () => localLedger.claimOwner(intent, authority, 'policy-digest-1', 1, 'public'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );
  });

  it('6. Replays historical receipt across full restart with persisted verifiers and partitions', async () => {
    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restart-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    // 1. First runtime instance with persistence enabled
    const registry1 = new AttachmentRegistry(undefined, restartDir);
    const ledger1 = new InvocationLedger({ dataRoot: restartDir });
    await ledger1.initialize();

    const catalogue1 = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue1.register({
      name: 'test.action',
      description: 'Test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ count: 42, executedAt: Date.now() }),
    });

    const transport1 = new CapabilityTransportAdapter(catalogue1, registry1, ledger1);

    const { launch } = await registry1.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-restart-1',
      idempotencyKey: 'idem-restart-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'test.action',
      params: {},
    };

    const resp1 = await transport1.dispatchIntent(intent);
    assert.strictEqual(resp1.ok, true);
    assert.strictEqual((resp1.data as { count: number }).count, 42);

    // 2. Simulate process restart: create fresh registry and ledger from same dataRoot
    const registry2 = new AttachmentRegistry(undefined, restartDir);
    await registry2.initialize();

    const ledger2 = new InvocationLedger({ dataRoot: restartDir });
    await ledger2.initialize();

    const catalogue2 = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue2.register({
      name: 'test.action',
      description: 'Test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => ({ count: 999 }), // Different output if re-executed
    });

    const transport2 = new CapabilityTransportAdapter(catalogue2, registry2, ledger2);

    // 3. Dispatch replay intent across restart: must authenticate secret from attachments-v1.jsonl
    // and return the cached receipt from invocations/<attachmentId>.jsonl (count: 42, NOT count: 999)
    const resp2 = await transport2.dispatchIntent(intent);
    assert.strictEqual(resp2.ok, true);
    assert.strictEqual(resp2.invocationId, resp1.invocationId);
    assert.strictEqual((resp2.data as { count: number }).count, 42);
  });

  it('7. Quarantines and fails closed when attachments-v1.jsonl is corrupted', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-corrupt-reg-'));
    const filePath = path.join(corruptDir, 'attachments-v1.jsonl');
    fs.writeFileSync(filePath, '{"formatVersion":1,"corrupt":true}\n', 'utf8');

    const registry = new AttachmentRegistry(undefined, corruptDir);
    await assert.rejects(
      async () => registry.initialize(),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );

    // Registry remains in quarantined failure state and rejects authentication
    assert.throws(
      () => registry.authenticateAttachmentCredentials('some-id', 'some-secret'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );
  });

  it('8. Prunes historical revisions across restart and fails closed when authenticating pruned revision', async () => {
    const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-rev-retention-'));
    try {
      const registry1 = new AttachmentRegistry(undefined, regDir, 3); // Max 3 revisions retained
      await registry1.initialize();

      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      const runId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

      const { launch } = await registry1.issueAttachment(runId, attemptId, projectId, workspaceId, {
        backendId: 'test-backend',
        lease,
        leaseToken: lease.token,
      });

      const rev1 = launch.authorityRevision;
      const rev2 = await registry1.rotateAuthorityRevision(launch.attachmentId);
      const rev3 = await registry1.rotateAuthorityRevision(launch.attachmentId);

      // Restart into registry2 from disk with maxHistoricalRevisions: 3
      const registry2 = new AttachmentRegistry(undefined, regDir, 3);
      await registry2.initialize();

      // Before 4th rotation, rev1, rev2, rev3 are all valid
      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev3 }));
      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev2 }));
      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev1 }));

      // 4th rotation in registry2 -> prunes rev1 (history retained: rev2, rev3, rev4)
      const rev4 = await registry2.rotateAuthorityRevision(launch.attachmentId);

      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev4 }));
      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev3 }));
      assert.ok(registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev2 }));

      // rev1 was pruned -> must fail closed with AUTHENTICATION_DENIED
      assert.throws(
        () => registry2.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev1 }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'AUTHENTICATION_DENIED'
      );

      // Restart again into registry3 -> verify persisted state only contains bounded revisions
      const registry3 = new AttachmentRegistry(undefined, regDir, 3);
      await registry3.initialize();
      assert.ok(registry3.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev4 }));
      assert.throws(
        () => registry3.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: rev1 }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'AUTHENTICATION_DENIED'
      );
    } finally {
      try {
        fs.rmSync(regDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('9. Policy-aware settlement classifier settles aborts with no-effect as interrupted', async () => {
    const runId = makeControlPlaneId('run');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 10000, 1);

    const catalogue = new CapabilityCatalogue({
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      runtime: { mode: 'standalone', lifecycle: 'active' },
    });

    catalogue.register({
      name: 'abortable.action',
      description: 'Abortable action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
      },
      execute: async () => {
        const err = new Error('Execution aborted by client');
        err.name = 'AbortError';
        throw err;
      },
    });

    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);
    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
    });

    const intent: ClientInvocationIntent = {
      requestId: 'req-abort-1',
      idempotencyKey: 'idem-abort-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
      name: 'abortable.action',
      params: {},
    };

    const resp = await transport.dispatchIntent(intent);
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error?.code, 'ABORTED');

    // Verify ledger record was settled as interrupted (NOT failed)
    const record = ledger.getRecord(resp.invocationId);
    assert.strictEqual(record?.state, 'interrupted');
  });

  it('10. Strict separation of receipt read permission vs live execution authority', async () => {
    const runId = makeControlPlaneId('run');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 50, 1);

    const { launch, record } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      ttlMs: 50,
      grant: 'write',
    });

    // Wait for attachment and lease to expire
    await new Promise((r) => setTimeout(r, 60));

    // 1. Live execution fails closed because attachment/lease is expired
    assert.throws(
      () => registry.validateLiveExecution(record, launch.authorityRevision!),
      (err: unknown) => err instanceof CapabilityError && (err.code === 'ATTACHMENT_STALE' || err.code === 'LEASE_EXPIRED')
    );

    // 2. Receipt read permission authorization still succeeds for historical inspection
    const readAuth = registry.authorizeReceiptRead(
      { attachmentId: launch.attachmentId, attachmentSecret: launch.secret },
      'read',
      'public'
    );
    assert.strictEqual(readAuth.allowed, true);
    assert.strictEqual(readAuth.record.id, launch.attachmentId);

    // 3. Historical revision resolution succeeds for historical inspection
    const histAuth = registry.resolveHistoricalRevision({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision!,
    });
    assert.strictEqual(histAuth.attachmentId, launch.attachmentId);
    assert.strictEqual(histAuth.authorityRevision, launch.authorityRevision);
  });
});
