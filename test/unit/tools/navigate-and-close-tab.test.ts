import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

const target: BrowserTarget = {
  projectId: 'proj',
  workspaceId: 'ws',
  runtimeId: 'rt',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

describe('BrowserControlPort.navigate url and timeout contract', () => {
  function makePort(): { port: BrowserControlPort; calls: Array<{ tabId: string; url: string; timeoutMs: number | undefined }> } {
    const calls: Array<{ tabId: string; url: string; timeoutMs: number | undefined }> = [];
    const host = {
      hasTab: (id: string) => id === 'tab-1',
      getTabList: () => [{ id: 'tab-1', url: 'about:blank' }],
      getDocumentGeneration: () => 1,
      navigate: () => true,
      navigateAndWait: async (tabId: string, url: string, timeoutMs?: number) => {
        calls.push({ tabId, url, timeoutMs });
        return true;
      },
    } as unknown as BrowserHostPort;
    return { port: new BrowserControlPort(host), calls };
  }

  it('allows about:blank', async () => {
    const { port, calls } = makePort();
    const res = await port.navigate(target, 'about:blank');
    assert.equal(res.navigated, true);
    assert.equal(calls[0]?.url, 'about:blank');
  });

  it('allows about:blank with surrounding whitespace by navigating to the trimmed url', async () => {
    const { port, calls } = makePort();
    await port.navigate(target, '  about:blank  ');
    assert.equal(calls[0]?.url, 'about:blank');
  });

  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'about:srcdoc', 'about:blank#x', 'about:blankx', '']) {
    it(`refuses ${JSON.stringify(url)}`, async () => {
      const { port, calls } = makePort();
      await assert.rejects(
        port.navigate(target, url),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
      );
      assert.equal(calls.length, 0, 'the host must never be asked to load a refused url');
    });
  }

  it('still allows https urls', async () => {
    const { port, calls } = makePort();
    await port.navigate(target, 'https://shop.test/x');
    assert.equal(calls[0]?.url, 'https://shop.test/x');
  });

  it('passes a requested timeout to the host navigation wait', async () => {
    const { port, calls } = makePort();
    await port.navigate(target, 'https://shop.test/', undefined, { timeoutMs: 45_000 });
    assert.equal(calls[0]?.timeoutMs, 45_000);
  });

  it('clamps a requested timeout to the 60000 ms ceiling', async () => {
    const { port, calls } = makePort();
    await port.navigate(target, 'https://shop.test/', undefined, { timeoutMs: 900_000 });
    assert.equal(calls[0]?.timeoutMs, 60_000);
  });

  it('leaves the host default when no usable timeout is requested', async () => {
    const { port, calls } = makePort();
    await port.navigate(target, 'https://shop.test/');
    await port.navigate(target, 'https://shop.test/', undefined, { timeoutMs: -5 });
    await port.navigate(target, 'https://shop.test/', undefined, { timeoutMs: Number.NaN });
    assert.deepEqual(calls.map((c) => c.timeoutMs), [undefined, undefined, undefined]);
  });

  it('answers an unknown explicit tab as a stale target with a rebind-capable recovery', async () => {
    const { port, calls } = makePort();
    await assert.rejects(
      port.navigate(target, 'https://shop.test/', 'tab-missing'),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'TARGET_STALE'
        && err.details?.tabId === 'tab-missing'
        && err.details?.canRebind === true
        && typeof err.details?.recovery === 'string'
    );
    assert.equal(calls.length, 0);
  });
});

