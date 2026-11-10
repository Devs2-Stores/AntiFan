import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue, type CapabilityCatalogueOptions } from '../../src/main/tools/capability-catalogue';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

const BOUND = 'tab-agent-bound';
const FOREIGN = 'tab-user-youtube';

async function refuse(
  listUsableTabs?: CapabilityCatalogueOptions['listUsableTabs'],
  gone?: { closedBy: 'user'; closeReason: string } | 'unrecorded',
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-retarget-refusal-'));
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  const asked: string[] = [];
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    resolveTabId: (id) => (gone && id === FOREIGN ? undefined : id),
    ...(gone && gone !== 'unrecorded' ? { describeClosedTab: (id: string) => (id === FOREIGN ? { closedBy: gone.closedBy, closeReason: gone.closeReason, closedAt: 1 } : undefined) } : {}),
    resolveFailoverTabId: () => undefined,
    getDocumentGeneration: () => 1,
    isTabAllowed: (primary, requested) => primary === requested,
    ...(listUsableTabs ? { listUsableTabs: (bound: string) => { asked.push(bound); return listUsableTabs(bound); } } : {}),
  });
  catalogue.register({
    name: 'browser.set-automation-target',
    description: 'Retargets automation',
    risk: 'write',
    requiresBrowserTarget: false,
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    policy: {
      effect: 'write', risk: 'write', requiresBrowserTarget: false, schedulerLane: 'unbounded', duplicateMode: 'in-process-join',
      recordedVisibility: 'public', receiptReadPermission: 'read', timeoutMs: 30_000, retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate', subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 100, policyVersion: 1,
    } as never,
    execute: async () => ({ success: true }),
  });
  const registry = new AttachmentRegistry(undefined, root);
  const ledger = new InvocationLedger({ dataRoot: root });
  await ledger.initialize();
  const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);
  const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
    backendId: 'test-backend', grant: 'write', lease, leaseToken: lease.token, tabId: BOUND,
  });
  const resp = await transport.dispatchIntent({
    requestId: makeControlPlaneId('request'),
    idempotencyKey: `test:${makeControlPlaneId('request')}`,
    attachmentId: launch.attachmentId,
    attachmentSecret: launch.secret,
    authorityRevision: launch.authorityRevision,
    name: 'browser.set-automation-target',
    params: { tabId: FOREIGN },
  });
  return { resp, asked };
}

describe('a retarget outside the session authority names the tabs the session may use', () => {
  it('lists them in the message and in details.usableTabs, asked for the bound tab', async () => {
    const { resp, asked } = await refuse(() => [
      { id: BOUND, url: 'https://shop.example/' },
      { id: 'tab-agent-2', url: 'https://shop.example/cart' },
    ]);
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
    assert.deepStrictEqual(asked, [BOUND]);
    assert.match(resp.error?.message ?? '', /Tabs this session may use: tab-agent-bound \(https:\/\/shop\.example\/\), tab-agent-2 \(https:\/\/shop\.example\/cart\)/);
    const details = resp.error?.details as Record<string, unknown>;
    assert.deepStrictEqual(details.usableTabs, [
      { id: BOUND, url: 'https://shop.example/' },
      { id: 'tab-agent-2', url: 'https://shop.example/cart' },
    ]);
    assert.strictEqual(details.boundTabId, BOUND);
  });

  it('says so when the session has no live tab, and still refuses', async () => {
    const { resp } = await refuse(() => []);
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
    assert.match(resp.error?.message ?? '', /no live tab it may use/);
    assert.deepStrictEqual((resp.error?.details as Record<string, unknown>).usableTabs, []);
  });

  it('keeps refusing, without a list, when the host cannot say which tabs are usable', async () => {
    const { resp } = await refuse(undefined);
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
    assert.ok(!('usableTabs' in ((resp.error?.details as Record<string, unknown>) ?? {})));
    assert.match(resp.error?.message ?? '', /outside this session's authority/);
  });

  it('does not let a failing listing turn the refusal into another error', async () => {
    const { resp } = await refuse(() => { throw new Error('host gone'); });
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
    assert.match(resp.error?.message ?? '', /outside this session's authority/);
  });

  it('says a closed tab is gone, with who closed it, instead of calling it foreign', async () => {
    const { resp } = await refuse(() => [{ id: BOUND, url: 'https://shop.example/' }], { closedBy: 'user', closeReason: 'user-close-other' });
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error?.code, 'TARGET_STALE');
    const details = resp.error?.details as Record<string, unknown>;
    assert.strictEqual(details.cause, 'tab-gone');
    assert.strictEqual(details.tabId, FOREIGN);
    assert.strictEqual(details.closedBy, 'user');
    assert.strictEqual(details.closeReason, 'user-close-other');
    assert.strictEqual(details.recovery, 'anti.browser.tabs.list');
    assert.match(resp.error?.message ?? '', /no longer exists/);
    assert.doesNotMatch(resp.error?.message ?? '', /another project, session or window/);
    assert.match(resp.error?.message ?? '', /Tabs this session may use: tab-agent-bound/);
  });

  it('still says gone when the host kept no record of the close, without inventing who closed it', async () => {
    const { resp } = await refuse(() => [{ id: BOUND, url: 'https://shop.example/' }], 'unrecorded');
    assert.strictEqual(resp.error?.code, 'TARGET_STALE');
    const details = resp.error?.details as Record<string, unknown>;
    assert.strictEqual(details.cause, 'tab-gone');
    assert.ok(!('closedBy' in details));
    assert.match(resp.error?.message ?? '', /no longer exists/);
  });
});
