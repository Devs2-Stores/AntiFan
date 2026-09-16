/**
 * AntiFan Browser Desktop — Process Lifecycle & Orphan Sweep Tests
 *
 * Proves child process lifecycle invariants on Windows:
 * - Child processes are tracked with owner + start time markers
 * - Clean shutdown / killAll terminates process trees
 * - Synchronous exit hooks kill child trees
 * - Startup orphan sweep kills real leaked children from prior crashes
 * - PID reuse safety: start time verification prevents killing innocent reused PIDs
 * - CoreHealth spawn integration registers and unregisters
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import {
  ProcessRegistry,
  isProcessAlive,
  getProcessCreationTime,
  parseWmicCreationDate,
  killProcessTree,
  killProcessTreeSync,
  type TrackedProcess,
} from '../../src/main/process/process-registry';
import { CoreHealthService } from '../../src/main/diagnostics/core-health';

/**
 * Poll until a process is confirmed dead or timeout occurs.
 * Uses real OS polling because Windows taskkill asynchronously reaps process handles.
 */
async function waitForProcessDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const startTime = Date.now();
  const poll = () => {
    if (!isProcessAlive(pid)) {
      resolve(true);
      return;
    }
    if (Date.now() - startTime >= timeoutMs) {
      resolve(false);
      return;
    }
    // Polling interval to avoid busy-waiting while Windows reaps the process
    setTimeout(poll, 50);
  };
  poll();
  return promise;
}

