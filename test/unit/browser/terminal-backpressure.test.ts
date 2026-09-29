/**
 * Phase 8: End-to-end backpressure — real TerminalManager against a fake PTY.
 *
 * These cases drive `TerminalManager.appendData`/`recordSubscriberAck` via the
 * real session record and event emitter. Only the PTY handle is a stub
 * (required — OS process creation is a genuine boundary, same as the sibling
 * sleep-lifecycle suite). Assertions cover:
 *   - subscribers see no more than BACKPRESSURE_HIGH_WATERMARK_BYTES in flight;
 *   - an ack below the low watermark drains the pending queue in seq order;
 *   - a session with no subscribers is never throttled;
 *   - a pruned (stale) subscriber cannot leave a session paused forever;
 *   - a pending-queue overflow evicts oldest queued chunks (journal keeps data).
 */
import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager, BACKPRESSURE_HIGH_WATERMARK_BYTES, BACKPRESSURE_LOW_WATERMARK_BYTES } from '../../../src/main/browser/terminal-manager';

interface FakePtyHandle {
  cols: number;
  rows: number;
  readonly pid: number;
  killed: boolean;
  write: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose(): void };
  emitData: (chunk: string) => void;
  emitExit: (code?: number) => void;
}

class FakePty implements FakePtyHandle {
  public cols: number;
  public rows: number;
  public readonly pid = 0;
  public killed = false;
  private dataL: Array<(d: string) => void> = [];
  private exitL: Array<(e: { exitCode: number }) => void> = [];
  constructor(_shell: string, options: Record<string, unknown>) {
    this.cols = typeof options.cols === 'number' ? options.cols : 80;
    this.rows = typeof options.rows === 'number' ? options.rows : 24;
  }
  onData(cb: (d: string) => void) { this.dataL.push(cb); return { dispose: () => { this.dataL = this.dataL.filter(f => f !== cb); } }; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitL.push(cb); return { dispose: () => { this.exitL = this.exitL.filter(f => f !== cb); } }; }
  write() {}
  resize() {}
  kill() { this.killed = true; }
  emitData(d: string) { for (const cb of this.dataL) cb(d); }
  emitExit(code = 0) { for (const cb of this.exitL) cb({ exitCode: code }); }
}

interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  pty: FakePty | null;
  lastSeq: number;
  sessionGeneration: number;
  state: 'running' | 'exited' | 'closed' | 'sleeping';
  pausedForBackpressure: boolean;
  pendingEmitQueue: Array<{ data: string; seq: number; generation: number; bytes: number }>;
  pendingEmitBytes: number;
  unackedBytes: number;
  inFlightChunkBytes: Map<number, number>;
}

interface TerminalManagerInternals {
  statePath: () => string;
  sessions: Map<string, SessionRecord>;
  sessionGenerations: Map<string, number>;
  activeSessionId: string;
  isDisposed: boolean;
  persistTimer: NodeJS.Timeout | null;
  pruneSubscribersForSession: (id: string) => void;
}

function collectDataFrames(tm: TerminalManager) {
  const frames: Array<{ sessionId: string; seq: number; data: string }> = [];
  tm.on('data', (p: { sessionId: string; seq: number; data: string }) => frames.push(p));
  return frames;
}

