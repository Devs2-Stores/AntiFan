import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserTarget, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { AnnotationManager } from '../../src/main/bridge/annotation-manager';

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
});
