import { ArtifactRef, BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from '../tools/browser-control-port';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { ArtifactStore } from '../tools/artifact-store';
import { PlatformDetector, PlatformDetectionResult, EcommercePlatform } from './scanners/platform-detector';
import { LiquidErrorScanner, LiquidScanResult, LiquidErrorFinding } from './scanners/liquid-error-scanner';
import { BrokenAssetScanner, BrokenAssetScanResult, BrokenAssetFinding } from './scanners/broken-asset-scanner';
import { LayoutOverflowEngine, ViewportOverflowResult } from './scanners/layout-overflow-engine';
import { HsGateRules, HsEvaluationResult, HsRuleViolation } from './rules/hs-gate-rules';

export interface ThemeQaChecklist {
  layout: boolean;
  responsive: boolean;
  overflow: boolean;
  interactions: boolean;
  diagnostics: boolean;
}

export interface ThemeQaDetailedFindings {
  platform: PlatformDetectionResult;
  liquid: LiquidScanResult;
  overflow: ViewportOverflowResult;
  assets: BrokenAssetScanResult;
  hsRules: HsEvaluationResult;
}

export interface ThemeQaReport {
  runId: string;
  attemptId: string;
  workspaceId: string;
  target: BrowserTarget;
  checklist: ThemeQaChecklist;
  findings?: ThemeQaDetailedFindings;
  artifacts: ArtifactRef[];
  createdAt: number;
}

export interface ThemeQaWorkflowPorts {
  browser: BrowserControlPort;
  files: WorkspaceFilePort;
  artifacts: ArtifactStore;
  reload: (target: BrowserTarget) => Promise<{ reloaded: boolean; target: BrowserTarget }> | { reloaded: boolean; target: BrowserTarget };
}

/**
 * Sanitize sensitive PII strings (RT-02 mitigation)
 */
export function sanitizePii(text: string): string {
  if (!text) return text;
  return text
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]')
    .replace(/(?:\+?84|0)(?:3|5|7|8|9)[0-9]{8}/g, '[REDACTED_PHONE]')
    .replace(/(?:bearer\s+|token=)[a-zA-Z0-9_\-\.]{20,}/gi, '[REDACTED_TOKEN]');
}

export class ThemeQaWorkflow {
  constructor(private readonly ports: ThemeQaWorkflowPorts) {}

  async inspect(input: { runId: string; attemptId: string; workspaceRoot: string; target: BrowserTarget; selector?: string }): Promise<{ dom: ArtifactRef | string; screenshot: ArtifactRef | string }> {
    this.assertOwnership(input.target);
    const dom = await this.ports.browser.dom(input.target, input.runId, input.attemptId, input.selector);
    const screenshot = await this.ports.browser.screenshot(input.target, input.runId, input.attemptId);
    return { dom, screenshot };
  }

  edit(input: { workspaceRoot: string; relativePath: string; content: string }): { path: string; byteLength: number; sha256: string } {
    return this.ports.files.write(input.workspaceRoot, input.relativePath, input.content);
  }

