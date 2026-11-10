import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { leaderRunsDir } from './leader-runtime';

/**
 * The Worker board's job rows: for each Leader terminal, the Leader jobs it drives (round, state,
 * worker silence, report status, whether the job needs the person).
 *
 * The rows come from `scripts/leader/board.mjs` (`buildBoard`), the same derivation `leader-job.mjs
 * needs-me` prints, loaded with a real dynamic `import()`. The repo already loads uncompiled `.mjs`
 * scripts this way (`scripts/lib/theme-checks.mjs` in the capability layer) and `module: nodenext`
 * keeps `import()` native in the CommonJS output, so there is one implementation of the row
 * derivation instead of a second copy that can drift from the CLI.
 */

/** One job row, as `buildBoard` returns it. Every additive key may be absent or null. */
export interface LeaderJobRow {
  job: string;
  state: string;
  ageHours?: number;
  rounds?: number;
  blocking?: string;
  needsMe?: boolean;
  stale?: boolean;
  deadWhy?: string | null;
  round?: number | null;
  kind?: string | null;
  roundsUsed?: number;
  worker?: string | null;
  runState?: string | null;
  silentMin?: number | null;
  lastTool?: string | null;
  workerAlive?: boolean | null;
  reportStatus?: string | null;
  /** The Leader terminal the job belongs to; present when the board lists every Leader. */
  leader?: string | null;
}

export type LeaderJobsBoard = Record<string, LeaderJobRow[]>;

interface BoardModule {
  /** With `leader` omitted the board lists every Leader's jobs and each row names its Leader in `leader`. */
  buildBoard(options: {
    jobsRoot: string;
    runsDir?: string;
    leader?: string | null;
    now?: number;
    includeClosed?: boolean;
  }): { rows?: unknown };
}

const DEFAULT_JOBS_ROOT = 'E:/Work/scratch/leader';
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]+$/;
/** Rows kept per Leader and Leaders answered per call: the board is a glance, not an archive. */
const MAX_ROWS_PER_LEADER = 40;
const MAX_LEADERS = 32;

type Env = NodeJS.ProcessEnv;

/** Same override and default as the hook and the ledger CLI. */
export function leaderJobsRoot(env: Env = process.env): string {
  const override = env.LEADER_JOBS_ROOT?.trim();
  return path.resolve(override && override.length > 0 ? override : DEFAULT_JOBS_ROOT);
}

/** `LEADER_RUNS_DIR` wins, as in the scripts; otherwise the app's own runtime runs folder. */
function runsDirOf(env: Env): string {
  const override = env.LEADER_RUNS_DIR?.trim();
  return override ? path.resolve(override) : leaderRunsDir();
}

function resolveBoardScript(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'scripts', 'leader', 'board.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let boardModule: Promise<BoardModule | null> | undefined;

function loadBoardModule(): Promise<BoardModule | null> {
  if (!boardModule) {
    boardModule = (async () => {
      const script = resolveBoardScript();
      if (!script) return null;
      const loaded = (await import(pathToFileURL(script).href)) as Partial<BoardModule>;
      return typeof loaded.buildBoard === 'function' ? (loaded as BoardModule) : null;
    })().catch(() => null);
  }
  return boardModule;
}

function isRow(value: unknown): value is LeaderJobRow {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { job?: unknown; state?: unknown };
  return typeof candidate.job === 'string' && typeof candidate.state === 'string';
}

/**
 * Job rows per Leader terminal id, needs-me first (`buildBoard`'s own order). Never throws: a missing
 * jobs root has no rows, a broken `job.json` is skipped by `buildBoard`, and an id that is not a
 * plain terminal id is left out. Closed jobs are not listed. The ledger is read once per call for
 * every Leader (one folder listing, one `job.json` per job, then the run file and the first bytes
 * of the report of each open job) and the rows are grouped here, so the cost does not grow with
 * the number of Leaders.
 */
export async function readLeaderJobsBoard(
  options: { leaders: readonly string[]; now?: number; env?: Env },
): Promise<LeaderJobsBoard> {
  const out: LeaderJobsBoard = {};
  const env = options.env ?? process.env;
  const leaders = Array.from(new Set(options.leaders))
    .filter((id): id is string => typeof id === 'string' && TERMINAL_ID_RE.test(id))
    .slice(0, MAX_LEADERS);
  if (leaders.length === 0) return out;
  const board = await loadBoardModule();
  if (!board) return out;
  for (const leader of leaders) out[leader] = [];
  let rows: unknown[];
  try {
    const result = board.buildBoard({ jobsRoot: leaderJobsRoot(env), runsDir: runsDirOf(env), now: options.now ?? Date.now(), includeClosed: false });
    rows = Array.isArray(result?.rows) ? result.rows : [];
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!isRow(row)) continue;
    // Own keys only: a job.json naming a Leader such as "constructor" must not reach Object.prototype.
    const list = typeof row.leader === 'string' && Object.hasOwn(out, row.leader) ? out[row.leader] : undefined;
    if (list && list.length < MAX_ROWS_PER_LEADER) list.push(row);
  }
  return out;
}
