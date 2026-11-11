import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore, type ArtifactStageInput } from '../../src/main/tools/artifact-store';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('ArtifactStore stage and stageAsync share their input validation', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-artifact-parity-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = (runId: string): ArtifactStageInput => ({
    kind: 'screenshot',
    mime: 'image/png',
    data: Buffer.alloc(4096, 5),
    runId,
    attemptId: 'attempt-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  });

  const cases: Array<[string, (input: ArtifactStageInput) => ArtifactStageInput]> = [
    ['a bad attemptId', (input) => ({ ...input, attemptId: 'bad attempt/../id' })],
    ['an empty projectId', (input) => ({ ...input, projectId: '   ' })],
    ['an empty workspaceId', (input) => ({ ...input, workspaceId: '' })],
    ['a bad overflowMode', (input) => ({ ...input, overflowMode: 'explode' as unknown as 'reject' })],
    ['a payload above the ceiling in reject mode', (input) => ({ ...input, overflowMode: 'reject', maxBytes: 16 })],
  ];

  for (const [label, mutate] of cases) {
    it(`refuses ${label} with the same code and message on both paths`, async () => {
      const store = new ArtifactStore({ root: path.join(root, 'refuse'), maxArtifactBytes: 1024 * 1024, maxRunBytes: 1024 * 1024 });
      const input = mutate(base('run-refuse'));
      let syncError: unknown;
      let asyncError: unknown;
      try { store.stage(input); } catch (err) { syncError = err; }
      try { await store.stageAsync(input); } catch (err) { asyncError = err; }
      assert.ok(syncError instanceof CapabilityError, 'stage must throw a CapabilityError');
      assert.ok(asyncError instanceof CapabilityError, 'stageAsync must reject with a CapabilityError');
      assert.equal(asyncError.code, syncError.code);
      assert.equal(asyncError.message, syncError.message);
      assert.equal(store.getStats().artifactCount, 0);
    });
  }
});