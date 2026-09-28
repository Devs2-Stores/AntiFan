/**
 * Zero-argument "active tab" authority.
 *
 * The rule under test: an agent-facing surface answers a target-less call from the
 * target that call was authenticated for, or refuses by name — it never reports the
 * window that happens to be focused, and never substitutes a tab from another window.
 * A native menu is the user's own action, so there the focused window is the evidence,
 * and the window directory has to answer with that window's host.
 *
 * These checks run under plain node (`test:main`), where no Electron transport exists:
 * the menu modules are loaded only after a stubbed `electron` is installed, and the
 * bridge and the action registry run over hand-written host doubles.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import type { BrowserWindow, WebContents } from 'electron';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
import { CapabilityError, makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import type { BrowserTarget, RuntimeLease } from '../../src/shared/control-plane-contracts';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { buildApplicationMenu } from '../../src/main/browser/app-menu';
import type { TabContextMenuBuilder } from '../../src/main/browser/tab-context-menu';

// ---------------------------------------------------------------------------
// Host doubles
// ---------------------------------------------------------------------------

/**
 * The three tabs every case is phrased against: the tab the window presents, the tab an
 * agent holds a target for, and a second agent tab. `activeTabQueries` counts every read
 * of the presented tab, which is what makes "no ambient fallback happened" observable
 * instead of merely inferred from a result.
 */
class RecordingTabHost extends EventEmitter {
  public activeTabQueries = 0;
  public readonly reloads: string[] = [];
  public readonly navigations: Array<{ tabId: string; url: string }> = [];
  private readonly tabs = [
    { id: 'tab-foreground', url: 'https://foreground.example/', title: 'Foreground' },
    { id: 'tab-bound', url: 'https://bound.example/', title: 'Bound' },
    { id: 'tab-other', url: 'https://other.example/', title: 'Other' },
  ];

  public getTabList(): Array<{ id: string; url: string; title: string }> {
    return this.tabs.map((tab) => ({ ...tab }));
  }

  public hasTab(tabId?: string | null): boolean {
    return Boolean(tabId && this.tabs.some((tab) => tab.id === tabId));
  }

  public getActiveTabId(): string {
    this.activeTabQueries += 1;
    return 'tab-foreground';
  }

  public getAutomationTabId(): string | null {
    return null;
  }

  public getTabWebContents(tabId?: string): { isDestroyed: () => boolean; getURL: () => string; getTitle: () => string } | null {
    if (!this.hasTab(tabId)) return null;
    const url = this.tabs.find((tab) => tab.id === tabId)?.url ?? 'about:blank';
    return { isDestroyed: () => false, getURL: () => url, getTitle: () => 'Tab' };
  }

  public reload(tabId: string): boolean {
    this.reloads.push(tabId);
    return true;
  }

  public navigate(tabId: string, url: string): boolean {
    this.navigations.push({ tabId, url });
    return true;
  }

  public goBack(tabId: string): boolean {
    this.navigations.push({ tabId, url: 'back' });
    return true;
  }

  public goForward(tabId: string): boolean {
    this.navigations.push({ tabId, url: 'forward' });
    return true;
  }
}

function asHost(double: object): NativeTabHost {
  // The doubles implement the surface each module actually calls; the host class itself
  // needs a live Electron process, which the main test lane does not have.
  return double as unknown as NativeTabHost;
}

// ---------------------------------------------------------------------------
// Bridge HTTP helpers
// ---------------------------------------------------------------------------

interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

function requestJson(port: number, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpAnswer> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpAnswer>();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = http.request(
    {
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      },
    },
    (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const parsed: Record<string, unknown> = raw ? JSON.parse(raw) : {};
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    }
  );
  request.on('error', reject);
  if (payload) request.write(payload);
  request.end();
  return promise;
}

async function claimPairingCode(port: number): Promise<string> {
  const answer = await requestJson(port, 'GET', '/api/pairing/challenge');
  assert.strictEqual(answer.status, 200, 'a loopback client must be able to claim a pairing challenge');
  const code = answer.body.code;
  assert.strictEqual(typeof code, 'string', 'the challenge response must carry a code');
  return code as string;
}