describe('BrowserControlPort.navigate waitUntil', () => {
  function makePort(): { port: BrowserControlPort; waits: unknown[] } {
    const waits: unknown[] = [];
    const host = {
      hasTab: (id: string) => id === 'tab-1',
      getTabList: () => [{ id: 'tab-1', url: 'https://shop.test/slow' }],
      getTabUrl: () => 'https://shop.test/slow',
      getDocumentGeneration: () => 1,
      navigate: () => true,
      navigateAndWait: async (_tabId: string, _url: string, wait?: number | { timeoutMs?: number; waitUntil?: string }) => {
        waits.push(wait);
        return true;
      },
    } as unknown as BrowserHostPort;
    return { port: new BrowserControlPort(host), waits };
  }

  it('hands an earlier lifecycle point to the host waiter and reports the state it stopped at', async () => {
    const { port, waits } = makePort();
    const commit = await port.navigate(target, 'https://shop.test/slow', undefined, { timeoutMs: 8_000, waitUntil: 'commit' });
    assert.deepEqual(waits[0], { timeoutMs: 8_000, waitUntil: 'commit' });
    assert.equal(commit.loadState, 'committed');
    assert.equal(commit.committedUrl, 'https://shop.test/slow');
    const dcl = await port.navigate(target, 'https://shop.test/slow', undefined, { waitUntil: 'domcontentloaded' });
    assert.deepEqual(waits[1], { timeoutMs: undefined, waitUntil: 'domcontentloaded' });
    assert.equal(dcl.loadState, 'domcontentloaded');
  });

  it('keeps the plain timeout argument for the default load wait', async () => {
    const { port, waits } = makePort();
    const res = await port.navigate(target, 'https://shop.test/slow', undefined, { timeoutMs: 5_000 });
    assert.deepEqual(waits, [5_000]);
    assert.equal(res.loadState, 'loaded');
    await port.navigate(target, 'https://shop.test/slow', undefined, { timeoutMs: 5_000, waitUntil: 'load' });
    assert.deepEqual(waits[1], 5_000);
  });

  it('refuses an unknown waitUntil before touching the host', async () => {
    const { port, waits } = makePort();
    await assert.rejects(
      port.navigate(target, 'https://shop.test/slow', undefined, { waitUntil: 'idle' as never }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.deepEqual(waits, []);
  });
});

describe('BrowserControlPort.closeTab idempotence', () => {
  function makePort(initialTabs: string[], allowed: (bound: string, requested: string) => boolean = () => true): {
    port: BrowserControlPort;
    closed: string[];
  } {
    const live = new Set(initialTabs);
    const closed: string[] = [];
    const host = {
      hasTab: (id: string) => live.has(id),
      getTabList: () => [...live].map((id) => ({ id })),
      isTabAllowed: allowed,
      closeTab: (id: string) => {
        closed.push(id);
        return live.delete(id);
      },
    } as unknown as BrowserHostPort;
    return { port: new BrowserControlPort(host), closed };
  }

  it('reports alreadyGone when the same tab is closed twice', () => {
    const { port, closed } = makePort(['tab-1', 'tab-2']);
    const first = port.closeTab('tab-2', { target });
    assert.equal(first.closed, true);
    assert.equal(first.alreadyGone, undefined);

    const second = port.closeTab('tab-2', { target });
    assert.equal(second.closed, false);
    assert.equal(second.alreadyGone, true);
    assert.equal(second.tabId, 'tab-2');
    assert.deepEqual(closed, ['tab-2'], 'the host is only asked to close a tab that exists');
  });

  it('answers alreadyGone for a vanished tab before the isolation check', () => {
    const { port, closed } = makePort(['tab-1'], () => false);
    const res = port.closeTab('tab-never-existed', { target });
    assert.equal(res.alreadyGone, true);
    assert.equal(res.closed, false);
    assert.deepEqual(closed, []);
  });

  it('still refuses to close a live tab outside the session', () => {
    const { port, closed } = makePort(['tab-1', 'tab-user'], (bound, requested) => bound === requested);
    assert.throws(
      () => port.closeTab('tab-user', { target }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && typeof err.details?.recovery === 'string'
    );
    assert.deepEqual(closed, []);
  });

  it('lets the creating attachment close a tab outside the bound tab pool, and nobody else', () => {
    const { port, closed } = makePort(['tab-1', 'tab-created'], (bound, requested) => bound === requested);
    assert.throws(
      () => port.closeTab('tab-created', { target }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
    assert.throws(
      () => port.closeTab('tab-created', { target, creatorTabId: 'tab-other' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH'
    );
    assert.deepEqual(closed, []);
    const res = port.closeTab('tab-created', { target, creatorTabId: 'tab-created' });
    assert.equal(res.closed, true);
    assert.deepEqual(closed, ['tab-created']);
  });

  it('waives the pool check only for the creator tab itself: a #N alias resolving to another tab stays refused', () => {
    const { port, closed } = makePort(['tab-1', 'tab-user', 'tab-created'], (bound, requested) => bound === requested);
    // The surface resolved '#2' against ITS list to the creator-owned tab; this port resolves '#2'
    // against its own list to a user tab. The creator waiver must not follow the alias.
    assert.throws(
      () => port.closeTab('#2', { target, creatorTabId: 'tab-created' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_MISMATCH' && err.details?.tabId === 'tab-user'
    );
    assert.deepEqual(closed, []);
    const res = port.closeTab('#3', { target, creatorTabId: 'tab-created' });
    assert.equal(res.closed, true);
    assert.equal(res.tabId, 'tab-created');
    assert.deepEqual(closed, ['tab-created']);
  });
});

describe('BrowserControlPort.openTab quota refusal', () => {
  it('names the tabs this session may close, never the bound tab or a foreign one', () => {
    const managed = new Set(['tab-1', ...Array.from({ length: 9 }, (_, index) => `tab-owned-${index + 1}`)]);
    const host = {
      hasTab: (id: string) => managed.has(id) || id === 'tab-user',
      getTabList: () => [...managed, 'tab-user'].map((id) => ({ id })),
      getManagedTabIds: () => managed,
      isTabAllowed: (_bound: string, requested: string) => requested !== 'tab-user',
      createTab: () => { throw new Error('a full session must be refused before a tab is created'); },
    } as unknown as BrowserHostPort;
    const port = new BrowserControlPort(host);
    assert.throws(
      () => port.openTab({}, { target }),
      (err: unknown) => {
        if (!(err instanceof CapabilityError) || err.code !== 'POLICY_DENIED') return false;
        const closable = err.details?.closableTabIds as string[];
        return closable.length === 8
          && !closable.includes('tab-1')
          && !closable.includes('tab-user')
          && closable.every((id) => id.startsWith('tab-owned-'))
          && err.message.includes(closable[0]!);
      }
    );
  });
});
