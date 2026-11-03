/**
 * How soon terminal state reaches disk. The state file is rewritten whole, so shell output alone
 * may only trigger a write once a minute, while a structural change (here: the shell exiting) must
 * still land within seconds even when an output-only write is already pending.
 *
 * Drives the real `TerminalManager.spawn` data and exit handlers against a stubbed `node-pty`, with
 * the state-file write itself replaced by a recorder so the write times are what gets asserted.
 */
import { describe, it, before, beforeEach, afterEach, after, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const SCRATCH_DATA_ROOT = path.join(os.tmpdir(), `antifan-persist-cadence-${process.pid}`);
const T0 = 1_000_000;

class FakePty {
  public cols = 120;
  public rows = 30;
  public readonly pid = 99998;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  onData(cb: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(cb);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); } };
  }
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.push(cb);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb); } };
  }
  kill(): void {}
  write(): void {}
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  emitData(chunk: string): void { for (const l of [...this.dataListeners]) l(chunk); }
  emitExit(exitCode: number): void { for (const l of [...this.exitListeners]) l({ exitCode }); }
}

interface Privates {
  spawn: (id: string, cwd: string) => { dataSubscription?: { dispose: () => void }; exitSubscription?: { dispose: () => void } };
  sessions: Map<string, { dataSubscription?: { dispose: () => void }; exitSubscription?: { dispose: () => void } }>;
  sessionGenerations: Map<string, number>;
  dirtySessionIds: Set<string>;
  persistTimer: NodeJS.Timeout | null;
  persistAsync: () => Promise<void>;
}

describe('Terminal state persistence cadence', () => {
  const spawned: FakePty[] = [];
  let privates: Privates;
  let originalPersistAsync: () => Promise<void>;
  // The state file and its id-counter sidecar resolve from ANTIFAN_CONFIG_DIR first; a run from an
  // AntiFan terminal inherits the live app's, so both variables point at a scratch root here.
  const previousEnv = { dataRoot: process.env.ANTIFAN_DATA_ROOT, configDir: process.env.ANTIFAN_CONFIG_DIR };
  let writes: number[] = [];
  let originalSpawn: ((...args: unknown[]) => unknown) | undefined;

  before(() => {
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_DATA_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DATA_ROOT, 'config');
    const ptyModule = require('node-pty') as { spawn: (...args: unknown[]) => unknown };
    originalSpawn = ptyModule.spawn;
    ptyModule.spawn = () => {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    };
    privates = TerminalManager.getInstance() as unknown as Privates;
    originalPersistAsync = privates.persistAsync;
  });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    writes = [];
    privates.persistAsync = () => {
      writes.push(Date.now() - T0);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    clearTimeout(privates.persistTimer ?? undefined);
    privates.persistTimer = null;
    for (const s of privates.sessions.values()) {
      s.dataSubscription?.dispose();
      s.exitSubscription?.dispose();
    }
    privates.sessions.clear();
    privates.sessionGenerations.clear();
    privates.dirtySessionIds.clear();
    spawned.length = 0;
    mock.timers.reset();
  });

  after(() => {
    privates.persistAsync = originalPersistAsync;
    const ptyModule = require('node-pty') as { spawn: (...args: unknown[]) => unknown };
    if (originalSpawn) ptyModule.spawn = originalSpawn;
    for (const [key, value] of [['ANTIFAN_DATA_ROOT', previousEnv.dataRoot], ['ANTIFAN_CONFIG_DIR', previousEnv.configDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(SCRATCH_DATA_ROOT, { recursive: true, force: true });
  });

  /** Spawns a session and lets the spawn's own structural write go out first. */
  const spawnSettled = (id: string): FakePty => {
    privates.spawn(id, os.tmpdir());
    const pty = spawned[spawned.length - 1];
    assert.ok(pty, 'the spawn must go through the stubbed node-pty');
    mock.timers.tick(5_000);
    writes = [];
    return pty;
  };

  it('writes continuous shell output once a minute, not every few seconds', () => {
    const pty = spawnSettled('cadence-output');
    const start = Date.now() - T0;
    for (let t = 0; t < 130_000; t += 500) {
      pty.emitData('\x1b[2K\x1b[1Gspinner frame\r');
      mock.timers.tick(500);
    }
    assert.deepEqual(writes.map((w) => w - start), [60_000, 120_000]);
  });

  it('writes a shell exit within 5 s even while an output-only write is pending', () => {
    const pty = spawnSettled('cadence-exit');
    const start = Date.now() - T0;
    pty.emitData('build output\r\n');
    mock.timers.tick(10_000);
    assert.deepEqual(writes, [], 'output alone is not written after 10 s');
    pty.emitExit(0);
    mock.timers.tick(5_000);
    assert.deepEqual(writes.map((w) => w - start), [15_000], 'the exit pulls the pending write to 5 s after it');
  });

  it('never lets output push a pending structural write later', () => {
    const pty = spawnSettled('cadence-pull-only');
    const start = Date.now() - T0;
    pty.emitExit(0);
    for (let t = 0; t < 4_000; t += 250) {
      pty.emitData('late chatter\r\n');
      mock.timers.tick(250);
    }
    // The exit armed a 5 s write; four seconds of output must not have re-armed it to 60 s.
    mock.timers.tick(1_000);
    assert.deepEqual(writes.map((w) => w - start), [5_000]);
  });
});
