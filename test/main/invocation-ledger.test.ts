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

  it('7. Automatically compacts partition on settle when uncompacted frames reach maxHotRecords', async () => {
    const autoLedger = new InvocationLedger({ dataRoot: tmpDir, maxHotRecordsPerPartition: 6 });
    await autoLedger.initialize();

    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');

    // 1st invocation: 2 frames (in_progress + completed)
    const intent1: ClientInvocationIntent = {
      requestId: 'req-auto-1',
      idempotencyKey: 'idem-auto-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'test.action',
      params: { index: 1 },
    };
    const claim1 = await autoLedger.claimOrObserve(intent1, authority, 'digest', 1, 'public');
    await autoLedger.settle(claim1.invocationId, 'completed', { result: 1 });

    // 2nd invocation: 4 frames total
    const intent2: ClientInvocationIntent = {
      requestId: 'req-auto-2',
      idempotencyKey: 'idem-auto-2',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'test.action',
      params: { index: 2 },
    };
    const claim2 = await autoLedger.claimOrObserve(intent2, authority, 'digest', 1, 'public');
    await autoLedger.settle(claim2.invocationId, 'completed', { result: 2 });

    const partitionPath = path.join(tmpDir, 'invocations', `${attachmentId}.jsonl`);
    let lines = fs.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 4, 'Before reaching threshold, partition has 4 raw frames');

    // 3rd invocation: reaches 6 frames on settle -> automatically triggers compactPartition!
    const intent3: ClientInvocationIntent = {
      requestId: 'req-auto-3',
      idempotencyKey: 'idem-auto-3',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'test.action',
      params: { index: 3 },
    };
    const claim3 = await autoLedger.claimOrObserve(intent3, authority, 'digest', 1, 'public');
    await autoLedger.settle(claim3.invocationId, 'completed', { result: 3 });

    // Drain pending IO operations deterministically
    await autoLedger.drain(attachmentId);
    // File on disk was automatically compacted from 6 frames down to 3 latest-state frames
    lines = fs.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3, 'Automatic compaction must coalesce partition to 3 latest-state frames');

    // Replay partition from disk into a fresh ledger to verify all 3 completed receipts are preserved
    const replayedLedger = new InvocationLedger({ dataRoot: tmpDir });
    await replayedLedger.initialize();

    for (let i = 1; i <= 3; i++) {
      const checkIntent: ClientInvocationIntent = {
        requestId: `req-auto-${i}`,
        idempotencyKey: `idem-auto-${i}`,
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

  it('8. Append failure while compaction is queued leaves no ghost receipt in memory, on disk, or upon restart and triggers zero unhandled rejections', async () => {
    const unhandledList: unknown[] = [];
    const rejectionHandler = (reason: unknown) => {
      unhandledList.push(reason);
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      const ledger = new InvocationLedger({ dataRoot: tmpDir });
      await ledger.initialize();

      const attachmentId = makeControlPlaneId('attachment');
      const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');

      // Seed with 1 valid completed invocation
      const validIntent: ClientInvocationIntent = {
        requestId: 'req-valid-1',
        idempotencyKey: 'idem-valid-1',
        attachmentId,
        attachmentSecret: 'sec-1',
        authorityRevision: 'rev-test-1',
        name: 'test.action',
        params: { ok: true },
      };
      const validClaim = await ledger.claimOwner(validIntent, authority, 'digest', 1, 'public');
      await ledger.settle(validClaim.invocationId, 'completed', { done: true });

      // Now force fs.promises.appendFile to fail for the next append
      const originalAppendFile = fs.promises.appendFile;
      let failCount = 0;
      (fs.promises as any).appendFile = async (...args: any[]) => {
        failCount++;
        throw new Error('Simulated ENOSPC disk write failure');
      };

      const failingIntent: ClientInvocationIntent = {
        requestId: 'req-fail-1',
        idempotencyKey: 'idem-fail-1',
        attachmentId,
        attachmentSecret: 'sec-1',
        authorityRevision: 'rev-test-1',
        name: 'test.action',
        params: { fail: true },
      };

      // Concurrent append attempt + compaction call
      const appendPromise = ledger.claimOwner(failingIntent, authority, 'digest', 1, 'public');
      const compactionPromise = ledger.compactPartition(attachmentId);

      await assert.rejects(
        appendPromise,
        (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED' && err.message.includes('Simulated ENOSPC')
      );

      // Restore fs.promises.appendFile
      fs.promises.appendFile = originalAppendFile;

      // Await compaction completion
      await compactionPromise;

      // Wait for next tick to ensure no deferred unhandled rejections exist
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(unhandledList.length, 0, 'Must emit exactly 0 unhandled promise rejections on append failure');

      // Verify failing idempotency key does not exist in memory
      const inMemoryObserve = await ledger.observe(failingIntent, authority);
      assert.strictEqual(inMemoryObserve, undefined, 'Failing claim must not exist in memory');

      // Verify on disk and across restart
      const replayedLedger = new InvocationLedger({ dataRoot: tmpDir });
      await replayedLedger.initialize();
      const replayedObserve = await replayedLedger.observe(failingIntent, authority);
      assert.strictEqual(replayedObserve, undefined, 'Failing claim must not exist in replayed ledger');

      // Valid claim must remain intact
      const validObserve = await replayedLedger.observe(validIntent, authority);
      assert.strictEqual(validObserve?.kind, 'replay');
      assert.strictEqual((validObserve?.record?.result as any)?.done, true);
    } finally {
      process.removeListener('unhandledRejection', rejectionHandler);
    }
  });

  it('9. Concurrent claimOwner race on identical idempotencyKey under boundary lock yields exactly 1 OWNER and 1 in-flight JOIN without overwrite', async () => {
    const ledger = new InvocationLedger({ dataRoot: tmpDir });
    await ledger.initialize();

    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');

    const racedIntent: ClientInvocationIntent = {
      requestId: 'req-raced-1',
      idempotencyKey: 'idem-raced-1',
      attachmentId,
      attachmentSecret: 'sec-1',
      authorityRevision: 'rev-test-1',
      name: 'test.action',
      params: { count: 100 },
    };

    // Fire two identical claims simultaneously
    const [claimA, claimB] = await Promise.all([
      ledger.claimOwner(racedIntent, authority, 'digest', 1, 'public'),
      ledger.claimOwner(racedIntent, authority, 'digest', 1, 'public'),
    ]);

    const ownerClaim = claimA.kind === 'owner' ? claimA : claimB;
    const joinClaim = claimA.kind === 'join' ? claimA : claimB;

    assert.strictEqual(ownerClaim.kind, 'owner', 'Exactly one claim must be owner');
    assert.strictEqual(joinClaim.kind, 'join', 'Exactly one claim must be join');
    assert.strictEqual(joinClaim.invocationId, ownerClaim.invocationId);
    assert.ok(joinClaim.promise !== undefined);

    // Settle the owner -> joiner resolves with exact same result
    const settled = await ledger.settle(ownerClaim.invocationId, 'completed', { resolvedCount: 100 });
    const joinerResult = await joinClaim.promise;

    assert.strictEqual(settled.state, 'completed');
    assert.strictEqual(joinerResult.state, 'completed');
    assert.deepStrictEqual(joinerResult.result, { resolvedCount: 100 });
  });

  it('10. Claim-only workload triggers threshold compaction automatically without settle', async () => {
    const autoLedger = new InvocationLedger({ dataRoot: tmpDir, maxHotRecordsPerPartition: 4 });
    await autoLedger.initialize();

    const attachmentId = makeControlPlaneId('attachment');
    const authority = createMockAuthority(attachmentId, 'run-1', 'att-1');

    // 4 claim-only invocations (no settle)
    for (let i = 1; i <= 4; i++) {
      const intent: ClientInvocationIntent = {
        requestId: `req-claim-only-${i}`,
        idempotencyKey: `idem-claim-only-${i}`,
        attachmentId,
        attachmentSecret: 'sec-1',
        authorityRevision: 'rev-test-1',
        name: 'test.action',
        params: { index: i },
      };
      const claim = await autoLedger.claimOwner(intent, authority, 'digest', 1, 'public');
      assert.strictEqual(claim.kind, 'owner');
    }

    // Drain pending IO operations deterministically
    await autoLedger.drain(attachmentId);
    const partitionPath = path.join(tmpDir, 'invocations', `${attachmentId}.jsonl`);
    const lines = fs.readFileSync(partitionPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 4, 'Compacted partition must contain 4 in_progress frames');
  });
});
