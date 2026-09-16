import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CapabilityTransportAdapter,
  FRESH_INSPECTION_CAPABILITIES,
  FRESH_INSPECTION_NAME_PATTERN,
  isFreshInspectionCapability,
  FreshInspectionTrait,
} from '../../src/main/tools/capability-transport';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities, makeBrowserPolicy } from '../../src/main/tools/browser-capabilities';
import {
  issueRuntimeLease,
  makeControlPlaneId,
  CapabilityEffectPolicy,
  BrowserTarget,
} from '../../src/shared/control-plane-contracts';

describe('Fresh Inspection Capabilities & Classification Contract', () => {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

  class MockInspectHost extends EventEmitter {
    public liveDocGenByTab = new Map<string, number>([
      ['tab-1', 10],
      ['tab-2', 5],
    ]);

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
  }

  function setupTestHarness(mockHost: MockInspectHost) {
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      getDocumentGeneration: (id) => mockHost.getDocumentGeneration(id),
    });

    const browserPort = new BrowserControlPort(mockHost as unknown as BrowserHostPort);
    registerBrowserCapabilities(catalogue, browserPort);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: (id) => mockHost.getDocumentGeneration(id),
      getAutomationTabId: () => 'tab-1',
    });

    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    return { catalogue, attachmentRegistry, transport, browserPort };
  }

  it('FRESH_INSPECTION_CAPABILITIES contains all 7 canonical and original names', () => {
    const originalNames = [
      'browser.dom',
      'anti.inspect.dom',
      'antifan_get_dom',
      'anti.inspect.snapshot',
      'browser.snapshot',
      'browser.find',
      'browser_find',
    ];
    for (const name of originalNames) {
      assert.strictEqual(
        FRESH_INSPECTION_CAPABILITIES.has(name),
        true,
        `FRESH_INSPECTION_CAPABILITIES must contain original name '${name}'`
      );
    }
  });

  it('FRESH_INSPECTION_CAPABILITIES contains known aliases matching the inspection invariant', () => {
    const aliasNames = [
      'anti.inspect.find',
      'antifan_find',
      'browser.agent-snapshot',
      'antifan_agent_snapshot',
      'anti.browser.snapshot',
    ];
    for (const name of aliasNames) {
      assert.strictEqual(
        FRESH_INSPECTION_CAPABILITIES.has(name),
        true,
        `FRESH_INSPECTION_CAPABILITIES must contain alias '${name}'`
      );
    }
  });

  it('drift guard: every registered browser capability matching read-effect + non-eval + DOM/snapshot/find is in the set', () => {
    const mockHost = new MockInspectHost();
    const { catalogue } = setupTestHarness(mockHost);

    const allRegistered = catalogue.listAll();
    assert.ok(allRegistered.length > 50, 'Catalogue must contain registered browser capabilities');

    for (const item of allRegistered) {
      const def = catalogue.get(item.name);
      if (!def) continue;

      const isReadEffect = def.policy.effect === 'read';
      const isNonEval = def.policy.risk !== 'eval';
      const nameOrDesc = `${def.name} ${def.description}`.toLowerCase();
      const isDomSnapshotFindSurface =
        (def.name.includes('dom') || def.name.includes('snapshot') || def.name.includes('find')) &&
        !def.name.includes('dump_dom'); // dump_dom is write effect anyway

      if (isReadEffect && isNonEval && isDomSnapshotFindSurface) {
        assert.strictEqual(
          FRESH_INSPECTION_CAPABILITIES.has(def.name),
          true,
          `Drift guard violation: registered capability '${def.name}' matches inspection invariant (read-effect + non-eval + DOM/snapshot/find) but is missing from FRESH_INSPECTION_CAPABILITIES`
        );
      }
    }
  });

  it('drift guard: non-DOM/snapshot/find read capabilities are excluded from FRESH_INSPECTION_CAPABILITIES', () => {
    const nonInspectionReadCapabilities = [
      'browser.screenshot',
      'browser.list-tabs',
      'browser.diagnostics',
      'browser.get-viewport',
      'anti.inspect.styles',
      'anti.inspect.layout',
      'anti.inspect.font',
      'anti.inspect.region',
      'anti.inspect.page_inventory',
      'anti.inspect.responsive_matrix',
      'browser.visual_compare',
      'anti.visual.compare',
      'anti.verification.list',
    ];

    for (const name of nonInspectionReadCapabilities) {
      assert.strictEqual(
        FRESH_INSPECTION_CAPABILITIES.has(name),
        false,
        `Non-inspection capability '${name}' must NOT be in FRESH_INSPECTION_CAPABILITIES`
      );
    }
  });

  it('isFreshInspectionCapability classifies canonical inspection capabilities as true when policy is read', () => {
    const readPolicy: CapabilityEffectPolicy = {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      schedulerLane: 'short-passive',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    assert.strictEqual(isFreshInspectionCapability('browser.dom', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('anti.inspect.dom', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('anti.inspect.snapshot', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('browser.find', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('browser_find', readPolicy), true);
  });

  it('isFreshInspectionCapability fails closed on write effect or eval risk', () => {
    const writePolicy: CapabilityEffectPolicy = {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: true,
      schedulerLane: 'viewport-gate',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'drain-and-persist',
      subscriberDisconnectBehavior: 'detach-and-continue',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    const evalPolicy: CapabilityEffectPolicy = {
      effect: 'read',
      risk: 'eval',
      requiresBrowserTarget: true,
      schedulerLane: 'short-passive',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'eval',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    assert.strictEqual(isFreshInspectionCapability('browser.dom', writePolicy), false);
    assert.strictEqual(isFreshInspectionCapability('browser.dom', evalPolicy), false);
    assert.strictEqual(isFreshInspectionCapability('anti.inspect.dom', undefined), false);
  });

  it('isFreshInspectionCapability respects explicit opt-in flag freshInspection: true on definition', () => {
    const readPolicy: CapabilityEffectPolicy = {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      schedulerLane: 'short-passive',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    const customTrait: FreshInspectionTrait = { freshInspection: true };
    // Custom name not in FRESH_INSPECTION_CAPABILITIES and not matching pattern
    assert.strictEqual(isFreshInspectionCapability('custom_page_scanner', readPolicy, customTrait), true);
  });

  it('isFreshInspectionCapability respects explicit opt-out flag freshInspection: false on definition', () => {
    const readPolicy: CapabilityEffectPolicy = {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      schedulerLane: 'short-passive',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    const optOutTrait: FreshInspectionTrait = { freshInspection: false };
    // Even though name is browser.dom, explicit opt-out forces false
    assert.strictEqual(isFreshInspectionCapability('browser.dom', readPolicy, optOutTrait), false);
  });

  it('isFreshInspectionCapability matches newly added capabilities via FRESH_INSPECTION_NAME_PATTERN', () => {
    const readPolicy: CapabilityEffectPolicy = {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: true,
      schedulerLane: 'short-passive',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
      policyDigest: 'test-digest',
      requiresDeviceTarget: false,
    };

    // Sub-capabilities or new variants matching the prefix pattern
    assert.strictEqual(isFreshInspectionCapability('browser.dom.raw', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('anti.inspect.snapshot.v2', readPolicy), true);
    assert.strictEqual(isFreshInspectionCapability('browser.find.deep', readPolicy), true);

    // Completely unrelated names return false
    assert.strictEqual(isFreshInspectionCapability('custom.unrelated_read', readPolicy), false);
  });

  it('CapabilityTransportAdapter.isFreshInspection resolves from live catalogue', () => {
    const mockHost = new MockInspectHost();
    const { catalogue, transport } = setupTestHarness(mockHost);

    // Register a brand-new capability with explicit freshInspection: true
    catalogue.register({
      name: 'new.inspection.tool',
      description: 'Newly registered tool with freshInspection marker',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
      // @ts-expect-error extra trait preserved at runtime
      freshInspection: true,
    });

    const toolDef = catalogue.get('new.inspection.tool');
    assert.ok(toolDef);
    assert.strictEqual(
      transport.isFreshInspection('new.inspection.tool', toolDef.policy),
      true,
      'Newly registered capability with freshInspection: true must be classified as fresh inspection'
    );

    // Register another brand-new capability without marker and without pattern
    catalogue.register({
      name: 'new.non_inspection.tool',
      description: 'Newly registered non-inspection read tool',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
    });

    const nonToolDef = catalogue.get('new.non_inspection.tool');
    assert.ok(nonToolDef);
    assert.strictEqual(
      transport.isFreshInspection('new.non_inspection.tool', nonToolDef.policy),
      false,
      'Newly registered capability without marker or pattern must NOT be classified as fresh inspection'
    );
  });

  it('end-to-end transport dispatch: newly registered inspection capability captures docGen and advances authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { catalogue, attachmentRegistry, transport } = setupTestHarness(mockHost);

    // Register a new custom inspection capability
    catalogue.register({
      name: 'anti.inspect.custom_dom',
      description: 'A new inspection capability registered at runtime',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
      inputSchema: { type: 'object' },
      execute: async (_params, context) => {
        const id = context.browserTarget?.tabId || 'tab-1';
        return `<html><body>Custom DOM of ${id} at docGen ${mockHost.getDocumentGeneration(id)}</body></html>`;
      },
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

    // Advance docGen out-of-band to 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // Dispatch the newly registered inspection capability
    const dispatchRes = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: 'idem-fresh-inspection-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'anti.inspect.custom_dom',
      params: {},
    });

    assert.strictEqual(dispatchRes.ok, true, 'Dispatch of newly registered inspection must succeed');
    assert.ok(
      dispatchRes.replacementAuthorityRevision,
      'Dispatch of fresh inspection must rotate authority revision when docGen strictly advanced'
    );

    // Verify attachment record was updated to docGen 12
    const updated = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.ok(updated);
    assert.strictEqual(updated.documentGeneration, 12, 'Attachment document generation must advance to 12');
  });

  it('end-to-end transport dispatch: newly registered non-inspection capability does NOT advance authority', async () => {
    const mockHost = new MockInspectHost();
    mockHost.liveDocGenByTab.set('tab-1', 10);
    const { catalogue, attachmentRegistry, transport } = setupTestHarness(mockHost);

    // Register a non-inspection read capability
    catalogue.register({
      name: 'browser.custom_telemetry',
      description: 'Non-inspection telemetry read',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'short-passive' }),
      inputSchema: { type: 'object' },
      execute: async () => ({ status: 'ok' }),
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

    // Advance docGen to 12
    mockHost.liveDocGenByTab.set('tab-1', 12);

    // Dispatch non-inspection capability
    const dispatchRes = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: 'idem-non-inspection-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'browser.custom_telemetry',
      params: {},
    });

    assert.strictEqual(dispatchRes.ok, true);
    assert.strictEqual(
      dispatchRes.replacementAuthorityRevision,
      undefined,
      'Non-inspection capability must NOT rotate authority revision on docGen drift'
    );

    const record = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.ok(record);
    assert.strictEqual(record.documentGeneration, 10, 'Attachment document generation must remain at 10');
  });
});
