import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  computePolicyDigest,
  CapabilityEffectPolicy,
  CapabilityEffectPolicyInput,
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  ClientInvocationIntent,
  MainResolvedAuthority,
  CapabilityExecutionControl,
  InvocationDispatchStage,
  OwnerCancellationBehavior,
  SubscriberDisconnectBehavior,
  McpEvidence,
} from '../../src/shared/control-plane-contracts';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import * as path from 'node:path';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { registerWorkflowCapabilities } from '../../src/main/workflow/workflow-capabilities';
import { WorkflowEngine } from '../../src/main/workflow/workflow-engine';
import { envelope, failure } from '../../src/main/mcp/result-envelope';

function createMockHost(): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }],
    getActiveTabId: () => 'tab-1',
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => '',
    evalJs: async () => null,
    sendKeyboardPress: async (params) => ({ success: true, key: params.key, modifiers: params.modifiers || [] }),
  };
}

describe('Phase 01: Canonical Authority Contracts, Effect Policy & MCP Envelopes', () => {
  it('1. Computes deterministic policy digests independently of property insertion order', () => {
    const policyA: CapabilityEffectPolicyInput = {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    };

    const policyB: CapabilityEffectPolicyInput = {
      policyVersion: 1,
      cancellationAckTimeoutMs: 5_000,
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      ownerCancellationBehavior: 'abort-immediate',
      retentionPolicy: 'run-durable',
      timeoutMs: 15_000,
      receiptReadPermission: 'read',
      recordedVisibility: 'tenant-scoped',
      duplicateMode: 'in-process-join',
      schedulerLane: 'unbounded',
      requiresBrowserTarget: false,
      risk: 'read',
      effect: 'read',
    };

    const digestA = computePolicyDigest(policyA);
    const digestB = computePolicyDigest(policyB);
    assert.strictEqual(digestA, digestB);
    assert.strictEqual(typeof digestA, 'string');
    assert.strictEqual(digestA.length, 64);
  });

  it('2. Enforces catalogue validation of orthogonal cancellation and disconnect policies', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    // Reject missing ownerCancellationBehavior
    assert.throws(
      () => catalogue.register({
        name: 'test.invalid-owner-cancel',
        description: 'invalid',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 15_000,
          retentionPolicy: 'run-durable',
          ownerCancellationBehavior: 'invalid-cancel' as unknown as OwnerCancellationBehavior,
          subscriberDisconnectBehavior: 'abort-when-unobserved',
          cancellationAckTimeoutMs: 5_000,
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      }),
      /invalid ownerCancellationBehavior/
    );

    // Reject legacy ignore-disconnect
    assert.throws(
      () => catalogue.register({
        name: 'test.legacy-ignore-disconnect',
        description: 'invalid',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 15_000,
          retentionPolicy: 'run-durable',
          ownerCancellationBehavior: 'ignore-disconnect' as unknown as OwnerCancellationBehavior,
          subscriberDisconnectBehavior: 'abort-when-unobserved',
          cancellationAckTimeoutMs: 5_000,
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      }),
      /invalid ownerCancellationBehavior/
    );

    // Reject abort-when-unobserved with drain-and-persist
    assert.throws(
      () => catalogue.register({
        name: 'test.invalid-unobserved-drain',
        description: 'invalid',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 15_000,
          retentionPolicy: 'run-durable',
          ownerCancellationBehavior: 'drain-and-persist',
          subscriberDisconnectBehavior: 'abort-when-unobserved',
          cancellationAckTimeoutMs: 5_000,
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      }),
      /cannot use abort-when-unobserved with drain-and-persist/
    );

    // Reject cancellationAckTimeoutMs > timeoutMs
    assert.throws(
      () => catalogue.register({
        name: 'test.invalid-ack-timeout',
        description: 'invalid',
        risk: 'read',
        policy: {
          effect: 'read',
          risk: 'read',
          requiresBrowserTarget: false,
          schedulerLane: 'unbounded',
          duplicateMode: 'in-process-join',
          recordedVisibility: 'tenant-scoped',
          receiptReadPermission: 'read',
          timeoutMs: 5_000,
          retentionPolicy: 'run-durable',
          ownerCancellationBehavior: 'abort-immediate',
          subscriberDisconnectBehavior: 'abort-when-unobserved',
          cancellationAckTimeoutMs: 10_000,
          policyVersion: 1,
        },
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      }),
      /cancellationAckTimeoutMs must be positive and <= timeoutMs/
    );
  });

  it('3. Ensures browser.keyboard-press and all aliases have requiresBrowserTarget: true and schedulerLane: viewport-gate', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const mockHost = createMockHost();
    const port = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, port);

    const keyboardAliases = [
      'browser.keyboard-press',
      'antifan_keyboard_press',
      'browser.send-keyboard-press',
      'browser_press_key',
    ];

    for (const name of keyboardAliases) {
      const cap = catalogue.get(name);
      assert.ok(cap, `Expected capability ${name} to be registered`);
      assert.strictEqual(cap.requiresBrowserTarget, true, `${name} must require browser target`);
      assert.strictEqual(cap.policy.requiresBrowserTarget, true, `${name} policy must require browser target`);
      assert.strictEqual(cap.policy.schedulerLane, 'viewport-gate', `${name} policy schedulerLane must be viewport-gate`);
      assert.strictEqual(cap.policy.effect, 'interactive-effect', `${name} policy effect must be interactive-effect`);
      assert.strictEqual(cap.policy.ownerCancellationBehavior, 'drain-and-persist');
      assert.strictEqual(cap.policy.subscriberDisconnectBehavior, 'detach-and-continue');
      assert.ok(cap.policy.cancellationAckTimeoutMs > 0);
    }
  });

  it('4. Ensures workflow.execute is registered with unbounded lane', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const mockHost = createMockHost();
    const artifacts = new ArtifactStore({ root: path.resolve('test-artifacts-dummy') });
    const engine = new WorkflowEngine({ catalogue, artifacts });
    registerWorkflowCapabilities(catalogue, engine);

    const workflowCap = catalogue.get('workflow.execute');
    assert.ok(workflowCap, 'workflow.execute must be registered');
    assert.strictEqual(workflowCap.policy.schedulerLane, 'unbounded', 'workflow.execute must use unbounded lane');
    assert.strictEqual(workflowCap.policy.ownerCancellationBehavior, 'abort-immediate');
    assert.strictEqual(workflowCap.policy.subscriberDisconnectBehavior, 'abort-when-unobserved');
  });

  it('5. Verifies MCP result envelope carries requestId, invocationId, evidence, and replacementAuthorityRevision', () => {
    const successResult = envelope(
      { output: 'test-data' },
      { tabId: 'tab-10', url: 'https://test.local', executionTier: 'cdp_trusted' },
      'req-alpha',
      'inv-beta',
      'rev-gamma'
    );

    assert.strictEqual(successResult.ok, true);
    assert.strictEqual(successResult.requestId, 'req-alpha');
    assert.strictEqual(successResult.invocationId, 'inv-beta');
    assert.strictEqual(successResult.authorityRevision, 'rev-gamma');
    assert.strictEqual(successResult.evidence.tabId, 'tab-10');
    assert.strictEqual(successResult.evidence.executionTier, 'cdp_trusted');

    const failResult = failure(
      'Actionability check failed',
      'REF_AMBIGUOUS',
      { matchedCount: 2 },
      { tabId: 'tab-10', fallbackReason: 'ambiguous-match' },
      'req-alpha',
      'inv-beta',
      'rev-delta'
    );

    assert.strictEqual(failResult.ok, false);
    assert.strictEqual(failResult.requestId, 'req-alpha');
    assert.strictEqual(failResult.invocationId, 'inv-beta');
    assert.strictEqual(failResult.authorityRevision, 'rev-delta');
    assert.strictEqual(failResult.error.code, 'REF_AMBIGUOUS');
    assert.strictEqual(failResult.error.message, 'Actionability check failed');
    assert.strictEqual(failResult.evidence.fallbackReason, 'ambiguous-match');
  });
});
