/**
 * Goal runner — the thin orchestrator an unattended run lives inside.
 *
 * Wiring only; every mechanism it composes is owned by a sibling module:
 * mutex + heartbeat from watchdog.mjs, atomic checkpoints from checkpoint.mjs,
 * the abort gate from health.mjs, criteria drift from drift.mjs, keep-awake from
 * keep-awake.mjs, artifact pruning from prune.mjs. The external supervisor
 * (supervisor.mjs, a separate process) watches the heartbeat this writes.
 *
 * Run model: a `spec` is `{ phases: [{ phaseId, items: [{ itemId, label?, run? }] }] }`.
 * Each item is one ladder unit. A unit's `run(ctx)` returns `{ verdict, ...receipt }`
 * with verdict in PASS | FAIL | NOT_IMPLEMENTED | BLOCKED; a missing `run` records
 * NOT_IMPLEMENTED, a throw records FAIL. The checkpoint is written after every
 * unit, so a kill loses at most the unit in flight.
 *
 * CLI: `node scripts/goal/runner.mjs <dir> --ladder <module.mjs> [--criteria <file>]
 *       [--run-id <id>] [--git-sha <sha>] [--heartbeat-ms N]`
 * The ladder module exports `spec` (named or default).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeRecordAtomic } from '../lib/atomic-record.mjs';
import {
  emptyCheckpoint,
  ladderUnit,
  nextUnit,
  readCheckpoint,
  recordUnitVerdict,
  writeCheckpoint,
} from './checkpoint.mjs';
import { detectDrift } from './drift.mjs';
import { createHealthMonitor } from './health.mjs';
import { startKeepAwake } from './keep-awake.mjs';
import { pruneRunArtifacts, isInside } from './prune.mjs';
import { THRESHOLDS, THRESHOLD_DIGEST } from './thresholds.mjs';
import {
  acquireRunnerMutex,
  isHeartbeatStale,
  releaseRunnerMutex,
  stampRunnerMutexRunId,
  startHeartbeat,
  writeHeartbeat,
} from './watchdog.mjs';

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'NOT_IMPLEMENTED', 'BLOCKED']);

/**
 * Anti-throttling flags every Electron/CDP child spawned by the run must carry —
 * the set the main app currently lacks (only scripts/test-clone-features.cjs:63-65
 * had them). A backgrounded renderer with throttled timers produces false stall
 * readings against the health bounds.
 */
export const ELECTRON_BACKGROUND_FLAGS = Object.freeze([
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]);

export function runSummaryPath(dir) {
  return path.join(dir, 'goal-run-summary.json');
}

export function worklogPath(dir) {
  return path.join(dir, 'goal-worklog.jsonl');
}

export function runArtifactsDir(dir) {
  return path.join(dir, 'artifacts');
}

