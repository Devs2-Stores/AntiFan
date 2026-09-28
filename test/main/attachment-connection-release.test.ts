/**
 * Connection-scoped attachment release.
 *
 * The second liveness proof beside `boundPid`: a binding whose renewals arrive through
 * a bridge socket is owned by that transport while it lives, so a client whose renewals
 * never carried a pid — the shape that left `attachments-v1.jsonl` records unclosable —
 * is released the moment its last renewing connection is gone. The rows below pin the
 * invariant from the defect: `revokeGoneOwnerAttachments` MUST retain a pid-less record
 * a live connection still renews, and `revokeForConnection` MUST release it only when
 * every renewing connection has closed — never while another live one renews it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { issueRuntimeLease, makeControlPlaneId, type BrowserTarget } from '../../src/shared/control-plane-contracts';
import {
  collectCloseLiveUse,
  projectLiveUseAttachments,
  type CloseLiveUseAttachment,
  type CloseLiveUseAttachmentRecord,
  type CloseLiveUsePort,
} from '../../src/main/browser/close-live-use';
import { PageCloseReservations, type LiveUseRequest } from '../../src/main/browser/project-close-coordinator';
import type { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';

const SHELL_A: LiveUseRequest = { scope: 'shell', ownerKey: 'project:a', pageIds: ['tab-1', 'tab-2'], auxiliaryKeys: [] };

/** Mint a binding on `tabId`, optionally owned by a named process (same shape as close-live-use.test). */
async function mintAttachment(registry: AttachmentRegistry, tabId: string, boundPid?: number) {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
  return await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
    backendId: 'test-backend',
    lease,
    leaseToken: lease.token,
    tabId,
    ...(boundPid === undefined ? {} : { boundPid }),
  });
}

/** The registry read the composition root performs, through the same projection it uses. */
function attachmentEvidence(registry: AttachmentRegistry): CloseLiveUseAttachment[] {
  const records: CloseLiveUseAttachmentRecord[] = [];
  for (const attachmentId of registry.getActiveRecordIds()) {
    const record = registry.getRecord(attachmentId);
    if (!record) continue;
    records.push({
      id: record.id,
      state: record.state,
      expiresAt: record.expiresAt,
      runId: record.runId,
      tabId: record.tabId,
      browserTarget: record.browserTarget ? { tabId: record.browserTarget.tabId } : undefined,
    });
  }
  return projectLiveUseAttachments(records, Date.now(), () => undefined);
}

/** The live-use port as the composition root assembles it, so only the attachment seam is under test. */
function wiredPort(registry: AttachmentRegistry): CloseLiveUsePort {
  return {
    admission: () => new PageCloseReservations(),
    operationCounters: () => ({}),
    ledgerInFlight: () => 0,
    runs: () => [],
    attachments: () => attachmentEvidence(registry),
    affinities: () => [],
    terminalState: () => ({ available: true, sessions: [] }),
  };
}

interface RpcResponse {
  id?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

describe('attachment release follows the renewing connection', () => {
  it('revokes a pid-less record once the connection that renewed it closes', async () => {
    const registry = new AttachmentRegistry();
    const { launch } = await mintAttachment(registry, 'tab-1');
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-a' });
    assert.equal(registry.getRecord(launch.attachmentId)?.connectionId, 'conn-a', 'the renewal stamps the transport identity');
    assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'busy', 'the binding holds its page while the connection lives');

    await registry.revokeForConnection('conn-a');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'revoked');
    assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'idle', 'the close evidence stops counting the released binding');
  });

  it('survives the first of two renewing connections and releases on the last', async () => {
    const registry = new AttachmentRegistry();
    const { launch } = await mintAttachment(registry, 'tab-1');
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-a' });
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-b' });

    await registry.revokeForConnection('conn-a');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'active', 'a live renewing connection keeps the binding');
    assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'busy');

    await registry.revokeForConnection('conn-b');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'revoked', 'the binding is released with the last renewing connection');
    assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'idle');
  });

  it('keeps a record when the still-stamped connection survives the other close', async () => {
    const registry = new AttachmentRegistry();
    const { launch } = await mintAttachment(registry, 'tab-1');
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-a' });
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-b' });

    // The last stamper closing first must not destroy a binding the earlier
    // connection still renews — liveness is the set, not the stamped field.
    await registry.revokeForConnection('conn-b');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'active');
    assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'busy');

    await registry.revokeForConnection('conn-a');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'revoked');
  });

  it('retains a pid-less record a live connection renews when the gone-owner sweep runs', async () => {
    const registry = new AttachmentRegistry({ isOwnerProcessAlive: () => false });
    const { launch } = await mintAttachment(registry, 'tab-1');
    await registry.renewAttachment(launch.attachmentId, launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-live' });

    const released = await registry.revokeGoneOwnerAttachments();
    assert.deepEqual(released, { revoked: [], expired: [], retained: 1 }, 'a live renewing connection is an owner that may come back');
    assert.equal(registry.getRecord(launch.attachmentId)?.state, 'active');
  });

  it('leaves records the closed connection never renewed untouched', async () => {
    const registry = new AttachmentRegistry();
    const first = await mintAttachment(registry, 'tab-1');
    const second = await mintAttachment(registry, 'tab-2');
    await registry.renewAttachment(first.launch.attachmentId, first.launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-a' });
    await registry.renewAttachment(second.launch.attachmentId, second.launch.secret, { extensionMs: 3_600_000, connectionId: 'conn-b' });

    await registry.revokeForConnection('conn-a');
    assert.equal(registry.getRecord(first.launch.attachmentId)?.state, 'revoked');
    assert.equal(registry.getRecord(second.launch.attachmentId)?.state, 'active', 'another connection\'s binding is not its neighbour\'s to lose');
  });
});

