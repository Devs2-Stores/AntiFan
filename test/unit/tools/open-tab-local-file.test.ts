/**
 * Agent tab creation at a local document.
 *
 * A capability-issued `tabs.create {url: file:}` used to reach the host's creation path, where a
 * file target is the capsule-preview shortcut the app's own UI uses: that shortcut answers no
 * workspace gate, so an agent could open any file on disk. The capability now creates the tab
 * blank and loads the document through the admission `anti.browser.navigate` applies. The host's
 * preview path is unchanged - it belongs to the UI callers that never come through a capability.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CapabilityCatalogue } from '../../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../../src/main/tools/browser-capabilities';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget, type CapabilityRequestContext, type RuntimeLease } from '../../../src/shared/control-plane-contracts';

const projectId = 'proj-open-file';
const workspaceId = 'ws-open-file';
const ANCHOR = 'tab-anchor';

const lease: RuntimeLease = {
  token: 'lease-tok',
  expiresAt: Date.now() + 60_000,
  runtimeId: 'run-1',
  projectId,
  workspaceId,
  protocolVersion: 1,
  hostEpoch: 1,
  ownerPid: process.pid,
  issuedAt: Date.now(),
};

const target: BrowserTarget = { projectId, workspaceId, runtimeId: 'run-1', tabId: ANCHOR, browserEpoch: 1, documentGeneration: 1 };

const context: CapabilityRequestContext = {
  lease, leaseToken: 'lease-tok', projectId, workspaceId, runId: 'run-1', attemptId: 'att-1', browserTarget: target, grant: 'write',
};

interface CreateCall { url?: string; activate?: boolean; options?: Record<string, unknown> }
interface NavigationCall { tabId: string; url: string; wait: unknown }

interface Harness {
  port: BrowserControlPort;
  created: CreateCall[];
  closed: string[];
  navigations: NavigationCall[];
  tabs: Map<string, string>;
}

/** What a test may replace on the host double: the load waiter's answer and the in-page read. */
interface HostOverrides {
  /** false: the waiter answers before the tab left its blank document (the URL is not recorded). */
  commitOnNavigate?: boolean;
  evalJs?: () => Promise<unknown>;
}

/** A port over a host that records what the creation and the navigation were handed. */
function makeHarness(overrides: HostOverrides = {}): Harness {
  const tabs = new Map<string, string>([[ANCHOR, 'https://shop.test/']]);
  const created: CreateCall[] = [];
  const closed: string[] = [];
  const navigations: NavigationCall[] = [];
  let seq = 0;
  const host = {
    hasTab: (id?: string | null) => typeof id === 'string' && tabs.has(id),
    getTabList: () => [...tabs.entries()].map(([id, url]) => ({ id, url, title: '' })),
    getTabUrl: (id: string) => tabs.get(id),
    getDocumentGeneration: () => 1,
    getOpenJsDialog: () => undefined,
    createTab: (url?: string, activate?: boolean, options?: Record<string, unknown>) => {
      const id = `tab-new-${++seq}`;
      tabs.set(id, url ?? 'about:blank');
      created.push({ url, activate, options });
      return id;
    },
    adoptChildTab: () => true,
    getManagedTabIds: () => new Set(tabs.keys()),
    closeTab: (id: string) => {
      closed.push(id);
      tabs.delete(id);
      return true;
    },
    navigate: (tabId: string, url: string) => {
      navigations.push({ tabId, url, wait: undefined });
      tabs.set(tabId, url);
      return true;
    },
    navigateAndWait: async (tabId: string, url: string, wait?: unknown) => {
      navigations.push({ tabId, url, wait });
      if (overrides.commitOnNavigate !== false) tabs.set(tabId, url);
      return true;
    },
    ...(overrides.evalJs ? { evalJs: overrides.evalJs } : {}),
    resolveTabAffiliation: () => ({ projectId, workspaceId, capsuleId: 'capsule-1' }),
  } as unknown as BrowserHostPort;
  return { port: new BrowserControlPort(host), created, closed, navigations, tabs };
}

/** The capability surface over one port, with a workspace registry that resolves the fixture root. */
function surface(harness: Harness, root: string): CapabilityCatalogue {
  const workspaceRegistry = {
    get: () => ({ id: workspaceId, projectId, rootPath: root, state: 'attached', createdAt: 0, updatedAt: 0 }),
  };
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    hostEpoch: 1,
    workspaceRegistry,
  } as unknown as ConstructorParameters<typeof CapabilityCatalogue>[0]);
  registerBrowserCapabilities(catalogue, harness.port);
  return catalogue;
}

function execute(catalogue: CapabilityCatalogue, capability: string, params: Record<string, unknown>): unknown {
  const registered = catalogue.get(capability);
  assert.ok(registered, `${capability} is registered`);
  return registered.execute(params, context);
}

