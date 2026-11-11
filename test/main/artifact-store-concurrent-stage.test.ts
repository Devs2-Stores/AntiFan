import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore, type ArtifactStageInput } from '../../src/main/tools/artifact-store';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('ArtifactStore.stageAsync under concurrency within one run', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-artifact-concurrent-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const PAYLOAD = 64 * 1024;
  const input = (runId: string, fill: number): ArtifactStageInput => ({
    kind: 'screenshot',
    mime: 'image/png',
    data: Buffer.alloc(PAYLOAD, fill),
    runId,
    attemptId: 'attempt-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  });

  it('counts every concurrent write against the run budget', async () => {
    const storeRoot = path.join(root, 'budget');
    const count = 6;
    const store = new ArtifactStore({ root: storeRoot, maxArtifactBytes: PAYLOAD, maxRunBytes: PAYLOAD * count });
    await Promise.all(Array.from({ length: count }, (_, i) => store.stageAsync(input('run-budget', i + 1))));

    // The run is now exactly full: one more distinct payload must be refused.
    await assert.rejects(
      () => store.stageAsync(input('run-budget', 200)),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE',
    );
  });

  it('persists an index that lists every concurrently staged artifact', async () => {
    const storeRoot = path.join(root, 'index');
    const count = 8;
    const store = new ArtifactStore({ root: storeRoot, maxArtifactBytes: PAYLOAD, maxRunBytes: PAYLOAD * 64 });
    const refs = await Promise.all(Array.from({ length: count }, (_, i) => store.stageAsync(input('run-index', i + 1))));

    const reopened = new ArtifactStore({ root: storeRoot, maxArtifactBytes: PAYLOAD, maxRunBytes: PAYLOAD * 64 });
    for (const ref of refs) {
      assert.ok(reopened.get(ref.id), `artifact ${ref.id} survives a restart`);
    }
  });

  it('keeps the file when the same bytes are staged twice at once', async () => {
    const storeRoot = path.join(root, 'same');
    const store = new ArtifactStore({ root: storeRoot, maxArtifactBytes: PAYLOAD, maxRunBytes: PAYLOAD * 8 });
    const [a, b] = await Promise.all([store.stageAsync(input('run-same', 9)), store.stageAsync(input('run-same', 9))]);
    assert.equal(a.path, b.path);
    assert.equal(fs.statSync(a.path).size, PAYLOAD);
    assert.equal(store.readBytesById(b.id).data.byteLength, PAYLOAD);
  });

  it('a refused stage does not block the next stage of the same run', async () => {
    const storeRoot = path.join(root, 'refused');
    const store = new ArtifactStore({ root: storeRoot, maxArtifactBytes: PAYLOAD, maxRunBytes: PAYLOAD * 8 });
    const refused = store.stageAsync({ ...input('run-refused', 1), overflowMode: 'reject', maxBytes: 16 });
    const next = store.stageAsync(input('run-refused', 2));
    await assert.rejects(refused, CapabilityError);
    assert.equal((await next).byteLength, PAYLOAD);
  });
});
