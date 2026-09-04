import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, CapabilityRequestContext, RuntimeLease, AuthenticatedCapabilityContext, CapabilityError } from '../../src/shared/control-plane-contracts';
import { buildInspectFontIsolatedScript } from '../../src/main/browser/scripts/advanced-inspection-scripts';

describe('Font Inspection Capabilities (100% Rendered Typography)', () => {
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
    grant: 'read',
  };

  const catalogueOptions = {
    runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    hostEpoch: 1,
  };

  it('registers and executes browser.inspect_font and anti.inspect.font through host', async () => {
    let capturedParams: unknown = null;
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123', title: 'Test', url: 'http://localhost' }],
      navigate: async () => true,
      reload: async () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      inspectFont: async (params) => {
        capturedParams = params;
        return {
          target: { tag: 'h1', id: 'main-title' },
          declared: {
            fontFamily: '"TAB Dough Sans", Inter, sans-serif',
            primaryDeclared: 'TAB Dough Sans',
            fontSize: '32px',
            fontWeight: '700',
          },
          textMetrics: {
            sampleText: 'Bánh Mì Tươi Mới Mỗi Ngày',
            characterCount: 25,
            glyphCount: 20,
            hasVietnameseDiacritics: true,
          },
          rendered: {
            is100PercentAccurate: true,
            isPrimaryRendered: true,
            hasFallbackGlyphs: false,
            primaryRenderedFont: 'TAB Dough Sans',
            renderedFonts: [
              { familyName: 'TAB Dough Sans', isCustomFont: true, glyphCount: 20 },
            ],
            fallbackFonts: [],
          },
          verdict: 'PERFECT_MATCH',
          summary: '100% of rendered glyphs (20) are rendered with primary declared font "TAB Dough Sans".',
        };
      },
    };

    const controlPort = new BrowserControlPort(mockHost);
    const catalogue = new CapabilityCatalogue(catalogueOptions);
    registerBrowserCapabilities(catalogue, controlPort);

    // 1. Verify capability registration
    const fontCap = catalogue.get('browser.inspect_font');
    assert.ok(fontCap, 'browser.inspect_font should be registered');
    assert.strictEqual(fontCap.risk, 'read');

    const antiFontCap = catalogue.get('anti.inspect.font');
    assert.ok(antiFontCap, 'anti.inspect.font alias should be registered');
    assert.strictEqual(antiFontCap.risk, 'read');

    // 2. Dispatch browser.inspect_font
    const res1 = (await fontCap.execute(
      { selector: 'h1.title', tabId: 'tab-123', paneId: 'desktop' },
      mockContext
    )) as Record<string, unknown>;

    assert.ok(res1);
    assert.strictEqual(res1.verdict, 'PERFECT_MATCH');
    const rendered1 = res1.rendered as Record<string, unknown>;
    assert.strictEqual(rendered1.is100PercentAccurate, true);
    assert.strictEqual(rendered1.isPrimaryRendered, true);
    assert.deepStrictEqual(capturedParams, {
      selector: 'h1.title',
      tabId: 'tab-123',
      paneId: 'desktop',
    });

    // 3. Dispatch anti.inspect.font alias
    const res2 = (await antiFontCap.execute(
      { ref: '@e5', tabId: 'tab-123', paneId: 'mobile' },
      mockContext
    )) as Record<string, unknown>;

    assert.ok(res2);
    assert.strictEqual(res2.verdict, 'PERFECT_MATCH');
    assert.deepStrictEqual(capturedParams, {
      ref: '@e5',
      tabId: 'tab-123',
      paneId: 'mobile',
    });
  });

  it('correctly models FALLBACK_DETECTED when Vietnamese glyphs fall back to system font', async () => {
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123', title: 'Test', url: 'http://localhost' }],
      navigate: async () => true,
      reload: async () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      inspectFont: async () => {
        return {
          target: { tag: 'p', className: 'product-desc' },
          declared: {
            fontFamily: 'Futura, sans-serif',
            primaryDeclared: 'Futura',
          },
          textMetrics: {
            sampleText: 'Sản phẩm thủ công độc bản',
            characterCount: 26,
            glyphCount: 21,
            hasVietnameseDiacritics: true,
          },
          rendered: {
            is100PercentAccurate: true,
            isPrimaryRendered: true,
            hasFallbackGlyphs: true,
            primaryRenderedFont: 'Futura',
            renderedFonts: [
              { familyName: 'Futura', isCustomFont: true, glyphCount: 16 },
              { familyName: 'Segoe UI', isCustomFont: false, glyphCount: 5 },
            ],
            fallbackFonts: ['Segoe UI'],
          },
          verdict: 'FALLBACK_DETECTED',
          summary: 'Primary font "Futura" rendered 16 glyphs, but 5 glyphs fell back to Segoe UI.',
        };
      },
    };

    const controlPort = new BrowserControlPort(mockHost);
    const catalogue = new CapabilityCatalogue(catalogueOptions);
    registerBrowserCapabilities(catalogue, controlPort);

    const fontCap = catalogue.get('browser.inspect_font')!;
    const res = (await fontCap.execute(
      { selector: '.product-desc' },
      mockContext
    )) as Record<string, unknown>;

    assert.strictEqual(res.verdict, 'FALLBACK_DETECTED');
    const rendered = res.rendered as Record<string, unknown>;
    assert.strictEqual(rendered.hasFallbackGlyphs, true);
    assert.deepStrictEqual(rendered.fallbackFonts, ['Segoe UI']);
  });

  it('correctly models FONT_MISSING_OR_FAILED when declared font fails to render', async () => {
    const mockHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123', title: 'Test', url: 'http://localhost' }],
      navigate: async () => true,
      reload: async () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
      inspectFont: async () => {
        return {
          target: { tag: 'h2' },
          declared: {
            fontFamily: 'NonExistentFont, Arial, sans-serif',
            primaryDeclared: 'NonExistentFont',
          },
          rendered: {
            is100PercentAccurate: true,
            isPrimaryRendered: false,
            hasFallbackGlyphs: false,
            primaryRenderedFont: undefined,
            renderedFonts: [
              { familyName: 'Arial', isCustomFont: false, glyphCount: 12 },
            ],
            fallbackFonts: ['Arial'],
          },
          verdict: 'FONT_MISSING_OR_FAILED',
          summary: 'Declared font "NonExistentFont" was NOT rendered! 100% of glyphs fell back to Arial.',
        };
      },
    };

    const controlPort = new BrowserControlPort(mockHost);
    const catalogue = new CapabilityCatalogue(catalogueOptions);
    registerBrowserCapabilities(catalogue, controlPort);

    const fontCap = catalogue.get('browser.inspect_font')!;
    const res = (await fontCap.execute(
      { selector: 'h2' },
      mockContext
    )) as Record<string, unknown>;

    assert.strictEqual(res.verdict, 'FONT_MISSING_OR_FAILED');
    const rendered = res.rendered as Record<string, unknown>;
    assert.strictEqual(rendered.isPrimaryRendered, false);
  });

  it('generates valid in-page isolation script via buildInspectFontIsolatedScript', () => {
    const script = buildInspectFontIsolatedScript({
      selector: 'h1.hero-title',
      documentUrl: 'https://test.local/store',
    });

    assert.ok(typeof script === 'string');
    assert.ok(script.includes('window.__antifan_last_inspected_font_element'));
    assert.ok(script.includes('document.fonts.check'));
    assert.ok(script.includes('FONT_FACE_RULE'));
    assert.ok(script.includes('hasVietnameseDiacritics'));
  });

  it('rejects when host does not support inspectFont', async () => {
    const emptyHost: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-123', title: 'Test', url: 'http://localhost' }],
      navigate: async () => true,
      reload: async () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => ({}),
    };

    const controlPort = new BrowserControlPort(emptyHost);
    const catalogue = new CapabilityCatalogue(catalogueOptions);
    registerBrowserCapabilities(catalogue, controlPort);

    const fontCap = catalogue.get('browser.inspect_font')!;
    await assert.rejects(
      async () => {
        await fontCap.execute({ selector: 'h1' }, mockContext);
      },
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'CAPABILITY_NOT_FOUND');
        assert.ok(err.message.includes('inspectFont is not supported by host'));
        return true;
      }
    );
  });
});
