import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: an import that throws
// registers no case, and a file with no registered case still reports as one passing test.
installElectronStub();

import { enumerateCloseLiveUseRuns } from '../../src/main/index';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
import {
  collectCloseLiveUse,
  ORPHANED_RUN_STATE,
  type CloseAdmissionTable,
  type CloseLiveUsePort,
} from '../../src/main/browser/close-live-use';
import type { LiveUseRequest } from '../../src/main/browser/project-close-coordinator';

const APPLICATION: LiveUseRequest = {
  scope: 'application',
  ownerKey: null,
  pageIds: [],
  auxiliaryKeys: [],
};

function idlePort(overrides: Partial<CloseLiveUsePort> = {}): CloseLiveUsePort {
  const admission: CloseAdmissionTable = {
    snapshot: () => ({ inFlightOperations: 0, reservedTabIds: [], applicationReserved: false }),
    inFlightOperationsOnPage: () => 0,
    inFlightOperationsOnOwner: () => 0,
  };
  return {
    admission: () => admission,
    operationCounters: () => ({}),
    ledgerInFlight: () => 0,
    runs: () => [],
    attachments: () => [],
    affinities: () => [],
    terminalState: () => ({ available: true, sessions: [] }),
    ...overrides,
  };
}

describe('close live-use runs enumeration — orphaned and unlisted runs', () => {
  it('returns empty array when control plane has no runs', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });

      const runs = enumerateCloseLiveUseRuns(runtime);
      assert.deepEqual(runs, []);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('enumerates runs for registered projects with their actual state', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });

      runtime.projects.registerProject({
        id: projectId,
        name: 'Project 1',
        dataRoot,
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

      const chat = runtime.chats.create(projectId, workspaceId, 'Chat');
      const run = runtime.runs.createRun(projectId, workspaceId, chat.id, 'cli');

      const runs = enumerateCloseLiveUseRuns(runtime);
      assert.equal(runs.length, 1);
      const [firstRun] = runs;
      assert.ok(firstRun, 'expected at least one run');
      assert.equal(firstRun.runId, run.id);
      assert.equal(firstRun.state, 'queued');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discovers an orphaned run from active attachments whose project was removed and reports it outside the run vocabulary', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });

      // Do NOT register projectId in runtime.projects (simulating a removed or unregistered project)
      // Issue an attachment directly for this orphaned project/run
      const orphanedRunId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);

      await runtime.runs.attachments.issueAttachment(orphanedRunId, attemptId, projectId, workspaceId, {
        backendId: 'test-backend',
        lease,
        leaseToken: lease.token,
      });

      // enumerateCloseLiveUseRuns must find this run through attachments and report it as a state
      // the close gate cannot interpret, so an orphaned run is never folded into the run service's
      // own terminal 'unknown'.
      const runs = enumerateCloseLiveUseRuns(runtime);
      assert.equal(runs.length, 1);
      const [firstRun] = runs;
      assert.ok(firstRun, 'expected at least one run');
      assert.equal(firstRun.runId, orphanedRunId);
      assert.equal(firstRun.state, ORPHANED_RUN_STATE, 'an orphaned run must report a state outside the run vocabulary, not idle or omitted');

      // Feeding into collectCloseLiveUse must refuse with state 'unknown'
      const port = idlePort({
        runs: () => runs,
      });
      const report = collectCloseLiveUse(APPLICATION, port);
      assert.equal(report.state, 'unknown', 'live-use report must be unknown for an orphaned run');
      assert.ok(report.reasons, 'reasons must be present');
      assert.ok(
        report.reasons.some((r) => r.category === 'evidence-unavailable' && r.detail.includes(orphanedRunId)),
        'reasons must cite the orphaned run as evidence-unavailable'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discovers an orphaned run from the run service when its project is not registered and reports it as unknown', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const orphanedProjectId = makeControlPlaneId('project');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });

      // Register the primary project and workspace
      runtime.projects.registerProject({
        id: projectId,
        name: 'Registered Project',
        dataRoot,
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

      // Create a run for orphanedProjectId, which is absent from runtime.projects.listProjects()
      const chat = runtime.chats.create(orphanedProjectId, workspaceId, 'Orphaned Chat');
      const orphanedRun = runtime.runs.createRun(orphanedProjectId, workspaceId, chat.id, 'cli');

      // Verify that orphanedProjectId is indeed absent from listProjects()
      const projectIds = runtime.projects.listProjects().map((p) => p.id);
      assert.ok(!projectIds.includes(orphanedProjectId), 'orphanedProjectId must not be in listProjects()');

      // enumerateCloseLiveUseRuns must detect the orphaned run from the run store and report it
      // outside the run vocabulary, which the close gate refuses on
      const runs = enumerateCloseLiveUseRuns(runtime);
      assert.equal(runs.length, 1);
      const [firstRun] = runs;
      assert.ok(firstRun, 'expected at least one run');
      assert.equal(firstRun.runId, orphanedRun.id);
      assert.equal(firstRun.state, ORPHANED_RUN_STATE, 'orphaned run whose project is absent must report a state outside the run vocabulary');

      // Feeding into collectCloseLiveUse must report unknown rather than idle
      const port = idlePort({
        runs: () => runs,
      });
      const report = collectCloseLiveUse(APPLICATION, port);
      assert.equal(report.state, 'unknown', 'live-use report must be unknown when an orphaned run exists');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not stand in for a run once its binding is revoked', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({ projectId, workspaceId, dataRoot, workspaceRoot });
      const runId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const issued = await runtime.runs.attachments.issueAttachment(runId, attemptId, projectId, workspaceId, {
        backendId: 'test-backend',
        lease,
        leaseToken: lease.token,
      });

      // The retained id set keeps a revoked record for audit, so the enumeration has to ask the
      // record itself whether the binding can still dispatch. A dead binding that keeps refusing
      // quits is the bug this pins: nothing can be running behind an authority that is gone.
      assert.equal(enumerateCloseLiveUseRuns(runtime).length, 1, 'a live binding must be enumerated');
      await runtime.runs.attachments.revokeAttachment(issued.launch.attachmentId);
      assert.deepEqual(enumerateCloseLiveUseRuns(runtime), [], 'a revoked binding must not stand in for its run');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not treat an active mcp transport attachment as an orphaned project run', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-runs-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({ projectId, workspaceId, dataRoot, workspaceRoot });
      const mcpRunId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);

      await runtime.runs.attachments.issueAttachment(mcpRunId, attemptId, projectId, workspaceId, {
        backendId: 'mcp',
        lease,
        leaseToken: lease.token,
      });

      // An MCP transport attachment mints a synthetic runId for capability dispatch authority
      // and does not run project workflows in RunService. It must not be reported as an orphaned run.
      const runs = enumerateCloseLiveUseRuns(runtime);
      assert.deepEqual(runs, [], 'mcp transport attachment must not be enumerated as an orphaned run');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
