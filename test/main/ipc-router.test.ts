/**
 * Chrome IPC router — authorization contract.
 *
 * These checks run under plain node (`test:main`), so no Electron `ipcMain`
 * exists: the router's registrar seam is injected and the route table here is a
 * local fixture. What is under test is the authorization decision — unknown
 * sender, wrong surface, subframe — not the transport.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  ChromeSubframeRefusalError,
  ChromeSurfaceMismatchError,
  UnknownChromeSenderError,
  dispatchChromeRoute,
  installChromeIpcOnce,
  setChromeSenderResolver,
  type ChromeIpcRegistrar,
  type IpcRoute,
  type RoutedSender,
} from '../../src/main/browser/ipc-router';

// The router only ever reads `host` off the resolved target and never touches
// host internals, so a marker object is a faithful stand-in here.
const hostA = { name: 'host-a' } as unknown as NativeTabHost;
const hostB = { name: 'host-b' } as unknown as NativeTabHost;
const toolbarSender = { id: 101 } as unknown as WebContents;
const sidebarSender = { id: 202 } as unknown as WebContents;
const unknownSender = { id: 303 } as unknown as WebContents;

const TOOLBAR_ONLY = 'antifan:toolbar:toggle-sidebar';
const SIDEBAR_ONLY = 'antifan:sidebar:set-width';
const ON_CHANNEL = 'antifan:backdrop:ready';

type RecordedCall = { channel: string; target: RoutedSender; args: readonly unknown[] };

function buildRoutes(calls: RecordedCall[]): IpcRoute[] {
  return [
    {
      channel: TOOLBAR_ONLY,
      surface: 'toolbar',
      run: (target, _event, args) => {
        calls.push({ channel: TOOLBAR_ONLY, target, args });
        return 'toolbar-ran';
      },
    },
    {
      channel: SIDEBAR_ONLY,
      surface: 'sidebar',
      run: (target, _event, args) => {
        calls.push({ channel: SIDEBAR_ONLY, target, args });
        return 'sidebar-ran';
      },
    },
    {
      channel: ON_CHANNEL,
      kind: 'on',
      surface: 'frameBackdrop',
      run: (target, _event, args) => {
        calls.push({ channel: ON_CHANNEL, target, args });
      },
    },
  ];
}

function resolveBySenderId(webContents: WebContents): RoutedSender | undefined {
  if (webContents === toolbarSender) return { host: hostA, surface: 'toolbar' };
  if (webContents === sidebarSender) return { host: hostA, surface: 'sidebar' };
  return undefined;
}

type Listener = (event: unknown, ...args: unknown[]) => unknown;

interface FakeRegistrar extends ChromeIpcRegistrar {
  readonly handledChannels: string[];
  readonly listenedChannels: string[];
  /** The listener the router installed for a channel, so a fake event can be delivered to it. */
  listenerFor(channel: string): Listener | undefined;
}

function createFakeRegistrar(): FakeRegistrar {
  const handled = new Map<string, Listener>();
  const listened = new Set<string>();
  return {
    get handledChannels() {
      return [...handled.keys()];
    },
    get listenedChannels() {
      return [...listened.keys()];
    },
    listenerFor: (channel) => handled.get(channel),
    handle(channel, listener) {
      handled.set(channel, listener as Listener);
    },
    on(channel, listener) {
      listened.add(channel);
      handled.set(channel, listener as Listener);
    },
  };
}

/** The one installation this process gets; later checks read its listeners. */
const primaryRegistrar = createFakeRegistrar();

