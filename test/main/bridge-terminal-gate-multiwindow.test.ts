import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';

/**
 * The bridge is built on the bootstrap window's host, but an agent's tab can live on another project
 * window and its shell can be evicted from the affinity map. Both must still resolve, and the user
 * plane must stay out of a shell an agent holds.
 */
class GateHost extends EventEmitter {
  constructor(
    private readonly allowed: Record<string, string[]>,
    private readonly affinityAlive: string[] = []
  ) {
    super();
  }
  isTerminalAllowedForTab(tabId: string, terminalId: string): boolean {
    return (this.allowed[tabId] ?? []).includes(terminalId);
  }
  getTerminalAgentAffinity(terminalId: string): { status: 'alive' } | undefined {
    return this.affinityAlive.includes(terminalId) ? { status: 'alive' } : undefined;
  }
}

interface BridgeGateInternals {
  attachmentRegistry: { getRecord(id: string): { tabId: string } | undefined };
  terminalWriteForAttachment(sessionId: string, boundAttachmentId?: string): boolean;
  userPlaneMayReachTerminal(terminalSessionId?: string): boolean;
}

function makeBridge(bootstrap: GateHost): { server: BridgeServer; gate: BridgeGateInternals } {
  const server = new BridgeServer(bootstrap as unknown as NativeTabHost, 0, false);
  const gate = server as unknown as BridgeGateInternals;
  gate.attachmentRegistry = { getRecord: (id) => (id === 'att-b' ? { tabId: 'tab-b' } : undefined) };
  return { server, gate };
}

describe('Bridge terminal gates across project windows', () => {
  it('asks the host that owns the attachment tab, not the bootstrap host', () => {
    const bootstrap = new GateHost({});
    const windowB = new GateHost({ 'tab-b': ['terminal-7'] });
    const { server, gate } = makeBridge(bootstrap);
    try {
      assert.strictEqual(gate.terminalWriteForAttachment('terminal-7', 'att-b'), false, 'without a resolver only the bootstrap host is asked');
      server.setTabHostResolver((tabId) => (tabId === 'tab-b' ? (windowB as unknown as NativeTabHost) : undefined));
      assert.strictEqual(gate.terminalWriteForAttachment('terminal-7', 'att-b'), true);
      assert.strictEqual(gate.terminalWriteForAttachment('terminal-8', 'att-b'), false, 'a shell the tab neither owns nor minted stays refused');
    } finally {
      server.dispose();
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
