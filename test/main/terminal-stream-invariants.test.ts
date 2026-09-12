/**
 * Phase T0: Terminal stream invariants & telemetry.
 *
 * These cases drive the real `TerminalManager.spawn` and its data path against a stubbed
 * `node-pty` boundary, so the sequence numbers, generation leaps, delivery journal, and
 * diagnostics asserted below are the ones production produces — not values a local mock
 * recomputed. Only PTY process creation is faked; everything above it is the shipped code.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const SCRATCH_DATA_ROOT = path.join(os.tmpdir(), `antifan-terminal-invariants-${process.pid}`);

interface DataEvent {
  sessionId: string;
  data: string;
  seq: number;
  generation: number;
}

interface ExitEvent {
  sessionId: string;
  sessionGeneration: number;
  exitCode: number;
  lastSeq: number;
}

class FakePty {
  public cols: number;
  public rows: number;
  public readonly pid = 99999;
  public readonly writes: string[] = [];
  public killed = false;
  public readonly options: Record<string, unknown>;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(public readonly shell: string, options: Record<string, unknown>) {
    this.options = options;
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

interface TerminalManagerPrivates {
  spawn: (
    id: string,
    cwd: string,
    restoredBuffer?: string,
    initialCols?: number,
    initialRows?: number,
    minimumRows?: number,
    parentSessionId?: string,
    parentGeneration?: number,
    reservedGeneration?: number,
  ) => { id: string; lastSeq: number; buffer: string; sessionGeneration: number; state: string; dataSubscription?: { dispose: () => void } };
  sessions: Map<string, { id: string; lastSeq: number; buffer: string; sessionGeneration: number; state: string; dataSubscription?: { dispose: () => void } }>;
  sessionGenerations: Map<string, number>;
  persistTimer?: NodeJS.Timeout | null;
}

const spawnedPtys: FakePty[] = [];

function installPtyStub(): void {
  const ptyModule = require('node-pty') as unknown as { spawn: (shell: string, args: string[], options: Record<string, unknown>) => FakePty };
  const realSpawn = ptyModule.spawn;
  ptyModule.spawn = (shell: string, _args: string[], options: Record<string, unknown>) => {
    const pty = new FakePty(shell, options);
    spawnedPtys.push(pty);
    return pty;
  };
  if (ptyModule.spawn === realSpawn) {
    throw new Error('node-pty spawn stub was not installed; the lane would exercise the real PTY');
  }
}

describe('Phase T0: Terminal Stream Invariants & Telemetry', () => {
  let tm: TerminalManager;
  let privates: TerminalManagerPrivates;
  let previousDataRoot: string | undefined;

  const latestPty = (): FakePty => {
    const pty = spawnedPtys[spawnedPtys.length - 1];
    assert.ok(pty, 'a PTY must have been spawned through the stubbed node-pty boundary');
    return pty;
  };

  before(() => {
    previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_DATA_ROOT;
    installPtyStub();
    tm = TerminalManager.getInstance();
    privates = tm as unknown as TerminalManagerPrivates;
  });

  beforeEach(() => {
    for (const session of privates.sessions.values()) {
      session.dataSubscription?.dispose();
    }
    privates.sessions.clear();
    privates.sessionGenerations.clear();
    spawnedPtys.length = 0;
  });

  after(() => {
    if (privates.persistTimer) clearTimeout(privates.persistTimer);
    for (const session of privates.sessions.values()) {
      session.dataSubscription?.dispose();
    }
    privates.sessions.clear();
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    fs.rmSync(SCRATCH_DATA_ROOT, { recursive: true, force: true });
  });

  it('INVARIANT 1 (Monotonicity): sequence numbers strictly increase within one generation', () => {
    const sessionId = 'test-session-mono';
    const session = privates.spawn(sessionId, 'E:\\Work');
    const pty = latestPty();

    const emitted: DataEvent[] = [];
    const onData = (payload: DataEvent) => {
      if (payload.sessionId === sessionId) emitted.push(payload);
    };
    tm.on('data', onData);

    try {
      pty.emitData('chunk 1');
      pty.emitData('chunk 2');
      pty.emitData('chunk 3');
      pty.emitData('chunk 4');
    } finally {
      tm.removeListener('data', onData);
    }

    assert.strictEqual(emitted.length, 4, 'every PTY chunk must reach the data emitter');
    assert.deepStrictEqual(
      emitted.map(event => event.seq),
      [1, 2, 3, 4],
      'seq must increment contiguously without gaps',
    );
    assert.strictEqual(session.lastSeq, 4, 'the session record must count the appended chunks');
    assert.strictEqual(session.buffer, 'chunk 1chunk 2chunk 3chunk 4', 'the transcript is appended in order');
    assert.ok(
      emitted.every(event => event.generation === session.sessionGeneration),
      'every emitted chunk carries its own session generation',
    );
  });

  it('INVARIANT 2 (Generational Leap): respawning increments generation and starts the new record at seq 0', () => {
    const sessionId = 'test-session-gen';
    const first = privates.spawn(sessionId, 'E:\\Work');
    const firstPty = latestPty();
    firstPty.emitData('data gen 1');
    assert.strictEqual(first.lastSeq, 1);

    const second = privates.spawn(sessionId, 'E:\\Work');
    const secondPty = latestPty();
    assert.notStrictEqual(secondPty, firstPty);
    assert.ok(second.sessionGeneration > first.sessionGeneration, 'generation must leap forward on respawn');
    assert.strictEqual(second.lastSeq, 0, 'a new generation starts its own sequence');

    secondPty.emitData('data gen 2');
    assert.strictEqual(second.lastSeq, 1, 'the first chunk of the new generation is seq 1');
    assert.strictEqual(second.buffer, 'data gen 2', 'the new record does not inherit the previous transcript');
    const spawnedEnv = secondPty.options.env as Record<string, string>;
    assert.strictEqual(
      spawnedEnv.ANTIFAN_TERMINAL_GENERATION,
      String(second.sessionGeneration),
      'the spawned PTY environment must advertise the generation of its own record',
    );
    assert.strictEqual(spawnedEnv.ANTIFAN_TERMINAL_SESSION_ID, sessionId);
  });

  it('INVARIANT 3 (Generation Fencing): a superseded PTY cannot advance the live transcript', () => {
    const sessionId = 'test-session-fence';
    const first = privates.spawn(sessionId, 'E:\\Work');
    const firstPty = latestPty();
    firstPty.emitData('live chunk');
    assert.strictEqual(first.lastSeq, 1);

    const second = privates.spawn(sessionId, 'E:\\Work');
    const secondPty = latestPty();
    assert.ok(second.sessionGeneration > first.sessionGeneration);

    const emitted: DataEvent[] = [];
    const onData = (payload: DataEvent) => {
      if (payload.sessionId === sessionId) emitted.push(payload);
    };
    tm.on('data', onData);
    try {
      // A chunk the shell wrote before the respawn arrives late.
      firstPty.emitData('stale delayed chunk');
    } finally {
      tm.removeListener('data', onData);
    }

    assert.strictEqual(second.lastSeq, 0, 'a stale chunk must never advance the live session sequence');
    assert.strictEqual(second.buffer, '', 'a stale chunk must never enter the live transcript');
    assert.deepStrictEqual(
      emitted.map(event => event.generation),
      [first.sessionGeneration],
      'the late chunk is emitted under the generation that produced it, so a receiver bound to the new generation rejects it',
    );

    secondPty.emitData('fresh chunk');
    assert.strictEqual(second.lastSeq, 1);
    assert.strictEqual(second.buffer, 'fresh chunk');

    const diagnostics = tm.getDiagnostics();
    const live = diagnostics.sessions.filter(entry => entry.sessionId === sessionId);
    assert.strictEqual(live.length, 1, 'only the current generation is reported for a session id');
    assert.strictEqual(live[0]!.generation, second.sessionGeneration);
    assert.strictEqual(live[0]!.lastSeq, 1);
  });

  it('TELEMETRY: getDiagnostics reports the restored transcript and measured stream state', () => {
    const sessionId = 'test-session-diag';
    const session = privates.spawn(sessionId, 'E:\\Work', 'restored_text');
    const pty = latestPty();
    pty.emitData('diag output 1');
    pty.emitData('diag output 2');

    const report = tm.getDiagnostics();
    assert.ok(report.timestamp > 0, 'timestamp must be positive');
    assert.ok(report.sessionCount >= 1, 'session count must include the spawned session');

    const entry = report.sessions.find(row => row.sessionId === sessionId);
    assert.ok(entry, 'the spawned session must be reported');
    assert.strictEqual(entry!.generation, session.sessionGeneration);
    assert.strictEqual(entry!.lastSeq, 2, 'lastSeq counts the chunks appended after the restore');
    assert.strictEqual(entry!.bufferBytes, Buffer.byteLength(session.buffer, 'utf8'));
    assert.ok(entry!.bufferBytes > Buffer.byteLength('restored_text', 'utf8'), 'the restored transcript grew');
    assert.strictEqual(entry!.state, 'running');
  });

  it('records the exit of a PTY as a final transcript chunk and an exit event', () => {
    const sessionId = 'test-session-exit';
    const session = privates.spawn(sessionId, 'E:\\Work');
    const pty = latestPty();
    pty.emitData('before exit');

    const exits: ExitEvent[] = [];
    const onExit = (payload: ExitEvent) => {
      if (payload.sessionId === sessionId) exits.push(payload);
    };
    tm.on('exit', onExit);
    try {
      pty.emitExit(7);
    } finally {
      tm.removeListener('exit', onExit);
    }

    assert.strictEqual(session.state, 'exited');
    assert.strictEqual(session.lastSeq, 2, 'the exit notice is appended as a chunk');
    assert.match(session.buffer, /\[Process exited with code 7\]/);
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0]!.exitCode, 7);
    assert.strictEqual(exits[0]!.sessionGeneration, session.sessionGeneration);
    assert.strictEqual(exits[0]!.lastSeq, 2);
  });

  it('INVARIANT 4 (Input Routing): keyboard input and geometry reach the PTY that owns the session', () => {
    const sessionId = 'test-session-input';
    privates.spawn(sessionId, 'E:\\Work');
    const pty = latestPty();

    // `ensureSessionPty` treats a record without a PTY handle as a deferred restore, so a handle
    // dropped at spawn time turns every keystroke into a silent no-op on the live session.
    tm.writeTo(sessionId, 'echo hi\r');
    assert.deepStrictEqual(pty.writes, ['echo hi\r'], 'input must reach the PTY that owns the session');
    assert.strictEqual(spawnedPtys.length, 1, 'routing input to a live session must not respawn a shell');

    tm.resizeTo(sessionId, 100, 40);
    assert.strictEqual(pty.cols, 100, 'a live session must resize its own PTY');
    assert.strictEqual(pty.rows, 40);
  });
});
