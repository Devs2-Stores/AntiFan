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
let enabledProfiles: string[] = ['google', 'ecommerce'];
let syncActiveTabOnly = false;
let isDeltaSyncEnabled = true;
let lastNativeError: string | null = null;

const debouncer = new CookieDebouncer(async (batch: DeltaSyncBatch) => {
  await dispatchDeltaSync(batch);
}, 300, 1000);

export async function loadSettings(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const stored = await chrome.storage.local.get([
    'bridgeAuth',
    'enabledProfiles',
    'syncActiveTabOnly',
    'isDeltaSyncEnabled',
  ]);
  if (stored.bridgeAuth) bridgeAuth = stored.bridgeAuth;
  if (stored.enabledProfiles) enabledProfiles = stored.enabledProfiles;
  if (typeof stored.syncActiveTabOnly === 'boolean') syncActiveTabOnly = stored.syncActiveTabOnly;
  if (typeof stored.isDeltaSyncEnabled === 'boolean') isDeltaSyncEnabled = stored.isDeltaSyncEnabled;
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
      console.log('[AntiFan Extension] Received from Native Host:', msg);
      if (msg.status === 'SUCCESS' && msg.token) {
        lastNativeError = null;
        bridgeAuth = {
          token: msg.token,
          port: msg.port,
          activeCapsuleId: msg.activeCapsuleId,
          activePartition: msg.activePartition,
        };
        if (chrome.storage?.local) {
          await chrome.storage.local.set({ bridgeAuth });
        }
        // Zero-touch auto-hydration on successful handshake
        triggerAutoHydration().catch(() => {});
      } else if (msg.status === 'ERROR') {
        lastNativeError = msg.message || msg.error || 'NATIVE_IPC_ERROR';
        console.warn('[AntiFan Extension] Native Host reported error:', lastNativeError);
      }
    });

    port.onDisconnect.addListener(() => {
      if (nativePort === port) {
        const disconnectMsg = chrome.runtime.lastError?.message;
        console.warn('[AntiFan Extension] Native Host disconnected:', disconnectMsg);
        if (typeof disconnectMsg === 'string' && disconnectMsg.length > 0) {
          lastNativeError = disconnectMsg;
        }
        nativePort = null;
        bridgeAuth = null;
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.remove(['bridgeAuth']).catch(() => {});
        }
        // Fallback immediately to local HTTP loopback if Native Messaging host is absent
        tryHttpHandshake().then((auth) => {
          if (auth) {
            lastNativeError = null;
            triggerAutoHydration().catch(() => {});
          }
        }).catch(() => {});
        // Retry native connection after 10 seconds if still disconnected
        setTimeout(() => {
          if (!nativePort && !bridgeAuth) {
            connectNativeMessaging();
          }
        }, 10000);
      }
    });
    // Send initial handshake to retrieve port and token
    port.postMessage({ action: 'HANDSHAKE' });
  } catch (err) {
    console.error('[AntiFan Extension] Failed to connect native messaging:', err);
  }
}

export async function ensureBridgeAuth(forceRefresh = false, timeoutMs = 2500): Promise<BridgeAuth | null> {
  if (forceRefresh) {
    bridgeAuth = null;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try { await chrome.storage.local.remove(['bridgeAuth']); } catch {}
    }
  }

  if (!forceRefresh && bridgeAuth?.token && bridgeAuth?.port) {
    return bridgeAuth;
  }

  // Check chrome.storage.local if not forcing refresh
  if (!forceRefresh && typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(['bridgeAuth']);
    if (stored.bridgeAuth?.token && stored.bridgeAuth?.port) {
      bridgeAuth = stored.bridgeAuth;
      return bridgeAuth;
    }
  }

  if (!nativePort) {
    connectNativeMessaging();
  }

  if (nativePort) {
    try {
      nativePort.postMessage({ action: 'HANDSHAKE' });
    } catch {}
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bridgeAuth?.token && bridgeAuth?.port) {
      return bridgeAuth;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // Fallback: Direct Local Loopback Handshake (Zero-Touch without Native Messaging C# Shim!)
  if (!bridgeAuth?.token || !bridgeAuth?.port) {
    await tryHttpHandshake();
  }
  return bridgeAuth;
}

export async function tryHttpHandshake(): Promise<BridgeAuth | null> {
  const candidatePorts = [20130, 20129, 20137];
  for (const p of candidatePorts) {
    try {
      const res = await (typeof fetch !== 'undefined' ? fetch : globalThis.fetch)(`http://127.0.0.1:${p}/api/extension/handshake`);
      if (res.ok) {
        const data = (await res.json()) as { status?: string; token?: string; port?: number; activeCapsuleId?: string; activePartition?: string } | null;
        if (data && data.status === 'SUCCESS' && data.token && data.port) {
          bridgeAuth = {
            token: data.token,
            port: data.port,
            activeCapsuleId: data.activeCapsuleId,
            activePartition: data.activePartition,
          };
          lastNativeError = null;
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            await chrome.storage.local.set({ bridgeAuth });
          }
          return bridgeAuth;
        }
      }
    } catch {}
  }
  return null;
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
      console.warn('[AntiFan Extension] Received 401 Unauthorized, re-authenticating with Native Host...');
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

export async function dispatchDeltaSync(batch: DeltaSyncBatch): Promise<void> {
  if (batch.upserted.length === 0 && batch.removed.length === 0) return;

  const payload = {
    cookies: batch.upserted,
    removed: batch.removed,
    source: 'chrome-extension-delta',
    timestamp: Date.now(),
  };

  await executeAuthenticatedCookieImport(
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
    if (request.action === 'SYNC_ALL_COOKIES') {
      (async () => {
        try {
          const allCookies = await chrome.cookies.getAll({});
          const result = await dispatchFullSync(allCookies);
          sendResponse(result);
        } catch (err: any) {
          sendResponse({ success: false, count: 0, error: err.message });
        }
      })();
      return true;
    }

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
        if (!bridgeAuth?.token) {
          await ensureBridgeAuth(false, 800);
        }
        sendResponse({
          connected: Boolean(bridgeAuth?.token && bridgeAuth?.port),
          auth: bridgeAuth,
          lastError: bridgeAuth?.token ? null : lastNativeError,
          enabledProfiles,
          syncActiveTabOnly,
          isDeltaSyncEnabled,
        });
      })();
      return true;
    }
    if (request.action === 'RECONNECT') {
      connectNativeMessaging();
      sendResponse({ status: 'RECONNECTING' });
      return false;
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
        if (!nativePort || !bridgeAuth) {
          connectNativeMessaging();
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
      connectNativeMessaging();
      await ensureBridgeAuth();
    });
  });
}
loadSettings().then(async () => {
  connectNativeMessaging();
  await ensureBridgeAuth();
});