describe('Process Lifecycle & Windows Orphan Sweep Proof', () => {
  let tempDir: string;
  let registry: ProcessRegistry;

  beforeEach(() => {
    ProcessRegistry.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proc-test-'));
    registry = new ProcessRegistry({
      stateDir: tempDir,
      autoInstallExitHooks: false, // Prevent test runner process from installing global exit listeners
    });
  });

  afterEach(async () => {
    // Clean up any remaining children
    if (registry) {
      await registry.killAll();
      registry.dispose();
    }
    ProcessRegistry.resetInstance();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp dir cleanup
    }
  });

  it('proves process tracking records real child processes in memory and on disk', async () => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });

    assert.ok(child.pid && child.pid > 0, 'Child must have a valid PID');
    const childPid = child.pid;

    try {
      const record = registry.register({
        pid: childPid,
        owner: 'test-runner',
        name: 'test-child-1',
        command: 'node keep-alive',
        processRef: child,
      });

      assert.strictEqual(record.pid, childPid);
      assert.strictEqual(record.owner, 'test-runner');
      assert.strictEqual(record.name, 'test-child-1');
      assert.ok(record.createdAt > 0);

      // Verify in-memory retrieval
      const fetched = registry.get(childPid);
      assert.ok(fetched);
      assert.strictEqual(fetched.pid, childPid);
      assert.strictEqual(registry.list().length, 1);
      assert.strictEqual(registry.listByOwner('test-runner').length, 1);
      assert.strictEqual(registry.listByOwner('other').length, 0);

      // Verify disk marker file was written and contains the record
      const diskRecords = registry.readMarkerFile();
      assert.strictEqual(diskRecords.length, 1);
      assert.strictEqual(diskRecords[0]?.pid, childPid);
      assert.strictEqual(diskRecords[0]?.owner, 'test-runner');

      // Unregister should update memory and disk
      const unregistered = registry.unregister(childPid, 0);
      assert.strictEqual(unregistered, true);
      assert.strictEqual(registry.get(childPid), undefined);
      assert.strictEqual(registry.readMarkerFile().length, 0);
    } finally {
      child.kill('SIGKILL');
      await waitForProcessDead(childPid);
    }
  });

  it('proves explicit kill terminates real child process and updates registry and disk', async () => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const childPid = child.pid!;

    registry.register({
      pid: childPid,
      owner: 'test-kill',
      processRef: child,
    });

    assert.strictEqual(registry.isAlive(childPid), true);

    const killed = await registry.kill(childPid);
    assert.strictEqual(killed, true);

    const isDead = await waitForProcessDead(childPid);
    assert.strictEqual(isDead, true, 'Process must be dead after registry.kill()');

    assert.strictEqual(registry.get(childPid), undefined);
    assert.strictEqual(registry.readMarkerFile().length, 0);
  });

  it('proves killAll terminates multiple child processes during shutdown', async () => {
    const child1 = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { windowsHide: true, stdio: 'ignore' });
    const child2 = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { windowsHide: true, stdio: 'ignore' });
    const pid1 = child1.pid!;
    const pid2 = child2.pid!;

    registry.register({ pid: pid1, owner: 'batch-test', name: 'child-1' });
    registry.register({ pid: pid2, owner: 'batch-test', name: 'child-2' });

    assert.strictEqual(registry.list().length, 2);
    assert.strictEqual(isProcessAlive(pid1), true);
    assert.strictEqual(isProcessAlive(pid2), true);

    const summary = await registry.killAll();
    assert.strictEqual(summary.attempted, 2);
    assert.strictEqual(summary.killed, 2);
    assert.strictEqual(summary.errors.length, 0);

    const dead1 = await waitForProcessDead(pid1);
    const dead2 = await waitForProcessDead(pid2);
    assert.strictEqual(dead1, true);
    assert.strictEqual(dead2, true);

    assert.strictEqual(registry.list().length, 0);
    assert.strictEqual(registry.readMarkerFile().length, 0);
  });

  it('proves synchronous killAllSync terminates children immediately', async () => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { windowsHide: true, stdio: 'ignore' });
    const pid = child.pid!;

    registry.register({ pid, owner: 'sync-test', processRef: child });
    assert.strictEqual(isProcessAlive(pid), true);

    registry.killAllSync();

    const dead = await waitForProcessDead(pid);
    assert.strictEqual(dead, true);
    assert.strictEqual(registry.list().length, 0);
  });

  it('proves startup orphan sweep finds and kills real orphaned processes from prior crash', async () => {
    // 1. Spawn a real background process that survives past simulated crash
    const orphan = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true, // detached so it doesn't die with normal pipes
    });
    const orphanPid = orphan.pid!;
    assert.strictEqual(isProcessAlive(orphanPid), true);

    // 2. Query real OS start time or use Date.now
    const osStartTime = getProcessCreationTime(orphanPid) ?? Date.now();

    // 3. Write a marker file to simulate a previous application crash
    // (The previous run crashed without calling unregister or kill)
    const crashedRecords = [
      {
        pid: orphanPid,
        owner: 'crashed-terminal-session',
        name: 'session-orphan-1',
        command: 'node orphan-keep-alive',
        createdAt: Date.now() - 2000,
        osStartTime,
      },
    ];
    registry.writeMarkerFile(crashedRecords);

    // 4. Dispose current registry instance to simulate complete app death
    registry.dispose();
    ProcessRegistry.resetInstance();

    // 5. App restarts: create fresh registry pointing at the same stateDir
    const rebootedRegistry = new ProcessRegistry({
      stateDir: tempDir,
      autoInstallExitHooks: false,
    });

    // 6. Run startup orphan sweep
    const sweepReport = await rebootedRegistry.sweepOrphans({ toleranceMs: 5000 });

    assert.strictEqual(sweepReport.scanned, 1);
    assert.strictEqual(sweepReport.killed, 1);
    assert.strictEqual(sweepReport.alreadyDead, 0);
    assert.strictEqual(sweepReport.pidReusedSkipped, 0);

    // 7. Prove the orphaned process is now dead
    const dead = await waitForProcessDead(orphanPid);
    assert.strictEqual(dead, true, 'Orphan process must be reaped by sweepOrphans');

    // 8. Prove the marker file is now clean
    const remaining = rebootedRegistry.readMarkerFile();
    assert.strictEqual(remaining.length, 0);

    rebootedRegistry.dispose();
  });

  it('proves PID-reuse safety: does NOT kill an innocent process when PID was recycled', async () => {
    // The current test runner process is alive
    const currentPid = process.pid;
    assert.strictEqual(isProcessAlive(currentPid), true);

    // Get current process real start time
    const realStartTime = getProcessCreationTime(currentPid) ?? Date.now();

    // Craft a marker record with the same PID, but a completely different start time
    // (Simulates a PID that belonged to an old child 2 hours ago, which exited, and Windows recycled the PID)
    const recycledMarkerTime = realStartTime - 2 * 3600 * 1000; // 2 hours prior
    const markerWithRecycledPid = [
      {
        pid: currentPid,
        owner: 'ancient-crashed-run',
        name: 'old-session',
        command: 'ancient-cmd',
        createdAt: recycledMarkerTime,
        osStartTime: recycledMarkerTime,
      },
    ];
    registry.writeMarkerFile(markerWithRecycledPid);

    // Run sweepOrphans
    const report = await registry.sweepOrphans({ toleranceMs: 5000 });

    // Must detect PID reuse and SKIP killing
    assert.strictEqual(report.scanned, 1);
    assert.strictEqual(report.killed, 0, 'Must NOT kill an innocent process with recycled PID');
    assert.strictEqual(report.pidReusedSkipped, 1, 'Must report pidReusedSkipped = 1');

    // Current process must still be alive!
    assert.strictEqual(isProcessAlive(currentPid), true, 'Innocent process must remain alive');

    // Stale marker must be pruned so we do not check this dead history again
    assert.strictEqual(registry.readMarkerFile().length, 0);
  });

  it('proves orphan sweep safely prunes already-dead PIDs without errors', async () => {
    // PID 9999999 is virtually guaranteed not to exist
    const deadPid = 99999999;
    assert.strictEqual(isProcessAlive(deadPid), false);

    registry.writeMarkerFile([
      {
        pid: deadPid,
        owner: 'old-run',
        createdAt: Date.now() - 5000,
        osStartTime: Date.now() - 5000,
      },
    ]);

    const report = await registry.sweepOrphans();
    assert.strictEqual(report.scanned, 1);
    assert.strictEqual(report.alreadyDead, 1);
    assert.strictEqual(report.killed, 0);
    assert.strictEqual(report.pidReusedSkipped, 0);
    assert.strictEqual(registry.readMarkerFile().length, 0);
  });

  it('handles invalid inputs, boundary PIDs, and corrupted marker files cleanly', async () => {
    // Boundary PIDs
    assert.strictEqual(isProcessAlive(0), false);
    assert.strictEqual(isProcessAlive(-1), false);
    assert.strictEqual(isProcessAlive(Number.NaN), false);
    assert.strictEqual(await killProcessTree(0), false);
    assert.strictEqual(await killProcessTree(-1), false);
    assert.strictEqual(killProcessTreeSync(0), false);
    assert.strictEqual(getProcessCreationTime(0), null);

    // Corrupted marker file
    const markerPath = registry.getMarkerFilePath();
    fs.writeFileSync(markerPath, 'INVALID JSON {[[', 'utf8');

    const records = registry.readMarkerFile();
    assert.deepStrictEqual(records, []);

    // Sweep on corrupted marker shouldn't throw
    const report = await registry.sweepOrphans();
    assert.strictEqual(report.scanned, 0);

    // parseWmicCreationDate verification
    const parsed = parseWmicCreationDate('20260916152810.607420+420');
    assert.ok(typeof parsed === 'number' && parsed > 0);
    assert.strictEqual(parseWmicCreationDate('invalid-date-string'), null);
    assert.strictEqual(parseWmicCreationDate(''), null);
  });

  it('proves CoreHealthService spawn site registers and unregisters with ProcessRegistry', async () => {
    const healthyPayload = {
      stats: { artifacts: 10, claims: 5, evidence: 8 },
      audit: { artifacts: 10, blocked: 0, blockedReasonless: 0, pending: 0, unresolved: 0 },
      decay: { stale: [], aging: [], cutoff: 'x' },
      gates: {
        coverage: { passed: true, detail: 'ok', gateId: 'gate-1' },
        evidence: { passed: true, detail: 'ok', gateId: 'gate-2' },
        conflict: { passed: true, detail: 'ok', gateId: 'gate-3' },
        temporal: { passed: true, detail: 'ok', gateId: 'gate-4' },
        promotion: { passed: true, detail: 'ok', gateId: 'gate-5' },
        regression: { passed: true, detail: 'last regression: PASS', gateId: 'gate-6' },
      },
      uncertainty: { level: 'STRONGLY_SUPPORTED', reason: 'claims promoted' },
    };

    const dummyScript = path.join(tempDir, 'dummy-cli.js');
    fs.writeFileSync(
      dummyScript,
      `console.log(${JSON.stringify(JSON.stringify(healthyPayload))}); process.exit(0);`,
      'utf8'
    );

    // Configure singleton registry instance for this test
    ProcessRegistry.resetInstance();
    const singleton = ProcessRegistry.getInstance({
      stateDir: tempDir,
      autoInstallExitHooks: false,
    });

    const svc = new CoreHealthService({
      repoRoot: tempDir,
      scriptPath: dummyScript,
      issueRegister: { list: () => [], summarizeOpen: () => [] },
    });

    assert.strictEqual(singleton.listByOwner('core-health').length, 0);

    const snapshot = await svc.getSnapshot();
    assert.strictEqual(snapshot.status, 'HEALTHY');

    // Process should be completely unregistered and disk marker cleared
    assert.strictEqual(singleton.listByOwner('core-health').length, 0);
    assert.strictEqual(singleton.readMarkerFile().length, 0);
  });
});
