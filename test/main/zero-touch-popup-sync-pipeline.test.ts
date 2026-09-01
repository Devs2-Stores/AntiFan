import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { executeAuthenticatedCookieImport, BridgeAuth } from '../../src/extension/background';

class MockCookieStore {
  public cookies: Map<string, Record<string, unknown>> = new Map();

  public async set(details: Record<string, unknown>): Promise<void> {
    const key = `${details.url || ''}#${details.name || ''}`;
    this.cookies.set(key, { ...details });
  }

  public async remove(url: string, name: string): Promise<void> {
    const key = `${url}#${name}`;
    this.cookies.delete(key);
  }

  public async get(query: { name?: string; domain?: string }): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    for (const cookie of this.cookies.values()) {
      if (query.name && cookie.name !== query.name) continue;
      if (query.domain && cookie.domain !== query.domain) continue;
      results.push(cookie);
    }
    return results;
  }
}

class MockIsolatedSession {
  public cookies = new MockCookieStore();
}

class MockTabHostWithCapsulePartitions extends EventEmitter {
  public capsuleSession = new MockIsolatedSession();
  public defaultSession = new MockIsolatedSession();

  public isValidCapsulePartition(partition: string): boolean {
    return partition === 'persist:capsule-popup-e2e-test' || partition === 'persist:capsule-google-sync-test';
  }

  public getPartitionSession(partition: string): any {
    if (partition === 'persist:capsule-popup-e2e-test' || partition === 'persist:capsule-google-sync-test') {
      return this.capsuleSession;
    }
    return this.defaultSession;
  }

  public getActiveTabSession(): any {
    return this.defaultSession;
  }

  public getActiveTab(): any {
    return { id: 'tab-default', url: 'https://example.com' };
  }

  public getTabSession(_id: string): any {
    return this.defaultSession;
  }
}

// ----------------------------------------------------------------------------
// Suite 1: Pure Background Authenticated Ingestion & Token Rotation Resilience
// ----------------------------------------------------------------------------

