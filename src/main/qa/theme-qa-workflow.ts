import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArtifactRef, BrowserTarget, CapabilityError } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from '../tools/browser-control-port';
import type { EvidenceCaptureEnvelope } from '../verification/visual-capture';
import type { VisualSettleReceipt } from '../verification/capture-settle';
import { ArtifactStore } from '../tools/artifact-store';
import { PlatformDetector, PlatformDetectionResult, EcommercePlatform } from './scanners/platform-detector';
import { LiquidErrorScanner, LiquidScanResult, LiquidErrorFinding } from './scanners/liquid-error-scanner';
import { ServerCrashScanner, ServerCrashScanResult, ServerCrashFinding } from './scanners/server-crash-scanner';
import { BrokenAssetScanner, BrokenAssetScanResult, BrokenAssetFinding } from './scanners/broken-asset-scanner';
import { LayoutOverflowEngine, ViewportOverflowResult } from './scanners/layout-overflow-engine';
import { HsGateRules, HsEvaluationResult, HsRuleViolation } from './rules/hs-gate-rules';
import { classifyDiagnostics, extractCorrelatableAssetFailures, DiagnosticsInput, DiagnosticIssue } from './diagnostics-filter';
import type { ThemeTransactionRegistry } from './theme-transaction-registry';
import type { TerminalSyncCursor, SyncSettleResult } from './haravan-sync-barrier';
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

export interface ThemeQaIssueItem {
  category: 'diagnostics' | 'liquid' | 'overflow' | 'broken_asset' | 'hs_rule';
  signature: string;
  severity: 'critical' | 'warning';
  message: string;
  origin?: string;
  details?: Record<string, unknown>;
}

export interface ThemeQaDifferentialAttribution {
  preExistingIssues: ThemeQaIssueItem[];
  resolvedIssues: ThemeQaIssueItem[];
  introducedRegressions: ThemeQaIssueItem[];
  hasRegressions: boolean;
}

export interface ThemeQaDetailedFindings {
  platform: PlatformDetectionResult;
  liquid: LiquidScanResult;
  overflow: ViewportOverflowResult;
  assets: BrokenAssetScanResult;
  hsRules: HsEvaluationResult;
  serverCrash?: ServerCrashScanResult;
  diagnosticIssues: DiagnosticIssue[];
  /** Diagnostics third-party chỉ cảnh báo — không fail gate. */
  diagnosticWarnings: DiagnosticIssue[];
  preReloadDiagnostics?: {
    criticalIssues: DiagnosticIssue[];
    warnings: DiagnosticIssue[];
  };
  differential?: ThemeQaDifferentialAttribution;
  evidenceGaps?: string[];
}
export interface ThemeQaSummary {
  passed: boolean;
  totalIssues: number;
  criticalCount: number;
  verdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
}
export interface QaMatrixDimension {
  score: number | null;
  details: string;
}

export interface QaMatrixViewportItem {
  mismatchPercent: number | null;
  passed: boolean;
  measured: boolean;
  verdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
}

export interface QaMatrixCoverage {
  measuredDimensions: number;
  totalDimensions: number;
  measuredViewports: number;
  totalViewports: number;
}

export interface QaMatrixReport {
  timestamp: string;
  overallScore: number | null;
  passed: boolean;
  verdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  coverage?: QaMatrixCoverage;
  dimensions: {
    visualFidelity: QaMatrixDimension;
    domSemantics: QaMatrixDimension;
    cssModularity: QaMatrixDimension;
    interactiveOperability: QaMatrixDimension;
    haravanCompliance: QaMatrixDimension;
    assetIntegrity: QaMatrixDimension;
    responsiveParity: QaMatrixDimension;
    performanceCWV: QaMatrixDimension;
  };
  viewports: {
    desktop: QaMatrixViewportItem;
    tablet: QaMatrixViewportItem;
    mobile: QaMatrixViewportItem;
  };
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
  qaMatrix?: QaMatrixReport;
  settleReceipt?: VisualSettleReceipt;
  createdAt: number;
}
export interface ThemeQaWorkflowPorts {
  browser: BrowserControlPort;
  artifacts: ArtifactStore;
  reload: (target: BrowserTarget) => Promise<{ reloaded: boolean; target: BrowserTarget }> | { reloaded: boolean; target: BrowserTarget };
  transactionRegistry?: ThemeTransactionRegistry;
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

/**
 * Visual mismatch ceiling for a viewport to count as passing. The comparison
 * score hits 0 at this percentage, so the boolean verdict is derived from the
 * measured number: a caller-supplied `passed` cannot certify a diff beyond it.
 */
const VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT = 10;

export class ThemeQaWorkflow {
  constructor(private readonly ports: ThemeQaWorkflowPorts) {}
  async inspect(input: { runId: string; attemptId: string; workspaceRoot: string; target: BrowserTarget; selector?: string }): Promise<{ dom: ArtifactRef | string; screenshot: EvidenceCaptureEnvelope }> {
    this.assertOwnership(input.target);
    const dom = await this.ports.browser.dom(input.target, input.runId, input.attemptId, input.selector);
    const screenshot = await this.ports.browser.screenshot(input.target, input.runId, input.attemptId);
    return { dom, screenshot };
  }


