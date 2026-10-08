import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import { dispatchChromeRoute, setChromeSenderResolver, type IpcRoute } from '../../src/main/browser/ipc-router';
import type { RenderSurfaceSnapshot } from '../../src/main/verification/visual-capture';

// The capture lane's host surface is what tells the port whether a tab can render at all:
// `assertRenderSurface` returns before checking anything when the host has no
      // `readRenderSurface` (`src/main/tools/browser-control-port.ts`), and the refusal it
      // raises around a collapsed surface names the session tab listing.
      // A harness that builds its own host adapter and omits those wires the gate
      // as a silent no-op, so it can only ever prove a capture on a surface it never measured.
//
// Session ownership: `anti.browser.tabs.create` adopts the tab it opens into the session
// pool, and closing a pooled tab is what records the anchor the failover path reads. Only
// the harness that drives tab creation and the close/failover case needs those fields.
//
// The transport decides whether the bound tab is still real by asking the catalogue to
// canonicalize it. With these delegates missing the catalogue answers "gone" for every
// live tab, so the harness reads a healthy session as stale: it warns on every dispatch
// and can never reach its heal path (`src/main/index.ts:1817-1833`).
//
// Each harness builds those objects through an exported factory that its own construction
// site consumes, so these checks drive the objects the live lanes really hand to the port
// and the router - never the spelling of a line, which a comment alone would satisfy.
// Chrome IPC is the sharpest case: the harness installs into the compiled `ipc-router`
// singleton, and this file's import resolves to that same module, so the resolver is
// observed through a dispatch the router actually performs.

const ROOT = fs.existsSync(path.resolve(__dirname, '../../../src/main/index.ts'))
  ? path.resolve(__dirname, '../../..')
  : path.resolve(__dirname, '../..');

const HARNESSES = ['scripts/smoke-mcp-industrial-e2e.cjs', 'scripts/smoke-theme-golden-live.cjs'];
const SESSION_HARNESS = 'scripts/smoke-mcp-industrial-e2e.cjs';
// Harnesses that bind a tab and dispatch capabilities through the transport: they must
// wire the runtime delegates or every dispatch reads a live tab as stale
// (`capability-catalogue.ts`). A superset of HARNESSES - some drive the transport without
// asserting a capture, so they do not need the host-adapter fields below.
const RUNTIME_DELEGATE_HARNESSES = [...HARNESSES, 'scripts/smoke-background-multitasking.cjs'];
// Harnesses that build a ProjectWindowShell whose chrome views (toolbar/sidebar/backdrop)
// boot through chrome IPC: without a sender resolver those calls are refused with
// UNKNOWN_CHROME_SENDER. smoke-mcp-industrial-e2e boots no chrome views, so it is not listed.
const CHROME_SENDER_HARNESSES = ['scripts/smoke-theme-golden-live.cjs', 'scripts/smoke-background-multitasking.cjs'];

const TAB_ID = 'tab-capture-1';
const CHILD_TAB_ID = 'tab-child-1';
const TARGET: BrowserTarget = {
  tabId: TAB_ID,
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  runtimeId: 'runtime-1',
  browserEpoch: 1,
  documentGeneration: 1,
};
// A tab laid out in the window: a capture can rasterize it, so the gate must not refuse.
const HEALTHY_SURFACE: RenderSurfaceSnapshot = {
  vw: 1440,
  vh: 900,
  dpr: 1,
  scrollX: 0,
  scrollY: 0,
  docH: 4096,
  readyState: 'complete',
  hidden: false,
};
// The same tab alive but not composited: `vw`/`vh` below 1 is the signal the gate refuses on.
const COLLAPSED_SURFACE: RenderSurfaceSnapshot = { ...HEALTHY_SURFACE, vw: 0, vh: 0, docH: 0 };
const INVENTORY_READING = { scrollHeight: 4096, viewportHeight: 900, sections: [] };
const CHROME_CHANNEL = 'capture-lane-mirror:chrome';
const CHROME_SENDER_ID = 4242;
const PAGE_SENDER_ID = 4243;
const UNKNOWN_SENDER_ID = 987654;

