import { classifyNetworkUrl } from './network-policy.js';

export interface ZeroNetworkTransactionResult {
  blockedCount: number;
  blockedUrls: string[];
}

export interface CdpDebuggerInterface {
  isAttached(): boolean;
  attach(version?: string): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void): unknown;
  removeListener(event: 'message', listener: (event: unknown, method: string, params: any, sessionId: string) => void): unknown;
}

/**
 * Executes an isolated transaction under strict Zero-External-Network Denial Policy.
 * Intercepts requests via Fetch.requestPaused and deterministically tracks in-flight request resolution.
 * All in-flight requests are awaited before the transaction completes and in `finally`.
 * When multiple failures occur (e.g. action failure + CDP request failure + Fetch.disable failure),
 * all errors are preserved using an AggregateError rather than dropping evidence.
 */
export async function withZeroNetworkDenialTransaction<T>(
  dbg: CdpDebuggerInterface,
  action: (receipt: { getBlockedUrls: () => string[]; awaitPendingRequests: () => Promise<void> }) => Promise<T>
): Promise<{ result: T; blockedUrls: string[] }> {
  if (!dbg) {
    throw new Error('CDP Debugger interface is required for Zero-Network Denial Transaction');
  }

  if (!dbg.isAttached()) {
    dbg.attach('1.3');
  }

  const blockedUrls: string[] = [];
  const pendingRequestPromises = new Set<Promise<void>>();
  const requestErrors: Error[] = [];

  const onRequestPaused = (_event: unknown, method: string, params: any) => {
    if (method !== 'Fetch.requestPaused' || !params) return;
    const requestId = params.requestId;
    const requestUrl = params.request?.url || '';

    const classification = classifyNetworkUrl(requestUrl);
    const executeHandling = async () => {
      if (classification.action === 'allow') {
        await dbg.sendCommand('Fetch.continueRequest', { requestId });
      } else {
        blockedUrls.push(requestUrl);
        await dbg.sendCommand('Fetch.failRequest', {
          requestId,
          errorReason: 'Failed'
        });
      }
    };

    let p: Promise<void>;
    p = executeHandling()
      .catch((err) => {
        requestErrors.push(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        pendingRequestPromises.delete(p);
      });

    pendingRequestPromises.add(p);
  };

  const drainPendingRequests = async () => {
    while (pendingRequestPromises.size > 0) {
      await Promise.all(Array.from(pendingRequestPromises));
    }
  };

  // 1. Send Fetch.enable first; if this fails, no listener is attached
  await dbg.sendCommand('Fetch.enable', {
    patterns: [{ urlPattern: '*' }]
  });

  const errorsToAggregate: Error[] = [];

  try {
    // 2. Attach listener only AFTER Fetch.enable succeeds
    dbg.on('message', onRequestPaused);

    const actionResult = await action({
      getBlockedUrls: () => [...blockedUrls],
      awaitPendingRequests: async () => {
        await drainPendingRequests();
        if (requestErrors.length > 0) {
          throw new AggregateError(
            [...requestErrors],
            `ZeroNetworkDenialTransaction request handling failures:\n${requestErrors.map(e => e.message).join('\n')}`
          );
        }
      }
    });

    // Await all pending intercepted requests deterministically on success
    await drainPendingRequests();

    if (requestErrors.length > 0) {
      throw new AggregateError(
        [...requestErrors],
        `ZeroNetworkDenialTransaction request handling failures:\n${requestErrors.map(e => e.message).join('\n')}`
      );
    }

    return {
      result: actionResult,
      blockedUrls
    };
  } catch (actionErr) {
    errorsToAggregate.push(actionErr instanceof Error ? actionErr : new Error(String(actionErr)));
    throw actionErr; // Re-thrown; caught in outer finally handler
  } finally {
    try {
      // Detach message listener first to stop accepting new requests
      dbg.removeListener('message', onRequestPaused);
    } catch (removeErr) {
      errorsToAggregate.push(removeErr instanceof Error ? removeErr : new Error(String(removeErr)));
    }

    try {
      // Drain and settle all in-flight request handling
      await drainPendingRequests();
    } catch (drainErr) {
      errorsToAggregate.push(drainErr instanceof Error ? drainErr : new Error(String(drainErr)));
    }

    if (requestErrors.length > 0) {
      for (const reqErr of requestErrors) {
        if (!errorsToAggregate.includes(reqErr)) {
          errorsToAggregate.push(reqErr);
        }
      }
    }

    try {
      await dbg.sendCommand('Fetch.disable');
    } catch (disableErr) {
      errorsToAggregate.push(disableErr instanceof Error ? disableErr : new Error(String(disableErr)));
    }

    // Aggregate all failures without dropping evidence
    if (errorsToAggregate.length === 1) {
      throw errorsToAggregate[0];
    } else if (errorsToAggregate.length > 1) {
      throw new AggregateError(
        errorsToAggregate,
        `ZeroNetworkDenialTransaction failed with multiple concurrent errors:\n${errorsToAggregate.map(e => e.message).join('\n')}`
      );
    }
  }
}