describe('chrome IPC router authorization', () => {
  it('refuses a duplicate channel table before marking itself installed', () => {
    const rejected = createFakeRegistrar();
    const duplicated: IpcRoute[] = [
      { channel: TOOLBAR_ONLY, surface: 'toolbar', run: () => 'first' },
      { channel: TOOLBAR_ONLY, surface: 'toolbar', run: () => 'second' },
    ];
    assert.throws(() => installChromeIpcOnce(duplicated, rejected), /Duplicate chrome channel/);
    assert.equal(rejected.handledChannels.length, 0, 'a rejected table must register nothing');
  });

  it('registers the table once and ignores a later installation', () => {
    const routes = buildRoutes([]);
    installChromeIpcOnce(routes, primaryRegistrar);
    assert.deepEqual(primaryRegistrar.handledChannels.sort(), [ON_CHANNEL, SIDEBAR_ONLY, TOOLBAR_ONLY].sort());
    assert.deepEqual(primaryRegistrar.listenedChannels, [ON_CHANNEL]);

    const second = createFakeRegistrar();
    installChromeIpcOnce(routes, second);
    assert.equal(second.handledChannels.length, 0, 'a second installation must be a no-op');
    assert.equal(second.listenedChannels.length, 0, 'a second installation must be a no-op');
  });

  it('dispatches to the resolved host and passes arguments as one array', () => {
    setChromeSenderResolver(resolveBySenderId);
    const calls: RecordedCall[] = [];
    const routes = buildRoutes(calls);

    const result = dispatchChromeRoute(routes, TOOLBAR_ONLY, toolbarSender, ['tab-7']);
    assert.equal(result, 'toolbar-ran');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call, 'the toolbar route must have run');
    assert.equal(call.target.host, hostA);
    assert.equal(call.target.surface, 'toolbar');
    assert.deepEqual(call.args, ['tab-7']);
  });

  it('refuses a renderer that belongs to no project window', () => {
    setChromeSenderResolver(resolveBySenderId);
    const routes = buildRoutes([]);
    assert.throws(
      () => dispatchChromeRoute(routes, TOOLBAR_ONLY, unknownSender, []),
      (err: unknown) => err instanceof UnknownChromeSenderError && err.code === 'UNKNOWN_CHROME_SENDER',
    );
  });

  it('refuses the right window calling through the wrong surface', () => {
    setChromeSenderResolver(resolveBySenderId);
    const routes = buildRoutes([]);
    assert.throws(
      () => dispatchChromeRoute(routes, TOOLBAR_ONLY, sidebarSender, []),
      (err: unknown) => err instanceof ChromeSurfaceMismatchError && err.code === 'CHROME_SURFACE_MISMATCH',
    );
  });

  it('refuses a child frame even from an owned surface', () => {
    setChromeSenderResolver(resolveBySenderId);
    const listener = primaryRegistrar.listenerFor(TOOLBAR_ONLY);
    assert.ok(listener, 'the router must have registered a listener for the toolbar channel');
    const subframeEvent = {
      sender: toolbarSender,
      senderFrame: { parent: { url: 'file:///E:/Work/apps/AntiFan/src/renderer/toolbar.html' }, url: 'https://embedded.example/iframe' },
    };
    assert.throws(
      () => listener(subframeEvent, []),
      (err: unknown) => err instanceof ChromeSubframeRefusalError && err.code === 'CHROME_SUBFRAME_REFUSED',
    );
  });

  it('refuses a sender whose frame is already gone', () => {
    setChromeSenderResolver(resolveBySenderId);
    const listener = primaryRegistrar.listenerFor(TOOLBAR_ONLY);
    assert.ok(listener);
    assert.throws(
      () => listener({ sender: toolbarSender, senderFrame: null }, []),
      (err: unknown) => err instanceof UnknownChromeSenderError,
    );
  });

  it('refuses a channel that is not in the table', () => {
    setChromeSenderResolver(resolveBySenderId);
    const routes = buildRoutes([]);
    assert.throws(() => dispatchChromeRoute(routes, 'antifan:not-a-route', toolbarSender, []), /No chrome route registered/);
  });

  it('serves a different window once the resolver answers for it', () => {
    const calls: RecordedCall[] = [];
    const routes = buildRoutes(calls);
    setChromeSenderResolver((webContents) => (webContents === toolbarSender ? { host: hostB, surface: 'toolbar' } : undefined));
    dispatchChromeRoute(routes, TOOLBAR_ONLY, toolbarSender, []);
    const call = calls[0];
    assert.ok(call, 'the toolbar route must have run for the second window');
    assert.equal(call.target.host, hostB);
    setChromeSenderResolver(resolveBySenderId);
  });
});
