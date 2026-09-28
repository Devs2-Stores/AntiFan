import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { BrowserControlPort, PassiveExecutionPool, ViewportGate } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { TabAuthorityDirectory } from '../../src/main/browser/tab-authority-directory';
import type { ProjectWindowShell } from '../../src/main/browser/project-window-shell';
import { deriveCapsulePartition } from '../../src/main/browser/browser-session-partition';
import {
  makeControlPlaneId,
  issueRuntimeLease,
  CapabilityError,
} from '../../src/shared/control-plane-contracts';

/** Distinct chrome webContents ids, so two windows can never answer for each other. */
let nextSurfaceContentsId = 700_000;

/**
 * One project window's routing authority: the shipping `NativeTabHost` methods over that
 * window's own tabs, plus the shell plumbing the real directory reads (owner, liveness, chrome
 * surface ids). Only window plumbing is absent — every routing decision below is the shipping one.
 */
function makeWindowAuthority(ownerProjectId: string, tabIds: readonly string[]) {
  const toolbarContentsId = (nextSurfaceContentsId += 1);
  const sidebarContentsId = (nextSurfaceContentsId += 1);
  let destroyed = false;
  const shell = {
    owner: { kind: 'project', projectId: ownerProjectId },
    window: { isDestroyed: () => destroyed },
    chromeSurfaceFor: (webContentsId: number) => {
      if (webContentsId === toolbarContentsId) return 'toolbar' as const;
      if (webContentsId === sidebarContentsId) return 'sidebar' as const;
      return undefined;
    },
  } as unknown as ProjectWindowShell;
  const host = Object.create(NativeTabHost.prototype) as NativeTabHost;
  Object.assign(host, {
    tabs: new Map(tabIds.map((id) => [id, { id, state: { id, url: 'about:blank', title: id } }])),
    tabOrder: [...tabIds],
    automationTabId: null,
    terminalWindows: new Map(),
    popoutWindow: null,
    isDisposed: false,
    shell,
    broadcastState: () => {},
  });
  return {
    shell,
    host,
    toolbarContentsId,
    sidebarContentsId,
    destroyWindow: () => {
      destroyed = true;
    },
  };
}

