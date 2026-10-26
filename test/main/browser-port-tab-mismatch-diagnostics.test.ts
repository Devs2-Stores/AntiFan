import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { SHARE_TAB_GUIDANCE, SHARE_TAB_MENU_LABEL } from '../../src/shared/tab-sharing';
import { classifyTargetStale } from '../../src/main/tools/capability-transport';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-bound',
  browserEpoch: 1,
  documentGeneration: 1,
};

function buildHost(overrides: Partial<BrowserHostPort> = {}): BrowserHostPort {
  const tabs = ['tab-bound', 'tab-user'];
  return {
    getTabList: () => tabs.map((id) => ({ id, url: 'https://shop.example/' })),
    hasTab: (id) => tabs.includes(id ?? ''),
    getTabUrl: () => 'https://shop.example/',
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => ({}),
    agentClick: async () => true,
    closeTab: () => true,
    isTabAllowed: () => false,
    getAutomationTabId: () => 'tab-bound',
    switchTab: () => true,
    ...overrides,
  };
}

describe('TARGET_MISMATCH diagnostics (K2, K19)', () => {
  it('menu label is the exact context-menu text', () => {
    assert.equal(SHARE_TAB_MENU_LABEL, 'Cho agent của project này dùng tab');
    assert.ok(SHARE_TAB_GUIDANCE.includes(SHARE_TAB_MENU_LABEL));
    assert.ok(SHARE_TAB_GUIDANCE.includes('anti.browser.rebind_target'));
  });

  it('closeTab refusal carries cause, ownership and the managed sample', () => {
    const host = buildHost({
      describeTabOwnership: (bound, target) => ({ boundLive: true, targetLive: true, targetOwner: 'other-session', boundTabId: bound, targetTabId: target }),
      getManagedTabIds: () => new Set(['tab-bound', 'tab-2', 'tab-3']),
    });
    const port = new BrowserControlPort(host);
    assert.throws(
      () => port.closeTab('tab-user', { target: TARGET }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'TARGET_MISMATCH');
        assert.ok(err.message.includes(SHARE_TAB_MENU_LABEL));
        assert.equal(err.details?.cause, 'not-in-session-pool');
        assert.deepEqual(err.details?.managedTabIds, ['tab-bound', 'tab-2', 'tab-3']);
        assert.equal(err.details?.managedTotal, 3);
        assert.ok(JSON.stringify(err.details?.ownership).includes('"targetOwner":"other-session"'));
        assert.equal(err.details?.shareRecovery, SHARE_TAB_GUIDANCE);
        return true;
      }
    );
  });

  it('a throwing diagnostic never changes the refusal', () => {
    const host = buildHost({
      describeTabOwnership: () => {
        throw new Error('boom');
      },
    });
    const port = new BrowserControlPort(host);
    assert.throws(
      () => port.closeTab('tab-user', { target: TARGET }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && err.details?.cause === 'not-in-session-pool'
    );
  });

  it('closing a co-managed tab is still allowed', () => {
    const closed: string[] = [];
    const host = buildHost({
      isTabAllowed: () => true,
      closeTab: (id) => {
        closed.push(id);
        return true;
      },
    });
    const port = new BrowserControlPort(host);
    assert.equal(port.closeTab('tab-user', { target: TARGET }).closed, true);
    assert.deepEqual(closed, ['tab-user']);
  });

  it('retarget, rebind and switch refusals name the share menu entry', () => {
    const port = new BrowserControlPort(buildHost());
    assert.throws(
      () => port.rebindTarget({ tabId: 'tab-user' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && err.message.includes(SHARE_TAB_MENU_LABEL)
    );
    assert.throws(
      () => port.switchTab('tab-user', { target: TARGET }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && err.message.includes(SHARE_TAB_MENU_LABEL)
    );
  });

  it('TARGET_REQUIRED with no automation tab names the share menu entry', async () => {
    const port = new BrowserControlPort(buildHost({ createTab: undefined, getAutomationTabId: () => null }));
    await assert.rejects(
      () => port.eval(undefined as unknown as BrowserTarget, '1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED' && String(err.details?.recovery).includes(SHARE_TAB_MENU_LABEL)
    );
  });
});

describe('TARGET_STALE causes (K7)', () => {
  it('classifies explicit causes and derives the rest', () => {
    assert.equal(classifyTargetStale({ cause: 'tab-gone' }, 'x'), 'tab-gone');
    assert.equal(classifyTargetStale({ reservedForClose: true }, 'x'), 'closing');
    assert.equal(classifyTargetStale({ targetDocumentGeneration: 1, liveDocumentGeneration: 2 }, 'x'), 'dom-drift');
  });

  it('a vanished bound tab is reported with cause tab-gone', async () => {
    const port = new BrowserControlPort(buildHost({ hasTab: () => false, getFailoverTargetTab: () => undefined }));
    await assert.rejects(
      () => port.agentClick({ selector: 'button' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE' && err.details?.cause === 'tab-gone'
    );
  });

  it('generation drift is reported with cause dom-drift and both generations', async () => {
    const port = new BrowserControlPort(buildHost({ getDocumentGeneration: () => 4 }));
    await assert.rejects(
      () => port.agentClick({ ref: '@e1' }, TARGET),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'TARGET_STALE');
        assert.equal(err.details?.cause, 'dom-drift');
        assert.equal(err.details?.targetDocumentGeneration, 1);
        assert.equal(err.details?.liveDocumentGeneration, 4);
        return true;
      }
    );
  });
});
