import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { buildFallbackThemeQaResult } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import { DiagnosticsInput } from '../../src/main/qa/diagnostics-filter';
/**
 * P1 agent reads summary.criticalCount / summary.passed from BOTH the full
 * ThemeQaWorkflow path and the fallback quick path (Red Team Finding 6).
 * This test pins the verdict parity: identical fake diagnostics must yield
 * identical summary.criticalCount and summary.passed on both paths.
 */

const FIRST_PARTY_URL = 'https://store.example.com/';
const TAB_HOST: BrowserHostPort = {
  getTabList: () => [{ id: 'tab-1', url: FIRST_PARTY_URL }],
  navigate: () => true,
  reload: () => true,
  getDom: async () => '<html><body><h1>Storefront</h1></body></html>',
  captureScreenshot: async () => Buffer.from('png').toString('base64'),
  evalJs: async () => null,
};

function makeTarget(): BrowserTarget {
  return {
    projectId: 'project-12345678901234567890',
    workspaceId: 'workspace-12345678901234567890',
    runtimeId: 'binding-12345678901234567890',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };
}

function fakeDiagnostics(): DiagnosticsInput {
  return {
    console: [
      { level: 3, message: 'Uncaught TypeError: x is not a function', source: 'https://store.example.com/app.js' },
      { level: 3, message: 'GTM blocked by content security policy', source: 'https://googletagmanager.com/gtm.js' },
      { level: 2, message: 'deprecation warning (should be filtered)', source: 'https://store.example.com/theme.js' },
    ],
    failures: [
      { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://store.example.com/missing.css', isMainFrame: false },
      { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://ads.other.com/pixel.png', isMainFrame: false },
      { errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'https://store.example.com/aborted.js', isMainFrame: false },
    ],
  };
}

/** BrowserHostPort.getDiagnostics requires non-optional arrays (host shape). */
function toHostDiagnostics(diag: DiagnosticsInput): { console: unknown[]; failures: unknown[] } {
  return { console: diag.console ?? [], failures: diag.failures ?? [] };
}

async function runFullPath(root: string, tabDiagnostics: DiagnosticsInput): Promise<Record<string, unknown>> {
  let docGen = 1;
  const host: BrowserHostPort = {
    ...TAB_HOST,
    reload: () => {
      docGen++;
      return true;
    },
    getDocumentGeneration: () => docGen,
    isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === docGen,
    getDiagnostics: () => toHostDiagnostics(tabDiagnostics),
  };
  const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const browser = new BrowserControlPort(host, artifactStore);
  const workflow = new ThemeQaWorkflow({
    browser,
    artifacts: artifactStore,
    reload: (t) => browser.reload(t),
  });
  const report = await workflow.validate({
    runId: 'run-12345678901234567890',
    attemptId: 'attempt-12345678901234567890',
    workspaceRoot: root,
    target: makeTarget(),
  });
  return report as unknown as Record<string, unknown>;
}

async function runFallbackPath(root: string, tabDiagnostics: DiagnosticsInput): Promise<Record<string, unknown>> {
  const host: BrowserHostPort = {
    ...TAB_HOST,
    getDiagnostics: () => toHostDiagnostics(tabDiagnostics),
  };
  const browser = new BrowserControlPort(host);
  return buildFallbackThemeQaResult(browser, makeTarget(), {}, root);
}

describe('Theme QA verdict parity: full path vs fallback path', () => {
  it('identical fake diagnostics => identical summary.criticalCount and passed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-'));
    try {
      const diag = fakeDiagnostics();
      const full = await runFullPath(root, diag);
      const fallback = await runFallbackPath(root, diag);

      const fullSummary = full.summary as { passed: boolean; criticalCount: number };
      const fallbackSummary = fallback.summary as { passed: boolean; criticalCount: number };

      // Both paths MUST return a complete summary object (Finding 6)
      assert.ok(fullSummary, 'full path must return summary');
      assert.ok(fallbackSummary, 'fallback path must return summary');
      assert.equal(typeof fullSummary.criticalCount, 'number');
      assert.equal(typeof fallbackSummary.criticalCount, 'number');

      // 2 first-party critical (console error + network -105), third-party
      // noise downgraded to warnings, -3 aborted ignored, plus correlated first-party broken asset (3 total)
      assert.equal(fallbackSummary.criticalCount, 3);
      assert.equal(fullSummary.criticalCount, fallbackSummary.criticalCount);
      assert.equal(fullSummary.passed, fallbackSummary.passed);
      assert.equal(fallbackSummary.passed, false, 'first-party critical issues fail the gate');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('third-party-only diagnostics pass on BOTH paths (Goal 2)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-clean-'));
    try {
      const diag: DiagnosticsInput = {
        console: [
          { level: 3, message: 'FB Pixel blocked', source: 'https://connect.facebook.net/fbevents.js' },
        ],
        failures: [
          { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://ads.other.com/pixel.png', isMainFrame: false },
        ],
      };
      const full = await runFullPath(root, diag);
      const fallback = await runFallbackPath(root, diag);
      const fs_ = fallback.summary as { passed: boolean; criticalCount: number };
      const ffs = full.summary as { passed: boolean; criticalCount: number };
      assert.equal(fs_.criticalCount, 0);
      assert.equal(ffs.criticalCount, 0);
      assert.equal(ffs.passed, true);
      assert.equal(fs_.passed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('overflow + HS failures keep summaries aligned on both paths (review finding)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-overflow-'));
    try {
      const overflowScript = LayoutOverflowEngine.getBrowserScanScript('active');
      const overflowingHost: BrowserHostPort = {
        ...TAB_HOST,
        getDiagnostics: () => ({ console: [], failures: [] }),
        evalJs: async (expression: string) => {
          if (expression === overflowScript) {
            return { hasOverflow: true, viewport: { name: 'desktop', width: 1440, height: 900 }, deltaX: 120, scrollWidth: 1560, clientWidth: 1440, culprits: [{ tag: 'div', id: 'wide', className: '', selector: 'div#wide', width: 1560 }] };
          }
          if (expression.includes('const platform =')) {
            return { passed: false, totalViolations: 1, errorsCount: 1, warningsCount: 0, violations: [{ ruleId: 'HS-01', ruleTitle: 't', severity: 'error', message: 'm', recommendation: 'r', selector: 'form' }] };
          }
          return null;
        },
      };
      const fullBrowser = new BrowserControlPort(overflowingHost, new ArtifactStore({ root: path.join(root, 'artifacts') }));
      const fullWorkflow = new ThemeQaWorkflow({
        browser: fullBrowser,
        artifacts: new ArtifactStore({ root: path.join(root, 'reports') }),
        reload: () => ({ reloaded: true, target: makeTarget() }),
      });
      const full = await fullWorkflow.validate({
        runId: 'run-12345678901234567890',
        attemptId: 'attempt-12345678901234567890',
        workspaceRoot: root,
        target: makeTarget(),
      });
      const fallback = await buildFallbackThemeQaResult(new BrowserControlPort(overflowingHost), makeTarget(), {}, root);

      const fullSummary = full.summary as { passed: boolean; totalIssues: number; criticalCount: number };
      const fbSummary = fallback.summary as { passed: boolean; totalIssues: number; criticalCount: number };
      assert.equal(fbSummary.passed, false, 'overflow/HS failure must fail the fallback gate');
      assert.equal(fbSummary.passed, fullSummary.passed);
      assert.equal(fbSummary.criticalCount, fullSummary.criticalCount);
      assert.equal(fbSummary.totalIssues, fullSummary.totalIssues);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('host without diagnostics support degrades to empty input on both paths (no throw)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-nodiag-'));
    try {
      const host: BrowserHostPort = { ...TAB_HOST };
      const browser = new BrowserControlPort(host);
      const fallback = await buildFallbackThemeQaResult(browser, makeTarget(), {}, root);
      const fbSummary = fallback.summary as { passed: boolean; criticalCount: number };
      assert.equal(fbSummary.criticalCount, 0);
      assert.equal(fbSummary.passed, true);

      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const fullBrowser = new BrowserControlPort(host, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser: fullBrowser,
        artifacts: artifactStore,
        reload: () => ({ reloaded: true, target: makeTarget() }),
      });
      const report = await workflow.validate({
        runId: 'run-12345678901234567890',
        attemptId: 'attempt-12345678901234567890',
        workspaceRoot: root,
        target: makeTarget(),
      });
      assert.equal(report.summary.criticalCount, 0);
      assert.equal(report.summary.passed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces engine checklist authority and applies enabledChecks strictly as a verdict filter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-enabled-checks-'));
    try {
      const overflowScript = LayoutOverflowEngine.getBrowserScanScript('active');
      const overflowingHost: BrowserHostPort = {
        ...TAB_HOST,
        getDiagnostics: () => ({ console: [], failures: [] }),
        getDom: async () => '<html><body><div style="width: 2000px">Wide overflow</div></body></html>',
        evalJs: async (expr: string) => {
          if (expr === overflowScript) {
            return {
              hasOverflow: true,
              viewport: { name: 'desktop', width: 1440, height: 900 },
              deltaX: 120,
              scrollWidth: 1560,
              clientWidth: 1440,
              culprits: [{ tag: 'div', id: 'wide', className: '', selector: 'div#wide', width: 1560 }],
            };
          }
          return null;
        },
      };

      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(overflowingHost, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: () => ({ reloaded: true, target: makeTarget() }),
      });
      // Case 1: Default validate -> layout fails, so summary.passed is FALSE and checklist.layout is FALSE
      const defaultReport = await workflow.validate({
        runId: 'run-1',
        attemptId: 'attempt-1',
        workspaceRoot: root,
        target: makeTarget(),
      });
      assert.equal(defaultReport.checklist.layout, false, 'Engine must detect layout overflow');
      assert.equal(defaultReport.summary.passed, false, 'Summary must fail when layout fails');

      // Case 2: Validate with enabledChecks: { layout: false } -> summary.passed evaluates to TRUE, but checklist.layout REMAINS FALSE
      const filteredReport = await workflow.validate({
        runId: 'run-2',
        attemptId: 'attempt-2',
        workspaceRoot: root,
        target: makeTarget(),
        enabledChecks: { layout: false, overflow: false, responsive: false },
      });
      assert.equal(filteredReport.checklist.layout, false, 'Checklist layout must remain false (engine authority preserved)');
      assert.equal(filteredReport.checklist.overflow, false, 'Checklist overflow must remain false');
      assert.equal(filteredReport.summary.passed, true, 'Summary passed must be true because failing checks were excluded from filter');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});