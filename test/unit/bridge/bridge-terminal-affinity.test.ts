import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { BridgeServer, type BridgeMintTargetRequest, type BridgeMintTargetResolution } from '../../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID } from '../../../src/main/browser/terminal-manager';
import { ControlPlaneRuntime } from '../../../src/main/control-plane/control-plane-runtime';

describe('BridgeServer Terminal Affinity Resolution Live RPC Contract Tests', () => {
  let server: BridgeServer;
  let port: number;
  let ws: WebSocket;
  let recordedAutomationTabId: string | null = null;
  let lastSessionCreatedOpts: any = null;
  let mockHost: MockTabHost;
  let resolverStub: ((opts: BridgeMintTargetRequest) => BridgeMintTargetResolution | undefined) | undefined;

  class MockTabHost extends EventEmitter {
    // A real host tracks the tabs it creates; the session-start validation reads
    // that back, so the mock must too.
    createdTabs = new Set<string>();
    // The options a mint carries (offscreen/ephemeral/capsuleId) are the contract the
    // capsule-pinning cases assert on.
    createTabCalls: Array<{ url?: string; activate?: boolean; options?: Record<string, unknown> }> = [];
    boundAffinity: Array<{ terminalId: string; generation?: string | number; tabId: string }> = [];
    hasTab(id?: string | null) { return typeof id === 'string' && (this.createdTabs.has(id) || id === 'tab-alive' || id === 'tab-auto' || id === 'tab-active'); }
    getAutomationTabId() { return 'tab-auto'; }
    getActiveTabId() { return 'tab-active'; }
    setAutomationTabId(id: string) { recordedAutomationTabId = id; }
    getActiveTab() { return { id: 'tab-active' }; }
    getTabList() { return [{ id: 'tab-alive' }, { id: 'tab-auto' }]; }
    getTabCapsuleId(id?: string | null) { return id === 'tab-active' ? 'capsule-active' : undefined; }
    resolveTargetTabId(id?: string | null) {
      if (id === '#1' || id === '1' || id === 'tab-1') return 'tab-alive';
      return typeof id === 'string' && this.hasTab(id) ? id : undefined;
    }
    createTab(url?: string, activate?: boolean, options?: Record<string, unknown>) {
      this.createTabCalls.push({ url, activate, options });
      this.createdTabs.add('tab-created');
      return 'tab-created';
    }
    bindTerminalAgentAffinity(terminalId: string, generation: string | number | undefined, tabId: string) {
      this.boundAffinity.push({ terminalId, generation, tabId });
    }
    getTerminalAgentAffinity(termId: string, gen?: string | number) {
      if (termId === 'term-alive' && (gen === undefined || String(gen) === '1')) {
        return { tabId: 'tab-alive', status: 'alive' as const, lastUrl: 'https://alive.test' };
      }
      if (termId === 'term-closed') {
        return { tabId: 'tab-closed', status: 'closed' as const, lastUrl: 'https://closed.test' };
      }
      return undefined;
    }
  }

  const mockControlPlane = {
    createCliSession: async (opts: any) => {
      lastSessionCreatedOpts = opts;
      return {
        run: { id: 'run-test-123456789012' },
        attempt: { id: 'attempt-test-123456789012' },
        launch: {
          attachmentId: 'binding-test-123456789012',
          secret: 'secret-test-123456789012',
          authorityRevision: 'rev-test-123456789012',
          projectId: opts?.projectId || 'project-local',
          workspaceId: opts?.workspaceId || 'workspace-local',
          expiresAt: Date.now() + 3600000,
        },
      };
    },
  };

  before(async () => {
    mockHost = new MockTabHost();
    server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    server.setControlPlane(mockControlPlane as unknown as ControlPlaneRuntime);
    server.setMintHostResolver((opts) => resolverStub?.(opts));
    port = await server.start();
    const token = server.getToken();
    ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.once('open', () => resolve());
    ws.once('error', reject);
    await promise;
  });

  after(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    if (server) {
      server.dispose();
    }
  });

  function rpcCall(method: string, params: any, timeoutMs = 5000): Promise<any> {
    const id = `rpc-${Math.random().toString(36).slice(2)}`;
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`RPC timed out for method ${method}`));
    }, timeoutMs);

    const onMessage = (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {}
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  it('1. Successfully resolves alive terminal affinity and sets session target tab', async () => {
    lastSessionCreatedOpts = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-alive',
      terminalGeneration: 1,
    });

    assert.strictEqual(resp.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-alive');
    assert.strictEqual(resp.data?.tabId, 'tab-alive');
  });

  it('2. Auto-provisions a fresh agent tab when the bound tab was closed', async () => {
    lastSessionCreatedOpts = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-closed',
    });

    // A dead affinity must not deadlock the session: the bridge falls through to
    // auto-provisioning a dedicated ephemeral agent tab instead of throwing
    // TERMINAL_TAB_CLOSED at a caller that cannot yet rebind.
    assert.strictEqual(resp.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
    assert.strictEqual(resp.data?.tabId, 'tab-created');
  });

  it('3. Auto-provisions a dedicated agent tab for an unbound terminal, never adopting the user active tab', async () => {
    lastSessionCreatedOpts = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      terminalSessionId: 'term-unbound',
    });

    assert.strictEqual(resp.success, true);
    assert.ok(lastSessionCreatedOpts?.tabId, 'must auto-provision and bind a dedicated agent tab for an unbound terminal');
    // The dual-plane MockTabHost.createTab returns a fresh 'tab-created' id; the
    // user's active tab is 'tab-active'. An unbound terminal must never adopt it.
    assert.notStrictEqual(lastSessionCreatedOpts?.tabId, 'tab-active', 'must never adopt the user active tab for an unbound terminal');
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created', 'must bind the dedicated auto-provisioned agent tab');
    assert.strictEqual(resp.data?.tabId, 'tab-created');
  });

  it('4. Validates explicit tabId and rejects non-existent tabId up front with TAB_NOT_FOUND', async () => {
    const resp = await rpcCall('antifan.cli.startSession', {
      tabId: 'tab-does-not-exist',
    });

    assert.strictEqual(resp.success, false);
    assert.ok(resp.error.includes('TAB_NOT_FOUND'));
  });

  it('5. Accepts valid explicit tabId and sets session target tab', async () => {
    lastSessionCreatedOpts = null;
    const resp = await rpcCall('antifan.cli.startSession', {
      tabId: 'tab-alive',
    });

    assert.strictEqual(resp.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-alive');
    assert.strictEqual(resp.data?.tabId, 'tab-alive');
  });

  it('6. Dedicated agent tab auto-provisioned when terminalSessionId and tabId are omitted (Phase 2 isolation)', async () => {
    lastSessionCreatedOpts = null;
    const resp = await rpcCall('antifan.cli.startSession', {});

    assert.strictEqual(resp.success, true);
    // Phase 2: never fall back to global automation target; provision dedicated offscreen/ephemeral tab
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
    assert.strictEqual(resp.data?.tabId, 'tab-created');
  });

  it('7. Canonicalizes positional tab references when starting CLI session', async () => {
    lastSessionCreatedOpts = null;
    const resp1 = await rpcCall('antifan.cli.startSession', {
      tabId: '#1',
    });
    assert.strictEqual(resp1.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-alive');
    assert.strictEqual(resp1.data?.tabId, 'tab-alive');

    lastSessionCreatedOpts = null;
    const resp2 = await rpcCall('antifan.cli.startSession', {
      tabId: '1',
    });
    assert.strictEqual(resp2.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-alive');
    assert.strictEqual(resp2.data?.tabId, 'tab-alive');

    lastSessionCreatedOpts = null;
    const resp3 = await rpcCall('antifan.cli.startSession', {
      tabId: 'tab-1',
    });
    assert.strictEqual(resp3.success, true);
    assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-alive');
    assert.strictEqual(resp3.data?.tabId, 'tab-alive');
  });

  // Capsule pinning at mint: the TerminalManager singleton is swapped for a stub that
  // answers sessionCapsuleId/sessionOwnerKey per case; the resolver stub plays the
  // index.ts routing seam (host + verified capsule).
  const terminalFacts = {
    capsuleById: {} as Record<string, string | undefined>,
    ownerById: {} as Record<string, string | undefined>,
  };
  const terminalStub = {
    on() { return terminalStub; },
    off() { return terminalStub; },
    removeListener() { return terminalStub; },
    listSessions: () => [],
    getActiveSessionId: () => undefined,
    getSession: () => undefined,
    sessionCapsuleId: (id: string) => terminalFacts.capsuleById[id],
    sessionOwnerKey: (id: string) => terminalFacts.ownerById[id],
  };
  let realTerminal: unknown;

  function installTerminalStub(capsuleById: Record<string, string | undefined>, ownerById: Record<string, string | undefined>) {
    terminalFacts.capsuleById = capsuleById;
    terminalFacts.ownerById = ownerById;
    realTerminal = TerminalManager.getInstance();
    TerminalManager.setInstance(terminalStub);
  }

  function restoreTerminalManager() {
    TerminalManager.setInstance(realTerminal);
    resolverStub = undefined;
  }

  function lastCreateTabCall() {
    return mockHost.createTabCalls[mockHost.createTabCalls.length - 1];
  }

  it('8. Mints the anchor on the resolved owning host stamped with the terminal capsule', async () => {
    installTerminalStub(
      { 'term-project': 'capsule-proj' },
      { 'term-project': 'project:proj-a' },
    );
    const altHost = new MockTabHost();
    resolverStub = () => ({ host: altHost as unknown as NativeTabHost, capsuleId: 'capsule-proj' });
    const mintsBefore = mockHost.createTabCalls.length;
    const bindsBefore = mockHost.boundAffinity.length;
    try {
      const resp = await rpcCall('antifan.cli.startSession', { terminalSessionId: 'term-project', terminalGeneration: 5 });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
      // Mint + affinity bind ran on the OWNING host, not the construction host.
      assert.strictEqual(altHost.createTabCalls.length, 1, 'anchor must mint on the resolved host');
      assert.strictEqual(mockHost.createTabCalls.length, mintsBefore, 'construction host must not mint the anchor');
      assert.strictEqual(altHost.boundAffinity.length, 1, 'affinity must bind on the resolved host');
      assert.strictEqual(mockHost.boundAffinity.length, bindsBefore);
      assert.strictEqual(altHost.createTabCalls[0]?.options?.capsuleId, 'capsule-proj');
      assert.strictEqual(altHost.createTabCalls[0]?.options?.offscreen, true);
      assert.strictEqual(altHost.createTabCalls[0]?.options?.ephemeral, true);
    } finally {
      restoreTerminalManager();
    }
  });

  it('9. Filters the default sentinel capsule before minting', async () => {
    installTerminalStub(
      { 'term-default': DEFAULT_TERMINAL_CAPSULE_ID },
      { 'term-default': 'unassigned' },
    );
    resolverStub = (opts) => ({ host: mockHost as unknown as NativeTabHost });
    try {
      const resp = await rpcCall('antifan.cli.startSession', { terminalSessionId: 'term-default' });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
      assert.strictEqual(lastCreateTabCall()?.options?.capsuleId, undefined, 'the sentinel never becomes a tab stamp');
    } finally {
      restoreTerminalManager();
    }
  });

  it('10. Fails closed on a project-claimed terminal with no resolvable capsule', async () => {
    installTerminalStub({}, { 'term-claimed': 'project:proj-orphan' });
    // The resolver found the owning window but no verified capsule for the claim.
    resolverStub = () => ({ host: mockHost as unknown as NativeTabHost });
    const before = mockHost.createTabCalls.length;
    try {
      const resp = await rpcCall('antifan.cli.startSession', { terminalSessionId: 'term-claimed' });
      assert.strictEqual(resp.success, false);
      assert.ok(String(resp.error).includes('TERMINAL_SCOPE_UNRESOLVED'));
      assert.strictEqual(mockHost.createTabCalls.length, before, 'no anchor may mint under an unproven scope');
    } finally {
      restoreTerminalManager();
    }
  });

  it('10b. Mints unpinned for a project-claimed terminal when the resolver vouches it is the boot project', async () => {
    installTerminalStub({}, { 'term-boot': 'project:proj-boot' });
    resolverStub = () => ({ host: mockHost as unknown as NativeTabHost, unpinnedBootProject: true });
    try {
      const resp = await rpcCall('antifan.cli.startSession', { terminalSessionId: 'term-boot' });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
      assert.strictEqual(lastCreateTabCall()?.options?.capsuleId, undefined);
    } finally {
      restoreTerminalManager();
    }
  });

  it('11. Mints an unpinned anchor for an unattributed terminal', async () => {
    installTerminalStub({}, { 'term-daemon': 'unassigned' });
    const bindsBefore = mockHost.boundAffinity.length;
    try {
      const resp = await rpcCall('antifan.cli.startSession', { terminalSessionId: 'term-daemon' });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
      assert.strictEqual(lastCreateTabCall()?.options?.capsuleId, undefined);
      assert.strictEqual(mockHost.boundAffinity.length, bindsBefore + 1, 'daemon-owned sessions still bind affinity');
    } finally {
      restoreTerminalManager();
    }
  });

  it('12. Pins a fresh provision to the caller project capsule on a validated claim', async () => {
    resolverStub = (opts) => opts.projectId === 'proj-x'
      ? { host: mockHost as unknown as NativeTabHost, capsuleId: 'capsule-proj-x' }
      : { host: mockHost as unknown as NativeTabHost };
    try {
      const resp = await rpcCall('antifan.cli.startSession', { projectId: 'proj-x' });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(lastSessionCreatedOpts?.tabId, 'tab-created');
      assert.strictEqual(lastCreateTabCall()?.options?.capsuleId, 'capsule-proj-x');
    } finally {
      restoreTerminalManager();
    }
  });

  it('13. openTab mints on the attributed tab\'s host with that tab\'s capsule', async () => {
    const altHost = new MockTabHost();
    resolverStub = (opts) => opts.boundTabId
      ? { host: altHost as unknown as NativeTabHost, capsuleId: 'capsule-active' }
      : { host: mockHost as unknown as NativeTabHost };
    try {
      const resp = await rpcCall('antifan.openTab', { url: 'https://example.test', activate: false });
      assert.strictEqual(resp.success, true);
      assert.strictEqual(resp.data?.tabId, 'tab-created');
      assert.strictEqual(altHost.createTabCalls.length, 1);
      assert.strictEqual(altHost.createTabCalls[0]?.options?.capsuleId, 'capsule-active');
    } finally {
      restoreTerminalManager();
    }
  });
});
