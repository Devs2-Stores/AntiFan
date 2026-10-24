import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArtifactRef, BrowserTarget, CapabilityError, TargetStaleCause } from '../../shared/control-plane-contracts';
import { BrowserControlPort } from '../tools/browser-control-port';
import type { CaptureFailureCode, EvidenceCaptureEnvelope } from '../verification/visual-capture';
import { effectiveDomQuietIgnore, type VisualSettleReceipt } from '../verification/capture-settle';
import { CaptureError } from '../verification/visual-capture';
import { ArtifactStore } from '../tools/artifact-store';
import { PlatformDetector, PlatformDetectionResult, EcommercePlatform } from './scanners/platform-detector';
import { LiquidErrorScanner, LiquidScanResult, LiquidErrorFinding } from './scanners/liquid-error-scanner';
import { ServerCrashScanner, ServerCrashScanResult, ServerCrashFinding } from './scanners/server-crash-scanner';
import { BrokenAssetScanner, BrokenAssetScanResult, BrokenAssetFinding } from './scanners/broken-asset-scanner';
import { LayoutOverflowEngine, ViewportOverflowResult } from './scanners/layout-overflow-engine';
import { LayoutIntegrityEngine, type LayoutIntegrityResult, type LayoutIntegrityFinding } from './scanners/layout-integrity-engine';
import type { QaVerification, QaExecution, QaRecovery } from './qa-state';
import { HsGateRules, HsEvaluationResult, HsRuleViolation } from './rules/hs-gate-rules';
import { classifyDiagnostics, extractCorrelatableAssetFailures, extractDocumentHttpStatus, DiagnosticsInput, DiagnosticIssue } from './diagnostics-filter';
import { DomSemanticsScanner, type DomSemanticsScanResult } from './scanners/dom-semantics-scanner';
import { VisualQualityScanner, visualQualityEvalTimeoutMs, type VisualQualityScanResult, type VisualQualityFinding } from './scanners/visual-quality-scanner';
import { formatInflightNote } from '../browser/first-party-network-tracker';
import { DEFAULT_SWEEP_BREAKPOINTS } from '../browser/sweep-viewports';
import type { ThemeTransactionRegistry } from './theme-transaction-registry';
import type { TerminalSyncCursor, SyncSettleResult } from './haravan-sync-barrier';
import { DEFAULT_QA_PROFILE, resolveQaThresholds, type QaProfile, type QaThresholds, type QaThresholdsSource } from './qa-thresholds';
import { ImageFrameScanner, type ImageFrameScanResult, type ImageFrameFinding } from './scanners/image-frame-scanner';
import type { StateMatrixResult } from './state-matrix';
export interface ThemeQaChecklist {
  layout: boolean;
  responsive: boolean | 'UNMEASURED';
  overflow: boolean;
  /**
   * Present only when a caller supplies a real interaction probe result. This
   * workflow runs no interaction probe of its own, and the Haravan HTML scan is
   * reported as `hsCompliant` — never as interactive operability.
   */
  interactions?: boolean;
  diagnostics: boolean;
  liquidClean?: boolean;
  assetsValid?: boolean;
  hsCompliant?: boolean;
}

