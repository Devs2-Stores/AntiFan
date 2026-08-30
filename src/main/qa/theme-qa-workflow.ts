import { ArtifactRef, BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from '../tools/browser-control-port';
import { WorkspaceFilePort } from '../tools/workspace-file-port';
import { ArtifactStore } from '../tools/artifact-store';
import { PlatformDetector, PlatformDetectionResult, EcommercePlatform } from './scanners/platform-detector';
import { LiquidErrorScanner, LiquidScanResult, LiquidErrorFinding } from './scanners/liquid-error-scanner';
import { BrokenAssetScanner, BrokenAssetScanResult, BrokenAssetFinding } from './scanners/broken-asset-scanner';
import { LayoutOverflowEngine, ViewportOverflowResult } from './scanners/layout-overflow-engine';
import { HsGateRules, HsEvaluationResult, HsRuleViolation } from './rules/hs-gate-rules';
import { classifyDiagnostics, computeOrigin, DiagnosticsInput, DiagnosticIssue, THEME_ASSET_HOSTS } from './diagnostics-filter';

export interface ThemeQaChecklist {
  layout: boolean;
  responsive: boolean;
  overflow: boolean;
  interactions: boolean;
  diagnostics: boolean;
  liquidClean?: boolean;
  assetsValid?: boolean;
  hsCompliant?: boolean;
}

export interface ThemeQaDetailedFindings {
  platform: PlatformDetectionResult;
  liquid: LiquidScanResult;
  overflow: ViewportOverflowResult;
  assets: BrokenAssetScanResult;
  hsRules: HsEvaluationResult;
  /** Critical diagnostics từ shared filter (console first-party/theme-asset
   *  level >= 3, network Chromium âm trừ -3 của first-party/theme-asset,
   *  isMainFrame failure). */
  diagnosticIssues: DiagnosticIssue[];
  /** Diagnostics third-party chỉ cảnh báo — không fail gate. */
  diagnosticWarnings: DiagnosticIssue[];
  preReloadDiagnostics?: {
    criticalIssues: DiagnosticIssue[];
    warnings: DiagnosticIssue[];
  };
}
export interface ThemeQaSummary {
  passed: boolean;
  totalIssues: number;
  criticalCount: number;
}
export interface ThemeQaReport {
  runId: string;
  attemptId: string;
  workspaceId: string;
  target: BrowserTarget;
  summary: ThemeQaSummary;
  checklist: ThemeQaChecklist & { liquidClean: boolean; assetsValid: boolean; hsCompliant: boolean };
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
function rethrowTargetLifecycleError(error: unknown): void {
  if (
    error instanceof CapabilityError &&
    (error.code === 'TARGET_REQUIRED' || error.code === 'TARGET_STALE' || error.code === 'TARGET_MISMATCH')
  ) {
    throw error;
  }
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
    enabledChecks?: Partial<Record<keyof ThemeQaChecklist, boolean>>;
    multiBreakpoint?: boolean;
    signal?: AbortSignal;
  }): Promise<ThemeQaReport> {
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }
    this.assertOwnership(input.target);

    // SNAPSHOT diagnostics tại ĐẦU validate, trước MỌI await (Red Team Finding
    // 11): đọc muộn ở bước 5.5 race với navigation clear (phase 1 clear đồng
    // bộ tại did-start-navigation). browser.diagnostics trả mảng copy sẵn nên
    // snapshot an toàn; host không hỗ trợ diagnostics → rỗng, không fail.
    let preReloadDiagnostics: DiagnosticsInput = { console: [], failures: [] };
    try {
      const raw = this.ports.browser.diagnostics(input.target.tabId);
      preReloadDiagnostics = {
        console: Array.isArray(raw.console) ? (raw.console as DiagnosticsInput['console']) : [],
        failures: Array.isArray(raw.failures) ? (raw.failures as DiagnosticsInput['failures']) : [],
      };
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // Host without diagnostics support — classification runs on empty input
    }
    // Pre-reload context URL dùng cho audit-only classification của snapshot trước reload
    let preReloadContextUrl = '';
    try {
      const tabs = this.ports.browser.listTabs({ target: input.target });
      const tab = Array.isArray(tabs) ? tabs.find((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object' && (t as Record<string, unknown>).id === input.target.tabId)) : undefined;
      if (tab && typeof tab.url === 'string') preReloadContextUrl = tab.url;
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // best-effort
    }

    // 1. Reload to reach load-complete document before inspecting
    const reload = await this.ports.reload(input.target);
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }
    if (!reload || !reload.reloaded || !reload.target) {
      throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not reach a load-complete document');
    }
    const activeTarget = reload.target;

    const checkAborted = () => {
      if (input.signal?.aborted) {
        throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
      }
      const currentGen = this.ports.browser.getDocumentGeneration?.(activeTarget.tabId);
      if (typeof currentGen === 'number' && activeTarget.documentGeneration && currentGen !== activeTarget.documentGeneration) {
        throw new CapabilityError('TARGET_STALE', `Document generation advanced from ${activeTarget.documentGeneration} to ${currentGen}`);
      }
    };
    checkAborted();
    let freshDiagnostics: DiagnosticsInput = { console: [], failures: [] };
    try {
      const raw = this.ports.browser.diagnostics(activeTarget.tabId);
      freshDiagnostics = {
        console: Array.isArray(raw.console) ? (raw.console as DiagnosticsInput['console']) : [],
        failures: Array.isArray(raw.failures) ? (raw.failures as DiagnosticsInput['failures']) : [],
      };
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // Host without diagnostics support — classification runs on empty input
    }

    // Post-reload context URL
    let contextUrl = '';
    try {
      const tabs = this.ports.browser.listTabs({ target: activeTarget });
      const tab = Array.isArray(tabs) ? tabs.find((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object' && (t as Record<string, unknown>).id === activeTarget.tabId)) : undefined;
      if (tab && typeof tab.url === 'string') contextUrl = tab.url;
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // best-effort — entries mới đều mang origin/isFirstParty sẵn
    }

    // 3. Capture evidence from fresh activeTarget
    checkAborted();
    await new Promise((r) => setImmediate(r));
    const evidence = await this.inspect({ ...input, target: activeTarget });
    checkAborted();
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
    // 4. Platform Detection
    const platformResult = PlatformDetector.detect(input.workspaceRoot, undefined, rawHtml);
    const detectedPlatform: EcommercePlatform = platformResult.platform;

    // 5. Liquid Error Scanning (RT-01 isolated script + fallback)
    await new Promise((r) => setImmediate(r));
    let liquidResult: LiquidScanResult = { hasErrors: false, errors: [], scannedElementsCount: 0 };
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, LiquidErrorScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasErrors' in evalRes) {
        liquidResult = evalRes as LiquidScanResult;
      } else if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
      }
    }

    // 6. Layout Overflow Engine (RT-06 sub-pixel deadband & RT-04 container limiting)
    let overflowResult: ViewportOverflowResult = {
      viewport: { name: 'desktop', width: 1440, height: 900 },
      hasOverflow: false,
      deltaX: 0,
      scrollWidth: 1440,
      clientWidth: 1440,
      culprits: [],
    };
    await new Promise((r) => setImmediate(r));
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, LayoutOverflowEngine.getBrowserScanScript('active'));
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasOverflow' in evalRes) {
        overflowResult = evalRes as ViewportOverflowResult;
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // Retain clean fallback
    }
    if (input.multiBreakpoint) {
      try {
        const responsive = await this.ports.browser.responsiveCheck(activeTarget.tabId);
        const breakpoints = responsive && typeof responsive === 'object' ? (responsive as Record<string, unknown>).breakpoints : undefined;
        if (breakpoints && typeof breakpoints === 'object') {
          const overflowBreakpoints = Object.values(breakpoints).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && 'hasHorizontalOverflow' in item));
          const failing = overflowBreakpoints.filter((item) => item.hasHorizontalOverflow === true);
          if (failing.length > 0) {
            const first = failing[0];
            if (!first) throw new Error('Responsive overflow result missing');
            overflowResult = {
              ...overflowResult,
              viewport: {
                name: first.mobile ? 'mobile' : first.width === 820 ? 'tablet' : 'desktop',
                width: typeof first.width === 'number' ? first.width : overflowResult.viewport.width,
                height: typeof first.height === 'number' ? first.height : overflowResult.viewport.height,
              },
              hasOverflow: true,
              deltaX: typeof first.scrollWidth === 'number' && typeof first.clientWidth === 'number' ? Math.max(0, first.scrollWidth - first.clientWidth) : overflowResult.deltaX,
              scrollWidth: typeof first.scrollWidth === 'number' ? first.scrollWidth : overflowResult.scrollWidth,
              clientWidth: typeof first.clientWidth === 'number' ? first.clientWidth : overflowResult.clientWidth,
            };
          }
        }
      } catch (error) {
        rethrowTargetLifecycleError(error);
        // Active viewport result remains authoritative when the optional sweep is unavailable.
      }
    }

    // 7. Broken Asset Telemetry (DOM + CDP Network Correlation)
    let assetResult: BrokenAssetScanResult = {
      hasBrokenAssets: false,
      brokenAssets: [],
      totalImagesScanned: 0,
      totalStylesheetsScanned: 0,
    };
    await new Promise((r) => setImmediate(r));
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, BrokenAssetScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasBrokenAssets' in evalRes) {
        assetResult = evalRes as BrokenAssetScanResult;
      }
      const diagnostics = freshDiagnostics;
      if (diagnostics && Array.isArray(diagnostics.failures) && diagnostics.failures.length > 0) {
        // blocker, GTM, FB Pixel) không được biến thành brokenAssets làm fail
        // gate (Goal 2: third-party chỉ warning). Legacy entries thiếu
        // origin/isFirstParty → computeOrigin fallback theo contextUrl.
        const mappedFailures = diagnostics.failures
          .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
          .filter((f) => {
            if (typeof f.isFirstParty === 'boolean') {
              const origin = typeof f.origin === 'string' ? f.origin : '';
              if (f.isFirstParty) return true;
              return THEME_ASSET_HOSTS.some((host) => origin === host || origin.endsWith(`.${host}`));
            }
            const rawUrl = typeof f.validatedURL === 'string' ? f.validatedURL : '';
            const originInfo = computeOrigin(rawUrl, contextUrl);
            return originInfo.isFirstParty || THEME_ASSET_HOSTS.some((host) => originInfo.origin === host || originInfo.origin.endsWith(`.${host}`));
          })
          .map((f) => ({
            url: typeof f.validatedURL === 'string' ? f.validatedURL : '',
            status: typeof f.errorCode === 'number' && f.errorCode > 0 ? f.errorCode : undefined,
            errorText: typeof f.errorDescription === 'string' ? f.errorDescription : undefined,
          }))
          .filter((f) => f.url.length > 0);
        assetResult = BrokenAssetScanner.correlateWithNetworkFailures(assetResult, mappedFailures);
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      // Retain clean fallback
    }

    // 8. Shared diagnostics classification (trust gate): quyết định critical vs
    // warning theo origin + error class (module dùng chung với fallback path).
    // URL tab làm context cho entries thiếu origin/isFirstParty (legacy).
    const diagResult = classifyDiagnostics(freshDiagnostics, contextUrl);
    const diagnosticIssues: DiagnosticIssue[] = diagResult.criticalIssues;
    const diagnosticWarnings: DiagnosticIssue[] = diagResult.warnings;

    // Pre-reload diagnostics classification (audit-only evidence)
    const preReloadDiagResult = classifyDiagnostics(preReloadDiagnostics, preReloadContextUrl);
    const preReloadCritical: DiagnosticIssue[] = preReloadDiagResult.criticalIssues;
    const preReloadWarningsList: DiagnosticIssue[] = preReloadDiagResult.warnings;
    const preReloadDiagnosticsObj =
      preReloadCritical.length > 0 || preReloadWarningsList.length > 0
        ? {
            criticalIssues: preReloadCritical,
            warnings: preReloadWarningsList,
          }
        : undefined;

    // 9. Platform-scoped HS gate evaluation
    await new Promise((r) => setImmediate(r));
    let hsResult: HsEvaluationResult = { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, HsGateRules.getBrowserEvaluationScript(detectedPlatform));
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'passed' in evalRes) {
        hsResult = evalRes as HsEvaluationResult;
      } else if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
      }
    }

    // 10. Compute authoritative checklist statuses (owned strictly by the engine).
    const checklist: ThemeQaReport['checklist'] = {
      layout: !overflowResult.hasOverflow,
      responsive: overflowResult.culprits.length === 0,
      overflow: !overflowResult.hasOverflow,
      interactions: hsResult.passed,
      diagnostics: !liquidResult.hasErrors && !assetResult.hasBrokenAssets && diagnosticIssues.length === 0,
      liquidClean: !liquidResult.hasErrors,
      assetsValid: !assetResult.hasBrokenAssets,
      hsCompliant: hsResult.passed,
    };

    // Filter which checks participate in the overall summary verdict if caller specified enabled checks
    const activeChecklistEntries: boolean[] = [];
    const enabled = input.enabledChecks;
    if (enabled) {
      if (enabled.layout !== false) activeChecklistEntries.push(checklist.layout);
      if (enabled.responsive !== false) activeChecklistEntries.push(checklist.responsive);
      if (enabled.overflow !== false) activeChecklistEntries.push(checklist.overflow);
      if (enabled.interactions !== false) activeChecklistEntries.push(checklist.interactions);
      if (enabled.diagnostics !== false) activeChecklistEntries.push(checklist.diagnostics);
      if (enabled.liquidClean !== false) activeChecklistEntries.push(checklist.liquidClean);
      if (enabled.assetsValid !== false) activeChecklistEntries.push(checklist.assetsValid);
      if (enabled.hsCompliant !== false) activeChecklistEntries.push(checklist.hsCompliant);
    } else {
      activeChecklistEntries.push(...Object.values(checklist));
    }

    const totalIssues =
      liquidResult.errors.length +
      overflowResult.culprits.length +
      assetResult.brokenAssets.length +
      hsResult.totalViolations +
      diagnosticIssues.length +
      diagnosticWarnings.length;
    const summary: ThemeQaSummary = {
      passed: activeChecklistEntries.length > 0 ? activeChecklistEntries.every(Boolean) : true,
      totalIssues,
      criticalCount: hsResult.errorsCount + liquidResult.errors.length + diagnosticIssues.length,
    };

    const findings: ThemeQaDetailedFindings = {
      platform: platformResult,
      liquid: liquidResult,
      overflow: overflowResult,
      assets: assetResult,
      hsRules: hsResult,
      diagnosticIssues,
      diagnosticWarnings,
      ...(preReloadDiagnosticsObj ? { preReloadDiagnostics: preReloadDiagnosticsObj } : {}),
    };

    const artifacts: ArtifactRef[] = [];
    for (const item of [evidence.dom, evidence.screenshot]) {
      if (typeof item !== 'string') artifacts.push(item);
    }
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }
    // 11. Generate PII-sanitized report JSON (RT-02 mitigation)
    const reportDataRaw = JSON.stringify(
      {
        runId: input.runId,
        attemptId: input.attemptId,
        workspaceId: activeTarget.workspaceId,
        target: activeTarget,
        summary,
        checklist,
        findings,
        artifactIds: artifacts.map((item) => item.id),
        createdAt: Date.now(),
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
      workspaceId: activeTarget.workspaceId,
      target: activeTarget,
      summary,
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
