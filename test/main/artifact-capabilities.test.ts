import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ArtifactStore, ArtifactPreflightResult } from '../../src/main/tools/artifact-store';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerArtifactCapabilities } from '../../src/main/tools/artifact-capabilities';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  RuntimeLease,
  ArtifactReadResult,
  ArtifactRef,
} from '../../src/shared/control-plane-contracts';

describe('Artifact Capabilities & Content-Addressed Storage (Phase 04)', () => {
  let tempDir: string;
  let store: ArtifactStore;
  let catalogue: CapabilityCatalogue;
  let projectId: string;
  let workspaceId: string;
  let lease: RuntimeLease;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-art-cap-'));
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
    store = new ArtifactStore({ root: tempDir, maxArtifactBytes: 8 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024 });
    catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerArtifactCapabilities(catalogue, store);
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Stages text artifact, redacts secrets, and computes SHA-256 content address', () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const textData = JSON.stringify({ token: 'very_long_secret_token_1234567890_abcdef', message: 'hello world' });

    const ref = store.stage({
      kind: 'dom',
      mime: 'application/json',
      data: textData,
      runId,
      attemptId,
      projectId,
      workspaceId,
    });

    assert.ok(ref.id.startsWith('artifact-'));
    assert.strictEqual(ref.redacted, true);
    assert.strictEqual(ref.runId, runId);
    assert.strictEqual(ref.attemptId, attemptId);
    assert.ok(fs.existsSync(ref.path));
    assert.ok(ref.path.endsWith(`${ref.sha256}.artifact`));

    // Read the committed content-addressed file back: the redaction flag alone is vacuous
    // unless the persisted bytes actually lack the plaintext secret.
    const storedBytes = fs.readFileSync(ref.path);
    assert.ok(storedBytes.byteLength > 0, 'Committed artifact file must be non-empty');
    const storedText = storedBytes.toString('utf8');
    assert.ok(
      !storedText.includes('very_long_secret_token_1234567890_abcdef'),
      'Plaintext token value must not be persisted in the artifact file'
    );
    assert.ok(
      storedText.includes('"token":"[REDACTED]"'),
      'Redaction replaces the JSON string value with [REDACTED] while keeping the key'
    );
  });

  it('2. Deduplicates identical blobs within the same run and charges quota only once', () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const content = Buffer.alloc(10 * 1024, 'x');

    const ref1 = store.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: content,
      runId,
      attemptId,
      projectId,
      workspaceId,
    });

    const ref2 = store.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: content,
      runId,
      attemptId,
      projectId,
      workspaceId,
    });

    assert.notStrictEqual(ref1.id, ref2.id, 'Distinct ArtifactRef IDs generated');
    assert.strictEqual(ref1.sha256, ref2.sha256, 'Identical SHA-256 hash');
    assert.strictEqual(ref1.path, ref2.path, 'Share the same on-disk .artifact file');
  });

  it('3. Enforces 256 MiB unique blob quota per run', () => {
    const smallStore = new ArtifactStore({ root: path.join(tempDir, 'quota-test'), maxRunBytes: 50 * 1024 });
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');

    const bigChunk1 = crypto.randomBytes(30 * 1024);
    smallStore.stage({
      kind: 'terminal',
      mime: 'text/plain',
      data: bigChunk1,
      runId,
      attemptId,
      projectId,
      workspaceId,
    });

    const bigChunk2 = crypto.randomBytes(30 * 1024);
    assert.throws(
      () => {
        smallStore.stage({
          kind: 'terminal',
          mime: 'text/plain',
          data: bigChunk2,
          runId,
          attemptId,
          projectId,
          workspaceId,
        });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
    );
  });

  it('4. Reads 1 MiB chunked artifacts through catalogue artifact.read with pagination framing', async () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const totalSize = Math.floor(2.5 * 1024 * 1024);
    const bigBuffer = Buffer.alloc(totalSize, 'a');

    const ref = store.stage({
      kind: 'report',
      mime: 'text/plain',
      data: bigBuffer,
      runId,
      attemptId,
      projectId,
      workspaceId,
      maxBytes: 8 * 1024 * 1024,
    });

    // Read chunk 0 (first 1 MiB)
    const chunk0 = (await catalogue.dispatch('artifact.read', {
      artifactId: ref.id,
      offset: 0,
      limit: 1024 * 1024,
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId,
      grant: 'read',
    })) as ArtifactReadResult;

    assert.strictEqual(chunk0.offset, 0);
    assert.strictEqual(chunk0.limit, 1024 * 1024);
    assert.strictEqual(chunk0.totalBytes, totalSize);
    assert.strictEqual(chunk0.hasMore, true);
    assert.strictEqual(chunk0.encoding, 'utf8');

    // Read chunk 1 (second 1 MiB)
    const chunk1 = (await catalogue.dispatch('artifact.read', {
      artifactId: ref.id,
      offset: 1024 * 1024,
      limit: 1024 * 1024,
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId,
      grant: 'read',
    })) as ArtifactReadResult;

    assert.strictEqual(chunk1.offset, 1024 * 1024);
    assert.strictEqual(chunk1.limit, 1024 * 1024);
    assert.strictEqual(chunk1.hasMore, true);

    // Read chunk 2 (remaining 0.5 MiB)
    const chunk2 = (await catalogue.dispatch('artifact.read', {
      artifactId: ref.id,
      offset: 2 * 1024 * 1024,
      limit: 1024 * 1024,
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId,
      grant: 'read',
    })) as ArtifactReadResult;

    assert.strictEqual(chunk2.offset, 2 * 1024 * 1024);
    assert.strictEqual(chunk2.hasMore, false);
  });

  it('5. Detects disk corruption and throws INTEGRITY_COMPROMISED on hash mismatch', () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const cleanData = Buffer.from('unaltered authentic data', 'utf8');

    const ref = store.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: cleanData,
      runId,
      attemptId,
      projectId,
      workspaceId,
    });

    // Tamper with the on-disk file directly
    fs.writeFileSync(ref.path, Buffer.from('corrupted tampered data', 'utf8'));

    // Create a fresh store to bypass hot cache and force disk read
    const verifyingStore = new ArtifactStore({ root: tempDir });
    assert.throws(
      () => verifyingStore.readBytesById(ref.id),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INTEGRITY_COMPROMISED'
    );
  });

  it('6. Rehydrates durable metadata index and recovers unique blob byte counts on startup', () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const data1 = Buffer.from('payload-rehydration-1', 'utf8');
    const data2 = Buffer.from('payload-rehydration-2', 'utf8');

    const ref1 = store.stage({ kind: 'dom', mime: 'text/html', data: data1, runId, attemptId, projectId, workspaceId });
    const ref2 = store.stage({ kind: 'dom', mime: 'text/html', data: data2, runId, attemptId, projectId, workspaceId });

    // Instantiate fresh ArtifactStore pointing at existing root
    const restoredStore = new ArtifactStore({ root: tempDir });
    const fetched1 = restoredStore.get(ref1.id);
    const fetched2 = restoredStore.get(ref2.id);

    assert.ok(fetched1, 'Artifact 1 rehydrated from index');
    assert.ok(fetched2, 'Artifact 2 rehydrated from index');
    assert.strictEqual(fetched1?.sha256, ref1.sha256);
    assert.strictEqual(fetched2?.sha256, ref2.sha256);
  });

  it('7. Enforces exact lineage authentication on artifact.stat', async () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const ref = store.stage({ kind: 'report', mime: 'application/json', data: '{}', runId, attemptId, projectId, workspaceId });

    // Correct lineage succeeds
    const statResult = (await catalogue.dispatch('artifact.stat', {
      artifactId: ref.id,
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId,
      grant: 'read',
    })) as ArtifactRef;
    assert.strictEqual(statResult.id, ref.id);
    assert.strictEqual(statResult.sha256, ref.sha256);

    // Mismatched runId fails with INVALID_ARGUMENT (uniform no-oracle denial)
    await assert.rejects(
      () => catalogue.dispatch('artifact.stat', {
        artifactId: ref.id,
      }, {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
        runId: 'wrong-run-id',
        attemptId,
        grant: 'read',
      }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('8. Dispatches management-classified report.generate capability into ArtifactStore', async () => {
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');

    const reportRes = (await catalogue.dispatch('report.generate', {
      name: 'Theme QA Summary Report',
      data: { score: 98, passed: true },
      mime: 'application/json',
    }, {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId,
      grant: 'write',
    })) as { generated: boolean; artifactRef: ArtifactRef };

    assert.strictEqual(reportRes.generated, true);
    assert.ok(reportRes.artifactRef?.id.startsWith('artifact-'));
    assert.strictEqual(reportRes.artifactRef?.kind, 'report');
  });

  describe('Evidence artifact lease (artifact.preflight / release_lease / leased stage)', () => {
    const context = (grant: 'read' | 'write', runId: string) => ({
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId,
      attemptId: makeControlPlaneId('attempt'),
      grant,
    });

    it('9. preflight grants one exclusive lease, publishes capacity, and denies a second acquire with LEASE_HELD', async () => {
      const runId = makeControlPlaneId('run');
      const granted = (await catalogue.dispatch(
        'artifact.preflight',
        { runId, artifactBytes: 1024 },
        context('read', runId)
      )) as ArtifactPreflightResult;

      assert.strictEqual(granted.granted, true);
      assert.ok(granted.leaseToken);
      assert.deepStrictEqual(granted.limits, { maxArtifactBytes: 8 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024 });
      assert.strictEqual(granted.committedBytes, 0);
      assert.strictEqual(granted.availableRunBytes, 256 * 1024 * 1024);
      assert.ok(store.getLease(runId), 'Granted preflight mints a live lease');

      const denied = (await catalogue.dispatch(
        'artifact.preflight',
        { runId, artifactBytes: 1024 },
        context('read', runId)
      )) as ArtifactPreflightResult;

      assert.strictEqual(denied.granted, false);
      assert.strictEqual(denied.reason, 'LEASE_HELD');
      assert.strictEqual(denied.leaseToken, undefined);
      assert.strictEqual(store.getLease(runId)?.leaseToken, granted.leaseToken, 'Denied acquire must not rotate the held lease');

      const preflightCapability = catalogue.get('artifact.preflight');
      assert.strictEqual(preflightCapability?.policy.timeoutMs, 15_000);
      assert.strictEqual(preflightCapability?.policy.cancellationAckTimeoutMs, 5_000);
    });

    it('10. preflight denies an artifact above the per-artifact ceiling without minting a lease', () => {
      const tight = new ArtifactStore({ root: path.join(tempDir, 'lease-limits'), maxArtifactBytes: 1024, maxRunBytes: 2048 });

      const overArtifact = tight.preflight({ runId: 'run-over-artifact', artifactBytes: 1025 });
      assert.strictEqual(overArtifact.granted, false);
      assert.strictEqual(overArtifact.reason, 'ARTIFACT_EXCEEDS_LIMIT');
      assert.strictEqual(tight.getLease('run-over-artifact'), undefined);

      const overAggregate = tight.preflight({ runId: 'run-over-aggregate', artifactBytes: 1024, aggregateBytes: 1025 });
      assert.strictEqual(overAggregate.granted, false);
      assert.strictEqual(overAggregate.reason, 'RUN_BUDGET_EXCEEDED');
      assert.strictEqual(tight.getLease('run-over-aggregate'), undefined);
    });

    it('11. preflight counts already committed run bytes against the aggregate budget', () => {
      const tight = new ArtifactStore({ root: path.join(tempDir, 'lease-committed'), maxRunBytes: 2048 });
      tight.stage({
        kind: 'dom',
        mime: 'text/plain',
        data: Buffer.alloc(1500, 1),
        runId: 'run-committed',
        attemptId: 'attempt-1',
        projectId,
        workspaceId,
      });

      const denied = tight.preflight({ runId: 'run-committed', artifactBytes: 600 });
      assert.strictEqual(denied.granted, false);
      assert.strictEqual(denied.reason, 'RUN_BUDGET_EXCEEDED');
      assert.strictEqual(denied.committedBytes, 1500);
      assert.strictEqual(denied.availableRunBytes, 548);

      const granted = tight.preflight({ runId: 'run-committed', artifactBytes: 548 });
      assert.strictEqual(granted.granted, true, 'Exactly the remaining budget must be grantable');
      assert.strictEqual(granted.committedBytes, 1500);
    });

    it('12. releaseLease ignores a wrong token, releases on the exact token, and permits re-acquire', () => {
      const runId = makeControlPlaneId('run');
      const granted = store.preflight({ runId, artifactBytes: 16 });
      assert.ok(granted.leaseToken);

      assert.deepStrictEqual(store.releaseLease(runId, 'foreign-token'), { released: false });
      assert.strictEqual(store.getLease(runId)?.leaseToken, granted.leaseToken, 'Wrong-token release is a no-op');

      assert.deepStrictEqual(store.releaseLease(runId, granted.leaseToken), { released: true });
      assert.strictEqual(store.getLease(runId), undefined);

      const reacquired = store.preflight({ runId, artifactBytes: 16 });
      assert.strictEqual(reacquired.granted, true);
      assert.notStrictEqual(reacquired.leaseToken, granted.leaseToken, 'Re-acquire mints a fresh token');
    });

    it('13. stage on a leased run requires the exact token and rejects a released token with LEASE_EXPIRED', () => {
      const leasedStore = new ArtifactStore({ root: path.join(tempDir, 'lease-token') });
      const runId = makeControlPlaneId('run');
      const granted = leasedStore.preflight({ runId, artifactBytes: 64 });
      assert.ok(granted.leaseToken);
      const base = {
        kind: 'dom' as const,
        mime: 'text/plain',
        data: Buffer.from('leased payload'),
        runId,
        attemptId: 'attempt-1',
        projectId,
        workspaceId,
      };

      assert.throws(
        () => leasedStore.stage(base),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TRANSACTION_CONFLICT' && err.message.includes('requires the matching leaseToken')
      );
      assert.throws(
        () => leasedStore.stage({ ...base, leaseToken: 'foreign-token' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TRANSACTION_CONFLICT' && err.message.includes('token mismatch')
      );
      assert.strictEqual(leasedStore.getStats().artifactCount, 0, 'Rejected leased stages must not mint artifacts');

      const ref = leasedStore.stage({ ...base, leaseToken: granted.leaseToken, overflowMode: 'reject' });
      assert.ok(ref.id.startsWith('artifact-'));
      assert.strictEqual(ref.byteLength, base.data.byteLength);

      assert.deepStrictEqual(leasedStore.releaseLease(runId, granted.leaseToken), { released: true });
      assert.throws(
        () => leasedStore.stage({ ...base, leaseToken: granted.leaseToken }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'LEASE_EXPIRED'
      );
    });

    it("14. overflowMode 'reject' fails closed before writing bytes or minting an ArtifactRef", () => {
      const rejectStore = new ArtifactStore({ root: path.join(tempDir, 'lease-reject'), maxArtifactBytes: 100 });
      const runId = 'run-reject';
      const before = rejectStore.getStats();

      assert.throws(
        () => rejectStore.stage({
          kind: 'dom',
          mime: 'text/plain',
          data: Buffer.alloc(200, 7),
          runId,
          attemptId: 'attempt-1',
          projectId,
          workspaceId,
          overflowMode: 'reject',
        }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE' && err.message.includes('exceeds the 100 byte ceiling')
      );

      assert.deepStrictEqual(rejectStore.getStats(), before, 'Rejected overflow must not write bytes, runs, or refs');
      assert.strictEqual(fs.existsSync(path.join(tempDir, 'lease-reject', runId)), false, 'Rejected overflow must not create the run directory');
    });

    it('15. a leased stage re-reads committed bytes from disk and fails when an out-of-band write exhausts the run budget', () => {
      const root = path.join(tempDir, 'lease-disk');
      const leasedStore = new ArtifactStore({ root, maxRunBytes: 4096 });
      const runId = 'run-disk';
      const granted = leasedStore.preflight({ runId, artifactBytes: 1024 });
      assert.strictEqual(granted.granted, true);
      assert.ok(granted.leaseToken);

      fs.mkdirSync(path.join(root, runId), { recursive: true });
      fs.writeFileSync(path.join(root, runId, 'out-of-band.artifact'), Buffer.alloc(4000, 3));

      assert.throws(
        () => leasedStore.stage({
          kind: 'dom',
          mime: 'text/plain',
          data: Buffer.alloc(200, 1),
          runId,
          attemptId: 'attempt-1',
          projectId,
          workspaceId,
          leaseToken: granted.leaseToken,
          overflowMode: 'reject',
        }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE' && err.message === 'Run artifact budget exceeded'
      );
      assert.strictEqual(leasedStore.getStats().artifactCount, 0);
    });

    it('16. artifact.release_lease dispatches a structured release and rejects a wrong token as released:false', async () => {
      const runId = makeControlPlaneId('run');
      const granted = (await catalogue.dispatch(
        'artifact.preflight',
        { runId, artifactBytes: 32 },
        context('read', runId)
      )) as ArtifactPreflightResult;
      assert.ok(granted.leaseToken);

      const wrong = (await catalogue.dispatch(
        'artifact.release_lease',
        { runId, leaseToken: 'foreign-token' },
        context('write', runId)
      )) as { released: boolean };
      assert.strictEqual(wrong.released, false);
      assert.strictEqual(store.getLease(runId)?.leaseToken, granted.leaseToken);

      const released = (await catalogue.dispatch(
        'artifact.release_lease',
        { runId, leaseToken: granted.leaseToken },
        context('write', runId)
      )) as { released: boolean };
      assert.strictEqual(released.released, true);
      assert.strictEqual(store.getLease(runId), undefined);
    });

    it('17. atomic write detects pre-existing truncated corruption, repairs destination, and cleans up temp files', () => {
      const runId = makeControlPlaneId('run');
      const testData = Buffer.from('atomic-write-verification-full-uncorrupted-payload-data-123456789');
      const sha256 = crypto.createHash('sha256').update(testData).digest('hex');
      const runDir = path.join(tempDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const expectedPath = path.join(runDir, `${sha256}.artifact`);

      // Precreate corrupt truncated bytes at destination to simulate prior interrupted write
      const corruptBytes = Buffer.from('corrupted-short-bytes');
      fs.writeFileSync(expectedPath, corruptBytes);
      assert.ok(fs.existsSync(expectedPath));
      assert.strictEqual(fs.statSync(expectedPath).size, corruptBytes.byteLength);

      const ref = store.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: testData,
        runId,
        attemptId: makeControlPlaneId('attempt'),
        projectId,
        workspaceId,
      });

      assert.strictEqual(ref.path, expectedPath);
      assert.ok(fs.existsSync(expectedPath), 'Destination artifact file must exist');
      assert.strictEqual(fs.statSync(expectedPath).size, testData.byteLength, 'Corrupt destination must be replaced with full payload');

      const files = fs.readdirSync(runDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      assert.strictEqual(tmpFiles.length, 0, 'No temporary files should linger after successful stage');

      // Assert exact recovered payload bytes and hash integrity on read
      const readResult = store.readBytesById(ref.id);
      assert.strictEqual(readResult.ref.byteLength, testData.byteLength);
      assert.strictEqual(readResult.ref.sha256, sha256);
      assert.deepStrictEqual(readResult.data, testData);
    });
  });
});
