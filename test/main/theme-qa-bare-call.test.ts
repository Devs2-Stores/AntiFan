import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { ThemeQaWorkflow, type ThemeQaReport } from '../../src/main/qa/theme-qa-workflow';
import type { BrowserTarget, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { createCleanQaPorts, makeCleanTarget, type CleanPortsOptions } from '../support/clean-qa-ports';

const defaultOptions = {
  runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
};

const withThemeRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-bare-call-'));
  fs.mkdirSync(path.join(root, 'layout'), { recursive: true });
  fs.writeFileSync(path.join(root, 'layout', 'theme.liquid'), '<html></html>');
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

/** Neither a profile nor thresholds: exactly what a tool call that names neither sends. */
const bareValidate = (options: CleanPortsOptions, root: string) => {
  const record = createCleanQaPorts(options);
  const workflow = new ThemeQaWorkflow(record.ports);
  return workflow
    .validate({ runId: 'run-bare', attemptId: 'att-bare', workspaceRoot: root, target: makeCleanTarget() })
    .then((report) => ({ report, record }));
};

const boundContext = (): CapabilityRequestContext => {
  const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
  return { lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() }, leaseToken: 'token-1', projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
};

describe('bare theme QA call', () => {
  it('grades a clean page PASS under build-strict with the built-in thresholds and no unmeasured-rules gap', async () => {
    await withThemeRoot(async (root) => {
      const { report } = await bareValidate({ activeWidth: 375 }, root);
      const gaps = report.findings?.evidenceGaps ?? [];
      assert.strictEqual(report.profile, 'build-strict');
      assert.strictEqual(report.thresholdsSource, 'default');
      assert.strictEqual(report.summary.thresholdsSource, 'default');
      assert.deepStrictEqual(gaps, [], `a clean page must carry no evidence gap, got: ${gaps.join(' | ')}`);
      assert.strictEqual(report.summary.verdict, 'PASS');
      assert.strictEqual(report.summary.passed, true);
      assert.ok(!gaps.some((gap) => /Registry rules unmeasured/i.test(gap)));
      assert.ok(report.measuredRules.includes('font-below-min'), 'registry rules must have been measured');
      assert.ok(report.measuredRules.includes('title-scale') && report.measuredRules.includes('input-height-band'));
      assert.ok(report.measuredRules.includes('image-crop'));
    });
  });

  it('reaches QA_PASSED on the receipt when the tool is called with no profile and no thresholds', async () => {
    await withThemeRoot(async (root) => {
      const { ports } = createCleanQaPorts({ activeWidth: 375, tabUrl: 'https://store.example.com/' });
      const bound = new BrowserControlPort({
        getTabList: () => [{ id: 'tab-1', url: 'https://store.example.com/' }],
        navigate: () => true,
        reload: () => true,
        getDom: async () => '<html></html>',
        captureScreenshot: async () => Buffer.from('png').toString('base64'),
        evalJs: async () => null,
      });
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, bound, new ThemeQaWorkflow(ports), () => root);
      const report = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, boundContext())) as ThemeQaReport;
      const receiptDir = path.join(root, '.antifan', 'qa-receipts');
      const files = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json')) : [];
      assert.strictEqual(files.length, 1, 'the call must leave exactly one receipt');
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, files[0]!), 'utf8')) as Record<string, unknown>;
      assert.strictEqual(receipt.profile, 'build-strict');
      assert.strictEqual(receipt.thresholdsSource, 'default');
      assert.strictEqual(receipt.verdict, 'QA_PASSED', `report gaps: ${(report.findings?.evidenceGaps ?? []).join(' | ')}`);
    });
  });

  it('does not report tap targets as ungraded when the tab is desktop-wide but the sweep measured 375', async () => {
    await withThemeRoot(async (root) => {
      const { report, record } = await bareValidate({ activeWidth: 1440 }, root);
      const gaps = report.findings?.evidenceGaps ?? [];
      assert.ok(!gaps.some((gap) => /Tap targets not graded/i.test(gap)), `unexpected gap: ${gaps.join(' | ')}`);
      assert.ok(record.sweepScripts.length > 0, 'the sweep must have run');
      assert.ok(record.sweepScripts.every((script) => script.includes('font-below-min')), 'every sweep reading must carry the visual-quality scan under build-strict');
      assert.strictEqual(report.summary.verdict, 'PASS');
    });
  });

  it('still reports the tap-target gap when the sweep carried no touch-width visual-quality reading', async () => {
    await withThemeRoot(async (root) => {
      const { report } = await bareValidate({ activeWidth: 1440, sweepVisualQuality: false }, root);
      const gaps = report.findings?.evidenceGaps ?? [];
      assert.ok(gaps.some((gap) => /Tap targets not graded/i.test(gap)), 'a desktop-only reading cannot vouch for tap targets');
      assert.notStrictEqual(report.summary.verdict, 'PASS');
    });
  });

  it('runs the state matrix with the product opt-in on a product page and without it elsewhere', async () => {
    await withThemeRoot(async (root) => {
      const product = await bareValidate({ activeWidth: 375, tabUrl: 'https://store.example.com/products/demo' }, root);
      assert.deepStrictEqual(product.record.stateMatrixCalls, [{ maxTriggers: 6, autoPopulate: 'pdp' }]);
      const home = await bareValidate({ activeWidth: 375, tabUrl: 'https://store.example.com/' }, root);
      assert.deepStrictEqual(home.record.stateMatrixCalls, [{ maxTriggers: 6 }]);
    });
  });

  it('names a missing state matrix capability as an evidence gap under build-strict', async () => {
    await withThemeRoot(async (root) => {
      const { report } = await bareValidate({ activeWidth: 375, stateMatrix: false }, root);
      const gaps = report.findings?.evidenceGaps ?? [];
      assert.ok(gaps.some((gap) => /State matrix unsupported under build-strict/.test(gap)));
      assert.notStrictEqual(report.summary.verdict, 'PASS');
    });
  });

  it('keeps the audit profile available and leaves the state matrix out of it', async () => {
    await withThemeRoot(async (root) => {
      const record = createCleanQaPorts({ activeWidth: 375 });
      const report = await new ThemeQaWorkflow(record.ports).validate({ runId: 'run-audit', attemptId: 'att-audit', workspaceRoot: root, target: makeCleanTarget(), profile: 'audit' });
      assert.strictEqual(report.profile, 'audit');
      assert.deepStrictEqual(record.stateMatrixCalls, []);
    });
  });
});
