import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityRequestContext, RuntimeLease } from '../../src/shared/control-plane-contracts';

describe('Advanced Inspection Browser Capabilities', () => {
  const projectId = 'proj-1';
  const workspaceId = 'ws-1';

  const mockTarget: BrowserTarget = {
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    tabId: 'tab-123',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const mockLease: RuntimeLease = {
    token: 'lease-tok',
    expiresAt: Date.now() + 60000,
    runtimeId: 'run-1',
    projectId,
    workspaceId,
    protocolVersion: 1,
    hostEpoch: 1,
    ownerPid: process.pid,
    issuedAt: Date.now(),
  };

  const mockContext: CapabilityRequestContext = {
    lease: mockLease,
    leaseToken: 'lease-tok',
    projectId,
    workspaceId,
    runId: 'run-123',
    attemptId: 'att-1',
    browserTarget: mockTarget,
    grant: 'write',
  };

  const catalogueOptions = {
    runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    hostEpoch: 1,
  };

  it('registers and executes browser.inspect_styles and anti.inspect.styles through host', async () => {
    let capturedInspectStylesParams: unknown = null;
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      inspectStyles: async (params) => {
        capturedInspectStylesParams = params;
        return {
          target: { tag: 'h1', id: 'heading' },
          boxModel: { width: 400, height: 60, margin: { top: 16, right: 0, bottom: 16, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 0, right: 0, bottom: 0, left: 0 } },
          typography: { fontSize: '32px', fontWeight: '700', fontFamily: 'sans-serif' },
          cssVariables: { '--brand-color': '#0066cc' },
        };
      },
    };

    const catalogue = new CapabilityCatalogue(catalogueOptions);
    const controlPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, controlPort);

    const canonicalCap = catalogue.get('browser.inspect_styles');
    assert.ok(canonicalCap);
    assert.strictEqual(canonicalCap.risk, 'read');

    const canonicalRes = await canonicalCap.execute({ selector: '#heading', properties: ['font-size', 'color'] }, mockContext) as Record<string, unknown>;
    assert.ok(canonicalRes);
    assert.deepStrictEqual((canonicalRes as { typography: { fontSize: string } }).typography.fontSize, '32px');
    assert.strictEqual((capturedInspectStylesParams as { selector: string }).selector, '#heading');

    const aliasCap = catalogue.get('anti.inspect.styles');
    assert.ok(aliasCap);
    const aliasRes = await aliasCap.execute({ ref: '@e5' }, mockContext) as Record<string, unknown>;
    assert.ok(aliasRes);
    assert.strictEqual((capturedInspectStylesParams as { ref: string }).ref, '@e5');
  });

  it('registers and executes browser.inspect_region and anti.inspect.region through host', async () => {
    let capturedRegionParams: unknown = null;
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      inspectRegion: async (params) => {
        capturedRegionParams = params;
        return {
          region: { left: 0, top: 0, width: 300, height: 200 },
          elementCount: 2,
          elements: [
            { tag: 'button', id: 'cta-btn', rect: { left: 10, top: 20, width: 120, height: 40 } },
            { tag: 'span', className: 'badge', rect: { left: 140, top: 20, width: 60, height: 24 } },
          ],
        };
      },
    };

    const catalogue = new CapabilityCatalogue(catalogueOptions);
    const controlPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, controlPort);

    const cap = catalogue.get('browser.inspect_region');
    assert.ok(cap);
    const res = await cap.execute({ x: 0, y: 0, width: 300, height: 200 }, mockContext) as Record<string, unknown>;
    assert.ok(res);
    assert.strictEqual((res as { elementCount: number }).elementCount, 2);
    assert.strictEqual((capturedRegionParams as { width: number }).width, 300);

    const aliasCap = catalogue.get('anti.inspect.region');
    assert.ok(aliasCap);
    const aliasRes = await aliasCap.execute({ selector: '#header-banner' }, mockContext) as Record<string, unknown>;
    assert.ok(aliasRes);
    assert.strictEqual((capturedRegionParams as { selector: string }).selector, '#header-banner');
  });

  it('registers and executes browser.trace_interaction with pre/post style capture under viewport lock', async () => {
    const clicked: string[] = [];
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      agentClick: async (params) => {
        clicked.push(params.selector || params.ref || '');
        return true;
      },
      inspectStyles: async () => ({
        typography: { color: clicked.length === 0 ? 'black' : 'red' },
      }),
    };

    const catalogue = new CapabilityCatalogue(catalogueOptions);
    const controlPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, controlPort);

    const cap = catalogue.get('browser.trace_interaction');
    assert.ok(cap);
    assert.strictEqual(cap.risk, 'write');

    const res = await cap.execute({ action: 'click', selector: '#toggle-btn', settleMs: 30 }, mockContext) as Record<string, unknown>;
    assert.ok(res);
    assert.strictEqual(res.action, 'click');
    assert.strictEqual(res.settled, true);
    assert.deepStrictEqual(clicked, ['#toggle-btn']);
    assert.deepStrictEqual((res.beforeStyles as { typography: { color: string } }).typography.color, 'black');
    assert.deepStrictEqual((res.afterStyles as { typography: { color: string } }).typography.color, 'red');
  });
});
