import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import {
  CapabilityError,
  ClientInvocationIntent,
  MainResolvedAuthority,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

describe('InvocationLedger - Main Serialization & Deduplication', () => {
  let tmpDir: string;
  let ledger: InvocationLedger;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ledger-test-'));
    ledger = new InvocationLedger({ dataRoot: tmpDir });
    await ledger.initialize();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockAuthority(attachmentId: string, runId: string, attemptId: string): MainResolvedAuthority {
    return {
      attachmentId,
      authorityRevision: 'rev-test-1',
      revisionNumber: 1,
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runId,
      attemptId,
      backendId: 'test-backend',
      grant: 'write',
      hostEpoch: 1,
      runtimePid: process.pid,
      runtimeLeaseToken: 'lease-tok-1',
      leaseExpiresAt: Date.now() + 3600_000,
      issuedAt: Date.now(),
    };
  }

  it('1. Atomic OWNER claim and subsequent in-flight JOIN', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent: ClientInvocationIntent = {
      requestId: 'req-1',
      idempotencyKey: 'idem-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.click',
      params: { selector: '#checkout' },
    };

    // First caller -> OWNER
    const claim1 = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(claim1.kind, 'owner');
    assert.ok(claim1.invocationId.startsWith('invocation-'));
    assert.strictEqual(claim1.record?.state, 'in_progress');

    // Second concurrent caller with same idempotencyKey -> JOIN
    const claim2 = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(claim2.kind, 'join');
    assert.strictEqual(claim2.invocationId, claim1.invocationId);
    assert.ok(claim2.promise !== undefined);

    // Settle OWNER -> JOINer resolves with same settled record
    const settled = await ledger.settle(claim1.invocationId, 'completed', { clicked: true });
    assert.strictEqual(settled.state, 'completed');
    assert.deepStrictEqual(settled.result, { clicked: true });

    const joinerResult = await claim2.promise;
    assert.strictEqual(joinerResult.state, 'completed');
    assert.deepStrictEqual(joinerResult.result, { clicked: true });
  });

  it('2. Settled invocation returns REPLAY for subsequent calls', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent: ClientInvocationIntent = {
      requestId: 'req-2',
      idempotencyKey: 'idem-2',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.dom',
      params: { selector: 'main' },
    };

    const claim = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(claim.kind, 'owner');

    await ledger.settle(claim.invocationId, 'completed', '<main>Hello</main>');

    // Later call with same idempotencyKey -> REPLAY
    const replayClaim = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(replayClaim.kind, 'replay');
    assert.strictEqual(replayClaim.invocationId, claim.invocationId);
    assert.strictEqual(replayClaim.record?.state, 'completed');
    assert.strictEqual(replayClaim.record?.result, '<main>Hello</main>');
  });

  it('3. Rejects BINDING_COLLISION when parameters differ for same idempotencyKey', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent1: ClientInvocationIntent = {
      requestId: 'req-3a',
      idempotencyKey: 'idem-3',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.type',
      params: { text: 'first' },
    };

    await ledger.claimOrObserve(intent1, authority, 'policy-digest-1', 1, 'public');

    const intent2: ClientInvocationIntent = {
      requestId: 'req-3b',
      idempotencyKey: 'idem-3',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.type',
      params: { text: 'different' },
    };

    await assert.rejects(
      async () => ledger.claimOrObserve(intent2, authority, 'policy-digest-1', 1, 'public'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'BINDING_COLLISION'
    );
  });

  it('4. Crash recovery marks unsettled records as interrupted upon initialization', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent: ClientInvocationIntent = {
      requestId: 'req-4',
      idempotencyKey: 'idem-4',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.navigate',
      params: { url: 'https://example.com' },
    };

    const claim = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(claim.kind, 'owner');
    // Simulate crash before settlement

    // Create fresh ledger instance pointing to same dataRoot
    const recoveredLedger = new InvocationLedger({ dataRoot: tmpDir });
    await recoveredLedger.initialize();

    // Stale in_progress record is recovered as interrupted
    const replay = await recoveredLedger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(replay.kind, 'replay');
    assert.strictEqual(replay.record?.state, 'interrupted');
    assert.strictEqual(replay.record?.error?.code, 'PROCESS_INTERRUPTED');
  });

  it('5. Monotonic settle transition prevents overwriting terminal states', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent: ClientInvocationIntent = {
      requestId: 'req-mono-1',
      idempotencyKey: 'idem-mono-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'browser.click',
      params: {},
    };

    const claim = await ledger.claimOrObserve(intent, authority, 'policy-digest-1', 1, 'public');
    assert.strictEqual(claim.kind, 'owner');

    // Settle to 'unknown'
    const settledUnknown = await ledger.settle(claim.invocationId, 'unknown', undefined, {
      code: 'TIMEOUT',
      message: 'Timed out waiting for response',
    });
    assert.strictEqual(settledUnknown.state, 'unknown');

    // Attempting to re-settle to 'completed' must be a no-op / preserve monotonic 'unknown'
    const reSettle = await ledger.settle(claim.invocationId, 'completed', { clicked: true });
    assert.strictEqual(reSettle.state, 'unknown');
  });

  it('6. Quarantines partition and fails closed on invalid checksum or format version', async () => {
    const attachmentId = makeControlPlaneId('attachment');
    const partitionPath = path.join(tmpDir, 'invocations', `${attachmentId}.jsonl`);
    fs.mkdirSync(path.dirname(partitionPath), { recursive: true });

    // Corrupt formatVersion: 2
    fs.writeFileSync(partitionPath, JSON.stringify({
      formatVersion: 2,
      id: 'inv-future-1',
      attachmentId,
      requestId: 'req-1',
      idempotencyKey: 'idem-1',
      name: 'test.action',
      state: 'completed',
      checksum: 'fake-checksum',
    }) + '\n', 'utf8');

    const corruptLedger = new InvocationLedger({ dataRoot: tmpDir });
    await corruptLedger.initialize();

    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');
    const intent: ClientInvocationIntent = {
      requestId: 'req-claim-corrupt',
      idempotencyKey: 'idem-corrupt-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'test.action',
      params: {},
    };

    // Quarantined partition fails closed with DURABILITY_FAILED
    await assert.rejects(
      async () => corruptLedger.claimOwner(intent, authority, 'policy-digest-1', 1, 'public'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );
  });

  it('7. Compacts partition by coalescing duplicate lifecycle frames into single canonical latest state', async () => {
    const smallLedger = new InvocationLedger({ dataRoot: tmpDir });
    await smallLedger.initialize();

    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');

    // Append 5 completed invocations (each claims in_progress frame then settles completed frame -> 10 total frames)
    for (let i = 1; i <= 5; i++) {
      const intent: ClientInvocationIntent = {
        requestId: `req-compact-${i}`,
        idempotencyKey: `idem-compact-${i}`,
        attachmentId,
        attachmentSecret: 'sec-1',
        authorityRevision: 'rev-test-1',
        name: 'test.action',
        params: { index: i },
      };
      const claim = await smallLedger.claimOrObserve(intent, authority, 'digest', 1, 'public');
      assert.strictEqual(claim.kind, 'owner');
      await smallLedger.settle(claim.invocationId, 'completed', { result: i });
    }

    const partitionPath = path.join(tmpDir, 'invocations', `${attachmentId}.jsonl`);
    const uncompactedLines = fs.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.strictEqual(uncompactedLines.length, 10, 'Uncompacted partition must contain 10 raw frames (in_progress + completed per item)');

    // Perform compaction -> coalesces to 5 latest-state frames
    await smallLedger.compactPartition(attachmentId);
    const compactedLines = fs.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.strictEqual(compactedLines.length, 5, 'Compacted partition must contain exactly 5 coalesced records');

    // Replay partition from disk into a fresh ledger to verify compaction file integrity across all 5 items
    const replayedLedger = new InvocationLedger({ dataRoot: tmpDir });
    await replayedLedger.initialize();

    for (let i = 1; i <= 5; i++) {
      const checkIntent: ClientInvocationIntent = {
        requestId: `req-compact-${i}`,
        idempotencyKey: `idem-compact-${i}`,
        attachmentId,
        attachmentSecret: 'sec-1',
        authorityRevision: 'rev-test-1',
        name: 'test.action',
        params: { index: i },
      };
      const replayedClaim = await replayedLedger.claimOrObserve(checkIntent, authority, 'digest', 1, 'public');
      assert.strictEqual(replayedClaim.kind, 'replay');
      assert.strictEqual(replayedClaim.record?.state, 'completed');
      assert.strictEqual((replayedClaim.record?.result as any)?.result, i);
    }
  });
});
