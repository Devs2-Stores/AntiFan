import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

describe('Theme QA vertical slice', () => {
  it('inspects, edits, reloads, and emits bounded durable evidence for one exact target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-'));
    const target: BrowserTarget = {
      projectId: 'project-12345678901234567890',
      workspaceId: 'workspace-12345678901234567890',
      runtimeId: 'binding-12345678901234567890',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    let reloads = 0;
    let currentGen = 1;
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(
      {
        getTabList: () => [{ id: 'tab-1' }],
        navigate: () => true,
        reload: () => {
          reloads++;
          currentGen++;
          return true;
        },
        getDocumentGeneration: () => currentGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === currentGen,
        getDom: async () => `<main>fixture-gen-${currentGen}</main>`,
        captureScreenshot: async () => Buffer.from(`png-gen-${currentGen}`).toString('base64'),
        evalJs: async () => null,
      },
      artifacts
    );
    const filePort = new WorkspaceFilePort();
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts,
      reload: (value) => browser.reload(value),
    });
    filePort.write(root, 'theme.css', 'body { color: red; }');
    const report = await workflow.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target,
    });
    assert.strictEqual(reloads, 1);
    assert.strictEqual(report.target.documentGeneration, 2);
    assert.strictEqual(report.checklist.layout, true);
    const domArtifact = report.artifacts.find((item) => item.kind === 'dom');
    assert.ok(domArtifact, 'DOM artifact must exist');
    const { data: domData } = artifacts.readBytesById(domArtifact.id);
    assert.ok(domData.toString('utf8').includes('fixture-gen-2'), 'DOM artifact must be from post-reload generation 2');
    assert.strictEqual(report.artifacts.some((item) => item.kind === 'screenshot'), true);
    assert.strictEqual(report.artifacts.some((item) => item.kind === 'report'), true);
    assert.ok(report.findings);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects runtime Liquid errors and reflects in diagnostics checklist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-liquid-'));
    const target: BrowserTarget = {
      projectId: 'project-12345678901234567890',
      workspaceId: 'workspace-12345678901234567890',
      runtimeId: 'binding-12345678901234567890',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    const htmlWithLiquidError = '<html><body><div>Liquid error: Could not find snippet "product-card"</div></body></html>';
    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    let currentGen = 1;
    const browser = new BrowserControlPort(
      {
        getTabList: () => [{ id: 'tab-1' }],
        navigate: () => true,
        reload: () => {
          currentGen++;
          return true;
        },
        getDocumentGeneration: () => currentGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === currentGen,
        getDom: async () => htmlWithLiquidError,
        captureScreenshot: async () => Buffer.from('png').toString('base64'),
        evalJs: async () => null,
      },
      artifactStore
    );
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (value) => browser.reload(value),
    });

    const report = await workflow.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target,
    });

    assert.strictEqual(report.checklist.diagnostics, false);
    assert.strictEqual(report.findings?.liquid.hasErrors, true);
    assert.strictEqual(report.findings?.liquid.errors[0]?.type, 'missing_include');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sanitizes customer PII in report artifacts (RT-02 mitigation)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-pii-'));
    const target: BrowserTarget = {
      projectId: 'project-12345678901234567890',
      workspaceId: 'workspace-12345678901234567890',
      runtimeId: 'binding-12345678901234567890',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    const htmlWithPii = '<html><body><div>Liquid error: User test.merchant@example.com with phone 0987654321 not found</div></body></html>';
    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    let currentGen = 1;
    const browser = new BrowserControlPort(
      {
        getTabList: () => [{ id: 'tab-1' }],
        navigate: () => true,
        reload: () => {
          currentGen++;
          return true;
        },
        getDocumentGeneration: () => currentGen,
        isCurrentTarget: (t) => t.tabId === 'tab-1' && t.documentGeneration === currentGen,
        getDom: async () => htmlWithPii,
        captureScreenshot: async () => Buffer.from('png').toString('base64'),
        evalJs: async () => null,
      },
      artifactStore
    );
    const workflow = new ThemeQaWorkflow({
      browser,
      artifacts: artifactStore,
      reload: (value) => browser.reload(value),
    });
    const report = await workflow.validate({
      runId: 'run-12345678901234567890',
      attemptId: 'attempt-12345678901234567890',
      workspaceRoot: root,
      target,
    });

    const reportArtifact = report.artifacts.find((a) => a.kind === 'report');
    assert.ok(reportArtifact);
    const { data } = artifactStore.readBytesById(reportArtifact.id);
    const rawContent = data.toString('utf8');

    assert.ok(!rawContent.includes('test.merchant@example.com'));
    assert.ok(rawContent.includes('[REDACTED_EMAIL]'));
    assert.ok(!rawContent.includes('0987654321'));
    assert.ok(rawContent.includes('[REDACTED_PHONE]'));

    // Verify 8-dimension QA Matrix emission
    assert.ok(report.qaMatrix, 'Must generate 8-dimension QA Matrix');
    assert.strictEqual(typeof report.qaMatrix.overallScore, 'number');
    assert.ok(report.qaMatrix.dimensions.visualFidelity);
    assert.ok(report.qaMatrix.dimensions.domSemantics);
    assert.ok(report.qaMatrix.dimensions.cssModularity);
    assert.ok(report.qaMatrix.dimensions.interactiveOperability);
    assert.ok(report.qaMatrix.dimensions.haravanCompliance);
    assert.ok(report.qaMatrix.dimensions.assetIntegrity);
    assert.ok(report.qaMatrix.dimensions.responsiveParity);
    assert.ok(report.qaMatrix.dimensions.performanceCWV);

    const emittedSpecs = path.join(root, 'specs', 'qa-matrix.json');
    assert.ok(fs.existsSync(emittedSpecs), 'Must emit specs/qa-matrix.json to workspaceRoot');
    const specsContent = JSON.parse(fs.readFileSync(emittedSpecs, 'utf8'));
    assert.strictEqual(specsContent.passed, report.summary.passed);
    assert.strictEqual(typeof specsContent.overallScore, 'number');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
