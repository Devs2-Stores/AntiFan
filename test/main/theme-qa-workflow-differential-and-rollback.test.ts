import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import {
  BrowserTarget,
  CapabilityError,
  CapabilityRequestContext,
  RuntimeLease,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { ProjectRegistry } from '../../src/main/project/project-registry';
import { WorkspaceRegistry } from '../../src/main/project/workspace-registry';

class MockBrowserHost implements BrowserHostPort {
  public currentHtml = '';
  public documentGeneration = 1;
  public browserEpoch = 1;
  public boundProjectId = '';
  public boundWorkspaceId = '';

  getTabList(): unknown[] {
    return [{ id: 'tab-test-1', url: 'https://mystore.haravan.com/' }];
  }

  getDocumentGeneration(_tabId?: string): number {
    return this.documentGeneration;
  }

  isCurrentTarget(target: BrowserTarget): boolean {
    return Boolean(
      target &&
        target.tabId === 'tab-test-1' &&
        target.projectId === this.boundProjectId &&
        target.workspaceId === this.boundWorkspaceId
    );
  }

  async getDom(_selector?: string, _tabId?: string): Promise<string> {
    return this.currentHtml;
  }

  async captureScreenshot(_tabId?: string): Promise<string> {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }

  async evalJs(expression: string, _tabId?: string): Promise<unknown> {
    if (expression.includes('LayoutOverflowEngine') || expression.includes('window.innerWidth')) {
      return { hasOverflow: false, deltaX: 0, culprits: [] };
    }
    if (expression.includes('HsGateRules') || expression.includes('violations')) {
      return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    }
    if (expression.includes('document.fonts') || expression.includes('rafPromise') || expression.includes('settleScript')) {
      return true;
    }
    return {};
  }

  getDiagnostics(_tabId?: string): { console: unknown[]; failures: unknown[] } {
    return { console: [], failures: [] };
  }

  async runResponsiveCheck(_tabId: string): Promise<Record<string, unknown>> {
    return { breakpoints: {} };
  }

  async navigate(_url: string, _tabId?: string): Promise<boolean> {
    return true;
  }

  async reload(_tabId?: string): Promise<boolean> {
    this.documentGeneration++;
    return true;
  }
}

describe('Theme QA Repair Capability Lifecycle & Differential Rollback via Dispatch', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let artifactStore: ArtifactStore;
  let mockHost: MockBrowserHost;
  let browserControl: BrowserControlPort;
  let catalogue: CapabilityCatalogue;
  let workflow: ThemeQaWorkflow;
  let workspaceRegistry: WorkspaceRegistry;
  let projectRegistry: ProjectRegistry;
  let projectId: string;
  let workspaceId: string;
  let lease: RuntimeLease;
  let mockTarget: BrowserTarget;
  let mockContext: CapabilityRequestContext;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'antifan-repair-dispatch-test-'));
    workspaceRoot = path.join(tempDir, 'theme-repo');
    const artifactsDir = path.join(tempDir, 'artifacts');
    await fs.promises.mkdir(workspaceRoot, { recursive: true });
    await fs.promises.mkdir(artifactsDir, { recursive: true });

    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

    mockTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-test-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    mockContext = {
      projectId,
      workspaceId,
      leaseToken: lease.token,
      lease,
      browserTarget: mockTarget,
      grant: 'write',
      runId: 'run-repair-e2e-1',
      attemptId: 'att-1',
    };

    projectRegistry = new ProjectRegistry();
    projectRegistry.registerProject({
      id: projectId,
      name: 'test-project',
      dataRoot: tempDir,
      state: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    workspaceRegistry = new WorkspaceRegistry(projectRegistry);
    workspaceRegistry.register({
      id: workspaceId,
      projectId,
      rootPath: workspaceRoot,
      state: 'attached',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    artifactStore = new ArtifactStore({ root: artifactsDir });
    mockHost = new MockBrowserHost();
    mockHost.boundProjectId = projectId;
    mockHost.boundWorkspaceId = workspaceId;

    browserControl = new BrowserControlPort(mockHost, artifactStore);
    workflow = new ThemeQaWorkflow({
      browser: browserControl,
      artifacts: artifactStore,
      reload: async (target) => ({ reloaded: true, target }),
    });

    catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      workspaceRegistry,
    });

    registerBrowserCapabilities(catalogue, browserControl, workflow, () => workspaceRoot);

    // Setup initial baseline theme files
    await fs.promises.mkdir(path.join(workspaceRoot, 'layout'), { recursive: true });
    await fs.promises.mkdir(path.join(workspaceRoot, 'snippets'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      '<!DOCTYPE html><html><head></head><body><h1>Original Baseline Theme</h1></body></html>',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'snippets', 'card.liquid'),
      '<div class="product-card">Card</div>',
      'utf8'
    );
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('dispatches theme.qa_repair.begin, verifies regression via dispatch, auto-rolls back to R0 and rejects replay', async () => {
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Haravan Store</title></head>
      <body>
        <!-- Haravan theme indicator -->
        <script src="https://theme.hstatic.net/1000/assets/app.js"></script>
        <!-- Pre-existing baseline liquid error -->
        <!-- liquid error: Unknown tag 'legacy_tag' -->
      </body>
      </html>
    `;

    // 1. Dispatch theme.qa_repair.begin through CapabilityCatalogue.dispatch
    const beginRes = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as any;
    assert.ok(beginRes.sessionId, 'Must return opaque sessionId');
    assert.equal(beginRes.summary.passed, false, 'Round 1 fails due to baseline error');
    assert.ok(beginRes.report.findings?.liquid.hasErrors);

    const sessionId = beginRes.sessionId;

    // 2. Perform external authorized file edits introducing a REGRESSION
    // Modify theme.liquid
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      '<!DOCTYPE html><html><body>MODIFIED REGRESSION CODE</body></html>',
      'utf8'
    );
    // Add newly created orphan file
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'snippets', 'orphan-regression.liquid'),
      '{% bad_syntax %}',
      'utf8'
    );

    // Update DOM to reflect regression
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Haravan Store</title></head>
      <body>
        <script src="https://theme.hstatic.net/1000/assets/app.js"></script>
        <!-- Pre-existing baseline liquid error -->
        <!-- liquid error: Unknown tag 'legacy_tag' -->
        <!-- INTRODUCED REGRESSION -->
        <!-- liquid error: Liquid syntax error: Unknown tag 'bad_syntax' -->
      </body>
      </html>
    `;

    // 3. Dispatch theme.qa_repair.verify through CapabilityCatalogue.dispatch
    const verifyRes = (await catalogue.dispatch(
      'theme.qa_repair.verify',
      { sessionId },
      { ...mockContext, attemptId: 'att-2' }
    )) as any;

    assert.equal(verifyRes.success, false, 'Verify must fail due to regression');
    assert.equal(verifyRes.rolledBack, true, 'Must automatically execute rollback to R0');
    assert.ok(verifyRes.rollbackResult);
    assert.equal(verifyRes.rollbackResult.success, true);
    assert.equal(verifyRes.rollbackResult.restoredFiles.length, 1);
    assert.equal(verifyRes.rollbackResult.restoredFiles[0], 'layout/theme.liquid');
    assert.equal(verifyRes.rollbackResult.deletedOrphanFiles.length, 1);
    assert.equal(verifyRes.rollbackResult.deletedOrphanFiles[0], 'snippets/orphan-regression.liquid');

    // Verify filesystem state after rollback
    const restoredTheme = await fs.promises.readFile(path.join(workspaceRoot, 'layout', 'theme.liquid'), 'utf8');
    assert.equal(restoredTheme, '<!DOCTYPE html><html><head></head><body><h1>Original Baseline Theme</h1></body></html>');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'snippets', 'orphan-regression.liquid')), false);

    // 4. Verify replay prevention: second verify with same sessionId must throw REPLAY_DENIED
    await assert.rejects(
      async () => {
        await catalogue.dispatch(
          'theme.qa_repair.verify',
          { sessionId },
          { ...mockContext, attemptId: 'att-3' }
        );
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'REPLAY_DENIED');
        return true;
      }
    );
  });

  it('verifies happy-path repair session without regressions (success: true, rolledBack: false)', async () => {
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Haravan Store</title></head>
      <body>
        <script src="https://theme.hstatic.net/1000/assets/app.js"></script>
        <!-- Pre-existing baseline liquid error -->
        <!-- liquid error: Unknown tag 'legacy_tag' -->
      </body>
      </html>
    `;

    const beginRes = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as any;
    const sessionId = beginRes.sessionId;

    // Perform a clean fix (removing baseline error)
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Haravan Store</title></head>
      <body>
        <script src="https://theme.hstatic.net/1000/assets/app.js"></script>
        <div>Clean Fixed Storefront</div>
      </body>
      </html>
    `;

    const verifyRes = (await catalogue.dispatch(
      'theme.qa_repair.verify',
      { sessionId },
      { ...mockContext, attemptId: 'att-clean-2' }
    )) as any;

    assert.strictEqual(verifyRes.success, true, 'Clean fix must pass verification');
    assert.strictEqual(verifyRes.rolledBack, false, 'Clean fix must not trigger rollback');
  });

  it('executes explicit theme.qa_rollback capability dispatch', async () => {
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html>
      <body><script src="https://theme.hstatic.net/1000/assets/app.js"></script></body>
      </html>
    `;

    const beginRes = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as any;
    const sessionId = beginRes.sessionId;

    // Mutate file
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'layout', 'theme.liquid'),
      'MODIFIED BEFORE EXPLICIT ROLLBACK',
      'utf8'
    );

    const rollbackRes = (await catalogue.dispatch(
      'theme.qa_rollback',
      { sessionId },
      { ...mockContext, attemptId: 'att-rollback' }
    )) as any;

    assert.strictEqual(rollbackRes.success, true);
    const content = await fs.promises.readFile(path.join(workspaceRoot, 'layout', 'theme.liquid'), 'utf8');
    assert.strictEqual(content, '<!DOCTYPE html><html><head></head><body><h1>Original Baseline Theme</h1></body></html>');
  });

  it('rejects verify with TARGET_MISMATCH when target coordinates change', async () => {
    mockHost.currentHtml = `
      <!DOCTYPE html>
      <html><body><script src="https://theme.hstatic.net/1000/assets/app.js"></script></body></html>
    `;
    const beginRes = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as any;
    const sessionId = beginRes.sessionId;

    const mismatchedTarget: BrowserTarget = {
      ...mockTarget,
      tabId: 'different-tab-id-999',
    };

    await assert.rejects(
      async () => {
        await catalogue.dispatch(
          'theme.qa_repair.verify',
          { sessionId },
          { ...mockContext, browserTarget: mismatchedTarget, attemptId: 'att-mismatch' }
        );
      },
      (err: any) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'TARGET_MISMATCH');
        return true;
      }
    );
  });
});
