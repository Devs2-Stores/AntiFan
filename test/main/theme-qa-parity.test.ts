import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget, CapabilityError, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
import { DiagnosticsInput } from '../../src/main/qa/diagnostics-filter';

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

function toHostDiagnostics(diag: DiagnosticsInput): { console: unknown[]; failures: unknown[] } {
  return { console: diag.console ?? [], failures: diag.failures ?? [] };
}

describe('ThemeQaWorkflow Canonical Validation & Capability Alias Delegation', () => {
  it('ThemeQaWorkflow correctly classifies first-party vs third-party diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-workflow-qa-'));
    try {
      let docGen = 1;
      const host: BrowserHostPort = {
        ...TAB_HOST,
        reload: () => {
          docGen++;
          return true;
        },
        getDocumentGeneration: () => docGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === docGen,
        getDiagnostics: () => toHostDiagnostics(fakeDiagnostics()),
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

      assert.ok(report.summary, 'workflow must return summary');
      assert.strictEqual(typeof report.summary.criticalCount, 'number');
      assert.strictEqual(report.summary.criticalCount, 3);
      assert.strictEqual(report.summary.passed, false, 'first-party critical issues fail the gate');
      assert.strictEqual(report.checklist.diagnostics, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('third-party-only diagnostics pass in ThemeQaWorkflow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-clean-'));
    try {
      let docGen = 1;
      const diag: DiagnosticsInput = {
        console: [
          { level: 3, message: 'FB Pixel blocked', source: 'https://connect.facebook.net/fbevents.js' },
        ],
        failures: [
          { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://ads.other.com/pixel.png', isMainFrame: false },
        ],
      };
      const host: BrowserHostPort = {
        ...TAB_HOST,
        reload: () => {
          docGen++;
          return true;
        },
        getDocumentGeneration: () => docGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === docGen,
        getDiagnostics: () => toHostDiagnostics(diag),
      };
      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(host, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: (t) => browser.reload(t),
      });
      const report = await workflow.validate({
        runId: 'run-clean',
        attemptId: 'attempt-clean',
        workspaceRoot: root,
        target: makeTarget(),
      });

      assert.strictEqual(report.summary.criticalCount, 0);
      assert.strictEqual(report.summary.passed, true);
      assert.strictEqual(report.checklist.diagnostics, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('overflow + HS failures are correctly counted in ThemeQaWorkflow summary', async () => {
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
      const report = await fullWorkflow.validate({
        runId: 'run-overflow',
        attemptId: 'attempt-overflow',
        workspaceRoot: root,
        target: makeTarget(),
      });

      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.checklist.layout, false);
      assert.strictEqual(report.checklist.interactions, false);
      assert.strictEqual(report.summary.criticalCount >= 2, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('host without diagnostics support degrades cleanly to empty input without throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-nodiag-'));
    try {
      const noDiagHost: BrowserHostPort = {
        ...TAB_HOST,
        getDiagnostics: () => {
          throw new Error('Host has no diagnostics subsystem');
        },
      };
      const browser = new BrowserControlPort(noDiagHost);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: new ArtifactStore({ root: path.join(root, 'reports') }),
        reload: () => ({ reloaded: true, target: makeTarget() }),
      });
      const report = await workflow.validate({
        runId: 'run-nodiag',
        attemptId: 'attempt-nodiag',
        workspaceRoot: root,
        target: makeTarget(),
      });
      assert.strictEqual(report.summary.criticalCount, 0);
      assert.strictEqual(report.summary.passed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces engine checklist authority and applies enabledChecks strictly as a verdict filter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-checklist-'));
    try {
      const overflowScript = LayoutOverflowEngine.getBrowserScanScript('active');
      const overflowingHost: BrowserHostPort = {
        ...TAB_HOST,
        getDiagnostics: () => ({ console: [], failures: [] }),
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
      assert.strictEqual(defaultReport.checklist.layout, false, 'Engine must detect layout overflow');
      assert.strictEqual(defaultReport.summary.passed, false, 'Summary must fail when layout fails');

      // Case 2: Validate with enabledChecks: { layout: false } -> summary.passed evaluates to TRUE, but checklist.layout REMAINS FALSE
      const filteredReport = await workflow.validate({
        runId: 'run-2',
        attemptId: 'attempt-2',
        workspaceRoot: root,
        target: makeTarget(),
        enabledChecks: { layout: false, overflow: false, responsive: false },
      });
      assert.strictEqual(filteredReport.checklist.layout, false, 'Checklist layout must remain false (engine authority preserved)');
      assert.strictEqual(filteredReport.checklist.overflow, false, 'Checklist overflow must remain false');
      assert.strictEqual(filteredReport.summary.passed, true, 'Summary passed must be true because failing checks were excluded from filter');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('theme.qa_validate and antifan_theme_qa_validate delegate to registered ThemeQaWorkflow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-alias-qa-'));
    try {
      let docGen = 1;
      const host: BrowserHostPort = {
        ...TAB_HOST,
        reload: () => {
          docGen++;
          return true;
        },
        getDocumentGeneration: () => docGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === docGen,
        getDiagnostics: () => toHostDiagnostics({ console: [], failures: [] }),
      };
      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(host, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: (t) => browser.reload(t),
      });

      const target = makeTarget();
      const lease = issueRuntimeLease(target.projectId, target.workspaceId, 60_000, 1);

      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runtimeId: target.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => lease,
      });
      registerBrowserCapabilities(catalogue, browser, workflow, () => root);

      const context = {
        grant: 'read' as const,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        lease,
        leaseToken: lease.token,
        browserTarget: target,
      };

      // 1. Primary capability execution
      const primaryResult = await catalogue.get('theme.qa_validate')!.execute({}, context) as { summary: { passed: boolean } };
      assert.strictEqual(primaryResult.summary.passed, true);

      // 2. Alias execution with fresh target generation
      const aliasContext = {
        ...context,
        browserTarget: { ...target, documentGeneration: docGen },
      };
      const aliasResult = await catalogue.get('antifan_theme_qa_validate')!.execute({}, aliasContext) as { summary: { passed: boolean } };
      assert.strictEqual(aliasResult.summary.passed, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('theme.qa_validate rejects mismatched explicit tabId with TARGET_MISMATCH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tab-mismatch-'));
    try {
      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(TAB_HOST, artifactStore);
      const workflow = new ThemeQaWorkflow({
        browser,
        artifacts: artifactStore,
        reload: (t) => browser.reload(t),
      });

      const target = makeTarget();
      const lease = issueRuntimeLease(target.projectId, target.workspaceId, 60_000, 1);

      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runtimeId: target.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => lease,
      });
      registerBrowserCapabilities(catalogue, browser, workflow, () => root);

      const context = {
        grant: 'read' as const,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        lease,
        leaseToken: lease.token,
        browserTarget: target,
      };

      await assert.rejects(
        async () => {
          await catalogue.get('theme.qa_validate')!.execute({ tabId: 'alien-tab' }, context);
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TARGET_MISMATCH');
          return true;
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('theme.qa_validate throws CAPABILITY_NOT_FOUND when ThemeQaWorkflow is not registered', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-missing-qa-'));
    try {
      const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
      const browser = new BrowserControlPort(TAB_HOST, artifactStore);

      const target = makeTarget();
      const lease = issueRuntimeLease(target.projectId, target.workspaceId, 60_000, 1);

      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runtimeId: target.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => lease,
      });
      // Register without ThemeQaWorkflow instance
      registerBrowserCapabilities(catalogue, browser, undefined, () => root);

      const context = {
        grant: 'read' as const,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        lease,
        leaseToken: lease.token,
        browserTarget: target,
      };

      await assert.rejects(
        async () => {
          await catalogue.get('theme.qa_validate')!.execute({}, context);
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'CAPABILITY_NOT_FOUND');
          return true;
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
