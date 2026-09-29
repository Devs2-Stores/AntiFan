import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId, issueRuntimeLease } from '../../src/shared/control-plane-contracts';

/**
 * A CLI session whose owner process dies without calling endCliSession leaves its
 * run in 'streaming' forever — and the close gate counts every non-terminal run
 * as busy evidence, so one dead agent wedges window close AND app quit. These
 * cases pin the reap: a run bound to a provably dead owner pid flips to
 * 'interrupted' (the run service's own terminal state), while a run with a live
 * or unrecorded owner keeps its state — the fail-closed direction.
 */
describe('run service gone-owner reap', () => {
  function makeRuntime() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reap-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtime = new ControlPlaneRuntime({ projectId, workspaceId, dataRoot, workspaceRoot });
    return { runtime, dataRoot, workspaceRoot, projectId, workspaceId };
  }

  function cleanup(roots: string[]) {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }

  it('interrupts a streaming run whose owner pid is dead', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      // A real dead pid: spawn a process that exits immediately, then use its pid.
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = dead.pid ?? -1;
      assert.ok(deadPid > 0, 'the fixture must mint a real pid');

      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const session = await runtime.runs.createCliSession({
        projectId,
        workspaceId,
        ownerPid: deadPid,
        lease,
        leaseToken: lease.token,
      });
      assert.equal(session.run.state, 'streaming', 'a live session starts streaming');

      const reaped = runtime.runs.reapGoneOwnerRuns();
      assert.deepEqual(reaped.interrupted, [session.run.id]);
      assert.equal(runtime.runs.getRun(session.run.id).state, 'interrupted');
      // The second sweep has nothing left to do: the run is terminal and the
      // attachment record was revoked through the same path endSession takes.
      assert.deepEqual(runtime.runs.reapGoneOwnerRuns().interrupted, []);
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('keeps a run whose owner pid is alive', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const session = await runtime.runs.createCliSession({
        projectId,
        workspaceId,
        ownerPid: process.pid,
        lease,
        leaseToken: lease.token,
      });

      const reaped = runtime.runs.reapGoneOwnerRuns();
      assert.deepEqual(reaped.interrupted, []);
      assert.equal(runtime.runs.getRun(session.run.id).state, 'streaming');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('keeps a run with no recorded owner pid — pid-less clients are fail-closed', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const session = await runtime.runs.createCliSession({
        projectId,
        workspaceId,
        lease,
        leaseToken: lease.token,
      });
      const reaped = runtime.runs.reapGoneOwnerRuns();
      assert.deepEqual(reaped.interrupted, []);
      assert.equal(runtime.runs.getRun(session.run.id).state, 'streaming');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });
  it('keeps a pid-less run while its dispatch binding is live — the transport may still end it', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const session = await runtime.runs.createCliSession({
        projectId,
        workspaceId,
        lease,
        leaseToken: lease.token,
      });
      const reaped = runtime.runs.reapGoneOwnerRuns();
      assert.deepEqual(reaped.interrupted, []);
      assert.equal(runtime.runs.getRun(session.run.id).state, 'streaming');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('interrupts a streaming run with no live dispatch binding — an owner that can never return', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
      const session = await runtime.runs.createCliSession({
        projectId,
        workspaceId,
        lease,
        leaseToken: lease.token,
      });
      // The client vanished without a clean release: its record is gone or
      // terminal, so no transport can ever drive this run to endSession again.
      await runtime.runs.attachments.revokeForAttempt(session.attempt.id);

      const reaped = runtime.runs.reapGoneOwnerRuns();
      assert.deepEqual(reaped.interrupted, [session.run.id]);
      assert.equal(runtime.runs.getRun(session.run.id).state, 'interrupted');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });
});
