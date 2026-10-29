import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';
import { readTerminalRunSnapshot, type TerminalRunSnapshotOptions } from '../run/run-state-service';
import type { TerminalRunSnapshot } from '../../shared/contracts';
import { CapabilityError } from '../../shared/control-plane-contracts';

/** Where a Leader asked a worker terminal to be minted. */
export interface LeaderPlacementRequest {
  cwd: string;
  name?: string;
}

export type LeaderPlacementResult =
  | { ok: true; sessionId: string; ownerKey?: string; capsuleId?: string }
  | { ok: false; reason: string; message: string };

/**
 * The host half of `terminal.create` for a Leader: mint a BASE terminal in the project that owns
 * `cwd`, filed the way the Terminal Manager's "new terminal in folder" files it. The terminal
 * manager state lives in the native tab host, so the host installs this late and the capability
 * layer never imports it.
 */
export interface LeaderPlacementPort {
  placeTerminal(request: LeaderPlacementRequest): Promise<LeaderPlacementResult>;
}

interface RegisteredPort {
  port: LeaderPlacementPort;
  /** The shared Terminal Manager's own host: it owns no folder, so it is the preferred placer. */
  sharedManager: boolean;
}

const placementPorts: RegisteredPort[] = [];

/**
 * Install a host's placement port; the returned function removes exactly this registration. Several
 * windows each carry a host, so the shared Terminal Manager's wins when it is present and the most
 * recently installed one answers otherwise.
 */
export function registerLeaderPlacementPort(port: LeaderPlacementPort, options: { sharedManager?: boolean } = {}): () => void {
  const entry: RegisteredPort = { port, sharedManager: options.sharedManager === true };
  placementPorts.push(entry);
  return () => {
    const index = placementPorts.indexOf(entry);
    if (index >= 0) placementPorts.splice(index, 1);
  };
}

export function getLeaderPlacementPort(): LeaderPlacementPort | undefined {
  const shared = placementPorts.find((entry) => entry.sharedManager);
  return (shared ?? placementPorts[placementPorts.length - 1])?.port;
}

/** `<runtime dir>/runs`, resolved on every call so an isolated data root is honoured. */
export function leaderRunsDir(): string {
  return path.join(StorageLocations.getRuntimeDir(), 'runs');
}

/**
 * Remove every run file a terminal id left behind: its run snapshot, its brief and half-written
 * temporaries. A terminal minted for a Leader's worker must start with no history: the hook reads these
 * files by terminal id, and a daemon that predates the persisted id counters can reissue a closed id.
 */
export function clearRunFilesOf(terminalId: string): void {
  const dir = leaderRunsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name !== `${terminalId}.json` && name !== `${terminalId}.brief.json` && !name.startsWith(`${terminalId}.json.tmp-`) && !name.startsWith(`${terminalId}.brief.json.tmp-`)) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* a run file the hook holds open is rewritten by that hook anyway */ }
  }
}

/** One terminal's OMP run, or undefined when no hook ever wrote a run file for it. */
export function leaderRunSnapshot(terminalId: string, options?: TerminalRunSnapshotOptions): TerminalRunSnapshot | undefined {
  return readTerminalRunSnapshot(leaderRunsDir(), terminalId, options);
}

export interface RunSettledCriteria {
  /** The run counter the run must have reached. */
  minRunSeq?: number;
  /**
   * Only count a run whose last event is NEWER than this (epoch ms) and that has completed at least
   * one turn (`runSeq >= 1`): a leftover file of an earlier OMP, or a fresh session that has not yet
   * taken the prompt, is idle too but is not the answer to the input just written.
   */
  afterEventAt?: number;
}

/**
 * Whether a run has finished its turn: idle, parked on a question, or over (a dead or silent run
 * reads as ended), and past every criterion the caller set.
 */
export function isRunSettled(run: TerminalRunSnapshot, criteria: RunSettledCriteria = {}): boolean {
  if (typeof criteria.minRunSeq === 'number' && run.runSeq < criteria.minRunSeq) return false;
  if (typeof criteria.afterEventAt === 'number') {
    if (run.runSeq < 1) return false;
    if (typeof run.lastEventAt !== 'number' || run.lastEventAt <= criteria.afterEventAt) return false;
  }
  return run.state === 'idle' || run.state === 'waiting_user' || run.state === 'ended';
}

const RUN_POLL_MS = 500;

/**
 * Poll the terminal's run file until its run has settled. Rejects with `WAIT_TIMEOUT` at the
 * deadline and `WAIT_ABORTED` when the platform cancels the call. A missing run file keeps the wait
 * going: the hook may simply not have started in that terminal yet.
 */
export async function waitForRunSettled(
  terminalId: string,
  options: RunSettledCriteria & { timeoutMs: number; signal?: AbortSignal; pollMs?: number }
): Promise<TerminalRunSnapshot> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? RUN_POLL_MS;
  for (;;) {
    if (options.signal?.aborted) throw new CapabilityError('WAIT_ABORTED', 'Terminal wait aborted', { sessionId: terminalId });
    const run = leaderRunSnapshot(terminalId);
    if (run && isRunSettled(run, options)) return run;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CapabilityError(
        'WAIT_TIMEOUT',
        `Terminal "${terminalId}" did not reach run-idle within ${options.timeoutMs}ms`,
        { sessionId: terminalId, ...(run ? { run } : {}) }
      );
    }
    const { promise: slept, resolve } = Promise.withResolvers<void>();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(pollMs, remaining));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await slept;
  }
}
