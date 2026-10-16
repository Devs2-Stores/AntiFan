// A session whose bound tab died should find its storefront again without guessing: tabs.list marks
// the rows on the project's storefront host, names the single in-scope match as the auto-bind
// candidate (only while the bound tab is gone), and rebind_target accepts that choice.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { pickAutoBindCandidate, storefrontHostMatches } from '../../src/main/tools/tab-binding';
import { BrowserTarget, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

const ORIGIN = 'https://s2-sky.myharavan.com';

interface TabRow {
  id: string;
  url: string;
  /** Project the tab measures into; defaults to the session's own. */
  foreign?: boolean;
}

function makeTarget(tabId: string): BrowserTarget {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  return { tabId, browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
}

function portFor(target: BrowserTarget, tabs: TabRow[], options: { origin?: string | undefined } = { origin: ORIGIN }): BrowserControlPort {
  const live = new Set(tabs.map((tab) => tab.id));
  const foreign = new Set(tabs.filter((tab) => tab.foreign).map((tab) => tab.id));
  const host = {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '',
    captureScreenshot: async () => '',
    evalJs: async () => undefined,
    getTabList: () => tabs.map(({ id, url }) => ({ id, url, title: id })),
    hasTab: (id: string) => live.has(id),
    getDocumentGeneration: () => 1,
    getAutomationTabId: () => target.tabId,
    resolveTargetTabId: (id?: string | null) => (id && live.has(id) ? id : undefined),
    isTabAllowed: () => false,
    getManagedTabIds: () => new Set<string>(),
    resolveTabAffiliation: (id: string) => (live.has(id)
      ? { projectId: foreign.has(id) ? 'project-foreign' : target.projectId, workspaceId: foreign.has(id) ? 'workspace-foreign' : target.workspaceId }
      : undefined),
    getProjectStorefrontOrigin: () => options.origin,
  } as unknown as BrowserHostPort;
  return new BrowserControlPort(host);
}

function code(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

function detail(err: unknown, key: string): unknown {
  if (!err || typeof err !== 'object' || !('details' in err)) return undefined;
  const details = err.details;
  return details && typeof details === 'object' && key in details ? Object.fromEntries(Object.entries(details))[key] : undefined;
}

describe('storefront host matching', () => {
  it('compares hosts only: scheme, port, path and preview query are ignored', () => {
    assert.equal(storefrontHostMatches('https://s2-sky.myharavan.com/products/x?themeid=123', ORIGIN), true);
    assert.equal(storefrontHostMatches('http://S2-SKY.myharavan.com:8080/', ORIGIN), true);
    assert.equal(storefrontHostMatches('https://other.myharavan.com/', ORIGIN), false);
    assert.equal(storefrontHostMatches('https://s2-sky.myharavan.com.evil.example/', ORIGIN), false);
  });

  it('never matches without a URL or an origin', () => {
    assert.equal(storefrontHostMatches(undefined, ORIGIN), false);
    assert.equal(storefrontHostMatches('https://s2-sky.myharavan.com/', undefined), false);
    assert.equal(storefrontHostMatches('not a url', ORIGIN), false);
  });
});

describe('pickAutoBindCandidate', () => {
  it('names exactly one match', () => {
    assert.equal(pickAutoBindCandidate([{ id: 'a', storefrontMatch: false }, { id: 'b', storefrontMatch: true }], false), 'b');
  });

  it('stays silent when two tabs match: that is ambiguous, not a candidate', () => {
    assert.equal(pickAutoBindCandidate([{ id: 'a', storefrontMatch: true }, { id: 'b', storefrontMatch: true }], false), undefined);
  });

  it('stays silent while the bound tab is alive', () => {
    assert.equal(pickAutoBindCandidate([{ id: 'b', storefrontMatch: true }], true), undefined);
  });

  it('stays silent with no match', () => {
    assert.equal(pickAutoBindCandidate([{ id: 'a' }], false), undefined);
  });
});

describe('tabs.list storefront marking and auto-bind candidate', () => {
  const tabs: TabRow[] = [
    { id: 'tab-store', url: `${ORIGIN}/collections/all?themeid=9` },
    { id: 'tab-docs', url: 'https://docs.example.com/' },
  ];

  it('marks only the storefront row; other rows keep their shape without the field', () => {
    const target = makeTarget('tab-store');
    const rows = portFor(target, tabs).listTabs({ target });
    const marked = new Map(rows.map((row) => [String(row && typeof row === 'object' && 'id' in row ? row.id : ''), row && typeof row === 'object' && 'storefrontMatch' in row ? row.storefrontMatch : undefined]));
    assert.equal(marked.get('tab-store'), true);
    assert.equal(marked.get('tab-docs'), undefined);
  });

  it('names the one storefront tab once the bound tab is gone', () => {
    const target = makeTarget('tab-dead');
    const result = portFor(target, tabs).listTabsWithBinding({ target });
    assert.equal(result.autoBindCandidate, 'tab-store');
  });

  it('names nothing while the bound tab is alive', () => {
    const target = makeTarget('tab-store');
    assert.equal(portFor(target, tabs).listTabsWithBinding({ target }).autoBindCandidate, undefined);
  });

  it('names nothing when two storefront tabs are open', () => {
    const target = makeTarget('tab-dead');
    const two = [...tabs, { id: 'tab-store-2', url: `${ORIGIN}/pages/about` }];
    assert.equal(portFor(target, two).listTabsWithBinding({ target }).autoBindCandidate, undefined);
  });

  it('never names a storefront tab that belongs to another project', () => {
    const target = makeTarget('tab-dead');
    const stranger: TabRow[] = [{ id: 'tab-store', url: `${ORIGIN}/`, foreign: true }, tabs[1]!];
    assert.equal(portFor(target, stranger).listTabsWithBinding({ target }).autoBindCandidate, undefined);
  });

  it('names nothing when the project storefront is unknown', () => {
    const target = makeTarget('tab-dead');
    assert.equal(portFor(target, tabs, { origin: undefined }).listTabsWithBinding({ target }).autoBindCandidate, undefined);
  });
});

describe('rebind_target auto', () => {
  const tabs: TabRow[] = [
    { id: 'tab-store', url: `${ORIGIN}/` },
    { id: 'tab-docs', url: 'https://docs.example.com/' },
  ];

  it('binds to the single storefront candidate', () => {
    const target = makeTarget('tab-dead');
    const receipt = portFor(target, tabs).rebindTarget({ tabId: 'auto' }, target);
    assert.equal(receipt.success, true);
    assert.equal(receipt.tabId, 'tab-store');
  });

  it('refuses when no single candidate exists', () => {
    const target = makeTarget('tab-dead');
    const none: TabRow[] = [{ id: 'tab-docs', url: 'https://docs.example.com/' }];
    assert.throws(
      () => portFor(target, none).rebindTarget({ tabId: 'auto' }, target),
      (err: unknown) => code(err) === 'TARGET_REQUIRED'
    );
  });

  it('refuses while the bound tab is still alive', () => {
    const target = makeTarget('tab-store');
    assert.throws(
      () => portFor(target, tabs).rebindTarget({ tabId: 'auto' }, target),
      (err: unknown) => code(err) === 'TARGET_REQUIRED'
    );
  });
});

describe('a dead bound tab names the storefront candidate in its error', () => {
  it('adds autoBindCandidate and the auto hint to TARGET_STALE', async () => {
    const target = makeTarget('tab-dead');
    const port = portFor(target, [{ id: 'tab-store', url: `${ORIGIN}/` }]);
    await assert.rejects(
      port.getViewport({}, target),
      (err: unknown) => code(err) === 'TARGET_STALE'
        && detail(err, 'autoBindCandidate') === 'tab-store'
        && detail(err, 'recovery') === 'anti.browser.rebind_target'
        && err instanceof Error && /tabId 'auto'/.test(err.message)
    );
  });

  it('keeps the plain rebind recovery when there is nothing to bind to automatically', async () => {
    const target = makeTarget('tab-dead');
    const port = portFor(target, [{ id: 'tab-docs', url: 'https://docs.example.com/' }]);
    await assert.rejects(
      port.getViewport({}, target),
      (err: unknown) => code(err) === 'TARGET_STALE'
        && detail(err, 'autoBindCandidate') === undefined
        && detail(err, 'recovery') === 'anti.browser.rebind_target'
        && err instanceof Error && !/tabId 'auto'/.test(err.message)
    );
  });
});
