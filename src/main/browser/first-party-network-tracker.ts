import { computeOrigin, THEME_ASSET_HOSTS } from '../qa/diagnostics-filter';
import { CapabilityError } from '../../shared/control-plane-contracts';

export interface NetworkTrackerOptions {
  idleWindowMs?: number; // default 500ms
  maxCeilingMs?: number; // default 2000ms
  requireAttached?: boolean;
}
export interface NetworkTrackerStats {
  attachedTargetCount: number;
  listenerCount: number;
  inflightRequestCount: number;
}

const CRITICAL_RESOURCE_TYPES = new Set([
  'mainframe',
  'document',
  'stylesheet',
  'script',
  'font',
]);

interface AttachedTargetState {
  ready: Promise<void>;
  detach: () => void;
}

export class FirstPartyNetworkTracker {
  private inflightByTarget = new Map<string, Set<number | string>>();
  private listenersByTarget = new Map<string, Set<() => void>>();
  private attachedTargets = new Map<string, AttachedTargetState>();

  public makeKey(tabId: string, paneId: string = 'desktop'): string {
    return `${tabId}:${paneId}`;
  }

  public isFirstPartyCritical(url: string, contextUrl: string, resourceType?: string): boolean {
    if (!url || typeof url !== 'string') return false;
    if (resourceType) {
      const normalizedType = resourceType.toLowerCase();
      if (!CRITICAL_RESOURCE_TYPES.has(normalizedType)) {
        return false;
      }
    }
    const originInfo = computeOrigin(url, contextUrl);
    if (originInfo.isFirstParty) return true;
    return THEME_ASSET_HOSTS.some((host) => originInfo.origin === host || originInfo.origin.endsWith(`.${host}`));
  }

  public onRequestStarted(
    tabId: string,
    paneId: string,
    requestId: number | string,
    url: string,
    contextUrl: string,
    resourceType?: string
  ): boolean {
    if (!this.isFirstPartyCritical(url, contextUrl, resourceType)) {
      return false;
    }
    const key = this.makeKey(tabId, paneId);
    let targetSet = this.inflightByTarget.get(key);
    if (!targetSet) {
      targetSet = new Set();
      this.inflightByTarget.set(key, targetSet);
    }
    targetSet.add(requestId);
    this.notifyStateChange(key);
    return true;
  }

  public onRequestFinished(tabId: string, paneId: string, requestId: number | string): void {
    const key = this.makeKey(tabId, paneId);
    const targetSet = this.inflightByTarget.get(key);
    if (targetSet && targetSet.delete(requestId)) {
      this.notifyStateChange(key);
    }
  }

  public getInflightCount(tabId: string, paneId: string = 'desktop'): number {
    return (this.inflightByTarget.get(this.makeKey(tabId, paneId)) || new Set()).size;
  }

  public isAttached(tabId: string, paneId: string = 'desktop'): boolean {
    return this.attachedTargets.has(this.makeKey(tabId, paneId));
  }
  public getStats(): NetworkTrackerStats {
    let listenerCount = 0;
    for (const listeners of this.listenersByTarget.values()) listenerCount += listeners.size;
    let inflightRequestCount = 0;
    for (const requests of this.inflightByTarget.values()) inflightRequestCount += requests.size;
    return {
      attachedTargetCount: this.attachedTargets.size,
      listenerCount,
      inflightRequestCount,
    };
  }

  public dispose(): void {
    for (const attached of this.attachedTargets.values()) {
      try { attached.detach(); } catch {}
    }
    this.attachedTargets.clear();
    this.listenersByTarget.clear();
    this.inflightByTarget.clear();
  }

  /**
   * Resets active inflight tracking for a navigation/reload without detaching listeners.
   */
  public resetInflight(tabId: string, paneId: string = 'desktop'): void {
    const key = this.makeKey(tabId, paneId);
    const targetSet = this.inflightByTarget.get(key);
    if (targetSet && targetSet.size > 0) {
      targetSet.clear();
      this.notifyStateChange(key);
    }
  }

  /**
   * Full teardown of target state and debugger listeners upon tab close / WebContents destruction.
   */
  public detachTarget(tabId: string, paneId: string = 'desktop'): void {
    const key = this.makeKey(tabId, paneId);
    this.inflightByTarget.delete(key);
    this.listenersByTarget.delete(key);

    const attached = this.attachedTargets.get(key);
    if (attached) {
      this.attachedTargets.delete(key);
      try {
        attached.detach();
      } catch {}
    }
  }