test('Background Ingestion: Executes HTTP import with partition targeting', async () => {
  const tabHost = new MockTabHostWithCapsulePartitions();
  const server = new BridgeServer(tabHost as unknown as NativeTabHost, 0);
  const port = await server.start();

  const initialToken = server.getToken();
  assert.ok(initialToken, 'BridgeServer must issue valid master token');

  const currentAuth: BridgeAuth = {
    token: initialToken,
    port,
    activeCapsuleId: 'capsule-google-sync-test',
    activePartition: 'persist:capsule-google-sync-test',
  };

  const payload = {
    profileName: 'Chrome Live (Zero-Touch Native)',
    timestamp: Date.now(),
    cookies: [
      {
        name: 'SID',
        value: 'mock-google-sid-token-xyz',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
    ],
  };

  const syncResult = await executeAuthenticatedCookieImport(
    payload,
    async () => currentAuth,
    async () => currentAuth
  );

  assert.equal(syncResult.success, true);
  assert.equal(syncResult.count, 1);

  const googleCookies = await tabHost.capsuleSession.cookies.get({ domain: '.google.com' });
  assert.equal(googleCookies.length, 1);
  assert.equal(googleCookies[0]?.name, 'SID');

  server.dispose();
});

test('Background Ingestion: Auto-rehandshake and retry on token rotation (HTTP 401 resilience)', async () => {
  const tabHost = new MockTabHostWithCapsulePartitions();
  const server = new BridgeServer(tabHost as unknown as NativeTabHost, 0);
  const port = await server.start();

  const freshToken = server.getToken();
  const staleToken = 'stale-expired-token-12345';

  let reauthCalled = false;
  let currentAuth: BridgeAuth = {
    token: staleToken,
    port,
    activeCapsuleId: 'capsule-google-sync-test',
    activePartition: 'persist:capsule-google-sync-test',
  };

  const payload = {
    profileName: 'Chrome Live (Zero-Touch Native)',
    timestamp: Date.now(),
    cookies: [
      {
        name: 'LOGIN_INFO',
        value: 'mock-youtube-login-token-789',
        domain: '.youtube.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
      },
    ],
  };

  const syncResult = await executeAuthenticatedCookieImport(
    payload,
    async () => currentAuth,
    async () => {
      reauthCalled = true;
      currentAuth = {
        token: freshToken,
        port,
        activeCapsuleId: 'capsule-google-sync-test',
        activePartition: 'persist:capsule-google-sync-test',
      };
      return currentAuth;
    }
  );

  assert.equal(reauthCalled, true, 'Must call reauthSupplier upon receiving 401');
  assert.equal(syncResult.success, true);
  assert.equal(syncResult.count, 1);

  const ytCookies = await tabHost.capsuleSession.cookies.get({ domain: '.youtube.com' });
  assert.equal(ytCookies.length, 1);
  assert.equal(ytCookies[0]?.name, 'LOGIN_INFO');

  server.dispose();
});

test('Background Ingestion: Graceful error report when AntiFan Desktop is offline', async () => {
  const payload = {
    profileName: 'Chrome Live (Zero-Touch Native)',
    timestamp: Date.now(),
    cookies: [{ name: 'test', value: '1', domain: '.example.com', path: '/' }],
  };

  const syncResult = await executeAuthenticatedCookieImport(
    payload,
    async () => null,
    async () => null
  );

  assert.equal(syncResult.success, false);
  assert.equal(syncResult.error, 'NOT_CONNECTED_TO_ANTIFAN');
});

// ----------------------------------------------------------------------------
// Suite 2: Full Chrome MV3 Runtime Harness: Popup.js -> Background -> Native -> HTTP
// ----------------------------------------------------------------------------

interface MockElement {
  id: string;
  className: string;
  textContent: string;
  innerHTML: string;
  disabled?: boolean;
  value?: string;
  type?: string;
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    contains: (c: string) => boolean;
  };
  listeners: Record<string, Array<(...args: any[]) => any>>;
  addEventListener: (event: string, handler: (...args: any[]) => any) => void;
  click: () => Promise<void>;
}

