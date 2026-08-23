import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { assertExactBrowserTarget, assertRuntimeLease, assertWorkspaceContained, CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

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
    assert.doesNotThrow(() => assertWorkspaceContained(root, path.join(root, 'src', 'index.ts')));
    assert.throws(() => assertWorkspaceContained(root, path.resolve(root, '..', 'outside.txt')), (error: unknown) => error instanceof CapabilityError && error.code === 'OUTSIDE_WORKSPACE');
  });
});
