/**
 * Worker-thread owner of node-pty for the terminal host.
 *
 * ConPTY's `startProcess` + `connect` run synchronously inside `pty.spawn` and cost 100-300 ms each
 * on Windows (more under CPU load). Hosted on the daemon's only JS thread, ten windows opening their
 * terminals at once stalled every RPC for 10 s+. Here they stall this thread only; the host keeps
 * answering while shells start one after another.
 *
 * Protocol (structured-clone messages, ordered per port):
 *   in : spawn | write | resize | pause | resume | kill | shutdown
 *   out: spawned | spawnError | data | exit | drained
 * Spawn tokens, not session ids, key the PTYs: a session respawns under the same id.
 */
import { parentPort } from 'node:worker_threads';
import { spawn as spawnProcess } from 'node:child_process';
import * as pty from 'node-pty';
import { absorbConoutRelayErrors } from './pty-conout-relay';

export type PtyWorkerRequest =
  | { op: 'spawn'; token: number; file: string; options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions; useConpty: boolean; fallbackCwd: string }
  | { op: 'write'; token: number; data: string }
  | { op: 'resize'; token: number; cols: number; rows: number }
  | { op: 'pause'; token: number }
  | { op: 'resume'; token: number }
  | { op: 'kill'; token: number }
  | { op: 'shutdown' };

export type PtyWorkerEvent =
  | { type: 'spawned'; token: number; pid: number; conptyFailed: boolean; conptyError?: string }
  | { type: 'spawnError'; token: number; message: string }
  | { type: 'data'; token: number; data: string }
  | { type: 'exit'; token: number; exitCode: number; signal?: number }
  | { type: 'drained' };

const port = parentPort;
if (!port) throw new Error('pty-worker must run inside a worker thread');

const ptys = new Map<number, pty.IPty>();
// Output is coalesced per PTY until the current turn ends: a burst of small ConPTY reads becomes
// one message instead of one structured clone each.
const pendingData = new Map<number, string>();
let flushScheduled = false;

const post = (event: PtyWorkerEvent): void => port.postMessage(event);

function flushData(): void {
  flushScheduled = false;
  for (const [token, data] of pendingData) post({ type: 'data', token, data });
  pendingData.clear();
}

function flushToken(token: number): void {
  const data = pendingData.get(token);
  if (data === undefined) return;
  pendingData.delete(token);
  post({ type: 'data', token, data });
}

/** `pty.kill()` closes the console; descendants (node, watchers) survive it on Windows. */
function killTree(pid: number): void {
  if (process.platform !== 'win32' || !(pid > 0)) return;
  try {
    const child = spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function spawnOnce(file: string, options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions, fallbackCwd: string): pty.IPty {
  try {
    return pty.spawn(file, [], options);
  } catch {
    return pty.spawn(file, [], { ...options, cwd: fallbackCwd });
  }
}

function handleSpawn(req: Extract<PtyWorkerRequest, { op: 'spawn' }>): void {
  let child: pty.IPty;
  let conptyFailed = false;
  let conptyError: string | undefined;
  try {
    if (req.useConpty) {
      try {
        child = spawnOnce(req.file, { ...req.options, useConpty: true } as pty.IWindowsPtyForkOptions, req.fallbackCwd);
      } catch (err) {
        conptyFailed = true;
        conptyError = err instanceof Error ? err.message : String(err);
        child = spawnOnce(req.file, { ...req.options, useConpty: false } as pty.IWindowsPtyForkOptions, req.fallbackCwd);
      }
    } else {
      child = spawnOnce(req.file, req.options, req.fallbackCwd);
    }
  } catch (err) {
    post({ type: 'spawnError', token: req.token, message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const token = req.token;
  // Unhandled here, the relay's teardown EPIPE would end this thread and every shell it hosts.
  absorbConoutRelayErrors(child);
  ptys.set(token, child);
  post({ type: 'spawned', token, pid: child.pid, conptyFailed, ...(conptyError ? { conptyError } : {}) });
  child.onData((data) => {
    const prev = pendingData.get(token);
    pendingData.set(token, prev === undefined ? data : prev + data);
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flushData);
    }
  });
  child.onExit(({ exitCode, signal }) => {
    ptys.delete(token);
    flushToken(token);
    post({ type: 'exit', token, exitCode, ...(typeof signal === 'number' ? { signal } : {}) });
  });
}

function kill(token: number): void {
  const child = ptys.get(token);
  if (!child) return;
  const pid = child.pid;
  try { child.resume(); } catch {}
  try { child.kill(); } catch {}
  killTree(pid);
}

port.on('message', (req: PtyWorkerRequest) => {
  switch (req.op) {
    case 'spawn':
      handleSpawn(req);
      return;
    case 'write':
      try { ptys.get(req.token)?.write(req.data); } catch {}
      return;
    case 'resize':
      try { ptys.get(req.token)?.resize(req.cols, req.rows); } catch {}
      return;
    case 'pause':
      try { ptys.get(req.token)?.pause(); } catch {}
      return;
    case 'resume':
      try { ptys.get(req.token)?.resume(); } catch {}
      return;
    case 'kill':
      kill(req.token);
      return;
    case 'shutdown':
      for (const token of [...ptys.keys()]) kill(token);
      flushData();
      post({ type: 'drained' });
      // node-pty finishes each kill asynchronously (console-list agent, conout worker). Closing
      // the port lets this thread exit once that settles; a `terminate()` mid-flight kills the host.
      port.close();
      return;
  }
});
