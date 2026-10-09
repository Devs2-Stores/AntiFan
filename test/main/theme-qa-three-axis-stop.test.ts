import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  evaluateThreeAxisStop,
  MAX_REPAIR_ITERATIONS,
  type ThreeAxisState,
} from '../../src/main/qa/three-axis-stop';
import { ThemeQaWorkflow, type ThemeQaReport } from '../../src/main/qa/theme-qa-workflow';
import type { ThemeRepairBeginResult, ThemeRepairVerificationResult } from '../../src/main/qa/theme-qa-repair-coordinator';
import { ThemeQaRepairCoordinator } from '../../src/main/qa/theme-qa-repair-coordinator';
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
import { TINY_PNG_BASE64, verificationCaptureEnvelope } from './verification-capture-fixture';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';

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
    return TINY_PNG_BASE64;
  }

  async captureVerificationScreenshot(_rect?: unknown, _tabId?: string, _paneId?: unknown, options?: { fullPage?: boolean }) {
    return verificationCaptureEnvelope(TINY_PNG_BASE64, { fullPage: options?.fullPage });
  }

  getNetworkTracker(): {
    isAttached: () => boolean;
    awaitQuiescence: () => Promise<{ settled: boolean; durationMs: number; timedOut: boolean }>;
  } {
    return {
      isAttached: () => true,
      awaitQuiescence: async () => ({ settled: true, durationMs: 1, timedOut: false }),
    };
  }

  async evalJs(expression: string, _tabId?: string): Promise<unknown> {
    if (expression.includes('img.decode') || expression.includes('relevantImages')) {
      return { settled: true, brokenImages: [] };
    }
    if (expression.includes('document.fonts') || expression.includes('requestAnimationFrame') || expression.includes('rafPromise') || expression.includes('settleScript')) {
      return true;
    }
    if (expression.includes('LayoutOverflowEngine') || expression.includes('window.innerWidth')) {
      return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
    }
    if (expression.includes('HsGateRules') || expression.includes('violations')) {
      return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
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

describe('three-axis-stop pure evaluator', () => {
  it('proceeds to verified only when sufficiency is complete with zero gaps', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 1, missingness: 0, contradiction: 0 }, 1);
    assert.equal(decision.action, 'PROCEED_VERIFIED');
  });

  it('gives contradiction (regression) absolute priority over every other axis', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 1, missingness: 0, contradiction: 1 }, 99);
    assert.equal(decision.action, 'ABORT_ROLLBACK');
  });

  it('blocks a false-positive verification when evidence is missing', () => {
    // sufficiency claims complete, but gaps exist: must NOT verify
    const decision = evaluateThreeAxisStop({ sufficiency: 1, missingness: 2, contradiction: 0 }, 1);
    assert.notEqual(decision.action, 'PROCEED_VERIFIED');
    assert.equal(decision.action, 'CONTINUE_REPAIR');
  });

  it('stops immediately when missingness exceeds the gap threshold regardless of attempts', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 1, missingness: 4, contradiction: 0 }, 1);
    assert.equal(decision.action, 'ABORT_BLOCKED');
    assert.equal(decision.reason, 'STOP_CRITERIA_EXCEEDED');
  });

  it('blocks the retry loop at the attempt cap', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 0, missingness: 0, contradiction: 0 }, MAX_REPAIR_ITERATIONS);
    assert.equal(decision.action, 'ABORT_BLOCKED');
    assert.equal(decision.reason, 'STOP_CRITERIA_EXCEEDED');
  });

  it('continues repair while evidence is incomplete but the budget is not exhausted', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 0, missingness: 1, contradiction: 0 }, 1);
    assert.equal(decision.action, 'CONTINUE_REPAIR');
  });

  it('honors a custom attempt cap', () => {
    const decision = evaluateThreeAxisStop({ sufficiency: 0, missingness: 0, contradiction: 0 }, 2, 2);
    assert.equal(decision.action, 'ABORT_BLOCKED');
  });

  it('computes stop decisions within the 0.5ms per-call budget', () => {
    const state: ThreeAxisState = { sufficiency: 0, missingness: 1, contradiction: 0 };
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      evaluateThreeAxisStop(state, i % 5);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 500, `1000 evaluations took ${elapsedMs}ms (budget 500ms, i.e. 0.5ms/call)`);
  });
});

