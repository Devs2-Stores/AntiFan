import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';
import { ThemeEvidenceEnvelope, isThemeEvidenceEnvelope } from '../../src/main/tools/theme-evidence-envelope';
import { ThemeSourceMapper, isAuthoritativeSourceCandidate } from '../../src/main/browser/theme-source-mapper';
import { CssCascadeAnalyzer, RawCdpMatchedStylesPayload } from '../../src/main/browser/css-cascade-analyzer';

describe('Phase 3: Theme Evidence Capabilities', () => {
  const fixtureThemeRoot = path.resolve(process.cwd(), 'test/fixtures/golden-workflow/product-card/theme');

  it('verifies ThemeEvidenceEnvelope schema and type guard', () => {
    const validEnvelope: ThemeEvidenceEnvelope<{ count: number }> = {
      success: true,
      data: { count: 42 },
      evidenceQuality: 'HIGH',
      signals: { markupClassMatch: true, renderCallMatch: true },
      timestamp: Date.now(),
    };

    assert.strictEqual(isThemeEvidenceEnvelope(validEnvelope), true);
    assert.strictEqual(isThemeEvidenceEnvelope(null), false);
    assert.strictEqual(isThemeEvidenceEnvelope({ success: true }), false);
  });

  it('maps element hints to a unique correlated HIGH candidate with evidence locators', () => {
    const envelope = ThemeSourceMapper.mapElementToSource(fixtureThemeRoot, {
      tagName: 'article',
      classes: ['card', 'product-card', 'card__badge'],
      attributes: {
        'data-section-id': 'featured-collection',
        'data-card-id': 'card-101',
      },
    });

    assert.strictEqual(envelope.success, true);
    assert.strictEqual(envelope.evidenceQuality, 'HIGH');
    assert.strictEqual(envelope.data?.ambiguous, false);
    assert.strictEqual(isAuthoritativeSourceCandidate(envelope.data), true);
    const primary = envelope.data?.primaryCandidate;
    assert.ok(primary);
    assert.strictEqual(primary.file, 'snippets/card-product.liquid');
    assert.strictEqual(primary.type, 'snippet');
    assert.strictEqual(primary.confidence, 'HIGH');
    assert.ok(primary.score >= 7);
    assert.strictEqual(primary.correlated, true);
    assert.ok(primary.evidence.every((item) => item.file === primary.file && item.line > 0));
    assert.ok(primary.evidence.some((item) => item.kind === 'class_token' && item.matched.includes('product-card')));
    assert.ok(primary.evidence.some((item) => item.kind === 'render_edge' && item.parentFile === 'sections/main-collection.liquid'));
  });

  it('rejects substring collisions and unrelated global render signals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-source-substring-'));
    fs.mkdirSync(path.join(root, 'snippets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snippets', 'target-copy.liquid'), '<article class="product-card-copy"></article>');
    fs.writeFileSync(path.join(root, 'snippets', 'unrelated.liquid'), '<aside class="other"></aside>');
    fs.writeFileSync(path.join(root, 'sections', 'main.liquid'), "{% render 'unrelated' %}");

    const envelope = ThemeSourceMapper.mapElementToSource(root, { tagName: 'article', classes: ['product-card'] });
    assert.strictEqual(envelope.data?.candidates.some((candidate) => candidate.signals.markupClassMatch), false);
    assert.strictEqual(isAuthoritativeSourceCandidate(envelope.data), false);
  });

  it('keeps tied candidates ambiguous with deterministic path ordering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-source-tie-'));
    fs.mkdirSync(path.join(root, 'snippets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snippets', 'beta.liquid'), '<article class="target-card"></article>');
    fs.writeFileSync(path.join(root, 'snippets', 'alpha.liquid'), '<article class="target-card"></article>');
    fs.writeFileSync(path.join(root, 'sections', 'main.liquid'), "{% render 'alpha' %}\n{% render 'beta' %}");

    const envelope = ThemeSourceMapper.mapElementToSource(root, { tagName: 'article', classes: ['target-card'] });
    assert.strictEqual(envelope.data?.ambiguous, true);
    assert.strictEqual(envelope.data?.primaryCandidate, undefined);
    assert.deepStrictEqual(envelope.data?.candidates.slice(0, 2).map((candidate) => candidate.file), [
      'snippets/alpha.liquid',
      'snippets/beta.liquid',
    ]);
    assert.strictEqual(isAuthoritativeSourceCandidate(envelope.data), false);
  });

  it('uses a direct breadcrumb with exact markup as correlated candidate evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-source-breadcrumb-'));
    fs.mkdirSync(path.join(root, 'snippets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snippets', 'focus.liquid'), '<article class="focus-card"></article>');

    const envelope = ThemeSourceMapper.mapElementToSource(root, {
      tagName: 'article',
      classes: ['focus-card'],
      commentHints: ['<!-- snippets/focus.liquid -->'],
    });
    assert.strictEqual(envelope.data?.primaryCandidate?.confidence, 'HIGH');
    assert.strictEqual(envelope.data?.primaryCandidate?.score, 9);
    assert.strictEqual(isAuthoritativeSourceCandidate(envelope.data), true);
  });

  it('analyzes CSS cascade and isolates ACTIVE declarations from OVERRIDDEN rules', () => {
    const mockCdpPayload: RawCdpMatchedStylesPayload = {
      matchedCSSRules: [
        {
          rule: {
            selectorList: { selectors: [{ text: '.card' }] },
            style: {
              cssProperties: [
                { name: 'margin-top', value: '16px' },
                { name: 'display', value: 'flex' },
              ],
              styleSheetId: 'sheet-1',
              range: { startLine: 10, startColumn: 2, endLine: 13, endColumn: 3 },
            },
          },
        },
        {
          rule: {
            selectorList: { selectors: [{ text: '.product-card' }] },
            style: {
              cssProperties: [
                { name: 'margin-top', value: '24px' },
                { name: '--card-badge-bg', value: '#e53e3e' },
              ],
              styleSheetId: 'sheet-1',
              range: { startLine: 20, startColumn: 2, endLine: 23, endColumn: 3 },
            },
          },
        },
      ],
    };

    const envelope = CssCascadeAnalyzer.analyze(mockCdpPayload, {
      'sheet-1': 'assets/component-card.css',
    });

    assert.strictEqual(envelope.success, true);
    assert.strictEqual(envelope.evidenceQuality, 'HIGH');
    assert.strictEqual(envelope.data?.definitionOfDone, 'STRONG PASS');

    const active = envelope.data?.activeRules || [];
    const overridden = envelope.data?.overriddenRules || [];

    const activeMarginTop = active.find((r) => r.property === 'margin-top');
    assert.ok(activeMarginTop);
    assert.strictEqual(activeMarginTop.value, '24px');
    assert.strictEqual(activeMarginTop.selector, '.product-card');
    assert.strictEqual(activeMarginTop.status, 'ACTIVE');
    assert.strictEqual(activeMarginTop.sourceUrl, 'assets/component-card.css');
    assert.strictEqual(activeMarginTop.line, 20);
    assert.strictEqual(activeMarginTop.column, 2);

    const overriddenMarginTop = overridden.find((r) => r.property === 'margin-top');
    assert.ok(overriddenMarginTop);
    assert.strictEqual(overriddenMarginTop.value, '16px');
    assert.strictEqual(overriddenMarginTop.selector, '.card');
    assert.strictEqual(overriddenMarginTop.status, 'OVERRIDDEN');

    assert.strictEqual(envelope.data?.cssVariables['--card-badge-bg'], '#e53e3e');
  });


  it('ignores non-author Chromium origins when grading theme CSS provenance', () => {
    const envelope = CssCascadeAnalyzer.analyze({
      matchedCSSRules: [
        {
          rule: {
            origin: 'user-agent',
            selectorList: { selectors: [{ text: 'address' }] },
            style: { cssProperties: [{ name: 'unicode-bidi', value: 'isolate' }] },
          },
        },
        {
          rule: {
            origin: 'regular',
            selectorList: { selectors: [{ text: '.product-card' }] },
            styleSheetId: 'sheet-theme',
            sourceUrl: 'assets/component-card.css',
            style: {
              cssProperties: [{ name: 'margin-top', value: '24px', range: { startLine: 18, startColumn: 2 } }],
            },
          },
        },
      ],
    });

    assert.strictEqual(envelope.data?.definitionOfDone, 'STRONG PASS');
    assert.deepStrictEqual(envelope.data?.activeRules.map((rule) => rule.property), ['margin-top']);
    assert.strictEqual(envelope.data?.totalRulesAnalyzed, 1);
  });
  it('does not mint STRONG PASS from a stylesheet URL without a CDP source range', () => {
    const envelope = CssCascadeAnalyzer.analyze({
      matchedCSSRules: [{
        rule: {
          selectorList: { selectors: [{ text: '.product-card' }] },
          style: {
            cssProperties: [{ name: 'margin-top', value: '24px' }],
            styleSheetId: 'sheet-1',
          },
          sourceUrl: 'assets/component-card.css',
        },
      }],
    });

    assert.strictEqual(envelope.data?.definitionOfDone, 'PASS');
    assert.strictEqual(envelope.evidenceQuality, 'MEDIUM');
    assert.strictEqual(envelope.signals.hasSourceRange, false);
  });

  it('dispatches anti.theme.resolve_element, anti.inspect.matched_styles, and anti.inspect.responsive_matrix through CapabilityCatalogue', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => ({
        classes: ['product-card', 'card__badge'],
        attributes: { 'data-section-id': 'featured-collection' },
        tagName: 'article',
      }),
      getMatchedStylesForNode: async () => ({
        matchedCSSRules: [
          {
            rule: {
              selectorList: { selectors: [{ text: '.product-card' }] },
              style: { cssProperties: [{ name: 'margin-top', value: '24px' }] },
              styleSheetId: 'sheet-1',
            },
          },
        ],
      }),
      runResponsiveCheck: async () => ({
        ok: true,
        tabId: 'tab-1',
        breakpoints: {
          'mobile-small': { width: 320, documentOverflowX: false, targetOverflowX: false },
          'mobile-standard': { width: 375, documentOverflowX: false, targetOverflowX: false },
          'tablet-portrait': { width: 768, documentOverflowX: false, targetOverflowX: false },
          'tablet-landscape': { width: 1024, documentOverflowX: false, targetOverflowX: false },
          'desktop-laptop': { width: 1440, documentOverflowX: false, targetOverflowX: false },
        },
      }),
    };

    const port = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, port, undefined, () => fixtureThemeRoot);

    assert.ok(catalogue.get('anti.theme.resolve_element'));
    assert.ok(catalogue.get('anti.inspect.matched_styles'));
    assert.ok(catalogue.get('anti.inspect.responsive_matrix'));

    const target: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
      runtimeId: lease.runtimeId,
      projectId,
      workspaceId,
    };

    // 1. Dispatch resolve_element
    const resolveRes = await catalogue.dispatch(
      'anti.theme.resolve_element',
      { selector: '.product-card', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    );
    assert.ok(isThemeEvidenceEnvelope(resolveRes));
    assert.strictEqual(resolveRes.evidenceQuality, 'HIGH');

    // 2. Dispatch matched_styles
    const stylesRes = await catalogue.dispatch(
      'anti.inspect.matched_styles',
      { selector: '.product-card', tabId: 'tab-1' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    );
    assert.ok(isThemeEvidenceEnvelope(stylesRes));
    assert.strictEqual(stylesRes.evidenceQuality, 'MEDIUM'); // 'PASS' because stylesheetUrlMap is empty by default

    // 3. Dispatch responsive_matrix
    const matrixRes = await catalogue.dispatch(
      'anti.inspect.responsive_matrix',
      { selector: '.product-card', tabId: 'tab-1' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    );
    assert.ok(isThemeEvidenceEnvelope(matrixRes));
    assert.strictEqual(matrixRes.evidenceQuality, 'HIGH');
    assert.strictEqual(matrixRes.signals.hasDocOverflow, false);
    assert.strictEqual(matrixRes.signals.hasTargetOverflow, false);
    assert.strictEqual(matrixRes.signals.allBreakpointsTested, true);
  });

  it('verifies theme.debug_bundle synchronizes target.tabId with params.tabId', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-policy' }, { id: 'tab-product' }],
      hasTab: (id) => id === 'tab-policy' || id === 'tab-product',
      getDom: async () => '<html><body><div>No error</div></body></html>',
      evalJs: async () => ({ hasOverflow: false, deltaX: 0, culprits: [] }),
    };

    const port = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, port, undefined, () => fixtureThemeRoot);

    const target: BrowserTarget = {
      tabId: 'tab-policy',
      browserEpoch: 1,
      documentGeneration: 1,
      runtimeId: lease.runtimeId,
      projectId,
      workspaceId,
    };

    // When tabId is not supplied, target remains tab-policy
    const defaultRes = (await catalogue.dispatch(
      'theme.debug_bundle',
      {},
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    )) as { target: BrowserTarget };
    assert.strictEqual(defaultRes.target.tabId, 'tab-policy');

    // When tabId is specified as tab-product, target.tabId is synchronized to tab-product
    const customRes = (await catalogue.dispatch(
      'theme.debug_bundle',
      { tabId: 'tab-product' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    )) as { target: BrowserTarget };
    assert.strictEqual(customRes.target.tabId, 'tab-product');
  });

  it('verifies visualCompare resolves selector bounding rect and passes rect to captureScreenshot', async () => {
    let capturedRect: any = undefined;
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '',
      getTabList: () => [{ id: 'tab-live' }, { id: 'tab-comp' }],
      hasTab: (id) => id === 'tab-live' || id === 'tab-comp',
      isTabAllowed: () => true,
      captureScreenshot: async (rect) => {
        capturedRect = rect;
        // 1x1 base64 png
        return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      },
      evalJs: async (expr) => {
        if (typeof expr === 'string' && expr.includes('getBoundingClientRect')) {
          return { x: 100, y: 200, width: 300, height: 400 };
        }
        return null;
      },
    };

    const port = new BrowserControlPort(mockHost);
    const target: BrowserTarget = {
      tabId: 'tab-live',
      browserEpoch: 1,
      documentGeneration: 1,
      runtimeId: 'rt-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
    };

    // Run visual compare with selector (in pure Node.js without Electron runtime, computePixelDiff rejects on nativeImage)
    await assert.rejects(
      async () => port.visualCompare(
        target,
        'run-1',
        'att-1',
        {
          comparisonTabId: 'tab-comp',
          selector: '.toda-catalogue-block',
        }
      ),
      (err: any) => err.code === 'CAPABILITY_NOT_FOUND' && err.message.includes('nativeImage')
    );
    assert.ok(capturedRect);
    assert.strictEqual(capturedRect.x, 100);
    assert.strictEqual(capturedRect.y, 200);
    assert.strictEqual(capturedRect.width, 300);
    assert.strictEqual(capturedRect.height, 400);
  });
});