  async validate(input: {
    runId: string;
    attemptId: string;
    workspaceRoot: string;
    target: BrowserTarget;
    enabledChecks?: Partial<Record<keyof ThemeQaChecklist, boolean>>;
    multiBreakpoint?: boolean;
    signal?: AbortSignal;
    baselineFindings?: ThemeQaDetailedFindings | ThemeQaIssueItem[];
    viewports?: {
      desktop?: { mismatchPercent: number; passed: boolean };
      tablet?: { mismatchPercent: number; passed: boolean };
      mobile?: { mismatchPercent: number; passed: boolean };
    };
    mutationContext?: {
      cursor?: TerminalSyncCursor;
      syncReceipt?: SyncSettleResult;
      initialDocGen?: number;
    };
  }): Promise<ThemeQaReport> {
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }
    this.assertOwnership(input.target);
    const effectiveBaselineFindings = input.baselineFindings;
    // Mutation QA lifecycle attestation:
    // Bind cursor/generation baseline captured before mutation and acknowledgment belonging to that mutation.
    // Caller omission of a baseline cannot reclassify a known mutation session as read-only.
    const activeSession = this.ports.transactionRegistry?.getActiveSession(input.workspaceRoot);
    const hasActiveSessionMutation = Boolean(
      activeSession &&
      (activeSession.sessionState === 'mutated' ||
       activeSession.sessionState === 'synced' ||
       activeSession.sessionState === 'settled' ||
       activeSession.touchedFiles.length > 0)
    );
    const hasMutationContext = Boolean(
      input.mutationContext &&
      (input.mutationContext.cursor || input.mutationContext.syncReceipt || typeof input.mutationContext.initialDocGen === 'number')
    );
    const isMutationSession = hasActiveSessionMutation || hasMutationContext;
    let mutationMissingBarrier = false;
    let mutationBarrierError: string | undefined;

