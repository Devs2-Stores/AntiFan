import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';

/**
 * The bridge is built on the bootstrap window's host, but an agent's tab can live on another project
 * window and its shell can be evicted from the affinity map. Both must still resolve, and the user
 * plane must stay out of a shell an agent holds. An attachment itself reaches only the split panes
 * of the terminal its bound tab is rooted in.
 */
class GateHost extends EventEmitter {
  constructor(
    private readonly homes: Record<string, string>,
    private readonly affinityAlive: string[] = []
  ) {
    super();
  }
  getTabHomeTerminalSession(tabId: string): string | undefined {
    return this.homes[tabId];
  }
  getTerminalAgentAffinity(terminalId: string): { status: 'alive' } | undefined {
    return this.affinityAlive.includes(terminalId) ? { status: 'alive' } : undefined;
  }
}

interface BridgeGateInternals {
  attachmentRegistry: { getRecord(id: string): { tabId: string; originTerminalSessionId?: string } | undefined };
  socketAttachmentIds: Map<unknown, string>;
  socketMobileGrants: Map<unknown, { allowedScopes: string[] }>;
  clients: Set<unknown>;
  terminalWriteForAttachment(sessionId: string, boundAttachmentId?: string): boolean;
  terminalFrameGate(terminalSessionId?: string): (client: unknown) => boolean;
  userPlaneMayReachTerminal(terminalSessionId?: string): boolean;
}

/** An open socket double that records the terminal sessions whose data frames reached it. */
function recordingSocket(): { socket: unknown; sessions: string[] } {
  const sessions: string[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(raw: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
      const frame = JSON.parse(String(raw)) as { event?: string; data?: { sessionId?: string } };
      if (frame.event === 'antifan:terminal:data' && frame.data?.sessionId) sessions.push(frame.data.sessionId);
      if (typeof cb === 'function') cb();
    },
    on() {},
    once() {},
    terminate() {},
    close() {},
  };
  return { socket, sessions };
}

type SeededSession = { id: string; sessionGeneration: number; state: string; disposed: boolean; splitOf?: string };

function makeBridge(
  bootstrap: GateHost,
  record: { tabId: string; originTerminalSessionId?: string } = { tabId: 'tab-b' }
): { server: BridgeServer; gate: BridgeGateInternals } {
  const server = new BridgeServer(bootstrap as unknown as NativeTabHost, 0, false);
  const gate = server as unknown as BridgeGateInternals;
  gate.attachmentRegistry = { getRecord: (id) => (id === 'att-b' ? record : undefined) };
  return { server, gate };
}

/** Seed the process-wide manager with raw session rows, and remove them again. */
function seedSessions(rows: Array<{ id: string; splitOf?: string; state?: string; disposed?: boolean }>): () => void {
  const internal = TerminalManager.getInstance() as unknown as { sessions: Map<string, SeededSession> };
  for (const row of rows) {
    internal.sessions.set(row.id, { id: row.id, sessionGeneration: 1, state: row.state ?? 'running', disposed: row.disposed ?? false, splitOf: row.splitOf });
  }
  return () => {
    for (const row of rows) internal.sessions.delete(row.id);
  };
}