async function exchangeAttachment(port: number, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const code = await claimPairingCode(port);
  const answer = await requestJson(port, 'POST', '/api/pairing/exchange', { code, clientClass: 'mcp', ...extra });
  assert.strictEqual(answer.status, 200, `pairing exchange must succeed, got ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

interface AttachmentIdentity {
  tabId?: string;
  browserTarget?: { tabId?: string };
}

function identityOf(registry: AttachmentRegistry, attachmentId: unknown): AttachmentIdentity {
  assert.strictEqual(typeof attachmentId, 'string', 'the exchange response must carry an attachment id');
  const record = registry.getRecord(attachmentId as string);
  assert.ok(record, 'the issued attachment must be registered');
  return record;
}

// Control-plane ids are shape-checked ("Invalid project ID") on the attachment path, so
// the binding has to be built the same way a runtime builds it.
const PROJECT_ID = makeControlPlaneId('project');
const WORKSPACE_ID = makeControlPlaneId('workspace');
const RUNTIME_ID = makeControlPlaneId('runtime');

interface RuntimeBindingDouble {
  lease: RuntimeLease;
  projectId: string;
  workspaceId: string;
  browserTarget?: BrowserTarget;
}

function makeLease(): RuntimeLease {
  return {
    runtimeId: RUNTIME_ID,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    token: makeControlPlaneId('session'),
    protocolVersion: 1,
    hostEpoch: 1,
    ownerPid: process.pid,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
}

function makeBrowserTarget(tabId: string): BrowserTarget {
  return {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    runtimeId: RUNTIME_ID,
    tabId,
    browserEpoch: 1,
    documentGeneration: 1,
  };
}

/** The binding a runtime caller carries: it may or may not name the tab it holds. */
function makeBinding(tabId?: string): RuntimeBindingDouble {
  return {
    lease: makeLease(),
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    ...(tabId ? { browserTarget: makeBrowserTarget(tabId) } : {}),
  };
}

interface InitFrame {
  event?: string;
  data?: { status?: Record<string, unknown>; tabs?: Array<{ id?: string }>; activeTabId?: string };
}

function waitForInitFrame(ws: WebSocket): Promise<InitFrame> {
  const { promise, resolve, reject } = Promise.withResolvers<InitFrame>();
  ws.on('error', reject);
  ws.on('message', (raw) => {
    const frame: InitFrame = JSON.parse(raw.toString());
    if (frame.event === 'antifan:init') resolve(frame);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Menu transport stub
// ---------------------------------------------------------------------------

interface CapturedItem {
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  type?: string;
  click?: (item?: unknown, window?: unknown, event?: unknown) => void;
  /** What Electron calls a nested menu in a template. */
  submenu?: CapturedItem[];
  /** What a built menu exposes as its children. */
  items?: CapturedItem[];
}

let capturedMenus: Array<{ items: CapturedItem[] }> = [];
let capturedTemplates: CapturedItem[][] = [];
const popupWaiters: Array<() => void> = [];

class StubMenu {
  public readonly items: CapturedItem[] = [];

  constructor() {
    capturedMenus.push(this);
  }

  public append(item: CapturedItem): void {
    this.items.push(item);
  }

  public popup(): void {
    const waiter = popupWaiters.shift();
    if (waiter) waiter();
  }

  public static buildFromTemplate(template: CapturedItem[]): StubMenu {
    capturedTemplates.push(template);
    const menu = new StubMenu();
    menu.items.push(...template);
    return menu;
  }
}

class StubMenuItem implements CapturedItem {
  public label?: string;
  public accelerator?: string;
  public enabled?: boolean;
  public type?: string;
  public click?: (item?: unknown, window?: unknown, event?: unknown) => void;
  public items?: CapturedItem[];

  constructor(options: CapturedItem) {
    Object.assign(this, options);
  }
}

/**
 * Install the Electron stand-in used by the menu modules. A native menu cannot be built
 * outside Electron, so the transport is stubbed while the templates, click routing and
 * resolution stay the production code paths.
 */
function installElectronStub(): void {
  const stub = {
    app: { quit: () => undefined, relaunch: () => undefined, exit: () => undefined },
    dialog: { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 2, showErrorBox: () => undefined },
    Menu: StubMenu,
    MenuItem: StubMenuItem,
    BrowserWindow: class {},
    shell: { openExternal: async () => undefined },
    clipboard: { writeText: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const electronPath = require.resolve('electron');
  // A cache entry is what `require` reads; Node's own Module constructor produces one.
  const entry = new (require('node:module').Module)(electronPath);
  entry.loaded = true;
  entry.exports = stub;
  require.cache[electronPath] = entry;
}

// The Electron transport does not exist under plain node, and the menu modules capture
// `electron` when they are first loaded: the stub has to be in the registry before any
// of them is required, which is why this runs at module scope and not inside a case.
installElectronStub();

interface MenuHostDouble {
  activeTabQueries: number;
  closedTabs: string[];
  reloadedTabs: string[];
  getActiveTabId: () => string;
}

function makeMenuHost(activeTabId: string): MenuHostDouble & Record<string, unknown> {
  const host = {
    activeTabQueries: 0,
    closedTabs: [] as string[],
    reloadedTabs: [] as string[],
    getActiveTabId(): string {
      host.activeTabQueries += 1;
      return activeTabId;
    },
    createTab: () => 'tab-created',
    reopenClosedTab: () => 'tab-reopened',
    closeTab: (tabId: string) => {
      host.closedTabs.push(tabId);
      return true;
    },
    reload: (tabId: string) => {
      host.reloadedTabs.push(tabId);
      return true;
    },
  };
  return host;
}

function lastMenuItems(): CapturedItem[] {
  const menu = capturedMenus[capturedMenus.length - 1];
  assert.ok(menu, 'a menu must have been captured');
  return menu.items;
}

function findItem(items: CapturedItem[], label: string): CapturedItem {
  const item = items.find((entry) => entry.label === label);
  assert.ok(item, `the menu must offer "${label}"`);
  return item;
}

/** The application menu is a template, so a section is `submenu`, not `items`. */
function submenuOf(items: CapturedItem[], label: string): CapturedItem[] {
  const section = findItem(items, label);
  assert.ok(section.submenu, `"${label}" must be a submenu`);
  return section.submenu;
}

function lastTemplate(): CapturedItem[] {
  const template = capturedTemplates[capturedTemplates.length - 1];
  assert.ok(template, 'a menu template must have been captured');
  return template;
}

// ---------------------------------------------------------------------------

describe('Zero-argument active-tab authority', () => {
  describe('bridge-server: an agent session is bound from its own authority or not at all', () => {
    it('mints an unbound attachment when the caller names no tab and holds no binding, even though a tab is presented', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding(), registry);
      try {
        const port = await server.start();
        const identity = identityOf(registry, (await exchangeAttachment(port)).attachmentId);

        assert.strictEqual(identity.tabId, undefined, 'no explicit target and no binding target must leave the attachment unbound');
        assert.strictEqual(identity.browserTarget, undefined, 'an unbound attachment must carry no browser target');
        assert.strictEqual(host.activeTabQueries, 0, 'the presented tab must never be read to fill in a missing target');
      } finally {
        server.dispose();
      }
    });

    it('binds the attachment to the target the runtime binding authenticates', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding('tab-bound'), registry);
      try {
        const port = await server.start();
        const identity = identityOf(registry, (await exchangeAttachment(port)).attachmentId);

        assert.strictEqual(identity.tabId, 'tab-bound', 'the authenticated binding target must answer for the session');
        assert.strictEqual(identity.browserTarget?.tabId, 'tab-bound');
        assert.strictEqual(host.activeTabQueries, 0, 'a binding target is not a reason to consult the presented tab');
      } finally {
        server.dispose();
      }
    });

    it('binds the attachment to an explicitly requested tabId', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding(), registry);
      try {
        const port = await server.start();
        const identity = identityOf(registry, (await exchangeAttachment(port, { tabId: 'tab-other' })).attachmentId);

        assert.strictEqual(identity.tabId, 'tab-other', 'an explicit request wins over any bound or presented answer');
        assert.strictEqual(host.activeTabQueries, 0);
      } finally {
        server.dispose();
      }
    });

    it('answers /status for an attachment credential from its own bound target', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding(), registry);
      try {
        const port = await server.start();
        const exchange = await exchangeAttachment(port, { tabId: 'tab-other' });
        const secret = exchange.secret;
        assert.strictEqual(typeof secret, 'string', 'the exchange must return the attachment secret');

        const answer = await requestJson(port, 'GET', '/status', undefined, { 'x-antifan-attachment-secret': secret as string });
        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.body.activeTabId, 'tab-other', "an attachment's status reports its own target");
        assert.strictEqual(answer.body.activeTabRefusal, undefined);
        assert.strictEqual(host.activeTabQueries, 0, 'the presented tab must stay out of an agent status snapshot');
      } finally {
        server.dispose();
      }
    });

    it('reports an honest absence with a reason when the attachment holds no bound target', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding(), registry);
      try {
        const port = await server.start();
        const exchange = await exchangeAttachment(port);
        const secret = exchange.secret;
        assert.strictEqual(typeof secret, 'string');

        const answer = await requestJson(port, 'GET', '/status', undefined, { 'x-antifan-attachment-secret': secret as string });
        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.body.activeTabId, undefined, 'an unbound agent caller must not be handed the presented tab');
        assert.strictEqual(typeof answer.body.activeTabRefusal, 'string');
        assert.match(String(answer.body.activeTabRefusal), /TARGET_REQUIRED/, 'the refusal must name the missing explicit target');
        assert.strictEqual(host.activeTabQueries, 0, 'the refusal must not be produced by consulting the presented tab');
      } finally {
        server.dispose();
      }
    });

    it('keeps the presenting host as the answer for the master-token user plane', async () => {
      const host = new RecordingTabHost();
      const server = new BridgeServer(asHost(host), 0);
      try {
        const port = await server.start();
        const answer = await requestJson(port, 'GET', '/status', undefined, { Authorization: `Bearer ${server.getToken()}` });

        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.body.activeTabId, 'tab-foreground', 'a user-plane client reads the window it is the user of');
        assert.strictEqual(answer.body.activeTabRefusal, undefined);
      } finally {
        server.dispose();
      }
    });

    it('scopes the init snapshot status of an attachment socket to its bound target', async () => {
      const host = new RecordingTabHost();
      const registry = new AttachmentRegistry();
      const server = new BridgeServer(asHost(host), 0, false, undefined, () => makeBinding(), registry);
      const sockets: WebSocket[] = [];
      try {
        const port = await server.start();
        const bound = await exchangeAttachment(port, { tabId: 'tab-bound' });
        const unbound = await exchangeAttachment(port);
        const open = async (secret: unknown): Promise<InitFrame> => {
          assert.strictEqual(typeof secret, 'string');
          const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-antifan-attachment-secret': secret as string } });
          sockets.push(ws);
          return waitForInitFrame(ws);
        };

        const boundFrame = await open(bound.secret);
        assert.strictEqual(boundFrame.data?.status?.activeTabId, 'tab-bound', 'an attachment socket sees its own target as active');
        assert.deepStrictEqual(boundFrame.data?.tabs?.map((tab) => tab.id), ['tab-bound'], 'the agent plane sees only its own tab');
        assert.strictEqual(boundFrame.data?.activeTabId, 'tab-bound');

        const unboundFrame = await open(unbound.secret);
        assert.strictEqual(unboundFrame.data?.status?.activeTabId, undefined, 'an unbound attachment must not be told the presented tab');
        assert.match(String(unboundFrame.data?.status?.activeTabRefusal), /TARGET_REQUIRED/);
        assert.strictEqual(unboundFrame.data?.activeTabId, undefined);
        assert.strictEqual(host.activeTabQueries, 0, 'no attachment snapshot may read the presented tab');
      } finally {
        for (const ws of sockets) ws.close();
        server.dispose();
      }
    });
  });

  describe('browser-action-registry: target-less actions resolve from the bound target or refuse', () => {
    it("acts on the invocation's authenticated target when no tabId is passed", async () => {
      const host = new RecordingTabHost();
      const registry = new BrowserActionRegistry(asHost(host));

      const reload = await registry.execute('reload', {}, false, { boundTabId: 'tab-bound' });
      assert.strictEqual(reload.success, true);
      assert.deepStrictEqual(host.reloads, ['tab-bound'], 'the invocation target answers, not the presented tab');

      await registry.execute('navigate', { url: 'https://bound.example/next' }, false, { boundTabId: 'tab-bound' });
      assert.deepStrictEqual(host.navigations, [{ tabId: 'tab-bound', url: 'https://bound.example/next' }]);
      assert.strictEqual(host.activeTabQueries, 0, 'no zero-argument action may read the presented tab');
    });

    it('refuses navigate, reload, goBack and goForward with no explicit target and no bound target', async () => {
      const host = new RecordingTabHost();
      const registry = new BrowserActionRegistry(asHost(host));
      const cases: Array<[string, Record<string, unknown>]> = [
        ['navigate', { url: 'https://example.com/' }],
        ['reload', {}],
        ['goBack', {}],
        ['goForward', {}],
      ];

      for (const [action, params] of cases) {
        await assert.rejects(
          () => registry.execute(action, params),
          (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED' && /tabId/.test(err.message),
          `${action} without a target must refuse by name`
        );
      }
      assert.strictEqual(host.activeTabQueries, 0, 'a refusal must not be reached by reading the presented tab');
      assert.strictEqual(host.reloads.length, 0);
      assert.strictEqual(host.navigations.length, 0);
    });

    it('prefers an explicit tabId over the bound target', async () => {
      const host = new RecordingTabHost();
      const registry = new BrowserActionRegistry(asHost(host));

      await registry.execute('reload', { tabId: 'tab-other' }, false, { boundTabId: 'tab-bound' });
      assert.deepStrictEqual(host.reloads, ['tab-other'], 'the explicit parameter is the caller naming its target');
    });

    it('answers listTabs and getStatus from the bound target, and reports a reason instead of another tab', async () => {
      const host = new RecordingTabHost();
      const registry = new BrowserActionRegistry(asHost(host));

      const scoped = await registry.execute('listTabs', {}, false, { boundTabId: 'tab-bound' });
      assert.strictEqual(scoped.activeTabId, 'tab-bound');
      assert.strictEqual(scoped.activeTabRefusal, undefined);

      const refused = await registry.execute('listTabs');
      assert.strictEqual(refused.activeTabId, null, 'a caller with no bound target must not be told a tab is active');
      assert.match(String(refused.activeTabRefusal), /TARGET_REQUIRED/);
      assert.ok(Array.isArray(refused.tabs), 'the wire shape keeps the tab list it always carried');

      const scopedStatus = await registry.execute('getStatus', {}, false, { boundTabId: 'tab-bound' });
      assert.strictEqual(scopedStatus.activeTabId, 'tab-bound');

      const refusedStatus = await registry.execute('getStatus');
      assert.strictEqual(refusedStatus.activeTabId, null);
      assert.match(String(refusedStatus.activeTabRefusal), /TARGET_REQUIRED/);
      assert.strictEqual(host.activeTabQueries, 0, 'no payload may be filled in from the presented tab');
    });
  });

  describe('app-menu: a native menu click resolves the focused window through its resolver', () => {
    const appMenu: { buildApplicationMenu: typeof buildApplicationMenu } = require('../../src/main/browser/app-menu');

    it("runs the command against the focused window's host", () => {
      const hostA = makeMenuHost('tab-a');
      const hostB = makeMenuHost('tab-b');
      const windowA = { id: 1 };
      const windowB = { id: 2 };
      const resolved: Array<unknown> = [];

      capturedTemplates = [];
      appMenu.buildApplicationMenu(windowA as unknown as BrowserWindow, asHost(hostA), {
        resolveHostForWindow: (window) => {
          resolved.push(window);
          return window === windowB ? asHost(hostB) : null;
        },
      });

      const viewItems = submenuOf(lastTemplate(), 'View');
      findItem(viewItems, 'Reload Page').click?.(undefined, windowB);

      assert.deepStrictEqual(resolved, [windowB], 'the resolver must be asked about the window the click came from');
      assert.deepStrictEqual(hostB.reloadedTabs, ['tab-b'], "the focused window's host reloads its own presented tab");
      assert.deepStrictEqual(hostA.reloadedTabs, [], 'the host the menu was built for must not serve another window');
      assert.strictEqual(hostA.activeTabQueries, 0);

      const fileItems = submenuOf(lastTemplate(), 'File');
      findItem(fileItems, 'Close Tab').click?.(undefined, windowA);
      assert.deepStrictEqual(hostA.closedTabs, [], 'a window the resolver does not know refuses the command');
      assert.deepStrictEqual(hostB.closedTabs, [], 'and it must not run against another window either');
    });

    it('keeps the passed host when no resolver is injected', () => {
      const hostA = makeMenuHost('tab-a');
      const hostB = makeMenuHost('tab-b');

      capturedTemplates = [];
      appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, asHost(hostA));
      const viewItems = submenuOf(lastTemplate(), 'View');
      findItem(viewItems, 'Reload Page').click?.(undefined, { id: 2 });

      assert.deepStrictEqual(hostA.reloadedTabs, ['tab-a'], 'an un-migrated caller keeps its own host for every command');
      assert.deepStrictEqual(hostB.reloadedTabs, [], 'an un-migrated menu never reaches a second window');
    });
  });

  describe('tab-context-menu: the page the menu was opened on is the target', () => {
    const contextMenu: { TabContextMenuBuilder: typeof TabContextMenuBuilder } = require('../../src/main/browser/tab-context-menu');

    class FakeContents extends EventEmitter {
      public executeJavaScript(): Promise<string> {
        return Promise.resolve('');
      }

      public isDestroyed(): boolean {
        return false;
      }

      public getURL(): string {
        return 'https://page.example/';
      }
    }

    const contextMenuParams = {
      srcURL: '',
      mediaType: 'none',
      x: 10,
      y: 10,
      selectionText: '',
      isEditable: false,
      linkURL: '',
    };

    type DelegateDoubles = {
      goBacks: string[];
      reloads: string[];
      createdTabs: string[];
      activeTabQueries: number;
    };

    function makeDelegate(mapping: ((wc: WebContents) => string | undefined) | undefined, presented: string): DelegateDoubles & Record<string, unknown> {
      const host = {
        goBacks: [] as string[],
        reloads: [] as string[],
        createdTabs: [] as string[],
        activeTabQueries: 0,
        getWindow: () => ({}) as BrowserWindow,
        getActiveTabId(): string {
          host.activeTabQueries += 1;
          return presented;
        },
        ...(mapping ? { getTabIdForWebContents: mapping } : {}),
        getActiveTab: () => ({ id: presented, url: 'https://presented.example/' }),
        resolveTargetProfileSession: () => ({}),
        startInspect: () => undefined,
        toggleInspect: () => true,
        toggleFontFinder: () => undefined,
        toggleRuler: () => undefined,
        toggleLens: () => undefined,
        toggleSidebar: () => undefined,
        toggleDevTools: () => undefined,
        focusFindBar: () => undefined,
        showShortcuts: () => undefined,
        clearStorageForActiveTab: () => undefined,
        bookmarkActiveTab: () => undefined,
        toggleBookmarkBar: () => undefined,
        goBack: (tabId: string) => {
          host.goBacks.push(tabId);
        },
        goForward: () => undefined,
        reload: (tabId: string) => {
          host.reloads.push(tabId);
          return true;
        },
        createTab: (url?: string) => {
          host.createdTabs.push(url ?? '');
          return 'tab-created';
        },
        captureScreenshot: async () => '',
        openExternal: () => undefined,
      };
      return host;
    }

    async function openMenu(delegate: Record<string, unknown>, wc: FakeContents): Promise<CapturedItem[]> {
      capturedMenus = [];
      const builder = new contextMenu.TabContextMenuBuilder(delegate as unknown as ConstructorParameters<typeof TabContextMenuBuilder>[0]);
      builder.setupPageContextMenu(wc as unknown as WebContents);
      const { promise: popped, resolve } = Promise.withResolvers<void>();
      popupWaiters.push(resolve);
      wc.emit('context-menu', {}, contextMenuParams);
      await popped;
      return lastMenuItems();
    }

    it('targets the tab that owns the page, even when another tab is presented', async () => {
      const wc = new FakeContents();
      const delegate = makeDelegate(() => 'tab-page', 'tab-presented');

      const items = await openMenu(delegate, wc);
      findItem(items, '🔄 Reload').click?.();

      assert.deepStrictEqual(delegate.reloads, ['tab-page'], 'the page that was right-clicked is the target');
      assert.strictEqual(delegate.activeTabQueries, 0, 'the presented tab must not be consulted when the page maps to a tab');
    });

    it('refuses navigation for a page the host cannot map to a tab', async () => {
      const wc = new FakeContents();
      const delegate = makeDelegate(() => undefined, 'tab-presented');

      const items = await openMenu(delegate, wc);
      const reload = findItem(items, '🔄 Reload');
      reload.click?.();

      assert.strictEqual(reload.enabled, false, 'an unresolvable page must disable the action rather than pick a neighbour');
      assert.deepStrictEqual(delegate.reloads, [], 'no tab may be substituted for the missing target');
      assert.deepStrictEqual(delegate.goBacks, []);
      assert.strictEqual(delegate.activeTabQueries, 0);
    });

    it('builds a view-source tab from the page the menu was opened on', async () => {
      const wc = new FakeContents();
      const delegate = makeDelegate(() => 'tab-page', 'tab-presented');

      const items = await openMenu(delegate, wc);
      findItem(items, '📄 View Page Source').click?.();

      assert.deepStrictEqual(delegate.createdTabs, ['view-source:https://page.example/'], 'the right-clicked page is the source, not the presented tab');
    });

    it("falls back to the host's presented tab for a delegate without the mapping", async () => {
      const wc = new FakeContents();
      const delegate = makeDelegate(undefined, 'tab-presented');

      const items = await openMenu(delegate, wc);
      findItem(items, '🔄 Reload').click?.();

      assert.deepStrictEqual(delegate.reloads, ['tab-presented'], 'an un-migrated host keeps its previous behaviour');
    });
  });
});
