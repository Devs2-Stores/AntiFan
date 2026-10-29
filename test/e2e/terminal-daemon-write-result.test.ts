/**
 * Live daemon contract for two Leader-terminal guarantees that only exist inside the staged host:
 *
 *  - `writeTo` / `write` report whether the bytes reached a PTY. An id that names no session
 *    answers `false` through the real RPC instead of a constant `true`.
 *  - A restarted daemon never reissues an id that a run file or the Leader registry still names,
 *    even when the id sidecar is behind: the next mint lands above all of them.
 *
 * Why the daemon lane: `daemon-entry.ts` and the `TerminalManager` it hosts are the code under
 * test; an in-process unit test cannot prove the wire reply. The run stages the shipped host into
 * a throwaway data root and config dir, so the user's live daemon, its pointer and its registry
 * are never read or written.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { ensureDaemon } from '../../src/main/terminal-daemon/daemon-spawner';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';

function resolveRepoRoot(): string {
  for (let dir = __dirname; ; ) {
    if (fs.existsSync(path.join(dir, 'scripts', 'stage-daemon-host.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = resolveRepoRoot();
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-write-'));
const CONFIG_DIR = path.join(SCRATCH_ROOT, 'config');
const RUNS_DIR = path.join(SCRATCH_ROOT, 'runtime', 'runs');
const READY_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Real-time exception (see ts-no-test-timers): the daemon is a separate OS process, so the only
 * honest wait for its exit is on the process table itself.
 */
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`daemon ${pid} did not exit within ${READY_TIMEOUT_MS}ms`);
    await sleep(250);
  }
}

const idNumber = (id: string): number => Number(/^terminal-(\d+)$/.exec(id)?.[1] ?? NaN);

describe('Live daemon write result and id floor', () => {
  let proxy: DaemonTerminalProxy | null = null;
  let daemonPid = 0;
  const previous = {
    data: process.env.ANTIFAN_DATA_ROOT,
    config: process.env.ANTIFAN_CONFIG_DIR,
    conpty: process.env.ANTIFAN_USE_CONPTY,
  };

  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  async function attach(): Promise<DaemonTerminalProxy> {
    const spawned = await ensureDaemon({ cwd: SCRATCH_ROOT });
    assert.notStrictEqual(spawned.mode, 'in-process', `no daemon host: ${spawned.reason || 'unknown reason'}`);
    const handle = spawned.handle!;
    daemonPid = handle.pid;
    const next = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
    await next.connect();
    proxy = next;
    return next;
  }

  async function stopDaemon(): Promise<void> {
    const pid = daemonPid;
    try { await proxy?.shutdownHost(); } catch {}
    if (pid) await waitForExit(pid);
    try { proxy?.dispose(); } catch {}
    proxy = null;
  }

  after(async () => {
    try { await stopDaemon(); } catch {}
    restore('ANTIFAN_DATA_ROOT', previous.data);
    restore('ANTIFAN_CONFIG_DIR', previous.config);
    restore('ANTIFAN_USE_CONPTY', previous.conpty);
    StorageLocations.resetCache();
    try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch {}
  });

  it('answers written:false for an unknown id and keeps minting above run files and the registry across a restart', async () => {
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = CONFIG_DIR;
    process.env.ANTIFAN_USE_CONPTY = '1';
    StorageLocations.resetCache();
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(RUNS_DIR, { recursive: true });

    // Ids a previous daemon handed out, known only to the hook's run files and the registry.
    fs.writeFileSync(path.join(RUNS_DIR, 'terminal-12.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(RUNS_DIR, 'terminal-13.json.tmp-4242'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(CONFIG_DIR, 'leader-terminals.json'),
      JSON.stringify({ schema: 1, leaders: ['terminal-2'], workers: { 'terminal-15': { leaderId: 'terminal-2', assignedAt: 1 } } }),
      'utf8',
    );

    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTIFAN_DATA_ROOT: SCRATCH_ROOT },
    });

    const first = await attach();

    assert.strictEqual(await first.writeTo('terminal-does-not-exist', 'x'), false, 'an id that names no session reports an undelivered write');

    // The host may open its own first terminal at boot, so the floor is asserted, not an exact id.
    const sessionId = await first.createSession(SCRATCH_ROOT);
    assert.ok(idNumber(sessionId) >= 16, `the first mint lands above the run file and the registry worker, got ${sessionId}`);
    assert.strictEqual(await first.waitReady(sessionId, READY_TIMEOUT_MS), true, 'the shell must reach a prompt before input');
    assert.strictEqual(await first.writeTo(sessionId, 'exit\r'), true, 'a write to a live session reports delivery');

    await stopDaemon();

    // The restarted daemon reads the sidecar (16) but must also honour a newer run file.
    fs.writeFileSync(path.join(RUNS_DIR, 'terminal-30.brief.json'), '{}', 'utf8');
    const second = await attach();
    const nextId = await second.createSession(SCRATCH_ROOT);
    assert.ok(idNumber(nextId) >= 31, `a restarted daemon mints above every id a run file still names, got ${nextId}`);
    assert.notStrictEqual(nextId, sessionId, 'an id is never reissued across the restart');
    assert.strictEqual(await second.writeTo('terminal-does-not-exist', 'x'), false);
  });
});
