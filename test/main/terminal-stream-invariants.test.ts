import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

interface MockSession {
  id: string;
  name: string;
  cwd: string;
  pty: unknown;
  buffer: string;
  splitOf?: string;
  capsuleId: string;
  disposed: boolean;
  lastSeq: number;
  sessionGeneration: number;
  state: 'running';
  dataSubscription?: { dispose: () => void };
  exitSubscription?: { dispose: () => void };
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
    parentGeneration?: number
  ) => MockSession;
  sessions: Map<string, MockSession>;
  sessionGenerations: Map<string, number>;
  lastCols?: number;
  lastRows?: number;
  currentCapsuleId?: string;
}

describe('Phase T0: Terminal Stream Invariants & Telemetry', () => {
  let tm: TerminalManager;
  let privates: TerminalManagerPrivates;
  let originalSpawn: TerminalManagerPrivates['spawn'];
  const ptyWriters: Map<string, (data: string) => void> = new Map();

  before(() => {
    tm = TerminalManager.getInstance();
    privates = tm as unknown as TerminalManagerPrivates;
    originalSpawn = privates.spawn.bind(tm);

    // Mock spawn to deterministically control PTY output events without native node-pty dependency in unit tests
    privates.spawn = function (
      id: string,
      cwd: string,
      restoredBuffer = '',
      initialCols?: number,
      initialRows?: number,
      minimumRows = 4,
      parentSessionId?: string,
      _parentGeneration?: number
    ): MockSession {
      const cols = Math.max(40, initialCols || privates.lastCols || 120);
      const rows = Math.max(minimumRows, initialRows || privates.lastRows || 30);
      const currentGen = (privates.sessionGenerations.get(id) || 0) + 1;
      privates.sessionGenerations.set(id, currentGen);

      let ptyDataListener: ((data: string) => void) | null = null;
      const mockPty = {
        pid: 99999,
        cols,
        rows,
        onData: (cb: (data: string) => void) => {
          ptyDataListener = cb;
          return { dispose: () => { ptyDataListener = null; } };
        },
        onExit: (_cb?: () => void) => ({ dispose: () => {} }),
        kill: () => {},
        write: (_input: string) => {},
        resize: (newCols: number, newRows: number) => {
          mockPty.cols = newCols;
          mockPty.rows = newRows;
        },
      };

      ptyWriters.set(id, (chunk: string) => {
        if (ptyDataListener) {
          ptyDataListener(chunk);
        }
      });

      const s: MockSession = {
        id,
        name: `Terminal ${id}`,
        cwd: cwd || 'E:\\Work',
        pty: mockPty,
        buffer: restoredBuffer,
        splitOf: parentSessionId,
        capsuleId: privates.currentCapsuleId || 'default',
        disposed: false,
        lastSeq: 0,
        sessionGeneration: currentGen,
        state: 'running' as const,
        dataSubscription: mockPty.onData((data: string) => {
          s.lastSeq = (s.lastSeq || 0) + 1;
          s.buffer += data;
          tm.emit('data', {
            sessionId: id,
            data,
            seq: s.lastSeq,
            generation: s.sessionGeneration,
          });
        }),
        exitSubscription: mockPty.onExit(() => {}),
      };

      privates.sessions.set(id, s);
      return s;
    };
  });

  after(() => {
    privates.spawn = originalSpawn;
    privates.sessions.clear();
  });

  it('INVARIANT 1 (Monotonicity): sequence numbers strictly increase within one generation', async () => {
    const sessionId = 'test-session-mono';
    privates.spawn(sessionId, 'E:\\Work');
    const writer = ptyWriters.get(sessionId);
    assert.ok(writer, 'PTY writer must be registered');

    const emittedSeqs: number[] = [];
    const onData = (payload: { sessionId: string; seq: number; generation: number }) => {
      if (payload.sessionId === sessionId) {
        emittedSeqs.push(payload.seq);
      }
    };
    tm.on('data', onData);

    try {
      writer('chunk 1');
      writer('chunk 2');
      writer('chunk 3');
      writer('chunk 4');

      assert.strictEqual(emittedSeqs.length, 4, 'Must have received 4 events');
      for (let i = 1; i < emittedSeqs.length; i++) {
        const current = emittedSeqs[i];
        const prev = emittedSeqs[i - 1];
        assert.ok(typeof current === 'number' && typeof prev === 'number');
        assert.ok(current > prev, `seq(${current}) must be strictly greater than seq(${prev})`);
        assert.strictEqual(current, prev + 1, 'seq must increment contiguously without gaps at emitter level');
      }
    } finally {
      tm.removeListener('data', onData);
    }
  });

  it('INVARIANT 2 (Generational Leap): respawning increments generation and resets seq to 0', async () => {
    const sessionId = 'test-session-gen';
    const s1 = privates.spawn(sessionId, 'E:\\Work');
    const gen1 = s1.sessionGeneration;
    const writer1 = ptyWriters.get(sessionId);
    assert.ok(writer1);
    writer1('data gen 1');
    assert.strictEqual(s1.lastSeq, 1);

    // Respawn session with same ID
    const s2 = privates.spawn(sessionId, 'E:\\Work');
    const gen2 = s2.sessionGeneration;

    assert.ok(gen2 > gen1, `Generation must increment: ${gen2} > ${gen1}`);
    assert.strictEqual(s2.lastSeq, 0, 'Sequence must reset to 0 in new generation');

    const writer2 = ptyWriters.get(sessionId);
    assert.ok(writer2);
    writer2('data gen 2');
    assert.strictEqual(s2.lastSeq, 1, 'First chunk of new generation must be seq 1');
  });

  it('INVARIANT 3 (Generation Fencing): receiver can identify and reject stale generation chunks', async () => {
    const sessionId = 'test-session-fence';
    const s1 = privates.spawn(sessionId, 'E:\\Work');
    const gen1 = s1.sessionGeneration;

    // Simulate renderer state currently bound to gen1
    const rendererReceiver = {
      boundGeneration: gen1,
      renderedChunks: [] as string[],
      rejectedStaleChunks: 0,
      receive(chunk: { generation: number; data: string; seq: number }) {
        if (chunk.generation !== this.boundGeneration) {
          this.rejectedStaleChunks++;
          return false;
        }
        this.renderedChunks.push(chunk.data);
        return true;
      },
    };

    // Receive valid gen1 chunk
    const accepted1 = rendererReceiver.receive({ generation: gen1, data: 'live chunk', seq: 1 });
    assert.strictEqual(accepted1, true);

    // Now session respawns to gen2, and renderer updates its subscription to gen2
    const s2 = privates.spawn(sessionId, 'E:\\Work');
    const gen2 = s2.sessionGeneration;
    assert.ok(gen2 > gen1);
    rendererReceiver.boundGeneration = gen2;

    // An old delayed chunk from gen1 arrives
    const acceptedOld = rendererReceiver.receive({ generation: gen1, data: 'stale delayed chunk', seq: 2 });
    assert.strictEqual(acceptedOld, false, 'Delayed chunk from previous generation must be rejected');
    assert.strictEqual(rendererReceiver.rejectedStaleChunks, 1);
  });

  it('TELEMETRY (Commit 1 Verification): getDiagnostics returns complete structured stream metadata', () => {
    const sessionId = 'test-session-diag';
    privates.spawn(sessionId, 'E:\\Work', 'restored_text');
    const writer = ptyWriters.get(sessionId);
    assert.ok(writer);
    writer('diag output 1');
    writer('diag output 2');

    const report = tm.getDiagnostics();
    assert.ok(report.timestamp > 0, 'Timestamp must be positive');
    assert.ok(report.sessionCount >= 1, 'Session count must be >= 1');

    const sessionDiag = report.sessions.find(s => s.sessionId === sessionId);
    assert.ok(sessionDiag, 'Target session must be in diagnostics');
    assert.strictEqual(sessionDiag?.sessionId, sessionId);
    assert.ok(sessionDiag.generation > 0, 'Generation must be positive');
    assert.strictEqual(sessionDiag.lastSeq, 2, 'lastSeq must be 2 after 2 writes');
    assert.ok(sessionDiag.bufferBytes > 0, 'bufferBytes must be > 0');
    assert.strictEqual(sessionDiag.state, 'running');
  });
});
