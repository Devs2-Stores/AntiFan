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
  terminalWriteForAttachment(sessionId: string, boundAttachmentId?: string): boolean;
  isClientAuthorizedForTerminal(client: unknown, terminalSessionId?: string): boolean;
  userPlaneMayReachTerminal(terminalSessionId?: string): boolean;
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
      assert.strictEqual(gate.isClientAuthorizedForTerminal(client, 'gate-pane'), true);
      assert.strictEqual(gate.isClientAuthorizedForTerminal(client, 'gate-home'), false);
      assert.strictEqual(gate.isClientAuthorizedForTerminal(client, 'gate-other-pane'), false);
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
});
