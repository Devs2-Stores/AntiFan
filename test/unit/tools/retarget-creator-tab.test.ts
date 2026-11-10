import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

const target: BrowserTarget = {
  projectId: 'proj',
  workspaceId: 'ws',
  runtimeId: 'rt',
  tabId: 'tab-pool',
  browserEpoch: 1,
  documentGeneration: 1,
};

/** A host where `tab-created` lives outside the pool of the tab the host currently has bound. */
function makePort() {
  const bound: string[] = [];
  const host = {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-pool' }, { id: 'tab-created' }, { id: 'tab-user' }],
    getAutomationTabId: () => 'tab-pool',
    setAutomationTabId: (id: string) => { bound.push(id); },
    resolveTargetTabId: (id: string) => id,
    getManagedTabIds: () => new Set(['tab-pool']),
    isTabAllowed: (primary: string, requested: string) => primary === requested,
    getDocumentGeneration: () => 1,
  } as unknown as BrowserHostPort;
  return { port: new BrowserControlPort(host), bound };
}

const mismatch = (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH';

describe('BrowserControlPort rebind and retarget to a tab the caller created', () => {
  it('rebinds to the creator tab outside the pool, and to no other tab', () => {
    const { port } = makePort();
    assert.throws(() => port.rebindTarget({ tabId: 'tab-created' }, target), mismatch);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-created' }, target, { creatorTabId: 'tab-user' }), mismatch);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target, { creatorTabId: 'tab-created' }), mismatch);
    const res = port.rebindTarget({ tabId: 'tab-created' }, target, { creatorTabId: 'tab-created' });
    assert.equal(res.success, true);
    assert.equal(res.tabId, 'tab-created');
  });

  it('retargets the automation tab to the creator tab outside the pool, and to no other tab', () => {
    const { port, bound } = makePort();
    assert.throws(() => port.setAutomationTarget('tab-created'), mismatch);
    assert.throws(() => port.setAutomationTarget('tab-user', { creatorTabId: 'tab-created' }), mismatch);
    assert.deepEqual(bound, []);
    assert.equal(port.setAutomationTarget('tab-created', { creatorTabId: 'tab-created' }).success, true);
    assert.deepEqual(bound, ['tab-created']);
  });
});
