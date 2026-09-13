import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CapabilityTransportAdapter,
} from '../../src/main/tools/capability-transport';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import {
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

describe('Inspect Fresh Generation Recovery Contract', () => {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

  class MockInspectHost extends EventEmitter {
    public liveDocGenByTab = new Map<string, number>([
      ['tab-1', 10],
      ['tab-2', 5],
    ]);
    public hoverCalls: Array<{ tabId: string; selector?: string }> = [];

    getTabList() {
      return [
        { id: 'tab-1', url: 'https://example.com/tab1', title: 'Tab 1' },
        { id: 'tab-2', url: 'https://example.com/tab2', title: 'Tab 2' },
      ];
    }
    getActiveTabId() { return 'tab-1'; }
    getActiveTab() { return { id: 'tab-1', url: 'https://example.com/tab1', title: 'Tab 1' }; }
    getAutomationTabId() { return 'tab-1'; }
    setAutomationTabId() {}
    getDocumentGeneration(tId?: string) {
      return this.liveDocGenByTab.get(tId || 'tab-1') ?? 1;
    }
    isCurrentTarget(t?: unknown) {
      if (!t || typeof t !== 'object') return false;
      const target = t as { tabId?: string; documentGeneration?: number };
      const tabId = target.tabId || 'tab-1';
      const expectedGen = this.liveDocGenByTab.get(tabId);
      return expectedGen !== undefined && target.documentGeneration === expectedGen;
    }
    async getDom(sel?: string, tabId?: string) {
      const id = tabId || 'tab-1';
      const gen = this.liveDocGenByTab.get(id) ?? 1;
      return `<html><body><div id="content">Tab ${id} at docGen ${gen}</div></body></html>`;
    }
    async agentHover(args: { tabId?: string; selector?: string }) {
      const id = args.tabId || 'tab-1';
      this.hoverCalls.push({ tabId: id, selector: args.selector });
      return true;
    }
  }
  function setupTestHarness(mockHost: MockInspectHost, options?: { isTabAllowed?: (t1: string, t2: string) => boolean }) {
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      getDocumentGeneration: (id) => mockHost.getDocumentGeneration(id),
      isTabAllowed: options?.isTabAllowed,
    });

    const browserPort = new BrowserControlPort(mockHost as unknown as BrowserHostPort);
    registerBrowserCapabilities(catalogue, browserPort);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: (id) => mockHost.getDocumentGeneration(id),
      getAutomationTabId: () => 'tab-1',
    });

    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(mockHost as unknown as NativeTabHost, false, transport);

    return { catalogue, attachmentRegistry, transport, mcpServer };
  }

  it('safely recovers from stale generation (10 vs 12) via inspect.dom then identical hover succeeds', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // 1. Out-of-band mutation advances live document generation to 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // 2. Immediate action (anti.agent.cursor.hover) FAILS with TARGET_STALE (10 vs 12)
    const hoverFail = await mcpServer.callTool('anti.agent.cursor.hover', { selector: '#content' });
    assert.strictEqual(hoverFail.isError, true, 'Hover before inspect must fail due to generation mismatch');
    const errText = hoverFail.content[0]?.text || '';
    assert.ok(errText.includes('TARGET_STALE'), `Expected TARGET_STALE error, got: ${errText}`);

    // 3. Caller performs fresh inspection (anti.inspect.dom) on the same attached target
    const inspectRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectRes.isError, undefined, 'Fresh inspection must succeed');
    assert.ok(inspectRes.content[0]?.text?.includes('docGen 12'), 'Inspection returns fresh document generation');

    // Verify AttachmentRegistry safely acknowledged the observed generation 12
    const updatedRecord = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(updatedRecord?.documentGeneration, 12, 'Attachment record document generation advanced to 12');

    // 4. Identical hover action retried after fresh inspection SUCCEEDS!
    const hoverSuccess = await mcpServer.callTool('anti.agent.cursor.hover', { selector: '#content' });
    assert.strictEqual(hoverSuccess.isError, undefined, 'Hover after fresh inspection must succeed');
    assert.strictEqual(mockHost.hoverCalls.length, 1, 'Hover handler executed successfully');
    assert.strictEqual(mockHost.hoverCalls[0]?.tabId, 'tab-1');
  });

  it('rejects foreign-target inspection: inspecting tab-2 does NOT advance attached tab-1 authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    mockHost.liveDocGenByTab.set('tab-2', 20);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // tab-1 advances out-of-band to 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // 1. Unprivileged foreign target inspection is refused before transport
    const inspectRefused = await mcpServer.callTool('anti.inspect.dom', { tabId: 'tab-2' });
    assert.strictEqual(inspectRefused.isError, true, 'Foreign inspection without permission is refused');
    const refusedText = inspectRefused.content[0]?.text || '';
    assert.ok(refusedText.includes('TARGET_MISMATCH'), 'Refusal must report TARGET_MISMATCH');

    // Attached tab-1 record must NOT be updated
    const recordAfterRefused = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterRefused?.tabId, 'tab-1');
    assert.strictEqual(recordAfterRefused?.documentGeneration, 10, 'Authority for attached tab-1 must not advance');

    // Subsequent hover on tab-1 MUST STILL FAIL with TARGET_STALE
    const hoverStale = await mcpServer.callTool('anti.agent.cursor.hover', { selector: '#content' });
    assert.strictEqual(hoverStale.isError, true, 'Hover must fail because foreign inspection did not update tab-1 authority');
    assert.ok(hoverStale.content[0]?.text?.includes('TARGET_STALE'));
  });

  it('rejects foreign-target inspection on authorized non-refused path: does NOT advance attached tab-1 authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    mockHost.liveDocGenByTab.set('tab-2', 20);
    // Allow tab-2 via isTabAllowed so capability execution succeeds
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost, {
      isTabAllowed: () => true,
    });

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // tab-1 advances out-of-band to 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // Caller inspects authorized foreign target tab-2 explicitly: capability succeeds!
    const inspectAllowed = await mcpServer.callTool('anti.inspect.dom', { tabId: 'tab-2' });
    assert.strictEqual(
      inspectAllowed.isError,
      undefined,
      `Authorized foreign inspection succeeds: ${String(inspectAllowed.content?.[0]?.text).slice(0, 200)}`
    );

    // Transport isSameAttachedTarget guard must ensure attached tab-1 record is NOT advanced with tab-2's generation
    const recordAfterAllowed = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterAllowed?.tabId, 'tab-1');
    assert.strictEqual(recordAfterAllowed?.documentGeneration, 10, 'Authority for attached tab-1 must not advance');

    // Subsequent hover on tab-1 MUST STILL FAIL with TARGET_STALE because tab-1 authority remains at 10
    const hoverStale = await mcpServer.callTool('anti.agent.cursor.hover', { selector: '#content' });
    assert.strictEqual(hoverStale.isError, true, 'Hover must fail because foreign inspection did not update tab-1 authority');
    assert.ok(hoverStale.content[0]?.text?.includes('TARGET_STALE'));
  });
  it('rejects backward or identical generation drift: does not rotate authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // 1. Unchanged generation (10): inspect succeeds but does not rotate authority revision
    const inspectSame = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectSame.isError, undefined);

    const envelopeSame = JSON.parse(inspectSame.content[0]?.text || '{}');
    assert.strictEqual(
      envelopeSame.authorityRevision,
      undefined,
      'Identical generation must not rotate authority revision'
    );

    // 2. Backward drift (live reports 8): inspect succeeds but does not rotate or downgrade authority
    mockHost.liveDocGenByTab.set('tab-1', 8);
    const inspectDrift = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectDrift.isError, undefined);

    const envelopeDrift = JSON.parse(inspectDrift.content[0]?.text || '{}');
    assert.strictEqual(
      envelopeDrift.authorityRevision,
      undefined,
      'Backward drift generation must not rotate authority revision'
    );

    const recordAfterDrift = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterDrift?.documentGeneration, 10, 'Document generation must not regress');
  });

  it('rejects authority rotation when navigation occurs during DOM read (pre/post inequality)', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // Pre-inspection will see docGen 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // When getDom executes, an out-of-band navigation bumps docGen to 13 during the read
    const origGetDom = mockHost.getDom.bind(mockHost);
    mockHost.getDom = async (sel?: string, tabId?: string) => {
      const res = await origGetDom(sel, tabId);
      // Navigation occurs during read!
      mockHost.liveDocGenByTab.set('tab-1', 13);
      return res;
    };

    // Execute inspection
    const inspectRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectRes.isError, undefined);

    // Post-inspection observed docGen 13 != pre-inspection 12.
    // Authority MUST NOT be rotated because the document changed during the read!
    const envelope = JSON.parse(inspectRes.content[0]?.text || '{}');
    assert.strictEqual(
      envelope.authorityRevision,
      undefined,
      'Pre/post generation mismatch must reject authority rotation'
    );

    const record = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(
      record?.documentGeneration,
      10,
      'Record generation must remain 10 because read was interrupted by navigation'
    );
  });

  it('preserves concurrent rebind during in-flight inspection via CAS', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    mockHost.liveDocGenByTab.set('tab-1', 12);

    let concurrentRebindRev: string | null = null;
    const origGetDom = mockHost.getDom.bind(mockHost);
    mockHost.getDom = async (sel?: string, tabId?: string) => {
      // While getDom is in flight, a concurrent rebind occurs on the attachment,
      // advancing docGen to 14 and rotating active revision!
      concurrentRebindRev = await attachmentRegistry.updateAttachmentTab(
        launch.attachmentId,
        'tab-1',
        14
      );
      return await origGetDom(sel, tabId);
    };

    const inspectRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectRes.isError, undefined);

    // Inspect finished with pre=12, post=12, but CAS expectedRevision was launch.authorityRevision.
    // Since concurrent rebind already rotated the revision, CAS fails!
    // Authority revision returned by inspect must NOT overwrite the concurrent rebind!
    const record = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(record?.documentGeneration, 14, 'Concurrent rebind docGen 14 must be preserved');
    assert.strictEqual(record?.authorityRevision, concurrentRebindRev, 'Concurrent rebind revision must be preserved');
  });

  it('does not trust arbitrary payload documentGeneration as authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { attachmentRegistry, mcpServer } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // Live host is at 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // Even if untrusted payload or mock claimed generation 999
    const inspectRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(inspectRes.isError, undefined);

    // Verified record must have host-observed 12, never arbitrary payload numbers
    const record = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(record?.documentGeneration, 12, 'Authority tied strictly to verified host document generation');
  });

  it('fails closed when CAS expected revision or tabId is absent or mismatched', async () => {
    const mockHost = new MockInspectHost();
    const { attachmentRegistry } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    // 1. Mismatched revision fails closed
    const resBadRev = await attachmentRegistry.updateAttachmentTab(
      launch.attachmentId,
      'tab-1',
      12,
      { expectedRevision: 'rev_nonexistent_123', expectedTabId: 'tab-1' }
    );
    assert.strictEqual(resBadRev, null);

    // 2. Mismatched tabId fails closed
    const resBadTab = await attachmentRegistry.updateAttachmentTab(
      launch.attachmentId,
      'tab-1',
      12,
      { expectedRevision: launch.authorityRevision, expectedTabId: 'tab-2' }
    );
    assert.strictEqual(resBadTab, null);

    // 3. Valid CAS succeeds
    const resValid = await attachmentRegistry.updateAttachmentTab(
      launch.attachmentId,
      'tab-1',
      12,
      { expectedRevision: launch.authorityRevision, expectedTabId: 'tab-1' }
    );
    assert.ok(typeof resValid === 'string');
  });

  it('strictly preserves passed observed generation in CAS update without re-sampling delegate', async () => {
    let delegateCallCount = 0;
    const mockHost = new MockInspectHost();
    mockHost.getDocumentGeneration = () => {
      delegateCallCount++;
      return 99; // Delegate claims 99
    };
    const { attachmentRegistry } = setupTestHarness(mockHost);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
      documentGeneration: 10,
    });

    delegateCallCount = 0;
    const newRev = await attachmentRegistry.updateAttachmentTab(
      launch.attachmentId,
      'tab-1',
      12, // Passed observed generation
      { expectedRevision: launch.authorityRevision, expectedTabId: 'tab-1' }
    );
    assert.ok(typeof newRev === 'string');
    assert.strictEqual(delegateCallCount, 0, 'Delegate must NOT be sampled during CAS update');

    const record = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(record?.documentGeneration, 12, 'Must strictly preserve passed observed generation 12');
  });
});
