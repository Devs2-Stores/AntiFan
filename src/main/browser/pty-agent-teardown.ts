/**
 * node-pty (1.1.0, Windows) leaves timers, a relay thread and pipes behind when a shell is killed,
 * and each one keeps the thread that owns the shell alive. On the terminal host that thread is the
 * pty worker, and host shutdown waits for it to exit, so every leftover became shutdown latency:
 * measured ~6 s on ConPTY and never-on-its-own on winpty (the host's forced-exit deadline ended it).
 * These two hooks release what node-pty keeps; neither changes what gets killed.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

type WindowsPtyAgent = {
  _useConpty?: boolean;
  _useConptyDll?: boolean;
  _innerPid?: number;
  _getConsoleProcessList?: () => Promise<number[]>;
  _flushDataAndCleanUp?: () => void;
  _conoutSocketWorker?: {
    _isDisposed?: boolean;
    _drainTimeout?: NodeJS.Timeout;
    _worker?: { terminate?: () => Promise<number> };
  };
  _inSocket?: { destroy?: () => void };
  _outSocket?: { destroy?: () => void };
};
type WindowsTerminal = { _isReady?: boolean; _agent?: WindowsPtyAgent };

/** node-pty's own deadline for a console-list agent that neither replies nor exits. */
const CONSOLE_LIST_TIMEOUT_MS = 5_000;

export type ForkConsoleListAgent = (shellPid: number) => ChildProcess;

function forkNodePtyAgent(shellPid: number): ChildProcess {
  const agentScript = path.join(path.dirname(require.resolve('node-pty')), 'conpty_console_list_agent');
  return fork(agentScript, [String(shellPid)]);
}

/**
 * ConPTY's `kill()` forks `lib/conpty_console_list_agent` to list the processes on the shell's
 * console, then closes that console in the same synchronous call. The agent attaches to the console
 * being closed and usually dies (exit code 1) before replying, but node-pty listens only for the
 * reply, so its 5 s fallback timer stays armed and holds the thread. Measured: every agent exited
 * within ~1.5 s of shutdown while the pty worker stayed up until each 5 s timer fired.
 *
 * The replacement keeps node-pty's protocol and fallback (the shell pid alone), settles as soon as
 * the agent is gone, and never holds a thread open itself.
 */
export function settleConsoleListOnAgentExit(child: unknown, forkAgent: ForkConsoleListAgent = forkNodePtyAgent): void {
  const agent = (child as WindowsTerminal | null)?._agent;
  if (!agent || agent._useConpty !== true || agent._useConptyDll || typeof agent._getConsoleProcessList !== 'function') return;
  agent._getConsoleProcessList = () => new Promise<number[]>((resolve) => {
    const shellOnly = [agent._innerPid ?? 0];
    let listAgent: ChildProcess;
    try {
      listAgent = forkAgent(shellOnly[0]!);
    } catch {
      resolve(shellOnly);
      return;
    }
    let settled = false;
    const settle = (list: number[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(list);
    };
    const timer = setTimeout(() => {
      try { listAgent.kill(); } catch {}
      settle(shellOnly);
    }, CONSOLE_LIST_TIMEOUT_MS);
    // The lookup is best-effort: an agent still starting when its thread is otherwise done (host
    // shutdown) is left to finish or fail on its own rather than keep the thread up.
    timer.unref?.();
    try { listAgent.unref(); } catch {}
    try { (listAgent.channel as { unref?: () => void } | null | undefined)?.unref?.(); } catch {}
    listAgent.on('message', (message: { consoleProcessList?: unknown }) => {
      const list = message?.consoleProcessList;
      settle(Array.isArray(list) ? list.filter((pid): pid is number => typeof pid === 'number') : shellOnly);
    });
    // 'close' follows the IPC channel's end, so a reply that was sent is always delivered first.
    listAgent.on('close', () => settle(shellOnly));
    listAgent.on('error', () => settle(shellOnly));
  });
}

/**
 * Releases what node-pty keeps after a kill or an exit: its output relay thread and both console
 * pipes (winpty's kill releases none of them - measured one MessagePort + one PipeWrap per shell
 * still held after shutdown), the relay's 1 s drain timer, and ConPTY's 1 s post-exit flush timer
 * (measured one Timeout per shell holding the worker 1 s past the last kill). Output after a kill
 * has no reader, and an exit is reported only once the output pipe has closed, so nothing readable
 * is dropped. A terminal that never became ready still has node-pty's kill queued behind its first
 * output, so its handles stay with it rather than strand that kill.
 */
export function releaseAgentHandles(child: unknown): void {
  const owner = child as WindowsTerminal | null;
  const agent = owner?._agent;
  if (!agent || owner._isReady === false) return;
  const relay = agent._conoutSocketWorker;
  if (relay) {
    relay._isDisposed = true;
    if (relay._drainTimeout) clearTimeout(relay._drainTimeout);
    try { relay._worker?.terminate?.()?.catch(() => 0); } catch {}
  }
  try { agent._inSocket?.destroy?.(); } catch {}
  try { agent._outSocket?.destroy?.(); } catch {}
  // The flush only ever ends in destroying the output socket, which is done above.
  if (typeof agent._flushDataAndCleanUp === 'function') agent._flushDataAndCleanUp = () => {};
}
