/**
 * AntiFan Core — Health Surface Service (Phase 6, items 11-15, 28, 29)
 *
 * Aggregates Super Core state through the existing CLI surface
 * (scripts/antifan-core.cjs) — never a second store, never invented metrics.
 *
 * Contract (R1): every status carries `reasonCode` + `affected`. A degraded
 * state reports DEGRADED, never a confident-looking percentage. Unknowns are
 * surfaced explicitly, never hidden.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IssueRegister } from '../session/issue-register';
import { ProcessRegistry } from '../process/process-registry';

export type CoreHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CoreHealthCheck {
  name: string;
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  detail?: string;
}

export interface CoreHealthSnapshot {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  checkedAt: string;
  checks: CoreHealthCheck[];
  stats?: Record<string, number>;
  audit?: Record<string, unknown>;
  decay?: { stale: number; aging: number; cutoff?: string };
  uncertainty?: { level: string; reason: string };
  openIssues?: { total: number; p0: number; p1: number };
}

export interface BridgeEvent {
  event: string;
  reason?: string;
  taskHash?: string;
  projectRoot?: string;
  ts?: string | number;
  [key: string]: unknown;
}

export interface BridgeState {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  coreReachable: boolean;
  telemetryFound: boolean;
  telemetryPaths: string[];
  failures: BridgeEvent[];
  recentPacks: Array<Record<string, unknown>>;
  unknowns: string[];
}

export interface TaskRunListState {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  taskRunsTable: boolean;
  taskRuns: Array<Record<string, unknown>>;
  packs: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
}

export interface TaskRunTrace {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  kind?: 'pack' | 'case' | 'task-run';
  pack?: Record<string, unknown>;
  claims?: Array<Record<string, unknown>>;
  receipts?: Array<Record<string, unknown>>;
  case?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  taskRun?: Record<string, unknown>;
}

export interface RootCauseGroup {
  key: string;
  issueClass: string;
  count: number;
  worstSeverity: string;
  affected: string[];
  latestIssueId: string;
  latestMessage: string;
  workaround?: string;
}

export interface RootCauseState {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  groups: RootCauseGroup[];
  openTotal: number;
}

export interface RegressionState {
  status: CoreHealthStatus;
  reasonCode: string;
  affected: string[];
  evidenceRefs: string[];
  replayEngineAvailable: boolean;
  rows: Array<Record<string, unknown>>;
}

export interface CoreHealthState {
  snapshot: CoreHealthSnapshot;
  bridge: BridgeState;
  taskRuns: TaskRunListState;
  rootCauses: RootCauseState;
  regressions: RegressionState;
}

export interface CoreHealthServiceOptions {
  /** Absolute path to scripts/antifan-core.cjs. Defaults to repo-root resolution. */
  scriptPath?: string;
  /** Repo root (holds .super-core/core.db and .canary/). */
  repoRoot?: string;
  /** Additional project roots scanned for .canary/core-bridge/events.jsonl. */
  projectRoots?: string[];
  /** Injectable runner for tests: (command, arg) => parsed JSON. Throw = unavailable. */
  runCli?: (command: string, arg?: string) => unknown;
  /** Injectable issue register for tests. */
  issueRegister?: Pick<IssueRegister, 'list' | 'summarizeOpen'>;
  /** Per-spawn timeout in ms. */
  timeoutMs?: number;
}

interface HealthCliResult {
  stats: Record<string, number>;
  audit: Record<string, unknown>;
  decay: { stale?: Array<{ claimId?: string }>; aging?: Array<{ claimId?: string }>; cutoff?: string };
  gates: Record<string, { passed?: boolean; detail?: string; gateId?: string }>;
  uncertainty: { level?: string; reason?: string };
}

const STATUS_RANK: Record<CoreHealthStatus, number> = {
  UNAVAILABLE: 3,
  DEGRADED: 2,
  UNKNOWN: 1,
  HEALTHY: 0,
};