export interface ThemeQaIssueItem {
  category: 'diagnostics' | 'liquid' | 'overflow' | 'broken_asset' | 'hs_rule' | 'layout_integrity' | 'visual_quality' | 'state_matrix';
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

export interface ThemeQaDiagnosticScreenshot {
  artifactId?: string;
  artifactRef?: unknown;
  certifying: false;
  reason: string;
}

export interface ThemeQaEvidenceFailure {
  code: CaptureFailureCode | 'RESOURCE_FAILURE';
  message: string;
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
  evidenceFailure?: ThemeQaEvidenceFailure;
  diagnosticScreenshot?: ThemeQaDiagnosticScreenshot;
  /** Geometry-first integrity scan: overlap/clipping/occlusion/offscreen/sticky + layout-shift witness. */
  layoutIntegrity?: LayoutIntegrityResult;
  /** Visual findings that deterministic rules cannot settle — surfaced for AI/human review, never auto-failed. */
  visualAmbiguities?: string[];
  /** Present only when the timer-driven popup wait ran: whether a hidden popup showed and how long the scan waited for it. */
  timedWidgets?: { seen: boolean; waitedMs: number };
  /** Per-breakpoint finding counts keyed by CSS width ("320","375","768","1024","1440","1920","2560"). */
  responsive?: Record<string, {
    documentOverflow: boolean | null;
    criticalOverflow: number | null;
    criticalOverlap: number | null;
    criticalClipping: number | null;
    criticalOcclusion: number | null;
    criticalOffscreen: number | null;
    /** Edge-clearance warnings at this width (never critical); null when the width was not scanned. */
    spacingWarnings: number | null;
    /** Detailed integrity findings captured at this width when non-empty. */
    findings?: LayoutIntegrityFinding[];
  }>;
  documentStatus?: number;
  domSemantics?: DomSemanticsScanResult;
  /** Contrast, tap-target and floating-widget measurements (see visual-quality-scanner.ts). */
  visualQuality?: VisualQualityScanResult;
}
export type ThemeQaSeverity = 'critical' | 'warning';

export interface ThemeQaCertificationRemedy {
  reason: string;
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * Findings of this run grouped by where they stand against the baseline. `introduced`: absent
 * from the baseline (or from the pre-reload diagnostics when no baseline was supplied).
 * `preexisting`: matched in the baseline. `legacy`: findings that had no baseline to be compared
 * with, so they cannot be called introduced.
 */
export interface ThemeQaAttribution {
  introduced: Record<ThemeQaSeverity, number>;
  preexisting: Record<ThemeQaSeverity, number>;
  legacy: Record<ThemeQaSeverity, number>;
  introducedSelectors: string[];
}

/** `width` is the sweep width for `sweep` and `absolute`; for `caller` it is the nominal width of the named viewport. */
export interface ThemeQaViewportTested {
  name: string;
  width: number;
  source: 'caller' | 'sweep' | 'absolute';
}

export interface ThemeQaStorefrontTheme {
  id?: string | number;
  role?: string;
  changedSincePreviousRun?: boolean;
}

export interface ThemeQaSummary {
  passed: boolean;
  totalIssues: number;
  criticalCount: number;
  verdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  domUnstable?: boolean;
  responsive?: boolean | 'UNMEASURED';
  documentStatus?: number;
  viewport?: { width: number; height: number; requestedWidth?: number | null; observedWidth?: number };
  pageCriticalCount?: number;
  scopedCriticalCount?: number | null;
  /**
   * What `verdict` certifies. STRUCTURAL: the measured structural checks passed while the
   * 8-dimension matrix still has unmeasured dimensions or viewports, so PASS is not a visual,
   * interaction or performance certification. CERTIFIED: the matrix itself passed.
   */
  certification?: 'STRUCTURAL' | 'CERTIFIED';
  /** The QA matrix verdict mirrored next to the structural verdict so neither is read alone. */
  matrixVerdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  /** Why `certification` is STRUCTURAL: the unmeasured viewports/dimensions and evidence gaps. Empty when CERTIFIED. */
  certificationReasons?: string[];
  /** Where the registry thresholds came from: explicit caller value, the workspace contract, or the built-in defaults. */
  thresholdsSource?: QaThresholdsSource;
  /** What backed a CERTIFIED verdict: a baseline comparison per viewport, or a declared greenfield run. Absent when STRUCTURAL. */
  certificationBasis?: 'baseline' | 'greenfield';
  /** Concrete calls that would turn a STRUCTURAL result into CERTIFIED; the reasons stay in `certificationReasons`. */
  certificationRemedies?: ThemeQaCertificationRemedy[];
  /** Where this run's critical findings stand relative to the baseline; never changes `criticalCount`. */
  attribution?: ThemeQaAttribution;
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
  /** `absolute` on a greenfield run (graded by the absolute gates, no pixel diff); absent for baseline-compared viewports. */
  basis?: 'baseline' | 'absolute';
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
  domUnstable?: boolean;
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
/**
 * How the ephemeral tracker-isolation window ended. `released: false` while
 * `opened: true` means the user's tab is still running with vendor origins
 * blocked and the release must be retried.
 */
export interface TrackerIsolationOutcome {
  opened: boolean;
  released: boolean;
  reason?: string;
}

/** Canonical responsive contract: the widths the host sweep
 * (runResponsiveCheck) measures, taken from DEFAULT_SWEEP_BREAKPOINTS so the
 * sweep and the per-width map cannot drift apart. */
export const QA_RESPONSIVE_WIDTHS: readonly number[] = DEFAULT_SWEEP_BREAKPOINTS.map((bp) => bp.width);

export type VisualSettleReceiptExtended = VisualSettleReceipt & {
  layoutStable?: boolean;
  domUnstable?: boolean;
  evidenceGaps?: string[];
  /** Selectors whose subtree mutations were excluded from the DOM-quiet predicate (defaults plus per-call), so a pass is auditable. */
  ignoreSelectors?: string[];
  scopeSelector?: string;
  /** One bounded re-settle was spent because the font gate was unsettled on the first attempt. */
  settleRetries?: number;
};

/** A caller-accepted visual-quality rule exception: both fields are required so a waiver never reads as silent. */
export interface QaWaiver {
  rule: string;
  reason: string;
}

export type { QaProfile, QaThresholds, QaThresholdsSource };

/** Per-call settle barrier overrides. Unset fields keep the host defaults. */
export interface QaSettleOverrides {
  scopeSelector?: string;
  ignoreSelectors?: string[];
  networkTimeoutMs?: number;
  fontsTimeoutMs?: number;
  imagesTimeoutMs?: number;
  domTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface ThemeQaReport {
  runId: string;
  attemptId: string;
  workspaceId: string;
  target: BrowserTarget;
  viewport?: { width: number; height: number; requestedWidth?: number | null; observedWidth?: number };
  summary: ThemeQaSummary;
  checklist: ThemeQaChecklist & { liquidClean: boolean; assetsValid: boolean; hsCompliant: boolean };
  findings?: ThemeQaDetailedFindings;
  artifacts: ArtifactRef[];
  qaMatrix?: QaMatrixReport;
  settleReceipt?: VisualSettleReceiptExtended;
  settingsRatchet?: { ok: boolean; newFailures: number; legacyDebt: number; findings: unknown[] } | null;
  /** Resilient-QA state axes. `verification` mirrors summary.verdict; `execution`
   * is DEGRADED when evidence gaps exist but the run completed, BLOCKED only on
   * terminal aborts that prevented the report (thrown path sets it on receipt). */
  verification: QaVerification;
  execution: QaExecution;
  recovery: { attempted: number; succeeded: number };
  /** Fraction of scanner dimensions that produced measurement evidence (0..1). */
  evidenceCoverage: number;
  /** Effective profile this run was graded under. */
  profile: QaProfile;
  /** Where the registry thresholds came from. */
  thresholdsSource: QaThresholdsSource;
  /** Widths this run measured and what measured them. */
  viewportsTested?: ThemeQaViewportTested[];
  /** The theme the storefront reported serving; absent when the page exposes none. */
  storefrontTheme?: ThemeQaStorefrontTheme;
  /** Scanner dimensions measured of the dimensions expected; the receipt mirrors it for coverage audits. */
  coverage: { measured: number; expected: number };
  /** Minimum measured/expected share below which a green run is INCONCLUSIVE. */
  coverageFloor: number;
  /** Rules and scan families that produced measurement evidence in this run. */
  measuredRules: string[];
  /** Waivers the caller supplied; echoed so an accepted exception stays visible. */
  waivers?: QaWaiver[];
  /** Outcome of persisting the workspace receipt; set by the capability layer after the write. */
  receipt?: { written: boolean; path?: string; code?: string };
  createdAt: number;
}
export interface ThemeQaWorkflowPorts {
  browser: BrowserControlPort;
  artifacts: ArtifactStore;
  reload: (target: BrowserTarget, options?: { ownedReloadToken?: string }) => Promise<{ reloaded: boolean; target: BrowserTarget }> | { reloaded: boolean; target: BrowserTarget };
  transactionRegistry?: ThemeTransactionRegistry;
  /**
   * Ephemeral third-party tracker isolation. Called with `true` before the
   * QA reload and `false` once the settle barrier has returned, so the block
   * window covers exactly the load-to-quiescence phase.
   *
   * This is a determinism measure, not a network remedy: the settle gate's
   * network counter only tracks first-party critical resources (same-origin or
   * theme-asset document/stylesheet/script/font) and explicitly excludes
   * analytics hosts, so blocking beacons cannot turn a `network=false` gate
   * settled. What it removes is third-party DOM noise — popups and widgets that
   * mutate the document mid-settle — and the `ReferenceError` a blocked tag
   * script would otherwise throw in the page under test.
   *
   * The pane is passed explicitly so isolation is applied to the same pane the
   * settle barrier measures. Optional: a host without it runs the workflow
   * unchanged, it just tolerates the third-party noise.
   */
  trackerIsolation?: (target: BrowserTarget, active: boolean, paneId: 'desktop' | 'mobile') => Promise<{ active: boolean; reason?: string }>;
  /**
   * Pause before the QA reload so the file writes of a theme edit, and the
   * watcher upload they trigger, land before the document is reloaded.
   * Defaults to {@link DEFAULT_FS_QUIESCENCE_MS}. A caller with no file system
   * behind the tab (a test double) may pass 0: the pause still yields one
   * macrotask, so an abort raised during it is observed before the reload.
   */
  fsQuiescenceMs?: number;
}

export const DEFAULT_FS_QUIESCENCE_MS = 150;

/**
 * Sanitize sensitive PII strings (RT-02 mitigation)
 */
export function sanitizePii(text: string): string {
  if (!text) return text;
  return text
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]')
    // Digit boundaries keep the pattern off longer numeric fields (e.g. a 13-digit
    // epoch), which would otherwise leave a bare token and break the JSON report.
    .replace(/(?<!\d)(?:\+?84|0)(?:3|5|7|8|9)[0-9]{8}(?!\d)/g, '[REDACTED_PHONE]')
    .replace(/(?:bearer\s+|token=)[a-zA-Z0-9_\-\.]{20,}/gi, '[REDACTED_TOKEN]');
}

export interface QaReceiptFindingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QaReceiptFinding {
  rule: string;
  severity: 'critical' | 'warning';
  selector: string | null;
  rect: QaReceiptFindingRect | null;
  message: string;
}

export function normalizeReceiptRect(raw: unknown): QaReceiptFindingRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = typeof r.x === 'number' && Number.isFinite(r.x) ? r.x : null;
  const y = typeof r.y === 'number' && Number.isFinite(r.y) ? r.y : null;
  const width =
    typeof r.width === 'number' && Number.isFinite(r.width)
      ? r.width
      : typeof r.w === 'number' && Number.isFinite(r.w)
        ? r.w
        : null;
  const height =
    typeof r.height === 'number' && Number.isFinite(r.height)
      ? r.height
      : typeof r.h === 'number' && Number.isFinite(r.h)
        ? r.h
        : null;
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

export function truncateReceiptMessage(msg: unknown, maxLen = 300): string {
  const s = typeof msg === 'string' ? msg : String(msg ?? '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function buildReceiptFindings(
  findings: ThemeQaDetailedFindings | undefined,
  settingsRatchet?: {
    ok?: boolean;
    findings?: Array<{ rule?: string; id?: string; file?: string; line?: number; message?: string; detail?: string }>;
  } | null,
  maxEntries = 200
): QaReceiptFinding[] {
  const criticals: QaReceiptFinding[] = [];
  const warnings: QaReceiptFinding[] = [];

  if (findings && typeof findings === 'object') {
    if (Array.isArray(findings.diagnosticIssues)) {
      for (const d of findings.diagnosticIssues) {
        if (!d) continue;
        criticals.push({
          rule: /^ROUTE_404:/i.test(d.message) ? 'ROUTE_404' : `diagnostics:${d.kind}`,
          severity: 'critical',
          selector: null,
          rect: null,
          message: truncateReceiptMessage(d.message),
        });
      }
    }
    if (Array.isArray(findings.liquid?.errors)) {
      for (const e of findings.liquid.errors) {
        if (!e) continue;
        criticals.push({
          rule: `liquid:${e.type}`,
          severity: 'critical',
          selector: e.selector || e.location || null,
          rect: null,
          message: truncateReceiptMessage(e.message),
        });
      }
    }
    if (findings.overflow) {
      if (Array.isArray(findings.overflow.culprits) && findings.overflow.culprits.length > 0) {
        for (const c of findings.overflow.culprits) {
          if (!c) continue;
          criticals.push({
            rule: 'overflow',
            severity: 'critical',
            selector: c.selector || null,
            rect: normalizeReceiptRect(c.boundingBox),
            message: truncateReceiptMessage(`Layout horizontal overflow: deltaX ${c.deltaX}px on ${c.selector || 'window'}`),
          });
        }
      } else if (findings.overflow.hasOverflow) {
        criticals.push({
          rule: 'overflow',
          severity: 'critical',
          selector: null,
          rect: null,
          message: truncateReceiptMessage(
            `Horizontal overflow detected on ${findings.overflow.viewport?.name || 'active'} viewport (${findings.overflow.viewport?.width || 0}px): deltaX ${findings.overflow.deltaX || 0}px`
          ),
        });
      }
      if (Array.isArray(findings.overflow.innerClippedCulprits)) {
        for (const c of findings.overflow.innerClippedCulprits) {
          if (!c) continue;
          warnings.push({
            rule: 'overflow:inner-clipped',
            severity: 'warning',
            selector: c.selector || null,
            rect: normalizeReceiptRect(c.boundingBox),
            message: truncateReceiptMessage(`Inner clipped horizontal overflow: deltaX ${c.deltaX}px on ${c.selector || 'element'}`),
          });
        }
      }
    }
    if (Array.isArray(findings.assets?.brokenAssets)) {
      for (const a of findings.assets.brokenAssets) {
        if (!a) continue;
        criticals.push({
          rule: `broken_asset:${a.type}`,
          severity: 'critical',
          selector: a.elementSelector || null,
          rect: null,
          message: truncateReceiptMessage(`Broken ${a.type}: ${a.url} (${a.reason})`),
        });
      }
    }
    if (Array.isArray(findings.hsRules?.violations)) {
      for (const v of findings.hsRules.violations) {
        if (!v) continue;
        const sev: 'critical' | 'warning' = v.severity === 'error' ? 'critical' : 'warning';
        const entry: QaReceiptFinding = {
          rule: v.ruleId || 'hs_rule',
          severity: sev,
          selector: v.selector || null,
          rect: null,
          message: truncateReceiptMessage(v.message),
        };
        if (sev === 'critical') criticals.push(entry);
        else warnings.push(entry);
      }
    }
    if (Array.isArray(findings.serverCrash?.findings)) {
      for (const s of findings.serverCrash.findings) {
        if (!s) continue;
        criticals.push({
          rule: `server_crash:${s.type}`,
          severity: 'critical',
          selector: null,
          rect: null,
          message: truncateReceiptMessage(s.message),
        });
      }
    }
    const activeIntegrityWidth =
      findings.layoutIntegrity?.measured === true ? findings.layoutIntegrity.viewport?.width : undefined;
    const activeCriticalKeys = new Set<string>();
    if (Array.isArray(findings.layoutIntegrity?.findings)) {
      for (const lf of findings.layoutIntegrity.findings) {
        if (!lf) continue;
        const rule = lf.ruleId ? `layout_integrity:${lf.kind}:${lf.ruleId}` : `layout_integrity:${lf.kind}`;
        const sev: 'critical' | 'warning' = lf.severity === 'critical' ? 'critical' : 'warning';
        const entry: QaReceiptFinding = {
          rule,
          severity: sev,
          selector: lf.selector || null,
          rect: normalizeReceiptRect(lf.rect),
          message: truncateReceiptMessage(lf.details),
        };
        if (sev === 'critical') {
          activeCriticalKeys.add(`${lf.kind}:${lf.selector || ''}:${(lf.details || '').slice(0, 80)}`);
          criticals.push(entry);
        } else {
          warnings.push(entry);
        }
      }
    }
    if (findings.responsive && typeof findings.responsive === 'object') {
      // The overflow block above already reports the width it measured as page-level overflow
      // (no culprits); with culprits, those may be out of scope, so the sweep reading still counts.
      const overflowWidth = findings.overflow?.measured && findings.overflow.hasOverflow && !(Array.isArray(findings.overflow.culprits) && findings.overflow.culprits.length > 0) ? findings.overflow.viewport?.width : undefined;
      for (const [wKey, rEntry] of Object.entries(findings.responsive)) {
        if (!rEntry) continue;
        const wNum = Number(wKey);
        if (rEntry.documentOverflow === true && wNum !== overflowWidth) {
          criticals.push({
            rule: `overflow@${wKey}`,
            severity: 'critical',
            selector: null,
            rect: null,
            message: truncateReceiptMessage(`Horizontal page overflow at ${wKey}px (responsive sweep)`),
          });
        }
        if (!Array.isArray(rEntry.findings)) continue;
        for (const rf of rEntry.findings) {
          if (!rf || rf.severity !== 'critical') continue;
          const key = `${rf.kind}:${rf.selector || ''}:${(rf.details || '').slice(0, 80)}`;
          if (wNum === activeIntegrityWidth && activeCriticalKeys.has(key)) continue;
          const rule = rf.ruleId ? `layout_integrity@${wKey}:${rf.kind}:${rf.ruleId}` : `layout_integrity@${wKey}:${rf.kind}`;
          criticals.push({
            rule,
            severity: 'critical',
            selector: rf.selector || null,
            rect: normalizeReceiptRect(rf.rect),
            message: truncateReceiptMessage(`(${wKey}px) ${rf.details}`),
          });
        }
      }
    }
    if (Array.isArray(findings.diagnosticWarnings)) {
      for (const d of findings.diagnosticWarnings) {
        if (!d) continue;
        warnings.push({
          rule: /^AUTH_REDIRECT:/i.test(d.message) ? 'AUTH_REDIRECT' : `diagnostics:${d.kind}`,
          severity: 'warning',
          selector: null,
          rect: null,
          message: truncateReceiptMessage(d.message),
        });
      }
    }
  }

  if (settingsRatchet && settingsRatchet.ok === false && Array.isArray(settingsRatchet.findings)) {
    for (const sf of settingsRatchet.findings) {
      if (!sf) continue;
      criticals.push({
        rule: sf.rule || 'settings_ratchet',
        severity: 'critical',
        selector: sf.id || null,
        rect: null,
        message: truncateReceiptMessage(sf.message || sf.detail || `${sf.rule || 'settings_ratchet'} at ${sf.file || 'config'}`),
      });
    }
  }

  return [...criticals, ...warnings].slice(0, maxEntries);
}

interface ParsedSelectorSegment {
  raw: string;
  tag: string;
  id: string;
  classes: string[];
  distinctiveClasses: string[];
}

const GENERIC_LAYOUT_CLASSES: Record<string, true> = {
  container: true,
  'container-fluid': true,
  wrapper: true,
  'page-wrapper': true,
  row: true,
  col: true,
  flex: true,
  grid: true,
  block: true,
  inline: true,
  'inline-block': true,
  relative: true,
  absolute: true,
  fixed: true,
  active: true,
  open: true,
  show: true,
  hidden: true,
  'w-full': true,
  'h-full': true,
  'is-scrolled': true,
};

const PAGE_ROOT_SEGMENTS: Record<string, true> = {
  html: true,
  body: true,
  window: true,
  document: true,
  main: true,
  'main#maincontent': true,
  '#maincontent': true,
  '#pagecontainer': true,
};

function splitSelectorChain(selector: string): string[] {
  const s = selector.trim();
  if (!s) return [];
  const parts: string[] = [];
  let buf = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    if (bracketDepth === 0 && parenDepth === 0 && (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch))) {
      const trimmed = buf.trim();
      if (trimmed) parts.push(trimmed);
      buf = '';
      while (i + 1 < s.length && (s[i + 1] === '>' || s[i + 1] === '+' || s[i + 1] === '~' || /\s/.test(s[i + 1]!))) {
        i++;
      }
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseSelectorSegment(raw: string): ParsedSelectorSegment {
  const withoutPseudo = raw
    .replace(/\[[^\]]*\]/g, '')
    .replace(/:+[a-zA-Z-]+(?:\([^)]*\))?/g, '')
    .trim();
  const tagMatch = withoutPseudo.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  const tag = tagMatch ? tagMatch[0].toLowerCase() : '';
  const idMatch = withoutPseudo.match(/#([a-zA-Z0-9_-]+)/);
  const id = idMatch && idMatch[1] ? idMatch[1].toLowerCase() : '';
  const classMatches = [...withoutPseudo.matchAll(/\.([a-zA-Z0-9_-]+)/g)]
    .map((m) => (m[1] || '').toLowerCase())
    .filter(Boolean);
  const distinctiveClasses = classMatches.filter((c) => !GENERIC_LAYOUT_CLASSES[c]);
  return {
    raw: withoutPseudo.toLowerCase(),
    tag,
    id,
    classes: classMatches,
    distinctiveClasses,
  };
}

function isPageRootSegment(seg: ParsedSelectorSegment): boolean {
  if (PAGE_ROOT_SEGMENTS[seg.raw]) return true;
  if (seg.id === 'maincontent' || seg.id === 'pagecontainer') return true;
  if ((seg.tag === 'html' || seg.tag === 'body' || seg.tag === 'main') && !seg.id && seg.distinctiveClasses.length === 0) {
    return true;
  }
  return false;
}

function selectorSegmentsMatch(a: ParsedSelectorSegment, b: ParsedSelectorSegment, allowSameTag = false): boolean {
  if (!a.raw || !b.raw) return false;
  if (a.id && b.id) {
    if (a.id !== b.id) return false;
    if (a.tag && b.tag && a.tag !== b.tag) return false;
    return true;
  }
  if (a.id || b.id) {
    if (a.distinctiveClasses.length > 0 && b.distinctiveClasses.length > 0) {
      if (a.tag && b.tag && a.tag !== b.tag) return false;
      return a.distinctiveClasses.some((c) => b.distinctiveClasses.includes(c));
    }
    return false;
  }
  if (a.tag && b.tag && a.tag !== b.tag) return false;
  if (a.distinctiveClasses.length > 0 && b.distinctiveClasses.length > 0) {
    return a.distinctiveClasses.some((c) => b.distinctiveClasses.includes(c));
  }
  if (allowSameTag && a.distinctiveClasses.length === 0 && b.distinctiveClasses.length === 0) {
    if (a.classes.length > 0 && b.classes.length > 0) {
      return a.classes.some((c) => b.classes.includes(c));
    }
    return Boolean(a.tag && b.tag && a.tag === b.tag);
  }
  return false;
}

export function isSelectorInAnnotationScope(
  findingSelector: string | null | undefined,
  targetSelector: string,
  domAncestry?: string
): boolean {
  if (!findingSelector || typeof findingSelector !== 'string' || !targetSelector || typeof targetSelector !== 'string') {
    return false;
  }
  const fTrim = findingSelector.trim();
  const tTrim = targetSelector.trim();
  if (!fTrim || !tTrim) return false;
  if (/^(?:document|window)$/i.test(fTrim)) return false;
  if (fTrim.toLowerCase() === tTrim.toLowerCase()) return true;

  const targetChain = splitSelectorChain(tTrim).map(parseSelectorSegment);
  const ancestryRaw = domAncestry ? splitSelectorChain(domAncestry).map(parseSelectorSegment) : [];
  const findingChain = splitSelectorChain(fTrim).map(parseSelectorSegment);
  if (targetChain.length === 0 || findingChain.length === 0) return false;

  const targetIsRoot = targetChain.length === 1 && isPageRootSegment(targetChain[0]!);
  if (!targetIsRoot && findingChain.every(isPageRootSegment)) {
    return false;
  }

  const strippedAncestry = targetIsRoot ? ancestryRaw : ancestryRaw.filter((seg) => !isPageRootSegment(seg));
  const strippedTarget = targetIsRoot ? targetChain : targetChain.filter((seg) => !isPageRootSegment(seg));
  if (strippedTarget.length === 0) return false;

  const targetLeaf = strippedTarget[strippedTarget.length - 1]!;
  let lineage: ParsedSelectorSegment[];
  if (strippedAncestry.length > 0) {
    lineage = [...strippedAncestry];
    const matchIdx = lineage.findIndex((seg) => selectorSegmentsMatch(seg, targetLeaf));
    if (matchIdx === -1) {
      lineage.push(...strippedTarget);
    }
  } else {
    lineage = [...strippedTarget];
  }

  const leafIdxInLineage = lineage.findIndex((seg) => selectorSegmentsMatch(seg, targetLeaf));
  const targetStartIdx = leafIdxInLineage >= 0 ? leafIdxInLineage : Math.max(0, lineage.length - 1);

  const fFiltered = targetIsRoot ? findingChain : findingChain.filter((seg) => !isPageRootSegment(seg));
  if (fFiltered.length === 0) return false;

  const prefixAlignsWithLineage = (endIdx: number, maxLineageIdx: number): boolean => {
    let minL = 0;
    for (let i = 0; i <= endIdx; i++) {
      const fSeg = fFiltered[i]!;
      let matchedAt = -1;
      for (let l = minL; l <= maxLineageIdx; l++) {
        if (selectorSegmentsMatch(fSeg, lineage[l]!, i > 0)) {
          matchedAt = l;
          break;
        }
      }
      if (matchedAt === -1) return false;
      minL = matchedAt + 1;
    }
    return true;
  };

  const fLastIdx = fFiltered.length - 1;
  const fLast = fFiltered[fLastIdx]!;

  for (let l = 0; l < lineage.length; l++) {
    if (selectorSegmentsMatch(fLast, lineage[l]!, fLastIdx > 0)) {
      if (fLastIdx === 0 || prefixAlignsWithLineage(fLastIdx - 1, l - 1)) {
        return true;
      }
    }
  }

  for (let k = 0; k < fLastIdx; k++) {
    const fSeg = fFiltered[k]!;
    for (let l = targetStartIdx; l < lineage.length; l++) {
      if (selectorSegmentsMatch(fSeg, lineage[l]!, k > 0)) {
        if (k === 0 || prefixAlignsWithLineage(k - 1, l - 1)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function parseAnnotationTargetFromMarkdown(markdown: string): { selector: string; domAncestry?: string } | null {
  if (!markdown || typeof markdown !== 'string') return null;
  const pickField = (re: RegExp): string => {
    const m = markdown.match(re);
    if (!m) return '';
    return (m[1] ?? m[2] ?? '').trim();
  };
  const elemSel =
    pickField(/^-\s*Element Selector:\s*(?:`([^`\r\n]+)`|([^\r\n]+))/m) ||
    pickField(/^-\s*Primary Scoped Selector:\s*(?:`([^`\r\n]+)`|([^\r\n]+))/m) ||
    pickField(/^selector:\s*(?:["']([^"'\r\n]+)["']|([^\r\n]+))/m);
  const domAncestry =
    pickField(/^-\s*DOM Ancestry:\s*(?:`([^`\r\n]+)`|([^\r\n]+))/m) ||
    pickField(/^dom_ancestry:\s*(?:["']([^"'\r\n]+)["']|([^\r\n]+))/m);
  const cleanSelector = elemSel && !/^(?:element|n\/a|none|unknown)$/i.test(elemSel) ? elemSel : '';
  const cleanAncestry = domAncestry && !/^(?:element|n\/a|none|unknown)$/i.test(domAncestry) ? domAncestry : '';
  const finalSelector = cleanSelector || cleanAncestry;
  if (!finalSelector) return null;
  return {
    selector: finalSelector,
    ...(cleanAncestry ? { domAncestry: cleanAncestry } : {}),
  };
}

export function resolveAnnotationTargetSelector(
  workspaceRoot: string | undefined,
  annotationId: string | undefined
): { selector: string; domAncestry?: string } | null {
  if (!workspaceRoot || !annotationId || typeof annotationId !== 'string') return null;
  const trimmedId = annotationId.trim();
  if (!trimmedId) return null;
  const annotationsDir = path.join(workspaceRoot, '.antifan', 'annotations');
  try {
    if (!fs.existsSync(annotationsDir)) return null;
    const directCandidates: string[] = [path.join(annotationsDir, `${trimmedId}.md`)];
    if (trimmedId.startsWith('annotation_')) {
      directCandidates.push(path.join(annotationsDir, `element_${trimmedId.slice('annotation_'.length)}.md`));
    }
    for (const candidatePath of directCandidates) {
      if (fs.existsSync(candidatePath)) {
        const content = fs.readFileSync(candidatePath, 'utf8');
        const parsed = parseAnnotationTargetFromMarkdown(content);
        if (parsed) return parsed;
      }
    }
    const entries = fs
      .readdirSync(annotationsDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse();
    const escapedId = trimmedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const idRe = new RegExp(
      `(?:^annotation_id:\\s*["']?${escapedId}["']?\\s*$|^\\s*-\\s*Annotation ID:\\s*\`?${escapedId}\`?\\s*$|\\bannotationId[\`":\\s]+${escapedId}\\b)`,
      'm'
    );
    for (const name of entries) {
      const fullPath = path.join(annotationsDir, name);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (idRe.test(content)) {
          const parsed = parseAnnotationTargetFromMarkdown(content);
          if (parsed) return parsed;
        }
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isUnscopedOrPageLevelSelector(sel: string | null | undefined): boolean {
  if (!sel || typeof sel !== 'string') return true;
  const trimmed = sel.trim();
  if (!trimmed) return true;
  if (/^(?:document|window)$/i.test(trimmed)) return true;
  const chain = splitSelectorChain(trimmed).map(parseSelectorSegment);
  if (chain.length === 0) return true;
  return chain.every(isPageRootSegment);
}

/**
 * True when no segment of the selector carries an id or a non-generic class (`div`, `p > span`,
 * `div.container`): such a selector matches the annotated element's own descendants as well as
 * anything else, so it never shows that a finding lies outside the annotation.
 */
function isAnonymousSelector(sel: string): boolean {
  const chain = splitSelectorChain(sel.trim()).map(parseSelectorSegment).filter((seg) => !isPageRootSegment(seg));
  return chain.length > 0 && chain.every((seg) => !seg.id && seg.distinctiveClasses.length === 0);
}

/** Every element selector the scoped count reads, so the live page can be asked about each once. */
export function collectScopeSelectors(findings: ThemeQaDetailedFindings | undefined, limit = 300): string[] {
  const out = new Set<string>();
  const add = (sel: string | null | undefined): void => {
    if (typeof sel === 'string' && sel.trim() && !isUnscopedOrPageLevelSelector(sel) && out.size < limit) out.add(sel.trim());
  };
  if (!findings) return [];
  findings.liquid?.errors?.forEach((e) => add(e?.selector || e?.location));
  findings.overflow?.culprits?.forEach((c) => add(c?.selector));
  findings.assets?.brokenAssets?.forEach((a) => add(a?.elementSelector));
  findings.hsRules?.violations?.forEach((v) => add(v?.selector));
  findings.layoutIntegrity?.findings?.forEach((f) => { add(f?.selector); add(f?.relatedSelector); });
  Object.values(findings.responsive || {}).forEach((entry) => entry?.findings?.forEach((f) => { add(f?.selector); add(f?.relatedSelector); }));
  return [...out];
}

/**
 * In-page reading of which selectors match an element inside the annotated element, or one that
 * contains it. Resolves to { [selector]: boolean } for the selectors that match anything, or null
 * when the annotated element itself is not on the page.
 */
export function buildScopeContainmentScript(targetSelector: string, selectors: string[]): string {
  return `(() => {
    let target = null;
    try { target = document.querySelector(${JSON.stringify(targetSelector)}); } catch (e) { return null; }
    if (!target) return null;
    const out = {};
    for (const sel of ${JSON.stringify(selectors)}) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      if (!els.length) continue;
      let related = false;
      for (let i = 0; i < els.length && !related; i++) {
        related = els[i] === target || target.contains(els[i]) || els[i].contains(target);
      }
      out[sel] = related;
    }
    return out;
  })()`;
}

export function computeScopedCriticalCount(
  findings: ThemeQaDetailedFindings | undefined,
  targetSelector: string,
  domAncestry?: string,
  fallbackReceiptFindings?: QaReceiptFinding[],
  /** Live-page reading from buildScopeContainmentScript; it decides every selector it covers. */
  containment?: Readonly<Record<string, boolean>> | null
): number {
  let count = 0;
  const inScope = (sel: string): boolean => {
    const live = containment ? containment[sel.trim()] : undefined;
    if (typeof live === 'boolean') return live;
    return isSelectorInAnnotationScope(sel, targetSelector, domAncestry) || isAnonymousSelector(sel);
  };
  const inScopeOrPageLevel = (sel: string | null | undefined, related?: string | null): boolean => {
    if (isUnscopedOrPageLevelSelector(sel)) {
      if (!related || isUnscopedOrPageLevelSelector(related)) return true;
      return inScope(related);
    }
    if (inScope(sel as string)) return true;
    if (related && !isUnscopedOrPageLevelSelector(related) && inScope(related)) return true;
    return false;
  };

  if (findings && typeof findings === 'object') {
    const countedSignatures = new Set<string>();
    if (Array.isArray(findings.diagnosticIssues)) {
      for (const d of findings.diagnosticIssues) {
        if (d) {
          count++;
          countedSignatures.add(`diagnostics:${d.kind}:${d.origin || ''}:${d.message}`);
        }
      }
    }
    if (Array.isArray(findings.serverCrash?.findings)) {
      for (const s of findings.serverCrash.findings) {
        if (s) count++;
      }
    }
    if (Array.isArray(findings.liquid?.errors)) {
      for (const e of findings.liquid.errors) {
        if (e && inScopeOrPageLevel(e.selector || e.location)) {
          count++;
          countedSignatures.add(`liquid:${e.type}:${e.location || e.selector || ''}:${e.message}`);
        }
      }
    }
    if (findings.overflow) {
      if (Array.isArray(findings.overflow.culprits) && findings.overflow.culprits.length > 0) {
        for (const c of findings.overflow.culprits) {
          if (c && inScopeOrPageLevel(c.selector)) {
            count++;
            countedSignatures.add(`overflow:${c.selector || 'window'}:${Math.round(c.deltaX || 0)}`);
          }
        }
      } else if (findings.overflow.hasOverflow) {
        count++;
        countedSignatures.add(
          `overflow:${findings.overflow.viewport?.name || 'active'}:${Math.round(findings.overflow.deltaX || 0)}`
        );
      }
    }
    if (Array.isArray(findings.assets?.brokenAssets)) {
      for (const a of findings.assets.brokenAssets) {
        if (a && inScopeOrPageLevel(a.elementSelector)) {
          count++;
          countedSignatures.add(`broken_asset:${a.type}:${a.url}:${a.reason}`);
        }
      }
    }
    if (Array.isArray(findings.hsRules?.violations)) {
      for (const v of findings.hsRules.violations) {
        if (v && v.severity === 'error' && inScopeOrPageLevel(v.selector)) {
          count++;
          countedSignatures.add(`hs_rule:${v.ruleId}:${v.selector || ''}:${v.message}`);
        }
      }
    }
    const activeIntegrityWidth =
      findings.layoutIntegrity?.measured === true ? findings.layoutIntegrity.viewport?.width : undefined;
    const activeCriticalKeys = new Set<string>();
    if (Array.isArray(findings.layoutIntegrity?.findings)) {
      for (const lf of findings.layoutIntegrity.findings) {
        if (!lf || lf.severity !== 'critical') continue;
        const key = `${lf.kind}:${lf.selector || ''}:${(lf.details || '').slice(0, 80)}`;
        activeCriticalKeys.add(key);
        if (inScopeOrPageLevel(lf.selector, lf.relatedSelector)) {
          count++;
          countedSignatures.add(`layout_integrity:${key}`);
        }
      }
    }
    if (findings.responsive && typeof findings.responsive === 'object') {
      // The overflow block above already counted the width it measured as page-level overflow
      // (no culprits); with culprits, those may be out of scope, so the sweep reading still counts.
      const overflowWidth = findings.overflow?.measured && findings.overflow.hasOverflow && !(Array.isArray(findings.overflow.culprits) && findings.overflow.culprits.length > 0) ? findings.overflow.viewport?.width : undefined;
      for (const [wKey, rEntry] of Object.entries(findings.responsive)) {
        if (!rEntry) continue;
        const wNum = Number(wKey);
        // Document-level horizontal overflow at another breakpoint has no selector: it is a
        // page-level defect, in scope for every annotation, and it fails the page verdict, so a
        // scoped pass must not ignore it.
        if (rEntry.documentOverflow === true && wNum !== overflowWidth) {
          count++;
          countedSignatures.add(`responsive_overflow@${wKey}`);
        }
        if (!Array.isArray(rEntry.findings)) continue;
        for (const rf of rEntry.findings) {
          if (!rf || rf.severity !== 'critical') continue;
          const key = `${rf.kind}:${rf.selector || ''}:${(rf.details || '').slice(0, 80)}`;
          if (wNum === activeIntegrityWidth && activeCriticalKeys.has(key)) continue;
          if (inScopeOrPageLevel(rf.selector, rf.relatedSelector)) {
            count++;
            countedSignatures.add(`layout_integrity@${wKey}:${key}`);
          }
        }
      }
    }
    if (Array.isArray(findings.differential?.introducedRegressions)) {
      for (const reg of findings.differential.introducedRegressions) {
        if (!reg || reg.severity !== 'critical') continue;
        if (reg.signature && countedSignatures.has(reg.signature)) continue;
        if (reg.signature) countedSignatures.add(reg.signature);
        count++;
      }
    }
    return count;
  }

  if (Array.isArray(fallbackReceiptFindings)) {
    for (const f of fallbackReceiptFindings) {
      if (!f || f.severity !== 'critical') continue;
      const isPageLevelRule =
        typeof f.rule === 'string' &&
        (f.rule === 'ROUTE_404' ||
          f.rule.startsWith('diagnostics:') ||
          f.rule.startsWith('server_crash:') ||
          f.rule.startsWith('server-crash:') ||
          f.rule === 'settings_ratchet');
      if (isPageLevelRule || inScopeOrPageLevel(f.selector)) {
        count++;
      }
    }
  }
  return count;
}
const CAPTURE_EVIDENCE_FAILURE_CODES: Partial<Record<CaptureFailureCode, true>> = {
  FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY: true,
  FULLPAGE_CAPTURE_UNSUPPORTED_FORMAT: true,
  CAPTURE_TIMEOUT: true,
  CAPTURE_FRAME_STARVATION: true,
  CAPTURE_EMPTY_PAYLOAD: true,
  CAPTURE_PNG_SIGNATURE_INVALID: true,
  CAPTURE_PNG_TRUNCATED: true,
  CAPTURE_PNG_UNDECODABLE: true,
  CAPTURE_JPEG_SIGNATURE_INVALID: true,
  CAPTURE_JPEG_TRUNCATED: true,
  CAPTURE_JPEG_UNDECODABLE: true,
  CAPTURE_SCALE_MISMATCH: true,
  TARGET_BUSY_DRAINING: true,
  NO_RENDER_SURFACE: true,
  CAPTURE_VIEWPORT_NOT_RESTORED: true,
  CAPTURE_NOT_READY: true,
  SETTLE_PREDICATE_FAILED: true,
  IMAGE_IDENTITY_UNSTABLE: true,
  DOCUMENT_GENERATION_UNSETTLED: true,
  // Route expectation errors are target-selection failures, not raster evidence gaps.
};

function captureEvidenceFailure(error: unknown): ThemeQaEvidenceFailure | undefined {
  if (error instanceof CapabilityError && error.code === 'RESOURCE_FAILURE') {
    return { code: 'RESOURCE_FAILURE', message: error.message };
  }
  if (error instanceof CaptureError && CAPTURE_EVIDENCE_FAILURE_CODES[error.code]) {
    return { code: error.code, message: error.message };
  }
  return undefined;
}
function rethrowTargetLifecycleError(error: unknown): void {
  if (
    error instanceof CapabilityError &&
    (error.code === 'TARGET_REQUIRED' || error.code === 'TARGET_STALE' || error.code === 'TARGET_MISMATCH' || error.code === 'ANTI_BOT_CHALLENGE')
  ) {
    throw error;
  }
}
function isValidViewportOverflowResult(res: unknown): res is ViewportOverflowResult {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return false;
  }
  const obj = res as Record<string, unknown>;
  if (obj.measured === false) {
    return false;
  }
  if ('measured' in obj && typeof obj.measured !== 'boolean') {
    return false;
  }
  if (typeof obj.hasOverflow !== 'boolean') {
    return false;
  }
  if (typeof obj.deltaX !== 'number' || !Number.isFinite(obj.deltaX) || obj.deltaX < 0) {
    return false;
  }
  if (typeof obj.scrollWidth !== 'number' || !Number.isFinite(obj.scrollWidth) || obj.scrollWidth < 0) {
    return false;
  }
  if (typeof obj.clientWidth !== 'number' || !Number.isFinite(obj.clientWidth) || obj.clientWidth <= 0) {
    return false;
  }
  if (!obj.viewport || typeof obj.viewport !== 'object' || Array.isArray(obj.viewport)) {
    return false;
  }
  const vp = obj.viewport as Record<string, unknown>;
  if (typeof vp.name !== 'string' || vp.name.trim().length === 0) {
    return false;
  }
  if (typeof vp.width !== 'number' || !Number.isFinite(vp.width) || vp.width <= 0) {
    return false;
  }
  if (typeof vp.height !== 'number' || !Number.isFinite(vp.height) || vp.height <= 0) {
    return false;
  }
  if (!Array.isArray(obj.culprits)) {
    return false;
  }
  for (const c of obj.culprits) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return false;
    }
  }
  return true;
}

/**
 * Visual mismatch ceiling for a viewport to count as passing. The comparison
 * score hits 0 at this percentage, so the boolean verdict is derived from the
 * measured number: a caller-supplied `passed` cannot certify a diff beyond it.
 */
const VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT = 10;

/** `/password` is the storefront lock Shopify shows instead of every page. */
export const AUTH_ROUTE_RE = /\/(?:account\/(?:login|register)|challenge|auth|password)(?:[/?#]|$)/i;

/** Profile ThemeQaWorkflow.validate applies when its caller names none: the same default as the `theme.qa_validate` tool, so every entry point grades identically. */
export { DEFAULT_QA_PROFILE };

/** Registry rules (graded against contract thresholds) that carry the verdict under build-strict. */
const STRICT_REGISTRY_RULES: Record<string, true> = {
  'font-below-min': true,
  'control-height-band': true,
  'wrapped-label': true,
  'icon-stroke-mismatch': true,
  'overlay-fit': true,
  'title-scale': true,
  'input-height-band': true,
  'image-crop': true,
};

/** Edge-clearance rules that fail a build-strict run (waivable); under audit they stay warnings. */
const STRICT_SPACING_RULES: Record<string, true> = {
  'edge-control': true,
  'sibling-gap': true,
  'min-gap': true,
  'content-drift': true,
};

/**
 * Folds a touch-width reading taken inside the responsive sweep into the active-width reading, so
 * tap targets and registry rules measured at 375px count even when the tab itself is desktop-sized.
 * Findings the active reading already holds are not repeated.
 */
function mergeMobileVisualQuality(base: VisualQualityScanResult | undefined, sweep: VisualQualityScanResult, width: number): VisualQualityScanResult {
  if (!base || base.measured !== true) return { ...sweep, mobileSweepWidth: width };
  const known = new Set(base.findings.map((f) => `${f.ruleId}|${f.selector}`));
  const added = sweep.findings
    .filter((f) => !known.has(`${f.ruleId}|${f.selector}`))
    .map((f): VisualQualityFinding => ({ ...f, details: `${f.details} (at ${width}px)`, measured: { ...f.measured, viewportWidth: width } }));
  const measuredRules = [...new Set([...base.stats.measuredRules, ...sweep.stats.measuredRules])];
  return {
    ...base,
    mobile: true,
    mobileSweepWidth: width,
    findings: [...base.findings, ...added],
    stats: {
      ...base.stats,
      controlsChecked: base.stats.controlsChecked + sweep.stats.controlsChecked,
      measuredRules,
      unmeasuredRules: base.stats.unmeasuredRules.filter((id) => !measuredRules.includes(id)),
      truncated: base.stats.truncated || sweep.stats.truncated,
      truncatedReasons: [...base.stats.truncatedReasons, ...sweep.stats.truncatedReasons],
    },
  };
}

export type GreenfieldViewportName = 'desktop' | 'tablet' | 'mobile';

const GREENFIELD_VIEWPORT_NAMES: readonly GreenfieldViewportName[] = ['desktop', 'tablet', 'mobile'];

/** The sweep width that stands for each viewport name on a greenfield run. */
const GREENFIELD_VIEWPORT_WIDTHS: Record<GreenfieldViewportName, number> = { desktop: 1440, tablet: 768, mobile: 320 };

type ResponsiveWidthEntry = NonNullable<ThemeQaDetailedFindings['responsive']>[string];

/** A width counts as measured only when the sweep returned both the overflow and the integrity reading. */
function greenfieldWidthMeasured(entry: ResponsiveWidthEntry | undefined): entry is ResponsiveWidthEntry {
  return (
    entry !== undefined &&
    entry.documentOverflow !== null &&
    entry.criticalOverlap !== null &&
    entry.criticalClipping !== null &&
    entry.criticalOcclusion !== null &&
    entry.criticalOffscreen !== null
  );
}

function greenfieldWidthClean(entry: ResponsiveWidthEntry): boolean {
  return (
    entry.documentOverflow === false &&
    entry.criticalOverflow === 0 &&
    entry.criticalOverlap === 0 &&
    entry.criticalClipping === 0 &&
    entry.criticalOcclusion === 0 &&
    entry.criticalOffscreen === 0
  );
}

/** Which widths a run measured, and by what evidence (see ThemeQaReport.viewportsTested). */
function buildViewportsTested(
  responsiveMap: NonNullable<ThemeQaDetailedFindings['responsive']>,
  qaMatrix: QaMatrixReport,
  greenfield: boolean
): ThemeQaViewportTested[] {
  const tested: ThemeQaViewportTested[] = [];
  for (const name of GREENFIELD_VIEWPORT_NAMES) {
    const viewport = qaMatrix.viewports[name];
    if (!viewport.measured) continue;
    tested.push({ name, width: GREENFIELD_VIEWPORT_WIDTHS[name], source: greenfield ? 'absolute' : 'caller' });
  }
  for (const width of QA_RESPONSIVE_WIDTHS) {
    const entry = responsiveMap[String(width)];
    if (!entry || entry.documentOverflow === null) continue;
    if (tested.some((item) => item.width === width)) continue;
    tested.push({ name: width < 768 ? 'mobile' : width <= 1024 ? 'tablet' : 'desktop', width, source: 'sweep' });
  }
  return tested;
}

function buildAttribution(differential: ThemeQaDifferentialAttribution, hasBaseline: boolean): ThemeQaAttribution {
  const zero = (): Record<ThemeQaSeverity, number> => ({ critical: 0, warning: 0 });
  const attribution: ThemeQaAttribution = { introduced: zero(), preexisting: zero(), legacy: zero(), introducedSelectors: [] };
  const introducedSelectors = new Set<string>();
  for (const item of differential.preExistingIssues) attribution.preexisting[item.severity]++;
  for (const item of differential.introducedRegressions) {
    // Without a supplied baseline only the diagnostics have a before-reload reading to compare
    // against; every other finding has nothing to be "introduced" relative to.
    if (!hasBaseline && item.category !== 'diagnostics') {
      attribution.legacy[item.severity]++;
      continue;
    }
    attribution.introduced[item.severity]++;
    const selector = item.details?.selector;
    if (typeof selector === 'string' && selector.length > 0) introducedSelectors.add(selector);
  }
  attribution.introducedSelectors = [...introducedSelectors].slice(0, 25);
  return attribution;
}

/** Reads the theme the storefront reports about itself; any shape it does not recognise reads as null. */
const STOREFRONT_THEME_SCRIPT = `(() => {
  try {
    var holder = (window.Shopify && window.Shopify.theme) || (window.Haravan && window.Haravan.theme) || (window.haravan && window.haravan.theme) || null;
    if (!holder || typeof holder !== 'object') return null;
    var id = holder.id !== undefined && holder.id !== null ? holder.id : holder.theme_id;
    var role = holder.role;
    return {
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      role: typeof role === 'string' ? role : null,
    };
  } catch (e) {
    return null;
  }
})()`;

function normalizeStorefrontTheme(reading: unknown): ThemeQaStorefrontTheme | undefined {
  if (!reading || typeof reading !== 'object') return undefined;
  const raw = reading as { id?: unknown; role?: unknown };
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : undefined;
  const role = typeof raw.role === 'string' && raw.role.trim().length > 0 ? raw.role.trim() : undefined;
  if (id === undefined && role === undefined) return undefined;
  return { ...(id !== undefined ? { id } : {}), ...(role !== undefined ? { role } : {}) };
}

/** Theme id recorded by the newest QA receipt in the workspace, or undefined when none carries one. */
function readPreviousStorefrontThemeId(workspaceRoot: string): string | undefined {
  if (!workspaceRoot) return undefined;
  try {
    const dir = path.join(workspaceRoot, '.antifan', 'qa-receipts');
    let newest: { file: string; at: number } | undefined;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const at = fs.statSync(path.join(dir, name)).mtimeMs;
      if (!newest || at > newest.at) newest = { file: name, at };
    }
    if (!newest) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, newest.file), 'utf8'));
    const id = (parsed as { storefrontTheme?: { id?: unknown } } | null)?.storefrontTheme?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a caller may hand to `ThemeQaWorkflow.validate`. */
export interface ThemeQaValidateInput {
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
  /** Recovery counters from the capability wrapper (e.g. failover rebind after
   * TARGET_STALE). The workflow performs no retries itself — it mirrors the
   * caller's real counts so the report never hard-codes zero. */
  recovery?: { attempted: number; succeeded: number };
  annotationId?: string;
  annotationTargetSelector?: string;
  annotationDomAncestry?: string;
  /**
   * build-strict (the default for every entry point): contrast below AA, sub-24px tap targets,
   * invisible click blockers, floating widgets over controls and the registry rules fail the run,
   * and an unmeasured scan is an evidence gap.
   * audit: visual-quality findings are reported, never verdict-bearing.
   */
  profile?: QaProfile;
  /** Contract thresholds for the registry rules; without them the workspace contract, then the built-in defaults apply. */
  thresholds?: QaThresholds;
  /** Minimum measured/expected scanner dimensions (0..1). Below it a green run is INCONCLUSIVE. Defaults to 1 under build-strict, 0 under audit. */
  coverageFloor?: number;
  /** Caller-accepted visual-quality rule exceptions; echoed on the report. */
  waivers?: QaWaiver[];
  /** Per-call settle barrier overrides (DOM-quiet ignore selectors, scope, timeouts). */
  settle?: QaSettleOverrides;
  /** HTTP status the contract declares for this route; a document returning exactly it is not a ROUTE_404 defect. */
  expectedDocumentStatus?: number;
  /**
   * Declares a run with no visual baseline to compare because none exists yet (a new theme).
   * Each of the three representative widths is then graded by the absolute gates measured at
   * that width, and certification is labelled `greenfield`. `baselineExists` is filled by the
   * capability layer after it looks for a promoted baseline: `true` refuses the run.
   */
  greenfield?: { reason: string; baselineExists?: boolean };
}

export class ThemeQaWorkflow {
  constructor(private readonly ports: ThemeQaWorkflowPorts) {}

  /**
   * Runs `body` with ephemeral tracker isolation applied to `target`, releasing
   * it in a `finally` so no failure path — including a `SETTLE_INCOMPLETE`
   * refusal — can leave the tab with a blocklist applied. A host without the
   * port runs `body` unchanged; an isolation that fails to open is routed
   * through the target-lifecycle channel and the body still runs, because QA
   * must never become less able to run than it was without the port.
   *
   * The release result is returned, not discarded: a failed release leaves the
   * user's tab with analytics blocked, and that is the one outcome that must not
   * disappear silently.
   */
  private async withTrackerIsolation<T>(
    target: BrowserTarget,
    body: (rebindTarget: (newTarget: BrowserTarget) => void) => Promise<T>
  ): Promise<{ result: T; isolation?: TrackerIsolationOutcome }> {
    const port = this.ports.trackerIsolation;
    if (!port) return { result: await body(() => {}) };
    let opened = false;
    let outcome: TrackerIsolationOutcome | undefined;
    try {
      const receipt = await port(target, true, 'desktop');
      opened = receipt?.active === true;
      outcome = { opened, released: !opened, reason: receipt?.reason };
    } catch (error) {
      // A throwing open must still be visible: without this the report omits
      // `trackerIsolation` entirely and an isolation that never applied looks the
      // same as one that was never requested.
      outcome = {
        opened: false,
        released: true,
        reason: `Tracker isolation could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      };
      rethrowTargetLifecycleError(error);
    }

    let releaseTarget = target;
    const rebindTarget = (newTarget: BrowserTarget) => {
      releaseTarget = newTarget;
    };

    try {
      return { result: await body(rebindTarget), isolation: outcome };
    } finally {
      if (opened && outcome) {
        try {
          const release = await port(releaseTarget, false, 'desktop');
          const released = release?.active !== true;
          outcome.released = released;
          if (!released) {
            // A release that fails leaves analytics blocked on the user's tab, and
            // a report field alone is not loud enough for that: it is the one
            // outcome of this window that must be visible in the app log too.
            outcome.reason = release?.reason || outcome.reason || 'unknown reason';
            console.warn(
              `[theme-qa] Tracker isolation could not be released on tab '${target.tabId}': ${outcome.reason}`
            );
          }
        } catch (error) {
          // The same reasoning on the throwing path: `rethrowTargetLifecycleError`
          // swallows everything that is not a target-lifecycle error, so this is
          // the last chance to say the tab is still blocked.
          outcome.released = false;
          outcome.reason = `Tracker isolation release failed: ${error instanceof Error ? error.message : String(error)}`;
          console.warn(
            `[theme-qa] Tracker isolation could not be released on tab '${target.tabId}': ${outcome.reason}`
          );
          rethrowTargetLifecycleError(error);
        }
      }
    }
  }
  /**
   * Names what an open network gate is waiting on.
   *
   * The gates alone say that something did not finish; the URLs are what make
   * the message diagnosable, and `network=false` is the gate a storefront hang
   * reports as. Only attached when the network gate is the one that failed, so a
   * font or image failure is not buried under an unrelated request list.
   */
  private describeInflight(target: BrowserTarget, receipt?: VisualSettleReceipt): string {
    if (!receipt || receipt.gates.network !== false) return '';
    const snapshot = typeof this.ports.browser.getInflightDiagnostics === 'function'
      ? this.ports.browser.getInflightDiagnostics(target.tabId, 'desktop')
      : null;
    if (snapshot === null) return '; first-party network snapshot unavailable on this host';
    return formatInflightNote(snapshot);
  }

  async inspect(input: { runId: string; attemptId: string; workspaceRoot: string; target: BrowserTarget; selector?: string }): Promise<{ dom: ArtifactRef | string; screenshot: EvidenceCaptureEnvelope }> {
    this.assertOwnership(input.target);
    const dom = await this.ports.browser.dom(input.target, input.runId, input.attemptId, input.selector);
    const screenshot = await this.ports.browser.screenshot(input.target, input.runId, input.attemptId);
    return { dom, screenshot };
  }


  async validate(input: ThemeQaValidateInput): Promise<ThemeQaReport> {
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
    }
    this.assertOwnership(input.target);
    // Greenfield is a declared exception to the baseline requirement, so it is refused unless it
    // names why no baseline exists and the catalogue found none; it also forces the responsive
    // sweep on, because the absolute gates it grades by are measured there.
    let greenfieldReason: string | undefined;
    if (input.greenfield !== undefined) {
      const declared = input.greenfield as { reason?: unknown; baselineExists?: unknown } | null;
      const reason = declared && typeof declared === 'object' && typeof declared.reason === 'string' ? declared.reason.trim() : '';
      if (reason.length === 0) {
        throw new CapabilityError('INVALID_ARGUMENT', 'greenfield.reason must be a non-empty string naming why no visual baseline exists', {
          recovery: 'pass greenfield: {reason: "<why no baseline exists>"}, or omit greenfield and supply viewports from a baseline comparison',
        });
      }
      if (declared!.baselineExists === true) {
        throw new CapabilityError('GREENFIELD_BASELINE_EXISTS', 'A visual baseline already exists for this workspace; a greenfield run cannot replace it', {
          recovery: 'compare against the promoted baseline with anti.visual.compare and pass the results as viewports, or delete the old baseline deliberately',
        });
      }
      greenfieldReason = reason;
      input = { ...input, multiBreakpoint: true };
    }
    const effectiveBaselineFindings = input.baselineFindings;
    // Profile and thresholds are resolved here, not by the caller, so a tool call, a cockpit scan and
    // a toolbar scan that name neither grade a theme identically.
    const effectiveProfile: QaProfile = input.profile ?? DEFAULT_QA_PROFILE;
    const strictProfile = effectiveProfile === 'build-strict';
    const resolvedThresholds = resolveQaThresholds({ explicit: input.thresholds, workspaceRoot: input.workspaceRoot });
    const effectiveThresholds = resolvedThresholds.thresholds;
    // A sweep that cannot run is an evidence gap whenever the caller asked for it or the profile
    // certifies mobile widths; only an explicit multiBreakpoint:false opts out.
    const sweepGaps = input.multiBreakpoint === true || (strictProfile && input.multiBreakpoint !== false);
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
          } else if (receipt.unsettledReason === 'WATCHER_SLEEPING') {
            // A sleeping watcher legitimately reports settledMethod 'none', which the
            // structural check below would misreport as a malformed receipt. Name the
            // real reason instead. This still FAILS CLOSED: the mutation is not attested.
            mutationMissingBarrier = true;
            mutationBarrierError = `Mutation sync could not be attested: watcher terminal is sleeping${receipt.wakeHint ? ` — ${receipt.wakeHint}` : ''}`;
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

    // Stage 1: File system debounce quiescence
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
    }
    const quiescence = Promise.withResolvers<void>();
    setTimeout(quiescence.resolve, this.ports.fsQuiescenceMs ?? DEFAULT_FS_QUIESCENCE_MS);
    await quiescence.promise;
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
    }

    // Stage 2: Reload to reach load-complete document
    //
    // Tracker isolation spans exactly the load-to-quiescence window: third-party
    // measurement tags are pure noise for QA and actively harmful to it. Note
    // the limit of that claim — the settle gate's first-party tracker excludes
    // analytics origins, so this window does not make a `network=false` gate
    // settle. What it prevents is widgets and popups mutating the document
    // mid-settle, and the `ReferenceError` a blocked tag script would throw in
    // the page under test. The window opens before the reload (so the vendor
    // stubs exist before the storefront JS runs) and is released in a `finally`,
    // so a settle failure cannot leave the tab blocked.
    let activeTarget: BrowserTarget = input.target;
    const liveDocGenBeforeReload = this.ports.browser.getDocumentGeneration?.(input.target.tabId);
    const preReloadTarget: BrowserTarget =
      typeof liveDocGenBeforeReload === 'number'
        ? { ...input.target, documentGeneration: liveDocGenBeforeReload }
        : input.target;

    const ownedReloadToken = `owned-qa-reload-${activeTarget.tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const loadPhase = await this.withTrackerIsolation(preReloadTarget, async (rebindTarget) => {
      const reload = await this.ports.reload(preReloadTarget, { ownedReloadToken });
      if (input.signal?.aborted) {
        throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
      }
      if (!reload || !reload.reloaded || !reload.target) {
        throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not reach a load-complete document', { cause: 'tab-gone' satisfies TargetStaleCause });
      }
      const postReloadGen = this.ports.browser.getDocumentGeneration?.(reload.target.tabId) ?? reload.target.documentGeneration;
      activeTarget = {
        ...reload.target,
        ...(typeof postReloadGen === 'number' ? { documentGeneration: postReloadGen } : {}),
      };
      rebindTarget(activeTarget);
      // Stage 2 & 3: Composed Settle Barrier (Phase 4: settleCapture)
      let receipt: VisualSettleReceiptExtended | undefined;
      let missingCapability = false;
      try {
        if (typeof this.ports.browser.freezeMedia === 'function') {
          try {
            await this.ports.browser.freezeMedia(activeTarget, { freeze: true, normalizeSliders: true });
          } catch {
            // Best effort freeze before settle barrier
          }
        }
        const pauseSlidersScript = `(() => {
          try {
            window.__antifanPausedSliders = window.__antifanPausedSliders || [];
            document.querySelectorAll('.swiper, .swiper-container, [class*="swiper"]').forEach((el) => {
              const sw = el.swiper;
              if (sw && sw.autoplay && typeof sw.autoplay.stop === 'function') {
                if (sw.autoplay.running) {
                  try {
                    sw.autoplay.stop();
                    window.__antifanPausedSliders.push({ type: 'swiper', swiper: sw });
                  } catch {}
                }
              }
            });
            if (typeof window.jQuery === 'function') {
              window.jQuery('.slick-slider, [class*="slick"]').each(function() {
                try {
                  const $el = window.jQuery(this);
                  if (typeof $el.slick === 'function') {
                    $el.slick('slickPause');
                    window.__antifanPausedSliders.push({ type: 'slick', el: this });
                  }
                } catch {}
              });
            }
          } catch {}
        })()`;
        if (typeof this.ports.browser.eval === 'function') {
          try {
            await this.ports.browser.eval(activeTarget, pauseSlidersScript);
          } catch {
            // Best effort pause autoplay sliders
          }
        }
        if (typeof this.ports.browser.settleCapture === 'function') {
          const settleOverrides = input.settle ?? {};
          let settleAttempt = 0;
          for (;;) {
            receipt = await this.ports.browser.settleCapture(activeTarget, 'desktop', undefined, { ...settleOverrides, signal: input.signal });
            // Font loading is intermittent on a cold document; one bounded re-settle separates a slow face from a broken one.
            if (settleAttempt === 0 && receipt && !receipt.settleComplete && receipt.gates?.fonts === false && !input.signal?.aborted) {
              settleAttempt = 1;
              continue;
            }
            break;
          }
          if (receipt) {
            receipt.ignoreSelectors = effectiveDomQuietIgnore(settleOverrides.ignoreSelectors);
            if (settleOverrides.scopeSelector) receipt.scopeSelector = settleOverrides.scopeSelector;
            if (settleAttempt > 0) receipt.settleRetries = settleAttempt;
          }
          if (!receipt || !receipt.settleComplete) {
            const gates = receipt?.gates;
            // Soft settle gaps are audit findings, not crashes: when the page has
            // reached a stable layout with fonts loaded, pending network (third-
            // party trackers, analytics), unsettled lazy images (srcless data-src /
            // lazysizes) or live DOM mutations (carousels, Alpine/Livewire
            // reactivity) are recorded as evidence gaps and the run completes
            // with execution DEGRADED / verdict INCONCLUSIVE. Fonts still
            // unsettled or an unstable layout means the measurements below would
            // describe a page mid-render, so that remains a hard SETTLE_INCOMPLETE.
            const failingPredicate = receipt?.failingPredicate
              ?? (gates?.network === false ? 'network' : gates?.fonts === false ? 'fonts' : gates?.images === false ? 'images' : gates?.dom === false ? 'dom' : undefined);
            const layoutQuiescent = receipt != null && receipt.layoutStable !== false && gates?.fonts === true;
            if (layoutQuiescent && receipt) {
              if (failingPredicate) receipt.failingPredicate = failingPredicate;
              const gaps = Array.isArray(receipt.evidenceGaps) ? receipt.evidenceGaps : (receipt.evidenceGaps = []);
              if (gates?.network === false) {
                gaps.push(`Network did not reach idle during settle window${this.describeInflight(activeTarget, receipt)}`);
              }
              if (gates?.images === false) {
                gaps.push('Images did not settle during settle window (lazy/srcless images outstanding)');
              }
              if (gates?.dom === false) {
                receipt.domUnstable = true;
                gaps.push('DOM mutations remained active during settle window (domUnstable)');
              }
            } else {
              throw new CapabilityError(
                'SETTLE_INCOMPLETE',
                `Theme QA settle gate incomplete: gates not all settled (network=${receipt?.gates?.network}, fonts=${receipt?.gates?.fonts}, images=${receipt?.gates?.images}, dom=${receipt?.gates?.dom})${this.describeInflight(activeTarget, receipt)}`,
                { failingPredicate: failingPredicate ?? 'layout', gates: receipt?.gates ?? null, ignoreSelectors: receipt?.ignoreSelectors ?? effectiveDomQuietIgnore(settleOverrides.ignoreSelectors) }
              );
            }
          }
        } else {
          missingCapability = true;
        }
      } catch (err) {
        rethrowTargetLifecycleError(err);
        const failure = captureEvidenceFailure(err);
        if (!failure) {
          if (err instanceof CapabilityError) throw err;
          throw new CapabilityError(
            'SETTLE_INCOMPLETE',
            `Theme QA settle gate failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { receipt, missingCapability, failure };
      }
      return { receipt, missingCapability, failure: undefined };
    });
    const settleReceipt: VisualSettleReceiptExtended | undefined = loadPhase.result.receipt;
    const settleMissingCapability = loadPhase.result.missingCapability;
    let evidenceFailure: ThemeQaEvidenceFailure | undefined = loadPhase.result.failure;
    const isolationOutcome = loadPhase.isolation;

    const checkAborted = () => {
      if (input.signal?.aborted) {
        throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
      }
      const currentGen = this.ports.browser.getDocumentGeneration?.(activeTarget.tabId);
      if (typeof currentGen === 'number' && activeTarget.documentGeneration && currentGen !== activeTarget.documentGeneration) {
        throw new CapabilityError('TARGET_STALE', `Document generation advanced from ${activeTarget.documentGeneration} to ${currentGen}`, { cause: 'navigated-away' satisfies TargetStaleCause });
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
    // The screenshot is the one raster in this run; when it cannot be produced (a mobile page wider
    // than its viewport fails the scale check) the DOM detectors still report what they observed and
    // the missing raster becomes an evidence gap, never a thrown run with no report.
    this.assertOwnership(activeTarget);
    const dom = await this.ports.browser.dom(activeTarget, input.runId, input.attemptId);
    let screenshot: EvidenceCaptureEnvelope | undefined;
    try {
      screenshot = await this.ports.browser.screenshot(activeTarget, input.runId, input.attemptId);
    } catch (error) {
      rethrowTargetLifecycleError(error);
      const failure = captureEvidenceFailure(error);
      if (!failure) throw error;
      evidenceFailure ??= failure;
    }
    const evidence = { dom, screenshot };
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
    // Separate evidence incompleteness from observed failure (do not inject into diagnosticIssues)
    const evidenceGaps: string[] = [];
    if (evidenceFailure) {
      evidenceGaps.push(`Evidence capture failed (${evidenceFailure.code}): ${evidenceFailure.message}`);
    }
    if (settleMissingCapability) {
      evidenceGaps.push('Authoritative settlement capability missing (browser.settleCapture is not available on host); cannot certify authoritative PASS');
    }

    if (settleReceipt?.domUnstable) {
      const domUnstableGap = 'DOM mutations remained active during settle window (domUnstable)';
      if (!evidenceGaps.includes(domUnstableGap)) {
        evidenceGaps.push(domUnstableGap);
      }
    }
    if (Array.isArray(settleReceipt?.evidenceGaps)) {
      for (const gap of settleReceipt.evidenceGaps) {
        if (!evidenceGaps.includes(gap)) {
          evidenceGaps.push(gap);
        }
      }
    }
    if (mutationMissingBarrier && mutationBarrierError) {
      evidenceGaps.push(mutationBarrierError);
    }

    if (!rawHtml && !evidence.dom) {
      evidenceGaps.push('DOM inspection returned empty content; cannot certify page structure');
    }

    // 5. Liquid Error Scanning (RT-01 isolated script + fallback)
    await new Promise((r) => setImmediate(r));
    let liquidResult: LiquidScanResult = { hasErrors: false, errors: [], scannedElementsCount: 0 };
    let liquidScanRan = false;
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, LiquidErrorScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasErrors' in evalRes) {
        liquidResult = evalRes as LiquidScanResult;
        liquidScanRan = true;
      } else if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
        liquidScanRan = true;
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
        liquidScanRan = true;
      }
    }
    if (!liquidScanRan && !rawHtml) {
      evidenceGaps.push('Liquid syntax scanner could not execute: browser eval failed and no HTML source was available; cannot certify liquid clean');
    }
    // 6. Layout Overflow Engine (RT-06 sub-pixel deadband & RT-04 container limiting)
    let overflowResult: ViewportOverflowResult = {
      viewport: { name: 'desktop', width: 1440, height: 900 },
      measured: false,
      unmeasuredReason: 'No layout overflow measurement was obtained from the scanned tab',
      hasOverflow: false,
      deltaX: 0,
      scrollWidth: 1440,
      clientWidth: 1440,
      culprits: [],
    };
    let measuredViewport: { width: number; height: number; requestedWidth?: number | null; observedWidth?: number } | undefined;
    const settleTick = Promise.withResolvers<void>();
    setImmediate(settleTick.resolve);
    await settleTick.promise;
    try {
      if (typeof this.ports.browser.getViewport === 'function') {
        const vpInfo = await this.ports.browser.getViewport(activeTarget);
        if (vpInfo && typeof vpInfo.width === 'number' && vpInfo.width > 0 && typeof vpInfo.height === 'number' && vpInfo.height > 0) {
          const vpExtra = vpInfo as typeof vpInfo & { requestedWidth?: number | null; observedWidth?: number };
          measuredViewport = { width: vpInfo.width, height: vpInfo.height };
          if (typeof vpExtra.requestedWidth === 'number' || vpExtra.requestedWidth === null) measuredViewport.requestedWidth = vpExtra.requestedWidth;
          if (typeof vpExtra.observedWidth === 'number') measuredViewport.observedWidth = vpExtra.observedWidth;
          if (typeof vpExtra.requestedWidth === 'number' && typeof vpExtra.observedWidth === 'number' && Math.abs(vpExtra.requestedWidth - vpExtra.observedWidth) > 2) {
            evidenceGaps.push(`VIEWPORT_MISMATCH requested ${vpExtra.requestedWidth} observed ${vpExtra.observedWidth}: the emulated viewport did not take effect, so width-dependent rules were graded at the wrong width`);
          }
        }
      }
    } catch {}
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, LayoutOverflowEngine.getBrowserScanScript('active'));
      checkAborted();
      if (isValidViewportOverflowResult(evalRes)) {
        overflowResult = evalRes;
        if (!measuredViewport && overflowResult.viewport && overflowResult.viewport.width > 0 && overflowResult.viewport.height > 0) {
          measuredViewport = { width: overflowResult.viewport.width, height: overflowResult.viewport.height };
        }
      } else {
        // Unlike the other scanners there is no in-process HTML fallback for layout geometry:
        // a malformed or unmeasured response leaves no measurement evidence, so FAIL closed
        // instead of certifying PASS from the placeholder default.
        const unmeasuredReason = LayoutOverflowEngine.readUnmeasuredReason(evalRes);
        evidenceGaps.push(
          unmeasuredReason
            ? `Layout overflow not measured: ${unmeasuredReason}`
            : 'Layout overflow scanner did not return valid measurement object'
        );
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      evidenceGaps.push(`Layout overflow scanner evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 6.5 Layout Integrity Engine — overlap/clipping/occlusion/offscreen/sticky
    // + layout-shift witness on the ACTIVE viewport. A failed evaluation, a
    // truncated scan or a detector that threw is an evidence gap (non-PASS);
    // the geometry findings themselves never abort the run. It must run before the
    // multi-breakpoint sweep: every emulated resize leaves hadRecentInput layout
    // shifts in the buffer, which the witness would sum into a false CLS.
    let integrityResult: LayoutIntegrityResult | undefined;
    let integrityRan = false;
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, LayoutIntegrityEngine.getBrowserScanScript('active'));
      checkAborted();
      const rec = evalRes && typeof evalRes === 'object' ? (evalRes as Record<string, unknown>) : undefined;
      if (rec && Array.isArray(rec.findings)) {
        integrityResult = evalRes as LayoutIntegrityResult;
        integrityRan = true;
        if (integrityResult.measured === false) {
          const reason = LayoutIntegrityEngine.readUnmeasuredReason(evalRes);
          evidenceGaps.push(`Layout integrity not measured: ${reason || 'engine reported unmeasured'}`);
        }
        const stats = integrityResult.stats;
        if (stats?.truncated === true) {
          const reasons = Array.isArray(stats.truncatedReasons) ? stats.truncatedReasons.join('; ') : '';
          evidenceGaps.push(`Layout integrity scan truncated: ${reasons || 'no reason reported'}`);
        }
        if (stats && Array.isArray(stats.failedDetectors) && stats.failedDetectors.length > 0) {
          evidenceGaps.push(`Layout integrity detectors failed: ${[...new Set(stats.failedDetectors)].join(', ')}`);
        }
      } else if (rec && rec.measured === false) {
        const reason = LayoutIntegrityEngine.readUnmeasuredReason(evalRes);
        evidenceGaps.push(`Layout integrity not measured: ${reason || 'engine reported unmeasured'}`);
      }
      // A malformed or absent payload is simply unmeasured — the overflow engine's
      // marker contract requires an explicit `measured:false` to declare a gap, so
      // stale hosts and harness stubs don't fabricate missing evidence.
    } catch (error) {
      rethrowTargetLifecycleError(error);
      evidenceGaps.push(`Layout integrity scanner evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Captured for the per-width responsive map; stays undefined when the
    // multi-breakpoint sweep did not run or returned no breakpoint payload.
    const runMultiBreakpoint = input.multiBreakpoint !== false;
    let responsiveBreakpoints: Record<string, unknown> | undefined;
    if (runMultiBreakpoint) {
      if (typeof this.ports.browser.responsiveCheck === 'function') {
        try {
          // Each width also gets the integrity scan, read after the emulated width took effect. The
          // layout-shift witness is left out: a resize records shifts of its own.
          const sweepIntegrityScript = LayoutIntegrityEngine.getBrowserScanScript('sweep', { skipLayoutShift: true });
          // Under build-strict the touch widths also run the visual-quality scan, so tap targets are
          // graded from the sweep and the verdict never depends on the tab happening to be mobile-sized.
          const sweepScript = strictProfile
            ? `(() => { const reading = ${sweepIntegrityScript}; try { if (window.innerWidth <= 767) reading.visualQuality = ${VisualQualityScanner.getBrowserScanScript({ thresholds: effectiveThresholds, skipFloating: true })}; } catch (e) { reading.visualQualityError = String((e && e.message) || e); } return reading; })()`
            : sweepIntegrityScript;
          const responsive = await this.ports.browser.responsiveCheck({
            tabId: activeTarget.tabId,
            perWidthScript: sweepScript,
          });
          const isOk = !responsive || typeof responsive !== 'object' || (responsive as Record<string, unknown>).ok !== false;
          const breakpoints = responsive && typeof responsive === 'object' ? (responsive as Record<string, unknown>).breakpoints : undefined;
          responsiveBreakpoints = breakpoints && typeof breakpoints === 'object' ? breakpoints as Record<string, unknown> : undefined;
          if (!isOk) {
            const errMsg = (responsive as Record<string, unknown>).error;
            if (sweepGaps) {
              evidenceGaps.push(`Responsive multi-breakpoint sweep failed: ${typeof errMsg === 'string' ? errMsg : 'host returned ok: false'}`);
            }
          } else if (!breakpoints || typeof breakpoints !== 'object' || Object.keys(breakpoints).length === 0) {
            if (sweepGaps) {
              evidenceGaps.push('Responsive multi-breakpoint sweep returned no breakpoint measurements');
            }
          } else {
            const bpEntries = Object.entries(breakpoints);
            let hasMalformedBreakpoint = false;
            const unmeasuredWidths: unknown[] = [];
            const failing: Record<string, unknown>[] = [];
            for (const [, bp] of bpEntries) {
              if (bp && typeof bp === 'object' && (bp as Record<string, unknown>).emulationApplied === false) {
                unmeasuredWidths.push((bp as Record<string, unknown>).width);
              } else if (!bp || typeof bp !== 'object' || typeof (bp as Record<string, unknown>).hasHorizontalOverflow !== 'boolean') {
                hasMalformedBreakpoint = true;
              } else {
                const bpObj = bp as Record<string, unknown>;
                if (bpObj.hasHorizontalOverflow === true) {
                  failing.push(bpObj);
                }
              }
            }
            if (unmeasuredWidths.length > 0 && sweepGaps) {
              evidenceGaps.push(`Responsive multi-breakpoint sweep could not apply the emulated viewport at width(s) ${unmeasuredWidths.join(', ')}`);
            }
            if (hasMalformedBreakpoint && sweepGaps) {
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
                measured: true,
                hasOverflow: true,
                deltaX: typeof first.scrollWidth === 'number' && typeof first.clientWidth === 'number' ? Math.max(0, first.scrollWidth - first.clientWidth) : overflowResult.deltaX,
                scrollWidth: typeof first.scrollWidth === 'number' ? first.scrollWidth : overflowResult.scrollWidth,
                clientWidth: typeof first.clientWidth === 'number' ? first.clientWidth : overflowResult.clientWidth,
              };
              // The sweep measured this viewport, so the placeholder's reason is stale.
              delete overflowResult.unmeasuredReason;
            }
          }
        } catch (error) {
          rethrowTargetLifecycleError(error);
          if (sweepGaps) {
            evidenceGaps.push(`Responsive multi-breakpoint sweep failed or unsupported: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else if (sweepGaps) {
        evidenceGaps.push('Responsive multi-breakpoint sweep unsupported: responsiveCheck capability missing on browser port');
      }
    }

    const integrityFindings: LayoutIntegrityFinding[] = integrityResult && Array.isArray(integrityResult.findings) ? integrityResult.findings : [];
    const integrityCriticals = integrityFindings.filter((f) => f.severity === 'critical');
    const integrityAmbiguities = integrityFindings
      .filter((f) => f.severity === 'warning')
      .map((f) => `[${f.kind}] ${f.selector ? `${f.selector} — ` : ''}${f.details}`);

    // Per-breakpoint responsive contract: QA_RESPONSIVE_WIDTHS. The
    // multi-breakpoint sweep (runResponsiveCheck) measures document-level
    // horizontal overflow by width. Integrity counts are null for every width
    // other than the one the integrity scan measured; widths the sweep did not
    // return report documentOverflow: null.
    const responsiveMap: NonNullable<ThemeQaDetailedFindings['responsive']> = {};
    const countKind = (findings: LayoutIntegrityFinding[], kind: LayoutIntegrityFinding['kind'], severity: LayoutIntegrityFinding['severity']): number =>
      findings.filter((f) => f.kind === kind && f.severity === severity).length;
    const bpByWidth = new Map<number, Record<string, unknown>>();
    if (responsiveBreakpoints && typeof responsiveBreakpoints === 'object') {
      for (const value of Object.values(responsiveBreakpoints)) {
        if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).width === 'number') {
          bpByWidth.set((value as Record<string, unknown>).width as number, value as Record<string, unknown>);
        }
      }
    }
    const integrityWidth = integrityResult?.measured === true ? integrityResult.viewport?.width : undefined;
    const activeCriticalKeys = new Set<string>();
    for (const f of integrityCriticals) {
      activeCriticalKeys.add(`${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`);
    }
    const sweepIntegrityCriticals: Array<{ width: number; finding: LayoutIntegrityFinding }> = [];
    const sweepSpacingFindings: Array<{ width: number; finding: LayoutIntegrityFinding }> = [];
    const sweepVisualQuality = new Map<number, VisualQualityScanResult>();
    const unmeasuredIntegrityWidths: number[] = [];
    const truncatedOrFailedIntegrityWidths: number[] = [];
    for (const w of QA_RESPONSIVE_WIDTHS) {
      const bp = bpByWidth.get(w);
      const docOverflow = bp && typeof bp.hasHorizontalOverflow === 'boolean' ? bp.hasHorizontalOverflow : null;
      // The reading taken at this width by the sweep wins; the active-viewport scan only stands in
      // for the width it was taken at when the sweep carried no usable reading.
      let atWidth: LayoutIntegrityFinding[] | null = null;
      const sweepIntegrity = bp ? bp.integrity : undefined;
      if (sweepIntegrity && typeof sweepIntegrity === 'object' && 'measured' in sweepIntegrity) {
        if (sweepIntegrity.measured === true && 'findings' in sweepIntegrity && Array.isArray(sweepIntegrity.findings)) {
          const validFindings = sweepIntegrity.findings.filter((f: unknown): f is LayoutIntegrityFinding => !!f && typeof f === 'object' && 'kind' in f && 'severity' in f);
          atWidth = validFindings;
          if ('visualQuality' in sweepIntegrity) {
            sweepVisualQuality.set(w, VisualQualityScanner.normalize(sweepIntegrity.visualQuality));
          }
          const sStats = 'stats' in sweepIntegrity && sweepIntegrity.stats && typeof sweepIntegrity.stats === 'object'
            ? (sweepIntegrity.stats as LayoutIntegrityResult['stats'])
            : undefined;
          if (sStats?.truncated === true || (Array.isArray(sStats?.failedDetectors) && sStats.failedDetectors.length > 0)) {
            truncatedOrFailedIntegrityWidths.push(w);
          }
          for (const f of validFindings) {
            if (f.severity === 'critical') {
              const key = `${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`;
              if (w === integrityWidth && activeCriticalKeys.has(key)) continue;
              sweepIntegrityCriticals.push({ width: w, finding: f });
            } else if (f.severity === 'warning' && w !== integrityWidth) {
              integrityAmbiguities.push(`[${f.kind}@${w}] ${f.selector ? `${f.selector} — ` : ''}${f.details}`);
              if (f.kind === 'spacing') sweepSpacingFindings.push({ width: w, finding: f });
            }
          }
        } else {
          unmeasuredIntegrityWidths.push(w);
        }
      }
      if (atWidth === null && integrityWidth === w) atWidth = integrityFindings;
      responsiveMap[String(w)] = {
        documentOverflow: docOverflow,
        criticalOverflow: docOverflow === null ? null : (docOverflow ? 1 : 0),
        criticalOverlap: atWidth ? countKind(atWidth, 'overlap', 'critical') : null,
        criticalClipping: atWidth ? countKind(atWidth, 'clipping', 'critical') : null,
        criticalOcclusion: atWidth ? countKind(atWidth, 'occlusion', 'critical') : null,
        criticalOffscreen: atWidth ? countKind(atWidth, 'offscreen', 'critical') + countKind(atWidth, 'zero-size', 'critical') : null,
        spacingWarnings: atWidth ? countKind(atWidth, 'spacing', 'warning') : null,
        ...(atWidth && atWidth.length > 0 ? { findings: atWidth } : {}),
      };
    }
    if (unmeasuredIntegrityWidths.length > 0 && sweepGaps) {
      evidenceGaps.push(`Responsive layout integrity not measured at width(s) ${unmeasuredIntegrityWidths.join(', ')}`);
    }
    if (truncatedOrFailedIntegrityWidths.length > 0 && sweepGaps) {
      evidenceGaps.push(`Responsive layout integrity truncated or detector failed at width(s) ${truncatedOrFailedIntegrityWidths.join(', ')}`);
    }
    // A declared greenfield run certifies only widths this run measured: each representative
    // width needs both the document-overflow reading and the layout-integrity reading.
    if (greenfieldReason !== undefined) {
      for (const name of GREENFIELD_VIEWPORT_NAMES) {
        const width = GREENFIELD_VIEWPORT_WIDTHS[name];
        if (!greenfieldWidthMeasured(responsiveMap[String(width)])) {
          evidenceGaps.push(`Greenfield ${name} viewport (${width}px) was not measured by the responsive sweep (overflow and layout integrity are both required); it cannot be certified`);
        }
      }
    }

    // 7. Broken Asset Telemetry (DOM + CDP Network Correlation)
    let assetResult: BrokenAssetScanResult = {
      hasBrokenAssets: false,
      brokenAssets: [],
      totalImagesScanned: 0,
      totalStylesheetsScanned: 0,
    };
    let assetScanRan = false;
    let documentStatus: number | undefined;
    await new Promise((r) => setImmediate(r));
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, BrokenAssetScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasBrokenAssets' in evalRes) {
        assetResult = evalRes as BrokenAssetScanResult;
        assetScanRan = true;
      }
      const diagnostics = freshDiagnostics;
      if (diagnostics && Array.isArray(diagnostics.failures) && diagnostics.failures.length > 0) {
        const mappedFailures = extractCorrelatableAssetFailures(diagnostics.failures, contextUrl);
        assetResult = BrokenAssetScanner.correlateWithNetworkFailures(assetResult, mappedFailures);
        documentStatus = extractDocumentHttpStatus(diagnostics.failures, contextUrl);
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
    const targetUrl = 'url' in input.target && typeof input.target.url === 'string' ? input.target.url : '';
    const activeTargetUrl = 'url' in activeTarget && typeof activeTarget.url === 'string' ? activeTarget.url : '';
    const mainFrame404Failure = Array.isArray(freshDiagnostics.failures)
      ? freshDiagnostics.failures.find((f) => Boolean(f && f.isMainFrame === true && f.status === 404))
      : undefined;
    const mainFrame404RawUrl =
      mainFrame404Failure && typeof mainFrame404Failure.validatedURL === 'string' && mainFrame404Failure.validatedURL
        ? mainFrame404Failure.validatedURL
        : mainFrame404Failure && 'url' in mainFrame404Failure && typeof mainFrame404Failure.url === 'string'
          ? mainFrame404Failure.url
          : '';
    const doc404Url = mainFrame404RawUrl || contextUrl || targetUrl;
    const isIntentional404Route = input.expectedDocumentStatus === 404 || [doc404Url, contextUrl, targetUrl].some(
      (u) => typeof u === 'string' && /\/404(?:[/?#]|$)/i.test(u)
    );
    if (documentStatus === 404 && doc404Url && !isIntentional404Route) {
      diagnosticIssues.push({
        kind: 'network',
        origin: doc404Url,
        message: `ROUTE_404: Document returned HTTP 404 on non-/404 route (${doc404Url})`,
      });
    }
    const requestedRouteUrl =
      targetUrl && AUTH_ROUTE_RE.test(targetUrl)
        ? targetUrl
        : targetUrl && !AUTH_ROUTE_RE.test(targetUrl) && (!preReloadContextUrl || AUTH_ROUTE_RE.test(preReloadContextUrl))
          ? targetUrl
          : preReloadContextUrl || targetUrl;
    const landedRouteUrl = contextUrl || activeTargetUrl;
    if (
      requestedRouteUrl &&
      landedRouteUrl &&
      !AUTH_ROUTE_RE.test(requestedRouteUrl) &&
      AUTH_ROUTE_RE.test(landedRouteUrl)
    ) {
      const authMsg = `AUTH_REDIRECT: Route '${requestedRouteUrl}' redirected to authentication page '${landedRouteUrl}'`;
      diagnosticWarnings.push({
        kind: 'network',
        origin: landedRouteUrl,
        message: authMsg,
      });
      if (!evidenceGaps.includes(authMsg)) {
        evidenceGaps.push(authMsg);
      }
    }
    // Pre-reload diagnostics classification (audit-only evidence)
    const preReloadDiagResult = classifyDiagnostics(preReloadDiagnostics, preReloadContextUrl);
    const preReloadCritical: DiagnosticIssue[] = preReloadDiagResult.criticalIssues;
    const preReloadWarningsList: DiagnosticIssue[] = preReloadDiagResult.warnings;
    // 9. Platform-scoped HS gate evaluation
    await new Promise((r) => setImmediate(r));
    let hsResult: HsEvaluationResult = { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    let hsScanRan = false;
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, HsGateRules.getBrowserEvaluationScript(detectedPlatform));
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'passed' in evalRes) {
        hsResult = evalRes as HsEvaluationResult;
        hsScanRan = true;
      } else if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
        hsScanRan = true;
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        hsResult = HsGateRules.evaluateHtml(rawHtml, detectedPlatform);
        hsScanRan = true;
      }
    }
    if (!hsScanRan && !rawHtml) {
      evidenceGaps.push('Platform compliance scanner could not execute: browser eval failed and no HTML source was available; cannot certify platform compliance');
    }

    // 9.5 Server Crash Scanner (Haravan 500, Shopify 500, Sapo 500, Cloudflare 5xx)
    let serverCrashResult: ServerCrashScanResult = { hasCrash: false, errorsCount: 0, findings: [] };
    let serverCrashScanRan = false;
    await new Promise((r) => setImmediate(r));
    try {
      checkAborted();
      const evalRes = await this.ports.browser.eval(activeTarget, ServerCrashScanner.getBrowserScanScript());
      checkAborted();
      if (evalRes && typeof evalRes === 'object' && 'hasCrash' in evalRes) {
        serverCrashResult = evalRes as ServerCrashScanResult;
        serverCrashScanRan = true;
      } else if (rawHtml) {
        serverCrashResult = ServerCrashScanner.scanHtmlString(rawHtml);
        serverCrashScanRan = true;
      }
    } catch (error) {
      rethrowTargetLifecycleError(error);
      if (rawHtml) {
        serverCrashResult = ServerCrashScanner.scanHtmlString(rawHtml);
        serverCrashScanRan = true;
      }
    }
    if (!serverCrashScanRan && !rawHtml) {
      evidenceGaps.push('Server crash scanner could not execute: browser eval failed and no HTML source was available; cannot certify server status');
    }

    // 9.6 DOM Semantics Scanner (SEO, a11y, heading hierarchy, meta tags, JSON-LD)
    let domSemanticsResult: DomSemanticsScanResult | undefined;
    let domSemanticsRan = false;
    await new Promise((r) => setImmediate(r));
    if (typeof this.ports.browser.eval === 'function') {
      try {
        checkAborted();
        const evalRes = await this.ports.browser.eval(activeTarget, DomSemanticsScanner.getBrowserScanScript());
        checkAborted();
        if (evalRes && typeof evalRes === 'object' && 'summary' in evalRes) {
          domSemanticsResult = evalRes as DomSemanticsScanResult;
          domSemanticsRan = true;
          if (domSemanticsResult.measured === false) {
            evidenceGaps.push('DOM semantics not measured: scanner reported measured: false');
          }
        } else if (evalRes && typeof evalRes === 'object' && (evalRes as Record<string, unknown>).measured === false) {
          evidenceGaps.push('DOM semantics not measured: scanner reported measured: false');
        }
      } catch (error) {
        rethrowTargetLifecycleError(error);
        evidenceGaps.push(`DOM semantics scanner evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 9.7 Visual quality (contrast, tap targets, floating widgets, registry rules). Reported in every
    // profile; only build-strict lets it carry the verdict, so audit runs keep their existing contract.
    const waivers: QaWaiver[] = Array.isArray(input.waivers) ? input.waivers : [];
    let visualQualityResult: VisualQualityScanResult | undefined;
    await new Promise((r) => setImmediate(r));
    if (typeof this.ports.browser.eval === 'function') {
      try {
        checkAborted();
        const vqOptions = { thresholds: effectiveThresholds };
        const evalRes = await this.ports.browser.eval(activeTarget, VisualQualityScanner.getBrowserScanScript(vqOptions), undefined, undefined, { timeoutMs: visualQualityEvalTimeoutMs(vqOptions) });
        checkAborted();
        visualQualityResult = VisualQualityScanner.normalize(evalRes);
      } catch (error) {
        rethrowTargetLifecycleError(error);
        visualQualityResult = VisualQualityScanner.normalize({ error: `VISUAL_QUALITY_EVAL_FAILED: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const mobileSweepWidth = sweepVisualQuality.get(375)?.measured === true ? 375 : sweepVisualQuality.get(320)?.measured === true ? 320 : undefined;
    const mobileSweepReading = mobileSweepWidth !== undefined ? sweepVisualQuality.get(mobileSweepWidth) : undefined;
    if (mobileSweepReading && mobileSweepWidth !== undefined && visualQualityResult?.mobile !== true) {
      visualQualityResult = mergeMobileVisualQuality(visualQualityResult, mobileSweepReading, mobileSweepWidth);
    }
    if (resolvedThresholds.note) {
      integrityAmbiguities.push(`[thresholds] contract ignored, built-in thresholds used: ${resolvedThresholds.note}`);
    }
    if (strictProfile && visualQualityResult?.measured !== true) {
      evidenceGaps.push(`Visual quality not measured under build-strict: ${visualQualityResult?.error || 'scanner unavailable'}`);
    }
    if (strictProfile && visualQualityResult?.measured === true && visualQualityResult.mobile !== true) {
      // Tap targets are graded at mobile widths only; a desktop-width run cannot vouch for them.
      evidenceGaps.push(`Tap targets not graded under build-strict: this run measured ${visualQualityResult.viewport.width}px and the mobile sweep reading is missing; validate a mobile viewport (<= 767px) to certify them`);
    }
    const timedWidgets = visualQualityResult?.measured === true ? visualQualityResult.stats.timedWidgets : undefined;
    if (timedWidgets && timedWidgets.appeared === 0) {
      // A theme may keep its popup hidden on purpose while it would cover content, so an unseen
      // popup is reported, not counted as an evidence gap that no re-run could clear.
      integrityAmbiguities.push(`[timed-widget] ${timedWidgets.selectors.join(', ')} stayed hidden for ${timedWidgets.waitedMs}ms; its overlap when shown was not graded`);
    }
    let imageFrameResult: ImageFrameScanResult | undefined;
    if (typeof this.ports.browser.eval === 'function') {
      try {
        checkAborted();
        const evalRes = await this.ports.browser.eval(activeTarget, ImageFrameScanner.getBrowserScanScript());
        checkAborted();
        imageFrameResult = ImageFrameScanner.normalize(evalRes);
      } catch (error) {
        rethrowTargetLifecycleError(error);
        imageFrameResult = ImageFrameScanner.normalize({ error: `IMAGE_FRAME_EVAL_FAILED: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (strictProfile && imageFrameResult?.measured !== true) {
      evidenceGaps.push(`Image frame not measured under build-strict: ${imageFrameResult?.error || 'scanner unavailable'}`);
    }
    const waivedRules = new Set(waivers.map((w) => w.rule));
    const strictVisualFailures: Array<VisualQualityFinding | ImageFrameFinding> = strictProfile
      ? [
          ...(visualQualityResult?.measured === true ? visualQualityResult.findings : []),
          ...(imageFrameResult?.measured === true ? imageFrameResult.findings : []),
        ].filter((f) =>
          !waivedRules.has(f.ruleId) &&
          (STRICT_REGISTRY_RULES[f.ruleId] === true ||
            f.ruleId === 'contrast-low' ||
            f.ruleId === 'tap-target-tiny' ||
            f.ruleId === 'invisible-click-blocker' ||
            (f.ruleId === 'floating-widget-overlap' && f.measured?.coveredIsControl === true)))
      : [];
    const isStrictSpacing = (f: LayoutIntegrityFinding): boolean =>
      f.kind === 'spacing' && typeof f.ruleId === 'string' && STRICT_SPACING_RULES[f.ruleId] === true && !waivedRules.has(f.ruleId);
    const strictSpacingFailures: Array<{ width: number | null; finding: LayoutIntegrityFinding }> = strictProfile
      ? [
          ...integrityFindings.filter(isStrictSpacing).map((finding) => ({ width: integrityWidth ?? null, finding })),
          ...sweepSpacingFindings.filter(({ finding }) => isStrictSpacing(finding)),
        ]
      : [];

    // Overlays are driven open and shut with trusted input, which a static scan cannot see: an
    // unclosable drawer or an unstyled modal passes every other check on this page.
    let stateMatrixResult: StateMatrixResult | undefined;
    let stateMatrixMeasured = false;
    const stateMatrixFailures: Array<{ trigger: string; code: string; message: string }> = [];
    if (strictProfile) {
      if (typeof this.ports.browser.stateMatrix === 'function') {
        try {
          checkAborted();
          const onProduct = /\/products\/[^/?#]+/i.test(activeTargetUrl || contextUrl || targetUrl);
          const res = await this.ports.browser.stateMatrix(activeTarget, { maxTriggers: 6, ...(onProduct ? { autoPopulate: 'pdp' as const } : {}) }, input.signal);
          checkAborted();
          stateMatrixResult = res;
          if (res.measured || res.error === 'NO_OVERLAY_TRIGGERS_FOUND') {
            stateMatrixMeasured = true;
          } else {
            evidenceGaps.push(`State matrix not measured under build-strict: ${res.error || `${res.summary?.notRun ?? 0} overlay(s) were not run`}`);
          }
          for (const trig of res.triggers ?? []) {
            for (const failure of trig.failures) {
              if (failure.severity === 'critical') stateMatrixFailures.push({ trigger: trig.trigger, code: failure.code, message: failure.message });
            }
          }
        } catch (error) {
          rethrowTargetLifecycleError(error);
          evidenceGaps.push(`State matrix failed under build-strict: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        evidenceGaps.push('State matrix unsupported under build-strict: stateMatrix capability missing on browser port');
      }
    }

    // Restore paused sliders and unfreeze media after in-page scanning has finished
    if (typeof this.ports.browser.eval === 'function') {
      try {
        const resumeSlidersScript = `(() => {
          try {
            if (Array.isArray(window.__antifanPausedSliders)) {
              window.__antifanPausedSliders.forEach((item) => {
                try {
                  if (item.type === 'swiper' && item.swiper?.autoplay && typeof item.swiper.autoplay.start === 'function') {
                    item.swiper.autoplay.start();
                  } else if (item.type === 'slick' && typeof window.jQuery === 'function' && item.el) {
                    window.jQuery(item.el).slick('slickPlay');
                  }
                } catch {}
              });
              delete window.__antifanPausedSliders;
            }
          } catch {}
        })()`;
        await this.ports.browser.eval(activeTarget, resumeSlidersScript);
      } catch {}
    }
    if (typeof this.ports.browser.freezeMedia === 'function') {
      try {
        await this.ports.browser.freezeMedia(activeTarget, { freeze: false, normalizeSliders: false });
      } catch {}
    }

    // Which theme the storefront served for this run: the receipt needs it to tell a re-run of the
    // same theme from a run against a different one. Unreadable stays undefined, never a guess.
    let storefrontTheme: ThemeQaStorefrontTheme | undefined;
    if (typeof this.ports.browser.eval === 'function') {
      try {
        const themeReading = await this.ports.browser.eval(activeTarget, STOREFRONT_THEME_SCRIPT);
        storefrontTheme = normalizeStorefrontTheme(themeReading);
      } catch (error) {
        rethrowTargetLifecycleError(error);
      }
    }
    if (storefrontTheme && storefrontTheme.id !== undefined) {
      const previousThemeId = readPreviousStorefrontThemeId(input.workspaceRoot);
      if (previousThemeId !== undefined) {
        storefrontTheme = { ...storefrontTheme, changedSincePreviousRun: previousThemeId !== String(storefrontTheme.id) };
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
        const bfActiveWidth = bf.layoutIntegrity?.measured === true ? bf.layoutIntegrity.viewport?.width : undefined;
        const bfActiveCriticalKeys = new Set<string>();
        if (bf.layoutIntegrity?.findings) {
          for (const f of bf.layoutIntegrity.findings) {
            if (f.severity !== 'critical') continue;
            bfActiveCriticalKeys.add(`${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`);
            preItems.push({
              category: 'layout_integrity',
              signature: `layout_integrity:${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`,
              severity: 'critical',
              message: `Layout integrity ${f.kind}: ${f.details}`,
              details: { kind: f.kind, selector: f.selector, rect: f.rect },
            });
          }
        }
        if (bf.responsive) {
          for (const [wKey, rEntry] of Object.entries(bf.responsive)) {
            if (rEntry?.findings) {
              const wNum = Number(wKey);
              for (const f of rEntry.findings) {
                if (f.severity !== 'critical') continue;
                const key = `${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`;
                if (wNum === bfActiveWidth && bfActiveCriticalKeys.has(key)) continue;
                preItems.push({
                  category: 'layout_integrity',
                  signature: `layout_integrity@${wKey}:${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`,
                  severity: 'critical',
                  message: `Layout integrity ${f.kind} (${wKey}px): ${f.details}`,
                  details: { kind: f.kind, width: wNum, selector: f.selector, rect: f.rect },
                });
              }
            }
          }
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
      ...integrityCriticals.map((f): ThemeQaIssueItem => ({
        category: 'layout_integrity',
        signature: `layout_integrity:${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`,
        severity: 'critical',
        message: `Layout integrity ${f.kind}: ${f.details}`,
        details: { kind: f.kind, selector: f.selector, rect: f.rect },
      })),
      ...sweepIntegrityCriticals.map(({ width, finding: f }): ThemeQaIssueItem => ({
        category: 'layout_integrity',
        signature: `layout_integrity@${width}:${f.kind}:${f.selector || ''}:${f.details.slice(0, 80)}`,
        severity: 'critical',
        message: `Layout integrity ${f.kind} (${width}px): ${f.details}`,
        details: { kind: f.kind, width, selector: f.selector, rect: f.rect },
      })),
      ...strictVisualFailures.map((f): ThemeQaIssueItem => ({
        category: 'visual_quality',
        signature: `visual_quality:${f.ruleId}:${f.selector || ''}:${f.details.slice(0, 80)}`,
        severity: 'critical',
        message: `Visual quality ${f.ruleId}: ${f.details}`,
        details: { ruleId: f.ruleId, selector: f.selector, rect: f.rect },
      })),
      ...strictSpacingFailures.map(({ width, finding: f }): ThemeQaIssueItem => ({
        category: 'layout_integrity',
        signature: `layout_integrity${width === null ? '' : `@${width}`}:${f.ruleId}:${f.selector || ''}:${f.details.slice(0, 80)}`,
        severity: 'critical',
        message: `Layout integrity ${f.ruleId}${width === null ? '' : ` (${width}px)`}: ${f.details}`,
        details: { kind: f.kind, ruleId: f.ruleId, width, selector: f.selector, rect: f.rect },
      })),
      ...stateMatrixFailures.map((f): ThemeQaIssueItem => ({
        category: 'state_matrix',
        signature: `state_matrix:${f.trigger}:${f.code}`,
        severity: 'critical',
        message: `Overlay ${f.trigger}: ${f.code} - ${f.message}`,
        details: { trigger: f.trigger, code: f.code },
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
    const attribution = buildAttribution(differential, effectiveBaselineFindings !== undefined);
    const preReloadDiagnosticsObj =
      preReloadCritical.length > 0 || preReloadWarningsList.length > 0
        ? {
            criticalIssues: preReloadCritical,
            warnings: preReloadWarningsList,
          }
        : undefined;
    // 10. Compute authoritative checklist statuses (owned strictly by the engine).
    const measuredResponsiveCount = Array.from(bpByWidth.values()).filter(
      (bp) => typeof bp.hasHorizontalOverflow === 'boolean'
    ).length;
    const hasResponsiveOverflow = Array.from(bpByWidth.values()).some(
      (bp) => bp.hasHorizontalOverflow === true
    );
    const responsiveChecklistStatus: boolean | 'UNMEASURED' =
      measuredResponsiveCount === 0 ? 'UNMEASURED' : (!hasResponsiveOverflow && !overflowResult.hasOverflow);

    const checklist: ThemeQaReport['checklist'] = {
      layout: !overflowResult.hasOverflow && integrityCriticals.length === 0 && sweepIntegrityCriticals.length === 0,
      responsive: responsiveChecklistStatus,
      overflow: !overflowResult.hasOverflow,
      diagnostics: !liquidResult.hasErrors && !assetResult.hasBrokenAssets && !serverCrashResult.hasCrash && diagnosticIssues.length === 0,
      liquidClean: !liquidResult.hasErrors,
      assetsValid: !assetResult.hasBrokenAssets,
      hsCompliant: hsResult.passed,
    };

    // Filter which checks participate in the overall summary verdict if caller specified enabled checks.
    // Only measured entries participate: an absent entry is an unmeasured dimension, and letting
    // `undefined` into this list would read as a definite failure.
    const activeChecklistEntries: boolean[] = [];
    const enabled = input.enabledChecks;
    const pushMeasured = (value: boolean | 'UNMEASURED' | undefined): void => {
      if (typeof value === 'boolean') activeChecklistEntries.push(value);
    };
    // A caller that explicitly enables a check this workflow cannot measure has a
    // missing-evidence gap, not an observed failure.
    const explicitlyRequestedUnmeasured: string[] = [];
    if (enabled) {
      if (enabled.layout !== false) pushMeasured(checklist.layout);
      if (enabled.responsive !== false) {
        pushMeasured(checklist.responsive);
        if (enabled.responsive === true && typeof checklist.responsive !== 'boolean') {
          explicitlyRequestedUnmeasured.push('responsive');
        }
      }
      if (enabled.overflow !== false) pushMeasured(checklist.overflow);
      if (enabled.interactions !== false) {
        pushMeasured(checklist.interactions);
        if (enabled.interactions === true && typeof checklist.interactions !== 'boolean') {
          explicitlyRequestedUnmeasured.push('interactions');
        }
      }
      if (enabled.diagnostics !== false) pushMeasured(checklist.diagnostics);
      if (enabled.liquidClean !== false) pushMeasured(checklist.liquidClean);
      if (enabled.assetsValid !== false) pushMeasured(checklist.assetsValid);
      if (enabled.hsCompliant !== false) pushMeasured(checklist.hsCompliant);
    } else {
      for (const value of Object.values(checklist)) pushMeasured(value);
    }
    if (explicitlyRequestedUnmeasured.length > 0) {
      evidenceGaps.push(
        `Requested check(s) not measured by this workflow: ${explicitlyRequestedUnmeasured.join(', ')}; cannot certify a verdict for them`
      );
    }

    const overflowIssueCount = overflowResult.culprits.length > 0 ? overflowResult.culprits.length : (overflowResult.hasOverflow ? 1 : 0);
    const totalIssues =
      liquidResult.errors.length +
      overflowIssueCount +
      assetResult.brokenAssets.length +
      hsResult.totalViolations +
      serverCrashResult.errorsCount +
      diagnosticIssues.length +
      diagnosticWarnings.length +
      integrityFindings.length +
      sweepIntegrityCriticals.length +
      strictVisualFailures.length +
      strictSpacingFailures.length +
      stateMatrixFailures.length;
    // Observed defects verdict only for checks the caller kept enabled; `enabledChecks` remains a
    // verdict filter, while engine checklist authority is preserved separately in `checklist`.
    const checkParticipates = (key: keyof ThemeQaChecklist): boolean => !enabled || enabled[key] !== false;
    if (input.multiBreakpoint === true && checkParticipates('responsive') && responsiveChecklistStatus === 'UNMEASURED') {
      evidenceGaps.push('Responsive viewports unmeasured: multiBreakpoint sweep was not run or returned no viewports; cannot certify responsive pass');
    }
    // Coverage: the scan families this run was expected to measure versus the ones that produced
    // evidence. An explicit multiBreakpoint:false opt-out narrows the declared scope, never the floor.
    const measuredDimensions: Array<[string, boolean]> = [
      ['liquid', liquidScanRan],
      ['layout-overflow', overflowResult.measured === true],
      ['assets', assetScanRan],
      ['hs-gate', hsScanRan],
      ['diagnostics', true], // diagnostics classification always runs on whatever payload exists
      ['layout-integrity', integrityRan && integrityResult?.measured === true],
      ...(input.multiBreakpoint === false ? [] : [['responsive', measuredResponsiveCount > 0] as [string, boolean]]),
      ['dom-semantics', domSemanticsRan && domSemanticsResult?.measured === true],
      ...(strictProfile ? [['state-matrix', stateMatrixMeasured] as [string, boolean]] : []),
    ];
    const measuredDimensionNames = measuredDimensions.filter(([, ok]) => ok).map(([name]) => name);
    const coverage = { measured: measuredDimensionNames.length, expected: measuredDimensions.length };
    const coverageFloor = Math.min(1, Math.max(0, input.coverageFloor ?? (strictProfile ? 1 : 0)));
    if (coverage.expected > 0 && coverage.measured / coverage.expected < coverageFloor) {
      const missed = measuredDimensions.filter(([, ok]) => !ok).map(([name]) => name).join(', ');
      evidenceGaps.push(`Coverage ${coverage.measured}/${coverage.expected} scan families is below the floor ${coverageFloor}; unmeasured: ${missed}`);
    }
    const hasObservedFailure =
      (checkParticipates('liquidClean') && liquidResult.hasErrors) ||
      ((checkParticipates('layout') || checkParticipates('responsive') || checkParticipates('overflow')) && overflowResult.hasOverflow) ||
      (checkParticipates('responsive') && hasResponsiveOverflow) ||
      (checkParticipates('assetsValid') && assetResult.hasBrokenAssets) ||
      (checkParticipates('hsCompliant') && hsResult.errorsCount > 0) ||
      serverCrashResult.hasCrash ||
      diagnosticIssues.length > 0 ||
      // Critical geometry defects are storefront failures, not evidence gaps —
      // an occluded Add-to-Cart fails verification regardless of settle state.
      // They belong to the `layout` check, the same key checklist.layout carries.
      (checkParticipates('layout') && (integrityCriticals.length > 0 || sweepIntegrityCriticals.length > 0)) ||
      // Opt-in only: under the default audit profile this list is always empty.
      strictVisualFailures.length > 0 ||
      strictSpacingFailures.length > 0 ||
      stateMatrixFailures.length > 0;
    const hasMissingEvidence =
      settleMissingCapability ||
      mutationMissingBarrier ||
      evidenceGaps.length > 0 ||
      activeChecklistEntries.length === 0 ||
      integrityResult?.measured === false ||
      domSemanticsResult?.measured === false;

    let summaryVerdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'PASS';
    if (hasObservedFailure) {
      summaryVerdict = 'FAIL';
    } else if (hasMissingEvidence) {
      summaryVerdict = 'INCONCLUSIVE';
    } else if (activeChecklistEntries.length > 0 && !activeChecklistEntries.every(Boolean)) {
      summaryVerdict = 'FAIL';
    }

    if (settleReceipt?.domUnstable === true && summaryVerdict === 'PASS') {
      summaryVerdict = 'INCONCLUSIVE';
    }

    const pageCriticalCount =
      hsResult.errorsCount +
      liquidResult.errors.length +
      serverCrashResult.errorsCount +
      diagnosticIssues.length +
      overflowIssueCount +
      assetResult.brokenAssets.length +
      integrityCriticals.length +
      sweepIntegrityCriticals.length +
      strictVisualFailures.length +
      strictSpacingFailures.length +
      stateMatrixFailures.length;
    const resolvedAnnotationTarget =
      input.annotationTargetSelector && input.annotationTargetSelector.trim()
        ? {
            selector: input.annotationTargetSelector.trim(),
            ...(input.annotationDomAncestry ? { domAncestry: input.annotationDomAncestry } : {}),
          }
        : resolveAnnotationTargetSelector(input.workspaceRoot, input.annotationId);
    const scopeFindings: ThemeQaDetailedFindings = {
      platform: platformResult,
      liquid: liquidResult,
      overflow: overflowResult,
      assets: assetResult,
      hsRules: hsResult,
      serverCrash: serverCrashResult,
      diagnosticIssues,
      diagnosticWarnings,
      ...(effectiveBaselineFindings ? { differential } : {}),
      ...(integrityResult ? { layoutIntegrity: integrityResult } : {}),
      responsive: responsiveMap,
    } as ThemeQaDetailedFindings;
    // Selector text cannot tell whether `p.price` sits inside the annotated card; the page can.
    let scopeContainment: Record<string, boolean> | null = null;
    if (resolvedAnnotationTarget) {
      const scopeSelectors = collectScopeSelectors(scopeFindings);
      if (scopeSelectors.length > 0) {
        try {
          const reading = await this.ports.browser.eval(activeTarget, buildScopeContainmentScript(resolvedAnnotationTarget.selector, scopeSelectors));
          if (reading && typeof reading === 'object' && !Array.isArray(reading)) scopeContainment = reading as Record<string, boolean>;
        } catch {
          // No live reading: the selector matcher decides, failing closed on anonymous selectors.
        }
      }
    }
    const scopedCriticalCount: number | null | undefined =
      input.annotationId || resolvedAnnotationTarget
        ? resolvedAnnotationTarget
          ? computeScopedCriticalCount(
              scopeFindings,
              resolvedAnnotationTarget.selector,
              resolvedAnnotationTarget.domAncestry,
              undefined,
              scopeContainment
            )
          : null
        : undefined;
    const summary: ThemeQaSummary = {
      passed: summaryVerdict === 'PASS',
      verdict: summaryVerdict,
      totalIssues,
      criticalCount: pageCriticalCount,
      pageCriticalCount,
      ...(scopedCriticalCount !== undefined ? { scopedCriticalCount } : {}),
      ...(settleReceipt?.domUnstable ? { domUnstable: true } : {}),
      ...(checklist.responsive !== undefined ? { responsive: checklist.responsive } : {}),
      ...(documentStatus !== undefined ? { documentStatus } : {}),
      ...(measuredViewport ? { viewport: measuredViewport } : {}),
      thresholdsSource: resolvedThresholds.source,
    };

    // Resilient axes: verification is the storefront verdict; execution is
    // DEGRADED whenever evidence is incomplete but the run still completed —
    // BLOCKED is only reachable via a thrown terminal path (receipt records it).
    const verificationAxis: QaVerification = summaryVerdict;
    const executionAxis: QaExecution = hasMissingEvidence ? 'DEGRADED' : 'COMPLETED';
    const measuredDims = [
      liquidScanRan,
      overflowResult.measured === true,
      assetScanRan,
      hsScanRan,
      true, // diagnostics classification always runs on whatever payload exists
      integrityRan && integrityResult?.measured === true,
      measuredResponsiveCount > 0,
      domSemanticsRan && domSemanticsResult?.measured === true,
      ...(strictProfile ? [stateMatrixMeasured] : []),
    ];
    const evidenceCoverage = measuredDims.filter(Boolean).length / measuredDims.length;

    const screenshotArtifactId =
      evidence.screenshot?.artifactRef &&
      typeof evidence.screenshot.artifactRef === 'object' &&
      'id' in (evidence.screenshot.artifactRef as unknown as Record<string, unknown>)
        ? String((evidence.screenshot.artifactRef as unknown as Record<string, unknown>).id)
        : (evidence.screenshot && typeof evidence.screenshot === 'object' && 'id' in (evidence.screenshot as unknown as Record<string, unknown>)
          ? String((evidence.screenshot as unknown as Record<string, unknown>).id)
          : undefined);

    const diagnosticScreenshot: ThemeQaDiagnosticScreenshot = {
      ...(screenshotArtifactId ? { artifactId: screenshotArtifactId } : {}),
      artifactRef: evidence.screenshot?.artifactRef,
      certifying: false,
      reason: 'Diagnostic viewport capture only; cannot certify visual parity without multi-viewport baseline comparison (anti.visual.compare)',
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
      ...(documentStatus !== undefined ? { documentStatus } : {}),
      ...(domSemanticsResult ? { domSemantics: domSemanticsResult } : {}),
      ...(visualQualityResult ? { visualQuality: visualQualityResult } : {}),
      ...(preReloadDiagnosticsObj ? { preReloadDiagnostics: preReloadDiagnosticsObj } : {}),
      ...(differential ? { differential } : {}),
      ...(evidenceGaps.length > 0 ? { evidenceGaps } : {}),
      ...(evidenceFailure ? { evidenceFailure } : {}),
      ...(integrityResult ? { layoutIntegrity: integrityResult } : {}),
      ...(integrityAmbiguities.length > 0 ? { visualAmbiguities: integrityAmbiguities } : {}),
      ...(timedWidgets ? { timedWidgets: { seen: timedWidgets.appeared > 0, waitedMs: timedWidgets.waitedMs } } : {}),
      responsive: responsiveMap,
      diagnosticScreenshot,
    };

    const artifacts: ArtifactRef[] = [];
    const collectRef = (item: unknown): void => {
      if (item && typeof item === 'object' && typeof (item as ArtifactRef).id === 'string') artifacts.push(item as ArtifactRef);
    };
    collectRef(evidence.dom);
    if (evidence.screenshot) collectRef(evidence.screenshot.artifactRef);
    if (input.signal?.aborted) {
      throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation', { cause: 'navigated-away' satisfies TargetStaleCause });
    }
    // A declared greenfield run grades each representative width by the absolute gates measured at
    // that width; a width nothing measured stays null and can never certify.
    let greenfieldMatrixInput: { absoluteViewports: Record<GreenfieldViewportName, boolean | null> } | undefined;
    if (greenfieldReason !== undefined) {
      const pageGatesClean = !assetResult.hasBrokenAssets && !serverCrashResult.hasCrash && diagnosticIssues.length === 0;
      const absoluteViewports: Record<GreenfieldViewportName, boolean | null> = { desktop: null, tablet: null, mobile: null };
      for (const name of GREENFIELD_VIEWPORT_NAMES) {
        const entry = responsiveMap[String(GREENFIELD_VIEWPORT_WIDTHS[name])];
        absoluteViewports[name] = greenfieldWidthMeasured(entry) ? pageGatesClean && greenfieldWidthClean(entry) : null;
      }
      greenfieldMatrixInput = { absoluteViewports };
    }
    const qaMatrix = ThemeQaWorkflow.computeQaMatrix(summary, checklist, findings, input.viewports, settleReceipt, greenfieldMatrixInput);
    // Additive labels only: the structural verdict keeps its contract, but a PASS that the matrix
    // could not certify (unmeasured visual/interaction/CWV dimensions) now says so in place. Set
    // before the report is serialized so the staged report carries the same labels.
    summary.matrixVerdict = qaMatrix.verdict;
    summary.certification = qaMatrix.verdict === 'PASS' ? 'CERTIFIED' : 'STRUCTURAL';
    summary.certificationReasons = [];
    const certificationRemedies: ThemeQaCertificationRemedy[] = [];
    if (greenfieldReason !== undefined) {
      summary.certificationReasons.push(`greenfield declared: ${greenfieldReason}; no visual baseline compared`);
    }
    if (summary.certification === 'CERTIFIED') {
      summary.certificationBasis = greenfieldReason !== undefined ? 'greenfield' : 'baseline';
    } else {
      const missingBaselineViewports: string[] = [];
      for (const [name, vp] of Object.entries(qaMatrix.viewports)) {
        if (greenfieldReason !== undefined) {
          const width = GREENFIELD_VIEWPORT_WIDTHS[name as GreenfieldViewportName];
          if (!vp.measured) {
            const reason = `absolute gates not measured at ${name} (${width}px): the responsive sweep did not measure it`;
            summary.certificationReasons.push(reason);
            certificationRemedies.push({ reason, tool: 'theme.qa_validate', args: { greenfield: { reason: greenfieldReason }, multiBreakpoint: true } });
          } else if (vp.verdict === 'FAIL') {
            summary.certificationReasons.push(`absolute gate failed at ${name} (${width}px)`);
          }
        } else if (!vp.measured) {
          summary.certificationReasons.push(`visual baseline missing at ${name}: pass viewports.${name} {mismatchPercent, passed} from a baseline comparison`);
          certificationRemedies.push({ reason: `visual baseline missing at ${name}`, tool: 'anti.visual.compare' });
          missingBaselineViewports.push(name);
        } else if (vp.verdict === 'FAIL') {
          summary.certificationReasons.push(`visual baseline at ${name} differs by ${vp.mismatchPercent}%`);
        }
      }
      if (missingBaselineViewports.length > 0) {
        certificationRemedies.push({
          reason: `no baseline exists to compare at ${missingBaselineViewports.join(', ')}: declare a greenfield run with the reason none exists`,
          tool: 'theme.qa_validate',
          args: { greenfield: { reason: '<why no baseline exists>' } },
        });
      }
      for (const [name, dim] of Object.entries(qaMatrix.dimensions)) {
        if (dim.score === null) summary.certificationReasons.push(`${name} unmeasured: ${dim.details}`);
      }
      for (const gap of evidenceGaps) summary.certificationReasons.push(`gap: ${gap}`);
      if (settleReceipt?.domUnstable === true || summary.domUnstable === true) {
        certificationRemedies.push({ reason: 'DOM mutations remained active during the settle window', tool: 'anti.media.freeze' });
      }
    }
    summary.certificationRemedies = certificationRemedies;
    summary.attribution = attribution;
    const viewportsTested = buildViewportsTested(responsiveMap, qaMatrix, greenfieldReason !== undefined);
    // 11. Generate PII-sanitized report JSON (RT-02 mitigation)
    const reportDataRaw = JSON.stringify(
      {
        runId: input.runId,
        attemptId: input.attemptId,
        workspaceId: activeTarget.workspaceId,
        target: activeTarget,
        ...(measuredViewport ? { viewport: measuredViewport } : {}),
        summary,
        checklist,
        findings,
        artifactIds: artifacts.map((item) => item.id),
        verification: verificationAxis,
        execution: executionAxis,
        recovery: input.recovery ?? { attempted: 0, succeeded: 0 },
        evidenceCoverage,
        profile: effectiveProfile,
        thresholdsSource: resolvedThresholds.source,
        viewportsTested,
        ...(storefrontTheme ? { storefrontTheme } : {}),
        coverage,
        ...(isolationOutcome ? { trackerIsolation: isolationOutcome } : {}),
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

    if (input.workspaceRoot) {
      try {
        const specsDir = path.join(input.workspaceRoot, 'specs');
        if (!fs.existsSync(specsDir)) {
          fs.mkdirSync(specsDir, { recursive: true });
        }
        const isRepoRoot = fs.existsSync(path.join(input.workspaceRoot, 'package.json')) &&
          !fs.existsSync(path.join(input.workspaceRoot, 'config', 'settings_schema.json'));
        const matrixFileName = (process.argv.includes('--publish') || !isRepoRoot)
          ? 'qa-matrix.json'
          : 'qa-matrix.local.json';
        fs.writeFileSync(path.join(specsDir, matrixFileName), JSON.stringify(qaMatrix, null, 2), 'utf-8');
      } catch {
        // Fallback gracefully if workspaceRoot is read-only
      }
    }

    return {
      runId: input.runId,
      attemptId: input.attemptId,
      workspaceId: activeTarget.workspaceId,
      target: activeTarget,
      ...(measuredViewport ? { viewport: measuredViewport } : {}),
      summary,
      checklist,
      findings,
      artifacts,
      qaMatrix,
      ...(settleReceipt ? { settleReceipt } : {}),
      ...(isolationOutcome ? { trackerIsolation: isolationOutcome } : {}),
      verification: verificationAxis,
      execution: executionAxis,
      recovery: input.recovery ?? { attempted: 0, succeeded: 0 },
      evidenceCoverage,
      profile: effectiveProfile,
      thresholdsSource: resolvedThresholds.source,
      viewportsTested,
      ...(storefrontTheme ? { storefrontTheme } : {}),
      coverage,
      coverageFloor,
      measuredRules: [
        ...measuredDimensionNames,
        ...(visualQualityResult?.measured === true && Array.isArray(visualQualityResult.stats?.measuredRules) ? visualQualityResult.stats.measuredRules : []),
        ...(imageFrameResult?.measured === true ? imageFrameResult.stats.measuredRules : []),
      ],
      ...(waivers.length > 0 ? { waivers } : {}),
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
    },
    settleReceipt?: VisualSettleReceiptExtended,
    greenfield?: { absoluteViewports: Record<GreenfieldViewportName, boolean | null> }
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

    // A declared greenfield run has no baseline to compare, so each viewport is graded by the
    // absolute gates measured at its own width. `null` is a width nothing measured: it stays
    // unmeasured (INCONCLUSIVE), never a pass.
    const parseAbsolute = (passed: boolean | null): QaMatrixViewportItem =>
      passed === null
        ? { mismatchPercent: null, passed: false, measured: false, verdict: 'INCONCLUSIVE', basis: 'absolute' }
        : { mismatchPercent: null, passed, measured: true, verdict: passed ? 'PASS' : 'FAIL', basis: 'absolute' };
    const vpDesktop = greenfield ? parseAbsolute(greenfield.absoluteViewports.desktop) : parseViewport(viewports?.desktop);
    const vpTablet = greenfield ? parseAbsolute(greenfield.absoluteViewports.tablet) : parseViewport(viewports?.tablet);
    const vpMobile = greenfield ? parseAbsolute(greenfield.absoluteViewports.mobile) : parseViewport(viewports?.mobile);

    const visualScore = vpDesktop.measured && typeof vpDesktop.mismatchPercent === 'number'
      ? Math.max(0, 100 - Math.round(vpDesktop.mismatchPercent * 10))
      : null;

    const responsiveMeasuredCount = (vpTablet.measured ? 1 : 0) + (vpMobile.measured ? 1 : 0);
    // No pixel diff exists on a greenfield run, so no diff-derived score is invented for it.
    const responsiveScore = responsiveMeasuredCount > 0 && !greenfield
      ? Math.max(0, 100 - Math.round((((vpTablet.mismatchPercent || 0) + (vpMobile.mismatchPercent || 0)) / responsiveMeasuredCount) * 10))
      : null;

    // This workflow runs no semantic-tree, stylesheet-modularity or interaction probe.
    // The layout overflow check and the Haravan HTML scan measure other things, so they
    // must not be dressed up as those dimensions: an unmeasured dimension stays null
    // instead of receiving an invented grade.
    let domSemanticsScore: number | null = null;
    let domSemanticsDetails = 'DOM semantics unmeasured (this workflow runs no semantic-tree scanner)';
    if (findings?.domSemantics?.measured === true) {
      domSemanticsScore = findings.domSemantics.score;
      const s = findings.domSemantics.summary;
      const jsonLdInfo = s.jsonLdInvalidCount > 0
        ? `${s.jsonLdInvalidCount} invalid block(s)`
        : `${s.jsonLdBlocksCount} block(s)${s.jsonLdTypes.length > 0 ? ` [@type: ${s.jsonLdTypes.join(', ')}]` : ''}`;
      domSemanticsDetails = `Score ${domSemanticsScore}/100: H1: ${s.h1Count}, Alt gaps: ${s.imgMissingAltCount}, Name gaps: ${s.controlsMissingNameCount}, Unlabeled: ${s.formControlsMissingLabelCount}, Dup IDs: ${s.duplicateIdCount}, JSON-LD: ${jsonLdInfo}`;
    }

    const cssModularityScore: number | null = null;
    const cssModularityDetails = 'CSS modularity unmeasured (this workflow runs no stylesheet-modularity scanner)';

    const interactiveScore = typeof checklist.interactions === 'boolean'
      ? (checklist.interactions ? 100 : 50)
      : null;
    const interactiveDetails = typeof checklist.interactions === 'boolean'
      ? (checklist.interactions
        ? 'Interaction probe result supplied by the caller (this workflow runs no interaction probe)'
        : 'Interaction probe failures supplied by the caller (this workflow runs no interaction probe)')
      : 'Interactive operability unmeasured (no interaction probe executed in this run)';

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
          ? (greenfield
            ? 'Greenfield: desktop graded by absolute gates only; no visual baseline compared'
            : `Desktop diff: ${vpDesktop.mismatchPercent}%, threshold < ${VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT}%`)
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
          ? (greenfield
            ? 'Greenfield: tablet and mobile graded by absolute gates only; no visual baseline compared'
            : `Tablet diff: ${vpTablet.mismatchPercent ?? 'N/A'}%, Mobile diff: ${vpMobile.mismatchPercent ?? 'N/A'}%`)
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

    if ((settleReceipt?.domUnstable === true || summary.domUnstable === true) && verdict === 'PASS') {
      verdict = 'INCONCLUSIVE';
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
      ...((settleReceipt?.domUnstable || summary.domUnstable) ? { domUnstable: true } : {}),
    };
  }
  private assertOwnership(target: BrowserTarget): void {
    if (!target.projectId || !target.workspaceId || !target.runtimeId || !target.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Theme QA requires an explicit Project/Workspace/runtime/tab target');
    }
  }
}

export { createWorkspaceSnapshotManifest, rollbackWorkspaceToManifest, WorkspaceSnapshotManifest, WorkspaceRollbackResult } from './workspace-snapshot-rollback';
