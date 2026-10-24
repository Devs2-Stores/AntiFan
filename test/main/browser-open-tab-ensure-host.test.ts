import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget, type CapabilityRequestContext, type RuntimeLease } from '../../src/shared/control-plane-contracts';

const projectId = 'proj-open';
const workspaceId = 'ws-open';

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

const boundTarget: BrowserTarget = {
  projectId,
  workspaceId,
  runtimeId: 'run-1',
  tabId: 'tab-bound',
  browserEpoch: 1,
  documentGeneration: 1,
};

const contextWith = (browserTarget?: BrowserTarget): CapabilityRequestContext => ({
  lease,
  leaseToken: 'lease-tok',
  projectId,
  workspaceId,
  runId: 'run-1',
  attemptId: 'att-1',
  ...(browserTarget ? { browserTarget } : {}),
  grant: 'write',
});

interface Recorded {
  events: string[];
  ensureCalls: Array<{ target?: BrowserTarget; authenticatedProjectId?: string }>;
  openCalls: Array<{ target?: BrowserTarget; authenticatedProjectId?: string }>;
}

/**
 * A port whose window is not open until the host seam resolves: `openTab` refuses with the
 * same TARGET_REQUIRED an ambient host lookup gives while no project window exists.
 */
function scenario(): { catalogue: CapabilityCatalogue; recorded: Recorded } {
  const recorded: Recorded = { events: [], ensureCalls: [], openCalls: [] };
  let windowOpen = false;
  const stub = {
    ensureHostForNewTab: async (context: { target?: BrowserTarget; authenticatedProjectId?: string }) => {
      recorded.ensureCalls.push(context);
      recorded.events.push('ensure:start');
      await Promise.resolve();
      windowOpen = true;
      recorded.events.push('ensure:done');
    },
    openTab: (_options: unknown, context: { target?: BrowserTarget; authenticatedProjectId?: string }) => {
      recorded.openCalls.push(context);
      recorded.events.push('open');
      if (!windowOpen) throw new CapabilityError('TARGET_REQUIRED', 'no project window is live');
      return { tabId: 'tab-new' };
    },
  };
  // The capabilities only call these two members on this path.
  const port = stub as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    hostEpoch: 1,
  });
  registerBrowserCapabilities(catalogue, port);
  return { catalogue, recorded };
}

describe('tab creation waits for the project window', () => {
  for (const name of ['browser.open-tab', 'antifan_open_tab', 'anti.browser.tabs.create']) {
    it(`${name} awaits the host seam before creating the tab`, async () => {
      const { catalogue, recorded } = scenario();
      const capability = catalogue.get(name);
      assert.ok(capability, `${name} must be registered`);
      const result = await capability.execute({ url: 'about:blank' }, contextWith());
      assert.deepEqual(result, { tabId: 'tab-new' });
      assert.deepEqual(recorded.events, ['ensure:start', 'ensure:done', 'open']);
      assert.equal(recorded.ensureCalls.length, 1);
      assert.equal(recorded.ensureCalls[0]!.authenticatedProjectId, projectId);
    });
  }

  it('hands the bound target to the seam so a session with a bound tab can be told apart', async () => {
    const { catalogue, recorded } = scenario();
    const capability = catalogue.get('anti.browser.tabs.create');
    assert.ok(capability);
    await capability.execute({}, contextWith(boundTarget));
    assert.equal(recorded.ensureCalls[0]!.target?.tabId, 'tab-bound');
    assert.equal(recorded.openCalls[0]!.target?.tabId, 'tab-bound');
    assert.equal(recorded.openCalls[0]!.authenticatedProjectId, projectId);
  });

  it('a refusal from the seam is surfaced and no tab is created', async () => {
    const opened: string[] = [];
    const port = { ensureHostForNewTab: async () => { throw new CapabilityError('TARGET_REQUIRED', 'unknown project'); }, openTab: () => { opened.push('open'); return { tabId: 'x' }; } };
    const refusing = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: 'run-1',
      hostEpoch: 1,
    });
    registerBrowserCapabilities(refusing, port as unknown as BrowserControlPort);
    const capability = refusing.get('anti.browser.tabs.create');
    assert.ok(capability);
    await assert.rejects(
      () => Promise.resolve(capability.execute({}, contextWith())),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED'
    );
    assert.deepEqual(opened, []);
  });
});
