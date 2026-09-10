import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort } from './browser-control-port.js';
import { BrowserTarget, issueRuntimeLease, makeControlPlaneId } from '../../shared/control-plane-contracts.js';
import { CdpDebuggerInterface } from '../browser/zero-network-interceptor.js';
import { CapabilityCatalogue } from './capability-catalogue.js';
import { registerBrowserCapabilities } from './browser-capabilities.js';

/**
 * `assert.rejects` hands the rejection back as `unknown`. These tests assert on the
 * CapabilityError envelope (`code`, `message`, `details`), which `Error` does not
 * declare, so narrow once here rather than casting at every call site.
 */
function asCapabilityError(err: unknown): Error & { code?: string; details?: Record<string, unknown> } {
  assert.ok(err instanceof Error, `expected a rejected Error, received ${typeof err}`);
  return err as Error & { code?: string; details?: Record<string, unknown> };
}

describe('BrowserControlPort.reloadZeroNetwork & Capability Catalogue Dispatch', () => {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');

  const validTarget: BrowserTarget = {
    projectId,
    workspaceId,
    runtimeId: 'test-runtime',
    browserEpoch: 1,
    documentGeneration: 1,
    tabId: 'tab-local-1'
  };

  it('1. rejects external/remote URLs immediately with INVALID_ARGUMENT before attaching debugger or calling reload', async () => {
    let reloadCalled = false;
    let debuggerAttached = false;

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => { reloadCalled = true; return true; },
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'https://phukienmaymoc.com/collections/all',
      getTabList: () => [{ id: 'tab-remote-1', url: 'https://phukienmaymoc.com/collections/all' }],
      hasTab: (id) => id === 'tab-remote-1',
      getTabDebugger: () => ({
        isAttached: () => debuggerAttached,
        attach: () => { debuggerAttached = true; },
        sendCommand: async () => ({}),
        on: () => {},
        removeListener: () => {}
      })
    };

    const port = new BrowserControlPort(mockHost);

    await assert.rejects(
      async () => {
        await port.reloadZeroNetwork({ ...validTarget, tabId: 'tab-remote-1' });
      },
      (err: unknown) => {
        const rejection = asCapabilityError(err);
        assert.strictEqual(rejection.code, 'INVALID_ARGUMENT');
        assert.ok(rejection.message.includes('restricted to verified local origins'));
        return true;
      }
    );

    assert.strictEqual(reloadCalled, false);
    assert.strictEqual(debuggerAttached, false);
  });

  it('2. fails closed with CAPABILITY_NOT_FOUND when tab debugger interface is missing or null', async () => {
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'http://127.0.0.1:8080/',
      getTabList: () => [{ id: 'tab-local-1', url: 'http://127.0.0.1:8080/' }],
      hasTab: (id) => id === 'tab-local-1',
      getTabDebugger: () => undefined
    };

    const port = new BrowserControlPort(mockHost);

    await assert.rejects(
      async () => {
        await port.reloadZeroNetwork(validTarget);
      },
      (err: unknown) => {
        const rejection = asCapabilityError(err);
        assert.strictEqual(rejection.code, 'CAPABILITY_NOT_FOUND');
        assert.ok(rejection.message.includes('CDP Debugger interface is not available'));
        return true;
      }
    );
  });

  it('3. asserts exact chronological lifecycle order: Fetch.enable -> reload -> Fetch.disable in finally', async () => {
    const eventTimeline: string[] = [];

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string) => {
        eventTimeline.push(`cdp:${method}`);
        return {};
      },
      on: () => {},
      removeListener: () => {}
    };

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => {
        eventTimeline.push('host:reload');
        return true;
      },
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'http://127.0.0.1:20145/index.html',
      getTabList: () => [{ id: 'tab-local-1', url: 'http://127.0.0.1:20145/index.html' }],
      hasTab: (id) => id === 'tab-local-1',
      getTabDebugger: () => mockDebugger,
      getDocumentGeneration: () => 5
    };

    const port = new BrowserControlPort(mockHost);
    // A reload is a lifecycle operation: `resolveTargetTab` fences it on document
    // generation, so the target has to be as fresh as the live document (5). The
    // generation is still rebased onto the live value and reported back.
    const res = await port.reloadZeroNetwork({ ...validTarget, documentGeneration: 5 });

    assert.strictEqual(res.reloaded, true);
    assert.strictEqual(res.verifiedOffline, true);
    assert.strictEqual(res.blockedCount, 0);
    assert.deepStrictEqual(res.blockedUrls, []);
    assert.strictEqual(res.target.documentGeneration, 5);

    // Assert exact chronological event timeline
    assert.deepStrictEqual(eventTimeline, [
      'cdp:Fetch.enable',
      'host:reload',
      'cdp:Fetch.disable'
    ], 'Must execute in exact chronological order without race conditions');
  });

  it('3b. fails closed with TARGET_STALE before any side effect when the target document generation is stale', async () => {
    const eventTimeline: string[] = [];

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string) => {
        eventTimeline.push(`cdp:${method}`);
        return {};
      },
      on: () => {},
      removeListener: () => {}
    };

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => {
        eventTimeline.push('host:reload');
        return true;
      },
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'http://127.0.0.1:20145/index.html',
      getTabList: () => [{ id: 'tab-local-1', url: 'http://127.0.0.1:20145/index.html' }],
      hasTab: (id) => id === 'tab-local-1',
      getTabDebugger: () => mockDebugger,
      getDocumentGeneration: () => 5
    };

    const port = new BrowserControlPort(mockHost);

    // `validTarget` is fenced at generation 1 while the live document is at 5. Refusing
    // is the whole point: reloading would apply an offline-interception lifecycle to
    // whatever the tab happens to be showing now, not to the document the caller inspected.
    await assert.rejects(
      async () => {
        await port.reloadZeroNetwork(validTarget);
      },
      (err: unknown) => {
        const rejection = asCapabilityError(err);
        assert.strictEqual(rejection.code, 'TARGET_STALE');
        assert.strictEqual(rejection.details?.targetDocumentGeneration, 1);
        assert.strictEqual(rejection.details?.liveDocumentGeneration, 5);
        return true;
      }
    );

    // The fence must hold BEFORE interception is enabled or the tab is reloaded.
    assert.deepStrictEqual(eventTimeline, [], 'A stale lifecycle target must produce no CDP command and no host reload');
  });

  it('4. records blocked external requests and returns verifiedOffline: false with exact blocked ledger', async () => {
    let messageListener: ((event: unknown, method: string, params: any, sessionId: string) => void) | null = null;
    const sentCdpCommands: Array<{ method: string; params?: any }> = [];

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string, params?: any) => {
        sentCdpCommands.push({ method, params });
        return {};
      },
      on: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        if (event === 'message') messageListener = listener;
      },
      removeListener: () => {
        messageListener = null;
      }
    };

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: async () => {
        if (messageListener) {
          messageListener(null, 'Fetch.requestPaused', {
            requestId: 'req-ext-1',
            request: { url: 'https://cdn.hstatic.net/tracker.js' }
          }, 'session-1');
        }
        return true;
      },
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'http://localhost:3000/',
      getTabList: () => [{ id: 'tab-local-1', url: 'http://localhost:3000/' }],
      hasTab: (id) => id === 'tab-local-1',
      getTabDebugger: () => mockDebugger
    };

    const port = new BrowserControlPort(mockHost);
    const res = await port.reloadZeroNetwork(validTarget);

    assert.strictEqual(res.reloaded, true);
    assert.strictEqual(res.verifiedOffline, false);
    assert.strictEqual(res.blockedCount, 1);
    assert.strictEqual(res.blockedUrls[0], 'https://cdn.hstatic.net/tracker.js');

    assert.ok(sentCdpCommands.some(c => c.method === 'Fetch.failRequest' && c.params?.requestId === 'req-ext-1'));
  });

  it('5. capability catalogue dispatches browser.reload_zero_network correctly via public contract', async () => {
    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {}
    };

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64',
      evalJs: async () => 'http://localhost:8080/index.html',
      getTabList: () => [{ id: 'tab-local-1', url: 'http://localhost:8080/index.html' }],
      hasTab: (id) => id === 'tab-local-1',
      getTabDebugger: () => mockDebugger
    };

    const port = new BrowserControlPort(mockHost);
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1
    });

    registerBrowserCapabilities(catalogue, port);

    // Verify capability is registered
    const cap = catalogue.get('browser.reload_zero_network');
    assert.ok(cap, 'browser.reload_zero_network must be registered in capability catalogue');
    assert.strictEqual(cap.name, 'browser.reload_zero_network');
    assert.strictEqual(cap.risk, 'write');

    // Execute via catalogue dispatch with lease
    const result = await catalogue.dispatch('browser.reload_zero_network', { tabId: 'tab-local-1' }, {
      lease,
      leaseToken: lease.token,
      browserTarget: { ...validTarget, runtimeId: lease.runtimeId },
      projectId,
      workspaceId,
      grant: 'write'
    });

    assert.ok(result, 'Must return execution result');
    assert.strictEqual((result as any).reloaded, true);
    assert.strictEqual((result as any).verifiedOffline, true);
    assert.strictEqual((result as any).blockedCount, 0);
  });
});