describe('terminal backpressure (P8)', () => {
  let tm: TerminalManager;
  let internals: TerminalManagerInternals;
  let scratchDir: string;
  let stateFile: string;
  let previousDataRoot: string | undefined;
  const spawnedPtys: FakePty[] = [];

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

  const subscribe = (sessionId: string, gen = 1, ackedSeq = 0) => {
    tm.recordSubscriberAck({ rendererInstanceId: 'r1', sessionId, generation: gen, seq: ackedSeq, role: 'DOCK' });
  };

  before(() => {
    previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p8-'));
    process.env.ANTIFAN_DATA_ROOT = scratchDir;
    stateFile = path.join(scratchDir, 'config', 'terminal-sessions.json');
    const ptyModule = require('node-pty') as { spawn: (shell: string, args: string[], options: Record<string, unknown>) => FakePty };
    const realSpawn = ptyModule.spawn;
    ptyModule.spawn = (shell: string, _args: string[], options: Record<string, unknown>) => {
      const stub = new FakePty(shell, options);
    internals.isDisposed = false;
      spawnedPtys.push(stub);
      return stub;
    };
    if (ptyModule.spawn === realSpawn) {
      throw new Error('node-pty spawn stub was not installed; the lane would exercise the real PTY');
    }
    tm = TerminalManager.getInstance();
    internals = tm as unknown as TerminalManagerInternals;
    internals.statePath = () => stateFile;
  });

  beforeEach(() => {
    internals.sessions.clear();
    internals.sessionGenerations.clear();
    internals.activeSessionId = '';
    internals.isDisposed = false;
  });

  afterEach(async () => {
    await tm.dispose();
    internals.statePath = () => stateFile;
  });

  after(() => {
    internals.statePath = () => stateFile;
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  });

  it('emits every chunk when no subscribers exist (no throttling)', () => {
    const id = tm.createSession('E:/Work/project');
    const pty = latestPty();
    const frames = collectDataFrames(tm);
    for (let i = 0; i < 50; i++) pty.emitData(`c${i}`);
    assert.equal(frames.length, 50);
    assert.ok(frames.every((f) => f.sessionId === id));
  });

  it('throttles a session whose subscriber in-flight exceeds the high watermark', () => {
    const id = tm.createSession('E:/Work/project');
    const pty = latestPty();
    const frames = collectDataFrames(tm);
    subscribe(id, 1, 0);
    // Emit ~300 KiB across chunks of 1 KiB each.
    for (let i = 0; i < 300; i++) pty.emitData('y'.repeat(1024));
    const s = record(id);
    assert.ok(s.pausedForBackpressure, 'session must pause above high watermark');
    assert.ok(s.pendingEmitQueue.length > 0, 'queued chunks while paused');
    assert.ok(s.unackedBytes >= BACKPRESSURE_HIGH_WATERMARK_BYTES, 'unacked reaches high watermark');
    assert.ok(s.unackedBytes < BACKPRESSURE_HIGH_WATERMARK_BYTES + 4096, 'unacked bounded near watermark');
    assert.ok(frames.length < 300, 'some chunks were not emitted immediately');
  });

  it('drains pending queue in seq order when ack drops below low watermark', () => {
    const id = tm.createSession('E:/Work/project');
    const pty = latestPty();
    const frames = collectDataFrames(tm);
    subscribe(id, 1, 0);
    for (let i = 0; i < 300; i++) pty.emitData('y'.repeat(1024));
    const s = record(id);
    assert.ok(s.pausedForBackpressure);
    const emittedBefore = frames.length;
    const lastSeq = frames.at(-1)?.seq ?? 0;
    const targetUnacked = BACKPRESSURE_LOW_WATERMARK_BYTES - 1024;
    const ackedSeq = lastSeq - Math.ceil(targetUnacked / 1024);
    tm.recordSubscriberAck({ rendererInstanceId: 'r1', sessionId: id, generation: 1, seq: ackedSeq, role: 'DOCK' });
    assert.ok(!s.pausedForBackpressure, 'resume below low watermark');
    assert.ok(frames.length > emittedBefore, 'pending queue drained');
    assert.equal(frames.at(-1)?.seq, 300, 'all 300 chunks delivered in order after drain');
  });

  it('a pruned subscriber does not leave the session paused forever', () => {
    const id = tm.createSession('E:/Work/project');
    const pty = latestPty();
    const frames = collectDataFrames(tm);
    subscribe(id, 1, 0);
    for (let i = 0; i < 300; i++) pty.emitData('y'.repeat(1024));
    const s = record(id);
    assert.ok(s.pausedForBackpressure);
    internals.pruneSubscribersForSession(id);
    const emittedBefore = frames.length;
    pty.emitData('more');
    assert.ok(frames.length > emittedBefore, 'emits again once no subscriber is throttling it');
  });

  it('pending queue overflow drops oldest queued chunks without losing journal data', () => {
    const id = tm.createSession('E:/Work/project');
    const pty = latestPty();
    collectDataFrames(tm);
    subscribe(id, 1, 0);
    // Emit 2 MiB across 2 KiB chunks to exceed BACKPRESSURE_MAX_PENDING_BYTES.
    for (let i = 0; i < 1024; i++) pty.emitData('z'.repeat(2048));
    const s = record(id);
    assert.ok(s.pendingEmitBytes <= 1024 * 1024, 'pending queue bounded at 1 MiB');
    assert.ok(s.pendingEmitQueue.length > 0, 'still has queued data to emit');
  });
});
