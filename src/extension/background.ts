import { isCookieInScope } from './domain-scoper';
import { CookieDebouncer, DeltaSyncBatch, ExtensionCookie } from './cookie-debouncer';

declare const chrome: any;

export interface BridgeAuth {
  token: string;
  port: number;
  activeCapsuleId?: string;
  activePartition?: string;
}
const HOST_NAME = 'com.antifan.bridge';
let nativePort: any = null;
let bridgeAuth: BridgeAuth | null = null;
let activeOperationToken: object | null = null;
let inFlightHandshakePromise: Promise<BridgeAuth | null> | null = null;
let enabledProfiles: string[] = ['google', 'ecommerce'];
let syncActiveTabOnly = false;
let isDeltaSyncEnabled = true;
let lastBridgeError: string | null = null;

const debouncer = new CookieDebouncer(async (batch: DeltaSyncBatch) => {
  await dispatchDeltaSync(batch);
}, 300, 1000);

export async function loadSettings(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const stored = await chrome.storage.local.get([
    'enabledProfiles',
    'syncActiveTabOnly',
    'isDeltaSyncEnabled',
  ]);
  if (stored.enabledProfiles) enabledProfiles = stored.enabledProfiles;
  if (typeof stored.syncActiveTabOnly === 'boolean') syncActiveTabOnly = stored.syncActiveTabOnly;
  if (typeof stored.isDeltaSyncEnabled === 'boolean') isDeltaSyncEnabled = stored.isDeltaSyncEnabled;
}
export async function validateBridgeAuth(auth: BridgeAuth | null): Promise<boolean> {
  if (!auth?.token || !auth?.port) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await (typeof fetch !== 'undefined' ? fetch : globalThis.fetch)(
      `http://127.0.0.1:${auth.port}/status?token=${encodeURIComponent(auth.token)}`,
      { signal: controller.signal }
    );
    if (res.ok) {
      lastBridgeError = null;
      return true;
    }
  } catch {} finally {
    clearTimeout(timeoutId);
  }
  return false;
}

