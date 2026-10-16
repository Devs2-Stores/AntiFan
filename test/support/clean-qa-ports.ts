import type { BrowserTarget } from '../../src/shared/control-plane-contracts';
import type { ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import type { VisualSettleReceipt } from '../../src/main/verification/capture-settle';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { DomSemanticsScanner } from '../../src/main/qa/scanners/dom-semantics-scanner';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { BrokenAssetScanner } from '../../src/main/qa/scanners/broken-asset-scanner';
import { ServerCrashScanner } from '../../src/main/qa/scanners/server-crash-scanner';
import { HsGateRules } from '../../src/main/qa/rules/hs-gate-rules';
import { VISUAL_QUALITY_RULE_IDS } from '../../src/main/qa/scanners/visual-quality-scanner';
import { IMAGE_FRAME_RULE_IDS } from '../../src/main/qa/scanners/image-frame-scanner';

export const SWEEP_WIDTHS = [320, 375, 768, 1024, 1440] as const;

export interface CleanPortsOptions {
  /** Width of the tab itself (what the active-viewport scans read). */
  activeWidth?: number;
  tabUrl?: string;
  /** False: the multi-breakpoint sweep carries no visual-quality reading at the touch widths. */
  sweepVisualQuality?: boolean;
  /** Reported by getViewport; omit both to model a host that does not report them. */
  requestedWidth?: number | null;
  observedWidth?: number;
  /** False: the browser port has no stateMatrix capability. */
  stateMatrix?: boolean;
}

export interface CleanPortsRecord {
  ports: ThemeQaWorkflowPorts;
  stateMatrixCalls: Array<Record<string, unknown>>;
  sweepScripts: string[];
  evalScripts: string[];
}

const heightFor = (width: number): number => (width <= 767 ? 812 : 900);

const integrityStats = () => ({
  elements: 120,
  textRuns: 40,
  controls: 10,
  sweepSteps: 1,
  truncated: false,
  truncatedReasons: [] as string[],
  failedDetectors: [] as string[],
  durationMs: 4,
  cls: 0,
});

const cleanIntegrity = (width: number, name: string) => ({
  measured: true,
  viewport: { name, width, height: heightFor(width) },
  findings: [] as unknown[],
  stats: integrityStats(),
});
const cleanVisualQuality = (width: number) => ({
  measured: true,
  viewport: { width, height: heightFor(width) },
  mobile: width <= 767,
  findings: [] as unknown[],
  stats: {
    textElementsChecked: 10,
    contrastIndeterminate: 0,
    controlsChecked: 4,
    floatingWidgets: 0,
    scrollPositions: 1,
    durationMs: 3,
    truncated: false,
    truncatedReasons: [] as string[],
    measuredRules: [...VISUAL_QUALITY_RULE_IDS],
    unmeasuredRules: [] as string[],
  },
});

const cleanImageFrame = (width: number) => ({
  measured: true,
  viewport: { width, height: heightFor(width) },
  findings: [] as unknown[],
  stats: {
    imagesChecked: 5,
    imagesPending: 0,
    durationMs: 2,
    truncated: false,
    truncatedReasons: [] as string[],
    measuredRules: [...IMAGE_FRAME_RULE_IDS],
    unmeasuredRules: [] as string[],
  },
});

const DOM_SEMANTICS_CLEAN = {
  measured: true,
  score: 100,
  summary: {
    totalIssues: 0,
    criticalIssues: 0,
    h1Count: 1,
    imgMissingAltCount: 0,
    controlsMissingNameCount: 0,
    formControlsMissingLabelCount: 0,
    duplicateIdCount: 0,
    jsonLdInvalidCount: 0,
    jsonLdBlocksCount: 0,
    jsonLdTypes: [] as string[],
  },
  findings: [] as unknown[],
};

/**
 * Ports whose every scanner returns a valid, clean measurement at the configured widths, so a
 * run over them can only fail or degrade for a reason the test introduced.
 */
export function createCleanQaPorts(options: CleanPortsOptions = {}): CleanPortsRecord {
  const activeWidth = options.activeWidth ?? 375;
  const record: CleanPortsRecord = { ports: undefined as unknown as ThemeQaWorkflowPorts, stateMatrixCalls: [], sweepScripts: [], evalScripts: [] };
  const hsScripts = new Set((['haravan', 'sapo', 'shopify', 'unknown'] as const).map((platform) => HsGateRules.getBrowserEvaluationScript(platform)));
  const overflowScript = LayoutOverflowEngine.getBrowserScanScript('active');
  const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
  const domScript = DomSemanticsScanner.getBrowserScanScript();
  const liquidScript = LiquidErrorScanner.getBrowserScanScript();
  const assetScript = BrokenAssetScanner.getBrowserScanScript();
  const crashScript = ServerCrashScanner.getBrowserScanScript();

  let currentGen = 1;
  const browser: Record<string, unknown> = {
    dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
    screenshot: async () => ({ artifactRef: { id: 'art-screenshot', kind: 'screenshot' }, envelope: {} }),
    eval: async (_target: BrowserTarget, script: string) => {
      record.evalScripts.push(script);
      if (script === integrityScript) return cleanIntegrity(activeWidth, 'active');
      if (script === overflowScript) {
        return { measured: true, viewport: { name: activeWidth <= 767 ? 'mobile' : 'desktop', width: activeWidth, height: heightFor(activeWidth) }, hasOverflow: false, deltaX: 0, scrollWidth: activeWidth, clientWidth: activeWidth, culprits: [] };
      }
      if (script === domScript) return DOM_SEMANTICS_CLEAN;
      if (script === liquidScript) return { hasErrors: false, errors: [], scannedElementsCount: 20 };
      if (script === assetScript) return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
      if (script === crashScript) return { hasCrash: false, errorsCount: 0, findings: [] };
      if (hsScripts.has(script)) return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
      if (script.includes('image-low-res')) return cleanImageFrame(activeWidth);
      if (script.includes('floating-widget-overlap')) return cleanVisualQuality(activeWidth);
      return {};
    },
    diagnostics: () => ({ console: [], failures: [] }),
    listTabs: () => [{ id: 'tab-1', url: options.tabUrl ?? 'https://store.example.com/' }],
    getDocumentGeneration: () => currentGen,
    settleCapture: async () =>
      ({ settleComplete: true, gates: { network: true, fonts: true, images: true, dom: true }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 }, brokenImages: [] }) as VisualSettleReceipt,
    responsiveCheck: async (params: { perWidthScript?: string }) => {
      record.sweepScripts.push(params?.perWidthScript ?? '');
      const breakpoints: Record<string, unknown> = {};
      for (const width of SWEEP_WIDTHS) {
        breakpoints[`w${width}`] = {
          width,
          height: heightFor(width),
          mobile: width <= 767,
          hasHorizontalOverflow: false,
          integrity: {
            ...cleanIntegrity(width, 'sweep'),
            ...(width <= 767 && options.sweepVisualQuality !== false ? { visualQuality: cleanVisualQuality(width) } : {}),
          },
        };
      }
      return { ok: true, breakpoints };
    },
    getViewport: async () => ({
      tabId: 'tab-1',
      width: activeWidth,
      height: heightFor(activeWidth),
      ...(options.requestedWidth !== undefined ? { requestedWidth: options.requestedWidth } : {}),
      ...(options.observedWidth !== undefined ? { observedWidth: options.observedWidth } : {}),
    }),
  };
  if (options.stateMatrix !== false) {
    browser.stateMatrix = async (_target: BrowserTarget, params: Record<string, unknown>) => {
      record.stateMatrixCalls.push(params);
      return {
        measured: true,
        safeMode: true,
        viewport: { width: activeWidth, height: heightFor(activeWidth) },
        triggers: [],
        summary: { total: 0, passed: 0, warned: 0, failed: 0, notRun: 0, criticalCount: 0 },
        skippedTriggers: [],
        durationMs: 1,
      };
    };
  }

  record.ports = {
    browser: browser as unknown as ThemeQaWorkflowPorts['browser'],
    artifacts: {
      stage: (item: { kind: string; data: Buffer | string }) => ({ id: `art-${item.kind}`, kind: item.kind, bytes: typeof item.data === 'string' ? Buffer.byteLength(item.data) : item.data.length, createdAt: Date.now() }),
      readBytesById: () => ({ data: Buffer.from('<html><body><main>Clean</main></body></html>') }),
    } as unknown as ThemeQaWorkflowPorts['artifacts'],
    reload: async (target: BrowserTarget) => {
      currentGen++;
      return { reloaded: true, target: { ...target, documentGeneration: currentGen } };
    },
    fsQuiescenceMs: 0,
  };
  return record;
}

export const makeCleanTarget = (): BrowserTarget => ({
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
});
