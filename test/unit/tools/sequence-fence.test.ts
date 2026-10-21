import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { sequenceDependsOnPriorDocument } from '../../../src/main/tools/sequence-fence';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

describe('sequenceDependsOnPriorDocument', () => {
  it('treats a sequence that navigates first as independent of the prior document', () => {
    assert.equal(sequenceDependsOnPriorDocument([
      { type: 'navigate', url: 'https://shop.test/' },
      { type: 'click', selector: '.buy' },
    ]), false);
  });

  it('treats a sequence of only waits and screenshots as independent', () => {
    assert.equal(sequenceDependsOnPriorDocument([
      { type: 'wait', waitMs: 200 },
      { type: 'screenshot' },
      { type: 'awaitNetwork' },
    ]), false);
  });

  it('still fences a selector click', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'click', selector: '.buy' }]), true);
  });

  it('still fences a ref click', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'click', ref: '@e3' }]), true);
  });

  it('still fences a coordinate click', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'click', x: 10, y: 20 }]), true);
  });

  it('fences a click that precedes the navigation', () => {
    assert.equal(sequenceDependsOnPriorDocument([
      { type: 'click', selector: '.buy' },
      { type: 'navigate', url: 'https://shop.test/' },
    ]), true);
  });

  it('fences a wait that precedes a selector action on the old document', () => {
    assert.equal(sequenceDependsOnPriorDocument([
      { type: 'wait', waitMs: 10 },
      { type: 'hover', selector: '.menu' },
    ]), true);
  });

  it('treats an unknown step kind as dependent', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'teleport' }]), true);
    assert.equal(sequenceDependsOnPriorDocument([{}]), true);
  });

  it('treats dismissModals as dependent because it inspects the live document', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'dismissModals' }]), true);
  });

  it('treats a snapshot of an @eN ref as dependent but a whole-page snapshot as independent', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'snapshot', ref: '@e2' }]), true);
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'snapshot' }]), false);
  });

  it('fences a pressKey that addresses an element', () => {
    assert.equal(sequenceDependsOnPriorDocument([{ type: 'pressKey', key: 'Enter', selector: 'input' }]), true);
  });
});

describe('BrowserControlPort.sequence document fence', () => {
  const target = (documentGeneration: number): BrowserTarget => ({
    projectId: 'proj',
    workspaceId: 'ws',
    runtimeId: 'rt',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration,
  });

  function makePort(liveGeneration: number): { port: BrowserControlPort; executed: Array<Record<string, unknown>> } {
    const executed: Array<Record<string, unknown>> = [];
    const host = {
      hasTab: (id: string) => id === 'tab-1',
      getTabList: () => [{ id: 'tab-1', url: 'https://shop.test/' }],
      isTabAllowed: () => true,
      getDocumentGeneration: () => liveGeneration,
      executeActionSequence: async (params: Record<string, unknown>) => {
        executed.push(params);
        return { success: true };
      },
    } as unknown as BrowserHostPort;
    return { port: new BrowserControlPort(host), executed };
  }

  it('runs a wait/screenshot sequence under generation drift', async () => {
    const { port, executed } = makePort(5);
    const result = await port.sequence({ actions: [{ type: 'wait', waitMs: 5 }, { type: 'screenshot' }] }, target(2)) as Record<string, unknown>;
    assert.equal(result['success'], true);
    assert.equal(result['liveDocumentGeneration'], 5);
    assert.equal(executed.length, 1);
  });

  it('runs a navigate-first sequence under generation drift', async () => {
    const { port, executed } = makePort(5);
    await port.sequence({ actions: [{ type: 'navigate', url: 'https://shop.test/x' }, { type: 'click', selector: '.buy' }] }, target(2));
    assert.equal(executed.length, 1);
  });

  it('refuses a selector click under generation drift with a recovery', async () => {
    const { port, executed } = makePort(5);
    await assert.rejects(
      port.sequence({ actions: [{ type: 'click', selector: '.buy' }] }, target(2)),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'TARGET_STALE'
        && err.details?.dependsOnPriorDocument === true
        && err.details?.liveDocumentGeneration === 5
        && err.details?.targetDocumentGeneration === 2
        && typeof err.details?.recovery === 'string'
    );
    assert.equal(executed.length, 0, 'the host must never run a fenced sequence');
  });

  it('refuses a coordinate click under generation drift', async () => {
    const { port, executed } = makePort(5);
    await assert.rejects(
      port.sequence({ actions: [{ type: 'click', x: 4, y: 9 }] }, target(2)),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.equal(executed.length, 0);
  });

  it('does not rebase an independent sequence onto a tab that does not exist', async () => {
    const { port, executed } = makePort(5);
    const gone = { ...target(2), tabId: 'tab-gone' };
    await assert.rejects(
      port.sequence({ actions: [{ type: 'wait', waitMs: 1 }] }, gone),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.equal(executed.length, 0);
  });
});