export function connectNativeMessaging(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connectNative) return;
  try {
    if (nativePort) {
      const oldPort = nativePort;
      nativePort = null;
      try { oldPort.disconnect(); } catch {}
    }

    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;

    port.onMessage.addListener(async (msg: any) => {
      if (nativePort !== port) return;
      if (msg.status === 'SUCCESS' && msg.token) {
        lastBridgeError = null;
        bridgeAuth = {
          token: msg.token,
          port: msg.port,
          activeCapsuleId: msg.activeCapsuleId,
          activePartition: msg.activePartition,
        };
        triggerAutoHydration().catch(() => {});
      } else if (msg.status === 'ERROR') {
        lastBridgeError = msg.message || msg.error || 'NATIVE_IPC_ERROR';
        bridgeAuth = null;
        if (nativePort === port) {
          try { nativePort.disconnect(); } catch {}
          nativePort = null;
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (nativePort === port) {
        const disconnectMsg = chrome.runtime.lastError?.message;
        if (typeof disconnectMsg === 'string' && disconnectMsg.length > 0) {
          lastBridgeError = disconnectMsg;
        }
        nativePort = null;
        bridgeAuth = null;
      }
    });

    port.postMessage({ action: 'HANDSHAKE' });
  } catch (err) {
    console.error('[AntiFan Extension] Failed to connect native messaging:', err);
  }
}

export async function ensureBridgeAuth(forceRefresh = false): Promise<BridgeAuth | null> {
  if (forceRefresh) {
    bridgeAuth = null;
    activeOperationToken = null;
    inFlightHandshakePromise = null;
    if (nativePort) {
      try { nativePort.disconnect(); } catch {}
      nativePort = null;
    }
  } else if (inFlightHandshakePromise) {
    return inFlightHandshakePromise;
  }

  const token = {};
  activeOperationToken = token;

  const operation = (async () => {
    await Promise.resolve();
    try {
      bridgeAuth = null;
      lastBridgeError = null;

      if (!nativePort) {
        connectNativeMessaging();
      } else {
        try {
          nativePort.postMessage({ action: 'HANDSHAKE' });
        } catch {
          try { nativePort.disconnect(); } catch {}
          nativePort = null;
          connectNativeMessaging();
        }
      }

      const start = Date.now();
      while (Date.now() - start < 1500) {
        // If superseded by a newer operation, abort this one cleanly
        if (activeOperationToken !== token) {
          return null;
        }
        const currentAuth = bridgeAuth as unknown as BridgeAuth | null;
        if (currentAuth && typeof currentAuth.token === 'string' && typeof currentAuth.port === 'number') {
          return currentAuth;
        }
        if (lastBridgeError) {
          return null;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      return null;
    } finally {
      if (activeOperationToken === token) {
        activeOperationToken = null;
        inFlightHandshakePromise = null;
      }
    }
  })();

  inFlightHandshakePromise = operation;
  return operation;
}

export function __resetExtensionStateForTesting(): void {
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    nativePort = null;
  }
  bridgeAuth = null;
  activeOperationToken = null;
  inFlightHandshakePromise = null;
  lastBridgeError = null;
}



export async function executeAuthenticatedCookieImport(
  payload: any,
  authSupplier: () => Promise<BridgeAuth | null>,
  reauthSupplier: () => Promise<BridgeAuth | null>,
  fetchFn: typeof fetch = fetch
): Promise<{ success: boolean; count: number; error?: string }> {
  let auth = await authSupplier();
  if (!auth?.token || !auth?.port) {
    return { success: false, count: 0, error: 'NOT_CONNECTED_TO_ANTIFAN' };
  }

  const postImport = async (currentAuth: BridgeAuth) => {
    return await fetchFn(`http://127.0.0.1:${currentAuth.port}/api/cookies/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentAuth.token}`,
        'x-antifan-attachment-secret': currentAuth.token,
      },
      body: JSON.stringify({
        ...payload,
        partition: currentAuth.activePartition || payload.partition || undefined,
      }),
    });
  };

  try {
    let resp = await postImport(auth);

    // If token rotated or stale, re-handshake and retry once!
    if (resp.status === 401) {
      console.warn('[AntiFan Extension] Received 401 Unauthorized, refreshing authentication with Desktop Bridge...');
      auth = await reauthSupplier();
      if (!auth?.token || !auth?.port) {
        return { success: false, count: 0, error: 'REAUTH_FAILED_AFTER_401' };
      }
      resp = await postImport(auth);
    }

    if (resp.ok) {
      const resData = await resp.json().catch(() => ({}));
      const importedCount = typeof resData.importedCount === 'number'
        ? resData.importedCount
        : (Array.isArray(payload.cookies) ? payload.cookies.length : 0);
      return { success: true, count: importedCount };
    }

    const errText = await resp.text().catch(() => '');
    return { success: false, count: 0, error: `HTTP_${resp.status}: ${errText}` };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message || 'NETWORK_ERROR' };
  }
}

export async function dispatchFullSync(allCookies: ExtensionCookie[]): Promise<{ success: boolean; count: number; error?: string }> {
  if (!allCookies || allCookies.length === 0) {
    return { success: false, count: 0, error: 'NO_COOKIES_FOUND' };
  }

  const payload = {
    profileName: 'Chrome Live (Zero-Touch Native)',
    timestamp: Date.now(),
    cookies: allCookies.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    })),
  };

  return await executeAuthenticatedCookieImport(
    payload,
    () => ensureBridgeAuth(false),
    () => ensureBridgeAuth(true)
  );
}

export async function dispatchDeltaSync(batch: DeltaSyncBatch): Promise<{ success: boolean; count: number; error?: string }> {
  // One-way additive: do not attempt to propagate deletions; no-op if no upserts
  if (!batch.upserted || batch.upserted.length === 0) {
    return { success: true, count: 0 };
  }

  // Strictly strip removals before HTTP to respect server's one-way additive contract
  const payload = {
    cookies: batch.upserted,
    source: 'chrome-extension-delta',
    timestamp: Date.now(),
  };

  return await executeAuthenticatedCookieImport(
    payload,
    () => ensureBridgeAuth(false),
    () => ensureBridgeAuth(true)
  );
}

