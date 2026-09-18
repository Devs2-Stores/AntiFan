/**
 * Session quota release wiring: the attachment registry is the single funnel
 * for tab rebinding and session end, so it is the surface that frees the tab
 * slots a session holds. A rebind to a different tab releases exactly the old
 * bound id; a same-tab rotation releases nothing; revocation and expiry free
 * the whole pool. Release calls are bookkeeping only — they never change the
 * outcome of the mutation that fired them.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import {
  CapabilityError,
  ExecutionAttachmentRecord,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';
const TAB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface ReleaseCalls {
  tabs: Array<{ sessionId: string; tabId: string }>;
  pools: string[];
}

function makeRegistry(calls: ReleaseCalls): AttachmentRegistry {
  return new AttachmentRegistry({
    releaseSessionTab: (sessionId, tabId) => {
      calls.tabs.push({ sessionId, tabId });
      return true;
    },
    releaseSessionTabPool: (sessionId) => {
      calls.pools.push(sessionId);
      return true;
    },
  });
}

async function mint(
  registry: AttachmentRegistry,
  options?: { tabId?: string; ttlMs?: number }
): Promise<ExecutionAttachmentRecord> {
  const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
  const { record } = await registry.issueAttachment(
    makeControlPlaneId('run'),
    makeControlPlaneId('attempt'),
    PROJECT_ID,
    WORKSPACE_ID,
    {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: options?.tabId,
      grant: 'write',
      documentGeneration: 1,
      ttlMs: options?.ttlMs,
    }
  );
  return record;
}

describe('attachment session quota release', () => {
  test('a rebind to a different tab releases exactly the old bound id', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const record = await mint(registry, { tabId: TAB_A });

    const next = await registry.updateAttachmentTab(record.id, TAB_B, 2);
    assert.ok(next, 'rotation succeeds');

    assert.deepStrictEqual(
      calls.tabs,
      [{ sessionId: TAB_A, tabId: TAB_A }],
      'the old bound tab id is the only slot released'
    );
    assert.deepStrictEqual(calls.pools, [], 'a rebind never frees the whole pool');
  });

  test('a same-tab rotation releases nothing', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const record = await mint(registry, { tabId: TAB_A });

    const next = await registry.updateAttachmentTab(record.id, TAB_A, 2);
    assert.ok(next, 'rotation succeeds');

    assert.deepStrictEqual(calls.tabs, [], 'no slot is released when the binding does not move');
    assert.deepStrictEqual(calls.pools, []);
  });

  test('an attachment that never held a tab releases nothing on first bind', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const record = await mint(registry);

    const next = await registry.updateAttachmentTab(record.id, TAB_A, 2);
    assert.ok(next, 'rotation succeeds');

    assert.deepStrictEqual(
      calls.tabs,
      [],
      'no id is released for a session the host never adopted'
    );
  });

  test('revoking an attachment frees its session pool', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const record = await mint(registry, { tabId: TAB_A });

    await registry.revokeAttachment(record.id);

    assert.deepStrictEqual(calls.pools, [TAB_A], 'revocation frees the bound tab pool');
  });

  test('revoking every attachment of an attempt frees each pool', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    const attemptId = makeControlPlaneId('attempt');
    const issue = (tabId: string) =>
      registry.issueAttachment(makeControlPlaneId('run'), attemptId, PROJECT_ID, WORKSPACE_ID, {
        backendId: 'test-backend',
        lease,
        leaseToken: lease.token,
        hostEpoch: 1,
        tabId,
        grant: 'write',
        documentGeneration: 1,
      });
    await issue(TAB_A);
    await issue(TAB_B);

    await registry.revokeForAttempt(attemptId);

    assert.deepStrictEqual(
      calls.pools.sort(),
      [TAB_A, TAB_B].sort(),
      'every revoked attachment frees its own pool'
    );
  });

  test('the expiry transition frees the session pool', async () => {
    const calls: ReleaseCalls = { tabs: [], pools: [] };
    const registry = makeRegistry(calls);
    const record = await mint(registry, { tabId: TAB_A, ttlMs: -1 });

    assert.throws(
      () => registry.validateLiveExecution(record, record.authorityRevision),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ATTACHMENT_STALE'
    );

    assert.deepStrictEqual(calls.pools, [TAB_A], 'expiry frees the bound tab pool');
  });
});