// WebContents doubles: the router reads only `id` off a sender, and no real one can be
// constructed outside an Electron process.
const CHROME_SENDER = { id: CHROME_SENDER_ID } as unknown as WebContents;
const PAGE_SENDER = { id: PAGE_SENDER_ID } as unknown as WebContents;
const UNKNOWN_SENDER = { id: UNKNOWN_SENDER_ID } as unknown as WebContents;

interface CallRecord {
  method: string;
  args: unknown[];
}

interface RoutedCall {
  host: unknown;
  surface: string;
}

/** The host methods the harness factories delegate to, plus the port fields the drive reaches. */
interface HostDouble {
  getSessionTabRecords(boundTabId?: string): unknown[];
  readRenderSurface(tabId?: string, paneId?: string, timeoutMs?: number): Promise<RenderSurfaceSnapshot>;
  adoptChildTabForBoundTab(primaryOrBoundTabId: string, childTabId: string): boolean;
  getManagedTabIdsForBoundTab(primaryOrBoundTabId: string): Set<string>;
  isTabAllowedForPrimary(primaryTabId: string, requestedTabId: string): boolean;
  resolveTargetTabId(id?: string | null): string | undefined;
  getFailoverTargetTab(staleTabId?: string): string | undefined;
  getDocumentGeneration(tabId?: string): number;
  surfaceForWebContents(webContentsId: number): string | undefined;
  hasTab(tabId?: string | null): boolean;
  getTabList(): unknown[];
  evalJs(expression?: string, tabId?: string, paneId?: string): Promise<unknown>;
}

interface CaptureLaneHostFields {
  getSessionTabList(boundTabId?: string): unknown[];
  readRenderSurface(tabId?: string, paneId?: string, timeoutMs?: number): Promise<RenderSurfaceSnapshot>;
}

interface SessionOwnershipHostFields {
  adoptChildTab(primaryOrBoundTabId: string, childTabId: string): boolean;
  getManagedTabIds(primaryOrBoundTabId: string): Set<string>;
}

interface RuntimeDelegates {
  getDocumentGeneration(tabId?: string): number;
  isTabAllowed(primaryTabId: string, requestedTabId: string): boolean;
  resolveTabId(id: string): string | undefined;
  resolveFailoverTabId(staleTabId: string): string | undefined;
}

interface CaptureLaneHarness {
  captureLaneHostFields(host: unknown): CaptureLaneHostFields;
}

interface SessionOwnershipHarness {
  sessionOwnershipHostFields(host: unknown): SessionOwnershipHostFields;
}

interface RuntimeDelegateHarness {
  runtimeDelegates(host: unknown): RuntimeDelegates;
}

interface ChromeSenderHarness {
  installChromeSenderResolver(target: { windowShell: unknown; tabHost: unknown }): void;
}

function buildHostDouble(calls: CallRecord[], surface: RenderSurfaceSnapshot): HostDouble {
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  return {
    getSessionTabRecords: (boundTabId?: string) => {
      record('getSessionTabRecords', [boundTabId]);
      return [{ id: TAB_ID }];
    },
    readRenderSurface: (tabId?: string, paneId?: string, timeoutMs?: number) => {
      record('readRenderSurface', [tabId, paneId, timeoutMs]);
      return Promise.resolve(surface);
    },
    adoptChildTabForBoundTab: (primaryOrBoundTabId: string, childTabId: string) => {
      record('adoptChildTabForBoundTab', [primaryOrBoundTabId, childTabId]);
      return true;
    },
    getManagedTabIdsForBoundTab: (primaryOrBoundTabId: string) => {
      record('getManagedTabIdsForBoundTab', [primaryOrBoundTabId]);
      return new Set<string>([primaryOrBoundTabId, CHILD_TAB_ID]);
    },
    isTabAllowedForPrimary: (primaryTabId: string, requestedTabId: string) => {
      record('isTabAllowedForPrimary', [primaryTabId, requestedTabId]);
      return requestedTabId === CHILD_TAB_ID;
    },
    resolveTargetTabId: (id?: string | null) => {
      record('resolveTargetTabId', [id]);
      return id ? `resolved:${id}` : undefined;
    },
    getFailoverTargetTab: (staleTabId?: string) => {
      record('getFailoverTargetTab', [staleTabId]);
      return `failover:${staleTabId}`;
    },
    getDocumentGeneration: (tabId?: string) => {
      record('getDocumentGeneration', [tabId]);
      return 7;
    },
    surfaceForWebContents: (webContentsId: number) => {
      record('surfaceForWebContents', [webContentsId]);
      return webContentsId === PAGE_SENDER_ID ? 'tab' : undefined;
    },
    hasTab: (tabId?: string | null) => {
      record('hasTab', [tabId]);
      return tabId === TAB_ID;
    },
    getTabList: () => {
      record('getTabList', []);
      return [{ id: TAB_ID }];
    },
    evalJs: (_expression?: string, tabId?: string, paneId?: string) => {
      record('evalJs', [tabId, paneId]);
      return Promise.resolve(INVENTORY_READING);
    },
  };
}

