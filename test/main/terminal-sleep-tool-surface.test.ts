import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import {
  registerTerminalCapabilities,
  TerminalWaitSleepingResult,
  TerminalWriteResult,
} from '../../src/main/tools/terminal-capabilities';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  RuntimeLease,
} from '../../src/shared/control-plane-contracts';
import {
  HaravanSyncBarrier,
  TerminalSyncCursor,
  TerminalSyncLifecycleProbe,
  TerminalSyncPort,
} from '../../src/main/qa/haravan-sync-barrier';

/**
 * Terminal SLEEP tolerance for (a) the terminal tool surface and (b) the Haravan
 * theme-sync barrier.
 *
 * The real `TerminalManager` runs with only the OS boundary stubbed (the PTY handle),
 * so the sleep/wake transitions, sequence counters, transcript folding and event
 * emission are the production implementations. The barrier is driven twice: against
 * the real manager, and against a stub port that can force the closed/disposed and
 * raced-lifecycle cases the real manager cannot be made to produce on demand.
 */

interface MockPtyHandle {
  pid: number | undefined;
  cols: number;
  rows: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  listenersRemoved: boolean;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void };
  kill: () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  removeAllListeners: () => void;
  emitData: (data: string) => void;
}

class StubTerminalSyncPort implements TerminalSyncPort {
  public waitCalls = 0;
  public baselineCalls = 0;
  private lifecycle: TerminalSyncLifecycleProbe | undefined;
  private satisfied = false;
  private advanceSeq = 9;
  private sleepDuringWait = false;

  constructor(public mode: 'running' | 'closed' | 'disposed' | 'sleeping' | 'sleeping-disposed') {
    if (mode === 'running') this.lifecycle = { state: 'running', disposed: false, lastSeq: 7, sessionGeneration: 3 };
    if (mode === 'closed') this.lifecycle = { state: 'closed', disposed: true, lastSeq: 7, sessionGeneration: 3 };
    if (mode === 'disposed') this.lifecycle = { state: 'running', disposed: true, lastSeq: 7, sessionGeneration: 3 };
    if (mode === 'sleeping') this.lifecycle = { state: 'sleeping', disposed: false, lastSeq: 7, sessionGeneration: 3 };
    // A disposed record whose stale state string still says "sleeping" must NOT be
    // treated as an attestable nap.
    if (mode === 'sleeping-disposed') this.lifecycle = { state: 'sleeping', disposed: true, lastSeq: 7, sessionGeneration: 3 };
  }

  public setSatisfied(satisfied: boolean, advanceSeq = 9): void {
    this.satisfied = satisfied;
    this.advanceSeq = advanceSeq;
  }

  public setSleepDuringWait(sleep: boolean): void {
    this.sleepDuringWait = sleep;
  }

  public captureBaselineSeq(sessionId: string): TerminalSyncCursor {
    this.baselineCalls++;
    if (this.mode === 'closed' || this.mode === 'disposed' || this.mode === 'sleeping-disposed') {
      throw new CapabilityError(
        'SESSION_CLOSED',
        `Terminal session "${sessionId}" is not running (state: ${this.mode === 'disposed' ? 'closed/disposed' : this.mode})`
      );
    }
    return { sessionId, sessionGeneration: 3, baselineSeq: 7 };
  }

  public async waitTerminal(): Promise<{
    satisfied: boolean;
    lastSeq: number;
    outputTail?: string;
    sessionGeneration?: number;
  }> {
    this.waitCalls++;
    if (this.sleepDuringWait) this.lifecycle = { state: 'sleeping', disposed: false, lastSeq: 7, sessionGeneration: 3 };
    return this.satisfied
      ? { satisfied: true, lastSeq: this.advanceSeq, sessionGeneration: 3, outputTail: 'Uploaded: x.liquid' }
      : { satisfied: false, lastSeq: 7, sessionGeneration: 3 };
  }

  public getSession(): TerminalSyncLifecycleProbe | undefined {
    return this.lifecycle;
  }
}