function createMockElement(id: string): MockElement {
  let _className = '';
  const listeners: Record<string, Array<(...args: any[]) => any>> = {};

  const el: MockElement = {
    id,
    get className() {
      return _className;
    },
    set className(val: string) {
      _className = val;
    },
    textContent: '',
    innerHTML: '',
    disabled: false,
    value: '',
    type: 'text',
    classList: {
      add: (c: string) => {
        const tokens = _className.split(/\s+/).filter(Boolean);
        if (!tokens.includes(c)) {
          tokens.push(c);
          _className = tokens.join(' ');
        }
      },
      remove: (c: string) => {
        const tokens = _className.split(/\s+/).filter(Boolean);
        _className = tokens.filter((t) => t !== c).join(' ');
      },
      contains: (c: string) => {
        return _className.split(/\s+/).filter(Boolean).includes(c);
      },
    },
    listeners,
    addEventListener: (event: string, handler: (...args: any[]) => any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    click: async () => {
      const handlers = listeners['click'] || [];
      for (const h of handlers) {
        await h();
      }
    },
  };
  return el;
}

test('Zero-Touch Popup Pipeline: Full Chrome Extension MV3 Harness (Popup Click -> Background -> Native Handshake -> Ingest)', async () => {
  const tabHost = new MockTabHostWithCapsulePartitions();
  const server = new BridgeServer(tabHost as unknown as NativeTabHost, 0);
  const bridgePort = await server.start();
  const masterToken = server.getToken();

  const targetCapsuleId = 'capsule-popup-e2e-test';
  const targetPartition = 'persist:capsule-popup-e2e-test';

  // 1. Mock Chrome Storage & Cookies Store
  const mockStorage: Record<string, any> = {};
  const mockChromeCookies = [
    {
      name: 'SID',
      value: 'google-auth-sid-token-12345',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'HSID',
      value: 'google-auth-hsid-token-67890',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'LOGIN_INFO',
      value: 'youtube-login-token-abcdef',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    },
  ];

  // 2. Simulated Chrome Runtime
  const runtimeListeners: Array<(msg: any, sender: any, sendResponse: (res: any) => void) => void | boolean> = [];
  const createdPorts: any[] = [];
  let activeNativePort: any = null;
  let isNativeHostAvailable = true;

  const mockChrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const res: Record<string, any> = {};
          for (const k of keys) {
            if (k in mockStorage) res[k] = mockStorage[k];
          }
          return res;
        },
        set: async (items: Record<string, any>) => {
          Object.assign(mockStorage, items);
        },
        remove: async (keys: string[]) => {
          for (const k of keys) delete mockStorage[k];
        },
      },
    },
    cookies: {
      getAll: async (_query: any) => mockChromeCookies,
    },
    runtime: {
      lastError: null as any,
      onMessage: {
        addListener: (fn: any) => {
          runtimeListeners.push(fn);
        },
      },
      sendMessage: (msg: any, callback?: (res: any) => void) => {
        let responded = false;
        const sendResponse = (res: any) => {
          if (!responded && callback) {
            responded = true;
            callback(res);
          }
        };

        for (const listener of runtimeListeners) {
          const isAsync = listener(msg, { id: 'popup' }, sendResponse);
          if (!isAsync && !responded && callback) {
            // Synchronous listener
          }
        }
      },
      connectNative: (host: string) => {
        assert.equal(host, 'com.antifan.bridge');
        let portMessageHandler: any = null;
        let portDisconnectListener: any = null;
        const portObj = {
          onMessage: {
            addListener: (fn: any) => {
              portMessageHandler = fn;
            },
          },
          onDisconnect: {
            addListener: (fn: any) => {
              portDisconnectListener = fn;
            },
          },
          postMessage: (msg: any) => {
            if (msg.action === 'HANDSHAKE') {
              if (isNativeHostAvailable) {
                setTimeout(() => {
                  if (portMessageHandler) {
                    portMessageHandler({
                      status: 'SUCCESS',
                      token: masterToken,
                      port: bridgePort,
                      activeCapsuleId: targetCapsuleId,
                      activePartition: targetPartition,
                    });
                  }
                }, 10);
              } else {
                setTimeout(() => {
                  if (portDisconnectListener) {
                    portDisconnectListener();
                  }
                }, 10);
              }
            }
          },
          disconnect: () => {
            if (portDisconnectListener) {
              portDisconnectListener();
            }
          },
          _triggerDisconnect: () => {
            if (portDisconnectListener) {
              portDisconnectListener();
            }
          },
          _triggerMessage: (msg: any) => {
            if (portMessageHandler) {
              portMessageHandler(msg);
            }
          },
        };
        createdPorts.push(portObj);
        activeNativePort = portObj;
        return portObj;
      },
    },
  };
  const scheduledTimers: Array<{ fn: (...args: any[]) => void; delay: number }> = [];
  const customSetTimeout = (fn: (...args: any[]) => void, delay?: number) => {
    if (delay === 5000) {
      // Record reconnect timer to prevent unmanaged open timers in Node test runner
      scheduledTimers.push({ fn, delay: 5000 });
      return 99999 as any;
    }
    return setTimeout(fn, delay);
  };

  const bgPath = path.resolve(process.cwd(), 'extension', 'background.js');
  const bgCode = fs.readFileSync(bgPath, 'utf8');

  const bgContext = vm.createContext({
    chrome: mockChrome,
    fetch: globalThis.fetch,
    console: console,
    setTimeout: customSetTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    URL: globalThis.URL,
    Array: globalThis.Array,
    Object: globalThis.Object,
    JSON: globalThis.JSON,
    Promise: globalThis.Promise,
  });

  vm.runInContext(bgCode, bgContext);

  // Allow initial load and handshake to settle
  await new Promise((r) => setTimeout(r, 60));

  // 4. Setup Mock Popup DOM
  const elements: Record<string, MockElement> = {
    'status-badge': createMockElement('status-badge'),
    'status-text': createMockElement('status-text'),
    'cookie-count': createMockElement('cookie-count'),
    'google-status': createMockElement('google-status'),
    'zero-touch-banner': createMockElement('zero-touch-banner'),
    'sync-btn': createMockElement('sync-btn'),
    'result-message': createMockElement('result-message'),
    'port-indicator': createMockElement('port-indicator'),
  };

  const mockDocument = {
    getElementById: (id: string) => elements[id] || null,
  };

  // 5. Load & Run popup.js in simulated browser context
  const popupPath = path.resolve(process.cwd(), 'extension', 'popup.js');
  const popupCode = fs.readFileSync(popupPath, 'utf8');

  const popupContext = vm.createContext({
    chrome: mockChrome,
    document: mockDocument,
    fetch: globalThis.fetch,
    console: console,
    setTimeout: globalThis.setTimeout,
    Date: globalThis.Date,
    Array: globalThis.Array,
    Object: globalThis.Object,
    JSON: globalThis.JSON,
    Promise: globalThis.Promise,
  });

  vm.runInContext(popupCode, popupContext);

  // Allow discoverBridge() and loadCookieStats() to complete
  await new Promise((r) => setTimeout(r, 60));

  // Verify Popup DOM state after auto-discovery:
  assert.equal(elements['cookie-count']?.textContent, '3');
  assert.equal(elements['google-status']?.textContent, 'Đã đăng nhập');
  assert.equal(elements['status-text']?.textContent, 'AntiFan Online (Tự động)');
  assert.equal(elements['port-indicator']?.textContent, `Port: ${bridgePort}`);

  // 6. User clicks "Đồng bộ ngay sang AntiFan"
  await elements['sync-btn']?.click();

  // Allow async message pipeline to complete
  await new Promise((r) => setTimeout(r, 100));

  // 7. Verify Popup Result Message & Ingested Cookies in Partition
  const resultMsg = elements['result-message']?.textContent || '';
  assert.ok(
    resultMsg.includes('Đã đồng bộ thành công 3 cookies sang AntiFan!'),
    `Expected success message in popup UI, got: ${resultMsg}`
  );

  // Verify cookies in target capsule partition session
  const ingestedGoogle = await tabHost.capsuleSession.cookies.get({ domain: '.google.com' });
  assert.equal(ingestedGoogle.length, 2);
  assert.equal(ingestedGoogle.some((c) => c.name === 'SID' && c.value === 'google-auth-sid-token-12345'), true);
  assert.equal(ingestedGoogle.some((c) => c.name === 'HSID' && c.value === 'google-auth-hsid-token-67890'), true);

  const ingestedYt = await tabHost.capsuleSession.cookies.get({ domain: '.youtube.com' });
  assert.equal(ingestedYt.length, 1);
  assert.equal(ingestedYt[0]?.name, 'LOGIN_INFO');

  // Verify 0 cookie leakage into default session
  const defaultCookies = await tabHost.defaultSession.cookies.get({});
  assert.equal(defaultCookies.length, 0);
  // 8. Disconnect / Desktop-Off Disconfirmation Test
  // Simulate AntiFan Desktop closing / native host becoming unavailable
  isNativeHostAvailable = false;
  activeNativePort?.disconnect();
  await new Promise((r) => setTimeout(r, 50));

  // Verify storage was cleared upon disconnect
  assert.equal(mockStorage['bridgeAuth'], undefined, 'bridgeAuth must be cleared from storage upon disconnect');
  // Verify 5000ms reconnect retry was scheduled
  assert.ok(
    scheduledTimers.some((t) => t.delay === 5000),
    'Must schedule 5000ms reconnect retry upon disconnect'
  );

  // Verify GET_STATUS returns disconnected
  let statusResponse: any = null;
  mockChrome.runtime.sendMessage({ action: 'GET_STATUS' }, (res) => {
    statusResponse = res;
  });
  assert.equal(statusResponse?.connected, false);
  assert.equal(statusResponse?.auth, null);

  // Re-run popup discoverBridge() in disconnected state
  vm.runInContext('discoverBridge();', popupContext);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(elements['status-text']?.textContent, 'Chưa mở AntiFan');
  assert.equal(elements['port-indicator']?.textContent, 'Port: --');
  assert.ok(elements['zero-touch-banner']?.classList.contains('disconnected'));

  // User attempts to click sync button while AntiFan Desktop is offline
  await elements['sync-btn']?.click();
  await new Promise((r) => setTimeout(r, 50));

  const offlineMsg = elements['result-message']?.textContent || '';
  assert.ok(
    offlineMsg.includes('Chưa mở AntiFan Desktop'),
    `Expected offline error message in popup, got: ${offlineMsg}`
  );

  // 9. Stale Disconnect Callback & Conditional Retry Disconfirmation Test
  try {
    // Reconnect when host becomes available again -> Creates a fresh connected Port
    isNativeHostAvailable = true;
    mockChrome.runtime.sendMessage({ action: 'RECONNECT' });
    await new Promise((r) => setTimeout(r, 60));

    const getStoredBridgeAuth = (): BridgeAuth | undefined => mockStorage['bridgeAuth'];
    const portCountAfterReconnect = createdPorts.length;
    assert.ok(portCountAfterReconnect >= 2, 'Must have created initial port(s) and a fresh reconnect port');
    assert.equal(getStoredBridgeAuth()?.token, masterToken, 'Reconnect port must have stored valid bridgeAuth');

    const stalePort = createdPorts[0];
    const activePort = createdPorts[createdPorts.length - 1];

    // Simulate stale Port 1's onDisconnect firing late (e.g. after fresh Port is established)
    stalePort._triggerDisconnect();
    await new Promise((r) => setTimeout(r, 20));

    // Active port and its credentials must remain completely untouched
    assert.equal(getStoredBridgeAuth()?.token, masterToken, 'Stale port disconnect must NOT clear active bridgeAuth');

    // Simulate stale Port 1's onMessage firing late with a rogue token
    stalePort._triggerMessage({ status: 'SUCCESS', token: 'rogue-stale-token', port: 12345 });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(getStoredBridgeAuth()?.token, masterToken, 'Stale port message must NOT overwrite active credentials');
    // Test conditional retry: running 5000ms timer while active port is healthy must NOT recreate nativePort
    const reconnectTimers = scheduledTimers.filter((t) => t.delay === 5000);
    for (const timer of reconnectTimers) {
      timer.fn();
    }
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(createdPorts.length, portCountAfterReconnect, '5000ms reconnect timer must NOT spawn new port while active connection is healthy');
  } finally {
    isNativeHostAvailable = false;
    activeNativePort?.disconnect();
    server.dispose();
  }
});