function appendWorklog(dir, event) {
  try {
    fs.appendFileSync(worklogPath(dir), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch {}
}

/**
 * Merge the spec into the checkpoint ladder: spec order governs execution;
 * existing units keep their verdicts; judged units whose spec item vanished are
 * retained as evidence; unjudged orphans are dropped so they are never run.
 */
function mergeLadder(checkpoint, spec) {
  const existing = new Map(checkpoint.ladder.map((u) => [`${u.phaseId}/${u.itemId}`, u]));
  const kept = new Set();
  const ladder = [];
  for (const phase of spec.phases) {
    for (const item of phase.items) {
      const key = `${phase.phaseId}/${item.itemId}`;
      const unit = existing.get(key) ?? ladderUnit({ phaseId: phase.phaseId, itemId: item.itemId, label: item.label });
      kept.add(unit);
      ladder.push(unit);
    }
  }
  for (const u of checkpoint.ladder) {
    if (!kept.has(u) && u.verdict !== null) ladder.push(u);
  }
  checkpoint.ladder = ladder;
  return checkpoint;
}

function countVerdicts(ladder) {
  const counts = { PASS: 0, FAIL: 0, NOT_IMPLEMENTED: 0, BLOCKED: 0, pending: 0 };
  for (const u of ladder) counts[u.verdict ?? 'pending'] += 1;
  return counts;
}

/**
 * Run (or resume) the ladder in `dir`. Never throws for run-level outcomes —
 * returns `{ status: 'completed'|'aborted'|'refused', reason, detail, checkpoint }`.
 * 'refused' covers mutex-held and checkpoint-under-different-bounds; 'aborted' is
 * the health/drift/staleness gate; 'completed' means every unit was judged.
 */
export async function runGoal({
  dir,
  spec,
  runId,
  gitSha = null,
  criteria = null,
  heartbeatIntervalMs = THRESHOLDS.heartbeatIntervalMs,
  healthMonitor = null,
  keepAwake = startKeepAwake,
  onEvent,
} = {}) {

  const mutex = acquireRunnerMutex(dir);
  if (!mutex.acquired) {
    return { status: 'refused', reason: 'MUTEX_HELD', detail: `runner pid ${mutex.holderPid} holds the lock`, holderPid: mutex.holderPid, checkpoint: null };
  }

  let checkpoint = null;
  let status = 'completed';
  let reason = null;
  let detail = null;
  let stopHeartbeat = () => {};
  let stopKeepAwake = () => {};
  const hbState = { runId: null, phaseId: null, itemId: null, watchdogArmedAt: null, done: false };

  const abort = (r, d) => {
    status = 'aborted';
    reason = r;
    detail = d ?? null;
    hbState.abortReason = r;
    appendWorklog(dir, { type: 'abort', reason: r, detail: d ?? null });
    onEvent?.({ type: 'abort', reason: r, detail: d ?? null });
  };

  try {
    try {
      checkpoint = readCheckpoint(dir);
    } catch (err) {
      // The checkpoint exists but was written under different bounds — resuming
      // would silently weaken the run. Refuse, do not abort: nothing ran.
      return finish('refused', 'CHECKPOINT_REFUSED', String(err && err.message));
    }

    const fresh = !checkpoint;
    if (fresh) {
      checkpoint = emptyCheckpoint({ runId: runId ?? `run-${Date.now()}`, gitSha });
    }
    hbState.runId = checkpoint.runId;
    hbState.phaseId = checkpoint.phaseId;
    // Bind the lock to this run so a supervisor can attribute the heartbeat and
    // the lock to the same run instead of trusting whatever it finds on disk.
    stampRunnerMutexRunId(dir, checkpoint.runId);

    // Criteria baseline: the first run stores the snapshot; a resume compares and
    // a weakened snapshot is an abort, not a retry.
    let drift = null;
    if (criteria != null) {
      if (checkpoint.criteriaSnapshot == null) {
        checkpoint.criteriaSnapshot = criteria;
      } else {
        drift = detectDrift(checkpoint.criteriaSnapshot, criteria);
      }
    } else if (checkpoint.criteriaSnapshot != null) {
      // A resume that supplies no criteria cannot be allowed to skip the drift
      // check: the snapshot exists, so "no criteria this time" is exactly the
      // move that would bypass the weakened-criteria abort. Fail closed.
      return finish(
        'refused',
        'CRITERIA_MISSING',
        'checkpoint holds a criteria snapshot; resuming requires the criteria file that the snapshot was taken under',
      );
    }

    mergeLadder(checkpoint, spec);
    const health = healthMonitor ?? createHealthMonitor({ dir });
    const runMap = new Map();
    for (const phase of spec.phases) {
      for (const item of phase.items) runMap.set(`${phase.phaseId}/${item.itemId}`, item);
    }

    stopKeepAwake = keepAwake({ onEvent: (e) => onEvent?.({ type: 'keep-awake', ...e }) });
    // A failed lease refresh means this process is no longer the lock holder:
    // another runner reclaimed a lock it judged stale. Continuing would run two
    // ladders against one checkpoint, so the run stops instead.
    stopHeartbeat = startHeartbeat(dir, hbState, heartbeatIntervalMs, () =>
      abort('MUTEX_LOST', 'the runner lock is now held by another process'),
    );

    writeCheckpoint(dir, checkpoint);
    hbState.watchdogArmedAt = new Date().toISOString();
    writeHeartbeat(dir, hbState);
    appendWorklog(dir, { type: fresh ? 'run-start' : 'run-resume', runId: checkpoint.runId, counts: countVerdicts(checkpoint.ladder) });
    onEvent?.({ type: 'armed', runId: checkpoint.runId, resumed: !fresh });

    // The gate runs BEFORE refreshing the heartbeat: a stale file at that point
    // means the last write never landed (or was aged externally) — the run stops
    // rather than papering over a heartbeat the supervisor can no longer trust.
    const gate = () => {
      if (isHeartbeatStale(dir)) {
        return { abort: true, reason: 'HEARTBEAT_STALE', detail: 'heartbeat file is stale from inside the runner — writes are not landing' };
      }
      return health.checkHealth({ drift });
    };

    let unit;
    while (status === 'completed' && (unit = nextUnit(checkpoint))) {
      hbState.phaseId = unit.phaseId;
      hbState.itemId = unit.itemId;

      const pre = gate();
      if (pre.abort) {
        abort(pre.reason, pre.detail);
        break;
      }
      writeHeartbeat(dir, hbState);

      const item = runMap.get(`${unit.phaseId}/${unit.itemId}`);
      // Containment: phaseId/itemId come from the spec, and a `..` segment (or an
      // absolute id) would place the unit's directory outside the run. The
      // directory is recursively deleted on PASS, so leaving it unguarded turns a
      // spec typo into arbitrary recursive deletion.
      const artifactsRoot = path.resolve(runArtifactsDir(dir));
      const artifactDir = path.resolve(artifactsRoot, String(unit.phaseId), String(unit.itemId));
      if (!isInside(artifactsRoot, artifactDir)) {
        abort('ARTIFACT_DIR_ESCAPES_RUN', `${unit.phaseId}/${unit.itemId} resolves outside ${artifactsRoot}`);
        break;
      }
      let verdict;
      let receipt;
      if (!item || typeof item.run !== 'function') {
        verdict = 'NOT_IMPLEMENTED';
        receipt = { artifactDir, error: 'no run function in spec' };
      } else {
        fs.mkdirSync(artifactDir, { recursive: true });
        appendWorklog(dir, { type: 'unit-start', phaseId: unit.phaseId, itemId: unit.itemId, attempt: unit.attempt + 1 });
        onEvent?.({ type: 'unit-start', phaseId: unit.phaseId, itemId: unit.itemId, attempt: unit.attempt + 1 });
        try {
          const out = await item.run({ dir, artifactDir, attempt: unit.attempt + 1, checkpoint, phaseId: unit.phaseId, itemId: unit.itemId });
          verdict = out && VERDICTS.includes(out.verdict) ? out.verdict : 'BLOCKED';
          // `out` may not redirect the artifact directory: the receipt is the only
          // input to pruning, so a unit could otherwise nominate any directory for
          // deletion.
          const { artifactDir: _ignored, ...rest } = out ?? {};
          receipt = { artifactDir, ...rest };
          if (!out || !VERDICTS.includes(out.verdict)) receipt.error = 'run produced no valid verdict';
        } catch (err) {
          verdict = 'FAIL';
          receipt = { artifactDir, error: String((err && err.stack) || err) };
        }
        appendWorklog(dir, { type: 'unit-verdict', phaseId: unit.phaseId, itemId: unit.itemId, verdict });
        onEvent?.({ type: 'unit-verdict', phaseId: unit.phaseId, itemId: unit.itemId, verdict });
      }

      recordUnitVerdict(checkpoint, { phaseId: unit.phaseId, itemId: unit.itemId, verdict, receipt });
      checkpoint.phaseId = unit.phaseId;
      health.recordVerify(verdict);
      writeCheckpoint(dir, checkpoint);

      const post = gate();
      if (post.abort) {
        abort(post.reason, post.detail);
        break;
      }
    }
  } finally {
    hbState.done = true;
    try {
      writeHeartbeat(dir, hbState);
    } catch {}
    stopHeartbeat();
    stopKeepAwake();
    releaseRunnerMutex(dir);
  }

  return finish(status, reason, detail);

  function finish(s, r, d) {
    const result = { status: s, reason: r, detail: d ?? null, checkpoint };
    // Prune after the last checkpoint write: PASS paths keep only their summary,
    // FAIL/BLOCKED paths keep everything. The measurement is recorded so the
    // pruning proves itself in bytes, not in a claim.
    if (checkpoint) {
      try {
        const entries = checkpoint.ladder
          .filter((u) => u.verdict && u.lastReceipt && u.lastReceipt.artifactDir)
          .map((u) => ({ dir: u.lastReceipt.artifactDir, verdict: u.verdict, summary: { phaseId: u.phaseId, itemId: u.itemId, verdict: u.verdict, receipt: u.lastReceipt } }));
        if (entries.length) {
          result.prune = pruneRunArtifacts(entries, { root: path.resolve(runArtifactsDir(dir)) });
          writeRecordAtomic(path.join(dir, 'goal-prune.json'), result.prune);
        }
      } catch (err) {
        result.pruneError = String(err && err.message);
      }
    }
    try {
      writeRecordAtomic(runSummaryPath(dir), {
        runId: checkpoint ? checkpoint.runId : (runId ?? null),
        status: s,
        reason: r,
        detail: d ?? null,
        thresholdDigest: THRESHOLD_DIGEST,
        gitSha: checkpoint ? checkpoint.gitSha : gitSha,
        counts: checkpoint ? countVerdicts(checkpoint.ladder) : null,
        startedAt: checkpoint ? checkpoint.startedAt : null,
        finishedAt: new Date().toISOString(),
      });
    } catch {}
    return result;
  }
}

function parseArgs(argv) {
  const args = { dir: null };
  const rest = [...argv];
  args.dir = rest.shift() ?? null;
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === '--ladder') args.ladder = value;
    else if (flag === '--criteria') args.criteriaFile = value;
    else if (flag === '--run-id') args.runId = value;
    else if (flag === '--git-sha') args.gitSha = value;
    else if (flag === '--heartbeat-ms') args.heartbeatIntervalMs = Number(value);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.ladder) {
    console.error('usage: node scripts/goal/runner.mjs <dir> --ladder <module.mjs> [--criteria <file>] [--run-id <id>] [--git-sha <sha>] [--heartbeat-ms N]');
    process.exit(2);
  }
  const mod = await import(pathToFileURL(path.resolve(args.ladder)).href);
  const spec = mod.spec ?? mod.default;
  if (!spec || !Array.isArray(spec.phases)) {
    console.error('ladder module must export `spec` with a phases array');
    process.exit(2);
  }
  let gitSha = args.gitSha ?? null;
  if (!gitSha) {
    try {
      gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(import.meta.dirname, '..', '..'), encoding: 'utf8' }).trim();
    } catch {}
  }
  const criteria = args.criteriaFile ? fs.readFileSync(args.criteriaFile, 'utf8') : null;
  const result = await runGoal({
    dir: path.resolve(args.dir),
    spec,
    runId: args.runId,
    gitSha,
    criteria,
    heartbeatIntervalMs: args.heartbeatIntervalMs ?? THRESHOLDS.heartbeatIntervalMs,
    onEvent: (e) => console.log(`[runner] ${JSON.stringify(e)}`),
  });
  console.log(`[runner] ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
  process.exit(result.status === 'completed' ? 0 : result.status === 'aborted' ? 1 : 2);
}
