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
});