describe('ThemeQaRepairCoordinator 3-axis stop wiring', () => {
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
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'antifan-three-axis-stop-test-'));
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
      runId: 'run-three-axis-stop-1',
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
      fsQuiescenceMs: 0,
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

  it('blocks a persistent-failure retry session deterministically at the 3rd verify round', async () => {
    mockHost.currentHtml = '<html><body><!-- liquid error: Unknown tag legacy_tag --></body></html>';
    const begin = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as ThemeRepairBeginResult;
    // Rounds 1-2: failure without regressions keeps the bounded retry session open
    for (let round = 1; round <= 2; round++) {
      fs.writeFileSync(path.join(workspaceRoot, `attempt-${round}.liquid`), String(round));
      const result = (await catalogue.dispatch('theme.qa_repair.verify', { sessionId: begin.sessionId }, mockContext)) as ThemeRepairVerificationResult;
      assert.equal(result.success, false);
      assert.equal(result.status, 'awaiting_fix');
    }

    // Round 3: attempt cap reached -> deterministic stop, not an open retry
    fs.writeFileSync(path.join(workspaceRoot, 'attempt-3.liquid'), '3');
    const stopped = (await catalogue.dispatch('theme.qa_repair.verify', { sessionId: begin.sessionId }, mockContext)) as ThemeRepairVerificationResult;
    assert.equal(stopped.success, false);
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.stopReason, 'STOP_CRITERIA_EXCEEDED');
    assert.equal(stopped.remainingRepairs, 0);

    // Round 4: terminal session is refused by the existing state machine
    fs.writeFileSync(path.join(workspaceRoot, 'attempt-4.liquid'), '4');
    await assert.rejects(
      catalogue.dispatch('theme.qa_repair.verify', { sessionId: begin.sessionId }, mockContext),
      (error: unknown) => error instanceof CapabilityError && error.code === 'REPLAY_DENIED'
    );
  });

  it('bounds persistent evidence-gap retries: the 4th verify on a gap-exhausted session is refused', async () => {
    mockHost.currentHtml = '<html><body><main>Clean</main></body></html>';
    const begin = (await catalogue.dispatch('theme.qa_repair.begin', {}, mockContext)) as ThemeRepairBeginResult;

    // Reachable gap source: the layout overflow scanner returns a measurement the
    // workflow rejects, so the report cannot certify PASS and records an evidence gap.
    const overflowScan = LayoutOverflowEngine.getBrowserScanScript('active');
    const mutableHost = mockHost as unknown as { evalJs: (expression: string, tabId?: string) => Promise<unknown> };
    const originalEvalJs = mutableHost.evalJs.bind(mockHost);
    mutableHost.evalJs = async (expression: string, tabId?: string) =>
      expression === overflowScan ? {} : originalEvalJs(expression, tabId);
    try {
      // Rounds 1-3: incomplete evidence, session stays retryable until the iteration cap
      for (let round = 1; round <= 3; round++) {
        fs.writeFileSync(path.join(workspaceRoot, `gap-${round}.liquid`), String(round));
        await assert.rejects(
          catalogue.dispatch('theme.qa_repair.verify', { sessionId: begin.sessionId }, mockContext),
          (error: unknown) => error instanceof CapabilityError && error.code === 'SETTLE_INCOMPLETE'
        );
      }

      // Round 4: the m_d axis made the session terminal after the 3rd gap round
      fs.writeFileSync(path.join(workspaceRoot, 'gap-4.liquid'), '4');
      await assert.rejects(
        catalogue.dispatch('theme.qa_repair.verify', { sessionId: begin.sessionId }, mockContext),
        (error: unknown) => error instanceof CapabilityError && error.code === 'REPLAY_DENIED'
      );
    } finally {
      mutableHost.evalJs = originalEvalJs;
    }
  });
});

describe('ThemeQaRepairCoordinator single-round gap threshold (m_d axis)', () => {
  let workspaceRoot = '';
  let target: BrowserTarget;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-md-axis-'));
    target = { projectId: 'p', workspaceId: 'w', runtimeId: 'r', tabId: 't' } as unknown as BrowserTarget;
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const gapReport = (gapCount: number): ThemeQaReport =>
    ({
      summary: { passed: false },
      findings: {
        differential: { hasRegressions: false },
        evidenceGaps: Array.from({ length: gapCount }, (_, index) => `gap-${index}`),
      },
    }) as unknown as ThemeQaReport;

  const coordinatorReporting = (gapCount: () => number): ThemeQaRepairCoordinator =>
    new ThemeQaRepairCoordinator({
      validate: async () => gapReport(gapCount()),
    } as unknown as ThemeQaWorkflow);

  it('blocks the session on the first round that reports more gaps than the threshold', async () => {
    let gaps = 1;
    const coordinator = coordinatorReporting(() => gaps);
    fs.writeFileSync(path.join(workspaceRoot, 'theme.liquid'), 'v1');
    const begin = (await coordinator.begin({ workspaceRoot, target, runId: 'run-md-axis' })) as ThemeRepairBeginResult;

    gaps = 4;
    fs.writeFileSync(path.join(workspaceRoot, 'theme.liquid'), 'v2');
    await assert.rejects(
      coordinator.verify({ sessionId: begin.sessionId, target }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'SETTLE_INCOMPLETE' &&
        error.message.includes('STOP_CRITERIA_EXCEEDED')
    );

    // The session is terminal, not awaiting another fix: the state machine refuses it by name.
    await assert.rejects(
      coordinator.verify({ sessionId: begin.sessionId, target }),
      (error: unknown) =>
        error instanceof CapabilityError && error.code === 'REPLAY_DENIED' && error.message.includes('"blocked"')
    );
  });

  it('keeps the session retryable when a round stays within the gap threshold', async () => {
    let gaps = 1;
    const coordinator = coordinatorReporting(() => gaps);
    fs.writeFileSync(path.join(workspaceRoot, 'theme.liquid'), 'v1');
    const begin = (await coordinator.begin({ workspaceRoot, target, runId: 'run-md-axis' })) as ThemeRepairBeginResult;

    gaps = 3;
    fs.writeFileSync(path.join(workspaceRoot, 'theme.liquid'), 'v2');
    await assert.rejects(
      coordinator.verify({ sessionId: begin.sessionId, target }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'SETTLE_INCOMPLETE' &&
        !error.message.includes('STOP_CRITERIA_EXCEEDED')
    );

    // Still awaiting a fix: the unchanged revision is refused as a replay, not as a blocked session.
    await assert.rejects(
      coordinator.verify({ sessionId: begin.sessionId, target }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'REPLAY_DENIED' &&
        error.message.includes('has not changed')
    );
  });
});
