import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { registerBrowserCapabilities, makeBrowserPolicy } from '../../src/main/tools/browser-capabilities';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import {
  AuthenticatedCapabilityContext,
  CapabilityRequestContext,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';
// Direct import of production MCP artifact response converter (Zero-mock Invariant C)
const { resolveImageArtifactResponse } = require('../../scripts/antifan-omp-mcp.cjs');

describe('Wave 1 Hardening Invariants Suite', () => {
  const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
  const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';
  const RUNTIME_ID = 'runtime-00000000-0000-4000-8000-000000000001';
  const TAB_PRIMARY = '11111111-1111-4111-8111-111111111111';
  const TAB_SECONDARY = '22222222-2222-4222-8222-222222222222';
  const TAB_UNAUTHORIZED = '33333333-3333-4333-8333-333333333333';

  function createTestCatalogue(options?: {
    isTabAllowed?: (p: string, r: string) => boolean;
    resolveTabId?: (id: string) => string | undefined;
    getDocumentGeneration?: (tabId?: string) => number;
  }) {
    const isAllowedFn = options?.isTabAllowed || ((p, r) => {
      if (p === TAB_PRIMARY && r === TAB_SECONDARY) return true;
      return p === r;
    });
    const resolveFn = options?.resolveTabId || ((id) => {
      if (id === TAB_PRIMARY || id === TAB_SECONDARY || id === TAB_UNAUTHORIZED) return id;
      if (id === '#1') return TAB_PRIMARY;
      if (id === '#2' || id === '@storefront') return TAB_SECONDARY;
      if (id === '#3') return TAB_UNAUTHORIZED;
      return undefined;
    });

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runtimeId: RUNTIME_ID,
      hostEpoch: 1,
      isTabAllowed: isAllowedFn,
      resolveTabId: resolveFn,
      getDocumentGeneration: options?.getDocumentGeneration || ((id) => (id === TAB_SECONDARY ? 42 : 1)),
    });

    return { catalogue, isAllowedFn, resolveFn };
  }

  function createAuthContext(tabId = TAB_PRIMARY, docGen = 1, url?: string): AuthenticatedCapabilityContext {
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    (lease as any).runtimeId = RUNTIME_ID;
    return {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runId: 'run-00000000-0000-4000-8000-000000000001',
      attemptId: 'att-00000000-0000-4000-8000-000000000001',
      hostEpoch: 1,
      lease,
      leaseToken: lease.token,
      attachmentId: 'attach-00000000-0000-4000-8000-000000000001',
      backendId: 'backend-00000000-0000-4000-8000-000000000001',
      invocationId: 'inv-00000000-0000-4000-8000-000000000001',
      grant: 'write',
      browserTarget: {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        runtimeId: RUNTIME_ID,
        tabId,
        browserEpoch: 1,
        documentGeneration: docGen,
        url,
      },
    };
  }

  function createTrustedContext(tabId = TAB_PRIMARY, docGen = 1): CapabilityRequestContext {
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    (lease as any).runtimeId = RUNTIME_ID;
    return {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      lease,
      leaseToken: lease.token,
      grant: 'write',
      browserTarget: {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        runtimeId: RUNTIME_ID,
        tabId,
        browserEpoch: 1,
        documentGeneration: docGen,
      },
    };
  }

  // --- TEST A: Invariant A (Authenticated + Allowed Secondary + URL Cleanup) ---
  test('Test A: dispatchAuthenticated with allowed secondary tab resolves effective target, updates documentGeneration, and strips stale primary url', async () => {
    const { catalogue } = createTestCatalogue();
    let executedTarget: any = null;

    catalogue.register({
      name: 'test.browse',
      description: 'Test browse capability',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true }),
      inputSchema: { type: 'object' },
      execute: async (_params, ctx) => {
        executedTarget = { ...ctx.browserTarget };
        return { ok: true };
      },
    });

    const context = createAuthContext(TAB_PRIMARY, 1, 'https://primary-storefront.vn');
    await catalogue.dispatchAuthenticated('test.browse', { tabId: TAB_SECONDARY }, context);

    assert.ok(executedTarget, 'Capability should have executed');
    assert.strictEqual(executedTarget.tabId, TAB_SECONDARY, 'Downstream capability must observe secondary tabId');
    assert.strictEqual(executedTarget.documentGeneration, 42, 'Downstream capability must observe refreshed documentGeneration');
    assert.strictEqual(executedTarget.url, undefined, 'Downstream capability must not inherit stale primary URL');
    assert.strictEqual(context.browserTarget?.tabId, TAB_SECONDARY, 'Context browserTarget must be materialized to secondary');
  });

  // --- TEST B: Invariant A (Authenticated + Unauthorized Secondary) ---
  test('Test B: dispatchAuthenticated with unauthorized secondary tab throws TARGET_MISMATCH and preserves original target', async () => {
    const { catalogue } = createTestCatalogue();
    let executed = false;

    catalogue.register({
      name: 'test.browse',
      description: 'Test browse capability',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true }),
      inputSchema: { type: 'object' },
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    const context = createAuthContext(TAB_PRIMARY, 1);
    await assert.rejects(
      async () => {
        await catalogue.dispatchAuthenticated('test.browse', { tabId: TAB_UNAUTHORIZED }, context);
      },
      (err: any) => err.code === 'TARGET_MISMATCH'
    );

    assert.strictEqual(executed, false, 'Capability must not execute when unauthorized');
    assert.strictEqual(context.browserTarget?.tabId, TAB_PRIMARY, 'Original target must remain unmutated');
  });

  // --- TEST C: Invariant A (Trusted + Unauthorized Secondary) ---
  test('Test C: dispatchTrusted with unauthorized secondary tab throws TARGET_MISMATCH without silent rewrite', async () => {
    const { catalogue } = createTestCatalogue();
    let executed = false;

    catalogue.register({
      name: 'test.browse',
      description: 'Test browse capability',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true }),
      inputSchema: { type: 'object' },
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    const context = createTrustedContext(TAB_PRIMARY, 1);
    await assert.rejects(
      async () => {
        await catalogue.dispatchTrusted('test.browse', { tabId: TAB_UNAUTHORIZED }, context);
      },
      (err: any) => err.code === 'TARGET_MISMATCH'
    );

    assert.strictEqual(executed, false, 'Capability must not execute on unauthorized target');
    assert.strictEqual(context.browserTarget?.tabId, TAB_PRIMARY, 'No silent rewrite of target is permitted');
  });

  // --- TEST D: Invariant B (switchTab unauthorized / missing target rejects and host is untouched) ---
  test('Test D: switchTab without target or with unauthorized target rejects and host switchTab is NOT called', () => {
    let hostSwitchedId = '';
    const mockHost: any = {
      resolveTargetTabId: (id: string) => (id === TAB_UNAUTHORIZED ? TAB_UNAUTHORIZED : id),
      isTabAllowed: () => false,
      switchTab: (id: string) => {
        hostSwitchedId = id;
        return true;
      },
      hasTab: () => true,
    };
    const port = new BrowserControlPort(mockHost);

    // 1. Missing target entirely throws TARGET_REQUIRED
    assert.throws(
      () => (port as any).switchTab(TAB_SECONDARY),
      (err: any) => err.code === 'TARGET_REQUIRED'
    );
    assert.strictEqual(hostSwitchedId, '', 'Host must not be called when target is missing');

    // 2. Unauthorized tab throws TARGET_MISMATCH
    const target = {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runtimeId: RUNTIME_ID,
      tabId: TAB_PRIMARY,
      browserEpoch: 1,
      documentGeneration: 1,
    };
    assert.throws(
      () => port.switchTab(TAB_UNAUTHORIZED, { target }),
      (err: any) => err.code === 'TARGET_MISMATCH'
    );
    assert.strictEqual(hostSwitchedId, '', 'Host must not be called when tab is unauthorized');
  });

  // --- TEST E: Invariant B (Canonical resolution, authorization, host side effect, and attachment rebind) ---
  test('Test E: switchTab resolves aliases (#2, @storefront), authorizes canonical ID, invokes host, and transport rebinds attachment', async () => {
    let hostSwitchedId = '';
    const mockHost: any = {
      resolveTargetTabId: (id: string) => {
        if (id === '#2' || id === '@storefront') return TAB_SECONDARY;
        if (id === '#1') return TAB_PRIMARY;
        return undefined;
      },
      isTabAllowed: (p: string, r: string) => p === TAB_PRIMARY && r === TAB_SECONDARY,
      switchTab: (id: string) => {
        hostSwitchedId = id;
        return true;
      },
      hasTab: (id: string) => id === TAB_PRIMARY || id === TAB_SECONDARY,
    };
    const port = new BrowserControlPort(mockHost);
    const target = {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      runtimeId: RUNTIME_ID,
      tabId: TAB_PRIMARY,
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // 1. Direct port call: switchTab with #2
    const res1 = port.switchTab('#2', { target });
    assert.strictEqual(res1.switched, true);
    assert.strictEqual(res1.tabId, TAB_SECONDARY, 'Result must return canonical UUID, not #2');
    assert.strictEqual(hostSwitchedId, TAB_SECONDARY, 'Host must be called with canonical UUID');

    // 2. Direct port call: switchTab with @storefront
    hostSwitchedId = '';
    const res2 = port.switchTab('@storefront', { target });
    assert.strictEqual(res2.switched, true);
    assert.strictEqual(res2.tabId, TAB_SECONDARY, 'Result must return canonical UUID, not @storefront');
    assert.strictEqual(hostSwitchedId, TAB_SECONDARY, 'Host must be called with canonical UUID');

    // 3. Negative test: switchTab with unknown #999 throws and host is NOT called
    hostSwitchedId = '';
    assert.throws(
      () => port.switchTab('#999', { target }),
      (err: any) => err.code === 'TARGET_MISMATCH'
    );
    assert.strictEqual(hostSwitchedId, '', 'Host must not be called for unresolved identifier');

    // 4. End-to-end transport dispatch with attachment rebind
    const { catalogue } = createTestCatalogue({
      isTabAllowed: (p, r) => p === TAB_PRIMARY && r === TAB_SECONDARY,
      resolveTabId: (id) => (id === '#2' || id === '@storefront' ? TAB_SECONDARY : (id === '#1' ? TAB_PRIMARY : undefined)),
    });
    registerBrowserCapabilities(catalogue, port);

    const attachmentRegistry = new AttachmentRegistry();
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    (lease as any).runtimeId = RUNTIME_ID;

    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, PROJECT_ID, WORKSPACE_ID, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: TAB_PRIMARY,
      grant: 'write',
      documentGeneration: 1,
    });

    // Dispatch browser.switch-tab with #2
    const dispatchRes = await transport.dispatchIntent({
      requestId: 'req-switch-1',
      idempotencyKey: 'idem-switch-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(launch.authorityRevision),
      name: 'browser.switch-tab',
      params: { tabId: '#2' },
    });

    assert.strictEqual(dispatchRes.ok, true, `Dispatch failed: ${JSON.stringify(dispatchRes.error)}`);

    // Verify attachment in registry has rebound to TAB_SECONDARY
    const updatedRecord = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.ok(updatedRecord);
    assert.strictEqual(updatedRecord.tabId, TAB_SECONDARY, 'Attachment authority must be rebound to canonical UUID');
    assert.notStrictEqual(dispatchRes.replacementAuthorityRevision, launch.authorityRevision, 'Authority revision must advance to a new revision string');
    assert.ok(typeof dispatchRes.replacementAuthorityRevision === 'string' && dispatchRes.replacementAuthorityRevision.startsWith('rev_'));

    // 5. Negative transport test: switched === false under exact switch-tab name must NOT rebind attachment
    const { catalogue: catFail } = createTestCatalogue();
    catFail.register({
      name: 'browser.switch-tab',
      description: 'Exact switch that returns false',
      risk: 'write',
      policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write' }),
      inputSchema: { type: 'object' },
      execute: async () => ({ switched: false, tabId: TAB_SECONDARY }),
    });
    const transportFail = new CapabilityTransportAdapter(catFail, attachmentRegistry);
    const failedDispatch = await transportFail.dispatchIntent({
      requestId: 'req-switch-fail',
      idempotencyKey: 'idem-switch-fail',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(dispatchRes.replacementAuthorityRevision),
      name: 'browser.switch-tab',
      params: {},
    });
    assert.strictEqual(failedDispatch.ok, true);
    assert.strictEqual(failedDispatch.replacementAuthorityRevision, undefined, 'Must not advance revision on failed switch');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_SECONDARY, 'Must not rebind tab on failed switch');

    // 6. Negative transport test: malformed non-UUID data.tabId under exact switch-tab name must NOT rebind attachment
    const { catalogue: catMalformed } = createTestCatalogue();
    catMalformed.register({
      name: 'browser.switch-tab',
      description: 'Exact switch with non-UUID result',
      risk: 'write',
      policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write' }),
      inputSchema: { type: 'object' },
      execute: async () => ({ switched: true, tabId: 'malformed-alias-#2' }),
    });
    const transportMalformed = new CapabilityTransportAdapter(catMalformed, attachmentRegistry);
    const malformedDispatch = await transportMalformed.dispatchIntent({
      requestId: 'req-switch-malformed',
      idempotencyKey: 'idem-switch-malformed',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(dispatchRes.replacementAuthorityRevision),
      name: 'browser.switch-tab',
      params: {},
    });
    assert.strictEqual(malformedDispatch.ok, true);
    assert.strictEqual(malformedDispatch.replacementAuthorityRevision, undefined, 'Must not advance revision on malformed tabId');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_SECONDARY, 'Must not rebind tab on malformed tabId');
  });

  // --- TEST F: Invariant C (MCP Boundary Fail-Closed on 0-byte Image Artifact) ---
  test('Test F: MCP Boundary production function rejects 0-byte image payload with EMPTY_ARTIFACT and isError=true', () => {
    // 1. 0-byte payload fail-closed
    const emptyResult = resolveImageArtifactResponse(
      { id: 'artifact-test-empty', mime: 'image/png' },
      { data: '' }
    );
    assert.strictEqual(emptyResult.isError, true, '0-byte payload must return isError: true');
    assert.ok(
      emptyResult.content && emptyResult.content[0]?.text?.includes('EMPTY_ARTIFACT'),
      'Error message must contain EMPTY_ARTIFACT code'
    );

    // 2. Valid image payload succeeds with image content type
    const validResult = resolveImageArtifactResponse(
      { id: 'artifact-test-valid', mime: 'image/png' },
      { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }
    );
    assert.strictEqual((validResult as any).isError, undefined, 'Valid payload must not have isError');
    assert.strictEqual(validResult.content[0].type, 'image');
    assert.strictEqual(validResult.content[0].mimeType, 'image/png');
  });

  // --- TEST G: Close Tab Failover Rebinding Invariants ---
  test('Test G: closeTab rebinds attachment ONLY on canonical result tabId match and rejects aliases / raw param fallbacks', async () => {
    const TAB_INITIAL = TAB_PRIMARY;
    const TAB_FAILOVER = TAB_SECONDARY;
    const TAB_CHILD = TAB_UNAUTHORIZED;

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
    (lease as any).runtimeId = RUNTIME_ID;
    const attachmentRegistry = new AttachmentRegistry();
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, PROJECT_ID, WORKSPACE_ID, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: TAB_INITIAL,
      grant: 'write',
      documentGeneration: 1,
    });

    const { catalogue: cat } = createTestCatalogue();
    cat.register({
      name: 'browser.close-tab',
      description: 'Close tab capability',
      risk: 'write',
      policy: makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write' }),
      inputSchema: { type: 'object' },
      execute: async (params: any) => {
        return params._mockResult;
      },
    });
    const transport = new CapabilityTransportAdapter(cat, attachmentRegistry);

    // Case 1: Canonical result tabId matches bound tab -> rebinds to failoverTabId
    const res1 = await transport.dispatchIntent({
      requestId: 'req-close-1',
      idempotencyKey: 'idem-close-1',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(launch.authorityRevision),
      name: 'browser.close-tab',
      params: {
        _mockResult: { closed: true, tabId: TAB_INITIAL, failoverTabId: TAB_FAILOVER },
      },
    });
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(typeof res1.replacementAuthorityRevision, 'string');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_FAILOVER);

    // Case 2: Closing managed child tab -> must NOT rebind bound tab
    const res2 = await transport.dispatchIntent({
      requestId: 'req-close-2',
      idempotencyKey: 'idem-close-2',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(res1.replacementAuthorityRevision),
      name: 'browser.close-tab',
      params: {
        _mockResult: { closed: true, tabId: TAB_CHILD, failoverTabId: TAB_INITIAL },
      },
    });
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.replacementAuthorityRevision, undefined, 'Must not advance revision when closing non-bound tab');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_FAILOVER);

    // Case 3: Handler returns closed: true but omits canonical tabId (even if params.tabId matches) -> must NOT rebind
    const res3 = await transport.dispatchIntent({
      requestId: 'req-close-3',
      idempotencyKey: 'idem-close-3',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(res1.replacementAuthorityRevision),
      name: 'browser.close-tab',
      params: {
        tabId: TAB_FAILOVER,
        _mockResult: { closed: true, failoverTabId: TAB_INITIAL },
      },
    });
    assert.strictEqual(res3.ok, true);
    assert.strictEqual(res3.replacementAuthorityRevision, undefined, 'Must not rebind from raw params when result.tabId is missing');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_FAILOVER);

    // Case 4: failoverTabId is an alias with leading whitespace or #/@ -> must NOT rebind
    const res4 = await transport.dispatchIntent({
      requestId: 'req-close-4',
      idempotencyKey: 'idem-close-4',
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: String(res1.replacementAuthorityRevision),
      name: 'browser.close-tab',
      params: {
        _mockResult: { closed: true, tabId: TAB_FAILOVER, failoverTabId: '  #1' },
      },
    });
    assert.strictEqual(res4.ok, true);
    assert.strictEqual(res4.replacementAuthorityRevision, undefined, 'Must reject failover alias with whitespace');
    assert.strictEqual(attachmentRegistry.getAttachment(launch.attachmentId)?.tabId, TAB_FAILOVER);
  });
});