let isHydrating = false;

export async function triggerAutoHydration(): Promise<{ success: boolean; count: number; error?: string }> {
  if (isHydrating) {
    return { success: true, count: 0 };
  }
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) {
    return { success: false, count: 0, error: 'CHROME_COOKIES_UNAVAILABLE' };
  }
  isHydrating = true;
  try {
    const allCookies = await chrome.cookies.getAll({});
    const scopedCookies = allCookies.filter((c: ExtensionCookie) =>
      isCookieInScope(c, enabledProfiles)
    );
    if (scopedCookies.length === 0) {
      return { success: true, count: 0 };
    }
    const result = await dispatchFullSync(scopedCookies);
    console.log(`[AntiFan Extension] Auto-hydrated ${result.count} cookies into AntiFan Desktop.`);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[AntiFan Extension] Auto-hydration notice:', message);
    return { success: false, count: 0, error: message || 'AUTO_HYDRATION_FAILED' };
  } finally {
    isHydrating = false;
  }
}

async function getActiveTabHostname(): Promise<string | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].url) {
      const url = new URL(tabs[0].url);
      return url.hostname;
    }
  } catch {}
  return null;
}

// Listen to cookie changes
if (typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener(async (changeInfo: any) => {
    if (!isDeltaSyncEnabled) return;

    const activeTabHost = syncActiveTabOnly ? await getActiveTabHostname() : null;
    const inScope = isCookieInScope(
      changeInfo.cookie,
      enabledProfiles,
      activeTabHost
    );

    if (inScope) {
      debouncer.addChange(changeInfo);
    }
  });
}

// Runtime messages from popup
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((request: any, sender: any, sendResponse: (res: any) => void) => {

    if (request.action === 'SYNC_ACTIVE_TAB') {
      (async () => {
        try {
          const activeHost = await getActiveTabHostname();
          if (!activeHost) {
            sendResponse({ success: false, error: 'NO_ACTIVE_TAB' });
            return;
          }

          const allCookies = await chrome.cookies.getAll({});
          const targetCookies = allCookies.filter((c: ExtensionCookie) =>
            isCookieInScope(c, enabledProfiles, activeHost)
          );

          await dispatchDeltaSync({ upserted: targetCookies, removed: [] });
          sendResponse({ success: true, count: targetCookies.length, host: activeHost });
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (request.action === 'GET_STATUS') {
      (async () => {
        const auth = await ensureBridgeAuth(false);
        sendResponse({
          connected: Boolean(auth?.token && auth?.port),
          auth,
          lastError: auth?.token ? null : lastBridgeError,
          enabledProfiles,
          syncActiveTabOnly,
          isDeltaSyncEnabled,
        });
      })();
      return true;
    }
    if (request.action === 'RECONNECT') {
      (async () => {
        const auth = await ensureBridgeAuth(true);
        sendResponse({ status: 'RECONNECTED', connected: Boolean(auth?.token), auth });
      })();
      return true;
    }

    return false;
  });
}

// Start up

// Watchdog for MV3 Service Worker suspension recovery
if (typeof chrome !== 'undefined' && chrome.alarms) {
  try {
    chrome.alarms.create('antifan-bridge-watchdog', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm: { name?: string }) => {
      if (alarm && alarm.name === 'antifan-bridge-watchdog') {
        if (!bridgeAuth?.token) {
          ensureBridgeAuth().catch(() => {});
        }
      }
    });
  } catch {}
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onSuspend) {
  try {
    chrome.runtime.onSuspend.addListener(() => {
      // Flush is suppressed on shutdown/suspension to avoid sending exit cleanup removals
      debouncer.clear();
    });
  } catch {}
}
if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    loadSettings().then(async () => {
      await ensureBridgeAuth();
    });
  });
}
loadSettings().then(async () => {
  await ensureBridgeAuth();
});
