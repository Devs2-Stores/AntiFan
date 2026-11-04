/**
 * A terminal host shutdown ends every PTY, and with them every OMP session running inside. The host
 * must refuse it while an OMP run is alive (run file not `ended`, pid alive, heartbeat fresh) unless
 * the caller passes `force`. Runs that are `ended`, whose pid is gone or whose heartbeat is stale
 * must not block.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';
import { LiveRunsError } from '../../src/main/terminal-daemon/protocol';
import { listLiveRuns } from '../../src/main/run/live-runs';
import { readTerminalRunSnapshot } from '../../src/main/run/run-state-service';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function writeRun(runsDir: string, terminal: string, fields: Record<string, unknown>): void {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${terminal}.json`), JSON.stringify({
    schema: 1,
    terminalSessionId: terminal,
    ompSessionId: `omp-${terminal}`,
    pid: process.pid,
    cwd: 'E:\\Work\\x',
    mode: 'unset',
    state: 'running',
    runSeq: 1,
    lastEventAt: Date.now(),
    updatedAt: Date.now(),
    ...fields,
  }));
}

/** A pid that existed and is gone. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.ok(result.pid > 0);
  return result.pid;
}

describe('listLiveRuns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-runs-'));
  const now = 1_000_000;
  const alive = (pid: number): boolean => pid === 111;

  it('keeps only runs that are not ended, with a live pid and a fresh heartbeat', () => {
    writeRun(root, 'terminal-1', { pid: 111, state: 'running', updatedAt: now - 1_000 });
    writeRun(root, 'terminal-2', { pid: 111, state: 'idle', updatedAt: now - 1_000 });
    writeRun(root, 'terminal-3', { pid: 111, state: 'waiting_user', updatedAt: now - 1_000 });
    writeRun(root, 'terminal-4', { pid: 111, state: 'ended', updatedAt: now - 1_000 });
    writeRun(root, 'terminal-5', { pid: 222, state: 'running', updatedAt: now - 1_000 });
    writeRun(root, 'terminal-6', { pid: 111, state: 'running', updatedAt: now - 60_000 });
    writeRun(root, 'terminal-7', { schema: 2, pid: 111, state: 'running', updatedAt: now });
    fs.writeFileSync(path.join(root, 'terminal-1.brief.json'), JSON.stringify({ schema: 1, terminalSessionId: 'brief', pid: 111, state: 'running', updatedAt: now }));
    fs.writeFileSync(path.join(root, 'terminal-8.json'), '{not json');
    writeRun(root, 'terminal-10', { pid: 111, state: 'running', updatedAt: now - 1_000 });

    const live = listLiveRuns(root, { isProcessAlive: alive, clock: () => now });
    assert.deepEqual(live.map((run) => `${run.terminalSessionId}:${run.state}`), [
      'terminal-1:running', 'terminal-2:idle', 'terminal-3:waiting_user', 'terminal-10:running',
    ]);
  });

  it('agrees with the run cards (readTerminalRunSnapshot) on every state, pid and heartbeat age', () => {
    const parityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-runs-parity-'));
    const cases: Array<{ id: string; state: string; pid: number; age: number }> = [];
    for (const state of ['idle', 'running', 'waiting_user', 'ended']) {
      for (const pid of [111, 222, 0]) {
        for (const age of [0, 44_999, 45_000, 45_001, 600_000]) cases.push({ id: `terminal-${cases.length + 1}`, state, pid, age });
      }
    }
    for (const c of cases) writeRun(parityRoot, c.id, { pid: c.pid, state: c.state, updatedAt: now - c.age });
    const guarded = new Set(listLiveRuns(parityRoot, { isProcessAlive: alive, clock: () => now }).map((run) => run.terminalSessionId));
    for (const c of cases) {
      const snapshot = readTerminalRunSnapshot(parityRoot, c.id, { isProcessAlive: alive, clock: () => now });
      assert.ok(snapshot, `${c.id} has a snapshot`);
      assert.equal(guarded.has(c.id), snapshot.state !== 'ended', `${c.id} (${c.state}, pid ${c.pid}, age ${c.age} ms)`);
    }
    assert.ok(guarded.size > 0 && guarded.size < cases.length, 'the grid has both live and not-live runs');
  });

  it('is empty when the runs directory does not exist', () => {
    assert.deepEqual(listLiveRuns(path.join(root, 'missing')), []);
  });

  it('skips a run on the allow list and keeps every other live run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-runs-allow-'));
    writeRun(dir, 'terminal-1', { pid: 111, updatedAt: now });
    writeRun(dir, 'terminal-2', { pid: 111, updatedAt: now });
    const live = listLiveRuns(dir, { isProcessAlive: alive, clock: () => now, allowRuns: ['terminal-1', 'terminal-404'] });
    assert.deepEqual(live.map((run) => run.terminalSessionId), ['terminal-2']);
  });
});

describe('terminal host shutdown guard', { skip: process.platform !== 'win32' && 'ConPTY is Windows-only' }, () => {
  async function startHost(): Promise<{ child: ChildProcess; proxy: DaemonTerminalProxy; root: string; runsDir: string; exited: Promise<void> }> {
    const entryPath = path.resolve(process.cwd(), '.compiled/src/main/terminal-daemon/daemon-entry.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-live-runs-'));
    const token = `live-runs-${Date.now()}-${Math.random()}`;
    const child = spawn(process.execPath, [entryPath, '--port', '0', '--cwd', root], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ANTIFAN_TERMINAL_HOST_TOKEN: token,
        ANTIFAN_DATA_ROOT: root,
        ANTIFAN_CONFIG_DIR: root,
        ANTIFAN_USE_CONPTY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      child.stdout?.on('data', (d) => {
        buf += d.toString();
        const match = buf.match(/TERMINAL_HOST_READY\s+(\{[^\n]+\})/);
        if (match?.[1]) resolve((JSON.parse(match[1]) as { port: number }).port);
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`host exited early code=${code}\n${stderr}`)));
    });
    const proxy = new DaemonTerminalProxy({ port, token }, { maxReconnectAttempts: 0 });
    await proxy.connect();
    return { child, proxy, root, runsDir: path.join(root, 'runtime', 'runs'), exited };
  }

  async function stopHost(host: { child: ChildProcess; proxy: DaemonTerminalProxy; root: string }): Promise<void> {
    host.proxy.dispose();
    if (host.child.exitCode === null && host.child.pid) {
      spawnSync('taskkill', ['/pid', String(host.child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    fs.rmSync(host.root, { recursive: true, force: true });
  }

  it('refuses while an OMP run is alive, keeps the host up, and shuts down with force', { timeout: 60_000 }, async () => {
    const host = await startHost();
    try {
      writeRun(host.runsDir, 'terminal-136', { pid: process.pid, state: 'running' });
      await assert.rejects(host.proxy.shutdownHost(), (err: unknown) => {
        assert.ok(err instanceof LiveRunsError, `expected LiveRunsError, got ${String(err)}`);
        assert.equal(err.code, 'LIVE_RUNS');
        assert.deepEqual(err.runs.map((run) => [run.terminalSessionId, run.pid, run.state]), [['terminal-136', process.pid, 'running']]);
        return true;
      });
      await sleep(1_000);
      assert.equal(host.child.exitCode, null, 'the host stays up after a refused shutdown');

      await host.proxy.shutdownHost({ force: true });
      await Promise.race([host.exited, sleep(15_000)]);
      assert.notEqual(host.child.exitCode, null, 'force shuts the host down');
    } finally {
      await stopHost(host);
    }
  });

  it('is not blocked by an ended run, a dead pid or a stale heartbeat', { timeout: 60_000 }, async () => {
    const host = await startHost();
    try {
      writeRun(host.runsDir, 'terminal-1', { pid: process.pid, state: 'ended' });
      writeRun(host.runsDir, 'terminal-2', { pid: deadPid(), state: 'running' });
      writeRun(host.runsDir, 'terminal-3', { pid: process.pid, state: 'idle', updatedAt: Date.now() - 10 * 60_000 });
      await host.proxy.shutdownHost();
      await Promise.race([host.exited, sleep(15_000)]);
      assert.notEqual(host.child.exitCode, null, 'the host exits without force when no run is alive');
    } finally {
      await stopHost(host);
    }
  });

  it('lets an approved run through but still refuses a live run that is not on the list', { timeout: 60_000 }, async () => {
    const host = await startHost();
    try {
      writeRun(host.runsDir, 'terminal-5', { pid: process.pid, state: 'running' });
      // A run that starts after the owner's approval was written is not on the list.
      writeRun(host.runsDir, 'terminal-9', { pid: process.pid, state: 'running' });
      await assert.rejects(host.proxy.shutdownHost({ allowRuns: ['terminal-5'] }), (err: unknown) => {
        assert.ok(err instanceof LiveRunsError, `expected LiveRunsError, got ${String(err)}`);
        assert.deepEqual(err.runs.map((run) => run.terminalSessionId), ['terminal-9']);
        return true;
      });
      await sleep(1_000);
      assert.equal(host.child.exitCode, null, 'the host stays up while an unapproved run is alive');

      fs.rmSync(path.join(host.runsDir, 'terminal-9.json'));
      await host.proxy.shutdownHost({ allowRuns: ['terminal-5'] });
      await Promise.race([host.exited, sleep(15_000)]);
      assert.notEqual(host.child.exitCode, null, 'the host exits once every live run is approved');
    } finally {
      await stopHost(host);
    }
  });
});