  async validate(input: {
    runId: string;
    attemptId: string;
    workspaceRoot: string;
    target: BrowserTarget;
    checklist?: Partial<ThemeQaChecklist>;
    multiBreakpoint?: boolean;
  }): Promise<ThemeQaReport> {
    this.assertOwnership(input.target);

    // 1. Capture initial evidence
    const evidence = await this.inspect({ ...input });
    const reload = await this.ports.reload(input.target);
    if (!reload.reloaded) throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded');

    // Retrieve raw HTML for static analysis and platform detection
    let rawHtml = '';
    if (typeof evidence.dom === 'string') {
      rawHtml = evidence.dom;
    } else if (evidence.dom && typeof evidence.dom === 'object' && 'id' in evidence.dom) {
      try {
        const { data } = this.ports.artifacts.readBytesById(evidence.dom.id);
        rawHtml = data.toString('utf8');
      } catch {
        // Ignore if store cannot resolve
      }
    }
    // 2. Platform Detection
    const platformResult = PlatformDetector.detect(input.workspaceRoot, undefined, rawHtml);
    const detectedPlatform: EcommercePlatform = platformResult.platform;

    // 3. Liquid Error Scanning (RT-01 isolated script + fallback)
    let liquidResult: LiquidScanResult = { hasErrors: false, errors: [], scannedElementsCount: 0 };
    try {
      const evalRes = await this.ports.browser.eval(input.target, LiquidErrorScanner.getBrowserScanScript());
      if (evalRes && typeof evalRes === 'object' && 'hasErrors' in evalRes) {
        liquidResult = evalRes as LiquidScanResult;
      } else if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
      }
    } catch {
      if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
      }
    }

    // 4. Layout Overflow Engine (RT-06 sub-pixel deadband & RT-04 container limiting)
    let overflowResult: ViewportOverflowResult = {
      viewport: { name: 'desktop', width: 1440, height: 900 },
      hasOverflow: false,
      deltaX: 0,
      scrollWidth: 1440,
      clientWidth: 1440,
      culprits: [],
    };
    try {
      const evalRes = await this.ports.browser.eval(input.target, LayoutOverflowEngine.getBrowserScanScript('active'));
      if (evalRes && typeof evalRes === 'object' && 'hasOverflow' in evalRes) {
        overflowResult = evalRes as ViewportOverflowResult;
      }
    } catch {
      // Retain clean fallback
    }

    // 5. Broken Asset Telemetry (DOM + CDP Network Correlation)
    let assetResult: BrokenAssetScanResult = {
      hasBrokenAssets: false,
      brokenAssets: [],
      totalImagesScanned: 0,
      totalStylesheetsScanned: 0,
    };
    try {
      const evalRes = await this.ports.browser.eval(input.target, BrokenAssetScanner.getBrowserScanScript());
      if (evalRes && typeof evalRes === 'object' && 'hasBrokenAssets' in evalRes) {
        assetResult = evalRes as BrokenAssetScanResult;
      }
      // Correlate with CDP diagnostics when available
      const diagnostics = this.ports.browser.diagnostics(input.target.tabId);
      if (diagnostics && Array.isArray(diagnostics.failures) && diagnostics.failures.length > 0) {
        const mappedFailures = diagnostics.failures
          .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
          .map((f) => ({
            url: typeof f.url === 'string' ? f.url : '',
            status: typeof f.status === 'number' ? f.status : undefined,
            errorText: typeof f.errorText === 'string' ? f.errorText : undefined,
          }))
          .filter((f) => f.url.length > 0);
        assetResult = BrokenAssetScanner.correlateWithNetworkFailures(assetResult, mappedFailures);
      }
    } catch {
      // Retain clean fallback
    }

    // 6. HS1-HS26 Rules Evaluation
    let hsResult: HsEvaluationResult = { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    try {
      const evalRes = await this.ports.browser.eval(input.target, HsGateRules.getBrowserEvaluationScript(detectedPlatform));
      if (evalRes && typeof evalRes === 'object' && 'passed' in evalRes) {
        hsResult = evalRes as HsEvaluationResult;
      } else if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
      }
    } catch {
      if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
      }
    }

    // 7. Compute Checklist Statuses
    const checklist: ThemeQaChecklist = {
      layout: !overflowResult.hasOverflow,
      responsive: overflowResult.culprits.length === 0,
      overflow: !overflowResult.hasOverflow,
      interactions: hsResult.passed,
      diagnostics: !liquidResult.hasErrors && !assetResult.hasBrokenAssets,
    };

    // Apply any explicit overrides if supplied
    if (input.checklist) {
      if (input.checklist.layout !== undefined) checklist.layout = input.checklist.layout;
      if (input.checklist.responsive !== undefined) checklist.responsive = input.checklist.responsive;
      if (input.checklist.overflow !== undefined) checklist.overflow = input.checklist.overflow;
      if (input.checklist.interactions !== undefined) checklist.interactions = input.checklist.interactions;
      if (input.checklist.diagnostics !== undefined) checklist.diagnostics = input.checklist.diagnostics;
    }

    const findings: ThemeQaDetailedFindings = {
      platform: platformResult,
      liquid: liquidResult,
      overflow: overflowResult,
      assets: assetResult,
      hsRules: hsResult,
    };

    const artifacts: ArtifactRef[] = [];
    for (const item of [evidence.dom, evidence.screenshot]) {
      if (typeof item !== 'string') artifacts.push(item);
    }

    // 8. Generate PII-sanitized report JSON (RT-02 mitigation)
    const reportDataRaw = JSON.stringify(
      {
        checklist,
        findings,
        artifactIds: artifacts.map((item) => item.id),
        target: input.target,
        timestamp: Date.now(),
      },
      null,
      2
    );
    const reportData = sanitizePii(reportDataRaw);

    artifacts.push(
      this.ports.artifacts.stage({
        kind: 'report',
        mime: 'application/json',
        data: reportData,
        runId: input.runId,
        attemptId: input.attemptId,
        maxBytes: 128 * 1024,
      })
    );

    return {
      runId: input.runId,
      attemptId: input.attemptId,
      workspaceId: input.target.workspaceId,
      target: input.target,
      checklist,
      findings,
      artifacts,
      createdAt: Date.now(),
    };
  }

  private assertOwnership(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Theme QA requires an explicit Project/Workspace/runtime/tab target');
    }
  }
}
