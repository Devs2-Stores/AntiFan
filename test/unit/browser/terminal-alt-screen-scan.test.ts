/**
 * Alternate-screen tracking across PTY chunk boundaries.
 *
 * The manager decides `altScreen` from the bytes a chunk carries, and a chunk is
 * not a message: ConPTY splits `\x1b[?1049h` mid-sequence, so a per-chunk
 * `includes` misses the switch entirely. The flag is what withholds a clear-screen
 * repaint, so a missed *leave* (flag stuck true) silently ignores the user's
 * `cls`/Ctrl+L, and a missed *enter* wipes the transcript of a full-screen program.
 * These cases drive the production `child.onData` handler with a split sequence,
 * using the same FakePty boundary the other terminal lanes use.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../../src/main/browser/terminal-manager';

class FakePty {
  public cols: number;
  public rows: number;
  public readonly pid = 0;
  private dataListeners: Array<(data: string) => void> = [];

  constructor(_shell: string, options: Record<string, unknown>) {
    this.cols = Number(options.cols) || 120;
    this.rows = Number(options.rows) || 30;
  }

  onData(cb: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(cb);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); } };
  }

  onExit(): { dispose: () => void } {
    return { dispose: () => {} };
  }

  kill(): void {}
  write(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /** Drive the production `child.onData` handler with one chunk. */
  emitData(chunk: string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }
}

interface SessionRecord {
  buffer: string;
  altScreen?: boolean;
  pendingClearScreen?: boolean;
}

