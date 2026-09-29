import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

type TestHost = any;

const OLD = Date.now() - 60 * 60 * 1000;

function makeHost(registry: unknown): { host: TestHost; closed: string[] } {
  const closed: string[] = [];
  const host: TestHost = Object.create(NativeTabHost.prototype);
  host.isDisposed = false;
  host.agentTabReapIdleMs = 10 * 60 * 1000;
  host.terminalAgentAffinity = new Map();
  host.sessionTabPools = new Map();
  host.automationHost = { agentWorkingRefs: new Map() };
  host.controlPlane = registry === undefined ? undefined : { runs: { attachments: registry } };
  host.tabs = new Map([
    ['orphan', { state: { offscreen: true, url: 'about:blank' }, lastActiveAt: OLD }],
    ['claimed', { state: { offscreen: true, url: 'about:blank' }, lastActiveAt: OLD }],
    ['visible', { state: { offscreen: false, url: 'https://x.test' }, lastActiveAt: OLD }],
  ]);
  host.isPageReservedForClose = () => false;
  host.getManagedTabIdsForBoundTab = (id: string) => new Set([id]);
  host.closeTab = (id: string) => {
    closed.push(id);
    host.tabs.delete(id);
    return true;
  };
  return { host, closed };
}

const activeRegistry = () => ({
  getActiveRecordIds: () => new Set(['a1', 'a2']),
  getRecord: (id: string) =>
    id === 'a1' ? { state: 'active', tabId: 'claimed' } : { state: 'expired', tabId: 'orphan' },
});

describe('agent tab reap sweep', () => {
  it('closes an unclaimed idle offscreen tab, keeps claimed and visible ones, ignores expired records', async () => {
    const { host, closed } = makeHost(activeRegistry());
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, ['orphan']);
  });

  it('closes nothing when the attachment registry is not wired', async () => {
    const { host, closed } = makeHost(undefined);
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, []);
  });

  it('closes nothing when the registry cannot read records', async () => {
    const { host, closed } = makeHost({ getActiveRecordIds: () => new Set(['a1']) });
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, []);
  });

  it('closes nothing when the registry read throws', async () => {
    const { host, closed } = makeHost({
      getActiveRecordIds: () => {
        throw new Error('boom');
      },
      getRecord: () => undefined,
    });
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, []);
  });

  it('keeps a recently resolved unclaimed tab alive', async () => {
    const { host, closed } = makeHost(activeRegistry());
    host.noteAgentTabActivity('orphan');
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, []);
  });

  it('isAgentTabClaimed fails closed without a registry', () => {
    const { host } = makeHost(undefined);
    assert.strictEqual(host.isAgentTabClaimed('orphan'), true);
  });

  it('closes nothing when an advertised record is missing', async () => {
    const { host, closed } = makeHost({
      getActiveRecordIds: () => new Set(['a1']),
      getRecord: () => undefined,
    });
    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, []);
  });

  it('attachment-less mint is reaped after idle and the next resolve mints a fresh tab', async () => {
    const { host } = makeHost({ getActiveRecordIds: () => new Set<string>(), getRecord: () => undefined });
    host.tabs.clear();
    host.automationTabId = null;
    host.agentTabReapIdleMs = 1000;
    let seq = 0;
    const realClose = host.closeTab;
    host.closeTab = (id: string) => {
      if (host.automationTabId === id) host.automationTabId = null;
      return realClose(id);
    };
    const hostPort = {
      hasTab: (id?: string | null) => Boolean(id && host.tabs.has(id)),
      getTabList: () => [...host.tabs.keys()].map((id) => ({ id })),
      getAutomationTabId: () => host.automationTabId,
      setAutomationTabId: (id?: string) => {
        host.automationTabId = id ?? null;
      },
      noteAgentTabActivity: (id?: string) => host.noteAgentTabActivity(id),
      createTab: () => {
        const id = `minted-${++seq}`;
        host.tabs.set(id, { state: { offscreen: true, ephemeral: true, url: 'about:blank' }, lastActiveAt: Date.now() });
        return id;
      },
    };
    const port = new BrowserControlPort(hostPort as unknown as ConstructorParameters<typeof BrowserControlPort>[0]) as unknown as {
      resolveTargetTab(target?: unknown, explicit?: string, op?: string): string;
    };

    const first = port.resolveTargetTab(undefined, undefined, 'read');
    assert.strictEqual(first, 'minted-1');
    assert.strictEqual(port.resolveTargetTab(undefined, undefined, 'read'), 'minted-1');

    await host.runAgentTabReapSweep();
    assert.ok(host.tabs.has('minted-1'));

    host.tabs.get('minted-1').lastActiveAt -= 2000;
    host.tabs.get('minted-1').agentActivityAt -= 2000;
    await host.runAgentTabReapSweep();
    assert.strictEqual(host.tabs.has('minted-1'), false);
    assert.strictEqual(host.automationTabId, null);

    assert.strictEqual(port.resolveTargetTab(undefined, undefined, 'read'), 'minted-2');
  });
});