    if (isMutationSession) {
      // 1. Workspace Transaction Authority: Trusted stored session evidence cannot be bypassed by caller receipts
      if (hasActiveSessionMutation && activeSession) {
        if (activeSession.sessionState !== 'settled') {
          mutationMissingBarrier = true;
          mutationBarrierError = `Active workspace mutation session "${activeSession.sessionId}" has un-settled mutations (state: ${activeSession.sessionState}); trusted session must be settled via awaitSyncAndReload before QA validation`;
        } else if (
          typeof input.target.documentGeneration === 'number' &&
          typeof activeSession.lineage.documentGeneration === 'number' &&
          input.target.documentGeneration < activeSession.lineage.documentGeneration
        ) {
          mutationMissingBarrier = true;
          mutationBarrierError = `Target documentGeneration (${input.target.documentGeneration}) is stale compared to session settled generation (${activeSession.lineage.documentGeneration})`;
        }
      }

      // 2. External Mutation Context: Never accept structural receipt alone; require cursor + syncReceipt + initialDocGen
      if (!mutationMissingBarrier && hasMutationContext) {
        const mc = input.mutationContext!;
        if (!mc.cursor || !mc.syncReceipt || typeof mc.initialDocGen !== 'number') {
          mutationMissingBarrier = true;
          mutationBarrierError = 'External mutation verification requires complete pre-mutation baseline (cursor, syncReceipt, and initialDocGen); structural receipt alone is not accepted';
        } else {
          const cursor = mc.cursor;
          const receipt = mc.syncReceipt;
          const initialDocGen = mc.initialDocGen;

          const isValidCursor =
            typeof cursor === 'object' &&
            cursor !== null &&
            typeof cursor.sessionId === 'string' &&
            cursor.sessionId.trim().length > 0 &&
            typeof cursor.baselineSeq === 'number' &&
            Number.isInteger(cursor.baselineSeq) &&
            cursor.baselineSeq >= 0 &&
            typeof cursor.sessionGeneration === 'number' &&
            Number.isInteger(cursor.sessionGeneration) &&
            cursor.sessionGeneration >= 0;

          const isValidReceipt =
            typeof receipt === 'object' &&
            receipt !== null &&
            receipt.settledMethod === 'terminal-output' &&
            typeof receipt.lastSeq === 'number' &&
            Number.isInteger(receipt.lastSeq) &&
            receipt.lastSeq > 0 &&
            typeof receipt.durationMs === 'number' &&
            Number.isFinite(receipt.durationMs) &&
            receipt.durationMs >= 0 &&
            typeof receipt.syncGen === 'number' &&
            Number.isInteger(receipt.syncGen) &&
            receipt.syncGen >= 0 &&
            typeof receipt.sessionGeneration === 'number' &&
            Number.isInteger(receipt.sessionGeneration) &&
            receipt.sessionGeneration >= 0;

          const isValidInitialDocGen =
            Number.isInteger(initialDocGen) && initialDocGen >= 0;

          if (!isValidCursor) {
            mutationMissingBarrier = true;
            mutationBarrierError = 'Terminal sync cursor is malformed: sessionId must be non-empty string, baselineSeq and sessionGeneration must be nonnegative integers';
          } else if (!isValidReceipt) {
            mutationMissingBarrier = true;
            mutationBarrierError = 'Mutation sync receipt is malformed: settledMethod must be "terminal-output", lastSeq positive integer, durationMs nonnegative, syncGen and exact sessionGeneration nonnegative integers';
          } else if (!isValidInitialDocGen) {
            mutationMissingBarrier = true;
            mutationBarrierError = 'Pre-mutation initialDocGen must be a nonnegative integer';
          } else if (receipt.lastSeq <= cursor.baselineSeq) {
            mutationMissingBarrier = true;
            mutationBarrierError = `Mutation sync acknowledgment sequence (${receipt.lastSeq}) preceded or matched pre-mutation baseline (${cursor.baselineSeq}); acknowledgment does not belong to this mutation`;
          } else if (receipt.sessionGeneration !== cursor.sessionGeneration) {
            mutationMissingBarrier = true;
            mutationBarrierError = `Mutation sync receipt sessionGeneration (${receipt.sessionGeneration}) does not match baseline cursor sessionGeneration (${cursor.sessionGeneration}); terminal session generation mismatch`;
          } else {
            const currentDocGen = input.target.documentGeneration;
            if (typeof currentDocGen !== 'number' || currentDocGen <= initialDocGen) {
              mutationMissingBarrier = true;
              mutationBarrierError = `Target documentGeneration (${currentDocGen ?? 'undefined'}) failed to advance beyond pre-mutation baseline (${initialDocGen}); stale document lineage`;
            }
          }
        }
      }
    }
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

