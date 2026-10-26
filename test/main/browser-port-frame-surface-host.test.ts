import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BrowserControlPort,
  DEFAULT_STOREFRONT_WIDGETS,
  type BrowserHostPort,
} from '../../src/main/tools/browser-control-port';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { PLATFORM_PREVIEW_CHROME_SELECTORS } from '../../src/main/qa/platform-preview-chrome';
import {
  CapabilityError,
  type AuthenticatedCapabilityContext,
  type BrowserTarget,
  type RuntimeLease,
} from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

function buildHost(overrides: Partial<BrowserHostPort> = {}): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: 'https://shop.example/' }],
    hasTab: (id) => id === 'tab-1',
    getTabUrl: () => 'https://shop.example/',
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => 'evaluated',
    ...overrides,
  };
}

describe('evalInFrame frame selectors (K14)', () => {
  it('forwards a frame id, index and selector object to the host', async () => {
    const seen: unknown[] = [];
    const port = new BrowserControlPort(buildHost({
      evalJsInFrame: async (_expr, frame) => {
        seen.push(frame);
        return 'ok';
      },
    }));
    await port.evalInFrame(TARGET, '1', { frameId: 7 }, 'tab-1');
    await port.evalInFrame(TARGET, '1', { index: 0, selector: 'iframe.pay' }, 'tab-1');
    assert.deepEqual(seen, [{ frameId: 7 }, { index: 0, selector: 'iframe.pay' }]);
  });

  it('keeps the URL-substring string form and collapses a lone frameUrl to it', async () => {
    const seen: unknown[] = [];
    const port = new BrowserControlPort(buildHost({
      evalJsInFrame: async (_expr, frame) => {
        seen.push(frame);
        return 'ok';
      },
    }));
    await port.evalInFrame(TARGET, '1', ' checkout.example ', 'tab-1');
    await port.evalInFrame(TARGET, '1', { frameUrl: 'checkout.example' }, 'tab-1');
    assert.deepEqual(seen, ['checkout.example', 'checkout.example']);
  });

  it('an empty selector names the accepted fields', async () => {
    const port = new BrowserControlPort(buildHost({ evalJsInFrame: async () => 'ok' }));
    for (const bad of ['', '  ', {}]) {
      await assert.rejects(
        () => port.evalInFrame(TARGET, '1', bad, 'tab-1'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('frameId') && err.message.includes('frameSelector')
      );
    }
    await assert.rejects(
      () => port.evalInFrame(TARGET, '1', { frameId: 1.5 }, 'tab-1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });
});

describe('dialog action alias (K16)', () => {
  it("'read' behaves as 'get' and an unknown action is refused", async () => {
    const port = new BrowserControlPort(buildHost({
      getOpenJsDialog: () => undefined,
      answerJsDialog: async () => {
        throw new Error('must not answer on read');
      },
    }));
    const res = await port.jsDialog({ action: 'read' }, TARGET);
    assert.deepEqual(res, { tabId: 'tab-1', open: false });
    await assert.rejects(
      // @ts-expect-error an action outside the enum must be refused at runtime
      () => port.jsDialog({ action: 'peek' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });
});

describe('INVALID_ARGUMENT names the valid fields (K16)', () => {
  it('a missing required argument lists the schema fields', async () => {
    const lease: RuntimeLease = {
      token: 'lease-tok',
      expiresAt: Date.now() + 60_000,
      runtimeId: 'run-1',
      projectId: TARGET.projectId,
      workspaceId: TARGET.workspaceId,
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: TARGET.projectId,
      workspaceId: TARGET.workspaceId,
      runtimeId: 'run-1',
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, new BrowserControlPort(buildHost()));
    const context: AuthenticatedCapabilityContext = {
      lease,
      leaseToken: 'lease-tok',
      projectId: TARGET.projectId,
      workspaceId: TARGET.workspaceId,
      runId: 'run-1',
      attemptId: 'att-1',
      attachmentId: 'att-1',
      backendId: 'be-1',
      hostEpoch: 1,
      invocationId: 'inv-1',
      browserTarget: TARGET,
      grant: 'write',
    };
    await assert.rejects(
      () => catalogue.dispatchAuthenticated('anti.browser.tabs.activate', {}, context),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'INVALID_ARGUMENT');
        assert.ok(err.message.includes('Valid fields'));
        assert.ok(Array.isArray(err.details?.validFields) && err.details.validFields.includes('tabId'));
        return true;
      }
    );
  });
});

describe('render-surface drain refusal (K5)', () => {
  function drainingHost(): BrowserHostPort {
    return buildHost({
      readRenderSurface: async () => {
        throw new CapabilityError('TARGET_BUSY_DRAINING', 'Target tab-1 is draining a timed-out command', { retryAfterMs: 3200 });
      },
    });
  }

  it('keeps retryAfterMs and names a recovery that bypasses the blocked queue', async () => {
    const port = new BrowserControlPort(drainingHost());
    await assert.rejects(
      () => port.eval(TARGET, '1', 'tab-1', 'desktop', { requireRenderSurface: true }),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'TARGET_BUSY_DRAINING');
        assert.equal(err.details?.retryAfterMs, 3200);
        assert.ok(String(err.details?.recovery).includes('anti.browser.tabs.close'));
        return true;
      }
    );
  });

  it('allowDegradedSurface goes on instead of refusing', async () => {
    const port = new BrowserControlPort(drainingHost());
    const res = await port.eval(TARGET, '1', 'tab-1', 'desktop', { requireRenderSurface: true, allowDegradedSurface: true });
    assert.equal(res, 'evaluated');
  });
});

describe('ensureHostForNewTab (K8)', () => {
  it('awaits the project host seam before a session with no bound tab creates its tab', async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const port = new BrowserControlPort(buildHost({
      ensureProjectTabHost: async (projectId) => {
        order.push(`start:${projectId}`);
        await gate.promise;
        order.push('done');
      },
    }));
    const pending = port.ensureHostForNewTab({ authenticatedProjectId: 'proj-9' });
    order.push('before-release');
    gate.resolve();
    await pending;
    order.push('after');
    assert.deepEqual(order, ['start:proj-9', 'before-release', 'done', 'after']);
  });

  it('does nothing when the session is already bound to a tab or names no project', async () => {
    let calls = 0;
    const port = new BrowserControlPort(buildHost({
      ensureProjectTabHost: async () => {
        calls += 1;
      },
    }));
    await port.ensureHostForNewTab({ target: TARGET, authenticatedProjectId: 'proj-9' });
    await port.ensureHostForNewTab({});
    await port.ensureHostForNewTab(undefined);
    assert.equal(calls, 0);
  });

  it('asks for a visible window only for a real http(s) page, never for a blank tab', async () => {
    const seen: Array<boolean | undefined> = [];
    const port = new BrowserControlPort(buildHost({
      ensureProjectTabHost: async (_projectId, options) => {
        seen.push(options?.visible);
      },
    }));
    await port.ensureHostForNewTab({ authenticatedProjectId: 'proj-9' });
    await port.ensureHostForNewTab({ authenticatedProjectId: 'proj-9', url: '' });
    await port.ensureHostForNewTab({ authenticatedProjectId: 'proj-9', url: 'about:blank' });
    await port.ensureHostForNewTab({ authenticatedProjectId: 'proj-9', url: 'https://example.com/a' });
    assert.deepEqual(seen, [false, false, false, true]);
  });

  it('surfaces the window holding a bound tab for web work only', async () => {
    const surfaced: string[] = [];
    const port = new BrowserControlPort(buildHost({ surfaceTabWindow: (tabId) => { surfaced.push(tabId); } }));
    await port.ensureHostForNewTab({ target: TARGET, authenticatedProjectId: 'proj-9' });
    await port.ensureHostForNewTab({ target: TARGET, authenticatedProjectId: 'proj-9', url: 'about:blank' });
    assert.deepEqual(surfaced, []);
    await port.ensureHostForNewTab({ target: TARGET, authenticatedProjectId: 'proj-9', url: 'http://example.com' });
    assert.deepEqual(surfaced, [TARGET.tabId]);
  });

  it('is a no-op when the host has no seam', async () => {
    await new BrowserControlPort(buildHost()).ensureHostForNewTab({ authenticatedProjectId: 'proj-9' });
  });
});

describe('default storefront widget masks (K9)', () => {
  it('spread the shared platform preview chrome and keep the chat / fake-order entries', () => {
    for (const selector of PLATFORM_PREVIEW_CHROME_SELECTORS) {
      assert.ok(DEFAULT_STOREFRONT_WIDGETS.includes(selector), `missing shared selector ${selector}`);
    }
    for (const kept of ['#fake-order-popup', '[id*="fake-order"]', '.chat-widget', '[class*="zalo-chat"]', '#fb-root', '#subiz']) {
      assert.ok(DEFAULT_STOREFRONT_WIDGETS.includes(kept), `lost first-party-neutral entry ${kept}`);
    }
  });

  it('the override style marker is never part of a shared constant', () => {
    assert.ok(!PLATFORM_PREVIEW_CHROME_SELECTORS.some((s) => s.includes('data-antifan-override')));
    assert.ok(!DEFAULT_STOREFRONT_WIDGETS.some((s) => s.includes('data-antifan-override')));
  });
});