describe('Multi-Project & Multi-Session Two-Tier Concurrency Stress Suite (Phase 05)', () => {
  it('runs end-to-end multi-project concurrency, preemption, and security verification', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-e2e-concurrency-'));
    let bridgeServer: BridgeServer | null = null;
    let ws: WebSocket | null = null;
    try {
      const projA = makeControlPlaneId('project');
      const wsA = makeControlPlaneId('workspace');
      const dirA = path.join(dataRoot, 'project-a');

      const projB = makeControlPlaneId('project');
      const wsB = makeControlPlaneId('workspace');
      const dirB = path.join(dataRoot, 'project-b');

      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        allowEval: false,
      });

      runtime.workspaces.ensureInitialWorkspace(projA, wsA, dirA, dataRoot);
      runtime.workspaces.ensureInitialWorkspace(projB, wsB, dirB, dataRoot);


      const activeExecutions: string[] = [];
      const interactiveHistory: string[] = [];

      const tabList = [
        { id: 'tab-projA-1', url: 'https://haravan-theme.vn', title: 'Haravan Tab' },
        { id: 'tab-projB-1', url: 'https://sapo-theme.vn', title: 'Sapo Tab' },
      ];

      class MockE2EHost extends EventEmitter {
        public agentInputInFlight = 0;
        getTabList() { return [...tabList]; }
        getActiveTabId() { return 'tab-projA-1'; }
        getActiveTab() { return tabList[0]; }
        getAutomationTabId() { return 'tab-projA-1'; }
        getDocumentGeneration() { return 1; }
        isCurrentTarget() { return true; }

        async getDom(selector?: string, tabId?: string) {
          activeExecutions.push(`dom:${tabId}`);
          await new Promise((r) => setImmediate(r));
          return `<html><body>DOM of ${tabId}</body></html>`;
        }

        async captureScreenshot(rect?: unknown, tabId?: string) {
          activeExecutions.push(`screenshot:${tabId}`);
          await new Promise((r) => setImmediate(r));
          return Buffer.from('png').toString('base64');
        }

        async agentClick(params: { selector?: string; tabId?: string }) {
          interactiveHistory.push(`click:${params.tabId}`);
          await new Promise((r) => setImmediate(r));
          return true;
        }

        async agentType(params: { text: string; tabId?: string }) {
          interactiveHistory.push(`type:${params.tabId}:${params.text}`);
          await new Promise((r) => setImmediate(r));
          return true;
        }

        createTab(url?: string) {
          const newTab = { id: 'tab-dynamic-created-999', url: url || 'about:blank', title: 'Created Dynamic Tab' };
          tabList.push(newTab);
          return newTab.id;
        }
      }

      const mockHost = new MockE2EHost() as unknown as NativeTabHost;
      const browserPort = new BrowserControlPort(mockHost as any);
      registerBrowserCapabilities(runtime.capabilities, browserPort, undefined, () => '');

      const transport = new CapabilityTransportAdapter(runtime.capabilities, runtime.runs.attachments);
      bridgeServer = new BridgeServer(mockHost, 0, false, transport, undefined, runtime.runs.attachments);
      const bridgePort = await bridgeServer.start();
      const sessionA = await runtime.createCliSession({
        projectId: projA,
        workspaceId: wsA,
        backendId: 'mcp',
        tabId: 'tab-projA-1',
        grant: 'write',
      });

      const sessionB = await runtime.createCliSession({
        projectId: projB,
        workspaceId: wsB,
        backendId: 'cli',
        tabId: 'tab-projB-1',
        grant: 'write',
      });
      const runA = sessionA.run.id;
      const attA = sessionA.attempt.id;
      const launchA = sessionA.launch;

      const runB = sessionB.run.id;
      const attB = sessionB.attempt.id;
      const launchB = sessionB.launch;

      const mcpServer = new AntiFanMcpServer(mockHost, false, transport, {
        attachmentId: launchA.attachmentId,
        attachmentSecret: launchA.secret,
        authorityRevision: launchA.authorityRevision,
      });

      // 1. Suite 1 & 2: Dynamic multi-project routing across MCP and Bridge
      const mcpDomRes = await mcpServer.callTool('anti.inspect.dom', {});
      assert.strictEqual(mcpDomRes.isError, undefined, `mcpDomRes failed: ${mcpDomRes.content[0]?.text}`);
      assert.ok(mcpDomRes.content[0]?.text?.includes('tab-projA-1'));
      ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, {
        headers: { 'x-antifan-attachment-secret': launchB.secret },
      });
      await new Promise<void>((resolve, reject) => {
        ws!.on('open', resolve);
        ws!.on('error', reject);
      });

      const sendRpc = (id: string, method: string, params: Record<string, unknown>) => {
        return new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
          const handler = (raw: Buffer | string) => {
            const resp = JSON.parse(raw.toString()) as { id: string; success: boolean; data?: unknown; error?: string };
            if (resp.id === id) {
              ws?.off('message', handler);
              resolve(resp);
            }
          };
          ws?.on('message', handler);
          ws?.send(JSON.stringify({ id, method, params }));
        });
      };

      const bridgeDomRes = await sendRpc('req-e2e-bridge-1', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: {},
        attachmentId: launchB.attachmentId,
        attachmentSecret: launchB.secret,
        authorityRevision: launchB.authorityRevision,
      });
      assert.strictEqual(bridgeDomRes.success, true, `bridgeDomRes failed: ${bridgeDomRes.error}`);
      await runtime.runs.attachments.revokeAttachment(launchA.attachmentId);
      const revokedA = await mcpServer.callTool('anti.inspect.dom', {});
      assert.strictEqual(revokedA.isError, true, 'Revoked Session A must fail');

      const stillValidB = await sendRpc('req-e2e-bridge-2', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: {},
        attachmentId: launchB.attachmentId,
        attachmentSecret: launchB.secret,
        authorityRevision: launchB.authorityRevision,
      });
      assert.strictEqual(stillValidB.success, true, 'Session B in Project B must remain valid');
      // 3. Suite 4: Fast-Path Tab Rebind in Session B
      const openTabB = await sendRpc('req-e2e-open', 'antifan.capability.dispatch', {
        name: 'antifan_open_tab',
        params: { url: 'https://sapo.vn/products' },
        attachmentId: launchB.attachmentId,
        attachmentSecret: launchB.secret,
        authorityRevision: launchB.authorityRevision,
      });
      assert.strictEqual(openTabB.success, true);
      assert.strictEqual(runtime.runs.attachments.getRecord(launchB.attachmentId)?.tabId, 'tab-dynamic-created-999');

      // 4. Suite 5: PassiveExecutionPool Saturation
      const passivePool = browserPort.passivePool;
      const deferreds: Array<{ resolve: () => void; promise: Promise<void> }> = [];
      const makeDef = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        return { resolve, promise };
      };

      for (let i = 0; i < 4; i++) {
        const d = makeDef();
        deferreds.push(d);
        void passivePool.execute('tab-stress-1', () => d.promise);
      }
      await assert.rejects(
        async () => passivePool.execute('tab-stress-1', async () => 'overflow'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_OVERLOADED'
      );
      for (const d of deferreds) d.resolve();

      // 5. Suite 6, 7 & 8: ViewportGate FIFO, Human Preemption & Controller Safety
      const viewportGate = browserPort.viewportGate;
      let session1Aborted = false;
      let session2Done = false;

      let act1StartedResolve!: () => void;
      const act1Started = new Promise<void>((r) => { act1StartedResolve = r; });

      const act1 = async (signal: AbortSignal) => {
        act1StartedResolve();
        if (signal.aborted) {
          session1Aborted = true;
          throw signal.reason;
        }
        return new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            session1Aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      };

      const act2 = async () => {
        session2Done = true;
        return 'act2_success';
      };

      const lockP1 = viewportGate.withLock(act1, { tabId: 'tab-1' });
      await act1Started;
      const lockP2 = viewportGate.withLock(act2, { tabId: 'tab-2' });

      // Preempt active lock holder
      viewportGate.preemptActiveAgent('Human typed on keyboard');
      await assert.rejects(
        lockP1,
        (err: unknown) => err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER'
      );
      assert.strictEqual(session1Aborted, true);

      const res2 = await lockP2;
      assert.strictEqual(res2, 'act2_success');
      assert.strictEqual(session2Done, true);

      // 6. Suite 9: Capsule partition isolation
      const partA = deriveCapsulePartition(projA, 'clean');
      const partB = deriveCapsulePartition(projB, 'clean');
      assert.notStrictEqual(partA, partB);

      // 7. Multi-project tab routing through the real window authority
      const directory = new TabAuthorityDirectory();
      const windowA = makeWindowAuthority(projA, ['tab-projA-1']);
      const windowB = makeWindowAuthority(projB, ['tab-projB-1', 'tab-dynamic-created-999']);
      directory.register(windowA.shell, windowA.host);
      directory.register(windowB.shell, windowB.host);

      const recordB = runtime.runs.attachments.getRecord(launchB.attachmentId);
      assert.ok(recordB, 'session B lost its attachment record');
      assert.strictEqual(recordB.tabId, 'tab-dynamic-created-999');
      assert.strictEqual(windowA.host.windowOwnerKey(), 'project:' + projA);
      assert.strictEqual(windowB.host.windowOwnerKey(), 'project:' + projB);

      // Every tab the two sessions actually bound resolves to the window that owns it, and a tab
      // that belongs to no window resolves to nothing instead of to a neighbour.
      assert.strictEqual(directory.hostForTab('tab-projA-1'), windowA.host);
      assert.strictEqual(directory.hostForTab('tab-dynamic-created-999'), windowB.host);
      assert.strictEqual(directory.hostForTab('tab-projB-1'), windowB.host);
      assert.strictEqual(directory.hostForTab('tab-nowhere'), undefined);
      assert.strictEqual(directory.hostForTab(''), undefined);
      assert.strictEqual(directory.hosts().length, 2);
      assert.strictEqual(directory.liveShellCount(), 2);

      // A chrome surface answers only for its own window; page content is not a chrome surface,
      // so a sender that belongs to no window resolves to nothing.
      assert.strictEqual(directory.resolveSender(windowA.toolbarContentsId)?.host, windowA.host);
      assert.strictEqual(directory.resolveSender(windowA.toolbarContentsId)?.surface, 'toolbar');
      assert.strictEqual(directory.resolveSender(windowB.sidebarContentsId)?.host, windowB.host);
      assert.strictEqual(directory.resolveSender(windowB.sidebarContentsId)?.surface, 'sidebar');
      assert.strictEqual(directory.resolveSender(999_999), undefined);

      // Closing one project window takes exactly that window's tabs out of routing.
      windowA.destroyWindow();
      assert.strictEqual(directory.hostForTab('tab-projA-1'), undefined);
      assert.strictEqual(directory.hostForTab('tab-dynamic-created-999'), windowB.host);
      assert.strictEqual(directory.liveShellCount(), 1);
      assert.deepStrictEqual(directory.hosts(), [windowB.host]);
      directory.unregister(windowB.shell);
      assert.strictEqual(directory.hostForShell(windowB.shell), undefined);
      assert.strictEqual(directory.hostForTab('tab-dynamic-created-999'), undefined);
      assert.strictEqual(directory.liveShellCount(), 0);

      if (ws) ws.close();
      if (bridgeServer) bridgeServer.dispose();
    } finally {
      if (ws) ws.close();
      if (bridgeServer) bridgeServer.dispose();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