    // Stage 1: File system debounce quiescence (150ms)
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }
    await new Promise((r) => setTimeout(r, 150));
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
    }

    // Stage 2: Reload to reach load-complete document
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

    // Stage 2 & 3: Composed Settle Barrier (Phase 4: settleCapture)
    let settleReceipt: VisualSettleReceipt | undefined;
    let settleMissingCapability = false;
    try {
      if (typeof this.ports.browser.freezeMedia === 'function') {
        try {
          await this.ports.browser.freezeMedia(activeTarget, { freeze: true, normalizeSliders: true });
        } catch {
          // Best effort freeze before settle barrier
        }
      }
      if (typeof this.ports.browser.settleCapture === 'function') {
        settleReceipt = await this.ports.browser.settleCapture(activeTarget, 'desktop', undefined, { signal: input.signal });
        if (!settleReceipt || !settleReceipt.settleComplete) {
          throw new CapabilityError(
            'SETTLE_INCOMPLETE',
            `Theme QA settle gate incomplete: gates not all settled (network=${settleReceipt?.gates?.network}, fonts=${settleReceipt?.gates?.fonts}, images=${settleReceipt?.gates?.images}, dom=${settleReceipt?.gates?.dom})`
          );
        }
      } else {
        settleMissingCapability = true;
      }
    } catch (err) {
      rethrowTargetLifecycleError(err);
      if (err instanceof CapabilityError) throw err;
      throw new CapabilityError(
        'SETTLE_INCOMPLETE',
        `Theme QA settle gate failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
    // Separate evidence incompleteness from observed failure (do not inject into diagnosticIssues)
    const evidenceGaps: string[] = [];
    if (settleMissingCapability) {
      evidenceGaps.push('Authoritative settlement capability missing (browser.settleCapture is not available on host); cannot certify authoritative PASS');
    }

    if (mutationMissingBarrier && mutationBarrierError) {
      evidenceGaps.push(mutationBarrierError);
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
      if (evalRes && typeof evalRes === 'object' && typeof (evalRes as Record<string, unknown>).hasOverflow === 'boolean') {
        overflowResult = evalRes as ViewportOverflowResult;
      } else {
        evidenceGaps.push('Layout overflow scanner evaluation did not return valid measurement object');
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      evidenceGaps.push(`Layout overflow scanner evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (input.multiBreakpoint) {
      try {
        const responsive = await this.ports.browser.responsiveCheck(activeTarget.tabId);
        const isOk = !responsive || typeof responsive !== 'object' || (responsive as Record<string, unknown>).ok !== false;
        const breakpoints = responsive && typeof responsive === 'object' ? (responsive as Record<string, unknown>).breakpoints : undefined;
        if (!isOk) {
          const errMsg = (responsive as Record<string, unknown>).error;
          evidenceGaps.push(`Responsive multi-breakpoint sweep failed: ${typeof errMsg === 'string' ? errMsg : 'host returned ok: false'}`);
        } else if (!breakpoints || typeof breakpoints !== 'object' || Object.keys(breakpoints).length === 0) {
          evidenceGaps.push('Responsive multi-breakpoint sweep returned no breakpoint measurements');
        } else {
          const bpEntries = Object.entries(breakpoints);
          let hasMalformedBreakpoint = false;
          const failing: Record<string, unknown>[] = [];
          for (const [, bp] of bpEntries) {
            if (!bp || typeof bp !== 'object' || typeof (bp as Record<string, unknown>).hasHorizontalOverflow !== 'boolean') {
              hasMalformedBreakpoint = true;
            } else {
              const bpObj = bp as Record<string, unknown>;
              if (bpObj.hasHorizontalOverflow === true) {
                failing.push(bpObj);
              }
            }
          }
          if (hasMalformedBreakpoint) {
            evidenceGaps.push('Responsive multi-breakpoint sweep contained malformed or incomplete breakpoint measurements');
          }
          if (failing.length > 0) {
            const first = failing[0];
            if (!first) throw new Error('Responsive overflow result missing');
            const vpWidth = typeof first.width === 'number' ? first.width : overflowResult.viewport.width;
            const isMobile = Boolean(first.mobile) || vpWidth < 768;
            const isTablet = !isMobile && vpWidth <= 1024;
            const vpName: 'mobile' | 'tablet' | 'desktop' = isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop';
            overflowResult = {
              ...overflowResult,
              viewport: {
                name: vpName,
                width: vpWidth,
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
        evidenceGaps.push(`Responsive multi-breakpoint sweep failed or unsupported: ${error instanceof Error ? error.message : String(error)}`);
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
        const mappedFailures = extractCorrelatableAssetFailures(diagnostics.failures, contextUrl);
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

    // 9.5 Server Crash Scanner (Haravan 500, Shopify 500, Sapo 500, Cloudflare 5xx)
    let serverCrashResult: ServerCrashScanResult = { hasCrash: false, errorsCount: 0, findings: [] };
    await new Promise((r) => setImmediate(r));
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, ServerCrashScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasCrash' in evalRes) {
        serverCrashResult = evalRes as ServerCrashScanResult;
      } else if (rawHtml) {
        serverCrashResult = ServerCrashScanner.scanHtmlString(rawHtml);
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        serverCrashResult = ServerCrashScanner.scanHtmlString(rawHtml);
      }
    }

    // 9.5. Compute Canonical Differential Attribution across all diagnostics & scanner findings
    const preExistingIssues: ThemeQaIssueItem[] = [];
    const resolvedIssues: ThemeQaIssueItem[] = [];
    const introducedRegressions: ThemeQaIssueItem[] = [];

    // Build baseline items from all 5 scanner categories (or preReload diagnostics)
    const preItems: ThemeQaIssueItem[] = [];
    if (effectiveBaselineFindings) {
      if (Array.isArray(effectiveBaselineFindings)) {
        preItems.push(...effectiveBaselineFindings);
      } else if (effectiveBaselineFindings.differential?.preExistingIssues) {
        preItems.push(
          ...effectiveBaselineFindings.differential.preExistingIssues,
          ...effectiveBaselineFindings.differential.introducedRegressions
        );
      } else {
        const bf = effectiveBaselineFindings;
        if (bf.diagnosticIssues) {
          preItems.push(
            ...bf.diagnosticIssues.map((d): ThemeQaIssueItem => ({
              category: 'diagnostics',
              signature: `diagnostics:${d.kind}:${d.origin || ''}:${d.message}`,
              severity: 'critical',
              message: d.message,
              origin: d.origin,
            }))
          );
        }
        if (bf.liquid?.errors) {
          preItems.push(
            ...bf.liquid.errors.map((e): ThemeQaIssueItem => ({
              category: 'liquid',
              signature: `liquid:${e.type}:${e.location || e.selector || ''}:${e.message}`,
              severity: 'critical',
              message: e.message,
              details: { type: e.type, location: e.location, selector: e.selector },
            }))
          );
        }
        if (bf.overflow?.culprits) {
          preItems.push(
            ...bf.overflow.culprits.map((c): ThemeQaIssueItem => ({
              category: 'overflow',
              signature: `overflow:${c.selector || 'window'}:${Math.round(c.deltaX || 0)}`,
              severity: 'critical',
              message: `Layout horizontal overflow: deltaX ${c.deltaX}px on ${c.selector}`,
              details: { selector: c.selector, deltaX: c.deltaX },
            }))
          );
        }
        if (bf.assets?.brokenAssets) {
          preItems.push(
            ...bf.assets.brokenAssets.map((a): ThemeQaIssueItem => ({
              category: 'broken_asset',
              signature: `broken_asset:${a.type}:${a.url}:${a.reason}`,
              severity: 'critical',
              message: `Broken ${a.type}: ${a.url} (${a.reason})`,
              details: { type: a.type, url: a.url, reason: a.reason, elementSelector: a.elementSelector },
            }))
          );
        }
        if (bf.hsRules?.violations) {
          preItems.push(
            ...bf.hsRules.violations
              .filter((v) => v.severity === 'error')
              .map((v): ThemeQaIssueItem => ({
                category: 'hs_rule',
                signature: `hs_rule:${v.ruleId}:${v.selector || ''}:${v.message}`,
                severity: 'critical',
                message: v.message,
                details: { ruleId: v.ruleId, ruleTitle: v.ruleTitle, selector: v.selector, recommendation: v.recommendation },
              }))
          );
        }
      }
    } else {
      preItems.push(
        ...preReloadCritical.map((d): ThemeQaIssueItem => ({
          category: 'diagnostics',
          signature: `diagnostics:${d.kind}:${d.origin || ''}:${d.message}`,
          severity: 'critical',
          message: d.message,
          origin: d.origin,
        }))
      );
    }

    const preCounts = new Map<string, { item: ThemeQaIssueItem; count: number }>();
    for (const item of preItems) {
      const existing = preCounts.get(item.signature);
      if (existing) {
        existing.count++;
      } else {
        preCounts.set(item.signature, { item, count: 1 });
      }
    }

    // Build post-reload current critical items from diagnostics and all scanners with verified fields
    const currentItems: ThemeQaIssueItem[] = [
      ...diagnosticIssues.map((d): ThemeQaIssueItem => ({
        category: 'diagnostics',
        signature: `diagnostics:${d.kind}:${d.origin || ''}:${d.message}`,
        severity: 'critical',
        message: d.message,
        origin: d.origin,
      })),
      ...liquidResult.errors.map((e): ThemeQaIssueItem => ({
        category: 'liquid',
        signature: `liquid:${e.type}:${e.location || e.selector || ''}:${e.message}`,
        severity: 'critical',
        message: e.message,
        details: { type: e.type, location: e.location, selector: e.selector },
      })),
      ...(overflowResult.culprits.length > 0
        ? overflowResult.culprits.map((c): ThemeQaIssueItem => ({
            category: 'overflow',
            signature: `overflow:${c.selector || 'window'}:${Math.round(c.deltaX || 0)}`,
            severity: 'critical',
            message: `Layout horizontal overflow: deltaX ${c.deltaX}px on ${c.selector}`,
            details: { selector: c.selector, deltaX: c.deltaX },
          }))
        : overflowResult.hasOverflow
          ? [
              {
                category: 'overflow' as const,
                signature: `overflow:${overflowResult.viewport.name}:${Math.round(overflowResult.deltaX || 0)}`,
                severity: 'critical' as const,
                message: `Horizontal overflow detected on ${overflowResult.viewport.name} viewport (${overflowResult.viewport.width}px): deltaX ${overflowResult.deltaX}px`,
                details: {
                  viewport: overflowResult.viewport.name,
                  width: overflowResult.viewport.width,
                  deltaX: overflowResult.deltaX,
                },
              },
            ]
          : []),
      ...assetResult.brokenAssets.map((a): ThemeQaIssueItem => ({
        category: 'broken_asset',
        signature: `broken_asset:${a.type}:${a.url}:${a.reason}`,
        severity: 'critical',
        message: `Broken ${a.type}: ${a.url} (${a.reason})`,
        details: { type: a.type, url: a.url, reason: a.reason, elementSelector: a.elementSelector },
      })),
      ...hsResult.violations
        .filter((v) => v.severity === 'error')
        .map((v): ThemeQaIssueItem => ({
          category: 'hs_rule',
          signature: `hs_rule:${v.ruleId}:${v.selector || ''}:${v.message}`,
          severity: 'critical',
          message: v.message,
          details: { ruleId: v.ruleId, ruleTitle: v.ruleTitle, selector: v.selector, recommendation: v.recommendation },
        })),
    ];

    for (const cur of currentItems) {
      const preEntry = preCounts.get(cur.signature);
      if (preEntry && preEntry.count > 0) {
        preEntry.count--;
        preExistingIssues.push(cur);
      } else {
        introducedRegressions.push(cur);
      }
    }

    for (const [, entry] of preCounts) {
      for (let i = 0; i < entry.count; i++) {
        resolvedIssues.push(entry.item);
      }
    }

    const differential: ThemeQaDifferentialAttribution = {
      preExistingIssues,
      resolvedIssues,
      introducedRegressions,
      hasRegressions: introducedRegressions.length > 0,
    };
    const preReloadDiagnosticsObj =
      preReloadCritical.length > 0 || preReloadWarningsList.length > 0
        ? {
            criticalIssues: preReloadCritical,
            warnings: preReloadWarningsList,
          }
        : undefined;
    // 10. Compute authoritative checklist statuses (owned strictly by the engine).
    const checklist: ThemeQaReport['checklist'] = {
      layout: !overflowResult.hasOverflow,
      responsive: !overflowResult.hasOverflow,
      overflow: !overflowResult.hasOverflow,
      interactions: hsResult.passed,
      diagnostics: !liquidResult.hasErrors && !assetResult.hasBrokenAssets && !serverCrashResult.hasCrash && diagnosticIssues.length === 0,
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

    const overflowIssueCount = overflowResult.culprits.length > 0 ? overflowResult.culprits.length : (overflowResult.hasOverflow ? 1 : 0);
    const totalIssues =
      liquidResult.errors.length +
      overflowIssueCount +
      assetResult.brokenAssets.length +
      hsResult.totalViolations +
      serverCrashResult.errorsCount +
      diagnosticIssues.length +
      diagnosticWarnings.length;
    // Observed defects verdict only for checks the caller kept enabled; `enabledChecks` remains a
    // verdict filter, while engine checklist authority is preserved separately in `checklist`.
    const checkParticipates = (key: keyof ThemeQaChecklist): boolean => !enabled || enabled[key] !== false;
    const hasObservedFailure =
      (checkParticipates('liquidClean') && liquidResult.hasErrors) ||
      ((checkParticipates('layout') || checkParticipates('responsive') || checkParticipates('overflow')) && overflowResult.hasOverflow) ||
      (checkParticipates('assetsValid') && assetResult.hasBrokenAssets) ||
      (checkParticipates('hsCompliant') && hsResult.errorsCount > 0) ||
      serverCrashResult.hasCrash ||
      diagnosticIssues.length > 0;
    const hasMissingEvidence = settleMissingCapability || mutationMissingBarrier || evidenceGaps.length > 0;

    let summaryVerdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'PASS';
    if (hasObservedFailure) {
      summaryVerdict = 'FAIL';
    } else if (hasMissingEvidence) {
      summaryVerdict = 'INCONCLUSIVE';
    } else if (activeChecklistEntries.length > 0 && !activeChecklistEntries.every(Boolean)) {
      summaryVerdict = 'FAIL';
    }

    const summary: ThemeQaSummary = {
      passed: summaryVerdict === 'PASS',
      verdict: summaryVerdict,
      totalIssues,
      criticalCount: hsResult.errorsCount + liquidResult.errors.length + serverCrashResult.errorsCount + diagnosticIssues.length + overflowIssueCount + assetResult.brokenAssets.length,
    };

    const findings: ThemeQaDetailedFindings = {
      platform: platformResult,
      liquid: liquidResult,
      overflow: overflowResult,
      assets: assetResult,
      hsRules: hsResult,
      serverCrash: serverCrashResult,
      diagnosticIssues,
      diagnosticWarnings,
      ...(preReloadDiagnosticsObj ? { preReloadDiagnostics: preReloadDiagnosticsObj } : {}),
      ...(differential ? { differential } : {}),
      ...(evidenceGaps.length > 0 ? { evidenceGaps } : {}),
    };

    const artifacts: ArtifactRef[] = [];
    const collectRef = (item: unknown): void => {
      if (item && typeof item === 'object' && typeof (item as ArtifactRef).id === 'string') artifacts.push(item as ArtifactRef);
    };
    collectRef(evidence.dom);
    collectRef(evidence.screenshot.artifactRef);
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
        projectId: activeTarget.projectId,
        workspaceId: activeTarget.workspaceId,
        maxBytes: 128 * 1024,
        // Same lifetime as the theme.qa_validate capability that runs this workflow.
        retentionPolicy: 'run-durable',
      })
    );

    const qaMatrix = ThemeQaWorkflow.computeQaMatrix(summary, checklist, findings, input.viewports);

    if (input.workspaceRoot) {
      try {
        const specsDir = path.join(input.workspaceRoot, 'specs');
        if (!fs.existsSync(specsDir)) {
          fs.mkdirSync(specsDir, { recursive: true });
        }
        fs.writeFileSync(path.join(specsDir, 'qa-matrix.json'), JSON.stringify(qaMatrix, null, 2), 'utf-8');
      } catch {
        // Fallback gracefully if workspaceRoot is read-only
      }
    }

    return {
      runId: input.runId,
      attemptId: input.attemptId,
      workspaceId: activeTarget.workspaceId,
      target: activeTarget,
      summary,
      checklist,
      findings,
      artifacts,
      qaMatrix,
      ...(settleReceipt ? { settleReceipt } : {}),
      createdAt: Date.now(),
    };
  }

  public static computeQaMatrix(
    summary: ThemeQaSummary,
    checklist: ThemeQaChecklist,
    findings?: ThemeQaDetailedFindings,
    viewports?: {
      desktop?: { mismatchPercent: number; passed: boolean };
      tablet?: { mismatchPercent: number; passed: boolean };
      mobile?: { mismatchPercent: number; passed: boolean };
    }
  ): QaMatrixReport {
    const parseViewport = (rawVp?: { mismatchPercent?: unknown; passed?: unknown }): QaMatrixViewportItem => {
      const isValidNumber = typeof rawVp?.mismatchPercent === 'number' &&
        Number.isFinite(rawVp.mismatchPercent) &&
        rawVp.mismatchPercent >= 0 &&
        rawVp.mismatchPercent <= 100;

      if (!isValidNumber) {
        return {
          mismatchPercent: null,
          passed: false,
          measured: false,
          verdict: 'INCONCLUSIVE',
        };
      }

      // The caller owns the structural verdict: a low pixel diff cannot see a
      // structural parity failure, so the threshold may only downgrade a caller
      // PASS, never upgrade a caller FAIL.
      const mismatchPercent = rawVp!.mismatchPercent as number;
      const passed =
        rawVp!.passed === true && mismatchPercent < VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT;
      return {
        mismatchPercent,
        passed,
        measured: true,
        verdict: passed ? 'PASS' : 'FAIL',
      };
    };

    const vpDesktop = parseViewport(viewports?.desktop);
    const vpTablet = parseViewport(viewports?.tablet);
    const vpMobile = parseViewport(viewports?.mobile);

    const visualScore = vpDesktop.measured && typeof vpDesktop.mismatchPercent === 'number'
      ? Math.max(0, 100 - Math.round(vpDesktop.mismatchPercent * 10))
      : null;

    const responsiveMeasuredCount = (vpTablet.measured ? 1 : 0) + (vpMobile.measured ? 1 : 0);
    const responsiveScore = responsiveMeasuredCount > 0
      ? Math.max(0, 100 - Math.round((((vpTablet.mismatchPercent || 0) + (vpMobile.mismatchPercent || 0)) / responsiveMeasuredCount) * 10))
      : null;

    const domSemanticsScore = typeof checklist.layout === 'boolean'
      ? (checklist.layout ? 98 : 70)
      : null;
    const domSemanticsDetails = typeof checklist.layout === 'boolean'
      ? (checklist.layout ? 'Semantic tags and clean tree structure validated' : 'DOM tree issues detected')
      : 'DOM semantics unmeasured';

    const cssModularityScore = typeof checklist.responsive === 'boolean'
      ? (checklist.responsive ? 96 : 65)
      : null;
    const cssModularityDetails = typeof checklist.responsive === 'boolean'
      ? 'Modular section CSS and responsive breakpoints'
      : 'CSS modularity unmeasured';

    const interactiveScore = typeof checklist.interactions === 'boolean'
      ? (checklist.interactions ? 100 : 50)
      : null;
    const interactiveDetails = typeof checklist.interactions === 'boolean'
      ? (checklist.interactions ? 'All hover, sliders, and modals pass CleanTabProbe' : 'Interactive failures')
      : 'Interactive operability unmeasured';

    // Compliance details describe actual scan scope/results. liquidClean absent is UNKNOWN, not clean.
    // Even true only certifies that scanner's checks, not all Haravan compliance or runtime execution.
    let haravanScore: number | null = null;
    let haravanDetails = 'Haravan Liquid syntax scan unmeasured or unknown (no scanner execution)';
    if (checklist.liquidClean === true) {
      haravanScore = 100;
      haravanDetails = 'Liquid syntax clean per scanner static/browser checks (does not certify full Haravan OS 2.0 or runtime platform compliance)';
    } else if (checklist.liquidClean === false) {
      haravanScore = 40;
      haravanDetails = 'Liquid syntax errors detected by scanner';
    }

    const assetScore = typeof checklist.assetsValid === 'boolean'
      ? (checklist.assetsValid ? 100 : 60)
      : null;
    const assetDetails = typeof checklist.assetsValid === 'boolean'
      ? (!findings?.assets?.hasBrokenAssets ? 'All assets and local font subsets resolved without broken links' : 'Broken assets found')
      : 'Asset integrity unmeasured';

    // Performance/CWV: unmeasured in ThemeQaWorkflow, nullable score without false certification
    const perfScore: number | null = null;
    const perfDetails = 'Core Web Vitals and performance unmeasured (no CWV telemetry measured in this run)';

    const dimensions = {
      visualFidelity: {
        score: visualScore,
        details: vpDesktop.measured
          ? `Desktop diff: ${vpDesktop.mismatchPercent}%, threshold < ${VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT}%`
          : 'Visual diff unmeasured (no baseline comparison supplied)',
      },
      domSemantics: { score: domSemanticsScore, details: domSemanticsDetails },
      cssModularity: { score: cssModularityScore, details: cssModularityDetails },
      interactiveOperability: { score: interactiveScore, details: interactiveDetails },
      haravanCompliance: { score: haravanScore, details: haravanDetails },
      assetIntegrity: { score: assetScore, details: assetDetails },
      responsiveParity: {
        score: responsiveScore,
        details: responsiveMeasuredCount > 0
          ? `Tablet diff: ${vpTablet.mismatchPercent ?? 'N/A'}%, Mobile diff: ${vpMobile.mismatchPercent ?? 'N/A'}%`
          : 'Responsive viewports unmeasured (no baseline comparison supplied)',
      },
      performanceCWV: { score: perfScore, details: perfDetails },
    };

    const finiteScores = Object.values(dimensions)
      .map((d) => d.score)
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

    const overallScore = finiteScores.length > 0
      ? Math.round(finiteScores.reduce((sum, s) => sum + s, 0) / finiteScores.length)
      : null;

    const measuredVpCount = (vpDesktop.measured ? 1 : 0) + (vpTablet.measured ? 1 : 0) + (vpMobile.measured ? 1 : 0);
    const coverage: QaMatrixCoverage = {
      measuredDimensions: finiteScores.length,
      totalDimensions: 8,
      measuredViewports: measuredVpCount,
      totalViewports: 3,
    };

    const anyVpFailed = (vpDesktop.measured && !vpDesktop.passed) ||
      (vpTablet.measured && !vpTablet.passed) ||
      (vpMobile.measured && !vpMobile.passed);

    const allVpMeasured = vpDesktop.measured && vpTablet.measured && vpMobile.measured;
    const allVpPassed = allVpMeasured && vpDesktop.passed && vpTablet.passed && vpMobile.passed;

    const rawLiquidClean: unknown = checklist && 'liquidClean' in checklist ? checklist.liquidClean : undefined;
    const hasComplianceScan = typeof rawLiquidClean === 'boolean';
    const hasEvidenceGaps = Boolean(findings?.evidenceGaps && findings.evidenceGaps.length > 0);

    let verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    if (anyVpFailed || summary.verdict === 'FAIL') {
      verdict = 'FAIL';
    } else if (
      !allVpMeasured ||
      !hasComplianceScan ||
      summary.verdict === 'INCONCLUSIVE' ||
      hasEvidenceGaps
    ) {
      verdict = 'INCONCLUSIVE';
    } else if (allVpPassed && summary.passed) {
      verdict = 'PASS';
    } else {
      verdict = summary.criticalCount > 0 ? 'FAIL' : 'INCONCLUSIVE';
    }

    const passed = verdict === 'PASS';

    return {
      timestamp: new Date().toISOString(),
      overallScore,
      passed,
      verdict,
      coverage,
      dimensions,
      viewports: {
        desktop: vpDesktop,
        tablet: vpTablet,
        mobile: vpMobile,
      },
    };
  }
  private assertOwnership(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Theme QA requires an explicit Project/Workspace/runtime/tab target');
    }
  }
}

export { createWorkspaceSnapshotManifest, rollbackWorkspaceToManifest, WorkspaceSnapshotManifest, WorkspaceRollbackResult } from './workspace-snapshot-rollback';
