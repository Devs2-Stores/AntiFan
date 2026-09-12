/**
 * Live PTY smoke: drives the shipped `TerminalManager` against a real shell through the real
 * `node-pty` boundary, with a real Windows console host.
 *
 * The stub-based invariants in `test/main/terminal-stream-invariants.test.ts` pin the stream
 * protocol (sequence numbers, generations, journal, preload routing) against a fake PTY. They
 * cannot show that a real shell receives input, that a resize reaches the console, or that the
 * teardown path reaps the process tree — those only exist with a real pty, so this case runs one
 * and watches the process table around it.
 *
 * The teardown assertion tracks the shell pid captured from the live handle plus that shell's
 * descendants, never a global scan of console hosts: sibling test files in the same lane start
 * their own shells, and a whole-machine diff would blame those on this run.
 *
 * Isolation: the run points `ANTIFAN_DATA_ROOT` and `ANTIFAN_CONFIG_DIR` at a temp directory, so
 * the persisted session store of the machine is never touched.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { StorageLocations } from '../../src/main/config/storage-locations';

const SCRATCH_ROOT = path.join(os.tmpdir(), `antifan-live-pty-${process.pid}`);
const MARKER = `ANTIFAN_LIVE_${process.pid}_${Date.now()}`;
const READY_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 20_000;

interface LivePtyHandle {
  pid: number;
  cols: number;
  rows: number;
}

interface LiveSessionRecord {
  id: string;
  pty: LivePtyHandle | null;
  lastSeq: number;
  state: string;
}

interface TerminalManagerPrivates {
  sessions: Map<string, LiveSessionRecord>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** True while a process with that pid exists; `kill(pid, 0)` only probes existence. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot of pid -> parent pid, used to find the console host that belongs to a given shell. */
function processParents(): Map<number, number> {
  const parents = new Map<number, number>();
  if (process.platform !== 'win32') return parents;
  let out = '';
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }'],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch {
    return parents;
  }
  for (const line of out.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d+)$/.exec(line.trim());
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** Transitive children of a pid, so a killed shell's console host is tracked with it. */
function descendantsOf(pid: number, parents: Map<number, number>): number[] {
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [child, parent] of parents) {
      if (parent === current && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

describe('Live PTY smoke (real shell through the shipped TerminalManager)', () => {
  let tm: TerminalManager;
  let privates: TerminalManagerPrivates;
  let previousDataRoot: string | undefined;
  let previousConfigDir: string | undefined;

  before(() => {
    previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
    previousConfigDir = process.env.ANTIFAN_CONFIG_DIR;
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_ROOT, 'config');
    StorageLocations.resetCache();
    fs.mkdirSync(path.join(SCRATCH_ROOT, 'config'), { recursive: true });
    tm = TerminalManager.getInstance();
    privates = tm as unknown as TerminalManagerPrivates;
  });

  after(() => {
    for (const session of privates.sessions.values()) {
      session.pty = null;
    }
    privates.sessions.clear();
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    if (previousConfigDir === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = previousConfigDir;
    StorageLocations.resetCache();
    try {
      fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    } catch {
      // A lingering console host can hold the transcript file briefly; the temp dir is disposable.
    }
  });

  it('routes input to a real shell, resizes its console, and reaps the process tree on teardown', async () => {
    const output: string[] = [];
    const onData = (payload: { sessionId: string; data: string }): void => {
      output.push(payload.data);
    };
    tm.on('data', onData);

    let tracked: number[] = [];
    const sessionId = tm.createSession(SCRATCH_ROOT);
    try {
      const session = privates.sessions.get(sessionId);
      assert.ok(session, 'createSession must register the session record');
      assert.ok(session.pty, 'the spawned shell handle must be bound to its record');
      const shellPid = session.pty.pid;
      assert.ok(shellPid > 0, 'the live shell must expose its pid');

      await waitFor(() => output.length > 0, 'the shell banner/first prompt', READY_TIMEOUT_MS);

      // Input has to travel through TerminalManager -> IPty -> the real shell -> back out.
      output.length = 0;
      tm.writeTo(sessionId, `echo ${MARKER}\r`);
      await waitFor(() => output.join('').includes(MARKER), 'the echoed marker from a real shell', READY_TIMEOUT_MS);
      assert.match(output.join(''), new RegExp(MARKER), 'the shell must echo the marker back through the PTY');

      // Geometry has to reach the console, not just the record's pending fields.
      output.length = 0;
      tm.resizeTo(sessionId, 100, 40);
      tm.writeTo(sessionId, '[Console]::WindowWidth\r');
      await waitFor(() => /(^|\D)100(\D|$)/.test(output.join('')), 'the console to report the resized width', READY_TIMEOUT_MS);
      assert.strictEqual(session.pty.cols, 100, 'the resize must reach the live PTY handle');
      assert.strictEqual(session.pty.rows, 40);

      assert.strictEqual(tm.getStats().runningPtyCount, 1, 'a live shell must be counted as a running PTY');

      // The console host belongs to this shell; track it before teardown so its exit is asserted too.
      tracked = [shellPid, ...descendantsOf(shellPid, processParents())];
      assert.ok(tracked.length >= 1, 'the shell must be tracked for teardown');

      const kill = tm.kill();
      const killed = await Promise.race([
        kill.then(() => true),
        sleep(KILL_TIMEOUT_MS).then(() => false),
      ]);
      assert.ok(killed, `teardown must not hang (still running after ${KILL_TIMEOUT_MS}ms)`);
      assert.strictEqual(tm.getStats().runningPtyCount, 0, 'teardown must retire the running PTY');
    } finally {
      tm.removeListener('data', onData);
    }

    // Windows console hosts exit asynchronously: poll instead of assuming an instant, so a slow
    // exit is not confused with a leaked process — a real leak never clears within the window.
    const deadline = Date.now() + KILL_TIMEOUT_MS;
    let alive = tracked.filter(processAlive);
    while (alive.length > 0 && Date.now() < deadline) {
      await sleep(250);
      alive = tracked.filter(processAlive);
    }
    assert.deepStrictEqual(alive, [], `teardown left the shell process tree behind: ${JSON.stringify(alive)} (tracked ${JSON.stringify(tracked)})`);
  });
});
