/**
 * A page's own reports are routed to the page that sent them.
 *
 * `src/preload/tab-preload.ts` sends two channels from a member page's webContents:
 * `antifan:tab-wheel-zoom` (Ctrl+wheel over the page) and `antifan:dom-mutation` (the page
 * announcing its own DOM changed, which advances the document-generation revision agent
 * staleness checks read). Both were declared `surface: 'toolbar'` when chrome IPC moved into
 * the route table, and a page's webContents is not a chrome surface — so the router refused
 * every one of them as an unknown sender: mutation revisions stopped advancing and wheel zoom
 * did nothing, silently, because `kind: 'on'` refusals only reach the console.
 *
 * These rows drive the real table through the real router (registrar + sender resolver), the
 * way production installs it, and read the effect off the tab the sender belongs to.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  installChromeIpcOnce,
  setChromeSenderResolver,
  type ChromeIpcRegistrar,
  type IpcRoute,
} from '../../src/main/browser/ipc-router';
import { TOOLBAR_CHANNELS } from '../../src/shared/contracts';

type Listener = (event: unknown, ...args: unknown[]) => unknown;
type AnyRecord = Record<string, any>;

const registrations = new Map<string, { kind: 'handle' | 'on'; listener: Listener }>();
const registrar: ChromeIpcRegistrar = {
  handle(channel: string, listener: (event: any, ...args: unknown[]) => unknown) {
    registrations.set(channel, { kind: 'handle', listener: listener as Listener });
  },
  on(channel: string, listener: (event: any, ...args: unknown[]) => void) {
    registrations.set(channel, { kind: 'on', listener: listener as Listener });
  },
};

/** A page's webContents, as the router sees it (an id and nothing else for this question). */
function pageWebContents(id: number): AnyRecord {
  return { id, isDestroyed: () => false, send: () => {}, executeJavaScript: async () => undefined };
}

function topLevelFrameEvent(sender: AnyRecord): AnyRecord {
  return { sender, senderFrame: { url: 'https://example.test/', parent: null } };
}

describe("a member page's own reports route to that page", () => {
  const desktopPage = pageWebContents(4101);
  const otherPage = pageWebContents(4102);
  const mobilePage = pageWebContents(4103);
  let host: AnyRecord;

  before(() => {
    host = Object.create(NativeTabHost.prototype) as AnyRecord;
    // Every field the real resolution reads, so the answer is the production one: no chrome
    // surface matches, no auxiliary window matches, and the only matches are the member tabs.
    host.shell = {
      chromeSurfaceFor: () => undefined,
      window: { isDestroyed: () => false, webContents: { id: 9000, isDestroyed: () => false } },
      toolbarView: { webContents: { id: 9001, isDestroyed: () => false } },
      sidebarView: { webContents: { id: 9002, isDestroyed: () => false } },
      frameBackdropView: { webContents: { id: 9003, isDestroyed: () => false } },
    };
    host.popoutWindow = null;
    host.terminalWindows = new Map<string, AnyRecord>();
    host.tabs = new Map<string, AnyRecord>([
      ['tab-a', { view: { webContents: desktopPage } }],
      ['tab-b', { view: { webContents: otherPage }, mobileView: { webContents: mobilePage } }],
    ]);
    host.activeTabId = 'tab-a';
    host.bumped = [];
    host.zoomed = [];
    host.bumpMutationRevision = (tabId: string) => { host.bumped.push(tabId); };
    host.setZoom = (tabId: string, zoom: number) => { host.zoomed.push({ tabId, zoom }); };
    (host.tabs.get('tab-a') as AnyRecord).state = { zoomFactor: 1 };

    installChromeIpcOnce(NativeTabHost.CHROME_ROUTES, registrar);
    setChromeSenderResolver(((sender: AnyRecord) => {
      const surface = host.surfaceForWebContents(sender.id);
      return surface ? { host, surface } : undefined;
    }) as never);
  });

  after(() => {
    setChromeSenderResolver(undefined);
  });

  it('the table resolves a page as the tab surface and keeps chrome surfaces ahead of it', () => {
    assert.strictEqual(host.surfaceForWebContents(desktopPage.id), 'tab', "the desktop page of a member tab did not resolve as 'tab'");
    assert.strictEqual(host.surfaceForWebContents(mobilePage.id), 'tab', "the mobile pane of a member tab did not resolve as 'tab'");
    assert.strictEqual(host.surfaceForWebContents(9001), undefined, "a page id that matches no tab was claimed as a tab");
  });

  it("a page's DOM report advances its own tab's revision, never the active tab's", () => {
    const route = NativeTabHost.CHROME_ROUTES.find((entry: IpcRoute) => entry.channel === 'antifan:dom-mutation');
    assert.ok(route, "the route table must declare 'antifan:dom-mutation'");
    assert.strictEqual(route.surface, 'tab', "the page's own mutation report must be declared for the page surface");

    const listener = registrations.get('antifan:dom-mutation')?.listener;
    assert.ok(listener, "the route must be registered as a fire-and-forget channel");
    listener(topLevelFrameEvent(otherPage));
    listener(topLevelFrameEvent(mobilePage));

    assert.deepStrictEqual(host.bumped, ['tab-b', 'tab-b'], "a page's DOM report did not reach the tab that sent it");
  });

  it('a wheel zoom from a page lands on that page, in that page\'s own zoom', () => {
    const route = NativeTabHost.CHROME_ROUTES.find((entry: IpcRoute) => entry.channel === 'antifan:tab-wheel-zoom');
    assert.ok(route, "the route table must declare 'antifan:tab-wheel-zoom'");
    assert.strictEqual(route.surface, 'tab', 'the page wheel zoom must be declared for the page surface');

    const listener = registrations.get('antifan:tab-wheel-zoom')?.listener;
    assert.ok(listener, 'the route must be registered as a fire-and-forget channel');
    listener(topLevelFrameEvent(desktopPage), { isZoomIn: true });

    assert.deepStrictEqual(host.zoomed, [{ tabId: 'tab-a', zoom: 1.1 }], 'the page wheel zoom did not reach the page it came from');
  });

  it('a page is refused by chrome-only routes, and by a sender no live host owns', () => {
    // Toolbar-declared: the same page that may report its own mutations may not drive chrome.
    const toolbarListener = registrations.get(TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE)?.listener;
    assert.ok(toolbarListener, 'a toolbar route must be registered');
    assert.throws(
      () => toolbarListener(topLevelFrameEvent(desktopPage)),
      (err: unknown) => (err as Error).name === 'ChromeSurfaceMismatchError',
      'a member page was allowed to invoke a toolbar-only route',
    );

    // Unknown sender: a webContents no live host answers for is refused, not routed by id.
    const unknownPage = pageWebContents(4999);
    assert.throws(
      () => toolbarListener(topLevelFrameEvent(unknownPage)),
      (err: unknown) => (err as Error).name === 'UnknownChromeSenderError',
      'a sender no host owns was allowed to invoke a route',
    );
  });
});