describe('bridge renewSession stamps and releases on socket close', () => {
  class MockTabHost extends EventEmitter {
    private readonly tabs: { id: string; url: string }[] = [{ id: 'tab-1', url: 'https://google.com' }];
    private activeTabId = 'tab-1';
    getTabList() { return this.tabs; }
    getActiveTabId() { return this.activeTabId; }
    createTab() { const id = `tab-${Date.now()}`; this.activeTabId = id; return id; }
    switchTab() { return true; }
    closeTab() { return true; }
    navigate() { return true; }
    reload() { return true; }
    async evalJs() { return null; }
    async getDom() { return '<html></html>'; }
    async captureScreenshot() { return ''; }
  }

  it('revokes the renewed attachment when its renewing socket closes', async () => {
    const mockHost = new MockTabHost() as unknown as NativeTabHost;
    const registry = new AttachmentRegistry();
    const { launch } = await mintAttachment(registry, 'tab-1');
    // The durable-dispose hook is the synchronous tail of the release, so awaiting it
    // observes the revocation itself rather than polling for it.
    const disposed = Promise.withResolvers<{ attachmentId: string; tabId?: string; browserTarget?: BrowserTarget }>();
    registry.setDisposeListener((info) => {
      if (info.attachmentId === launch.attachmentId) disposed.resolve(info);
    });
    const server = new BridgeServer(mockHost, 0, false, undefined, undefined, registry);
    server.setControlPlane({
      renewCliSession: async (attachmentId: string, secret: string, options?: { extensionMs?: number; ownerPid?: number; connectionId?: string }) =>
        registry.renewAttachment(attachmentId, secret, options),
      runs: { attachments: registry },
    } as unknown as ControlPlaneRuntime);
    const port = await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { 'x-antifan-attachment-secret': launch.secret },
    });
    try {
      const opened = Promise.withResolvers<void>();
      ws.on('open', () => opened.resolve());
      ws.on('error', (err) => opened.reject(err));
      await opened.promise;

      const renewReply = Promise.withResolvers<RpcResponse>();
      ws.on('message', (raw) => {
        const resp = JSON.parse(raw.toString()) as RpcResponse;
        if (resp.id === 'renew-1') renewReply.resolve(resp);
      });
      ws.send(JSON.stringify({ id: 'renew-1', method: 'antifan.cli.renewSession', params: { attachmentId: launch.attachmentId, secret: launch.secret, extensionMs: 3_600_000 } }));
      const renewResp = await renewReply.promise;
      assert.equal(renewResp.success, true, `renewSession refused: ${renewResp.error}`);
      const stamped = registry.getRecord(launch.attachmentId);
      assert.equal(stamped?.state, 'active');
      assert.ok(stamped?.connectionId, 'the socket that renewed is stamped on the record');

      const closed = Promise.withResolvers<void>();
      ws.on('close', () => closed.resolve());
      ws.close();
      await closed.promise;
      const dispose = await disposed.promise;
      assert.equal(dispose.attachmentId, launch.attachmentId);
      assert.equal(registry.getRecord(launch.attachmentId)?.state, 'revoked');
      assert.equal(registry.verifyConnectionToken(launch.secret), null, 'a released binding answers no more connections');
      assert.equal(collectCloseLiveUse(SHELL_A, wiredPort(registry)).state, 'idle', 'the close evidence stops counting it');
    } finally {
      try { ws.close(); } catch {}
      server.dispose();
    }
  });
});
