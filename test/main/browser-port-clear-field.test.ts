import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

function buildHost(typed: Array<Record<string, unknown>>): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: 'https://shop.example/' }],
    hasTab: (id) => id === 'tab-1',
    getTabUrl: () => 'https://shop.example/',
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => ({}),
    agentType: async (params) => {
      typed.push({ ...params });
      return true;
    },
  };
}

describe('emptying a field with agentType', () => {
  it('forwards clear:true with empty text when the text is left out', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    const res = await port.agentType({ selector: '#q', clear: true }, TARGET);
    assert.equal(res.typed, true);
    assert.equal(typed.length, 1);
    assert.equal(typed[0]?.text, '');
    assert.equal(typed[0]?.clear, true);
  });

  it('forwards clear:true with text:"" unchanged', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    await port.agentType({ selector: '#q', text: '', clear: true }, TARGET);
    assert.equal(typed[0]?.text, '');
    assert.equal(typed[0]?.clear, true);
  });

  it('still refuses a call with neither text, fromEnv nor clear:true', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    for (const args of [{ selector: '#q' }, { selector: '#q', clear: false }, { selector: '#q', text: '', clear: false }]) {
      await assert.rejects(
        () => port.agentType(args, TARGET),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /text/.test(err.message)
      );
    }
    assert.equal(typed.length, 0);
  });
});
