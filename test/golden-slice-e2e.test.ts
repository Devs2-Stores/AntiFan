import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import {
  ThemeTaskContext,
  assertValidThemeTaskContext,
} from '../src/shared/theme-task-context';
import {
  SourceMappingResult,
} from '../src/main/browser/theme-source-mapper';
import {
  MatchedStylesResult,
} from '../src/main/browser/css-cascade-analyzer';
import {
  isThemeEvidenceEnvelope,
  ThemeEvidenceEnvelope,
} from '../src/main/tools/theme-evidence-envelope';
import { ThemeProofHelpers } from '../src/main/verification/theme-proof-helpers';
import { VerificationEvaluator } from '../src/main/verification/verification-evaluator';
import {
  VerificationClaim,
  VerificationRecord,
  ProofObligation,
  THEME_METRICS,
} from '../src/main/verification/verification-contract';
import { runCorePurityAudit } from '../scripts/audit-core-purity';
import { CapabilityCatalogue } from '../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../src/main/tools/browser-capabilities';
import {
  BrowserControlPort,
  BrowserHostPort,
} from '../src/main/tools/browser-control-port';
import {
  AuthenticatedCapabilityContext,
  BrowserTarget,
  RuntimeLease,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../src/shared/control-plane-contracts';
import { ReceiptStore } from '../src/main/session/receipt-store';

describe('Phase 5: Golden Slice E2E & Architecture Gate Validation', () => {
  const originalFixtureThemeRoot = path.resolve(
    process.cwd(),
    'test/fixtures/golden-workflow/product-card/theme'
  );
  const fixtureStorefrontHtml = path.resolve(
    process.cwd(),
    'test/fixtures/golden-workflow/product-card/storefront/index.html'
  );

  // Isolated workspace copy for mutation testing
  const tempWorkspaceDir = path.resolve(
    process.cwd(),
    'test/fixtures/golden-workflow/temp-e2e-workspace'
  );
  const tempReceiptFile = path.resolve(
    tempWorkspaceDir,
    'e2e-receipts.jsonl'
  );

  let server: http.Server;
  let serverUrl = '';
  let receiptStore: ReceiptStore;
  let catalogue: CapabilityCatalogue;
  let browserPort: BrowserControlPort;
  let target: BrowserTarget;
  let leaseToken: string;
  let projectId: string;
  let workspaceId: string;
  let runtimeLease: RuntimeLease;
  let capabilityCallCount = 0;

  // Track the generated evidence envelopes across steps
  let sourceMappingEnvelope: ThemeEvidenceEnvelope<SourceMappingResult>;
  let matchedStylesEnvelope: ThemeEvidenceEnvelope<MatchedStylesResult>;
  let responsiveMatrixEnvelope: ThemeEvidenceEnvelope<Record<string, unknown>>;
  let claimIdForGate = '';
  let lastInvocationId = '';
  before(async () => {
    // 1. Prepare isolated workspace directory
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempWorkspaceDir, { recursive: true });

    // Copy original fixture theme files to temp workspace
    const copyRecursive = (src: string, dest: string) => {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };
    copyRecursive(originalFixtureThemeRoot, tempWorkspaceDir);

    // 2. Start local HTTP server serving the static storefront and CSS
    server = http.createServer((req, res) => {
      const reqUrl = req.url || '/';
      if (reqUrl === '/' || reqUrl === '/index.html') {
        const html = fs.readFileSync(fixtureStorefrontHtml, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (reqUrl.includes('component-card.css')) {
        const cssPath = path.join(tempWorkspaceDir, 'assets/component-card.css');
        const css = fs.readFileSync(cssPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(css);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as net.AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}/index.html`;

    // 3. Initialize ReceiptStore with isolated receipt file
    receiptStore = new ReceiptStore({ filePath: tempReceiptFile });

    // 4. Initialize CapabilityCatalogue & Control Port
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    runtimeLease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    leaseToken = runtimeLease.token;

    catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: runtimeLease.runtimeId,
      hostEpoch: 1,
      resolveTabId: (id) => (id === 'tab-e2e-1' ? 'tab-e2e-1' : undefined),
      isTabAllowed: () => true,
      getDocumentGeneration: () => 1,
    });

    // Mock host backed by real fixture DOM data and CSS rules
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => fs.readFileSync(fixtureStorefrontHtml, 'utf8'),
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-e2e-1' }],
      evalJs: async () => ({
        classes: ['product-card', 'card__badge', 'badge--sale'],
        attributes: {
          'data-card-id': 'card-101',
          'data-section-id': 'featured-collection',
        },
        tagName: 'span',
      }),
      getMatchedStylesForNode: async () => ({
        matchedCSSRules: [
          {
            rule: {
              selectorList: { selectors: [{ text: '.card' }] },
              style: {
                cssProperties: [
                  { name: 'font-size', value: '14px' },
                  { name: 'margin-top', value: '16px' },
                ],
                range: { startLine: 1, startColumn: 0, endLine: 4, endColumn: 1 },
              },
              origin: 'regular',
              styleSheetId: 'sheet-card-css',
              sourceUrl: 'assets/component-card.css',
            },
          },
          {
            rule: {
              selectorList: { selectors: [{ text: '.card__badge' }] },
              style: {
                cssProperties: [
                  { name: 'font-size', value: '10px' },
                  { name: 'padding', value: '2px 6px' },
                  { name: 'background-color', value: 'var(--card-badge-bg)' },
                ],
                range: { startLine: 10, startColumn: 0, endLine: 14, endColumn: 1 },
              },
              origin: 'regular',
              styleSheetId: 'sheet-card-css',
              sourceUrl: 'assets/component-card.css',
            },
          },
        ],
      }),
      runResponsiveCheck: async () => ({
        ok: true,
        tabId: 'tab-e2e-1',
        breakpoints: {
          'mobile-small': { width: 320, documentOverflowX: false, targetOverflowX: false },
          'mobile-standard': { width: 375, documentOverflowX: false, targetOverflowX: false },
          'tablet-portrait': { width: 768, documentOverflowX: false, targetOverflowX: false },
          'tablet-landscape': { width: 1024, documentOverflowX: false, targetOverflowX: false },
          'desktop-laptop': { width: 1440, documentOverflowX: false, targetOverflowX: false },
        },
      }),
      inspectStyles: async () => ({
        'font-size': '10px',
        'padding': '2px 6px',
        'background-color': '#e53e3e',
      }),
    };

    browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(
      catalogue,
      browserPort,
      undefined,
      () => tempWorkspaceDir,
      receiptStore,
      () => ({ 'sheet-card-css': 'assets/component-card.css' })
    );

    target = {
      tabId: 'tab-e2e-1',
      browserEpoch: 1,
      documentGeneration: 1,
      runtimeId: runtimeLease.runtimeId,
      projectId,
      workspaceId,
    };
  });

  after(async () => {
    // Teardown local server
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Clean up temp workspace
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
  });

  async function dispatchMonitoredCapability<T>(capabilityName: string, params: Record<string, unknown>, grant: 'read' | 'write' = 'write'): Promise<T> {
    capabilityCallCount++;
    lastInvocationId = makeControlPlaneId('invocation');
    const context: AuthenticatedCapabilityContext = {
      attachmentId: makeControlPlaneId('binding'),
      runId: 'run-golden-slice',
      attemptId: 'attempt-golden-slice',
      projectId,
      workspaceId,
      backendId: 'golden-integration',
      hostEpoch: 1,
      invocationId: lastInvocationId,
      lease: runtimeLease,
      leaseToken,
      browserTarget: target,
      grant,
    };
    return await catalogue.dispatch(capabilityName, params, context) as T;
  }

  it('Step 1: Local HTTP server serves storefront fixture & ThemeTaskContext initializes', async () => {
    // Verify HTTP server is serving fixture
    const resp = await fetch(serverUrl);
    assert.strictEqual(resp.status, 200);
    const html = await resp.text();
    assert.ok(html.includes('data-template="collection"'));
    assert.ok(html.includes('product-card'));

    // Initialize and assert ThemeTaskContext contract
    const context: ThemeTaskContext = {
      taskId: 'task-golden-slice-e2e',
      url: serverUrl,
      targetRef: '@e1',
      workspaceRoot: tempWorkspaceDir,
      timestamp: Date.now(),
    };

    assert.doesNotThrow(() => assertValidThemeTaskContext(context));
    assert.strictEqual(context.taskId, 'task-golden-slice-e2e');
    assert.strictEqual(context.url, serverUrl);
    assert.strictEqual(context.targetRef, '@e1');
  });

  it('Step 2: Dispatches anti.inspect.styles and anti.inspect.matched_styles via CapabilityCatalogue', async () => {
    // 1. Query computed styles via anti.inspect.styles
    const computedStyles = await dispatchMonitoredCapability<Record<string, string>>(
      'anti.inspect.styles',
      { selector: '.card__badge', tabId: 'tab-e2e-1' }
    );
    assert.strictEqual(computedStyles['font-size'], '10px');
    assert.strictEqual(computedStyles['padding'], '2px 6px');

    // 2. Query causality-aware matched rules via anti.inspect.matched_styles
    const rawRes = await dispatchMonitoredCapability(
      'anti.inspect.matched_styles',
      {
        selector: '.card__badge',
        tabId: 'tab-e2e-1',
        stylesheetUrlMap: { 'sheet-card-css': 'assets/component-card.css' },
      }
    );

    assert.ok(isThemeEvidenceEnvelope(rawRes));
    matchedStylesEnvelope = rawRes as unknown as ThemeEvidenceEnvelope<MatchedStylesResult>;

    assert.strictEqual(matchedStylesEnvelope.success, true);
    assert.ok(matchedStylesEnvelope.data);
    assert.strictEqual(matchedStylesEnvelope.signals.hasMatchedRules, true);

    // Verify ACTIVE rule is isolated from OVERRIDDEN rule
    const activeRule = matchedStylesEnvelope.data.activeRules.find((r) => r.property === 'font-size');
    assert.ok(activeRule);
    assert.strictEqual(activeRule.value, '10px');
    assert.strictEqual(activeRule.selector, '.card__badge');
    assert.strictEqual(activeRule.status, 'ACTIVE');

    const overriddenRule = matchedStylesEnvelope.data.overriddenRules.find((r) => r.property === 'font-size');
    assert.ok(overriddenRule);
    assert.strictEqual(overriddenRule.value, '14px');
    assert.strictEqual(overriddenRule.selector, '.card');
    assert.strictEqual(overriddenRule.status, 'OVERRIDDEN');
  });

  it('Step 3: Dispatches anti.theme.resolve_element via CapabilityCatalogue and maps to snippets/card-product.liquid', async () => {
    const rawRes = await dispatchMonitoredCapability(
      'anti.theme.resolve_element',
      { selector: '.product-card', tabId: 'tab-e2e-1', workspaceRoot: tempWorkspaceDir }
    );

    assert.ok(isThemeEvidenceEnvelope(rawRes));
    sourceMappingEnvelope = rawRes as unknown as ThemeEvidenceEnvelope<SourceMappingResult>;

    assert.strictEqual(sourceMappingEnvelope.success, true);
    assert.strictEqual(sourceMappingEnvelope.evidenceQuality, 'HIGH');
    assert.strictEqual(sourceMappingEnvelope.signals.markupClassMatch, true);
    assert.strictEqual(sourceMappingEnvelope.signals.renderCallMatch, true);
    assert.strictEqual(sourceMappingEnvelope.signals.referencedBySection, true);

    const primaryCandidate = sourceMappingEnvelope.data?.primaryCandidate;
    assert.ok(primaryCandidate);
    assert.strictEqual(primaryCandidate.file, 'snippets/card-product.liquid');
    assert.strictEqual(primaryCandidate.type, 'snippet');
    assert.strictEqual(primaryCandidate.confidence, 'HIGH');
  });

  it('Step 4: Executes simulated mutation on fixture workspace file on disk', () => {
    const cssFilePath = path.join(tempWorkspaceDir, 'assets/component-card.css');
    assert.ok(fs.existsSync(cssFilePath), 'Target CSS file must exist in workspace');

    const initialContent = fs.readFileSync(cssFilePath, 'utf8');
    const fixPatch = '\n/* [E2E Simulated Fix]: Prevent responsive text overflow on card badge */\n.card__badge { max-width: 100%; word-break: break-word; }\n';
    fs.writeFileSync(cssFilePath, initialContent + fixPatch, 'utf8');

    const updatedContent = fs.readFileSync(cssFilePath, 'utf8');
    assert.ok(updatedContent.includes('[E2E Simulated Fix]'), 'Mutation must be persisted to workspace disk');
    assert.ok(updatedContent.includes('max-width: 100%'));
  });

  it('Step 5: Dispatches anti.inspect.responsive_matrix via CapabilityCatalogue across all 5 breakpoints', async () => {
    const rawRes = await dispatchMonitoredCapability(
      'anti.inspect.responsive_matrix',
      { selector: '.card', tabId: 'tab-e2e-1' }
    );

    assert.ok(isThemeEvidenceEnvelope(rawRes));
    responsiveMatrixEnvelope = rawRes as unknown as ThemeEvidenceEnvelope<Record<string, unknown>>;

    assert.strictEqual(responsiveMatrixEnvelope.success, true);
    assert.strictEqual(responsiveMatrixEnvelope.evidenceQuality, 'HIGH');
    assert.strictEqual(responsiveMatrixEnvelope.signals.allBreakpointsTested, true);
    assert.strictEqual(responsiveMatrixEnvelope.signals.hasTargetOverflow, false);
    assert.strictEqual(responsiveMatrixEnvelope.signals.hasDocOverflow, false);
  });

  it('Step 6: Evaluates claim via anti.verification.verify_claim dispatch and writes Authoritative Receipt to ReceiptStore', async () => {
    assert.ok(sourceMappingEnvelope, 'Source mapping envelope must be available');
    assert.ok(matchedStylesEnvelope, 'Matched styles envelope must be available');
    assert.ok(responsiveMatrixEnvelope, 'Responsive matrix envelope must be available');

    // 1. Bridge all envelopes into a canonical EvidenceSampleBundle and evaluate
    const bundle = ThemeProofHelpers.createEvidenceBundle({
      tabId: 'tab-e2e-1',
      documentGeneration: 1,
      sourceMappingEnvelope,
      matchedStylesEnvelope,
      responsiveMatrixEnvelope,
    });
    assert.strictEqual(bundle.samples.length, 5);

    // 2. Dispatch anti.verification.record_claim via CapabilityCatalogue
    const obligations = ThemeProofHelpers.buildThemeProofObligations({
      requireStrongPass: true,
      criticalNoTargetOverflow: true,
    });

    const recordClaimRes = await dispatchMonitoredCapability<VerificationRecord>(
      'anti.verification.record_claim',
      {
        claim: 'Product card badge styling conforms to theme specification with zero responsive overflow',
        category: 'CUSTOM',
        tabId: 'tab-e2e-1',
        selector: '.card__badge',
        proofObligations: obligations,
      }
    );
    assert.ok(recordClaimRes.id);
    assert.strictEqual(recordClaimRes.verdict, 'UNVERIFIED');
    const recordedClaimId = recordClaimRes.id;
    claimIdForGate = recordedClaimId;
    // 3. Dispatch anti.verification.verify_claim via CapabilityCatalogue
    const verifyClaimRes = await dispatchMonitoredCapability<{ id: string; verdict: string; proofProfile: { completeness: string; violations: unknown[]; passedMetricsCount: number } }>(
      'anti.verification.verify_claim',
      {
        claimId: recordedClaimId,
      }
    );

    assert.strictEqual(verifyClaimRes.verdict, 'VERIFIED');
    assert.strictEqual(verifyClaimRes.proofProfile.completeness, 'FULL');
    assert.strictEqual(verifyClaimRes.proofProfile.violations.length, 0);

    // 4. Also evaluate claim directly via VerificationEvaluator and verify parity
    const evaluationResult = VerificationEvaluator.evaluate(recordClaimRes, bundle);
    assert.strictEqual(evaluationResult.verdict, 'VERIFIED');
    assert.strictEqual(evaluationResult.proofProfile.completeness, 'FULL');
    assert.strictEqual(evaluationResult.proofProfile.violations.length, 0);

    // 5. Verify that anti.verification.verify_claim persisted a receipt under invocation identity
    const persistedReceipt = receiptStore.findByCommand(lastInvocationId);
    assert.ok(persistedReceipt, 'ReceiptStore must contain the authoritative receipt created by verify_claim');
    assert.ok(persistedReceipt.id.startsWith('receipt-'));
    assert.strictEqual(persistedReceipt.state, 'completed');
    assert.strictEqual(persistedReceipt.deliveryState, 'accepted-exact');
    assert.strictEqual(persistedReceipt.binding.commandId, lastInvocationId);
    assert.strictEqual(persistedReceipt.binding.canonicalWorkspace, tempWorkspaceDir);
    claimIdForGate = lastInvocationId;
  });

  it('Step 7: Validates all 5 Architecture Gate Criteria for P1 Capability Unlock', () => {
    // Criterion 1: Source Mapping Candidate Accuracy
    assert.ok(sourceMappingEnvelope);
    assert.strictEqual(sourceMappingEnvelope.data?.primaryCandidate?.file, 'snippets/card-product.liquid');
    assert.strictEqual(sourceMappingEnvelope.data?.primaryCandidate?.confidence, 'HIGH');
    assert.strictEqual(sourceMappingEnvelope.signals.markupClassMatch, true);
    assert.strictEqual(sourceMappingEnvelope.signals.renderCallMatch, true);

    // Criterion 2: CSS Causality Precision
    assert.ok(matchedStylesEnvelope);
    const hasActive = matchedStylesEnvelope.data?.activeRules.some((r) => r.status === 'ACTIVE');
    const hasOverridden = matchedStylesEnvelope.data?.overriddenRules.some((r) => r.status === 'OVERRIDDEN');
    assert.strictEqual(hasActive, true, 'Must isolate ACTIVE declarations');
    assert.strictEqual(hasOverridden, true, 'Must isolate OVERRIDDEN declarations');
    assert.ok(
      matchedStylesEnvelope.data?.definitionOfDone === 'PASS' ||
      matchedStylesEnvelope.data?.definitionOfDone === 'STRONG PASS',
      'Must achieve at least PASS DoD'
    );

    // Criterion 3: Responsive Matrix Disambiguation
    assert.ok(responsiveMatrixEnvelope);
    assert.strictEqual(responsiveMatrixEnvelope.signals.allBreakpointsTested, true);
    assert.strictEqual(responsiveMatrixEnvelope.signals.hasTargetOverflow, false);
    assert.strictEqual(responsiveMatrixEnvelope.signals.hasDocOverflow, false);
    const matrixSamples = ThemeProofHelpers.responsiveMatrixToSamples(responsiveMatrixEnvelope);
    assert.strictEqual(matrixSamples.length, 2);
    assert.strictEqual(matrixSamples[0]?.metric, THEME_METRICS.RESPONSIVE_NO_TARGET_OVERFLOW);
    assert.strictEqual(matrixSamples[1]?.metric, THEME_METRICS.RESPONSIVE_NO_DOC_OVERFLOW);
    // Criterion 4: Verification receipt is keyed by invocation, not claim identity
    const receiptOnDisk = receiptStore.findByCommand(claimIdForGate);
    assert.ok(receiptOnDisk, 'Receipt must exist in ReceiptStore');
    assert.strictEqual(receiptOnDisk.state, 'completed');
    assert.strictEqual(receiptOnDisk.deliveryState, 'accepted-exact');
    assert.strictEqual(receiptOnDisk.binding.canonicalWorkspace, tempWorkspaceDir);

    // Criterion 5: Tool Cost & Round-Trip Invariance (Calls <= 6, Zero Blind Grep)
    assert.ok(
      capabilityCallCount > 0 && capabilityCallCount <= 6,
      `Total capability round-trips must be <= 6 (was ${capabilityCallCount})`
    );

    // Confirm Core Purity invariant: Zero product-specific fixture bleed in src/main/
    const purityAudit = runCorePurityAudit();
    assert.strictEqual(purityAudit.passed, true, 'Core purity must be 100% clean');
  });
});
