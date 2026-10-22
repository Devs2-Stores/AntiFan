/**
 * A terminal host asked to shut down must exit promptly and take every shell with it.
 *
 * Real daemon-entry, real ConPTY shells (one busy in `ping`), real `shutdown` RPC: the host's exit
 * is timed from the request. node-pty's ConPTY kill forks a console-list agent that the kill itself
 * orphans (it closes the console the agent attaches to), and its unanswered 5 s timer used to keep
 * the pty worker thread — and so `dispose()` and the whole host — alive for ~6 s.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';

// Well under the host's 5 s forced-exit deadline, so the deadline cannot be what makes this pass.
const EXIT_BUDGET_MS = 3_000;

type ProcRow = { ProcessId: number; ParentProcessId: number; Name: string };

function descendantsOf(rootPid: number): ProcRow[] {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
  { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  const rows = JSON.parse(out) as ProcRow[];
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = children.get(row.ParentProcessId) ?? [];
    list.push(row);
    children.set(row.ParentProcessId, list);
  }
  const found: ProcRow[] = [];
  const walk = (pid: number): void => {
    for (const row of children.get(pid) ?? []) {
      if (row.ProcessId === pid) continue;
      found.push(row);
      walk(row.ProcessId);
    }
  };
  walk(rootPid);
  return found;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('terminal host shutdown', { skip: process.platform !== 'win32' && 'ConPTY is Windows-only' }, () => {
  it('exits within budget on ConPTY with a busy shell and leaves no shell behind', { timeout: 60_000 }, async () => {
    const entryPath = path.resolve(process.cwd(), '.compiled/src/main/terminal-daemon/daemon-entry.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-shutdown-exit-'));
    const token = `shutdown-exit-${Date.now()}`;
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
    const exited = new Promise<number>((resolve) => child.once('exit', () => resolve(Date.now())));
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    let proxy: DaemonTerminalProxy | undefined;
    try {
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
      proxy = new DaemonTerminalProxy({ port, token }, { maxReconnectAttempts: 0 });
      await proxy.connect();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await proxy.createSession(root));
      for (const id of ids) await proxy.writeTo(id, 'echo ready\r');
      await sleep(2_000);
      await proxy.writeTo(ids[0]!, 'ping -n 120 127.0.0.1\r');
      await sleep(1_500);

      const shells = descendantsOf(child.pid!).filter((p) => /^powershell/i.test(p.Name));
      assert.ok(shells.length >= 3, `expected the host to own >=3 shells, saw ${shells.map((p) => p.Name).join(',')}`);

      const requestedAt = Date.now();
      await proxy.shutdownHost();
      const exitMs = (await Promise.race([exited, sleep(15_000).then(() => -1)])) - requestedAt;
      assert.ok(exitMs >= 0 && exitMs < EXIT_BUDGET_MS, `host exited ${exitMs} ms after shutdown (budget ${EXIT_BUDGET_MS} ms)`);

      await sleep(500);
      const survivors = shells.filter((p) => isAlive(p.ProcessId));
      assert.deepEqual(survivors, [], 'every shell the host owned is gone after shutdown');
    } finally {
      proxy?.dispose();
      if (child.exitCode === null && child.pid) {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
