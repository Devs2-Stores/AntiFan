/**
 * An attachment's authority is scoped to the runtime that minted it.
 *
 * Measured live on 2026-09-18: `attachments-v1.jsonl` held 2,585 frames, 2,562 of
 * them `state: 'active'`, and 2,444 carrying a runtimeId from a process that no
 * longer existed. Those 2,444 could never dispatch again — the catalogue refuses
 * a foreign runtimeId with RUNTIME_MISMATCH (`capability-catalogue.ts:380`) — yet
 * `initialize()` restored them as active and `renewAttachment()` slid their expiry
 * forward without ever checking runtime identity, so the owning client's repair
 * path never fired and the attachment was renewable forever.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('Attachment runtime scoping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runtime-scope-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function mint(registry: AttachmentRegistry, backendId: string, ttlMs = 3_600_000) {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, ttlMs, 1);
    const { launch } = await registry.issueAttachment(
      makeControlPlaneId('run'),
      makeControlPlaneId('attempt'),
      projectId,
      workspaceId,
      { backendId, lease, leaseToken: lease.token, ttlMs }
    );
    return { launch, lease, projectId, workspaceId };
  }

  it('drops records bound to a previous runtime and keeps the current one', async () => {
    const minting = new AttachmentRegistry(undefined, tmpDir);
    await minting.initialize();
    const { launch, lease } = await mint(minting, 'cli');

    const sameRuntime = new AttachmentRegistry(undefined, tmpDir);
    await sameRuntime.initialize(lease.runtimeId);
    assert.ok(
      sameRuntime.getAttachment(launch.attachmentId),
      'a record minted by the replaying runtime survives the restart'
    );

    const otherRuntime = issueRuntimeLease(lease.projectId, lease.workspaceId, 3_600_000, 1);
    assert.notStrictEqual(otherRuntime.runtimeId, lease.runtimeId);
    const replaying = new AttachmentRegistry(undefined, tmpDir);
    await replaying.initialize(otherRuntime.runtimeId);

    assert.strictEqual(
      replaying.getAttachment(launch.attachmentId),
      undefined,
      'a record bound to a foreign runtime is not restored'
    );
    assert.strictEqual(
      replaying.verifyAttachmentSecret(launch.attachmentId, launch.secret),
      false,
      'the dropped record can no longer authenticate, so the client re-pairs'
    );
  });

  it('keeps every record when replay is called without a runtime id', async () => {
    const minting = new AttachmentRegistry(undefined, tmpDir);
    await minting.initialize();
    const { launch } = await mint(minting, 'cli');

    const legacy = new AttachmentRegistry(undefined, tmpDir);
    await legacy.initialize();
    assert.ok(
      legacy.getAttachment(launch.attachmentId),
      'a caller that passes no runtime id keeps the previous replay semantics'
    );
  });

  it('renews a pair-minted attachment whose attempt the registry does not track', async () => {
    // The bridge mints pairing attachments with a run/attempt pair RunService never
    // registers, so the lineage delegate answers `undefined` for them — the same
    // answer the attempt-state check above it already treats as "not tracked".
    const registry = new AttachmentRegistry(
      { getAttemptState: () => undefined, getBackendId: () => undefined },
      tmpDir
    );
    await registry.initialize();
    const { launch } = await mint(registry, 'mcp');
    const before = registry.getAttachment(launch.attachmentId)!.expiresAt;

    const renewed = await registry.renewAttachment(launch.attachmentId, launch.secret, {
      extensionMs: 7_200_000,
    });
    assert.ok(
      renewed.expiresAt > before,
      'renewSession is the client liveness proof; it must succeed for a live attachment'
    );
  });

  it('still refuses renewal when the backend really changed', async () => {
    const registry = new AttachmentRegistry({ getBackendId: () => 'other-backend' }, tmpDir);
    await registry.initialize();
    const { launch } = await mint(registry, 'mcp');

    await assert.rejects(
      async () => registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 60_000 }),
      (err: unknown) => (err as { code?: string }).code === 'LINEAGE_MISMATCH',
      'a reported backend mismatch is still a lineage violation'
    );
  });
});
