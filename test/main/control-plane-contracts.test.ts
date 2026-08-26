import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertExactBrowserTarget, assertNoReparseTraversal, assertRuntimeLease, assertWorkspaceContained, CapabilityError, issueRuntimeLease, makeControlPlaneId, validateLaunchPath } from '../../src/shared/control-plane-contracts';
describe('Control-plane contracts', () => {
  it('requires explicit ownership and rejects stale or cross-project leases', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 7);
    assert.doesNotThrow(() => assertRuntimeLease(lease, { projectId, workspaceId, hostEpoch: 7, token: lease.token }));
    assert.throws(() => assertRuntimeLease(lease, { projectId: makeControlPlaneId('project') }), (error: unknown) => error instanceof CapabilityError && error.code === 'PROJECT_MISMATCH');
    assert.throws(() => assertExactBrowserTarget(undefined, { projectId, workspaceId, runtimeId: lease.runtimeId }), (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED');
  });

  it('canonicalizes and contains workspace paths without traversal', () => {
    const root = path.resolve('test-fixture-workspace');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '// test');
    try {
      assert.doesNotThrow(() => assertWorkspaceContained(root, path.join(root, 'src', 'index.ts')));
      assert.throws(() => assertWorkspaceContained(root, path.resolve(root, '..', 'outside.txt')), (error: unknown) => error instanceof CapabilityError && error.code === 'OUTSIDE_WORKSPACE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates launch path and rejects non-existent or outside paths', () => {
    const root = path.resolve('test-fixture-launch');
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    try {
      const valid = validateLaunchPath(root, sub);
      assert.strictEqual(valid.canonicalLaunchCwd, assertWorkspaceContained(root, sub, true));

      assert.throws(() => validateLaunchPath(root, path.resolve(root, '..')), (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE');
      assert.throws(() => validateLaunchPath(root, path.join(root, 'non-existent')), (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE');

      // If OS supports symlink/junction creation without elevated privilege
      try {
        const link = path.join(root, 'symlink-dir');
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(sub, link, type);
        try {
          assert.throws(() => assertNoReparseTraversal(root, path.join(link, 'file.txt')), (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE');
        } finally {
          try { fs.unlinkSync(link); } catch {}
        }
      } catch (linkErr: any) {
        // If host cannot create symlinks/junctions due to privileges or FS unsupported type, skip gracefully
        if (linkErr.code !== 'EPERM' && linkErr.code !== 'EACCES' && linkErr.code !== 'ENOSYS' && linkErr.code !== 'EINVAL') {
          throw linkErr;
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces assertExactBrowserTarget tab presence by default and validates opt-in allowMissingTab semantics', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeId = makeControlPlaneId('binding');

    const expected = { projectId, workspaceId, runtimeId, browserEpoch: 2, documentGeneration: 3 };

    const validFullTarget = {
      projectId,
      workspaceId,
      runtimeId,
      tabId: 'tab-123',
      browserEpoch: 2,
      documentGeneration: 3,
    };

    const validTablessTarget = {
      projectId,
      workspaceId,
      runtimeId,
      tabId: undefined as any,
      browserEpoch: 2,
      documentGeneration: 3,
    };

    // Default mode: requires tabId
    assert.strictEqual(assertExactBrowserTarget(validFullTarget, expected), validFullTarget);
    assert.throws(() => assertExactBrowserTarget(validTablessTarget, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED');
    assert.throws(() => assertExactBrowserTarget(undefined, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED');
    assert.throws(() => assertExactBrowserTarget({} as any, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH');

    // Mismatched project / workspace / runtime
    assert.throws(() => assertExactBrowserTarget({ ...validFullTarget, projectId: 'proj-other' }, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH');
    assert.throws(() => assertExactBrowserTarget({ ...validFullTarget, workspaceId: 'ws-other' }, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH');
    assert.throws(() => assertExactBrowserTarget({ ...validFullTarget, runtimeId: 'rt-other' }, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH');

    // Stale epoch / generation
    assert.throws(() => assertExactBrowserTarget({ ...validFullTarget, browserEpoch: 1 }, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');
    assert.throws(() => assertExactBrowserTarget({ ...validFullTarget, documentGeneration: 2 }, expected), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');

    // Opt-in allowMissingTab mode: permits missing tabId if ownership and epoch/generation match
    assert.strictEqual(assertExactBrowserTarget(validTablessTarget, expected, true), validTablessTarget);
    assert.throws(() => assertExactBrowserTarget(undefined, expected, true), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED');
    assert.throws(() => assertExactBrowserTarget({ ...validTablessTarget, projectId: 'proj-other' }, expected, true), (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH');
    assert.throws(() => assertExactBrowserTarget({ ...validTablessTarget, browserEpoch: 1 }, expected, true), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');
    assert.throws(() => assertExactBrowserTarget({ ...validTablessTarget, documentGeneration: 2 }, expected, true), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');
  });
});