describe('Terminal sleep: tool surface + Haravan sync barrier tolerance', () => {
  let manager: TerminalManager;
  let catalogue: CapabilityCatalogue;
  let lease: RuntimeLease;
  let projectId: string;
  let workspaceId: string;
  let configDir: string;
  let originalSpawn: unknown;
  const spawnIds: string[] = [];
  const ptyBySession = new Map<string, MockPtyHandle>();

  function countSpawns(sessionId: string): number {
    return spawnIds.filter((id) => id === sessionId).length;
  }

  function settle(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Bounded poll for an asynchronous, eventually-true condition. The sleep teardown
   * is deliberately asynchronous (`void teardownSessionPty`), so assertions about the
   * released process tree must not depend on a single phase of the event loop.
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await settle();
    }
    return predicate();
  }

  function ptyOf(sessionId: string): MockPtyHandle {
    const handle = ptyBySession.get(sessionId);
    assert.ok(handle, `mock PTY for ${sessionId} must exist`);
    return handle;
  }

  function installMockSpawn(): void {
    const mutable = manager as unknown as {
      spawn: (...args: any[]) => any;
      createSessionRecord: (...args: any[]) => Record<string, unknown>;
      sessions: Map<string, Record<string, unknown>>;
      sessionGenerations: Map<string, number>;
      lastCols?: number;
      lastRows?: number;
      currentCwd?: string;
      currentCapsuleId?: string;
      appendData: (session: unknown, data: string) => void;
    };

    mutable.spawn = (
      id: string,
      cwd: string,
      restoredBuffer = '',
      initialCols?: number,
      initialRows?: number,
      minimumRows = 8,
      parentSessionId?: string,
      parentGeneration?: number,
      reservedGeneration?: number
    ) => {
      const cols = Math.max(40, initialCols || mutable.lastCols || 120);
      const rows = Math.max(minimumRows, initialRows || mutable.lastRows || 30);
      const generation =
        reservedGeneration !== undefined
          ? reservedGeneration
          : (mutable.sessionGenerations.get(id) || 0) + 1;
      mutable.sessionGenerations.set(id, generation);

      const record = mutable.createSessionRecord(
        id,
        cwd || mutable.currentCwd || process.cwd(),
        restoredBuffer,
        cols,
        rows,
        minimumRows,
        parentSessionId,
        generation,
        parentGeneration
      ) as Record<string, unknown> & { pty: unknown; buffer: string; disposed: boolean };

      const writes: string[] = [];
      const resizes: Array<{ cols: number; rows: number }> = [];
      const handle: MockPtyHandle = {
        pid: undefined,
        cols,
        rows,
        writes,
        resizes,
        killed: false,
        listenersRemoved: false,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        kill: () => {
          handle.killed = true;
        },
        // The real appendData keeps sequence/transcript semantics identical to a live
        // shell, so waits, cursors and transcript assertions exercise production code.
        write: (data: string) => {
          writes.push(data);
          mutable.appendData(record, data);
        },
        resize: (nextCols: number, nextRows: number) => {
          handle.cols = nextCols;
          handle.rows = nextRows;
          resizes.push({ cols: nextCols, rows: nextRows });
        },
        removeAllListeners: () => {
          handle.listenersRemoved = true;
        },
        emitData: (data: string) => {
          mutable.appendData(record, data);
        },
      };

      record.pty = handle;
      record.dataSubscription = { dispose: () => {} };
      record.exitSubscription = { dispose: () => {} };
      mutable.sessions.set(id, record);
      ptyBySession.set(id, handle);
      spawnIds.push(id);
      return record;
    };
  }

  before(() => {
    // Isolate the manager from the developer's real saved-session file: restore must
    // not spawn anything this test did not create.
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sleep-cfg-'));
    process.env.ANTIFAN_CONFIG_DIR = configDir;

    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

    manager = TerminalManager.getInstance();
    originalSpawn = (manager as unknown as { spawn: unknown }).spawn;
    installMockSpawn();

    catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerTerminalCapabilities(catalogue, manager);
  });

  after(async () => {
    try {
      await manager.dispose();
    } catch {}
    (manager as unknown as { spawn: unknown }).spawn = originalSpawn;
    (TerminalManager as unknown as { instance?: TerminalManager }).instance = undefined;
    delete process.env.ANTIFAN_CONFIG_DIR;
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  function readContext() {
    return { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' as const };
  }

  function writeContext() {
    return { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const };
  }

  it('1. terminal.wait on a sleeping session answers with the typed sleeping result, promptly, and never spawns', async () => {
    const id = manager.createSession(process.cwd());
    ptyOf(id).emitData('[14:20:00] Uploaded: snippets/old.liquid\n');
    assert.strictEqual(manager.captureBaselineSeq(id).baselineSeq, 1);

    assert.strictEqual(manager.sleepSession(id), true);
    assert.strictEqual(manager.getSession(id)?.state, 'sleeping');
    assert.strictEqual(manager.getSession(id)?.pty, null, 'sleeping must release the PTY handle synchronously');
    // The process-tree teardown is asynchronous by design (`void teardownSessionPty`).
    assert.ok(await waitFor(() => ptyOf(id).killed), 'sleeping must tear the shell down');

    const spawnsBefore = countSpawns(id);
    const started = Date.now();
    const result = (await catalogue.dispatch(
      'terminal.wait',
      { sessionId: id, condition: 'output-match', pattern: 'Uploaded', timeoutMs: 30_000 },
      readContext()
    )) as TerminalWaitSleepingResult;
    const elapsed = Date.now() - started;

    assert.strictEqual(result.satisfied, false, 'nothing can be satisfied while the session sleeps');
    assert.strictEqual(result.sleeping, true);
    assert.strictEqual(result.code, 'SESSION_SLEEPING');
    assert.strictEqual(result.reason, 'SESSION_SLEEPING');
    assert.strictEqual(result.sessionId, id);
    assert.strictEqual(result.wakeCapability, 'terminal.write');
    assert.ok(result.wakeHint.includes('terminal.write'), 'the sleeping result must name the wake capability');
    assert.ok(result.message.includes('sleeping'), 'the sleeping result must explain itself');
    assert.strictEqual(result.lastSeq, 1, 'the monotonic cursor is reported, not reset by the nap');
    assert.ok(elapsed < 500, `a sleeping wait must return immediately, took ${elapsed}ms of a 30000ms budget`);
    assert.strictEqual(countSpawns(id), spawnsBefore, 'terminal.wait must not spawn a PTY for a sleeping session');
    assert.strictEqual(manager.getSession(id)?.state, 'sleeping', 'terminal.wait must not wake the session');
  });

  it('2. terminal.write is the wake path: it wakes the sleeping session and delivers the input in one spawn', async () => {
    const id = manager.createSession(process.cwd());
    ptyOf(id).emitData('MARKER-before-sleep\r\n');
    assert.strictEqual(manager.sleepSession(id), true);
    assert.strictEqual(manager.getSession(id)?.state, 'sleeping');

    const spawnsBefore = countSpawns(id);
    const result = (await catalogue.dispatch(
      'terminal.write',
      { sessionId: id, input: 'echo AWAKE\r\n' },
      writeContext()
    )) as TerminalWriteResult;

    assert.strictEqual(result.written, true, 'a wake-then-write is a success, not an error');
    assert.strictEqual(result.woke, true, 'the tool must report that this write performed the wake');
    assert.strictEqual(result.priorState, 'sleeping');
    assert.strictEqual(result.state, 'running');
    assert.strictEqual(result.message, undefined, 'a successful wake must not be reported as a failure');
    assert.strictEqual(manager.getSession(id)?.state, 'running');
    assert.ok(manager.getSession(id)?.pty, 'the session must hold a live shell after the wake');
    assert.strictEqual(
      countSpawns(id) - spawnsBefore,
      1,
      'exactly one wake spawn: the tool must not issue a second, racing wake'
    );
    assert.ok(
      ptyOf(id).writes.includes('echo AWAKE\r\n'),
      'the input written to a sleeping session must reach the woken shell'
    );
    assert.ok(
      manager.getFullBuffer(id).buffer.includes('MARKER-before-sleep'),
      'the pre-sleep transcript must survive the nap'
    );

    // And the same session is a normal, waitable session again.
    const waitResult = (await catalogue.dispatch(
      'terminal.wait',
      { sessionId: id, condition: 'output-match', pattern: 'AWAKE_MARKER_ABSENT', timeoutMs: 120 },
      readContext()
    ).catch((err: unknown) => err)) as CapabilityError;
    assert.ok(waitResult instanceof CapabilityError);
    assert.strictEqual(waitResult.code, 'WAIT_TIMEOUT', 'a running session keeps the historical wait semantics');
  });

  it('3. terminal.write reports an un-woken sleeping session honestly instead of claiming delivery', async () => {
    const id = manager.createSession(process.cwd());
    assert.strictEqual(manager.sleepSession(id), true);

    const mutable = manager as unknown as { spawn: (...args: any[]) => any };
    const workingSpawn = mutable.spawn;
    mutable.spawn = () => {
      throw new Error('simulated spawn failure');
    };
    try {
      const result = (await catalogue.dispatch(
        'terminal.write',
        { sessionId: id, input: 'echo NEVER\r\n' },
        writeContext()
      )) as TerminalWriteResult;

      assert.strictEqual(result.woke, false);
      assert.strictEqual(result.written, false, 'input dropped by a failed wake must not be reported as written');
      assert.strictEqual(result.state, 'sleeping');
      assert.ok(result.message && result.message.includes('did not wake'));
    } finally {
      mutable.spawn = workingSpawn;
    }
  });

  it('4. terminal.wait keeps its exact pre-sleep shape for a live session', async () => {
    const id = manager.createSession(process.cwd());
    ptyOf(id).emitData('READY_MARKER\r\n');

    const result = (await catalogue.dispatch(
      'terminal.wait',
      { sessionId: id, condition: 'output-match', pattern: 'READY_MARKER', timeoutMs: 2000 },
      readContext()
    )) as Record<string, unknown>;

    assert.strictEqual(result.satisfied, true);
    assert.ok(!('sleeping' in result), 'a live session must not carry the sleeping marker');
    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['lastSeq', 'outputTail', 'satisfied', 'sessionGeneration'],
      'the non-sleeping wait result shape must be unchanged'
    );
  });

  it('5. HaravanSyncBarrier: a sleeping watcher yields a typed unsettled outcome without waking or spawning it', async () => {
    const id = manager.createSession(process.cwd());
    ptyOf(id).emitData('[14:20:00] Uploaded: snippets/old.liquid\n');

    const barrier = new HaravanSyncBarrier(manager);
    const cursorWhileRunning = barrier.captureBaselineCursor(id);
    assert.strictEqual(cursorWhileRunning.baselineSeq, 1);

    assert.strictEqual(manager.sleepSession(id), true);
    // A nap must not invalidate the cursor: sequence numbers stay monotonic.
    const cursor = barrier.captureBaselineCursor(id);
    assert.strictEqual(cursor.baselineSeq, 1, 'sleep must not reset the baseline sequence');
    assert.strictEqual(cursor.sessionGeneration, cursorWhileRunning.sessionGeneration);

    const spawnsBefore = countSpawns(id);
    const started = Date.now();
    const outcome = await barrier.awaitSync(7, { cursor, timeoutMs: 30_000 });
    const elapsed = Date.now() - started;

    assert.strictEqual(outcome.settled, false, 'a sleeping watcher must never be reported as settled');
    assert.strictEqual(outcome.unsettledReason, 'WATCHER_SLEEPING');
    assert.strictEqual(outcome.settledMethod, 'none');
    assert.strictEqual(outcome.syncGen, 7);
    assert.strictEqual(outcome.sessionId, id);
    assert.strictEqual(outcome.lastSeq, 1, 'the observed monotonic sequence is echoed, not invented');
    assert.strictEqual(outcome.baselineSeq, 1);
    assert.ok(outcome.wakeHint && outcome.wakeHint.includes('terminal.write'));
    assert.ok(elapsed < 500, `a sleeping watcher must not burn the wait budget, took ${elapsed}ms`);
    assert.strictEqual(countSpawns(id), spawnsBefore, 'the barrier must not spawn a shell for a sleeping watcher');
    assert.strictEqual(manager.getSession(id)?.state, 'sleeping', 'the barrier must not wake the watcher');
  });

  it('6. HaravanSyncBarrier: closed and disposed watchers still fail loudly with SESSION_CLOSED', async () => {
    for (const mode of ['closed', 'disposed', 'sleeping-disposed'] as const) {
      const port = new StubTerminalSyncPort(mode);
      const barrier = new HaravanSyncBarrier(port);
      await assert.rejects(
        async () => barrier.captureBaselineCursor('watcher-1'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'SESSION_CLOSED',
        `${mode} must keep failing loudly on baseline capture`
      );
    }

    // A disposed record whose stale state string says "sleeping" must NOT be treated
    // as an attestable nap: the wait still runs and the miss still fails loudly.
    const disposedPort = new StubTerminalSyncPort('sleeping-disposed');
    disposedPort.setSleepDuringWait(false);
    const disposedBarrier = new HaravanSyncBarrier(disposedPort);
    await assert.rejects(
      async () => disposedBarrier.awaitSync(1, { cursor: { sessionId: 'w', sessionGeneration: 3, baselineSeq: 7 }, timeoutMs: 50 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );
    assert.strictEqual(disposedPort.waitCalls, 1, 'a disposed watcher is not a nap: the wait still runs');
  });

  it('7. HaravanSyncBarrier: a genuine miss still fails closed, and a genuine ack still settles', async () => {
    const missPort = new StubTerminalSyncPort('running');
    missPort.setSatisfied(false);
    const missBarrier = new HaravanSyncBarrier(missPort);
    await assert.rejects(
      async () => missBarrier.awaitSync(3, { cursor: { sessionId: 'w', sessionGeneration: 3, baselineSeq: 7 }, timeoutMs: 50 }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );
    assert.strictEqual(missPort.waitCalls, 1);

    const ackPort = new StubTerminalSyncPort('running');
    ackPort.setSatisfied(true, 9);
    const ackBarrier = new HaravanSyncBarrier(ackPort);
    const settled = await ackBarrier.awaitSync(3, {
      cursor: { sessionId: 'w', sessionGeneration: 3, baselineSeq: 7 },
      timeoutMs: 50,
    });
    assert.strictEqual(settled.settled, true);
    assert.strictEqual(settled.settledMethod, 'terminal-output');
    assert.strictEqual(settled.lastSeq, 9);
    assert.strictEqual(settled.unsettledReason, undefined);
  });

  it('8. HaravanSyncBarrier: a watcher that falls asleep during the wait is reported as sleeping, not as a timeout', async () => {
    const port = new StubTerminalSyncPort('running');
    port.setSatisfied(false);
    port.setSleepDuringWait(true);
    const barrier = new HaravanSyncBarrier(port);

    const outcome = await barrier.awaitSync(5, {
      cursor: { sessionId: 'w', sessionGeneration: 3, baselineSeq: 7 },
      timeoutMs: 50,
    });

    assert.strictEqual(port.waitCalls, 1, 'the wait that was already in flight is not repeated');
    assert.strictEqual(outcome.settled, false);
    assert.strictEqual(outcome.unsettledReason, 'WATCHER_SLEEPING');
    assert.strictEqual(outcome.settledMethod, 'none');
  });

  it('9. HaravanSyncBarrier: a sleeping watcher is never waited on at all', async () => {
    const port = new StubTerminalSyncPort('sleeping');
    const barrier = new HaravanSyncBarrier(port);

    const outcome = await barrier.awaitSync(2, {
      cursor: { sessionId: 'w', sessionGeneration: 3, baselineSeq: 7 },
      timeoutMs: 30_000,
    });

    assert.strictEqual(port.waitCalls, 0, 'no wait may be issued for a session with no live PTY');
    assert.strictEqual(outcome.unsettledReason, 'WATCHER_SLEEPING');
    assert.strictEqual(outcome.baselineSeq, 7);
  });
});