describe('Alternate screen tracking across chunks', () => {
  let tm: TerminalManager;
  let scratchDir: string;
  let stateFile: string;
  let previousDataRoot: string | undefined;
  let restoreSpawn: () => void;
  const spawnedPtys: FakePty[] = [];

  const latestPty = (): FakePty => {
    const stub = spawnedPtys[spawnedPtys.length - 1];
    assert.ok(stub, 'a PTY must have been spawned through the stubbed node-pty boundary');
    return stub;
  };
  const record = (id: string): SessionRecord =>
    (tm as unknown as { sessions: Map<string, SessionRecord> }).sessions.get(id) as SessionRecord;

  before(() => {
    previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-alt-screen-'));
    process.env.ANTIFAN_DATA_ROOT = scratchDir;
    stateFile = path.join(scratchDir, 'config', 'terminal-sessions.json');

    const ptyModule = require('node-pty') as { spawn: (shell: string, args: string[], options: Record<string, unknown>) => FakePty };
    const realSpawn = ptyModule.spawn;
    ptyModule.spawn = (shell: string, _args: string[], options: Record<string, unknown>) => {
      const stub = new FakePty(shell, options);
      spawnedPtys.push(stub);
      return stub;
    };
    if (ptyModule.spawn === realSpawn) throw new Error('node-pty spawn stub was not installed');
    restoreSpawn = () => { ptyModule.spawn = realSpawn; };

    tm = TerminalManager.getInstance();
    (tm as unknown as { statePath: () => string }).statePath = () => stateFile;
  });

  beforeEach(() => {
    const internals = tm as unknown as { sessions: Map<string, unknown>; activeSessionId: string; isDisposed: boolean };
    internals.sessions.clear();
    internals.activeSessionId = '';
    internals.isDisposed = false;
    spawnedPtys.length = 0;
    try { fs.rmSync(stateFile, { force: true }); } catch {}
  });

  afterEach(async () => {
    await tm.dispose();
  });

  after(() => {
    restoreSpawn();
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  });

  it('follows a switch that the PTY split across two chunks, in both directions', () => {
    const id = tm.createSession('E:/Work/project');
    const session = record(id);
    const pty = latestPty();

    pty.emitData('prompt$ \x1b[?10');
    assert.strictEqual(session.altScreen, undefined, 'a chunk holding half a sequence is not the sequence');

    pty.emitData('49h');
    assert.strictEqual(session.altScreen, true, 'entering the alternate screen is recognized across the boundary');

    pty.emitData('\x1b[?1049');
    pty.emitData('l\r\n');
    assert.strictEqual(session.altScreen, false, 'leaving it is recognized across the boundary too');
  });

  it('takes the last switch when one chunk carries both', () => {
    const id = tm.createSession('E:/Work/project');
    const session = record(id);
    const pty = latestPty();

    pty.emitData('before \x1b[?1049h inside \x1b[?1049l after');
    assert.strictEqual(session.altScreen, false, 'the report of leaving the screen is the state a viewer must act on');

    pty.emitData('again \x1b[?1049h');
    assert.strictEqual(session.altScreen, true);
  });

  it('withholds a clear-screen repaint for a full-screen program and applies it on the way out', () => {
    const id = tm.createSession('E:/Work/project');
    const session = record(id);
    const pty = latestPty();

    pty.emitData('legacy transcript\r\n');

    // vim opens; the enter sequence is split across the boundary, so the flag is
    // only true once the second chunk lands.
    pty.emitData('\x1b[?1049');
    pty.emitData('h\x1b[2Jvim');
    assert.strictEqual(session.altScreen, true, 'the full-screen program is recognized across the split');

    // Ctrl+L inside the TUI queues a repaint that must not touch scrollback.
    tm.write('\x0c');
    assert.strictEqual(session.pendingClearScreen, true, 'the clear is queued, not yet applied');
    pty.emitData('vim redraw');
    assert.ok(session.buffer.includes('legacy transcript'), 'a full-screen program must not wipe the transcript');
    assert.strictEqual(session.pendingClearScreen, true, 'the queued repaint waits for the alternate screen to end');

    // vim quits: the leave sequence completes across the boundary, and the queued
    // repaint is applied to the same chunk that reports it.
    pty.emitData('\x1b[?1049');
    pty.emitData('l\r\nprompt$ ');
    assert.strictEqual(session.altScreen, false);
    assert.strictEqual(session.buffer.startsWith('\x1b[3J'), true, 'leaving the screen applies the queued wipe');
    assert.strictEqual(session.buffer.includes('legacy transcript'), false, 'the pre-clear transcript is dropped');
    assert.ok(session.buffer.includes('prompt$ '), 'the repainting chunk survives the wipe');
    assert.strictEqual(session.pendingClearScreen, false);
  });

  it('applies a prompt-issued clear on the chunk that arrives, even when it ends the enter sequence mid-way', () => {
    const id = tm.createSession('E:/Work/project');
    const session = record(id);
    const pty = latestPty();

    pty.emitData('legacy transcript\r\n');

    // Ctrl+L at the prompt, then the program's enter sequence arrives cut mid-way in
    // the very next chunk. A chunk that ends mid-sequence has not entered the
    // alternate screen yet, and the clear applies here anyway: the transcript it
    // drops is the one the keystroke asked to drop. Holding it back until the
    // alternate screen ends would defer a prompt-issued clear past the whole
    // session and then destroy the full-screen program's own output instead — the
    // deferred variant fails the first two assertions below.
    tm.write('\x0c');
    pty.emitData('\x1b[H\x1b[2Jprompt$ vim\r\n\x1b[?104');
    assert.strictEqual(session.buffer.startsWith('\x1b[3J'), true, 'the prompt-issued clear is applied to this chunk');
    assert.strictEqual(session.buffer.includes('legacy transcript'), false, 'the pre-clear transcript is dropped');
    assert.strictEqual(session.pendingClearScreen, false, 'the clear is spent here, not carried into the full-screen session');

    pty.emitData('9h\x1b[2Jvim');
    assert.strictEqual(session.altScreen, true, 'the split enter sequence is still recognized once it completes');

    // vim quits: no second wipe follows it, so the screen it painted is still there.
    pty.emitData('\x1b[?1049l\r\nback at the prompt$ ');
    assert.strictEqual(session.altScreen, false);
    assert.strictEqual(session.buffer.split('\x1b[3J').length, 2, 'the clear was applied exactly once, not again on exit');
    assert.ok(session.buffer.includes('back at the prompt$ '), 'the exit repaint is not wiped by a stale clear');
    assert.ok(session.buffer.includes('vim'), 'the full-screen output is still readable after it exits');
  });
});
