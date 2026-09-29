import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import {
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

function basePolicy(overrides: Record<string, unknown> = {}) {
  return {
    effect: 'write',
    risk: 'write',
    requiresBrowserTarget: false,
    schedulerLane: 'unbounded',
    duplicateMode: 'in-process-join',
    recordedVisibility: 'public',
    receiptReadPermission: 'read',
    timeoutMs: 30_000,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: 'abort-immediate',
    subscriberDisconnectBehavior: 'abort-when-unobserved',
    cancellationAckTimeoutMs: 100,
    policyVersion: 1,
    ...overrides,
  } as never;
}

describe('target transition lifecycle error semantics', () => {
  it('navigate succeeds but rotation fails -> emits TARGET_TRANSITION_UNCOMMITTED with mutationCommitted details', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-nav-fail-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const intendedTab = 'tab-nav-destination-999';
    let navigateExecuted = false;

    catalogue.register({
      name: 'browser.navigate',
      description: 'Navigates to URL and reports destination tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async () => {
        navigateExecuted = true;
        return {
          target: {
            tabId: intendedTab,
            documentGeneration: 3,
          },
        };
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    // Force rotation failure (e.g. simulating CAS conflict or missing registry record)
    registry.updateAttachmentTab = async () => null;

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.navigate',
      params: { url: 'https://example.com' },
    });

    assert.strictEqual(navigateExecuted, true, 'Mutation must have executed');
    assert.strictEqual(resp.ok, false, 'Dispatch must not succeed when authority rotation fails');
    assert.strictEqual(resp.error?.code, 'TARGET_TRANSITION_UNCOMMITTED', 'Error code must be TARGET_TRANSITION_UNCOMMITTED');

    const details = resp.error?.details as Record<string, unknown> | undefined;
    assert.ok(details, 'Error details must be present');
    assert.strictEqual(details?.mutationCommitted, true, 'mutationCommitted must be true');
    assert.strictEqual(details?.intendedTabId, intendedTab, 'intendedTabId must match destination');
    assert.strictEqual(details?.attachmentId, launch.attachmentId, 'attachmentId must match');
    assert.strictEqual(details?.recoveryAction, 'browser.rebind-target', 'recoveryAction must suggest rebind');
  });

  it('reload succeeds but rotation fails -> emits TARGET_TRANSITION_UNCOMMITTED with mutationCommitted details', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-reload-fail-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const reloadedTab = 'tab-reload-destination-888';
    let reloadExecuted = false;

    catalogue.register({
      name: 'browser.reload',
      description: 'Reloads page and reports tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object' },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async () => {
        reloadExecuted = true;
        return {
          tabId: reloadedTab,
          documentGeneration: 5,
        };
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    // Force rotation failure
    registry.updateAttachmentTab = async () => null;

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.reload',
      params: {},
    });

    assert.strictEqual(reloadExecuted, true, 'Reload mutation must have executed');
    assert.strictEqual(resp.ok, false, 'Dispatch must fail when authority rotation fails');
    assert.strictEqual(resp.error?.code, 'TARGET_TRANSITION_UNCOMMITTED');

    const details = resp.error?.details as Record<string, unknown> | undefined;
    assert.ok(details, 'Error details must be present');
    assert.strictEqual(details?.mutationCommitted, true);
    assert.strictEqual(details?.intendedTabId, reloadedTab);
    assert.strictEqual(details?.attachmentId, launch.attachmentId);
  });

  it('rebind-target rotation failure -> emits ATTACHMENT_REBIND_FAILED with mutationCommitted=false', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-rebind-fail-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const rebindTab = 'tab-rebind-destination-777';

    catalogue.register({
      name: 'browser.rebind-target',
      description: 'Rebinds target tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async () => {
        return {
          target: {
            tabId: rebindTab,
            documentGeneration: 1,
          },
        };
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    // Force rotation failure
    registry.updateAttachmentTab = async () => null;

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.rebind-target',
      params: { tabId: rebindTab },
    });

    assert.strictEqual(resp.ok, false, 'Dispatch must fail when rebind authority rotation fails');
    assert.strictEqual(resp.error?.code, 'ATTACHMENT_REBIND_FAILED', 'Authority-only op must emit ATTACHMENT_REBIND_FAILED');

    const details = resp.error?.details as Record<string, unknown> | undefined;
    assert.ok(details, 'Error details must be present');
    assert.strictEqual(details?.mutationCommitted, false, 'mutationCommitted must be false for pure authority op');
    assert.strictEqual(details?.intendedTabId, rebindTab);
  });

  it('navigate succeeds and authority rotation succeeds -> clean completion with replacement revision', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-nav-success-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const destinationTab = 'tab-destination-success-123';

    catalogue.register({
      name: 'browser.navigate',
      description: 'Navigates and reports tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async () => ({
        target: {
          tabId: destinationTab,
          documentGeneration: 10,
        },
      }),
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.navigate',
      params: { url: 'https://example.com' },
    });
    assert.strictEqual(resp.ok, true, 'Navigate must succeed');
    assert.ok(resp.replacementAuthorityRevision, 'Replacement authority revision must be issued');
    assert.strictEqual(registry.getAttachment(launch.attachmentId)?.tabId, destinationTab, 'Attachment must be rotated to destination tab');
  });

  it('stale-bound retarget to an unrelated live user tab is refused before dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-hijack-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      // The session's bound tab is gone; only the unrelated user tab is live.
      resolveTabId: (id) => (id === 'tab-user-youtube' ? 'tab-user-youtube' : undefined),
      resolveFailoverTabId: () => undefined,
      getDocumentGeneration: () => 1,
      isTabAllowed: (primaryId, requestedId) => primaryId === requestedId,
    });

    let setTargetExecuted = false;
    catalogue.register({
      name: 'browser.set-automation-target',
      description: 'Retargets automation',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      policy: basePolicy({ effect: 'write' }),
      execute: async () => {
        setTargetExecuted = true;
        return { success: true, tabId: 'tab-user-youtube' };
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
      tabId: 'tab-agent-dead',
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.set-automation-target',
      params: { tabId: 'tab-user-youtube' },
    });

    assert.strictEqual(setTargetExecuted, false, 'Retarget must be refused before the handler runs');
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
  });

  it('stale-bound rebind to the session failover sibling succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-sibling-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      resolveTabId: (id) => (id === 'tab-agent-sibling' ? 'tab-agent-sibling' : undefined),
      resolveFailoverTabId: (stale) => (stale === 'tab-agent-dead' ? 'tab-agent-sibling' : undefined),
      getDocumentGeneration: () => 1,
      isTabAllowed: (primaryId, requestedId) => primaryId === requestedId,
    });

    let reboundTabId: string | undefined;
    catalogue.register({
      name: 'browser.rebind-target',
      description: 'Rebinds target tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async (params: { tabId?: string }) => {
        reboundTabId = params.tabId;
        return { success: true, tabId: params.tabId, documentGeneration: 1, browserEpoch: 1 };
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
      tabId: 'tab-agent-dead',
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.rebind-target',
      params: { tabId: 'tab-agent-sibling' },
    });

    assert.strictEqual(resp.ok, true, `Managed sibling rebind must succeed, got ${JSON.stringify(resp.error)}`);
    assert.strictEqual(reboundTabId, 'tab-agent-sibling');
    assert.strictEqual(registry.getAttachment(launch.attachmentId)?.tabId, 'tab-agent-sibling', 'Authority must rotate to the sibling');
  });

  it('stale-bound rebind to a foreign live tab is refused before dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-target-trans-rebind-foreign-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      resolveTabId: (id) => (id === 'tab-user-youtube' ? 'tab-user-youtube' : undefined),
      resolveFailoverTabId: () => undefined,
      getDocumentGeneration: () => 1,
      isTabAllowed: (primaryId, requestedId) => primaryId === requestedId,
    });

    let rebindExecuted = false;
    catalogue.register({
      name: 'browser.rebind-target',
      description: 'Rebinds target tab',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      policy: basePolicy({ effect: 'idempotent-write' }),
      execute: async () => { rebindExecuted = true; return { success: true, tabId: 'tab-user-youtube', documentGeneration: 1, browserEpoch: 1 }; },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
      tabId: 'tab-agent-dead',
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.rebind-target',
      params: { tabId: 'tab-user-youtube' },
    });

    assert.strictEqual(rebindExecuted, false, 'Foreign rebind must be refused before the handler runs');
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error?.code, 'TARGET_MISMATCH');
  });
});
