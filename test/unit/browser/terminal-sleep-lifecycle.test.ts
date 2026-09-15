/**
 * Phase 5: Sleep / Archive terminal tab lifecycle.
 *
 * These cases drive the real `TerminalManager` (real Session records, real
 * persist paths, real event emitter) against a stubbed `node-pty` boundary and a
 * scratch state file. Only PTY process creation and the OS process-tree kill are
 * faked — both are genuine OS boundaries. Everything asserted below (state
 * transitions, transcript folding, persisted JSON, emitted events) is produced by
 * the shipped code, not by a local re-implementation.
 */
import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../../src/main/browser/terminal-manager';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';

const TRANSCRIPT_BANNER = '\r\n── phiên trước ──\r\n';

interface FakePtyHandle {
  cols: number;
  rows: number;
  readonly pid: number;
  readonly writes: string[];
  killed: boolean;
  kill: () => void;
  write: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
}

class FakePty implements FakePtyHandle {
  public cols: number;
  public rows: number;
  // A non-positive pid keeps `killProcessTree` (the real OS kill) out of the lane:
  // it returns immediately for pid <= 0. `killed` still proves the teardown ran.
  public readonly pid = 0;
  public readonly writes: string[] = [];
  public killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(public readonly shell: string, public readonly options: Record<string, unknown>) {
    this.cols = Number(options.cols) || 120;
    this.rows = Number(options.rows) || 30;
  }

  onData(cb: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter(listener => listener !== cb);
      },
    };
  }

  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter(listener => listener !== cb);
      },
    };
  }

  kill(): void {
    this.killed = true;
  }

  write(input: string): void {
    this.writes.push(input);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /** Drive the production `child.onData` handler with a chunk. */
  emitData(chunk: string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  /** Drive the production `child.onExit` handler. */
  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal });
  }
}

interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  pty: FakePty | null;
  buffer: string;
  bufferBytes?: number;
  restoredTail?: string;
  lastSeq: number;
  sessionGeneration: number;
  state: 'running' | 'exited' | 'closed' | 'sleeping';
  disposed?: boolean;
  category?: string;
  sleptAt?: number;
  pendingCols?: number;
  pendingRows?: number;
  splitOf?: string;
  deliveryJournal: { getRetainedRange: () => { chunks: number } };
}

interface SavedSessionLike {
  id: string;
  name: string;
  cwd: string;
  buffer?: string;
  splitOf?: string;
  capsuleId?: string;
  cols?: number;
  rows?: number;
  state?: 'running' | 'exited' | 'closed' | 'sleeping';
  category?: string;
  restoredTail?: string;
}

interface TerminalManagerInternals {
  statePath: () => string;
  sessions: Map<string, SessionRecord>;
  sessionGenerations: Map<string, number>;
  activeSessionId: string;
  deferredPtyIds: string[];
  isDisposed: boolean;
  persistTimer: NodeJS.Timeout | null;
  restoreSleepingSession: (
    item: SavedSessionLike,
    initialCols: number | undefined,
    initialRows: number | undefined,
    minimumRows: number,
    parentSessionId?: string,
    parentGeneration?: number,
  ) => SessionRecord;
  pumpDeferredPtyQueue: () => void;
  schedulePersist: (sessionId?: string) => void;
}

interface CapturedEvent {
  name: string;
  payload: unknown;
}

const LIFECYCLE_EVENTS = [
  'close',
  'session-closed',
  'session-woken',
  'session-restarted',
  'session-created',
  'exit',
  'data',
  'session',
] as const;

function recordLifecycleEvents(target: TerminalManager): { events: CapturedEvent[]; stop: () => void } {
  const events: CapturedEvent[] = [];
  const handlers: Array<[string, (payload: unknown) => void]> = [];
  for (const name of LIFECYCLE_EVENTS) {
    const handler = (payload: unknown) => { events.push({ name, payload }); };
    target.on(name, handler);
    handlers.push([name, handler]);
  }
  return {
    events,
    stop: () => {
      for (const [name, handler] of handlers) target.off(name, handler);
    },
  };
}

function eventNames(events: CapturedEvent[]): string[] {
  return events.map(event => event.name);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms); });
}

