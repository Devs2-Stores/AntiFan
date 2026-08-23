import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowEngine } from '../../src/main/workflow/workflow-engine';
import { WorkflowDefinition } from '../../src/main/workflow/workflow-schema';
import { registerWorkflowCapabilities } from '../../src/main/workflow/workflow-capabilities';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { registerFileCapabilities } from '../../src/main/tools/file-capabilities';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import {
  BrowserTarget,
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

function createMockHost(overrides?: Partial<BrowserHostPort>): BrowserHostPort {
  let activeTab = 'tab-1';
  const tabs = [
    { id: 'tab-1', url: 'https://example.com', title: 'Example' },
    { id: 'tab-2', url: 'https://other.com', title: 'Other' },
  ];

  return {
    getTabList: () => [...tabs],
    getActiveTabId: () => activeTab,
    switchTab: (id: string) => {
      if (tabs.some((t) => t.id === id)) {
        activeTab = id;
        return true;
      }
      return false;
    },
    navigate: (_tabId: string, url: string) => {
      const t = tabs.find((x) => x.id === activeTab);
      if (t) t.url = url;
      return true;
    },
    reload: () => true,
    getDom: async (_selector?: string) => '<div id="content"><h1>Title</h1></div>',
    captureScreenshot: async () => Buffer.from('fake-png').toString('base64'),
    evalJs: async () => null,
    agentMove: async () => true,
    agentClick: async () => true,
    agentType: async () => true,
    agentScroll: async () => true,
    agentHover: async () => true,
    agentHighlight: async () => true,
    agentClear: async () => true,
    agentSnapshot: async () => 'YAML_SNAPSHOT',
    setViewportSize: () => true,
    setDevicePreset: () => true,
    setZoom: () => true,
    getDiagnostics: () => ({ console: [], failures: [] }),
    runResponsiveCheck: async () => ({
      hasHorizontalScrollbar: false,
      scrollWidth: 1000,
      clientWidth: 1000,
      viewportWidth: 1000,
      viewportHeight: 800,
      devicePixelRatio: 1,
    }),
    ...overrides,
  };
}

describe('Workflow Engine', () => {
  it('executes a full multi-step workflow through CapabilityCatalogue with artifacts and events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const host = createMockHost();
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifacts);
    const files = new WorkspaceFilePort();

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);
    registerFileCapabilities(catalogue, files, () => root);

    const engine = new WorkflowEngine({ catalogue, artifacts });

    files.write(root, 'app.config.json', JSON.stringify({ version: '1.0.0' }));

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Smoke QA Workflow',
      steps: [
        { id: 'step-1', name: 'Navigate to app', type: 'browser.navigate', params: { url: 'https://example.com/login' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-2', name: 'Enter username', type: 'browser.type', params: { selector: '#user', text: 'admin' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-3', name: 'Click submit', type: 'browser.click', params: { selector: '#submit' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-4', name: 'Scroll page', type: 'browser.scroll', params: { deltaY: 200 }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-5', name: 'Extract DOM', type: 'browser.extract_dom', params: { selector: '#content' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-6', name: 'Capture Evidence', type: 'browser.screenshot', params: {}, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-7', name: 'Check console errors', type: 'qa.check_console_errors', params: {}, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-8', name: 'Check overflow', type: 'qa.check_overflow', params: {}, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 'step-9', name: 'Verify config', type: 'file.assert_not_contains', params: { path: 'app.config.json', pattern: 'FORBIDDEN_KEY' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    const events: string[] = [];
    const result = await engine.execute({
      workflow,
      target,
      lease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'write',
      onEvent: (ev) => events.push(ev.type),
    });

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.passedSteps, 9);
    assert.strictEqual(result.failedSteps, 0);
    assert.strictEqual(result.skippedSteps, 0);
    assert.strictEqual(result.stepResults.length, 9);
    assert.strictEqual(result.artifacts.length > 0, true);
    assert.strictEqual(events.includes('workflow:start'), true);
    assert.strictEqual(events.includes('workflow:end'), true);
  });

  it('rejects mismatched projectId, workspaceId, runtimeId, or forged lease before any browser action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-sec-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    let browserNavigated = false;
    const host = createMockHost({
      navigate: () => {
        browserNavigated = true;
        return true;
      },
    });
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifacts);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerBrowserCapabilities(catalogue, browser);

    const engine = new WorkflowEngine({ catalogue, artifacts });

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Security Test',
      steps: [
        { id: 's1', name: 'Nav', type: 'browser.navigate', params: { url: 'https://example.com' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    // 1. Mismatched project ID
    const targetWrongProject: BrowserTarget = {
      projectId: 'project-WRONG123456789012',
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res1 = await engine.execute({
      workflow,
      target: targetWrongProject,
      lease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'write',
    });
    assert.strictEqual(res1.status, 'failed');
    assert.strictEqual(res1.stepResults[0]?.error?.includes('Project'), true);
    assert.strictEqual(browserNavigated, false, 'No browser call must occur on project mismatch');

    // 2. Mismatched workspace ID
    const targetWrongWorkspace: BrowserTarget = {
      projectId,
      workspaceId: 'workspace-WRONG123456789',
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res2 = await engine.execute({
      workflow,
      target: targetWrongWorkspace,
      lease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'write',
    });
    assert.strictEqual(res2.status, 'failed');
    assert.strictEqual(res2.stepResults[0]?.error?.includes('Workspace'), true);
    assert.strictEqual(browserNavigated, false, 'No browser call must occur on workspace mismatch');

    // 3. Forged lease
    const forgedLease = { ...lease, token: 'forged-token' };
    const validTarget: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res3 = await engine.execute({
      workflow,
      target: validTarget,
      lease: forgedLease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'write',
    });
    assert.strictEqual(res3.status, 'failed');
    assert.strictEqual(browserNavigated, false, 'No browser call must occur on forged lease');
  });

  it('enforces policy grants on file operations and rejects write step when grant is read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-policy-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const host = createMockHost();
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifacts);
    const files = new WorkspaceFilePort();

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);
    registerFileCapabilities(catalogue, files, () => root);

    const engine = new WorkflowEngine({ catalogue, artifacts });

    // Workflow attempting file write with read-only grant
    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Unauthorized File Write Test',
      steps: [
        { id: 's1', name: 'Unauthorized Write', type: 'file.write', params: { path: 'secret.txt', content: 'unauthorized' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    const res = await engine.execute({
      workflow,
      target,
      lease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'read', // READ grant executing WRITE step
    });

    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.stepResults[0]?.error?.includes('policy'), true);
    assert.strictEqual(fs.existsSync(path.join(root, 'secret.txt')), false, 'File must not be written without write grant');
  });

  it('handles abort signal and interrupts execution cleanly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-abort-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const host = createMockHost();
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifacts);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);

    const engine = new WorkflowEngine({ catalogue, artifacts });

    const ac = new AbortController();

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Abort Test',
      steps: [
        { id: 's1', name: 'Step 1', type: 'browser.click', params: { selector: '#btn' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 's2', name: 'Step 2', type: 'browser.type', params: { selector: '#input', text: 'test' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    // Abort before start
    ac.abort();

    const res = await engine.execute({
      workflow,
      target,
      lease,
      runId: 'run-1',
      attemptId: 'attempt-1',
      grant: 'write',
      signal: ac.signal,
    });

    assert.strictEqual(res.status, 'interrupted');
    assert.strictEqual(res.skippedSteps > 0, true);
  });

  it('supports registration in CapabilityCatalogue via registerWorkflowCapabilities', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-cap-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const host = createMockHost();
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(host, artifacts);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);

    const engine = new WorkflowEngine({ catalogue, artifacts });
    registerWorkflowCapabilities(catalogue, engine);

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Workflow Capability Test',
      steps: [
        { id: 's1', name: 'Click', type: 'browser.click', params: { selector: '#btn' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    const result = (await catalogue.dispatch(
      'workflow.execute',
      { workflow },
      {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
        browserTarget: target,
        grant: 'write',
      }
    )) as { status: string; passedSteps: number };

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.passedSteps, 1);

    // Enforce rejection when browserTarget is missing
    await assert.rejects(
      () =>
        catalogue.dispatch(
          'workflow.execute',
          { workflow },
          {
            lease,
            leaseToken: lease.token,
            projectId,
            workspaceId,
            grant: 'write',
          }
        ),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED'
    );
  });
});
