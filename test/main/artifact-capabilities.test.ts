import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
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
});