function worstOf(checks: CoreHealthCheck[]): Pick<CoreHealthSnapshot, 'status' | 'reasonCode' | 'affected' | 'evidenceRefs'> {
  let worst: CoreHealthCheck | undefined;
  for (const c of checks) {
    if (!worst || STATUS_RANK[c.status] > STATUS_RANK[worst.status]) worst = c;
  }
  if (!worst || worst.status === 'HEALTHY') {
    return { status: 'HEALTHY', reasonCode: 'ALL_GATES_PASSED', affected: [], evidenceRefs: checks.flatMap((c) => c.evidenceRefs) };
  }
  return {
    status: worst.status,
    reasonCode: worst.reasonCode,
    affected: [...new Set(checks.filter((c) => c.status !== 'HEALTHY').flatMap((c) => c.affected))].slice(0, 50),
    evidenceRefs: checks.flatMap((c) => c.evidenceRefs),
  };
}

function gateCheck(name: string, gate: { passed?: boolean; detail?: string; gateId?: string } | undefined, opts: {
  failCode: string;
  unknownCode?: string;
  unknownWhen?: (detail: string) => boolean;
}): CoreHealthCheck {
  const evidenceRefs = gate?.gateId ? [`phase_gates:${gate.gateId}`] : [];
  const detail = gate?.detail ?? 'gate did not run';
  if (!gate) {
    return { name, status: 'UNKNOWN', reasonCode: 'GATE_MISSING', affected: [], evidenceRefs, detail };
  }
  if (gate.passed) {
    return { name, status: 'HEALTHY', reasonCode: 'GATE_PASSED', affected: [], evidenceRefs, detail };
  }
  if (opts.unknownWhen && opts.unknownWhen(detail)) {
    return { name, status: 'UNKNOWN', reasonCode: opts.unknownCode ?? 'GATE_INCONCLUSIVE', affected: [detail], evidenceRefs, detail };
  }
  return { name, status: 'DEGRADED', reasonCode: opts.failCode, affected: [detail], evidenceRefs, detail };
}

/** Walk up from a starting dir until scripts/antifan-core.cjs is found. */
export function resolveRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'antifan-core.cjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the compiled-layout assumption (.compiled/src/main/<dir>).
  return path.resolve(startDir, '..', '..', '..', '..');
}

export class CoreHealthService {
  private readonly scriptPath: string;
  private readonly repoRoot: string;
  private readonly projectRoots: string[];
  private readonly timeoutMs: number;
  private readonly runner?: (command: string, arg?: string) => unknown;
  private readonly issues: Pick<IssueRegister, 'list' | 'summarizeOpen'>;

  constructor(options: CoreHealthServiceOptions = {}) {
    this.repoRoot = options.repoRoot ?? resolveRepoRoot(__dirname);
    this.scriptPath = options.scriptPath ?? path.join(this.repoRoot, 'scripts', 'antifan-core.cjs');
    this.projectRoots = options.projectRoots ?? [this.repoRoot];
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.runner = options.runCli;
    this.issues = options.issueRegister ?? IssueRegister.getInstance();
  }