/** The port host a lane builds: the harness's own adapter fields over this file's host. */
function buildPortHost(host: HostDouble, fields: object): BrowserHostPort {
  return {
    hasTab: host.hasTab,
    getTabList: host.getTabList,
    evalJs: host.evalJs,
    ...fields,
  } as unknown as BrowserHostPort;
}

/** Reads the `code` a refusal carries; a test seam should not import the error class for it. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

function callsTo(calls: CallRecord[], method: string): CallRecord[] {
  return calls.filter((call) => call.method === method);
}

function onlyCall(calls: CallRecord[], method: string, label: string): CallRecord {
  const matching = callsTo(calls, method);
  assert.equal(matching.length, 1, `${label}: expected one ${method} call, saw ${matching.length}`);
  const [record] = matching;
  assert.ok(record);
  return record;
}

/**
 * The harnesses are Electron entry scripts, so they are loaded by path rather than imported:
 * their entry guard keeps loading one side-effect free, and the factories they export are the
 * ones their own construction sites consume.
 */
function loadHarness<T>(rel: string): T {
  return require(path.join(ROOT, rel)) as T;
}

describe('Capture-lane host adapters mirror the composition root', () => {
  it('feeds the capture gate from the fields each harness builds', async () => {
    for (const rel of HARNESSES) {
      const { captureLaneHostFields } = loadHarness<CaptureLaneHarness>(rel);

      // A laid-out surface: the gate measures through the harness's own probe and lets the
      // bounded operation through, so the probe the harness builds is the one the port reads.
      const gatedCalls: CallRecord[] = [];
      const gatedHost = buildHostDouble(gatedCalls, HEALTHY_SURFACE);
      const gatedPort = new BrowserControlPort(buildPortHost(gatedHost, captureLaneHostFields(gatedHost)));
      const inventory = await gatedPort.pageInventory(TARGET, {}, TAB_ID);
      assert.equal(inventory.tabId, TAB_ID, `${rel}: the gated inventory must run on the bound tab`);
      assert.equal(
        inventory.scrollHeight,
        INVENTORY_READING.scrollHeight,
        `${rel}: a measured surface must not refuse the operation`
      );
      const probe = onlyCall(gatedCalls, 'readRenderSurface', rel);
      assert.deepEqual(probe.args.slice(0, 2), [TAB_ID, 'desktop'], `${rel}: the gate must probe the bound tab and pane`);
      assert.ok(
        typeof probe.args[2] === 'number' && probe.args[2] > 0,
        `${rel}: the probe must carry the port's own bound, saw ${String(probe.args[2])}`
      );

      // A tab that is alive but not composited: the refusal reads the session tab listing,
      // so that adapter field is the one the same gate names.
      const collapsedCalls: CallRecord[] = [];
      const collapsedHost = buildHostDouble(collapsedCalls, COLLAPSED_SURFACE);
      const collapsedPort = new BrowserControlPort(buildPortHost(collapsedHost, captureLaneHostFields(collapsedHost)));
      await assert.rejects(
        () => collapsedPort.pageInventory(TARGET, {}, TAB_ID),
        (err: unknown) => {
          assert.equal(errorCode(err), 'NO_RENDER_SURFACE', `${rel}: an uncomposited tab must be refused, not measured`);
          return true;
        }
      );
      assert.deepEqual(
        onlyCall(collapsedCalls, 'getSessionTabRecords', rel).args,
        [TAB_ID],
        `${rel}: the refusal must list the session's tabs`
      );
      assert.equal(
        callsTo(collapsedCalls, 'evalJs').length,
        0,
        `${rel}: the refusal must land before anything is dispatched to the page`
      );

      // The control: the port treats an absent probe as "nothing to check"
      // (`browser-control-port.ts:2303`), which is exactly the silent no-op a harness that
      // drops the field would ride. If this ever starts refusing instead, the port gained a
      // loud contract and this control should be retired rather than relaxed.
      const omittedCalls: CallRecord[] = [];
      const omittedHost = buildHostDouble(omittedCalls, HEALTHY_SURFACE);
      const { readRenderSurface: _omitted, ...fieldsWithoutProbe } = captureLaneHostFields(omittedHost);
      const omittedPort = new BrowserControlPort(buildPortHost(omittedHost, fieldsWithoutProbe));
      const unmeasured = await omittedPort.pageInventory(TARGET, {}, TAB_ID);
      assert.equal(unmeasured.tabId, TAB_ID, `${rel}: without the probe the operation is dispatched unmeasured`);
      assert.equal(
        callsTo(omittedCalls, 'evalJs').length,
        1,
        `${rel}: without the probe the operation is dispatched unmeasured`
      );
    }
  });

  it('routes the catalogue delegates to the host the harness built them for', () => {
    for (const rel of RUNTIME_DELEGATE_HARNESSES) {
      const { runtimeDelegates } = loadHarness<RuntimeDelegateHarness>(rel);
      const calls: CallRecord[] = [];
      const host = buildHostDouble(calls, HEALTHY_SURFACE);
      const delegates = runtimeDelegates(host);

      // Every delegate must answer with the host's own reading: one that returns a constant
      // (or nothing) leaves the catalogue resolving live tabs to `undefined`.
      assert.equal(delegates.isTabAllowed(TAB_ID, CHILD_TAB_ID), true, `${rel}: isTabAllowed must report the host's answer`);
      assert.deepEqual(onlyCall(calls, 'isTabAllowedForPrimary', rel).args, [TAB_ID, CHILD_TAB_ID], rel);
      assert.equal(delegates.resolveTabId(TAB_ID), `resolved:${TAB_ID}`, `${rel}: resolveTabId must report the host's answer`);
      assert.deepEqual(onlyCall(calls, 'resolveTargetTabId', rel).args, [TAB_ID], rel);
      assert.equal(
        delegates.resolveFailoverTabId(TAB_ID),
        `failover:${TAB_ID}`,
        `${rel}: resolveFailoverTabId must report the host's answer`
      );
      assert.deepEqual(onlyCall(calls, 'getFailoverTargetTab', rel).args, [TAB_ID], rel);
      assert.equal(delegates.getDocumentGeneration(TAB_ID), 7, `${rel}: getDocumentGeneration must report the host's answer`);
      assert.deepEqual(onlyCall(calls, 'getDocumentGeneration', rel).args, [TAB_ID], rel);
    }
  });

  it('installs a chrome sender resolver the router dispatches through', () => {
    for (const rel of CHROME_SENDER_HARNESSES) {
      const { installChromeSenderResolver } = loadHarness<ChromeSenderHarness>(rel);
      const calls: CallRecord[] = [];
      const host = buildHostDouble(calls, HEALTHY_SURFACE);
      const windowShell = {
        chromeSurfaceFor: (webContentsId: number) => {
          calls.push({ method: 'chromeSurfaceFor', args: [webContentsId] });
          return webContentsId === CHROME_SENDER_ID ? 'toolbar' : undefined;
        },
      };
      // The route records the target the router resolved for it, so the assertion reads the
      // router's own value rather than a shape this file guessed at.
      const routed: RoutedCall[] = [];
      const routes: IpcRoute[] = [
        {
          channel: CHROME_CHANNEL,
          surface: ['toolbar', 'tab'],
          run: (target) => {
            routed.push({ host: target.host, surface: target.surface });
            return true;
          },
        },
      ];

      // Before the install no chrome dispatch can be reached at all: this is the
      // UNKNOWN_CHROME_SENDER refusal a shell without the resolver buries its boot in.
      setChromeSenderResolver(undefined);
      assert.throws(
        () => dispatchChromeRoute(routes, CHROME_CHANNEL, CHROME_SENDER),
        (err: unknown) => errorCode(err) === 'UNKNOWN_CHROME_SENDER',
        `${rel}: a chrome dispatch must be refused while no resolver is installed`
      );

      installChromeSenderResolver({ windowShell, tabHost: host });

      // The harness's own install authorizes the dispatch, and it names the harness's host.
      dispatchChromeRoute(routes, CHROME_CHANNEL, CHROME_SENDER);
      assert.equal(routed.length, 1, `${rel}: the installed resolver must let the chrome route run`);
      const [chromeRouted] = routed;
      assert.ok(chromeRouted);
      assert.equal(chromeRouted.host, host, `${rel}: the dispatch target must be the harness's own host`);
      assert.equal(chromeRouted.surface, 'toolbar', `${rel}: the shell's chrome surface must decide the route's role`);

      // A member page's own webContents is no chrome surface of this shell, so the resolver
      // falls back to the host - that fallback is what keeps `tab`-scoped routes reachable.
      dispatchChromeRoute(routes, CHROME_CHANNEL, PAGE_SENDER);
      const [, pageRouted] = routed;
      assert.ok(pageRouted, `${rel}: a page's own webContents must resolve through the host`);
      assert.equal(pageRouted.host, host, `${rel}: the fallback target must be the harness's own host`);
      assert.equal(pageRouted.surface, 'tab', `${rel}: the fallback surface must be the host's own role`);

      // A webContents no live surface owns stays refused: a resolver that answered every
      // sender would authorize any renderer able to reach the channel.
      assert.throws(
        () => dispatchChromeRoute(routes, CHROME_CHANNEL, UNKNOWN_SENDER),
        (err: unknown) => errorCode(err) === 'UNKNOWN_CHROME_SENDER',
        `${rel}: a sender no live surface owns must stay refused`
      );
      assert.deepEqual(
        callsTo(calls, 'chromeSurfaceFor').map((call) => call.args[0]),
        [CHROME_SENDER_ID, PAGE_SENDER_ID, UNKNOWN_SENDER_ID],
        `${rel}: every sender, refused ones included, must be resolved from the shell first`
      );
      assert.deepEqual(
        callsTo(calls, 'surfaceForWebContents').map((call) => call.args[0]),
        [PAGE_SENDER_ID, UNKNOWN_SENDER_ID],
        `${rel}: the host is the fallback for senders the shell does not own`
      );
    }
  });

  it('adopts and lists session tabs through the pool the harness builds', () => {
    const { sessionOwnershipHostFields } = loadHarness<SessionOwnershipHarness>(SESSION_HARNESS);
    const calls: CallRecord[] = [];
    const host = buildHostDouble(calls, HEALTHY_SURFACE);
    const fields = sessionOwnershipHostFields(host);

    assert.equal(
      fields.adoptChildTab(TAB_ID, CHILD_TAB_ID),
      true,
      `${SESSION_HARNESS}: adoption must report the host's own answer`
    );
    assert.deepEqual(onlyCall(calls, 'adoptChildTabForBoundTab', SESSION_HARNESS).args, [TAB_ID, CHILD_TAB_ID], SESSION_HARNESS);
    assert.deepEqual(
      [...fields.getManagedTabIds(TAB_ID)],
      [TAB_ID, CHILD_TAB_ID],
      `${SESSION_HARNESS}: the managed set must be the host's own`
    );
    assert.deepEqual(onlyCall(calls, 'getManagedTabIdsForBoundTab', SESSION_HARNESS).args, [TAB_ID], SESSION_HARNESS);
  });
});
