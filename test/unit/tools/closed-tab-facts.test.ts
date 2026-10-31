/**
 * Closed-tab facts: who closed a tab, why and when must survive into the stale-target refusal a
 * session gets afterwards, and closing a tab the session did not bind must never rebind it.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import {
  CLOSED_TAB_RECORD_CAP,
  classifyCloseSource,
  describeClosedTab,
  recordClosedTab,
  type ClosedTabRecord,
} from '../../../src/main/browser/closed-tab-record';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter } from '../../../src/main/tools/capability-transport';
import type { CapabilityCatalogue } from '../../../src/main/tools/capability-catalogue';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';
import { lifecycleLogDrained } from '../../../src/main/diagnostics/main-lifecycle-log';

// `closeTab` journals through the lifecycle log, which resolves its path lazily on first write:
// point it at a scratch directory before any event is recorded.
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-closed-tab-facts-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

after(async () => {
  await lifecycleLogDrained();
  try {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  } catch {}
});

describe('closed tab record', () => {
  it('classifies the close source onto the party that caused it', () => {
    assert.equal(classifyCloseSource('mcp-tool'), 'agent');
    assert.equal(classifyCloseSource('bridge-rpc'), 'agent');
    assert.equal(classifyCloseSource('agent-mint-rollback'), 'agent');
    assert.equal(classifyCloseSource('user-toolbar'), 'user');
    assert.equal(classifyCloseSource('view-close'), 'page');
    assert.equal(classifyCloseSource('view-destroyed'), 'page');
    assert.equal(classifyCloseSource('close-attempt'), 'app');
    assert.equal(classifyCloseSource(undefined), 'app');
  });

  it('stores closedBy, reason and time for every close and keeps the history bounded', () => {
    const records = new Map<string, ClosedTabRecord>();
    recordClosedTab(records, 'tab-a', 'tab-anchor', 'mcp-tool', 1234);
    assert.deepEqual(records.get('tab-a'), { anchor: 'tab-anchor', closedBy: 'agent', reason: 'mcp-tool', at: 1234 });

    recordClosedTab(records, 'tab-b', undefined, undefined, 99);
    assert.deepEqual(records.get('tab-b'), { closedBy: 'app', reason: 'unspecified', at: 99 });

    for (let index = 0; index < CLOSED_TAB_RECORD_CAP + 5; index += 1) {
      recordClosedTab(records, `tab-n${index}`, undefined, 'view-close');
    }
    assert.equal(records.size, CLOSED_TAB_RECORD_CAP);
    assert.equal(records.has('tab-a'), false, 'the oldest records are evicted first');
  });

  it('describes a record with the replacement only when one is live', () => {
    const record: ClosedTabRecord = { closedBy: 'user', reason: 'user-toolbar', at: 7 };
    assert.deepEqual(describeClosedTab(record), { closedBy: 'user', closeReason: 'user-toolbar', closedAt: 7 });
    assert.deepEqual(describeClosedTab(record, 'tab-live'), {
      closedBy: 'user',
      closeReason: 'user-toolbar',
      closedAt: 7,
      replacementTabId: 'tab-live',
    });
    assert.equal(describeClosedTab(undefined), undefined);
  });
});

describe('NativeTabHost.closeTab records the close', () => {
  function createHost(tabIds: string[]) {
    const host = Object.create(NativeTabHost.prototype);
    host.isDisposed = false;
    host.tabs = new Map(
      tabIds.map((id) => [id, { state: { id, url: 'about:blank', title: '' }, view: { webContents: undefined }, projectId: 'proj-1' }])
    );
    host.tabOrder = [...tabIds];
    host.activeTabId = '';
    host.closeAdmission = null;
    host.attemptAuthorizedCloses = new Set<string>();
    host.tabPreviewUnsubscribers = new Map();
    host.recentlyClosedTabs = [];
    host.sessionTabPools = new Map();
    host.closedTabAnchors = new Map();
    host.terminalAgentAffinity = new Map();
    host.automationTabId = null;
    host.isInspecting = false;
    host.automationHost = { agentWorkingRefs: new Map(), clearTabAgentWorking: () => {} };
    host.networkTracker = { detachTarget: () => {} };
    host.shell = { window: { isDestroyed: () => false, contentView: { children: [] } } };
    host.broadcastState = () => {};
    host.reassertPresentedView = () => {};
    host.isTerminalOnlyWindow = () => false;
    return host;
  }

  it('answers closedBy, reason and time for an agent close, and the live replacement from the pool', () => {
    const host = createHost(['tab-bound', 'tab-scratch']);
    host.sessionTabPools.set('tab-bound', new Set(['tab-bound', 'tab-scratch']));

    assert.equal(host.closeTab('tab-scratch', 'mcp-tool'), true);

    const info = host.getClosedTabInfo('tab-scratch');
    assert.ok(info, 'the host remembers the close');
    assert.equal(info.closedBy, 'agent');
    assert.equal(info.closeReason, 'mcp-tool');
    assert.equal(typeof info.closedAt, 'number');
    assert.equal(info.replacementTabId, 'tab-bound');
  });

  it('records a user close and an unlabeled close without a replacement', () => {
    const host = createHost(['tab-1', 'tab-2']);
    assert.equal(host.closeTab('tab-1', 'user-toolbar'), true);
    assert.equal(host.closeTab('tab-2'), true);
    assert.equal(host.getClosedTabInfo('tab-1')?.closedBy, 'user');
    assert.equal(host.getClosedTabInfo('tab-2')?.closedBy, 'app');
    assert.equal(host.getClosedTabInfo('tab-2')?.closeReason, 'unspecified');
    assert.equal(host.getClosedTabInfo('tab-2')?.replacementTabId, undefined);
    assert.equal(host.getClosedTabInfo('tab-never-existed'), undefined);
  });
});

describe('stale-target refusal carries the close facts', () => {
  const closedFacts = { closedBy: 'agent', closeReason: 'mcp-tool', closedAt: 4242, replacementTabId: 'tab-live' };

  function adapterWith(describeClosedTab: (id: string) => unknown): CapabilityTransportAdapter {
    const catalogue = { describeClosedTab } as unknown as CapabilityCatalogue;
    return new CapabilityTransportAdapter(catalogue, undefined as never);
  }
  const withFacts = (adapter: CapabilityTransportAdapter, code: string, details?: Record<string, unknown>) =>
    adapter['withClosedTabFacts'](code, details);

  it('folds the host record into a tab-gone TARGET_STALE, keeping the raising site details on top', () => {
    const seen: string[] = [];
    const adapter = adapterWith((id) => {
      seen.push(id);
      return closedFacts;
    });
    const details = withFacts(adapter, 'TARGET_STALE', { cause: 'tab-gone', tabId: ' tab-dead ', recovery: 'x', closedBy: 'page' });
    assert.deepEqual(seen, ['tab-dead']);
    assert.equal(details?.closedBy, 'page', 'a fact the raising site already set wins');
    assert.equal(details?.closeReason, 'mcp-tool');
    assert.equal(details?.closedAt, 4242);
    assert.equal(details?.replacementTabId, 'tab-live');
    assert.equal(details?.recovery, 'x');
  });

  it('leaves other codes, other causes and unknown tabs untouched', () => {
    const adapter = adapterWith((id) => (id === 'tab-dead' ? closedFacts : undefined));
    const other = { cause: 'tab-gone', tabId: 'tab-dead' };
    assert.equal(withFacts(adapter, 'TARGET_MISMATCH', other), other);
    const drift = { cause: 'dom-drift', tabId: 'tab-dead' };
    assert.equal(withFacts(adapter, 'TARGET_STALE', drift), drift);
    const unknown = { cause: 'tab-gone', tabId: 'tab-other' };
    assert.equal(withFacts(adapter, 'TARGET_STALE', unknown), unknown);
    assert.equal(withFacts(adapter, 'TARGET_STALE', undefined), undefined);
  });
});

describe('closing a tab the session did not bind', () => {
  const target: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'rt-1',
    tabId: 'tab-bound',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  it('closes a bind:false tab without nominating a rebind', () => {
    const live = new Set(['tab-bound', 'tab-side']);
    let failoverAsked = 0;
    const host = {
      hasTab: (id: string) => live.has(id),
      getTabList: () => [...live].map((id) => ({ id })),
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      closeTab: (id: string) => live.delete(id),
      // A host that would happily name a replacement: the port must not even ask for a tab that
      // was not the bound one.
      getFailoverTargetTab: () => {
        failoverAsked += 1;
        return 'tab-bound';
      },
    } as unknown as BrowserHostPort;
    const port = new BrowserControlPort(host);

    const res = port.closeTab('tab-side', { target, creatorTabId: 'tab-side' });

    assert.equal(res.closed, true);
    assert.equal(res.failoverTabId, undefined);
    assert.equal(failoverAsked, 0);
    assert.equal(live.has('tab-bound'), true, 'the bound tab is untouched');
  });

  it('still refuses a foreign tab', () => {
    const live = new Set(['tab-bound', 'tab-foreign']);
    const host = {
      hasTab: (id: string) => live.has(id),
      getTabList: () => [...live].map((id) => ({ id })),
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      closeTab: (id: string) => live.delete(id),
    } as unknown as BrowserHostPort;
    const port = new BrowserControlPort(host);
    assert.throws(
      () => port.closeTab('tab-foreign', { target }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
    assert.equal(live.has('tab-foreign'), true);
  });
});