  /** Run one CLI command; rejects on any failure (caller maps to UNAVAILABLE).
   * Async spawn — never blocks the main-process event loop. */
  private async cli<T = unknown>(command: string, arg?: string): Promise<T> {
    if (this.runner) return this.runner(command, arg) as T;
    const args = [this.scriptPath, command];
    if (arg !== undefined) args.push(arg);
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: this.repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
      if (child.pid) {
        ProcessRegistry.getInstance().register({
          pid: child.pid,
          owner: 'core-health',
          name: command,
          command: args.join(' '),
          processRef: child,
        });
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        if (child.pid) {
          void ProcessRegistry.getInstance().kill(child.pid);
        } else {
          child.kill('SIGKILL');
        }
      }, this.timeoutMs);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', (error) => {
        if (child.pid) {
          ProcessRegistry.getInstance().unregister(child.pid);
        }
        clearTimeout(timer);
        resolve({ status: null, stdout, stderr, error });
      });
      child.on('close', (status) => {
        if (child.pid) {
          ProcessRegistry.getInstance().unregister(child.pid, status);
        }
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = res.stderr.trim();
      // The CLI reports a missing store as JSON on stderr with exit 2.
      let reason: string | undefined;
      try {
        const parsed: unknown = JSON.parse(stderr);
        if (parsed && typeof parsed === 'object' && 'reason' in parsed && typeof parsed.reason === 'string') {
          reason = parsed.reason;
        }
      } catch { /* not JSON — fall through to raw stderr */ }
      throw new Error(reason || stderr || `antifan-core ${command} exited ${res.status}`);
    }
    return JSON.parse(res.stdout) as T;
  }

  private unavailable<T extends { status: CoreHealthStatus; reasonCode: string; affected: string[]; evidenceRefs: string[] }>(
    base: T, err: unknown,
  ): T {
    base.status = 'UNAVAILABLE';
    base.reasonCode = 'CORE_UNAVAILABLE';
    base.affected = [String(err instanceof Error ? err.message : err)];
    return base;
  }

  // ---- item 11/12: Core Health service + snapshot ---------------------------

  async getSnapshot(): Promise<CoreHealthSnapshot> {
    let health: HealthCliResult;
    try {
      health = await this.cli<HealthCliResult>('health');
    } catch (err) {
      return {
        status: 'UNAVAILABLE',
        reasonCode: 'CORE_UNAVAILABLE',
        affected: [String(err instanceof Error ? err.message : err)],
        evidenceRefs: [`cli:${this.scriptPath}`],
        checkedAt: new Date().toISOString(),
        checks: [],
      };
    }

    const stats = health.stats ?? {};
    const gates = health.gates ?? {};
    const checks: CoreHealthCheck[] = [];

    checks.push({
      name: 'core.store',
      status: 'HEALTHY',
      reasonCode: 'STORE_REACHABLE',
      affected: [],
      evidenceRefs: ['cli:health'],
      detail: `${stats.artifacts ?? 0} artifacts, ${stats.claims ?? 0} claims, ${stats.evidence ?? 0} evidence anchors`,
    });

    checks.push(gateCheck('core.coverage', gates.coverage, {
      failCode: 'GATE_FAILED:COVERAGE',
      unknownCode: 'EMPTY_STORE',
      unknownWhen: () => (stats.artifacts ?? 0) === 0,
    }));
    checks.push(gateCheck('core.evidence', gates.evidence, { failCode: 'GATE_FAILED:EVIDENCE' }));
    checks.push(gateCheck('core.conflicts', gates.conflict, { failCode: 'UNRESOLVED_CONFLICTS' }));

    const staleCount = (health.decay?.stale?.length ?? 0) + (health.decay?.aging?.length ?? 0);
    const temporalGate = gates.temporal;
    if ((temporalGate && !temporalGate.passed) || staleCount > 0) {
      const staleIds = [
        ...(health.decay?.stale ?? []).map((c) => c.claimId ?? 'unknown'),
        ...(health.decay?.aging ?? []).map((c) => c.claimId ?? 'unknown'),
      ].slice(0, 10);
      checks.push({
        name: 'core.freshness',
        status: 'DEGRADED',
        reasonCode: 'STALE_CLAIMS',
        affected: staleIds.length ? staleIds : [temporalGate?.detail ?? `${staleCount} stale/aging claims`],
        evidenceRefs: temporalGate?.gateId ? [`phase_gates:${temporalGate.gateId}`] : ['cli:decay'],
        detail: temporalGate?.detail ?? `${staleCount} stale/aging claims`,
      });
    } else {
      checks.push({
        name: 'core.freshness',
        status: 'HEALTHY',
        reasonCode: 'GATE_PASSED',
        affected: [],
        evidenceRefs: temporalGate?.gateId ? [`phase_gates:${temporalGate.gateId}`] : [],
        detail: temporalGate?.detail,
      });
    }

    checks.push(gateCheck('core.promotion', gates.promotion, { failCode: 'PENDING_CANDIDATES' }));
    checks.push(gateCheck('core.regression', gates.regression, {
      failCode: 'REGRESSION_FAILED',
      unknownCode: 'NO_REGRESSION_RUN',
      unknownWhen: (d) => d === 'no regression run',
    }));

    const uncertainty = health.uncertainty ?? {};
    if (uncertainty.level === 'CONFLICTED') {
      checks.push({ name: 'core.uncertainty', status: 'DEGRADED', reasonCode: 'CONFLICTED_CLAIMS', affected: [uncertainty.reason ?? 'conflicted'], evidenceRefs: ['cli:uncertainty'], detail: uncertainty.reason });
    } else if (uncertainty.level === 'UNKNOWN') {
      checks.push({ name: 'core.uncertainty', status: 'UNKNOWN', reasonCode: 'INSUFFICIENT_EVIDENCE', affected: [uncertainty.reason ?? 'unknown'], evidenceRefs: ['cli:uncertainty'], detail: uncertainty.reason });
    } else {
      checks.push({ name: 'core.uncertainty', status: 'HEALTHY', reasonCode: uncertainty.level || 'SUPPORTED', affected: [], evidenceRefs: ['cli:uncertainty'], detail: uncertainty.reason });
    }

    const open = this.issues.list({ status: 'OPEN' });
    const p0 = open.filter((i) => i.severity === 'P0');
    const p1 = open.filter((i) => i.severity === 'P1');
    if (p0.length + p1.length > 0) {
      checks.push({
        name: 'issues.open',
        status: 'DEGRADED',
        reasonCode: 'OPEN_HIGH_SEVERITY_ISSUES',
        affected: [...p0, ...p1].slice(0, 10).map((i) => `${i.id}:${i.errorCode || i.toolName}`),
        evidenceRefs: ['issue-register:open'],
        detail: `${p0.length} P0 + ${p1.length} P1 open issues`,
      });
    } else {
      checks.push({
        name: 'issues.open',
        status: 'HEALTHY',
        reasonCode: 'NO_HIGH_SEVERITY_ISSUES',
        affected: [],
        evidenceRefs: ['issue-register:open'],
        detail: `${open.length} open issue(s), none above P1`,
      });
    }

    const overall = worstOf(checks);
    return {
      ...overall,
      checkedAt: new Date().toISOString(),
      checks,
      stats,
      audit: health.audit,
      decay: { stale: health.decay?.stale?.length ?? 0, aging: health.decay?.aging?.length ?? 0, cutoff: health.decay?.cutoff },
      uncertainty: { level: uncertainty.level ?? 'UNKNOWN', reason: uncertainty.reason ?? 'no result' },
      openIssues: { total: open.length, p0: p0.length, p1: p1.length },
    };
  }

  // ---- item 14: Bridge UI ----------------------------------------------------
  // Bridge telemetry lands in <projectRoot>/.canary/core-bridge/events.jsonl
  // (one BRIDGE_CONTEXT_FAILED per session, deduped — Phase 3 contract). The
  // hook runs inside the OMP agent process and cannot reach IssueRegister, so
  // this surface reads the JSONL directly and reports honestly when absent.

  async getBridgeState(): Promise<BridgeState> {
    const state: BridgeState = {
      status: 'UNKNOWN',
      reasonCode: 'BRIDGE_TELEMETRY_MISSING',
      affected: [],
      evidenceRefs: [],
      coreReachable: false,
      telemetryFound: false,
      telemetryPaths: [],
      failures: [],
      recentPacks: [],
      unknowns: [
        'pack injection rate per agent turn — not measurable from this surface',
        'packId stability across session.compacting — needs a live OMP session',
      ],
    };

    try {
      await this.cli('stats');
      state.coreReachable = true;
      state.evidenceRefs.push('cli:stats');
    } catch (err) {
      state.status = 'UNAVAILABLE';
      state.reasonCode = 'CORE_UNAVAILABLE';
      state.affected = [String(err instanceof Error ? err.message : err)];
      return state;
    }

    try {
      const runs = await this.cli<{ packs?: Array<Record<string, unknown>> }>('task-runs', JSON.stringify({ limit: 10 }));
      state.recentPacks = runs.packs ?? [];
      state.evidenceRefs.push('cli:task-runs');
    } catch {
      state.unknowns.push('recent pack list unavailable (task-runs command failed)');
    }

    const events: BridgeEvent[] = [];
    for (const root of this.projectRoots) {
      const file = path.join(root, '.canary', 'core-bridge', 'events.jsonl');
      if (!fs.existsSync(file)) continue;
      state.telemetryFound = true;
      state.telemetryPaths.push(file);
      try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === 'object') events.push(parsed as BridgeEvent);
          } catch {
            state.unknowns.push(`unparseable bridge event line in ${file}`);
          }
        }
      } catch (err) {
        state.unknowns.push(`cannot read ${file}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }

    state.failures = events.filter((e) => e.event === 'BRIDGE_CONTEXT_FAILED');
    state.evidenceRefs.push(...state.telemetryPaths);

    if (state.failures.length > 0) {
      state.status = 'DEGRADED';
      state.reasonCode = 'BRIDGE_CONTEXT_FAILED';
      state.affected = state.failures.slice(0, 10).map((f) => `${f.event}${f.taskHash ? `:${f.taskHash}` : ''}${f.reason ? ` (${f.reason})` : ''}`);
    } else if (!state.telemetryFound) {
      state.status = 'UNKNOWN';
      state.reasonCode = 'BRIDGE_TELEMETRY_MISSING';
      state.affected = this.projectRoots.map((r) => path.join(r, '.canary', 'core-bridge', 'events.jsonl'));
    } else {
      state.status = 'HEALTHY';
      state.reasonCode = 'NO_BRIDGE_FAILURES';
      state.affected = [];
    }
    return state;
  }

  // ---- item 15: Task Run trace ------------------------------------------------

  async listTaskRuns(): Promise<TaskRunListState> {
    const state: TaskRunListState = {
      status: 'UNKNOWN',
      reasonCode: 'NO_TASK_RUNS',
      affected: [],
      evidenceRefs: ['cli:task-runs'],
      taskRunsTable: false,
      taskRuns: [],
      packs: [],
      cases: [],
    };
    try {
      const out = await this.cli<{
        taskRunsTable?: boolean;
        taskRuns?: Array<Record<string, unknown>>;
        packs?: Array<Record<string, unknown>>;
        cases?: Array<Record<string, unknown>>;
      }>('task-runs', JSON.stringify({ limit: 50 }));
      state.taskRunsTable = Boolean(out.taskRunsTable);
      state.taskRuns = out.taskRuns ?? [];
      state.packs = out.packs ?? [];
      state.cases = out.cases ?? [];
      const total = state.taskRuns.length + state.packs.length + state.cases.length;
      if (total > 0) {
        state.status = 'HEALTHY';
        state.reasonCode = 'TASK_RUNS_PRESENT';
      } else {
        state.status = 'UNKNOWN';
        state.reasonCode = 'NO_TASK_RUNS';
        state.affected = ['no packs, cases, or task_runs rows in the Core store'];
      }
      return state;
    } catch (err) {
      return this.unavailable(state, err);
    }
  }

  async getTaskRunTrace(id: string): Promise<TaskRunTrace> {
    const base: TaskRunTrace = {
      status: 'UNKNOWN',
      reasonCode: 'TASK_RUN_NOT_FOUND',
      affected: [id],
      evidenceRefs: [],
    };
    try {
      if (id.startsWith('pack-')) {
        const out = await this.cli<{ error?: string; pack?: Record<string, unknown>; claims?: Array<Record<string, unknown>>; receipts?: Array<Record<string, unknown>> }>('pack-detail', id);
        if (out.error || !out.pack) return { ...base, evidenceRefs: ['cli:pack-detail'] };
        return {
          status: 'HEALTHY',
          reasonCode: 'TRACE_FOUND',
          affected: [id],
          evidenceRefs: ['cli:pack-detail', `packs:${id}`],
          kind: 'pack',
          pack: out.pack,
          claims: out.claims ?? [],
          receipts: out.receipts ?? [],
        };
      }
      if (id.startsWith('case-')) {
        const out = await this.cli<{ error?: string; case?: Record<string, unknown>; candidates?: Array<Record<string, unknown>> }>('case-detail', id);
        if (out.error || !out.case) return { ...base, evidenceRefs: ['cli:case-detail'] };
        return {
          status: 'HEALTHY',
          reasonCode: 'TRACE_FOUND',
          affected: [id],
          evidenceRefs: ['cli:case-detail', `cases:${id}`],
          kind: 'case',
          case: out.case,
          candidates: out.candidates ?? [],
        };
      }
      // Generic task_runs row or unknown id shape — look it up in the list.
      const list = await this.listTaskRuns();
      const row = list.taskRuns.find((r) => Object.values(r).includes(id) || r.runId === id || r.taskRunId === id);
      if (row) {
        return {
          status: 'HEALTHY',
          reasonCode: 'TRACE_FOUND',
          affected: [id],
          evidenceRefs: ['cli:task-runs'],
          kind: 'task-run',
          taskRun: row,
        };
      }
      return { ...base, evidenceRefs: ['cli:task-runs'] };
    } catch (err) {
      return this.unavailable(base, err);
    }
  }

  // ---- item 28: Root cause UI --------------------------------------------------

  getRootCauses(): RootCauseState {
    const groups = this.issues.summarizeOpen();
    const openTotal = groups.reduce((n, g) => n + g.count, 0);
    const hasHigh = groups.some((g) => g.worstSeverity === 'P0' || g.worstSeverity === 'P1');
    return {
      status: openTotal === 0 ? 'HEALTHY' : hasHigh ? 'DEGRADED' : 'UNKNOWN',
      reasonCode: openTotal === 0 ? 'NO_OPEN_ISSUES' : hasHigh ? 'OPEN_HIGH_SEVERITY_ISSUES' : 'OPEN_ISSUES',
      affected: groups.slice(0, 10).map((g) => `${g.key} ×${g.count}`),
      evidenceRefs: ['issue-register:open'],
      groups,
      openTotal,
    };
  }

  // ---- item 29: Core regression UI ----------------------------------------------
  // The replay engine is owned by another workstream. The CLI reports
  // replayEngineAvailable; until it lands this surface reports UNKNOWN with
  // REPLAY_ENGINE_NOT_IMPLEMENTED — never PASS on an empty table.

  async getRegressions(): Promise<RegressionState> {
    const state: RegressionState = {
      status: 'UNKNOWN',
      reasonCode: 'REPLAY_ENGINE_NOT_IMPLEMENTED',
      affected: [],
      evidenceRefs: ['cli:regressions'],
      replayEngineAvailable: false,
      rows: [],
    };
    try {
      const out = await this.cli<{ replayEngineAvailable?: boolean; rows?: Array<Record<string, unknown>> }>('regressions');
      state.replayEngineAvailable = Boolean(out.replayEngineAvailable);
      state.rows = out.rows ?? [];
      if (!state.replayEngineAvailable) {
        state.status = 'UNKNOWN';
        state.reasonCode = 'REPLAY_ENGINE_NOT_IMPLEMENTED';
        state.affected = ['replay engine not present in packages/super-core — recorded rows shown read-only'];
        return state;
      }
      if (state.rows.length === 0) {
        state.status = 'UNKNOWN';
        state.reasonCode = 'NO_REGRESSION_RUNS';
        return state;
      }
      const last = state.rows[0];
      const lastResult = last && typeof last.replayResult === 'string' ? last.replayResult : undefined;
      const lastId = last && typeof last.regressionId === 'string' ? last.regressionId : 'latest regression';
      if (lastResult === 'PASS') {
        state.status = 'HEALTHY';
        state.reasonCode = 'LAST_REPLAY_PASSED';
      } else {
        state.status = 'DEGRADED';
        state.reasonCode = 'REGRESSION_FAILED';
        state.affected = [lastId];
      }
      return state;
    } catch (err) {
      return this.unavailable(state, err);
    }
  }

  // ---- aggregate ------------------------------------------------------------

  async getState(): Promise<CoreHealthState> {
    const [snapshot, bridge, taskRuns, regressions] = await Promise.all([
      this.getSnapshot(),
      this.getBridgeState(),
      this.listTaskRuns(),
      this.getRegressions(),
    ]);
    return { snapshot, bridge, taskRuns, rootCauses: this.getRootCauses(), regressions };
  }
}

let singleton: CoreHealthService | null = null;
export function getCoreHealthService(): CoreHealthService {
  if (!singleton) singleton = new CoreHealthService();
  return singleton;
}
