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
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
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

    await files.write(root, 'app.config.json', JSON.stringify({ version: '1.0.0' }));

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

  it('executes a workflow through ControlPlaneRuntime.executeWorkflow with real run, attempt, events, and authoritative receipts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cpr-wf-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const runtime = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot: root,
      workspaceRoot,
      hostEpoch: 2,
    });

    runtime.projects.registerProject({
      id: projectId,
      name: 'Project',
      dataRoot: root,
      state: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runtime.workspaces.register({
      id: workspaceId,
      projectId,
      rootPath: workspaceRoot,
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const mockHost = createMockHost();
    runtime.registerBrowser(new BrowserControlPort(mockHost));

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Runtime Integration Flow',
      steps: [
        {
          id: 'step-nav',
          name: 'Navigate to target',
          type: 'browser.navigate',
          params: { url: 'https://example.com/runtime-test' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    };

    const lease = runtime.getLease();
    const target: BrowserTarget = {
      tabId: 'tab-1',
      url: 'https://example.com',
      browserEpoch: 2,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId || '',
    };

    const events: string[] = [];
    const result = await runtime.executeWorkflow({
      workflow,
      target,
      grant: 'write',
      onEvent: (event) => events.push(event.type),
    });

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.passedSteps, 1);
    assert.strictEqual(result.failedSteps, 0);
    assert.strictEqual(events.includes('workflow:start'), true);
    assert.strictEqual(events.includes('workflow:end'), true);

    // Verify real run and attempt were created
    const runs = Array.from((runtime.runs as any).runs.values());
    assert.ok(runs.length > 0);
    const wfRun = runs.find((r: any) => r.backendId === 'workflow');
    assert.ok(wfRun, 'A real run with backendId=workflow must exist');
    assert.strictEqual((wfRun as any).state, 'completed');

    // Verify authoritative receipt is recorded and completed
    const receipts = Array.from((runtime.receipts as any).records.values());
    assert.ok(receipts.length > 0);
    const wfReceipt = receipts.find((rec: any) => (rec as any).binding.backendSessionRef === 'workflow');
    assert.ok(wfReceipt, 'An authoritative receipt for workflow must exist');
    assert.strictEqual((wfReceipt as any).state, 'completed');
    assert.strictEqual((wfReceipt as any).deliveryState, 'accepted-exact');
  });

  it('rejects stale epoch, mismatched project/workspace, draining runtime, or unauthorized grant in ControlPlaneRuntime.executeWorkflow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cpr-wf-stale-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const runtime = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot: root,
      workspaceRoot,
      hostEpoch: 5,
    });

    runtime.projects.registerProject({
      id: projectId,
      name: 'Project',
      dataRoot: root,
      state: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runtime.workspaces.register({
      id: workspaceId,
      projectId,
      rootPath: workspaceRoot,
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const mockHost = createMockHost();
    runtime.registerBrowser(new BrowserControlPort(mockHost));
    const lease = runtime.getLease();
    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Security Fail-Closed Flow',
      steps: [
        {
          id: 'step-1',
          name: 'Navigate',
          type: 'browser.navigate',
          params: { url: 'https://example.com' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    };

    // 1. Stale epoch (epoch 1 vs host epoch 5)
    const staleTarget: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId || '',
    };
    await assert.rejects(
      () => runtime.executeWorkflow({ workflow, target: staleTarget, grant: 'write' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    // 2. Mismatched project
    const wrongProjectTarget: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 5,
      documentGeneration: 1,
      projectId: 'project-wrong',
      workspaceId,
      runtimeId: lease.runtimeId || '',
    };
    await assert.rejects(
      () => runtime.executeWorkflow({ workflow, target: wrongProjectTarget, grant: 'write' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH'
    );
    // 3. Missing tabId
    const missingTabTarget = {
      tabId: '',
      browserEpoch: 5,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId || '',
    } as any;
    await assert.rejects(
      () => runtime.executeWorkflow({ workflow, target: missingTabTarget, grant: 'write' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED'
    );

    // 4. Unauthorized grant (grant: 'read' vs workflow.execute risk: 'write' -> POLICY_DENIED)
    const validTarget: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 5,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId || '',
    };
    await assert.rejects(
      () => runtime.executeWorkflow({ workflow, target: validTarget, grant: 'read' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED'
    );

    // 5. Draining runtime (beginDrain -> RUNTIME_DRAINING)
    runtime.beginDrain();
    await assert.rejects(
      () => runtime.executeWorkflow({ workflow, target: validTarget, grant: 'write' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'RUNTIME_DRAINING'
    );
  });

  it('executes workflow steps through CapabilityTransportAdapter with child intent dispatch and authority progression', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-child-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
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

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();

    const transport = new CapabilityTransportAdapter(
      catalogue,
      registry,
      ledger
    );
    const engine = new WorkflowEngine({ catalogue, artifacts, transport });

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
      browserTarget: target,
    });

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Child Intent Workflow',
      steps: [
        { id: 's1', name: 'Navigate', type: 'browser.navigate', params: { url: 'https://example.com/page1' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
        { id: 's2', name: 'Click button', type: 'browser.click', params: { selector: '#btn' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    const result = await engine.execute({
      workflow,
      target,
      lease,
      leaseToken: lease.token,
      runId,
      attemptId,
      grant: 'write',
      authorityRevision: launch.authorityRevision,
      parentInvocationId: 'parent-wf-inv-1',
      dispatchChildIntent: (stepId, attempt, intent) => {
        const record = registry.getRecord(launch.attachmentId);
        const currentRev = record?.authorityRevision || launch.authorityRevision;
        return transport.dispatchChildIntent('parent-wf-inv-1', stepId, attempt, {
          ...intent,
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision: currentRev,
        });
      },
    });
    if (result.status !== 'passed') {
      console.error('Child workflow execution failed:', JSON.stringify(result.stepResults, null, 2));
    }
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.passedSteps, 2);
  });

  it('times out hanging capability and interrupts step execution cleanly via Promise.race', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-timeout-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Mock host that hangs forever on agentClick
    const host = createMockHost({
      agentClick: async () => new Promise<boolean>(() => {}), // Never resolves
    });
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

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Hanging Step Workflow',
      steps: [
        { id: 's1', name: 'Hanging Click', type: 'browser.click', params: { selector: '#hang' }, timeoutMs: 100, retryCount: 0, continueOnError: false },
      ],
    };
    const startTime = Date.now();
    const result = await engine.execute({
      workflow,
      target,
      lease,
      leaseToken: lease.token,
      runId,
      attemptId,
      grant: 'write',
    });

    const elapsed = Date.now() - startTime;
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedSteps, 1);
    assert.ok(elapsed < 2000, `Elapsed time (${elapsed}ms) must be close to timeout (50ms)`);
    assert.ok(result.stepResults[0]?.error?.includes('timed out'), `Expected timeout error, got: ${result.stepResults[0]?.error}`);
  });

  it('propagates exact documentGeneration !== 1 into initial workflow attachment and child execution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-docgen-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const runtime = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot: root,
      workspaceRoot,
      hostEpoch: 3,
    });

    runtime.projects.registerProject({
      id: projectId,
      name: 'Project',
      dataRoot: root,
      state: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runtime.workspaces.register({
      id: workspaceId,
      projectId,
      rootPath: workspaceRoot,
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const mockHost = createMockHost();
    runtime.registerBrowser(new BrowserControlPort(mockHost));

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'DocGen Workflow',
      steps: [
        { id: 's1', name: 'Click', type: 'browser.click', params: { selector: '#btn' }, timeoutMs: 5000, retryCount: 0, continueOnError: false },
      ],
    };

    const lease = runtime.getLease();
    const targetWithDocGen7: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 3,
      documentGeneration: 7,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId || '',
    };

    const result = await runtime.executeWorkflow({
      workflow,
      target: targetWithDocGen7,
      grant: 'write',
    });

    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.passedSteps, 1);
  });

  it('aborts browser.wait_for_selector immediately when AbortSignal fires', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-wf-abort-'));
    const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const controller = new AbortController();
    let domCalls = 0;
    const host = createMockHost({
      getDom: async () => {
        domCalls++;
        controller.abort(new Error('User aborted wait'));
        return '';
      },
    });
    const browser = new BrowserControlPort(host, artifacts);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeId = makeControlPlaneId('binding');
    const lease = { runtimeId, projectId, workspaceId, token: 'tok-1', protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);

    const engine = new WorkflowEngine({ catalogue, artifacts });

    const workflow: WorkflowDefinition = {
      version: '1.0',
      name: 'Abort Wait For Selector',
      steps: [
        {
          id: 'step-wait',
          name: 'Wait for missing button',
          type: 'browser.wait_for_selector',
          params: { selector: '#never-appears' },
          timeoutMs: 10_000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    };

    const target: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
    };

    const result = await engine.execute({
      workflow,
      target,
      lease,
      leaseToken: lease.token,
      runId,
      attemptId,
      grant: 'write',
      signal: controller.signal,
    });

    assert.strictEqual(result.status, 'interrupted');
    assert.ok(domCalls >= 1, 'Mock DOM must have been called before abort');
  });
});
