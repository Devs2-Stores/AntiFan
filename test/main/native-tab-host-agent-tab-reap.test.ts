import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

// The sweep's closeTab now journals `tabhost.tabClosed`. Redirect the lifecycle log
// to a temp runtime BEFORE the first write — the journal binds its path lazily.
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reap-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

function tabClosedRows(): Array<Record<string, unknown>> {
  const logPath = path.join(RUNTIME_DIR, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"tabhost.tabClosed"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

    const minted = host.tabs.get('minted-1');
    assert.strictEqual(typeof minted.agentActivityAt, 'number');
    minted.lastActiveAt -= 2000;
    minted.agentActivityAt -= 2000;
    await host.runAgentTabReapSweep();
    assert.strictEqual(host.tabs.has('minted-1'), false);
    assert.strictEqual(host.automationTabId, null);

    assert.strictEqual(port.resolveTargetTab(undefined, undefined, 'read'), 'minted-2');
  });

  it('journals the reaped tab with source agent-reap through the real closeTab', async () => {
    const { host, closed } = makeHost({
      getActiveRecordIds: () => new Set(['a1']),
      getRecord: (id: string) => (id === 'a1' ? { state: 'active', tabId: 'claimed' } : undefined),
    });
    // The suite stubs closeTab wholesale above; this case exercises the REAL close so
    // the telemetry row it emits can be asserted. Only the fields closeTab actually
    // dereferences are provided.
    const realClose = NativeTabHost.prototype.closeTab as (this: unknown, id: string, source?: string) => boolean;
    host.tabOrder = [...host.tabs.keys()];
    host.activeTabId = '';
    host.attemptAuthorizedCloses = new Set();
    host.tabPreviewUnsubscribers = new Map();
    host.recentlyClosedTabs = [];
    host.closedTabAnchors = new Map();
    host.automationTabId = null;
    host.networkTracker = { detachTarget: () => {} };
    host.shell = { window: { isDestroyed: () => false, contentView: { children: [] } } };
    host.automationHost = { agentWorkingRefs: new Map(), clearTabAgentWorking: () => {} };
    host.broadcastState = () => {};
    host.reassertPresentedView = () => {};
    host.isTerminalOnlyWindow = () => false;
    host.closeTab = (id: string, source?: string) => {
      if (host.automationTabId === id) host.automationTabId = null;
      closed.push(id);
      return realClose.call(host, id, source);
    };

    await host.runAgentTabReapSweep();
    assert.deepStrictEqual(closed, ['orphan']);

    const rows = tabClosedRows().filter((row) => row['tabId'] === 'orphan');
    assert.strictEqual(rows.length, 1, 'one journal row for the reaped tab');
    assert.strictEqual(rows[0]!['event'], 'tabhost.tabClosed');
    assert.strictEqual(rows[0]!['source'], 'agent-reap');
    assert.strictEqual(rows[0]!['offscreen'], true);
  });
});