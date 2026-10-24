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

function buildHost(liveGeneration: number, clicks: Array<Record<string, unknown>>): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: 'https://spa.example/' }],
    hasTab: (id) => id === 'tab-1',
    getTabUrl: () => 'https://spa.example/',
    getDocumentGeneration: () => liveGeneration,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => ({}),
    agentClick: async (params) => {
      clicks.push({ ...params });
      return true;
    },
    agentHover: async () => true,
    agentMove: async () => true,
    executeActionSequence: async (args) => ({ executedCount: 1, results: [], tabId: args.tabId }),
  };
}

describe('document-generation fence for coordinate-only actions (K6)', () => {
  it('a click at x,y after the generation moved goes through on the live generation', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const res = await port.agentClick({ x: 100, y: 200 }, TARGET);
    assert.equal(res.clicked, true);
    assert.equal(clicks.length, 1);
    assert.deepEqual(res.documentGenerationRebased, { from: 1, to: 5 });
  });

  it('a click by selector after the generation moved is still TARGET_STALE', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(
      () => port.agentClick({ selector: '#buy' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE' && err.details?.cause === 'dom-drift'
    );
    assert.equal(clicks.length, 0);
  });

  it('a click by ref after the generation moved is still TARGET_STALE', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(
      () => port.agentClick({ ref: '@e3' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.equal(clicks.length, 0);
  });

  it('x,y combined with a selector keeps the fence', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(
      () => port.agentClick({ selector: '#buy', x: 1, y: 2 }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });

  it('hover at x,y rebases the same way', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const res = await port.agentHover({ x: 10, y: 20 }, TARGET);
    assert.equal(res.success, true);
  });

  it('a sequence of coordinate clicks passes; a selector step keeps the fence', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await port.sequence({ actions: [{ type: 'click', x: 5, y: 6 }, { type: 'wait', ms: 10 }] }, TARGET);
    await assert.rejects(
      () => port.sequence({ actions: [{ type: 'click', selector: '#buy' }] }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });
});
