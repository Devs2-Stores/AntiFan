// The trusted hover runs an input-bearing focus gate first; that gate auto-dismisses popups
// unless the request (or the tab) opted out, so the opt-out has to reach the gate script.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';

function harness() {
  const isolatedScripts: string[] = [];
  const wc: any = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://shop.example.com/',
    executeJavaScript: async () => undefined,
    mainFrame: {
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) => {
        isolatedScripts.push(scripts[0]?.code || '');
        // Refuse the gate so the action stops right after it: only the script matters here.
        return { ok: false, error: 'stop after the gate', code: 'NOT_ACTIONABLE' };
      },
    },
  };
  const tab: any = { state: { id: 'tab-1', url: 'https://shop.example.com/' } };
  const host = new TabAutomationHost({
    getTabWebContents: () => wc,
    getTabRecord: () => tab,
    getAutomationTabId: () => 'tab-1',
    getActiveTabId: () => 'tab-1',
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    semanticRefRegistry: new SemanticRefRegistry(),
    runTargetOperation: async <T>(_tabId: string, _paneId: unknown, op: () => Promise<T>) => op(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    getAllTabs: () => [][Symbol.iterator](),
  } as any);
  return { host, isolatedScripts };
}

describe('trusted hover focus gate', () => {
  it('carries noAutoDismiss and the device preset into the gate script', async () => {
    const { host, isolatedScripts } = harness();
    await host.dispatchAgentAction('hover', { selector: '#menu', noAutoDismiss: true, presetId: 'iphone-15', tabId: 'tab-1' } as any).catch(() => undefined);
    const gate = isolatedScripts.find((s) => s.includes('"action":"focus"'));
    assert.ok(gate, 'the hover ran its focus gate');
    assert.ok(gate.includes('"noAutoDismiss":true'), 'the opt-out reaches the gate');
    assert.ok(gate.includes('"presetId":"iphone-15"'));
    assert.ok(gate.includes('"skipFocus":true'), 'a hover never moves focus');
  });
});