async function rejection(run: unknown): Promise<CapabilityError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof CapabilityError, `expected a CapabilityError, received ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to be refused');
}

describe('tabs.create at a local document', () => {
  let tmp = '';
  let root = '';
  let file = '';
  let outside = '';

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-open-file-')));
    root = path.join(tmp, 'ws');
    fs.mkdirSync(root);
    file = path.join(root, 'page.html');
    fs.writeFileSync(file, '<!doctype html><title>local</title><p>hi');
    outside = path.join(tmp, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html><title>outside</title>');
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const capability of ['anti.browser.tabs.create', 'browser.open-tab']) {
    it(`${capability} creates the tab blank and admits a file inside the workspace root`, async () => {
      const harness = makeHarness();
      const admittedUrl = pathToFileURL(fs.realpathSync.native(file)).href;

      const result = await execute(surface(harness, root), capability, { url: pathToFileURL(file).href });

      // The host's creation path never names the file: that is what keeps the capsule preview
      // shortcut (the app's own UI affordance) off a capability-issued creation.
      assert.equal(harness.created.length, 1);
      assert.equal(harness.created[0]?.url, 'about:blank');
      // The document is loaded through the admitted path, with the canonical path handed to the host.
      assert.equal(harness.navigations.length, 1);
      assert.equal(harness.navigations[0]?.url, admittedUrl);
      const wait = harness.navigations[0]?.wait;
      assert.ok(wait && typeof wait === 'object' && 'admittedLocalFilePath' in wait, 'the navigation carries the admitted local path');
      assert.equal(wait.admittedLocalFilePath, path.resolve(fs.realpathSync.native(file)));
      // The row reports the tab and the URL the tab settled on.
      assert.deepEqual(result, { tabId: 'tab-new-1', navigated: true, url: admittedUrl });
      assert.deepEqual(harness.closed, []);
    });
  }

  it('reports the file only once the page holds it when the load waiter answered for the blank document', async () => {
    // Measured on the live app: the waiter resolved on the new tab's own about:blank load, so the
    // row said `navigated:true, url:about:blank` while the file committed milliseconds later.
    const admittedUrl = pathToFileURL(fs.realpathSync.native(file)).href;
    let probes = 0;
    const harness = makeHarness({
      commitOnNavigate: false,
      evalJs: async () => {
        probes += 1;
        return probes < 3
          ? { url: 'about:blank', readyState: 'complete', errorPage: false }
          : { url: admittedUrl, readyState: 'complete', errorPage: false };
      },
    });

    const result = await execute(surface(harness, root), 'anti.browser.tabs.create', { url: pathToFileURL(file).href });

    assert.deepEqual(result, { tabId: 'tab-new-1', navigated: true, url: admittedUrl });
    assert.equal(probes, 3);
  });

  it('refuses a file outside the workspace root with the loopback serve hint and closes the blank tab', async () => {
    const harness = makeHarness();

    const error = await rejection(execute(surface(harness, root), 'anti.browser.tabs.create', { url: pathToFileURL(outside).href }));

    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /file: navigation is limited to an existing regular file inside the workspace root/);
    assert.match(error.message, /http:\/\/127\.0\.0\.1/);
    assert.equal(typeof error.details?.localFileServeHint, 'string');
    assert.equal(error.details?.failedCheck, 'localFileNavigation');
    // The file never reached the host, and the blank tab the creation opened was closed again.
    assert.equal(harness.navigations.length, 0);
    assert.equal(harness.created.length, 1);
    assert.ok(harness.created[0]?.url === 'about:blank');
    assert.deepEqual(harness.closed, ['tab-new-1']);
  });

  it('refuses the Windows path form of a local document instead of letting it become a preview', async () => {
    const harness = makeHarness();

    const error = await rejection(execute(surface(harness, root), 'anti.browser.tabs.create', { url: file }));

    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /a local page must be a file: URL inside the workspace root/);
    assert.match(error.message, /http:\/\/127\.0\.0\.1/);
    assert.equal(harness.navigations.length, 0);
    assert.deepEqual(harness.closed, ['tab-new-1']);
  });

  it('still opens and admits the file after the session lost its bound tab', async () => {
    // The transport clears the target when the bound tab was closed, so a creation is dispatched
    // with no authority record at all. That is exactly the session this path must keep working for.
    const harness = makeHarness();
    const unbound = { ...context, browserTarget: undefined };
    const admittedUrl = pathToFileURL(fs.realpathSync.native(file)).href;
    const registered = surface(harness, root).get('anti.browser.tabs.create');
    assert.ok(registered);

    const result = await registered.execute({ url: pathToFileURL(file).href }, unbound);

    assert.deepEqual(result, { tabId: 'tab-new-1', navigated: true, url: admittedUrl });
    assert.equal(harness.created[0]?.url, 'about:blank');
    assert.equal(harness.navigations[0]?.url, admittedUrl);
  });

  it('still hands a file URL straight to the host when an in-process caller opens the tab', () => {
    // The UI preview path: BrowserControlPort.openTab is what the app's own surfaces use, and the
    // host turns a file target into its capsule preview tab. Unchanged by the capability routing.
    const harness = makeHarness();

    const opened = harness.port.openTab({ url: pathToFileURL(file).href }, { target });

    assert.deepEqual(opened, { tabId: 'tab-new-1' });
    assert.equal(harness.created[0]?.url, pathToFileURL(file).href);
    assert.equal(harness.navigations.length, 0);
  });
});