  private notifyStateChange(key: string): void {
    const listeners = this.listenersByTarget.get(key);
    if (listeners) {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch {}
      }
    }
  }

  public async awaitQuiescence(
    tabId: string,
    paneId: string = 'desktop',
    options: NetworkTrackerOptions = {},
    signal?: AbortSignal
  ): Promise<{ settled: boolean; durationMs: number; timedOut: boolean }> {
    const key = this.makeKey(tabId, paneId);

    if (options.requireAttached && !this.isAttached(tabId, paneId)) {
      throw new CapabilityError('TARGET_STALE', `FirstPartyNetworkTracker is not attached for target "${key}"`);
    }

    if (signal?.aborted) {
      throw new CapabilityError('WAIT_ABORTED', 'Network quiescence wait aborted');
    }

    const idleWindowMs = options.idleWindowMs ?? 500;
    const maxCeilingMs = options.maxCeilingMs ?? 2000;
    const startTime = Date.now();

    const { promise, resolve, reject } = Promise.withResolvers<{ settled: boolean; durationMs: number; timedOut: boolean }>();

    let debounceTimer: NodeJS.Timeout | null = null;
    let ceilingTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (ceilingTimer) {
        clearTimeout(ceilingTimer);
        ceilingTimer = null;
      }
      const listeners = this.listenersByTarget.get(key);
      if (listeners) {
        listeners.delete(onStateChange);
        if (listeners.size === 0) this.listenersByTarget.delete(key);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ settled: true, durationMs: Date.now() - startTime, timedOut });
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CapabilityError('WAIT_ABORTED', 'Network quiescence wait aborted'));
    };

    const resetDebounce = () => {
      if (settled) return;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (this.getInflightCount(tabId, paneId) === 0) {
        debounceTimer = setTimeout(() => {
          if (!settled && this.getInflightCount(tabId, paneId) === 0) {
            finish(false);
          }
        }, idleWindowMs);
      }
    };

    const onStateChange = () => {
      if (settled) return;
      resetDebounce();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let listeners = this.listenersByTarget.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listenersByTarget.set(key, listeners);
    }
    listeners.add(onStateChange);

    ceilingTimer = setTimeout(() => {
      finish(true);
    }, maxCeilingMs);

    resetDebounce();

    return promise;
  }

  /**
   * Ensures CDP network listeners are attached and enabled on a WebContents debugger exactly once.
   * Fails closed if debugger interface is unavailable or Network.enable rejects.
   */
  public async ensureAttached(
    tabId: string,
    paneId: string,
    wc: Electron.WebContents,
    getContextUrl: () => string
  ): Promise<void> {
    const key = this.makeKey(tabId, paneId);
    const existing = this.attachedTargets.get(key);
    if (existing) {
      return await existing.ready;
    }

    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      throw new CapabilityError('TARGET_STALE', 'WebContents is destroyed or unavailable');
    }
    if (!wc.debugger) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Debugger interface is not available on WebContents');
    }

    const readyPromise = (async () => {
      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
        } catch (err) {
          throw new CapabilityError(
            'TARGET_STALE',
            `Failed to attach debugger for first-party network tracking: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      try {
        await wc.debugger.sendCommand('Network.enable');
      } catch (err) {
        throw new CapabilityError(
          'TARGET_STALE',
          `Failed to enable CDP Network domain on target WebContents: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();

    const onMessage = (_event: unknown, method: string, params: any) => {
      if (method === 'Network.requestWillBeSent' && params) {
        const reqId = params.requestId;
        const url = params.request?.url || '';
        const resourceType = params.type || '';
        this.onRequestStarted(tabId, paneId, reqId, url, getContextUrl(), resourceType);
      } else if (
        (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') &&
        params
      ) {
        const reqId = params.requestId;
        this.onRequestFinished(tabId, paneId, reqId);
      }
    };

    wc.debugger.on('message', onMessage);

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      try {
        wc.debugger.removeListener('message', onMessage);
      } catch {}
      try {
        wc.removeListener('destroyed', onWebContentsDestroyed);
      } catch {}
    };

    const onWebContentsDestroyed = () => {
      this.detachTarget(tabId, paneId);
    };

    wc.once('destroyed', onWebContentsDestroyed);

    this.attachedTargets.set(key, {
      ready: readyPromise,
      detach,
    });

    try {
      await readyPromise;
    } catch (err) {
      detach();
      this.attachedTargets.delete(key);
      throw err;
    }
  }
}
