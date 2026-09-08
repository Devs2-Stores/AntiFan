import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { withZeroNetworkDenialTransaction, CdpDebuggerInterface } from './zero-network-interceptor.js';

describe('Production Zero-External-Network Denial Gate (CDP Fetch Interceptor Transaction)', () => {
  it('intercepts requests via Fetch.requestPaused, continues allowed local URLs, fails blocked external URLs, awaits in-flight promises deterministically, and cleans up in finally', async () => {
    const sentCommands: Array<{ method: string; params?: any }> = [];
    const listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
    let isAttached = false;

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => isAttached,
      attach: () => { isAttached = true; },
      sendCommand: async (method: string, params?: any) => {
        sentCommands.push({ method, params });
        return {};
      },
      on: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        list.push(listener);
        listeners.set(event, list);
      },
      removeListener: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
        listeners.set(event, list);
      }
    };

    const emitMessage = (method: string, params: any) => {
      const list = listeners.get('message') || [];
      for (const l of list) {
        l(null, method, params, 'session-default');
      }
    };

    const { result, blockedUrls } = await withZeroNetworkDenialTransaction(
      mockDebugger,
      async (receipt) => {
        // Assert Fetch.enable was sent before action execution
        assert.ok(sentCommands.some(c => c.method === 'Fetch.enable'));

        // 1. Simulate an allowed localhost request
        emitMessage('Fetch.requestPaused', {
          requestId: 'req-1',
          request: { url: 'http://localhost:8080/theme.css' }
        });

        // 2. Simulate an external prohibited CDN request
        emitMessage('Fetch.requestPaused', {
          requestId: 'req-2',
          request: { url: 'https://cdn.hstatic.net/unwanted.js' }
        });

        // 3. Simulate host-boundary bypass attempt (localhost.evil.com)
        emitMessage('Fetch.requestPaused', {
          requestId: 'req-3',
          request: { url: 'http://localhost.evil.com/exfiltrate' }
        });

        // Deterministic await: waits until all in-flight Fetch commands settle without sleep
        await receipt.awaitPendingRequests();

        const currentlyBlocked = receipt.getBlockedUrls();
        assert.strictEqual(currentlyBlocked.length, 2);
        return 'transaction-success';
      }
    );

    assert.strictEqual(result, 'transaction-success');
    assert.strictEqual(blockedUrls.length, 2);
    assert.strictEqual(blockedUrls[0], 'https://cdn.hstatic.net/unwanted.js');
    assert.strictEqual(blockedUrls[1], 'http://localhost.evil.com/exfiltrate');

    // Verify command calls:
    // Fetch.continueRequest for req-1
    assert.ok(sentCommands.some(c => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'req-1'));
    // Fetch.failRequest for req-2 and req-3 with errorReason: 'Failed'
    assert.ok(sentCommands.some(c => c.method === 'Fetch.failRequest' && c.params?.requestId === 'req-2' && c.params?.errorReason === 'Failed'));
    assert.ok(sentCommands.some(c => c.method === 'Fetch.failRequest' && c.params?.requestId === 'req-3' && c.params?.errorReason === 'Failed'));

    // Verify cleanup in finally:
    // Fetch.disable sent
    assert.ok(sentCommands.some(c => c.method === 'Fetch.disable'));
    // Message listener removed
    const messageListeners = listeners.get('message') || [];
    assert.strictEqual(messageListeners.length, 0, 'Listener must be strictly removed in finally');
  });

  it('guarantees Fetch.disable and listener teardown when action throws (Fail-Closed Clean State)', async () => {
    const sentCommands: Array<{ method: string; params?: any }> = [];
    const listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string, params?: any) => {
        sentCommands.push({ method, params });
        return {};
      },
      on: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        list.push(listener);
        listeners.set(event, list);
      },
      removeListener: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
        listeners.set(event, list);
      }
    };

    await assert.rejects(
      async () => {
        await withZeroNetworkDenialTransaction(mockDebugger, async () => {
          throw new Error('Test Simulated Execution Failure');
        });
      },
      /Test Simulated Execution Failure/
    );

    // Assert Fetch.disable was still called
    assert.ok(sentCommands.some(c => c.method === 'Fetch.disable'), 'Must disable Fetch on throw');
    assert.strictEqual((listeners.get('message') || []).length, 0, 'Must clean listeners on throw');
  });

  it('fails closed and preserves both action error and CDP request error in AggregateError without dropping evidence', async () => {
    const sentCommands: Array<{ method: string; params?: any }> = [];
    const listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

    const mockDebugger: CdpDebuggerInterface = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string, params?: any) => {
        sentCommands.push({ method, params });
        if (method === 'Fetch.failRequest') {
          throw new Error('CDP Network Failure on failRequest');
        }
        return {};
      },
      on: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        list.push(listener);
        listeners.set(event, list);
      },
      removeListener: (event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void) => {
        const list = listeners.get(event) || [];
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
        listeners.set(event, list);
      }
    };

    const emitMessage = (method: string, params: any) => {
      const list = listeners.get('message') || [];
      for (const l of list) {
        l(null, method, params, 'session-default');
      }
    };

    let caughtError: any = null;
    try {
      await withZeroNetworkDenialTransaction(mockDebugger, async () => {
        // Emit an external request whose handling command will reject in background
        emitMessage('Fetch.requestPaused', {
          requestId: 'req-err',
          request: { url: 'https://evil.com/leak' }
        });
        throw new Error('Action Primary Failure');
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Must throw error');
    assert.ok(caughtError instanceof AggregateError, 'Must preserve multiple concurrent failures in AggregateError');
    assert.strictEqual(caughtError.errors.length, 2, 'Must contain exactly the 2 concurrent failures');

    const errorMessages = caughtError.errors.map((e: Error) => e.message);
    assert.ok(errorMessages.includes('Action Primary Failure'), 'Must contain Action Primary Failure');
    assert.ok(errorMessages.includes('CDP Network Failure on failRequest'), 'Must contain CDP failRequest Failure');

    // Verify Fetch.disable was still guaranteed in finally
    assert.ok(sentCommands.some(c => c.method === 'Fetch.disable'));
    assert.strictEqual((listeners.get('message') || []).length, 0);
  });
});
