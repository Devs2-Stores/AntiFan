/**
 * Sleeps agent terminals that have done nothing for half an hour.
 *
 * Every OMP agent keeps its process (hundreds of MB of private memory) for as long as its terminal
 * runs. With many projects open, finished agents idling at their prompt are what exhausts Windows
 * commit, and an exhausted system ends the terminal daemon that holds every shell (02/11/2026).
 * `sleepSession` releases the shell and its whole process tree and keeps the transcript, so a
 * finished agent costs nothing until the user comes back to it.
 *
 * A terminal is slept only when all of these hold, so work in progress is never cut:
 * - its agent's run file says `idle` (the turn ended; `running` and an unanswered `waiting_user`
 *   never qualify), the agent process is alive, and its last event is at least `afterMs` old;
 * - no PTY output reached Main for `afterMs` (counted from this process's start, never assumed);
 * - it is a base terminal that is neither a Leader nor the worker of a live Leader (a Leader may
 *   still send the next round into its worker, and that input must reach the agent, not a shell);
 * - every running split pane qualifies on its own: sleep takes the panes with the tab, so each one
 *   must be quiet and run an agent that is idle as well. A running pane without an agent run (a
 *   shell the user or an agent left open, possibly a silent dev server) keeps the whole tab awake.
 * `sleepSession` still refuses watcher terminals (`idlePolicy: 'never'`), and a terminal without an
 * agent run (a plain shell, a dev server that logs nothing) is never touched.
 */
import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';
import { LeaderRegistry } from '../leader/leader-registry';

export const IDLE_SLEEP_AFTER_MS = 30 * 60_000;
export const IDLE_SLEEP_SWEEP_MS = 60_000;

export interface IdleSleepSession {
  id: string;
  state?: string;
  splitOf?: string;
  idlePolicy?: string;
}

export interface IdleSleepRun {
  terminalSessionId: string;
  state: string;
  stale: boolean;
  lastEventAt?: number;
}

export interface IdleSleepFacts {
  now: number;
  sessions: readonly IdleSleepSession[];
  runs: readonly IdleSleepRun[];
  /** When the last PTY output of the session reached Main (or when watching began). */
  lastOutputAt: (sessionId: string) => number;
  isLeader: (sessionId: string) => boolean;
  drivenByLiveLeader: (sessionId: string) => boolean;
  afterMs?: number;
}

/** The base terminals to put to sleep now, each with how long it has been idle. */
export function selectIdleTerminals(facts: IdleSleepFacts): Array<{ id: string; idleMs: number }> {
  const afterMs = facts.afterMs ?? IDLE_SLEEP_AFTER_MS;
  const runById = new Map(facts.runs.map((run) => [run.terminalSessionId, run]));
  const runIdleMs = (run: IdleSleepRun): number | null =>
    run.state === 'idle' && !run.stale && typeof run.lastEventAt === 'number' ? facts.now - run.lastEventAt : null;
  const paneMaySleep = (pane: IdleSleepSession): boolean => {
    if (pane.idlePolicy === 'never' || facts.isLeader(pane.id) || facts.drivenByLiveLeader(pane.id)) return false;
    if (facts.now - facts.lastOutputAt(pane.id) < afterMs) return false;
    const run = runById.get(pane.id);
    // A pane with no agent run may be a dev server or a watcher that logs nothing; sleeping the
    // tab would kill it, so its tab stays awake.
    if (!run) return false;
    const idle = runIdleMs(run);
    return idle !== null && idle >= afterMs;
  };

  const picked: Array<{ id: string; idleMs: number }> = [];
  for (const base of facts.sessions) {
    if (base.splitOf || base.state !== 'running') continue;
    const run = runById.get(base.id);
    if (!run) continue;
    const idle = runIdleMs(run);
    if (idle === null || idle < afterMs) continue;
    if (!paneMaySleep(base)) continue;
    const panes = facts.sessions.filter((s) => s.splitOf === base.id && s.state === 'running');
    if (!panes.every(paneMaySleep)) continue;
    picked.push({ id: base.id, idleMs: Math.min(idle, facts.now - facts.lastOutputAt(base.id)) });
  }
  return picked;
}

export interface IdleSleepTerminal {
  listSessions(): IdleSleepSession[];
  sleepSession(id: string): { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  on(event: 'data', listener: (evt: { sessionId?: string }) => void): unknown;
  off(event: 'data', listener: (evt: { sessionId?: string }) => void): unknown;
}

/** Starts the sweep; returns a stop function. */
export function startIdleTerminalSleep(deps: {
  terminal: IdleSleepTerminal;
  runs: () => readonly IdleSleepRun[];
  clock?: () => number;
}): () => void {
  const clock = deps.clock ?? Date.now;
  const watchedSince = clock();
  const lastOutput = new Map<string, number>();
  const onData = (evt: { sessionId?: string }): void => {
    if (evt && typeof evt.sessionId === 'string') lastOutput.set(evt.sessionId, clock());
  };
  deps.terminal.on('data', onData);
  const leaders = LeaderRegistry.getInstance();
  let sweeping = false;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      const sessions = deps.terminal.listSessions();
      const live = new Set(sessions.map((s) => s.id));
      for (const id of lastOutput.keys()) if (!live.has(id)) lastOutput.delete(id);
      const picked = selectIdleTerminals({
        now: clock(),
        sessions,
        runs: deps.runs(),
        lastOutputAt: (id) => lastOutput.get(id) ?? watchedSince,
        isLeader: (id) => leaders.isLeader(id),
        drivenByLiveLeader: (id) => {
          const record = leaders.workerOf(id);
          return record !== undefined && leaders.isLeader(record.leaderId);
        },
      });
      for (const { id, idleMs } of picked) {
        // Restart the clock whatever the answer, so a refused terminal is asked again only after
        // another full idle period rather than every sweep.
        lastOutput.set(id, clock());
        const result = await deps.terminal.sleepSession(id);
        recordLifecycleEvent(result.ok ? 'terminal.idleSleep' : 'terminal.idleSleepRefused', {
          sessionId: id,
          idleMs,
          ...(result.ok ? {} : { reason: result.reason }),
        });
      }
    } catch (err) {
      recordLifecycleEvent('terminal.idleSleepFailed', { error: String(err) });
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => { void sweep(); }, IDLE_SLEEP_SWEEP_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    deps.terminal.off('data', onData);
  };
}