/**
 * Bounded poll for an eventually-true condition. The PTY process-tree teardown is
 * deliberately asynchronous (`void teardownSessionPty`), so the assertion that the
 * shell was killed must not depend on a single phase of the event loop — a fixed
 * sleep flakes when the machine is loaded by parallel test lanes.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return predicate();
}

function readStateFile(file: string): { activeSessionId?: string; sessions: SavedSessionLike[] } {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { activeSessionId?: string; sessions: SavedSessionLike[] };
}

describe('Phase 5: Terminal sleep / wake lifecycle', () => {
  let tm: TerminalManager;
  let internals: TerminalManagerInternals;
  let scratchDir: string;
  let stateFile: string;
  let previousDataRoot: string | undefined;
  let restoreEnsureSessionPty: () => void;

  const spawnedPtys: FakePty[] = [];
  const ensureSessionPtyCalls: string[] = [];

  const latestPty = (): FakePty => {
    const stub = spawnedPtys[spawnedPtys.length - 1];
    assert.ok(stub, 'a PTY must have been spawned through the stubbed node-pty boundary');
    return stub;
  };

  const record = (id: string): SessionRecord => {
    const session = internals.sessions.get(id);
    assert.ok(session, `session ${id} must exist`);
    return session;
  };

  before(() => {
    previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-terminal-sleep-'));
    process.env.ANTIFAN_DATA_ROOT = scratchDir;
    stateFile = path.join(scratchDir, 'config', 'terminal-sessions.json');

    const ptyModule = require('node-pty') as { spawn: (shell: string, args: string[], options: Record<string, unknown>) => FakePty };
    const realSpawn = ptyModule.spawn;
    ptyModule.spawn = (shell: string, _args: string[], options: Record<string, unknown>) => {
      const stub = new FakePty(shell, options);
      spawnedPtys.push(stub);
      return stub;
    };
    if (ptyModule.spawn === realSpawn) {
      throw new Error('node-pty spawn stub was not installed; the lane would exercise the real PTY');
    }

    tm = TerminalManager.getInstance();
    internals = tm as unknown as TerminalManagerInternals;
    internals.statePath = () => stateFile;

    // Count every dispatch through the real prototype method without replacing it.
    const proto = TerminalManager.prototype as unknown as { ensureSessionPty: (id: string) => unknown };
    const originalEnsure = proto.ensureSessionPty;
    proto.ensureSessionPty = function (this: unknown, id: string) {
      ensureSessionPtyCalls.push(id);
      return originalEnsure.call(this, id);
    };
    restoreEnsureSessionPty = () => { proto.ensureSessionPty = originalEnsure; };
  });

  beforeEach(() => {
    internals.sessions.clear();
    internals.sessionGenerations.clear();
    internals.deferredPtyIds.length = 0;
    internals.activeSessionId = '';
    // afterEach calls dispose(); a fresh manager is live again (createSession /
    // startTerminal both clear this flag themselves).
    internals.isDisposed = false;
    if (internals.persistTimer) {
      clearTimeout(internals.persistTimer);
      internals.persistTimer = null;
    }
    spawnedPtys.length = 0;
    ensureSessionPtyCalls.length = 0;
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {}
  });

  afterEach(async () => {
    await tm.dispose();
  });

  after(() => {
    restoreEnsureSessionPty();
    internals.statePath = () => stateFile;
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  });

  it('(a) sleep releases the PTY, folds the transcript, and emits no close event', async () => {
    const id = tm.createSession('E:/Work/project');
    const ptyStub = latestPty();
    ptyStub.emitData('npm run build\r\nBUILD OK\r\n');
    const session = record(id);
    const transcript = session.buffer;
    assert.strictEqual(transcript, 'npm run build\r\nBUILD OK\r\n');
    assert.strictEqual(session.lastSeq, 1);

    const recorder = recordLifecycleEvents(tm);
    try {
      assert.strictEqual(tm.sleepSession(id), true);
    } finally {
      recorder.stop();
    }

    // PTY disposal happened (synchronously detached, killed on the next loop turn).
    assert.strictEqual(session.pty, null, 'sleep must detach the PTY handle');
    assert.ok(await waitFor(() => ptyStub.killed), 'sleep must kill the shell process');

    // Transcript survives without a live buffer.
    assert.strictEqual(session.state, 'sleeping');
    assert.strictEqual(session.buffer, '', 'the live buffer must be folded away');
    // The session ran live from boot (no restored tail), so composeTranscript
    // returns the raw transcript and that is exactly what gets folded in.
    assert.strictEqual(session.restoredTail, transcript);
    assert.strictEqual(session.bufferBytes, 0);
    assert.strictEqual(session.deliveryJournal.getRetainedRange().chunks, 0, 'the delta journal must be cleared');
    assert.strictEqual(typeof session.sleptAt, 'number');

    // Sleep is not close.
    assert.strictEqual(session.disposed, false, 'sleep must never dispose the session');
    const names = eventNames(recorder.events);
    assert.strictEqual(names.includes('close'), false, "sleep must never emit 'close'");
    assert.strictEqual(names.includes('session-closed'), false, "sleep must never emit 'session-closed'");
    assert.strictEqual(names.includes('exit'), false, 'tearing the PTY down must not look like a shell exit');
    assert.deepStrictEqual([...new Set(names)], ['session'], "sleep emits ONLY 'session'");

    // Every viewer still sees the transcript (mobile-remote-html reads s.buffer only).
    const unpaged = tm.listSessions(false).find(item => item.id === id);
    assert.ok(unpaged);
    assert.strictEqual(unpaged.state, 'sleeping');
    assert.strictEqual(unpaged.buffer, `${transcript}${TRANSCRIPT_BANNER}`, 'the composed transcript must survive a sleep');
    const paged = tm.listSessions().find(item => item.id === id);
    assert.strictEqual(paged?.state, 'sleeping');
    assert.match(paged?.buffer || '', /BUILD OK/);
    assert.strictEqual(tm.getFullBuffer(id).buffer, `${transcript}${TRANSCRIPT_BANNER}`);
    assert.strictEqual(tm.getDiagnostics().sessions.find(item => item.sessionId === id)?.state, 'sleeping');

    // A second sleep is a no-op.
    assert.strictEqual(tm.sleepSession(id), false);
    assert.strictEqual(tm.sleepSession('terminal-does-not-exist'), false);
  });

  it('(b) sleep keeps disposed false and wake restores the same generation with a live PTY', async () => {
    const id = tm.createSession('E:/Work/project');
    latestPty().emitData('history line\r\n');
    const before = record(id);
    const generation = before.sessionGeneration;

    assert.strictEqual(tm.sleepSession(id), true);
    assert.strictEqual(before.disposed, false);

    const recorder = recordLifecycleEvents(tm);
    let woke = false;
    try {
      woke = tm.wakeSession(id);
    } finally {
      recorder.stop();
    }

    assert.strictEqual(woke, true);
    const live = record(id);
    assert.notStrictEqual(live, before, 'the woken record is the spawned one');
    assert.strictEqual(live.state, 'running');
    assert.notStrictEqual(live.pty, null, 'wake must give the session a live shell');
    assert.strictEqual(live.pty, spawnedPtys[1], 'the live record must own the newly spawned shell');
    assert.strictEqual(live.sleptAt, undefined);
    assert.strictEqual(live.sessionGeneration, generation, 'wake must reuse the reserved generation');
    assert.strictEqual(internals.sessionGenerations.get(id), generation);
    assert.strictEqual(spawnedPtys.length, 2, 'wake spawns exactly one replacement shell');

    // The transcript is still renderable after the wake, and no banner accumulates.
    assert.match(live.buffer, /history line/);
    assert.match(tm.getFullBuffer(id).buffer, /history line/);
    assert.match(tm.listSessions().find(item => item.id === id)?.buffer || '', /history line/);

    const names = eventNames(recorder.events);
    assert.strictEqual(names.includes('session-woken'), true, "wake must emit 'session-woken'");
    assert.strictEqual(names.includes('session-restarted'), false, "wake must NOT emit 'session-restarted' (it would migrate the affinity key)");
    const woken = recorder.events.find(event => event.name === 'session-woken');
    assert.deepStrictEqual(woken?.payload, { id, generation });

    // Waking an awake session, and a missing one, are refusals.
    assert.strictEqual(tm.wakeSession(id), false);
    assert.strictEqual(tm.wakeSession('terminal-does-not-exist'), false);
  });

  it('(c) switching to a sleeping tab never respawns its shell', () => {
    const other = tm.createSession('E:/Work/other');
    const sleeping = tm.createSession('E:/Work/project');
    assert.strictEqual(tm.sleepSession(sleeping), true);
    const sleepingRecord = record(sleeping);
    assert.strictEqual(sleepingRecord.pty, null);

    assert.strictEqual(tm.switchSession(other), true);
    const spawnedBefore = spawnedPtys.length;
    ensureSessionPtyCalls.length = 0;

    assert.strictEqual(tm.switchSession(sleeping), true);

    assert.strictEqual(tm.getActiveSessionId(), sleeping, 'viewing a sleeping tab must still select it');
    assert.deepStrictEqual(ensureSessionPtyCalls, [], 'switchSession must not call ensureSessionPty for a sleeping target');
    assert.strictEqual(sleepingRecord.pty, null, 'the sleeping session must still have no PTY');
    assert.strictEqual(sleepingRecord.state, 'sleeping');
    assert.strictEqual(spawnedPtys.length, spawnedBefore, 'no shell may be spawned by a tab click');
  });

  it('(d) write/writeTo on a sleeping session wakes it and then delivers the input', () => {
    const id = tm.createSession('E:/Work/project');
    latestPty().emitData('$ ');
    assert.strictEqual(tm.sleepSession(id), true);
    assert.strictEqual(record(id).pty, null);

    const recorder = recordLifecycleEvents(tm);
    try {
      // Active-session write path.
      tm.write('echo one\r');
    } finally {
      recorder.stop();
    }

    const afterWrite = record(id);
    assert.strictEqual(afterWrite.state, 'running');
    assert.notStrictEqual(afterWrite.pty, null);
    assert.strictEqual(spawnedPtys.length, 2);
    assert.deepStrictEqual(latestPty().writes, ['echo one\r'], 'the keystroke must reach the woken shell');
    assert.strictEqual(eventNames(recorder.events).includes('session-woken'), true, 'a wake-on-input must emit session-woken');
    assert.match(afterWrite.buffer, /\$ /, 'the folded transcript must survive the wake');

    // Targeted write path on a freshly slept session.
    assert.strictEqual(tm.sleepSession(id), true);
    assert.strictEqual(record(id).pty, null);
    const secondRecorder = recordLifecycleEvents(tm);
    try {
      tm.writeTo(id, 'echo two\r');
    } finally {
      secondRecorder.stop();
    }

    assert.strictEqual(record(id).state, 'running');
    assert.strictEqual(spawnedPtys.length, 3);
    assert.deepStrictEqual(latestPty().writes, ['echo two\r']);
    assert.strictEqual(eventNames(secondRecorder.events).includes('session-woken'), true);
  });

  it('(e) setCategory trims, maps empty to undefined, and persists', () => {
    const id = tm.createSession('E:/Work/project');

    assert.strictEqual(tm.setCategory(id, '  Backend  '), true);
    assert.strictEqual(record(id).category, 'Backend');
    assert.strictEqual(tm.listSessions().find(item => item.id === id)?.category, 'Backend');

    assert.strictEqual(tm.setCategory(id, 'Frontend'), true);
    tm.persistSync();
    const saved = readStateFile(stateFile).sessions.find(item => item.id === id);
    assert.ok(saved, 'the session must be on disk');
    assert.strictEqual(saved.category, 'Frontend');

    assert.strictEqual(tm.setCategory(id, '   '), true, 'clearing a category succeeds');
    assert.strictEqual(record(id).category, undefined, 'whitespace must map to undefined');
    tm.persistSync();
    const cleared = readStateFile(stateFile).sessions.find(item => item.id === id);
    assert.strictEqual(cleared?.category, undefined);

    assert.strictEqual(tm.setCategory(id, ''), true);
    assert.strictEqual(record(id).category, undefined);

    assert.strictEqual(tm.setCategory('terminal-does-not-exist', 'X'), false);
    assert.strictEqual(tm.setCategory(id, 'Archive'), true);
  });

  it('(f) persist round-trip restores a sleeping session with its transcript and no PTY', async () => {
    const id = tm.createSession('E:/Work/project');
    latestPty().emitData('deep work output\r\nDONE\r\n');
    assert.strictEqual(tm.sleepSession(id), true);
    assert.strictEqual(tm.setCategory(id, 'Archived'), true);
    const expectedTranscript = record(id).restoredTail;
    assert.ok(expectedTranscript && expectedTranscript.includes('deep work output'));

    tm.persistSync();
    const onDisk = readStateFile(stateFile).sessions.find(item => item.id === id);
    assert.ok(onDisk, 'the sleeping session must be persisted');
    assert.strictEqual(onDisk.state, 'sleeping');
    assert.strictEqual(onDisk.category, 'Archived');
    assert.strictEqual(onDisk.buffer, '');
    assert.strictEqual(onDisk.restoredTail, expectedTranscript);
    assert.match(onDisk.restoredTail || '', /deep work output/);

    // Simulate a fresh process: drop the in-memory records and boot again.
    internals.sessions.clear();
    internals.sessionGenerations.clear();
    internals.activeSessionId = '';
    spawnedPtys.length = 0;

    assert.strictEqual(tm.startTerminal('E:/Work/project'), true);
    const restored = record(id);
    assert.strictEqual(restored.state, 'sleeping', 'a sleeping tab must come back asleep');
    assert.strictEqual(restored.pty, null, 'restoring a sleeping tab must not spawn a PTY');
    assert.strictEqual(restored.category, 'Archived');
    assert.match(restored.restoredTail || '', /deep work output/);
    assert.strictEqual(spawnedPtys.length, 0, 'not even the eager active session may spawn a shell');
    assert.strictEqual(internals.deferredPtyIds.includes(id), false, 'a sleeping tab must not be queued for a deferred start');

    // The deferred queue really stays quiet for a sleeping session.
    await delay(400);
    assert.strictEqual(spawnedPtys.length, 0, 'the deferred queue must not resurrect a sleeping session');

    // The transcript is fully readable for every consumer that reads s.buffer.
    const summary = tm.listSessions().find(item => item.id === id);
    assert.strictEqual(summary?.state, 'sleeping');
    assert.match(summary?.buffer || '', /deep work output/);
    assert.match(tm.getFullBuffer(id).buffer, /DONE/);

    // And it still wakes into a live shell on demand.
    assert.strictEqual(tm.wakeSession(id), true);
    assert.strictEqual(record(id).state, 'running');
    assert.notStrictEqual(record(id).pty, null);
    assert.strictEqual(spawnedPtys.length, 1);
  });

  it('(g) waitTerminal refuses to spawn a shell for a sleeping session', async () => {
    const id = tm.createSession('E:/Work/project');
    latestPty().emitData('one chunk\r\n');
    assert.strictEqual(tm.sleepSession(id), true);
    const before = spawnedPtys.length;
    ensureSessionPtyCalls.length = 0;

    const result = await tm.waitTerminal({ sessionId: id, condition: 'output-match', pattern: 'never-matches', timeoutMs: 5000 });

    assert.deepStrictEqual(result, {
      satisfied: false,
      sessionGeneration: record(id).sessionGeneration,
      lastSeq: 1,
    });
    assert.deepStrictEqual(ensureSessionPtyCalls, [], 'waitTerminal must not materialize a shell');
    assert.strictEqual(spawnedPtys.length, before);
    assert.strictEqual(record(id).state, 'sleeping', 'the refusal must leave the session asleep');
  });

  it('(h) captureBaselineSeq accepts sleeping (monotonic) and still rejects a stopped session', () => {
    const id = tm.createSession('E:/Work/project');
    latestPty().emitData('chunk one\r\n');
    latestPty().emitData('chunk two\r\n');
    const running = tm.captureBaselineSeq(id);
    assert.strictEqual(running.baselineSeq, 2);

    assert.strictEqual(tm.sleepSession(id), true);
    const sleeping = tm.captureBaselineSeq(id);
    assert.strictEqual(sleeping.baselineSeq, 2, 'a sleeping session keeps its monotonic sequence');
    assert.strictEqual(sleeping.sessionGeneration, running.sessionGeneration);

    // An exited session still hard-fails the sync barrier contract.
    const exitedId = tm.createSession('E:/Work/project');
    latestPty().emitExit(0);
    assert.strictEqual(record(exitedId).state, 'exited');
    assert.throws(
      () => tm.captureBaselineSeq(exitedId),
      (err: unknown) => err instanceof CapabilityError && (err as CapabilityError).code === 'SESSION_CLOSED',
    );
  });

  it('(i) the deferred PTY queue drops a session that fell asleep while queued', async () => {
    const restored = internals.restoreSleepingSession(
      { id: 'terminal-9', name: 'Napping', cwd: 'E:/Work/project', state: 'sleeping', category: 'Z', restoredTail: 'old output\r\n' },
      undefined,
      undefined,
      8,
    );
    assert.strictEqual(restored.state, 'sleeping');
    assert.strictEqual(restored.pty, null);
    assert.strictEqual(restored.category, 'Z');

    internals.deferredPtyIds.push('terminal-9');
    internals.pumpDeferredPtyQueue();
    await delay(400);

    assert.strictEqual(internals.deferredPtyIds.includes('terminal-9'), false, 'a sleeping id must be dropped, not head-blocking');
    assert.strictEqual(spawnedPtys.length, 0, 'the queue must not spawn a shell for a sleeping session');
  });

  it('(j) resize() leaves a sleeping session geometry untouched', () => {
    const id = tm.createSession('E:/Work/project');
    const session = record(id);
    assert.strictEqual(tm.sleepSession(id), true);
    session.pendingCols = 80;
    session.pendingRows = 20;

    tm.resize(200, 50);

    assert.strictEqual(session.pendingCols, 80, 'resize must skip sleeping sessions');
    assert.strictEqual(session.pendingRows, 20);

    // The awake session does get the new geometry.
    const awake = tm.createSession('E:/Work/other');
    tm.resize(200, 50);
    assert.strictEqual(record(awake).pendingCols, 200);
    assert.strictEqual(record(awake).pendingRows, 50);
  });
});
