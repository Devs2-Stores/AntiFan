import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveRunSummary } from '../terminal-daemon/protocol';
import type { TerminalRunStateFile } from './run-state-service';

// The terminal-host daemon loads this module, and its staged bundle ships only the static import
// closure of daemon-entry. run-state-service.ts and bridge-health.ts are deliberately NOT imported
// at runtime: bridge-health lazily requires bridge-server, which would drag the whole GUI bridge into
// the host. The two values below therefore mirror them, and live-runs-guard.test.ts compares this
// module with `readTerminalRunSnapshot` over a grid of run files so the two cannot drift apart.
/** = RUN_STALE_MS in run-state-service.ts. */
const RUN_STALE_MS = 45_000;
const PROMPT_HEAD_MAX = 80;

/** = isPidAlive in bridge-health.ts: only ESRCH (or a nonsense pid) means gone. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return !(err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH');
  }
}

export interface LiveRunsOptions {
  isProcessAlive?: (pid: number) => boolean;
  clock?: () => number;
  staleMs?: number;
  /** terminalSessionIds whose live run the owner approved ending (e.g. the session that schedules the restart). They do not block; every other live run does. */
  allowRuns?: readonly string[];
}

/**
 * The OMP runs a terminal-host shutdown would cut: every `<runsDir>/*.json` whose state is not
 * `ended`, whose pid is alive and whose heartbeat is not older than `staleMs` (the rule of
 * `classifyRunLiveness`, which turns a run `ended` + `stale` otherwise). An unreadable or non-schema-1
 * file is not a run.
 */
export function listLiveRuns(runsDir: string, options: LiveRunsOptions = {}): LiveRunSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const now = (options.clock ?? Date.now)();
  const staleMs = options.staleMs ?? RUN_STALE_MS;
  const alive = options.isProcessAlive ?? pidAlive;
  const live: LiveRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.brief.json')) continue;
    let data: Partial<TerminalRunStateFile> | null;
    try {
      data = JSON.parse(fs.readFileSync(path.join(runsDir, entry), 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object' || data.schema !== 1 || !data.terminalSessionId) continue;
    const state = typeof data.state === 'string' ? data.state : 'idle';
    if (state === 'ended' || options.allowRuns?.includes(data.terminalSessionId)) continue;
    const pid = typeof data.pid === 'number' ? data.pid : 0;
    const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
    if (pid <= 0 || !alive(pid) || now - updatedAt > staleMs) continue;
    live.push({
      terminalSessionId: data.terminalSessionId,
      pid,
      state,
      ompSessionId: typeof data.ompSessionId === 'string' && data.ompSessionId ? data.ompSessionId : undefined,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      promptHead: typeof data.promptHead === 'string' ? data.promptHead.slice(0, PROMPT_HEAD_MAX) : undefined,
      lastEventAt: typeof data.lastEventAt === 'number' ? data.lastEventAt : undefined,
    });
  }
  return live.sort((a, b) => a.terminalSessionId.localeCompare(b.terminalSessionId, undefined, { numeric: true }));
}
