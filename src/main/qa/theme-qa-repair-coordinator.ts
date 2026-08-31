import { randomUUID } from 'node:crypto';
import { CapabilityError, BrowserTarget } from '../../shared/control-plane-contracts';
import { ThemeQaWorkflow, ThemeQaReport, ThemeQaSummary, ThemeQaDetailedFindings } from './theme-qa-workflow';
import {
  createWorkspaceSnapshotManifest,
  rollbackWorkspaceToManifest,
  type WorkspaceSnapshotManifest,
  type WorkspaceRollbackResult,
} from './workspace-snapshot-rollback';

interface RepairSessionState {
  sessionId: string;
  runId: string;
  workspaceRoot: string;
  target: {
    projectId: string;
    workspaceId: string;
    runtimeId: string;
    tabId: string;
  };
  manifest: WorkspaceSnapshotManifest;
  r1Findings?: ThemeQaDetailedFindings;
  status: 'awaiting_fix' | 'verifying' | 'verified' | 'rolled_back';
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class ThemeQaRepairCoordinator {
  private sessions = new Map<string, RepairSessionState>();

  constructor(private readonly workflow: ThemeQaWorkflow) {}

  /**
   * Begins a safe repair session:
   * 1. Creates an immutable R0 snapshot manifest of workspaceRoot before mutations.
   * 2. Executes Round 1 validation to establish baseline findings.
   * 3. Stores private session state bound strictly to the project/workspace/runtime/tab target.
   * 4. Returns an opaque single-use sessionId along with the Round 1 QA report.
   */
  async begin(input: {
    workspaceRoot: string;
    target: BrowserTarget;
    runId: string;
    attemptId?: string;
  }): Promise<{ sessionId: string; report: ThemeQaReport; summary: ThemeQaSummary }> {
    if (!input.workspaceRoot) {
      throw new CapabilityError('INVALID_ARGUMENT', 'workspaceRoot is required for theme repair session');
    }
    if (!input.target?.projectId || !input.target?.workspaceId || !input.target?.runtimeId || !input.target?.tabId) {
      throw new CapabilityError('TARGET_REQUIRED', 'Theme repair session requires explicit target binding');
    }

    const safeRunId = (input.runId || 'run-repair').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const attemptId = input.attemptId || 'attempt-r1';

    // 1. Snapshot R0 baseline before any mutations occur
    const snapshotManifest = await createWorkspaceSnapshotManifest(input.workspaceRoot, safeRunId);

    // 2. Round 1 Baseline Validation (pure read-only)
    const report = await this.workflow.validate({
      runId: safeRunId,
      attemptId,
      workspaceRoot: input.workspaceRoot,
      target: input.target,
    });

    const sessionId = randomUUID();
    const session: RepairSessionState = {
      sessionId,
      runId: safeRunId,
      workspaceRoot: input.workspaceRoot,
      target: {
        projectId: input.target.projectId,
        workspaceId: input.target.workspaceId,
        runtimeId: input.target.runtimeId,
        tabId: input.target.tabId,
      },
      manifest: snapshotManifest,
      r1Findings: report.findings,
      status: 'awaiting_fix',
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    return {
      sessionId,
      report,
      summary: report.summary,
    };
  }

  /**
   * Verifies an active repair session after external authorized file edits:
   * 1. Validates session state, TTL, and target binding (prevents replay / parallel race).
   * 2. Executes Round 2 validation with baselineFindings from Round 1.
   * 3. If Round 2 introduced regressions, automatically rolls back workspace to R0 and cleans orphan files.
   */
  async verify(input: {
    sessionId: string;
    target: BrowserTarget;
    attemptId?: string;
  }): Promise<{
    success: boolean;
    report: ThemeQaReport;
    summary: ThemeQaSummary;
    rolledBack: boolean;
    rollbackResult?: WorkspaceRollbackResult;
  }> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new CapabilityError('REPLAY_DENIED', 'Invalid, consumed, or expired repair session');
    }

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(input.sessionId);
      throw new CapabilityError('LEASE_EXPIRED', `Repair session "${input.sessionId}" has expired`);
    }

    if (session.status !== 'awaiting_fix') {
      throw new CapabilityError(
        'REPLAY_DENIED',
        `Repair session "${input.sessionId}" is in state "${session.status}" and cannot be re-verified`
      );
    }

    // Strict target binding validation
    if (
      input.target.projectId !== session.target.projectId ||
      input.target.workspaceId !== session.target.workspaceId ||
      input.target.runtimeId !== session.target.runtimeId ||
      input.target.tabId !== session.target.tabId
    ) {
      throw new CapabilityError('TARGET_MISMATCH', 'Target binding does not match repair session origin target');
    }

    session.status = 'verifying';

    try {
      // Execute Round 2 Validation with baseline findings from Round 1
      const report = await this.workflow.validate({
        runId: session.runId,
        attemptId: input.attemptId || 'attempt-r2',
        workspaceRoot: session.workspaceRoot,
        target: input.target,
        baselineFindings: session.r1Findings,
      });

      const differential = report.findings?.differential;
      const hasRegressions = differential?.hasRegressions ?? false;

      if (hasRegressions) {
        // Automatic rollback to R0
        this.sessions.delete(input.sessionId);
        try {
          const rollbackResult = await rollbackWorkspaceToManifest(session.workspaceRoot, session.manifest);
          if (!rollbackResult.success) {
            throw new CapabilityError('RUNTIME_MISMATCH', 'Theme repair rollback to R0 failed');
          }
          return {
            success: false,
            report,
            summary: report.summary,
            rolledBack: true,
            rollbackResult,
          };
        } catch (err) {
          throw new CapabilityError(
            'RUNTIME_MISMATCH',
            `Critical rollback failure: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      session.status = 'verified';
      this.sessions.delete(input.sessionId);

      return {
        success: report.summary.passed,
        report,
        summary: report.summary,
        rolledBack: false,
      };
    } catch (err) {
      this.sessions.delete(input.sessionId);
      throw err;
    }
  }

  /**
   * Explicit rollback of an active repair session
   */
  async rollback(input: {
    sessionId: string;
    target: BrowserTarget;
  }): Promise<{ success: boolean; rollbackResult: WorkspaceRollbackResult }> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new CapabilityError('REPLAY_DENIED', 'Invalid, consumed, or expired repair session');
    }

    // Strict target binding validation
    if (
      input.target.projectId !== session.target.projectId ||
      input.target.workspaceId !== session.target.workspaceId ||
      input.target.runtimeId !== session.target.runtimeId ||
      input.target.tabId !== session.target.tabId
    ) {
      throw new CapabilityError('TARGET_MISMATCH', 'Target binding does not match repair session origin target');
    }

    const rollbackResult = await rollbackWorkspaceToManifest(session.workspaceRoot, session.manifest);
    session.status = 'rolled_back';
    this.sessions.delete(input.sessionId);

    return {
      success: rollbackResult.success,
      rollbackResult,
    };
  }
}

export { createWorkspaceSnapshotManifest, rollbackWorkspaceToManifest, WorkspaceSnapshotManifest, WorkspaceRollbackResult };
