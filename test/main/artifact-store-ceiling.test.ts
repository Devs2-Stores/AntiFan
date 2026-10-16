import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore, DEFAULT_MAX_ARTIFACT_BYTES, FULL_PAGE_ARTIFACT_MAX_BYTES } from '../../src/main/tools/artifact-store';
import { CapabilityError, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('ArtifactStore per-call byte ceiling', () => {
  let root: string;
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-artifact-ceiling-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = (runId: string) => ({
    kind: 'screenshot' as const,
    mime: 'image/png',
    runId,
    attemptId: 'attempt-1',
    projectId,
    workspaceId,
  });

  it('exports a full-page ceiling above the default per-artifact size', () => {
    assert.equal(FULL_PAGE_ARTIFACT_MAX_BYTES, 64 * 1024 * 1024);
    assert.ok(FULL_PAGE_ARTIFACT_MAX_BYTES > DEFAULT_MAX_ARTIFACT_BYTES);
  });

  it('lets an explicit maxBytes raise the ceiling above the store default instead of rejecting the payload', () => {
    const store = new ArtifactStore({ root: path.join(root, 'raise'), maxArtifactBytes: 1024, maxRunBytes: 1024 * 1024 });
    const payload = Buffer.alloc(4096, 7);

    assert.throws(
      () => store.stage({ ...base('run-default'), data: payload, overflowMode: 'reject' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
    );
    const ref = store.stage({ ...base('run-raised'), data: payload, maxBytes: 8192, overflowMode: 'reject' });

    assert.equal(ref.byteLength, 4096);
    assert.equal(ref.truncated, false);
  });

  it('applies the same raised ceiling to the async stage', async () => {
    const store = new ArtifactStore({ root: path.join(root, 'raise-async'), maxArtifactBytes: 1024, maxRunBytes: 1024 * 1024 });

    const ref = await store.stageAsync({ ...base('run-async'), data: Buffer.alloc(4096, 1), maxBytes: 8192, overflowMode: 'reject' });

    assert.equal(ref.byteLength, 4096);
  });

  it('still lowers the ceiling below the default and truncates when asked to', () => {
    const store = new ArtifactStore({ root: path.join(root, 'lower'), maxArtifactBytes: 8192, maxRunBytes: 1024 * 1024 });

    const ref = store.stage({ ...base('run-lower'), data: Buffer.alloc(4096, 3), maxBytes: 1000 });

    assert.equal(ref.byteLength, 1000);
    assert.equal(ref.truncated, true);
  });

  it('never lets a per-call ceiling exceed the run budget', () => {
    const store = new ArtifactStore({ root: path.join(root, 'run-bound'), maxArtifactBytes: 1024, maxRunBytes: 2048 });

    assert.throws(
      () => store.stage({ ...base('run-bound'), data: Buffer.alloc(4096, 5), maxBytes: 64 * 1024 * 1024, overflowMode: 'reject' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE' && /2048 byte ceiling/.test(err.message)
    );
  });
});