describe('Bridge terminal gates across project windows', () => {
  it('asks the host that owns the attachment tab, and admits only the split panes under its home terminal', () => {
    const restore = seedSessions([
      { id: 'gate-home' },
      { id: 'gate-pane', splitOf: 'gate-home' },
      { id: 'gate-pane-closed', splitOf: 'gate-home', state: 'closed' },
      { id: 'gate-other' },
      { id: 'gate-other-pane', splitOf: 'gate-other' },
    ]);
    const bootstrap = new GateHost({});
    const windowB = new GateHost({ 'tab-b': 'gate-home' });
    const { server, gate } = makeBridge(bootstrap);
    try {
      assert.strictEqual(gate.terminalWriteForAttachment('gate-pane', 'att-b'), false, 'without a resolver only the bootstrap host is asked, and it knows no home for the tab');
      server.setTabHostResolver((tabId) => (tabId === 'tab-b' ? (windowB as unknown as NativeTabHost) : undefined));
      assert.strictEqual(gate.terminalWriteForAttachment('gate-pane', 'att-b'), true);
      assert.strictEqual(gate.terminalWriteForAttachment('gate-home', 'att-b'), false, 'the shell the agent runs in is never drivable');
      assert.strictEqual(gate.terminalWriteForAttachment('gate-pane-closed', 'att-b'), false, 'a closed pane is gone');
      assert.strictEqual(gate.terminalWriteForAttachment('gate-other', 'att-b'), false, 'another base terminal stays refused');
      assert.strictEqual(gate.terminalWriteForAttachment('gate-other-pane', 'att-b'), false, 'a pane of another terminal stays refused');
      assert.strictEqual(gate.terminalWriteForAttachment('gate-missing', 'att-b'), false);
      assert.strictEqual(gate.terminalWriteForAttachment('gate-pane', 'att-unknown'), false);

      // The same predicate decides which terminal data frames a bound client receives.
      const client = {};
      gate.socketAttachmentIds.set(client, 'att-b');
      assert.strictEqual(gate.terminalFrameGate('gate-pane')(client), true);
      assert.strictEqual(gate.terminalFrameGate('gate-home')(client), false);
      assert.strictEqual(gate.terminalFrameGate('gate-other-pane')(client), false);
    } finally {
      server.dispose();
      restore();
    }
  });

  it('resolves the home through a split the tab names, falls back to the minting terminal, and refuses a caller with no home', () => {
    const restore = seedSessions([
      { id: 'gate-home' },
      { id: 'gate-pane', splitOf: 'gate-home' },
      { id: 'gate-pane-two', splitOf: 'gate-home' },
    ]);
    try {
      // The tab names one of the splits: the home is its parent.
      const viaSplit = makeBridge(new GateHost({ 'tab-b': 'gate-pane' }));
      try {
        assert.strictEqual(viaSplit.gate.terminalWriteForAttachment('gate-pane-two', 'att-b'), true);
        assert.strictEqual(viaSplit.gate.terminalWriteForAttachment('gate-home', 'att-b'), false);
      } finally {
        viaSplit.server.dispose();
      }

      // The tab names nothing live: the terminal the attachment was minted from backs it up.
      const viaOrigin = makeBridge(new GateHost({ 'tab-b': 'gate-dead' }), { tabId: 'tab-b', originTerminalSessionId: 'gate-home' });
      try {
        assert.strictEqual(viaOrigin.gate.terminalWriteForAttachment('gate-pane', 'att-b'), true);
      } finally {
        viaOrigin.server.dispose();
      }

      // No home at all: nothing is reachable.
      const homeless = makeBridge(new GateHost({}));
      try {
        assert.strictEqual(homeless.gate.terminalWriteForAttachment('gate-pane', 'att-b'), false);
      } finally {
        homeless.server.dispose();
      }
    } finally {
      restore();
    }
  });

  it('keeps the user plane out of every shell an agent holds, wherever its affinity lives', () => {
    const bootstrap = new GateHost({}, ['terminal-affine']);
    const { server, gate } = makeBridge(bootstrap);
    try {
      // No directory seam: the bootstrap host's own affinity map is all the bridge can see.
      assert.strictEqual(gate.userPlaneMayReachTerminal('terminal-affine'), false);
      assert.strictEqual(gate.userPlaneMayReachTerminal('terminal-evicted'), true);

      // Main's directory also knows shells evicted from the map and agents on other windows.
      server.setAgentTerminalHold((id) => id === 'terminal-evicted' || id === 'terminal-elsewhere');
      assert.strictEqual(gate.userPlaneMayReachTerminal('terminal-evicted'), false);
      assert.strictEqual(gate.userPlaneMayReachTerminal('terminal-elsewhere'), false);
      assert.strictEqual(gate.userPlaneMayReachTerminal('terminal-user'), true);
      assert.strictEqual(gate.userPlaneMayReachTerminal(undefined), false);
    } finally {
      server.dispose();
    }
  });

  it('delivers each terminal data frame only to the clients its gate admits', () => {
    const restore = seedSessions([
      { id: 'fan-home' },
      { id: 'fan-pane', splitOf: 'fan-home' },
      { id: 'fan-other' },
      { id: 'fan-other-pane', splitOf: 'fan-other' },
      { id: 'fan-closed-pane', splitOf: 'fan-home', state: 'closed' },
    ]);
    const host = new GateHost({ 'tab-b': 'fan-home' });
    const { server, gate } = makeBridge(host);
    try {
      server.setAgentTerminalHold((id) => id === 'fan-other');
      const agent = recordingSocket();
      const user = recordingSocket();
      const phoneSync = recordingSocket();
      const phoneNoSync = recordingSocket();
      for (const s of [agent, user, phoneSync, phoneNoSync]) gate.clients.add(s.socket);
      gate.socketAttachmentIds.set(agent.socket, 'att-b');
      gate.socketMobileGrants.set(phoneSync.socket, { allowedScopes: ['terminal.sync'] });
      gate.socketMobileGrants.set(phoneNoSync.socket, { allowedScopes: ['tabs.view'] });

      for (const sessionId of ['fan-home', 'fan-pane', 'fan-other', 'fan-other-pane', 'fan-closed-pane', 'fan-missing']) {
        server.broadcastEvent('antifan:terminal:data', { sessionId, data: 'x', seq: 1 });
      }

      assert.deepStrictEqual(agent.sessions, ['fan-pane'], 'an attachment reads only the live split panes of its home terminal');
      // The user-plane predicate is `!agentHoldsTerminal(id)` (preserved from before `terminalFrameGate`),
      // so closed, missing and split-of-held ids that carry no hold of their own pass through.
      const userPlane = ['fan-home', 'fan-pane', 'fan-other-pane', 'fan-closed-pane', 'fan-missing'];
      assert.deepStrictEqual(user.sessions, userPlane, 'the user plane reads every terminal no agent holds');
      assert.deepStrictEqual(phoneSync.sessions, userPlane, 'a companion with terminal.sync sees the user plane');
      assert.deepStrictEqual(phoneNoSync.sessions, [], 'a companion without terminal.sync receives no terminal data');
    } finally {
      server.dispose();
      restore();
    }
  });
});
