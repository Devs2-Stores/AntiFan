import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserTarget, CapabilityRequestContext, CapabilityError } from '../../src/shared/control-plane-contracts';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { AnnotationManager } from '../../src/main/bridge/annotation-manager';
import { CockpitPort, CockpitHostPort, CockpitQaState } from '../../src/main/tools/cockpit-port';
import {
  getScope,
  mutateScope,
  setScopeCas,
  isProvisionalChecklistScope,
} from '../../src/main/qa/theme-checklist-store';
import { checklistScope, workspaceTag, type ThemeChecklistItem } from '../../src/shared/theme-checklist';

import { ThemeQaWorkflow, type ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import { VisualSettleReceipt } from '../../src/main/verification/capture-settle';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { BrokenAssetScanner } from '../../src/main/qa/scanners/broken-asset-scanner';
import { ServerCrashScanner } from '../../src/main/qa/scanners/server-crash-scanner';
describe('Theme QA MCP Capabilities', () => {
  const defaultOptions = {
    runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
    projectId: 'project-12345678901234567890',
    workspaceId: 'workspace-12345678901234567890',
    runtimeId: 'binding-12345678901234567890',
  };

  const makeBoundBrowser = (liveUrl?: string) =>
    new BrowserControlPort({
      getTabList: () => [{ id: 'tab-1', url: liveUrl }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => Buffer.from('png').toString('base64'),
      evalJs: async () => null,
    });

  const makeBoundContext = (): CapabilityRequestContext => {
    const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
    return { lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() }, leaseToken: 'token-1', projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
  };

  /** Reads back the receipt from DISK — never from in-memory state. */
  const readSoleReceipt = (root: string): Record<string, unknown> => {
    const receiptsDir = path.join(root, '.antifan', 'qa-receipts');
    const files = fs.readdirSync(receiptsDir).filter((name) => name.endsWith('.json'));
    assert.strictEqual(files.length, 1, `expected exactly 1 receipt in ${receiptsDir}, found ${files.length}`);
    return JSON.parse(fs.readFileSync(path.join(receiptsDir, files[0] as string), 'utf8'));
  };

  const layoutScript = LayoutOverflowEngine.getBrowserScanScript('active');
  const liquidScript = LiquidErrorScanner.getBrowserScanScript();
  const assetScript = BrokenAssetScanner.getBrowserScanScript();
  const serverCrashScript = ServerCrashScanner.getBrowserScanScript();

  const createMockWorkflowPorts = (overrides?: {
    settleCapture?: (target: BrowserTarget) => Promise<VisualSettleReceipt>;
    eval?: (target: BrowserTarget, script: string) => Promise<unknown>;
  }): ThemeQaWorkflowPorts => {
    let currentGen = 1;
    const browserObj: Record<string, unknown> = {
      dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
      screenshot: async () => ({
        artifactRef: { id: 'art-screenshot', kind: 'screenshot' },
        envelope: {},
      }),
      eval: overrides?.eval ?? (async (_target: BrowserTarget, script: string) => {
        if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX')) {
          return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
        }
        if (script === liquidScript || script.includes('ERROR_PATTERNS')) {
          return { hasErrors: false, errors: [], scannedElementsCount: 20 };
        }
        if (script === assetScript || script.includes('naturalWidth') || script.includes('img.decode')) {
          return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
        }
        if (script.includes('HS-') || script.includes('violations') || script.includes('sapo') || script.includes('haravan') || script.includes('evaluateHtml')) {
          return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
        }
        if (script === serverCrashScript || script.includes('crash') || script.includes('ServerCrashScanner')) {
          return { hasCrash: false, errorsCount: 0, findings: [] };
        }
        return {};
      }),
      diagnostics: () => ({ console: [], failures: [] }),
      listTabs: () => [{ id: 'tab-1', url: 'https://store.example.com' }],
      getDocumentGeneration: () => currentGen,
      settleCapture: overrides?.settleCapture ?? (async () => ({
        settleComplete: true,
        gates: { network: true, fonts: true, images: true, dom: true },
        timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 },
        brokenImages: [],
      })),
    };

    return {
      browser: browserObj as unknown as ThemeQaWorkflowPorts['browser'],
      artifacts: {
        stage: (item: { kind: string; data: Buffer | string }) => ({
          id: `art-${item.kind}`,
          kind: item.kind,
          bytes: typeof item.data === 'string' ? Buffer.byteLength(item.data) : item.data.length,
          createdAt: Date.now(),
        }),
        readBytesById: () => ({ data: Buffer.from('<html><body><main>Clean</main></body></html>') }),
      } as unknown as ThemeQaWorkflowPorts['artifacts'],
      reload: async (target: BrowserTarget) => {
        currentGen++;
        return {
          reloaded: true,
          target: { ...target, documentGeneration: currentGen },
        };
      },
      fsQuiescenceMs: 0,
    };
  };

  it('registers theme.qa_validate and theme.debug_bundle with aliases', () => {
    const catalogue = new CapabilityCatalogue(defaultOptions);
    const browser = new BrowserControlPort({
      getTabList: () => [{ id: 'tab-1' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html><body><div>Test</div></body></html>',
      captureScreenshot: async () => Buffer.from('png').toString('base64'),
      evalJs: async () => null,
    });
    registerBrowserCapabilities(catalogue, browser);

    const tools = catalogue.list({ grant: 'read' });
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes('theme.qa_validate'));
    assert.ok(toolNames.includes('theme.debug_bundle'));
    assert.ok(toolNames.includes('antifan_theme_qa_validate'));
    assert.ok(toolNames.includes('antifan_theme_debug_bundle'));
  });

  it('executes theme.debug_bundle with hierarchy and passive cart telemetry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-debug-'));
    const catalogue = new CapabilityCatalogue(defaultOptions);
    const browser = new BrowserControlPort({
      getTabList: () => [{ id: 'tab-1' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html data-template="product"><body><section data-section-id="main-product" data-section-type="product"></section></body></html>',
      captureScreenshot: async () => Buffer.from('png').toString('base64'),
      evalJs: async (expression) => {
        if (expression.includes('data-template')) return { template: 'product', sections: [{ id: 'main-product', type: 'product', tag: 'section' }] };
        if (expression.includes('performance.getEntriesByType')) return { observedRequests: [{ url: 'https://shop.myshopify.com/cart.js', method: 'GET' }], forms: [], contracts: { add: false, change: false, read: true } };
        return { hasOverflow: false, deltaX: 0, culprits: [] };
      },
    });
    registerBrowserCapabilities(catalogue, browser);
    const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
    const context: CapabilityRequestContext = { lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() }, leaseToken: 'token-1', projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
    const result = await catalogue.dispatch('theme.debug_bundle', { tabId: 'tab-1' }, context) as any;
    assert.strictEqual(result.templateHierarchy.template, 'product');
    assert.strictEqual(result.templateHierarchy.sections[0].id, 'main-product');
    assert.strictEqual(result.cartTelemetry.contracts.read, true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes optional multiBreakpoint through the authoritative Theme QA workflow', async () => {
    const catalogue = new CapabilityCatalogue(defaultOptions);
    let requestedMultiBreakpoint: boolean | undefined;
    const workflow = { validate: async (input: any) => { requestedMultiBreakpoint = input.multiBreakpoint; return { ok: true }; } } as any;
    const browser = new BrowserControlPort({ getTabList: () => [{ id: 'tab-1' }], navigate: () => true, reload: () => true, getDom: async () => '<html></html>', captureScreenshot: async () => Buffer.from('png').toString('base64'), evalJs: async () => null });
    registerBrowserCapabilities(catalogue, browser, workflow);
    const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
    const context: CapabilityRequestContext = { lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() }, leaseToken: 'token-1', projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
    await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', multiBreakpoint: true }, context);
    assert.strictEqual(requestedMultiBreakpoint, true);
  });

  describe('workspace QA receipt emitted on every terminal branch', () => {
    it('writes a QA_PASSED receipt when the workflow resolves green', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-pass-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = { validate: async () => ({ summary: { passed: true, criticalCount: 0 } }) } as any;
        registerBrowserCapabilities(catalogue, makeBoundBrowser('https://shop.example.com/products/demo'), workflow, () => root);

        await catalogue.dispatch(
          'theme.qa_validate',
          { tabId: 'tab-1', workspaceRoot: root, annotationId: 'annotation-pass', expectedUrl: 'https://shop.example.com/products/demo' },
          makeBoundContext()
        );

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_PASSED');
        assert.strictEqual(receipt.receiptVersion, '1.1');
        assert.strictEqual(receipt.annotationId, 'annotation-pass');
        assert.strictEqual(receipt.passed, true);
        assert.strictEqual(receipt.criticalCount, 0);
        assert.strictEqual(receipt.errorCode, null);
        assert.strictEqual(receipt.errorMessage, null);
        assert.strictEqual(receipt.observedUrl, 'https://shop.example.com/products/demo');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('writes a QA_FAILED receipt when the workflow resolves red', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-fail-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = { validate: async () => ({ summary: { passed: false, criticalCount: 2 } }) } as any;
        registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);

        await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_FAILED');
        assert.strictEqual(receipt.passed, false);
        assert.strictEqual(receipt.criticalCount, 2);
        assert.strictEqual(receipt.errorCode, null);
        assert.strictEqual(receipt.errorMessage, null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('writes a QA_INCONCLUSIVE receipt when the workflow resolves INCONCLUSIVE with no critical finding', async () => {
      // Degraded evidence (settle gaps, missing capability) is not a failure: the
      // QA gate keeps itself armed on QA_FAILED only, so writing FAILED here would
      // pin the gate on every degraded capture and loop the agent on re-validation.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-inconclusive-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = { validate: async () => ({ summary: { passed: false, criticalCount: 0, verdict: 'INCONCLUSIVE' }, execution: 'DEGRADED' }) } as unknown as ThemeQaWorkflow;
        registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);

        await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_INCONCLUSIVE');
        assert.strictEqual(receipt.execution, 'DEGRADED', 'Receipt must mirror workflow execution status');
        assert.strictEqual(receipt.passed, false);
        assert.strictEqual(receipt.criticalCount, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('serializes on-disk receipt fields from real ThemeQaWorkflow execution', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-real-workflow-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const ports = createMockWorkflowPorts();
        const workflow = new ThemeQaWorkflow(ports);
        registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com'), workflow, () => root);

        await catalogue.dispatch(
          'theme.qa_validate',
          {
            tabId: 'tab-1',
            workspaceRoot: root,
            viewports: {
              desktop: { mismatchPercent: 0.5, passed: true },
              tablet: { mismatchPercent: 1.0, passed: true },
              mobile: { mismatchPercent: 1.5, passed: true },
            },
          },
          makeBoundContext()
        );

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_PASSED');
        assert.strictEqual(receipt.execution, 'COMPLETED');
        assert.strictEqual(receipt.passed, true);
        assert.strictEqual(receipt.criticalCount, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('serializes on-disk receipt fields from real ThemeQaWorkflow execution with settle gaps', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-real-degraded-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const ports = createMockWorkflowPorts({
          settleCapture: async () => ({
            settleComplete: false,
            gates: { network: false, fonts: true, images: false, dom: true },
            timingsMs: { network: 5000, fonts: 100, images: 5000, dom: 5, total: 5000 },
            brokenImages: [],
            layoutStable: true,
          }),
        });
        const workflow = new ThemeQaWorkflow(ports);
        registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com'), workflow, () => root);

        await catalogue.dispatch(
          'theme.qa_validate',
          {
            tabId: 'tab-1',
            workspaceRoot: root,
            viewports: {
              desktop: { mismatchPercent: 0.5, passed: true },
              tablet: { mismatchPercent: 1.0, passed: true },
              mobile: { mismatchPercent: 1.5, passed: true },
            },
          },
          makeBoundContext()
        );

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_INCONCLUSIVE');
        assert.strictEqual(receipt.execution, 'DEGRADED');
        assert.strictEqual(receipt.passed, false);
        assert.strictEqual(receipt.criticalCount, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('keeps a QA_FAILED receipt when an INCONCLUSIVE run still carries critical findings', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-inconclusive-critical-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = { validate: async () => ({ summary: { passed: false, criticalCount: 1, verdict: 'INCONCLUSIVE' } }) } as any;
        registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);

        await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_FAILED');
        assert.strictEqual(receipt.criticalCount, 1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('still rejects AND persists a QA_INCONCLUSIVE receipt when the workflow throws (P0 regression guard)', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-throw-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = {
          validate: async () => {
            throw new Error('CAPTURE_TIMEOUT: simulated');
          },
        } as any;
        registerBrowserCapabilities(catalogue, makeBoundBrowser('https://shop.example.com/products/demo'), workflow, () => root);

        await assert.rejects(
          () => catalogue.dispatch(
            'theme.qa_validate',
            { tabId: 'tab-1', workspaceRoot: root, annotationId: 'annotation-throw', expectedUrl: 'https://shop.example.com/products/demo' },
            makeBoundContext()
          ),
          /CAPTURE_TIMEOUT: simulated/
        );

        // The receipt must exist even though the call failed: the external gate lists
        // this directory and deadlocks forever when a failing run writes nothing.
        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_INCONCLUSIVE');
        assert.strictEqual(receipt.receiptVersion, '1.1');
        assert.ok(typeof receipt.errorCode === 'string' && receipt.errorCode.length > 0, 'errorCode must be a non-empty string');
        assert.ok(typeof receipt.errorMessage === 'string' && receipt.errorMessage.length > 0, 'errorMessage must be a non-empty string');
        assert.match(String(receipt.errorCode), /CAPTURE_TIMEOUT/);
        assert.match(String(receipt.errorMessage), /CAPTURE_TIMEOUT/);
        assert.strictEqual(receipt.passed, null);
        assert.strictEqual(receipt.criticalCount, null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('writes a receipt for the pre-flight route gate failure and keeps the route-gate error code', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-route-'));
      try {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        const workflow = { validate: async () => ({ summary: { passed: true, criticalCount: 0 } }) } as any;
        registerBrowserCapabilities(catalogue, makeBoundBrowser('https://shop.example.com/products/demo'), workflow, () => root);

        await assert.rejects(
          () => catalogue.dispatch(
            'theme.qa_validate',
            { tabId: 'tab-1', workspaceRoot: root, expectedUrl: 'https://other-host.example.com/products/demo' },
            makeBoundContext()
          ),
          (err: any) => {
            // The route gate's own error code must survive the restructure unchanged.
            assert.strictEqual(err?.code, 'URL_HOST_MISMATCH');
            assert.match(String(err?.message), /Theme QA route gate failed/);
            return true;
          }
        );

        const receipt = readSoleReceipt(root);
        assert.strictEqual(receipt.verdict, 'QA_INCONCLUSIVE');
        assert.strictEqual(receipt.errorCode, 'URL_HOST_MISMATCH');
        assert.match(String(receipt.errorMessage), /Theme QA route gate failed/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('pre-creates .antifan/qa-receipts/ when a workspace is annotation-bound', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipts-prebind-'));
      try {
        const receiptsDir = path.join(root, '.antifan', 'qa-receipts');
        assert.strictEqual(fs.existsSync(receiptsDir), false, 'fresh temp workspace must not already have the receipts dir');

        const result = await AnnotationManager.getInstance().processAnnotationPayload({
          workspaceDir: root,
          annotationId: 'annotation-prebind',
          userComment: 'QA receipts dir pre-creation probe',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(fs.existsSync(receiptsDir), true, 'annotation binding must pre-create .antifan/qa-receipts/');
        assert.deepStrictEqual(fs.readdirSync(receiptsDir), []);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('layout overflow measurement gate', () => {
    const realOverflow = {
      viewport: { name: 'active', width: 1440, height: 900 },
      measured: true,
      hasOverflow: true,
      deltaX: 120,
      scrollWidth: 1560,
      clientWidth: 1440,
      culprits: [{ selector: 'div#wide', tagName: 'div', deltaX: 120 }],
    };
    const unmeasuredOverflow = {
      viewport: { name: 'active', width: 1440, height: 900 },
      measured: false,
      unmeasuredReason: 'the scanned tab has no laid-out CSS viewport (documentElement.clientWidth=0, window.innerWidth=1440); horizontal overflow was not measured',
      hasOverflow: false,
      deltaX: 0,
      scrollWidth: 5000,
      clientWidth: 1440,
      culprits: [],
    };

    const scriptedHost = (overflowPayload: unknown, collapsedSurface = false) => {
      const state = { overflowEvalCalls: 0 };
      const host: BrowserHostPort = {
        getTabList: () => [{ id: 'tab-1', url: 'https://shop.example.com/' }],
        navigate: () => true,
        reload: () => true,
        getDom: async () => '<html><body><main>Storefront</main></body></html>',
        captureScreenshot: async () => Buffer.from('png').toString('base64'),
        evalJs: async (expression: string) => {
          if (expression.includes('rawDeltaX') || expression.includes('deadband')) {
            state.overflowEvalCalls++;
            return overflowPayload;
          }
          if (expression.includes('data-template')) return { template: 'product', sections: [] };
          if (expression.includes('performance.getEntriesByType')) return { observedRequests: [], forms: [], contracts: { add: false, change: false, read: true } };
          return {};
        },
      };
      if (collapsedSurface) {
        host.readRenderSurface = async () => ({ vw: 0, vh: 0, layoutWidth: 0, layoutHeight: 0, dpr: 1, scrollX: 0, scrollY: 0, docH: 0, readyState: 'complete', hidden: false });
      }
      return { host, state };
    };

    const dispatchBundle = async (host: BrowserHostPort): Promise<{ overflow: { measured: boolean; unmeasuredReason?: string; hasOverflow: boolean; deltaX: number; culprits: unknown[] }; evidenceGaps: string[] }> => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, new BrowserControlPort(host));
      return (await catalogue.dispatch('theme.debug_bundle', { tabId: 'tab-1' }, makeBoundContext())) as {
        overflow: { measured: boolean; unmeasuredReason?: string; hasOverflow: boolean; deltaX: number; culprits: unknown[] };
        evidenceGaps: string[];
      };
    };

    it('never reports an overflow for a tab whose surface measured 0x0, and never evaluates the scan there', async () => {
      const { host, state } = scriptedHost({ ...realOverflow, viewport: { name: 'active', width: 0, height: 0 }, deltaX: 5000, scrollWidth: 5000, clientWidth: 0 }, true);
      const bundle = await dispatchBundle(host);

      assert.strictEqual(state.overflowEvalCalls, 0, 'An unmeasurable surface must be refused before the scan runs');
      assert.strictEqual(bundle.overflow.measured, false);
      assert.strictEqual(bundle.overflow.hasOverflow, false, 'A refused surface must not surface as an overflow finding');
      assert.strictEqual(bundle.overflow.deltaX, 0);
      assert.strictEqual(bundle.overflow.culprits.length, 0);
      assert.ok(
        bundle.evidenceGaps.some((gap) => gap.includes('Layout overflow not measured') && gap.includes('no laid-out surface')),
        `expected a render-surface evidence gap, got ${JSON.stringify(bundle.evidenceGaps)}`
      );
    });

    it('turns the scan unmeasured marker into an evidence gap, and still reports a measured overflow', async () => {
      const unmeasuredBundle = await dispatchBundle(scriptedHost(unmeasuredOverflow).host);
      assert.strictEqual(unmeasuredBundle.overflow.measured, false);
      assert.strictEqual(unmeasuredBundle.overflow.hasOverflow, false);
      assert.strictEqual(unmeasuredBundle.overflow.culprits.length, 0);
      assert.strictEqual(unmeasuredBundle.overflow.unmeasuredReason, unmeasuredOverflow.unmeasuredReason);
      assert.ok(
        unmeasuredBundle.evidenceGaps.some((gap) => gap.includes('Layout overflow not measured') && gap.includes('no laid-out CSS viewport')),
        `expected the scan reason in the gaps, got ${JSON.stringify(unmeasuredBundle.evidenceGaps)}`
      );

      const measuredBundle = await dispatchBundle(scriptedHost(realOverflow).host);
      assert.strictEqual(measuredBundle.overflow.measured, true);
      assert.strictEqual(measuredBundle.overflow.hasOverflow, true);
      assert.strictEqual(measuredBundle.overflow.deltaX, 120);
      assert.strictEqual(measuredBundle.overflow.culprits.length, 1);
      assert.deepStrictEqual(measuredBundle.evidenceGaps, [], 'A real measurement adds no evidence gap');
    });

    it('withholds a legacy payload that carries no positive viewport width', async () => {
      const bundle = await dispatchBundle(scriptedHost({ hasOverflow: true, deltaX: 5000, scrollWidth: 5000, culprits: [{ selector: 'div#wide' }] }).host);

      assert.strictEqual(bundle.overflow.measured, false);
      assert.strictEqual(bundle.overflow.hasOverflow, false);
      assert.strictEqual(bundle.overflow.culprits.length, 0);
      assert.strictEqual(bundle.evidenceGaps.length, 1);
      assert.ok(bundle.evidenceGaps[0]?.includes('no usable viewport measurement'));
    });
  });
  describe('theme.cockpit_* capabilities', () => {
    type Fixture = {
      catalogue: CapabilityCatalogue;
      navigations: Array<{ tabId: string; url: string }>;
      qaCalls: Array<{ tabId: string; workspaceRoot?: string }>;
      scope: string;
      root: string;
    };
    type CockpitListResult = {
      scope: string;
      isProvisional: boolean;
      total: number;
      done: number;
      items: ThemeChecklistItem[];
    };
    type CockpitMarkResult = { item: ThemeChecklistItem; updatedAt: number; scope: string; isProvisional: boolean };
    type CockpitScanResult = { ok: boolean; workspaceRoot: string; scope: string; isProvisional: boolean };

    // A CockpitHostPort backed by the real checklist store on a tmp root: a
    // capability-level round-trip therefore proves the persisted file, not a
    // mocked echo.
    const makeCockpitFixture = (liveUrl: string, options?: { tabAlive?: boolean; navResult?: boolean }): Fixture => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cockpit-'));
      const navigations: Fixture['navigations'] = [];
      const qaCalls: Fixture['qaCalls'] = [];
      const qaState: CockpitQaState = { status: 'pass', issueCount: 0, updatedAt: 1 };
      const host: CockpitHostPort = {
        hasTab: (tabId) => tabId === 'tab-1' && options?.tabAlive !== false,
        getTabUrl: (tabId) => (tabId === 'tab-1' ? liveUrl : ''),
        resolveTabWorkspaceRoot: () => root,
        navigateAndWait: async (tabId, url) => {
          navigations.push({ tabId, url });
          // Configurable outcome: a false result is a real navigation failure
          // (timeout/abort), which cockpit_scan must refuse — not scan anyway.
          return options?.navResult !== false;
        },
        runThemeQa: async (tabId, qaOptions) => {
          qaCalls.push({ tabId, workspaceRoot: qaOptions?.workspaceRoot });
          return { ok: true, report: { summary: { passed: true } } };
        },
        getThemeQaState: () => qaState,
        checklistLoad: (_tabId, input) => {
          const snap = getScope(input.workspaceRoot, input.scope);
          return {
            scope: input.scope,
            workspaceRoot: input.workspaceRoot,
            items: snap.items,
            updatedAt: snap.updatedAt,
            existed: snap.existed,
            migrated: snap.migrated,
            isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
          };
        },
        checklistMutate: (_tabId, input) => ({
          ...mutateScope(input.workspaceRoot, input.scope, input.op),
          scope: input.scope,
          workspaceRoot: input.workspaceRoot,
          isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
        }),
        checklistSave: (_tabId, input) => {
          const result = setScopeCas(input.workspaceRoot, input.scope, input.items, input.baseUpdatedAt);
          return {
            ok: !result.conflict,
            scope: input.scope,
            workspaceRoot: input.workspaceRoot,
            items: result.items,
            updatedAt: result.updatedAt,
            conflict: result.conflict,
            isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
          };
        },
      };
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(liveUrl), undefined, undefined, undefined, undefined, new CockpitPort(host));
      const scope = checklistScope(new URL(liveUrl).origin, workspaceTag(root));
      return { catalogue, navigations, qaCalls, scope, root };
    };

    const writeContext = (): CapabilityRequestContext => ({ ...makeBoundContext(), grant: 'write' });

    it('registers all eight canonical theme.cockpit_* tools and their antifan_* aliases', () => {
      const { catalogue, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        for (const name of ['list', 'mark', 'mark_page', 'add_item', 'remove_item', 'scan', 'findings', 'report']) {
          assert.ok(catalogue.has(`theme.cockpit_${name}`), `missing theme.cockpit_${name}`);
          assert.ok(catalogue.has(`antifan_cockpit_${name}`), `missing antifan_cockpit_${name}`);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('cockpit_mark round-trips through the on-disk checklist scope', async () => {
      const { catalogue, scope, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        const before = await catalogue.dispatch('theme.cockpit_list', {}, makeBoundContext()) as CockpitListResult;
        assert.strictEqual(before.scope, scope);
        assert.strictEqual(before.isProvisional, false);
        assert.strictEqual(before.total, 44);
        assert.strictEqual(before.items.find((it) => it.id === 'hom-01')?.done, false);

        const marked = await catalogue.dispatch('theme.cockpit_mark', { itemId: 'hom-01', done: true, note: 'verified' }, writeContext()) as CockpitMarkResult;
        assert.strictEqual(marked.item.id, 'hom-01');
        assert.strictEqual(marked.item.done, true);
        assert.strictEqual(marked.item.note, 'verified');

        const stored = getScope(root, scope);
        assert.strictEqual(stored.existed, true);
        assert.strictEqual(stored.items.find((it) => it.id === 'hom-01')?.done, true);
        assert.strictEqual(stored.items.find((it) => it.id === 'hom-01')?.note, 'verified');

        // The antifan_ alias must reach the same canonical op.
        const unmarked = await catalogue.dispatch('antifan_cockpit_mark', { itemId: 'hom-01', done: false }, writeContext()) as CockpitMarkResult;
        assert.strictEqual(unmarked.item.done, false);
        assert.strictEqual(getScope(root, scope).items.find((it) => it.id === 'hom-01')?.done, false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses an explicit scope that re-derives unequal with SCOPE_MISMATCH', async () => {
      const { catalogue, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_mark', { itemId: 'hom-01', done: true, scope: 'https://other.example.com@elsewhere' }, writeContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'SCOPE_MISMATCH'
        );
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_list', { scope: 'https://other.example.com@elsewhere' }, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'SCOPE_MISMATCH'
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses cockpit_mark_page for a page outside PAGE_DEFS and the loaded scope', async () => {
      const { catalogue, scope, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_mark_page', { page: 'nope', done: true }, writeContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
        );
        // A page the scope actually carries does toggle: mark_page on 'home'
        // must flip every home item in the persisted file.
        const result = await catalogue.dispatch('theme.cockpit_mark_page', { page: 'home', done: true }, writeContext()) as { toggled: number };
        assert.ok(result.toggled > 0);
        assert.ok(getScope(root, scope).items.filter((it) => it.page === 'home').every((it) => it.done));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('cockpit_scan runs QA on the bound tab with the confined workspace root', async () => {
      const { catalogue, qaCalls, navigations, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        const result = await catalogue.dispatch(
          'theme.cockpit_scan',
          { page: 'home', workspaceRoot: path.join(root, '..', 'elsewhere-escape') },
          makeBoundContext()
        ) as CockpitScanResult;
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.workspaceRoot, root, 'workspaceRoot outside the bound root must fall back, not escape');
        assert.strictEqual(qaCalls.length, 1);
        assert.strictEqual(qaCalls[0]!.tabId, 'tab-1', 'QA must run on the bound tab, never the ambient active tab');
        assert.strictEqual(qaCalls[0]!.workspaceRoot, root);
        // Bound tab is already on the resolved '/' route → no pre-navigation.
        assert.strictEqual(navigations.length, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('cockpit_scan navigates the bound tab to the page route it is not already on', async () => {
      const { catalogue, qaCalls, navigations, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        await catalogue.dispatch('theme.cockpit_scan', { page: 'cart' }, makeBoundContext());
        assert.deepStrictEqual(navigations, [{ tabId: 'tab-1', url: 'https://shop.example.com/cart' }]);
        assert.strictEqual(qaCalls.length, 1);
        assert.strictEqual(qaCalls[0]!.tabId, 'tab-1');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects cockpit_scan with NAVIGATION_FAILED when the bound tab never reaches the route', async () => {
      // navigateAndWait returning false means the tab never settled on the
      // page's route; scanning anyway would report findings for the stale URL
      // under the requested page's name. The QA run must not be attempted.
      const { catalogue, qaCalls, navigations, root } = makeCockpitFixture('https://shop.example.com/', { navResult: false });
      try {
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_scan', { page: 'cart' }, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'NAVIGATION_FAILED'
        );
        assert.deepStrictEqual(navigations, [{ tabId: 'tab-1', url: 'https://shop.example.com/cart' }], 'the navigation was attempted');
        assert.strictEqual(qaCalls.length, 0, 'no QA run happens against the stale page');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses cockpit_scan for product when the bound tab is not on a PDP', async () => {
      const { catalogue, root } = makeCockpitFixture('https://shop.example.com/');
      try {
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_scan', { page: 'product' }, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED'
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('propagates TARGET_REQUIRED when the bound tab owns no live window', async () => {
      const { catalogue, root } = makeCockpitFixture('https://shop.example.com/', { tabAlive: false });
      try {
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_list', {}, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED'
        );
        await assert.rejects(
          () => catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED'
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
