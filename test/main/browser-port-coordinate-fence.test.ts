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

function buildHost(liveGeneration: number, clicks: Array<Record<string, unknown>>, calls: string[] = []): BrowserHostPort {
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
    agentType: async () => { calls.push('type'); return true; },
    agentScroll: async () => { calls.push('scroll'); return true; },
    agentHighlight: async () => { calls.push('highlight'); return true; },
    sendKeyboardPress: async (params) => { calls.push('key'); return { success: true, key: params.key, modifiers: [] }; },
    uploadFileInput: async () => { calls.push('upload'); return { success: true, uploadedCount: 1 }; },
    dropFiles: async () => { calls.push('drop'); return { success: true, droppedCount: 1 }; },
    agentDrag: async () => { calls.push('drag'); return { success: true }; },
    agentHover: async () => true,
    agentMove: async () => true,
    executeActionSequence: async (args) => ({ executedCount: 1, results: [], tabId: args.tabId }),
  };
}

const REBASED = { from: 1, to: 5 };
const isStaleDrift = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'TARGET_STALE' && err.details?.cause === 'dom-drift';

describe('document-generation fence: only a semantic @eN ref keeps it', () => {
  it('a click at x,y after the generation moved goes through on the live generation', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const res = await port.agentClick({ x: 100, y: 200 }, TARGET);
    assert.equal(res.clicked, true);
    assert.equal(clicks.length, 1);
    assert.deepEqual(res.documentGenerationRebased, REBASED);
  });

  it('a click by CSS selector after the generation moved runs on the live generation and says so', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const res = await port.agentClick({ selector: '#buy' }, TARGET);
    assert.equal(res.clicked, true);
    assert.equal(clicks.length, 1);
    assert.deepEqual(res.documentGenerationRebased, REBASED);
  });

  it('an unchanged generation reports no rebase', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(1, clicks));
    const res = await port.agentClick({ selector: '#buy' }, TARGET);
    assert.equal(res.documentGenerationRebased, undefined);
  });

  it('a click by ref after the generation moved is still TARGET_STALE', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(() => port.agentClick({ ref: '@e3' }, TARGET), isStaleDrift);
    assert.equal(clicks.length, 0);
  });

  it('an @eN ref in the selector field keeps the fence', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(() => port.agentClick({ selector: '@e3' }, TARGET), isStaleDrift);
    assert.equal(clicks.length, 0);
  });

  it('x,y combined with an @eN ref keeps the fence', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    await assert.rejects(() => port.agentClick({ ref: '@e3', x: 1, y: 2 }, TARGET), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');
  });

  it('hover at x,y rebases the same way', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const res = await port.agentHover({ x: 10, y: 20 }, TARGET);
    assert.equal(res.success, true);
    assert.deepEqual(res.documentGenerationRebased, REBASED);
  });

  it('type, scroll, highlight and key press by selector or without an address rebase', async () => {
    const calls: string[] = [];
    const port = new BrowserControlPort(buildHost(5, [], calls));
    assert.deepEqual((await port.agentType({ selector: 'input[name=q]', text: 'hi' }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual((await port.agentScroll({ selector: '.list', deltaY: 300 }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual((await port.agentHighlight({ selector: '.hero' }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual((await port.keyboardPress({ key: 'Enter' }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual(calls, ['type', 'scroll', 'highlight', 'key']);
  });

  it('upload, drop and drag by selector rebase', async () => {
    const calls: string[] = [];
    const port = new BrowserControlPort(buildHost(5, [], calls));
    assert.deepEqual((await port.uploadFileInput({ refOrSelector: 'input[type=file]', filePaths: ['a.png'] }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual((await port.dropFiles({ refOrSelector: '.dropzone', filePaths: ['a.png'] }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual((await port.agentDrag({ fromSelector: '.a', toSelector: '.b' }, TARGET)).documentGenerationRebased, REBASED);
    assert.deepEqual(calls, ['upload', 'drop', 'drag']);
  });

  it('every ref-carrying field keeps the fence when it holds an @eN ref', async () => {
    const calls: string[] = [];
    const port = new BrowserControlPort(buildHost(5, [], calls));
    await assert.rejects(() => port.agentType({ ref: '@e2', text: 'x' }, TARGET), isStaleDrift);
    await assert.rejects(() => port.agentScroll({ ref: '@e2' }, TARGET), isStaleDrift);
    await assert.rejects(() => port.agentHighlight({ ref: '@e2' }, TARGET), isStaleDrift);
    await assert.rejects(() => port.uploadFileInput({ refOrSelector: '@e7', filePaths: ['a.png'] }, TARGET), isStaleDrift);
    await assert.rejects(() => port.dropFiles({ refOrSelector: '@e7', filePaths: ['a.png'] }, TARGET), isStaleDrift);
    await assert.rejects(() => port.agentDrag({ fromRef: '@e1', toSelector: '.b' }, TARGET), isStaleDrift);
    await assert.rejects(() => port.agentDrag({ fromSelector: '.a', toSelector: '@e5' }, TARGET), isStaleDrift);
    assert.deepEqual(calls, [], 'a refused call never reaches the host');
  });

  it('a sequence of selector/coordinate steps runs and reports the rebase; an @eN step keeps the fence', async () => {
    const clicks: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(5, clicks));
    const coordinates = await port.sequence({ actions: [{ type: 'click', x: 5, y: 6 }, { type: 'wait', ms: 10 }] }, TARGET) as Record<string, unknown>;
    assert.deepEqual(coordinates.documentGenerationRebased, REBASED);
    const selector = await port.sequence({ actions: [{ type: 'click', selector: '#buy' }] }, TARGET) as Record<string, unknown>;
    assert.deepEqual(selector.documentGenerationRebased, REBASED);
    await assert.rejects(() => port.sequence({ actions: [{ type: 'click', ref: '@e9' }] }, TARGET), isStaleDrift);
  });

  it('refuses a sequence step without a known type before dispatch, naming the step and the valid types', async () => {
    const port = new BrowserControlPort(buildHost(1, []));
    await assert.rejects(
      () => port.sequence({ actions: [{ type: 'wait', ms: 1 }, { selector: '#x' }] }, TARGET),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'INVALID_ARGUMENT'
        && err.details?.stepIndex === 1
        && Array.isArray(err.details?.validTypes)
        && (err.details?.validTypes as string[]).includes('click')
    );
    await assert.rejects(
      () => port.sequence({ actions: [{ type: 'teleport' }] }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.details?.stepIndex === 0 && err.details?.receivedType === 'teleport'
    );
  });
});
