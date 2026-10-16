// A tab asked to lay out at a width must still do so after a navigation or reload: a cross-process
// commit can come up with the renderer's default layout while the host records the request. The host
// puts the stored request back on commit, and getViewport reports requested next to observed width so
// a disagreement is visible instead of silently graded.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { requestedViewportWidth, viewportWidthMismatch, VIEWPORT_MISMATCH_TOLERANCE_PX } from '../../src/main/browser/viewport-request';
import { BrowserTarget, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

function makeTarget(tabId = 'tab-1'): BrowserTarget {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  return { tabId, browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
}

describe('requested viewport width', () => {
  it('is null for a fluid tab and for a missing tab', () => {
    assert.equal(requestedViewportWidth(undefined), null);
    assert.equal(requestedViewportWidth({ devicePresetId: 'responsive' }), null);
    assert.equal(requestedViewportWidth({}), null);
  });

  it('reads a custom viewport and a custom preset id', () => {
    assert.equal(requestedViewportWidth({ customViewport: { width: 390, height: 844 } }), 390);
    assert.equal(requestedViewportWidth({ devicePresetId: 'custom-412x915' }), 412);
  });

  it('prefers a known preset over a stale custom size, as the emulation does', () => {
    assert.equal(requestedViewportWidth({ devicePresetId: 'phone-iphone15pro', customViewport: { width: 999, height: 999 } }), 393);
  });

  it('uses the desktop pane preset in split review', () => {
    assert.equal(requestedViewportWidth({ splitMode: true, splitDesktopPresetId: 'laptop-macbook13' }), 1280);
  });

  it('counts a mismatch only beyond the tolerance and only when something was requested', () => {
    assert.equal(viewportWidthMismatch(null, 1280), false);
    assert.equal(viewportWidthMismatch(390, 390 + VIEWPORT_MISMATCH_TOLERANCE_PX), false);
    assert.equal(viewportWidthMismatch(390, 390 + VIEWPORT_MISMATCH_TOLERANCE_PX + 1), true);
    assert.equal(viewportWidthMismatch(390, 0), false, 'an unmeasured surface is reported through its cause, not as a width mismatch');
  });
});

describe('getViewport requested versus observed', () => {
  function portWith(tab: Record<string, unknown>, vw: number | undefined): BrowserControlPort {
    return new BrowserControlPort({
      navigate: () => true,
      reload: () => true,
      getDom: async () => '',
      captureScreenshot: async () => '',
      evalJs: async () => undefined,
      getTabList: () => [{ id: 'tab-1', ...tab }],
      hasTab: (id: string) => id === 'tab-1',
      getActiveTabId: () => 'tab-1',
      getDocumentGeneration: () => 1,
      readRenderSurface: async () => {
        if (vw === undefined) throw Object.assign(new Error('no surface'), { code: 'NO_RENDER_SURFACE' });
        return { vw, vh: 800, dpr: 2 };
      },
    } as unknown as BrowserHostPort);
  }

  it('reports a re-applied request as matching', async () => {
    const view = await portWith({ customViewport: { width: 390, height: 844, mobile: true } }, 390).getViewport({}, makeTarget());
    assert.equal(view.requestedWidth, 390);
    assert.equal(view.observedWidth, 390);
    assert.equal(view.mismatch, false);
  });

  it('surfaces a layout that did not take the request', async () => {
    const view = await portWith({ customViewport: { width: 390, height: 844, mobile: true } }, 1280).getViewport({}, makeTarget());
    assert.equal(view.requestedWidth, 390);
    assert.equal(view.observedWidth, 1280);
    assert.equal(view.mismatch, true);
  });

  it('reports no request for a fluid tab and never flags it', async () => {
    const view = await portWith({ devicePresetId: 'responsive' }, 1280).getViewport({}, makeTarget());
    assert.equal(view.requestedWidth, null);
    assert.equal(view.mismatch, false);
  });

  it('keeps the request visible when the surface cannot be measured', async () => {
    const view = await portWith({ customViewport: { width: 390, height: 844 } }, undefined).getViewport({}, makeTarget());
    assert.equal(view.requestedWidth, 390);
    assert.equal(view.observedWidth, 0);
    assert.equal(view.mismatch, false);
  });
});

describe('host puts the stored request back on a navigation commit', () => {
  interface EmulationHost {
    tabs: Map<string, unknown>;
    sweepingEmulationTabs: Set<string>;
    applied: string[];
    applyTabDeviceEmulationForTab(tabId: string): void;
    reassertEmulationOnCommit(tabId: string): Promise<void>;
  }

  function hostWithTab(state: Record<string, unknown>, customViewport?: { width: number; height: number }): EmulationHost {
    const host = Object.create(NativeTabHost.prototype) as unknown as EmulationHost;
    host.tabs = new Map([['tab-1', {
      state: { id: 'tab-1', url: 'https://shop.example/', ...state },
      customViewport,
      view: { webContents: { isDestroyed: () => false } },
    }]]);
    host.sweepingEmulationTabs = new Set();
    host.applied = [];
    host.applyTabDeviceEmulationForTab = (tabId: string) => { host.applied.push(tabId); };
    return host;
  }

  it('re-applies a custom viewport request', async () => {
    const host = hostWithTab({ devicePresetId: 'custom-390x844' }, { width: 390, height: 844 });
    await host.reassertEmulationOnCommit('tab-1');
    assert.deepEqual(host.applied, ['tab-1']);
  });

  it('re-applies a named device preset', async () => {
    const host = hostWithTab({ devicePresetId: 'phone-iphone15pro' });
    await host.reassertEmulationOnCommit('tab-1');
    assert.deepEqual(host.applied, ['tab-1']);
  });

  it('leaves a fluid tab alone', async () => {
    const host = hostWithTab({ devicePresetId: 'responsive' });
    await host.reassertEmulationOnCommit('tab-1');
    assert.deepEqual(host.applied, []);
  });

  it('does not fight a sweep that owns the tab emulation', async () => {
    const host = hostWithTab({ devicePresetId: 'phone-iphone15pro' });
    host.sweepingEmulationTabs.add('tab-1');
    await host.reassertEmulationOnCommit('tab-1');
    assert.deepEqual(host.applied, []);
  });

  it('ignores a tab whose view is gone', async () => {
    const host = hostWithTab({ devicePresetId: 'phone-iphone15pro' });
    host.tabs.set('tab-1', { state: { id: 'tab-1', devicePresetId: 'phone-iphone15pro' }, view: { webContents: { isDestroyed: () => true } } });
    await host.reassertEmulationOnCommit('tab-1');
    assert.deepEqual(host.applied, []);
  });
});
