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
    const target: BrowserTarget = { projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890', runtimeId: 'binding-12345678901234567890', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
    let reloads = 0;
    const browser = new BrowserControlPort({ getTabList: () => [], navigate: () => true, reload: () => { reloads++; return true; }, getDom: async () => '<main>fixture</main>', captureScreenshot: async () => Buffer.from('png').toString('base64'), evalJs: async () => null }, new ArtifactStore({ root: path.join(root, 'artifacts') }));
    const workflow = new ThemeQaWorkflow({ browser, files: new WorkspaceFilePort(), artifacts: new ArtifactStore({ root: path.join(root, 'reports') }), reload: (value) => browser.reload(value) });
    workflow.edit({ workspaceRoot: root, relativePath: 'theme.css', content: 'body { color: red; }' });
    const report = await workflow.validate({ runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890', workspaceRoot: root, target });
    assert.strictEqual(reloads, 1);
    assert.strictEqual(report.checklist.layout, true);
    assert.strictEqual(report.artifacts.some((item) => item.kind === 'report'), true);
  });
});
