// A refusal about which tab the session may drive must let the caller correct itself in one call:
// it names the tabs the session may use and the call that opens one of its own.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { SESSION_TAB_LIMIT } from '../../src/shared/tab-sharing';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-bound',
  browserEpoch: 1,
  documentGeneration: 1,
};

const URLS: Record<string, string> = {
  'tab-bound': 'https://shop.example/',
  'tab-2': 'https://shop.example/products/a',
  'tab-user': 'https://mail.example/',
};

function buildHost(overrides: Partial<BrowserHostPort> = {}): BrowserHostPort {
  const ids = Object.keys(URLS);
  return {
    getTabList: () => ids.map((id) => ({ id, url: URLS[id] })),
    hasTab: (id) => ids.includes(id ?? ''),
    getTabUrl: (id: string) => URLS[id],
    getDocumentGeneration: () => 1,
    isTabAllowed: (_bound: string, candidate: string) => candidate !== 'tab-user',
    getManagedTabIds: () => new Set(['tab-bound', 'tab-2']),
    getAutomationTabId: () => 'tab-bound',
    closeTab: () => true,
    createTab: () => 'tab-new',
    ...overrides,
  } as unknown as BrowserHostPort;
}

describe('TARGET_MISMATCH names what the session may use', () => {
  it('a refused close lists the tabs it may drive, with their URLs, and the call that opens its own', () => {
    const port = new BrowserControlPort(buildHost());
    assert.throws(
      () => port.closeTab('tab-user', { target: TARGET }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'TARGET_MISMATCH');
        assert.match(err.message, /tab-bound \(https:\/\/shop\.example\/\)/);
        assert.match(err.message, /tab-2 \(https:\/\/shop\.example\/products\/a\)/);
        assert.match(err.message, /anti\.browser\.tabs\.create \{[^}]*bind: false[^}]*\}/);
        assert.deepEqual(err.details?.usableTabs, [
          { id: 'tab-bound', url: 'https://shop.example/' },
          { id: 'tab-2', url: 'https://shop.example/products/a' },
        ]);
        return true;
      }
    );
  });

  it('an explicit tabId outside the session on an effectful call carries the same guidance', async () => {
    const port = new BrowserControlPort(buildHost({ resolveTargetTabId: (id: string) => id }));
    await assert.rejects(
      port.awaitCdnSync(TARGET, { assetPath: 'theme.css', tabId: 'tab-user', timeoutMs: 200 }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'TARGET_MISMATCH'
        && /tab-2 \(https:\/\/shop\.example\/products\/a\)/.test(err.message)
        && Array.isArray(err.details?.usableTabs)
    );
  });

  it('lists the bound tab first and never repeats it, and bounds the list', () => {
    const many = new Set(['tab-bound', ...Array.from({ length: 20 }, (_, i) => `tab-x${i}`)]);
    const port = new BrowserControlPort(buildHost({ getManagedTabIds: () => many }));
    assert.throws(
      () => port.closeTab('tab-user', { target: TARGET }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        const usable = err.details?.usableTabs as Array<{ id: string }>;
        assert.equal(usable[0]?.id, 'tab-bound');
        assert.equal(usable.filter((tab) => tab.id === 'tab-bound').length, 1);
        assert.ok(usable.length <= 8, `bounded, got ${usable.length}`);
        return true;
      }
    );
  });

  it('a host that cannot list its managed tabs still names the bound tab', () => {
    const port = new BrowserControlPort(buildHost({ getManagedTabIds: () => { throw new Error('boom'); } }));
    assert.throws(
      () => port.closeTab('tab-user', { target: TARGET }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && /tab-bound/.test(err.message)
    );
  });
});

describe('the session tab limit names which tabs this session owns', () => {
  it('lists every counted tab with its URL and whether it may be closed', () => {
    const owned = ['tab-bound', ...Array.from({ length: SESSION_TAB_LIMIT - 1 }, (_, i) => `tab-o${i}`)];
    const port = new BrowserControlPort(buildHost({
      getManagedTabIds: () => new Set(owned),
      getTabUrl: (id: string) => `https://shop.example/${id}`,
      getTabList: () => owned.map((id) => ({ id, url: `https://shop.example/${id}` })),
      isTabAllowed: () => true,
    }));
    assert.throws(
      () => port.openTab({ url: 'https://shop.example/new' }, { target: TARGET }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'POLICY_DENIED');
        const rows = err.details?.ownedByThisAgent as Array<{ id: string; url?: string; closable: boolean }>;
        assert.equal(rows.length, SESSION_TAB_LIMIT);
        assert.deepEqual(rows[0], { id: 'tab-bound', url: 'https://shop.example/tab-bound', closable: false });
        assert.deepEqual(rows[1], { id: 'tab-o0', url: 'https://shop.example/tab-o0', closable: true });
        assert.match(err.message, /tab-o0 \(https:\/\/shop\.example\/tab-o0\)/);
        return true;
      }
    );
  });
});
