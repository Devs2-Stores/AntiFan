import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AttachmentTabLedger } from '../../../src/main/tools/attachment-tab-ledger';
import { CapabilityCatalogue } from '../../../src/main/tools/capability-catalogue';
import { makeBrowserPolicy } from '../../../src/main/tools/browser-capabilities';
import {
  AuthenticatedCapabilityContext,
  CapabilityError,
  issueRuntimeLease,
} from '../../../src/shared/control-plane-contracts';

const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';
const RUNTIME_ID = 'runtime-00000000-0000-4000-8000-000000000001';
const BOUND_TAB = '11111111-1111-4111-8111-111111111111';
const CREATED_TAB = '22222222-2222-4222-8222-222222222222';
const FOREIGN_TAB = '33333333-3333-4333-8333-333333333333';
const CREATOR = 'attach-00000000-0000-4000-8000-00000000000a';
const SIBLING = 'attach-00000000-0000-4000-8000-00000000000b';

describe('AttachmentTabLedger', () => {
  test('records per attachment and answers ownership only for the creator', () => {
    const ledger = new AttachmentTabLedger();
    ledger.record(CREATOR, CREATED_TAB);
    assert.equal(ledger.owns(CREATOR, CREATED_TAB), true);
    assert.equal(ledger.owns(SIBLING, CREATED_TAB), false);
    assert.equal(ledger.owns(CREATOR, FOREIGN_TAB), false);
  });

  test('release revokes every tab of that attachment', () => {
    const ledger = new AttachmentTabLedger();
    ledger.record(CREATOR, CREATED_TAB);
    ledger.record(SIBLING, FOREIGN_TAB);
    ledger.release(CREATOR);
    assert.equal(ledger.owns(CREATOR, CREATED_TAB), false);
    assert.equal(ledger.owns(SIBLING, FOREIGN_TAB), true);
  });

  test('prune forgets tabs that are gone and attachments left with none', () => {
    const ledger = new AttachmentTabLedger();
    ledger.record(CREATOR, CREATED_TAB);
    ledger.record(CREATOR, FOREIGN_TAB);
    ledger.prune((tabId) => tabId === FOREIGN_TAB);
    assert.equal(ledger.owns(CREATOR, CREATED_TAB), false);
    assert.equal(ledger.owns(CREATOR, FOREIGN_TAB), true);
    ledger.prune(() => false);
    assert.equal(ledger.owns(CREATOR, FOREIGN_TAB), false);
  });

  test('retainAttachments drops attachments that are no longer live', () => {
    const ledger = new AttachmentTabLedger();
    ledger.record(CREATOR, CREATED_TAB);
    ledger.record(SIBLING, FOREIGN_TAB);
    ledger.retainAttachments(new Set([SIBLING]));
    assert.equal(ledger.owns(CREATOR, CREATED_TAB), false);
    assert.equal(ledger.owns(SIBLING, FOREIGN_TAB), true);
  });
});

describe('catalogue gate and the creator ledger', () => {
  function makeCatalogue(): { catalogue: CapabilityCatalogue; executedTabs: string[] } {
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runtimeId: RUNTIME_ID,
      hostEpoch: 1,
      // The session pool contains only the bound tab: the created tab fell out of it after a rebind.
      isTabAllowed: (primary, requested) => primary === requested,
      resolveTabId: (id) => (id === BOUND_TAB || id === CREATED_TAB || id === FOREIGN_TAB ? id : undefined),
      getDocumentGeneration: () => 1,
    });
    const executedTabs: string[] = [];
    catalogue.register({
      name: 'test.write',
      description: 'Effectful capability on a tab',
      risk: 'write',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true }),
      inputSchema: { type: 'object' },
      execute: async (_params, ctx) => {
        executedTabs.push(String(ctx.browserTarget?.tabId));
        return { ok: true };
      },
    });
    return { catalogue, executedTabs };
  }

  function contextFor(attachmentId: string): AuthenticatedCapabilityContext {
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    (lease as { runtimeId: string }).runtimeId = RUNTIME_ID;
    return {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runId: 'run-00000000-0000-4000-8000-000000000001',
      attemptId: 'att-00000000-0000-4000-8000-000000000001',
      hostEpoch: 1,
      lease,
      leaseToken: lease.token,
      attachmentId,
      backendId: 'backend-00000000-0000-4000-8000-000000000001',
      invocationId: 'inv-00000000-0000-4000-8000-000000000001',
      grant: 'write',
      browserTarget: {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        runtimeId: RUNTIME_ID,
        tabId: BOUND_TAB,
        browserEpoch: 1,
        documentGeneration: 1,
      },
    };
  }

  test('the creating attachment reaches a tab outside the pool after a rebind', async () => {
    const { catalogue, executedTabs } = makeCatalogue();
    catalogue.tabLedger.record(CREATOR, CREATED_TAB);
    await catalogue.dispatchAuthenticated('test.write', { tabId: CREATED_TAB }, contextFor(CREATOR));
    assert.deepEqual(executedTabs, [CREATED_TAB]);
  });

  test('a sibling attachment is still refused the same tab', async () => {
    const { catalogue, executedTabs } = makeCatalogue();
    catalogue.tabLedger.record(CREATOR, CREATED_TAB);
    await assert.rejects(
      () => catalogue.dispatchAuthenticated('test.write', { tabId: CREATED_TAB }, contextFor(SIBLING)),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
    assert.deepEqual(executedTabs, []);
  });

  test('a tab the attachment did not create stays refused', async () => {
    const { catalogue } = makeCatalogue();
    catalogue.tabLedger.record(CREATOR, CREATED_TAB);
    await assert.rejects(
      () => catalogue.dispatchAuthenticated('test.write', { tabId: FOREIGN_TAB }, contextFor(CREATOR)),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
  });

  test('release revokes the creator authority', async () => {
    const { catalogue } = makeCatalogue();
    catalogue.tabLedger.record(CREATOR, CREATED_TAB);
    catalogue.tabLedger.release(CREATOR);
    await assert.rejects(
      () => catalogue.dispatchAuthenticated('test.write', { tabId: CREATED_TAB }, contextFor(CREATOR)),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
  });
});
