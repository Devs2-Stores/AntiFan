import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';

class MockTabHost extends EventEmitter implements BrowserHostPort {
  getTabList() { return [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }]; }
  getActiveTabId() { return 'tab-1'; }
  getActiveTab() { return { id: 'tab-1', url: 'https://example.com', title: 'Example' }; }
  isCurrentTarget() { return true; }
  getDocumentGeneration() { return 1; }
  async agentMove() { return true; }
  navigate() { return true; }
  reload() { return true; }
  async getDom() { return '<html><body><h1>AntiFan DOM</h1></body></html>'; }
  async captureScreenshot() { return 'base64-screenshot'; }
  async evalJs() { return true; }
}
describe('BridgeServer Attachment Authentication & Scoped Dispatch', () => {
  it('authenticates via attachment secret, restricts to capability dispatch, enforces replay denial, and prevents legacy RPCs', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const runId = 'run-12345678901234567890';
    const attemptId = 'attempt-12345678901234567890';
    const projectId = 'project-12345678901234567890';
    const workspaceId = 'workspace-12345678901234567890';
    const runtimeId = 'binding-12345678901234567890';
    const hostEpoch = 1;

    const lease = {
      runtimeId,
      projectId,
      workspaceId,
      token: 'active-lease-token',
      protocolVersion: 1,
      hostEpoch,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId,
      hostEpoch,
      getActiveLease: () => lease,
    });

    catalogue.register({
      name: 'browser.test-echo',
      description: 'Test echo capability',
      risk: 'read',
      inputSchema: { type: 'object' },
      execute: (params: any) => ({ echoed: params.text }),
    });

    const transport = new CapabilityTransportAdapter(catalogue);
    const registry = new AttachmentRegistry();

    const server = new BridgeServer(mockHost, 0, false, transport, undefined, registry);
    const port = await server.start();
    assert.strictEqual(server.getHost(), '127.0.0.1');
    assert.ok(port > 0);
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch,
    });

    // 1. Connect via attachment secret as token parameter
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const sendRpc = (id: string, method: string, params: any) => {
      return new Promise<any>((resolve) => {
        const handler = (raw: any) => {
          const resp = JSON.parse(raw.toString());
          if (resp.id === id) {
            ws.off('message', handler);
            resolve(resp);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    // 2. Attachment-authenticated socket cannot invoke legacy RPC
    const legacyResp = await sendRpc('1', 'antifan.agentMove', { selector: '#btn', x: 10, y: 10 });
    assert.strictEqual(legacyResp.success, false);
    assert.ok(legacyResp.error?.includes('Forbidden'), 'Must reject legacy RPC for attachment-authenticated connections');

    // 3. Attachment-authenticated socket can invoke antifan.capability.dispatch
    const invocationId1 = 'inv-11111111111111111111';
    const capResp1 = await sendRpc('2', 'antifan.capability.dispatch', {
      name: 'browser.test-echo',
      params: { text: 'hello world' },
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        invocationId: invocationId1,
      },
    });

    assert.strictEqual(capResp1.success, true);
    assert.deepStrictEqual(capResp1.data, { echoed: 'hello world' });

    // 4. Replay of same invocationId is rejected
    const replayResp = await sendRpc('3', 'antifan.capability.dispatch', {
      name: 'browser.test-echo',
      params: { text: 'hello world' },
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        invocationId: invocationId1,
      },
    });
    assert.strictEqual(replayResp.success, false);
    assert.ok(replayResp.error?.includes('REPLAY_DENIED') || replayResp.error?.includes('Duplicate invocation'));
    // 5. Cross-attachment claim attempt is rejected (socket connected with launch1 cannot dispatch claims for launch2)
    const runId2 = 'run-22222222222222222222';
    const attemptId2 = 'attempt-22222222222222222222';
    const { launch: launch2 } = registry.issueAttachment(runId2, attemptId2, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    const crossResp = await sendRpc('4', 'antifan.capability.dispatch', {
      name: 'browser.test-echo',
      params: { text: 'cross attachment attack' },
      attachmentClaims: {
        attachmentId: launch2.attachmentId,
        attachmentSecret: launch2.secret,
        runId: runId2,
        attemptId: attemptId2,
        projectId,
        workspaceId,
        invocationId: 'inv-cross-11111111111',
      },
    });
    assert.strictEqual(crossResp.success, false);
    assert.ok(crossResp.error?.includes('ATTACHMENT_INVALID') || crossResp.error?.includes('Cross-attachment'));

    // 6. Revocation denies further capability dispatches
    registry.revokeAttachment(launch.attachmentId);

    const invocationId2 = 'inv-22222222222222222222';
    const revokedResp = await sendRpc('5', 'antifan.capability.dispatch', {
      name: 'browser.test-echo',
      params: { text: 'after revocation' },
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        invocationId: invocationId2,
      },
    });
    assert.strictEqual(revokedResp.success, false);
    assert.ok(revokedResp.error?.includes('ATTACHMENT_STALE') || revokedResp.error?.includes('revoked'));

    ws.close();

    // 7. Verify Authorization: Bearer header authentication
    const runId3 = 'run-33333333333333333333';
    const attemptId3 = 'attempt-33333333333333333333';
    const { launch: launch3 } = registry.issueAttachment(runId3, attemptId3, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    const wsBearer = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${launch3.secret}` },
    });
    await new Promise<void>((resolve, reject) => {
      wsBearer.on('open', resolve);
      wsBearer.on('error', reject);
    });
    const bearerResp = await new Promise<any>((resolve) => {
      const handler = (raw: any) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.id === 'b1') {
          wsBearer.off('message', handler);
          resolve(parsed);
        }
      };
      wsBearer.on('message', handler);
      wsBearer.send(JSON.stringify({
        id: 'b1',
        method: 'antifan.capability.dispatch',
        params: {
          name: 'browser.test-echo',
          params: { text: 'bearer header authenticated' },
          attachmentClaims: {
            attachmentId: launch3.attachmentId,
            attachmentSecret: launch3.secret,
            runId: runId3,
            attemptId: attemptId3,
            projectId,
            workspaceId,
            invocationId: 'inv-bearer-1111111111',
          },
        },
      }));
    });
    assert.strictEqual(bearerResp.success, true);
    assert.deepStrictEqual(bearerResp.data, { echoed: 'bearer header authenticated' });
    wsBearer.close();

    // 8. Verify X-Antifan-Attachment-Secret header authentication
    const runId4 = 'run-44444444444444444444';
    const attemptId4 = 'attempt-44444444444444444444';
    const { launch: launch4 } = registry.issueAttachment(runId4, attemptId4, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    const wsCustomHeader = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { 'X-Antifan-Attachment-Secret': launch4.secret },
    });
    await new Promise<void>((resolve, reject) => {
      wsCustomHeader.on('open', resolve);
      wsCustomHeader.on('error', reject);
    });
    const customResp = await new Promise<any>((resolve) => {
      const handler = (raw: any) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.id === 'c1') {
          wsCustomHeader.off('message', handler);
          resolve(parsed);
        }
      };
      wsCustomHeader.on('message', handler);
      wsCustomHeader.send(JSON.stringify({
        id: 'c1',
        method: 'antifan.capability.dispatch',
        params: {
          name: 'browser.test-echo',
          params: { text: 'custom header authenticated' },
          attachmentClaims: {
            attachmentId: launch4.attachmentId,
            attachmentSecret: launch4.secret,
            runId: runId4,
            attemptId: attemptId4,
            projectId,
            workspaceId,
            invocationId: 'inv-custom-1111111111',
          },
        },
      }));
    });
    assert.strictEqual(customResp.success, true);
    assert.deepStrictEqual(customResp.data, { echoed: 'custom header authenticated' });
    wsCustomHeader.close();

    // 9. Verify getRemoteConnectionInfo is redacted and contains no raw token
    const remoteInfo = server.getRemoteConnectionInfo();
    assert.strictEqual((remoteInfo as any).token, undefined, 'Must not expose raw token');
    for (const url of remoteInfo.urls) {
      assert.ok(!url.includes('token='), `URL ${url} must not contain token`);
    }
    assert.ok(!remoteInfo.primaryUrl.includes('token='), 'Primary URL must not contain token');

    server.dispose();
  });

  it('rejects stopped attempts, host epoch changes, PID mismatches, and backend mismatches via validator delegate without consuming invocation nonces', async () => {
    let attemptState: 'prepared' | 'running' | 'completed' | 'failed' | 'interrupted' | undefined = 'running';
    let hostEpoch = 1;
    let expectedPid: number | undefined = 12345;
    let backendId: string | undefined = 'codex';

    const registry = new AttachmentRegistry({
      getAttemptState: () => attemptState,
      getHostEpoch: () => hostEpoch,
      getProcessPid: () => expectedPid,
      getBackendId: () => backendId,
    });

    const runId = 'run-11111111111111111111';
    const attemptId = 'attempt-11111111111111111111';
    const projectId = 'project-11111111111111111111';
    const workspaceId = 'workspace-11111111111111111111';
    const lease = {
      runtimeId: 'binding-11111111111111111111',
      projectId,
      workspaceId,
      token: 'tok-111',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: 12345,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });

    // 1. Valid active attempt validation succeeds
    const validContext = registry.validateAttachment({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      invocationId: 'inv-active-1',
      ownerPid: 12345,
    });
    assert.strictEqual(validContext.attachmentId, launch.attachmentId);

    // 2. Same attachment + same invocationId after success MUST fail with REPLAY_DENIED
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-active-1',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'REPLAY_DENIED'
    );

    // 3. Same-attachment validation failure MUST NOT consume nonce:
    // Calling with mismatched PID fails with PROCESS_MISMATCH...
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-same-att-retry-1',
          ownerPid: 99999, // wrong PID
        }),
      (err: any) => err.code === 'PROCESS_MISMATCH'
    );

    // ...then retrying on the SAME attachment with the SAME invocationId and CORRECT PID succeeds!
    const retriedSameAttachment = registry.validateAttachment({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      invocationId: 'inv-same-att-retry-1',
      ownerPid: 12345,
    });
    assert.strictEqual(retriedSameAttachment.attachmentId, launch.attachmentId);

    // 4. Stopped attempt fails with ATTEMPT_NOT_ACTIVE
    attemptState = 'completed';
    const { launch: launchStopped } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launchStopped.attachmentId,
          attachmentSecret: launchStopped.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-completed-1',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'ATTEMPT_NOT_ACTIVE'
    );

    // 5. Undefined attempt state fails with ATTEMPT_NOT_ACTIVE
    attemptState = undefined;
    const { launch: launchUndef } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launchUndef.attachmentId,
          attachmentSecret: launchUndef.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-undef-1',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'ATTEMPT_NOT_ACTIVE'
    );

    // 6. Host epoch mismatch fails with ATTACHMENT_STALE
    attemptState = 'running';
    hostEpoch = 2; // host epoch rotated
    const { launch: launchEpoch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launchEpoch.attachmentId,
          attachmentSecret: launchEpoch.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-epoch-1',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'ATTACHMENT_STALE'
    );

    // 7. Missing required PID fails with PROCESS_MISMATCH
    hostEpoch = 1;
    expectedPid = 12345;
    const { launch: launchMissingPid } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launchMissingPid.attachmentId,
          attachmentSecret: launchMissingPid.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-missing-pid',
          // ownerPid omitted
        }),
      (err: any) => err.code === 'PROCESS_MISMATCH'
    );

    // 8. Backend mismatch or undefined fails with LINEAGE_MISMATCH
    backendId = 'antigravity';
    const { launch: launchBackend } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    assert.throws(
      () =>
        registry.validateAttachment({
          attachmentId: launchBackend.attachmentId,
          attachmentSecret: launchBackend.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-backend-1',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'LINEAGE_MISMATCH'
    );

    // 8b. Active authenticated invocation extends sliding window expiresAt
    backendId = 'codex';
    const { launch: launchSliding } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      ttlMs: 60_000,
    });
    const initialExpiresAt = launchSliding.expiresAt;
    const validatedContext = registry.validateAttachment({
      attachmentId: launchSliding.attachmentId,
      attachmentSecret: launchSliding.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      invocationId: 'inv-sliding-1',
      ownerPid: 12345,
    });
    assert.ok(validatedContext.lease.expiresAt >= initialExpiresAt, 'Sliding window must maintain or extend expiresAt');

    // 9. Bound PID on attachment is strictly enforced without delegate
    const standaloneRegistry = new AttachmentRegistry();
    const { launch: launchBoundPid } = standaloneRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      boundPid: 54321,
    });
    assert.throws(
      () =>
        standaloneRegistry.validateAttachment({
          attachmentId: launchBoundPid.attachmentId,
          attachmentSecret: launchBoundPid.secret,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-bound-pid-wrong',
          ownerPid: 12345,
        }),
      (err: any) => err.code === 'PROCESS_MISMATCH'
    );
    const validBound = standaloneRegistry.validateAttachment({
      attachmentId: launchBoundPid.attachmentId,
      attachmentSecret: launchBoundPid.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      invocationId: 'inv-bound-pid-correct',
      ownerPid: 54321,
    });
    assert.strictEqual(validBound.attachmentId, launchBoundPid.attachmentId);
  });

  it('automatically resolves target for browser.dom capability dispatch via attachment authentication without TARGET_REQUIRED error', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const runId = 'run-22222222222222222222';
    const attemptId = 'attempt-22222222222222222222';
    const projectId = 'project-22222222222222222222';
    const workspaceId = 'workspace-22222222222222222222';
    const runtimeId = 'binding-22222222222222222222';
    const hostEpoch = 1;

    const lease = {
      runtimeId,
      projectId,
      workspaceId,
      token: 'active-lease-token-2',
      protocolVersion: 1,
      hostEpoch,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId,
      hostEpoch,
      getActiveLease: () => lease,
    });

    const browserPort = new BrowserControlPort(mockHost as unknown as BrowserHostPort);
    registerBrowserCapabilities(catalogue, browserPort);
    const transport = new CapabilityTransportAdapter(catalogue);
    const registry = new AttachmentRegistry();

    const server = new BridgeServer(mockHost, 0, false, transport, undefined, registry);
    const port = await server.start();

    // Issue attachment with NO explicit browserTarget (standard for CLI session / MCP client)
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'cli',
      lease,
      leaseToken: lease.token,
      hostEpoch,
      grant: 'read',
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const sendRpc = (id: string, method: string, params: Record<string, unknown>) => {
        return new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
          const handler = (raw: Buffer | string) => {
            const resp = JSON.parse(raw.toString()) as { id: string; success: boolean; data?: unknown; error?: string };
            if (resp.id === id) {
              ws.off('message', handler);
              resolve(resp);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      // Dispatch browser.dom through attachment
      const domResp = await sendRpc('req-dom-1', 'antifan.capability.dispatch', {
        name: 'browser.dom',
        params: {},
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-dom-test-1',
          grant: 'read',
        },
      });

      assert.strictEqual(domResp.success, true, `browser.dom dispatch failed: ${domResp.error}`);
      assert.ok(typeof domResp.data === 'string' && domResp.data.includes('AntiFan DOM'));
    } finally {
      ws.close();
      server.dispose();
    }
  });
  it('does not implicitly retarget on antifan_open_tab, retargets on antifan_set_automation_target and antifan_navigate', async () => {
    let currentTabId = 'tab-initial';
    let currentGen = 1;
    let clearAgentWorkingCalled = false;

    class DynamicMockTabHost extends EventEmitter {
      getTabList() { return [{ id: currentTabId, url: 'https://example.com', title: 'Example' }]; }
      getActiveTabId() { return currentTabId; }
      getActiveTab() { return { id: currentTabId, url: 'https://example.com', title: 'Example' }; }
      getAutomationTabId() { return currentTabId; }
      setAutomationTabId(id?: string) { if (id) currentTabId = id; }
      createTab(url?: string) {
        currentTabId = 'tab-created-456';
        currentGen = 1;
        return currentTabId;
      }
      navigate(tabId: string, url: string) {
        currentGen += 1;
        return true;
      }
      getDocumentGeneration(tabId?: string) { return currentGen; }
      isCurrentTarget(target: any) {
        return Boolean(target && target.tabId === currentTabId && target.documentGeneration === currentGen);
      }
      clearAllAgentWorking() {
        clearAgentWorkingCalled = true;
      }
      async getDom() { return '<html><body>Content for ' + currentTabId + ' (gen ' + currentGen + ')</body></html>'; }
    }
    const dynamicMockHost = new DynamicMockTabHost() as unknown as NativeTabHost;

    const runId = 'run-99999999999999999999';
    const attemptId = 'attempt-99999999999999999999';
    const projectId = 'project-99999999999999999999';
    const workspaceId = 'workspace-99999999999999999999';
    const runtimeId = 'binding-99999999999999999999';
    const hostEpoch = 1;

    const lease = {
      runtimeId,
      projectId,
      workspaceId,
      token: 'active-lease-token',
      protocolVersion: 1,
      hostEpoch,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId,
      hostEpoch,
      getActiveLease: () => lease,
    });

    const controlPort = new BrowserControlPort(dynamicMockHost as any);
    registerBrowserCapabilities(catalogue, controlPort);
    const transport = new CapabilityTransportAdapter(catalogue);
    const registry = new AttachmentRegistry({
      getHostEpoch: () => hostEpoch,
      getDocumentGeneration: (tId) => (dynamicMockHost as any).getDocumentGeneration(tId),
      getAutomationTabId: () => (dynamicMockHost as any).getAutomationTabId(),
    });

    const server = new BridgeServer(
      dynamicMockHost,
      0,
      false,
      transport,
      undefined,
      registry
    );
    const port = await server.start();
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'cli',
      lease,
      leaseToken: lease.token,
      hostEpoch,
      grant: 'write',
      tabId: currentTabId,
      documentGeneration: currentGen,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const sendRpc = (id: string, method: string, params: Record<string, unknown>) => {
        return new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
          const handler = (raw: Buffer | string) => {
            const resp = JSON.parse(raw.toString()) as { id: string; success: boolean; data?: unknown; error?: string };
            if (resp.id === id) {
              ws.off('message', handler);
              resolve(resp);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      // 1. Open tab via MCP alias (does NOT implicitly retarget automation attachment)
      const openResp = await sendRpc('req-open-1', 'antifan.capability.dispatch', {
        name: 'antifan_open_tab',
        params: { url: 'https://example.com/new' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-open-1',
          grant: 'write',
        },
      });
      assert.strictEqual(openResp.success, true);
      const openData = openResp.data;
      assert.ok(openData && typeof openData === 'object' && 'tabId' in openData);
      assert.strictEqual(openData.tabId, 'tab-created-456');
      // Invariant: openTab does NOT steal or retarget attachment tab
      assert.strictEqual(registry.getRecord(launch.attachmentId)?.tabId, 'tab-initial');

      // 1b. Explicitly retarget via antifan_set_automation_target
      const retargetResp = await sendRpc('req-retarget-1', 'antifan.capability.dispatch', {
        name: 'antifan_set_automation_target',
        params: { tabId: 'tab-created-456' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-retarget-1',
          grant: 'write',
        },
      });
      assert.strictEqual(retargetResp.success, true);
      assert.strictEqual(registry.getRecord(launch.attachmentId)?.tabId, 'tab-created-456');

      // 1c. Invariant: setAutomationTarget fails closed on unknown tab ID
      const failResp = await sendRpc('req-retarget-fail', 'antifan.capability.dispatch', {
        name: 'antifan_set_automation_target',
        params: { tabId: 'tab-non-existent-999' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-retarget-fail',
          grant: 'write',
        },
      });
      assert.strictEqual(failResp.success, false);
      assert.ok(failResp.error && failResp.error.includes('not found'));

      // 2. Navigate via MCP alias
      const navResp = await sendRpc('req-nav-1', 'antifan.capability.dispatch', {
        name: 'antifan_navigate',
        params: { url: 'https://example.com/navigated' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-nav-1',
          grant: 'write',
        },
      });
      assert.strictEqual(navResp.success, true);
      assert.strictEqual(currentGen, 2);
      assert.strictEqual(registry.getRecord(launch.attachmentId)?.documentGeneration, 2);

      // 3. Dispatch DOM read immediately after navigation - should NOT throw TARGET_STALE
      const domResp = await sendRpc('req-dom-post-nav', 'antifan.capability.dispatch', {
        name: 'antifan_get_dom',
        params: {},
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-dom-2',
          grant: 'write',
        },
      });
      assert.strictEqual(domResp.success, true);
      assert.ok(typeof domResp.data === 'string' && domResp.data.includes('gen 2'));
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('self-heals and rebinds target when previous authenticated tab was closed and caller provides explicit new tab or opens tab', async () => {
    const liveTabs = new Map<string, { id: string; url: string; title: string }>();
    liveTabs.set('tab-original', { id: 'tab-original', url: 'https://example.com', title: 'Example' });
    let currentAutomationTab: string | null = 'tab-original';
    let tabGen = 1;

    class DynamicHost extends EventEmitter {
      getTabList() { return Array.from(liveTabs.values()); }
      getActiveTabId() { return liveTabs.keys().next().value || ''; }
      getActiveTab() { return liveTabs.values().next().value || null; }
      getAutomationTabId() { return currentAutomationTab; }
      setAutomationTabId(id?: string) { currentAutomationTab = id || null; }
      createTab(url?: string) {
        const newId = `tab-created-${Date.now()}`;
        liveTabs.set(newId, { id: newId, url: url || 'about:blank', title: 'New Tab' });
        return newId;
      }
      navigate(tabId: string) {
        tabGen += 1;
        return true;
      }
      getDocumentGeneration() { return tabGen; }
      isCurrentTarget(target: unknown) {
        return Boolean(target && typeof target === 'object' && 'tabId' in target && (target as { tabId: unknown }).tabId === currentAutomationTab);
      }
      clearAllAgentWorking() {}
      async getDom(_sel?: string, tabId?: string) {
        return `<html><body>Content for ${tabId || currentAutomationTab}</body></html>`;
      }
    }
    const host = new DynamicHost() as unknown as NativeTabHost;

    const runId = 'run-88888888888888888888';
    const attemptId = 'attempt-88888888888888888888';
    const projectId = 'project-88888888888888888888';
    const workspaceId = 'workspace-88888888888888888888';
    const runtimeId = 'binding-88888888888888888888';

    const lease = {
      runtimeId,
      projectId,
      workspaceId,
      token: 'active-lease-token',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    const browserPort = new BrowserControlPort(host as unknown as BrowserHostPort);
    registerBrowserCapabilities(catalogue, browserPort);

    const transport = new CapabilityTransportAdapter(catalogue);
    const registry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => tabGen,
      getAutomationTabId: () => currentAutomationTab,
    });

    const server = new BridgeServer(host, 0, false, transport, undefined, registry);
    const port = await server.start();

    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-original',
      grant: 'write',
      browserTarget: {
        projectId,
        workspaceId,
        runtimeId,
        tabId: 'tab-original',
        browserEpoch: 1,
        documentGeneration: 1,
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const sendRpc = (id: string, method: string, params: Record<string, unknown>) => {
        return new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
          const handler = (raw: Buffer | string) => {
            const resp = JSON.parse(raw.toString()) as { id: string; success: boolean; data?: unknown; error?: string };
            if (resp.id === id) {
              ws.off('message', handler);
              resolve(resp);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      // Simulate user closing 'tab-original'
      liveTabs.delete('tab-original');
      currentAutomationTab = null;

      // 1. Agent creates a new tab because previous tab was closed
      const openResp = await sendRpc('req-open-dead-recover', 'antifan.capability.dispatch', {
        name: 'anti.browser.tabs.create',
        params: { url: 'https://example.com/recovered' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-open-recover',
          grant: 'write',
        },
      });
      assert.strictEqual(openResp.success, true);
      const openData = openResp.data as { tabId: string };
      assert.ok(openData.tabId.startsWith('tab-created-'));
      const newTabId = openData.tabId;

      // Since old tab was dead, openTab immediately rebinds attachment tab to newTabId
      assert.strictEqual(registry.getRecord(launch.attachmentId)?.tabId, newTabId);
      assert.strictEqual(currentAutomationTab, newTabId);

      // 2. Explicit tabId call on the new alive tab must succeed without TARGET_MISMATCH
      const domResp = await sendRpc('req-dom-recovered', 'antifan.capability.dispatch', {
        name: 'browser.dom',
        params: { tabId: newTabId },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-dom-recover',
          grant: 'write',
        },
      });
      assert.strictEqual(domResp.success, true);
      assert.ok(typeof domResp.data === 'string' && domResp.data.includes(newTabId));
    } finally {
      ws.close();
      server.dispose();
    }
  });
  it('renewAttachment is fail-closed: rejects issued, bound, stale, revoked and expired states; renews only active', () => {
    const registry = new AttachmentRegistry();
    const runId = 'run-33333333333333333333';
    const attemptId = 'attempt-33333333333333333333';
    const projectId = 'project-33333333333333333333';
    const workspaceId = 'workspace-33333333333333333333';
    const lease = {
      runtimeId: 'binding-33333333333333333333',
      projectId,
      workspaceId,
      token: 'tok-333',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: 33333,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    // Active record renews (reference returned by issueAttachment is the stored record).
    const { record, launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'codex',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      boundPid: 33333,
    });
    const before = record.expiresAt;
    const renewed = registry.renewAttachment(launch.attachmentId, launch.secret, {
      extensionMs: 60_000,
      ownerPid: 33333,
    });
    assert.ok(renewed.expiresAt > before, 'active renewal must strictly advance expiresAt');

    // Every non-active state must be rejected with ATTACHMENT_STALE.
    for (const state of ['issued', 'bound', 'stale', 'revoked', 'expired'] as const) {
      record.state = state;
      assert.throws(
        () => registry.renewAttachment(launch.attachmentId, launch.secret, {
          extensionMs: 60_000,
          ownerPid: 33333,
        }),
        (err: any) => err instanceof CapabilityError && err.code === 'ATTACHMENT_STALE',
        'renewAttachment must reject state=' + state
      );
    }

    // Timestamp-expired record must be rejected even if state is nominally 'active'.
    record.state = 'active';
    record.expiresAt = Date.now() - 1;
    assert.throws(
      () => registry.renewAttachment(launch.attachmentId, launch.secret, {
        extensionMs: 60_000,
        ownerPid: 33333,
      }),
      (err: any) => err instanceof CapabilityError && err.code === 'ATTACHMENT_STALE',
      'renewAttachment must reject an active-state record past expiresAt'
    );
  });
});