test('Zero-Touch Auto-Hydration: Ingests scoped cookies on Handshake without popup and recovers via Watchdog alarm', async () => {
  const tabHost = new MockTabHostWithCapsulePartitions();
  const server = new BridgeServer(tabHost as unknown as NativeTabHost, 0);
  const bridgePort = await server.start();
  const masterToken = server.getToken();

  const targetCapsuleId = 'capsule-google-sync-test';
  const targetPartition = 'persist:capsule-google-sync-test';

  const mockStorage: Record<string, any> = {};
  const mockChromeCookies = [
    {
      name: 'SID',
      value: 'auto-hydrated-sid-token-12345',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'SHOPIFY_S',
      value: 'shopify-session-token-abcde',
      domain: '.myshopify.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    {
      name: 'UNSCOPED_TRACKER',
      value: 'tracker-xyz',
      domain: '.ad-tracker-unknown.com',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'no_restriction',
    },
  ];

  let activeNativePort: any = null;
  let isNativeHostAvailable = true;
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];

  const mockChrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const res: Record<string, any> = {};
          for (const k of keys) {
            if (k in mockStorage) res[k] = mockStorage[k];
          }
          return res;
        },
        set: async (items: Record<string, any>) => {
          Object.assign(mockStorage, items);
        },
        remove: async (keys: string[]) => {
          for (const k of keys) delete mockStorage[k];
        },
      },
    },
    cookies: {
      getAll: async (_query: any) => mockChromeCookies,
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: (_name: string, _info: any) => {},
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => {
          alarmListeners.push(fn);
        },
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      connectNative: (host: string) => {
        assert.equal(host, 'com.antifan.bridge');
        let portMessageHandler: any = null;
        let portDisconnectListener: any = null;
        const portObj = {
          onMessage: {
            addListener: (fn: any) => {
              portMessageHandler = fn;
            },
          },
          onDisconnect: {
            addListener: (fn: any) => {
              portDisconnectListener = fn;
            },
          },
          postMessage: (msg: any) => {
            if (msg.action === 'HANDSHAKE') {
              if (isNativeHostAvailable) {
                setTimeout(() => {
                  if (portMessageHandler) {
                    portMessageHandler({
                      status: 'SUCCESS',
                      token: masterToken,
                      port: bridgePort,
                      activeCapsuleId: targetCapsuleId,
                      activePartition: targetPartition,
                    });
                  }
                }, 10);
              } else {
                setTimeout(() => {
                  if (portDisconnectListener) {
                    portDisconnectListener();
                  }
                }, 10);
              }
            }
          },
          disconnect: () => {
            if (portDisconnectListener) {
              portDisconnectListener();
            }
          },
        };
        activeNativePort = portObj;
        return portObj;
      },
    },
  };

  const bgPath = path.resolve(process.cwd(), 'extension', 'background.js');
  const bgCode = fs.readFileSync(bgPath, 'utf8');

  const bgContext = vm.createContext({
    chrome: mockChrome,
    fetch: globalThis.fetch,
    console: console,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    URL: globalThis.URL,
    Array: globalThis.Array,
    Object: globalThis.Object,
    JSON: globalThis.JSON,
    Promise: globalThis.Promise,
  });

  // 1. Run Background Script — zero popup interaction
  vm.runInContext(bgCode, bgContext);

  // Allow auto-hydration on handshake to complete
  await new Promise((r) => setTimeout(r, 150));

  // 2. Assert that scoped cookies (Google & Shopify) automatically reached the capsule session
  const capsuleGoogle = await tabHost.capsuleSession.cookies.get({ domain: '.google.com' });
  assert.equal(capsuleGoogle.length, 1);
  assert.equal(capsuleGoogle[0]?.name, 'SID');
  assert.equal(capsuleGoogle[0]?.value, 'auto-hydrated-sid-token-12345');

  const capsuleShopify = await tabHost.capsuleSession.cookies.get({ domain: '.myshopify.com' });
  assert.equal(capsuleShopify.length, 1);
  assert.equal(capsuleShopify[0]?.name, 'SHOPIFY_S');

  // 3. Assert unscoped cookies were filtered out
  const capsuleUnscoped = await tabHost.capsuleSession.cookies.get({ domain: '.ad-tracker-unknown.com' });
  assert.equal(capsuleUnscoped.length, 0);

  // 4. Assert Watchdog alarm reconnects when disconnected
  isNativeHostAvailable = false;
  activeNativePort?.disconnect();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mockStorage['bridgeAuth'], undefined);

  // Now host becomes available and watchdog alarm fires
  isNativeHostAvailable = true;
  assert.ok(alarmListeners.length > 0, 'Watchdog alarm listener must be registered');
  for (const listener of alarmListeners) {
    listener({ name: 'antifan-bridge-watchdog' });
  }
  await new Promise((r) => setTimeout(r, 150));

  // Assert re-authenticated and auto-hydrated
  const getBridgeAuth = (): BridgeAuth | undefined => mockStorage['bridgeAuth'];
  assert.equal(getBridgeAuth()?.token, masterToken);
  server.dispose();
});
