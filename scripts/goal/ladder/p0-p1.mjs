/**
 * Acceptance ladder for the P0-A -> P1 upgrade items.
 *
 * This module is the executable form of `reports/ladder-31-items.md`, which is
 * the denominator of "100%". Each item owns one or more verification routes.
 * A route is a command that exercises the real behaviour and exits non-zero when
 * the behaviour is wrong, so the verdict is read off the runtime, never inferred
 * from the presence of code.
 *
 * Verdict rules (no other route to PASS exists):
 *   PASS            every route exited 0 and asserted at least one real check.
 *   FAIL            a route ran and observed wrong behaviour.
 *   NOT_IMPLEMENTED a declared prerequisite artifact is absent. Witnessed by the
 *                   absence itself, recorded in the receipt.
 *   BLOCKED         a prerequisite outside this repository is missing. Named.
 *
 * The `pattern matched nothing` guard deserves its own note. `node --test`
 * reports `# tests 1 / # pass 1` when a name pattern filters every test away: it
 * counts the file itself as a passing placeholder whose name is the file path.
 * A typo in a pattern would therefore read as a green route while proving
 * nothing, so a run whose only passing names are the route file is a FAIL.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

const ROUTE_TIMEOUT_MS = Number(process.env.GOAL_ROUTE_TIMEOUT_MS || 300_000);

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const digest = (s) => crypto.createHash('sha256').update(s ?? '').digest('hex');

/**
 * Normalize a path for the placeholder comparison. TAP escapes the separator, so
 * a Windows path arrives with doubled backslashes; they must be collapsed before
 * the comparison or the file placeholder never matches its own route target.
 */
const normPath = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

/**
 * A route that runs tests out of a file, optionally narrowed to a name pattern.
 * `.ts` tests are executed from their compiled output, which the ladder CLI
 * builds before the first item runs.
 */
function tests(file, pattern = null) {
  const target = file.endsWith('.ts') ? `.compiled/${file.replace(/\.ts$/, '.js')}` : file;
  return { kind: 'tests', file, target, pattern, requires: [target] };
}

/** A route that runs a standalone probe which reports its own verdict. */
function probe(file) {
  return { kind: 'probe', file, target: file, pattern: null, requires: [file] };
}

/**
 * argv for the route. Built as an array, never re-split from the display string:
 * name patterns contain spaces, and splitting the joined command would hand node
 * the pattern's words as separate arguments.
 */
function argvFor(route) {
  const args = [];
  if (route.kind === 'tests') {
    // `--test-force-exit` is the flag the project's own lanes run with. It matters
    // here: the Core Health surface is a live surface, and rendering it schedules
    // timers that outlive the assertions (measured: 5 Timeouts at teardown). A
    // route measures the acceptance signal, not process-exit hygiene, and forcing
    // exit after the tests complete weakens no assertion — the failure mode it
    // removes would otherwise surface as a false ROUTE_TIMEOUT on a healthy run.
    args.push('--test', '--test-force-exit', '--test-reporter=tap');
    if (route.pattern) args.push(`--test-name-pattern=${route.pattern}`);
  }
  args.push(route.target);
  return args;
}

function commandFor(route) {
  return [process.execPath, ...argvFor(route)]
    .map((part, i) => (i > 0 && /[\s|]/.test(part) ? `"${part}"` : part))
    .join(' ');
}

function parseTap(stdout) {
  const names = [];
  let tests_n = null;
  let pass = null;
  let fail = null;
  for (const line of stdout.split(/\r?\n/)) {
    const ok = /^\s*ok\s+\d+\s+-\s+(.*)$/.exec(line);
    if (ok) names.push(ok[1].trim());
    const m = /^#\s*(tests|pass|fail)\s+(\d+)\s*$/.exec(line);
    if (m) {
      if (m[1] === 'tests') tests_n = Number(m[2]);
      if (m[1] === 'pass') pass = Number(m[2]);
      if (m[1] === 'fail') fail = Number(m[2]);
    }
  }
  return { names, tests: tests_n, pass, fail };
}

/**
 * Decide a test route's verdict from its TAP output. Returns null when the route
 * passes, otherwise a `{ verdict, reason }` pair.
 */
function judgeTestRoute(route, out) {
  const actualNames = out.names.filter((n) => !namesTheFileItself(n, route));
  if (out.fail === null || out.pass === null) {
    return { verdict: 'FAIL', reason: 'ROUTE_PRODUCED_NO_TAP_SUMMARY' };
  }
  if (out.fail > 0) return { verdict: 'FAIL', reason: 'ROUTE_ASSERTION_FAILED' };
  if (actualNames.length === 0) {
    // Every passing name was the file placeholder: the pattern matched nothing.
    return { verdict: 'FAIL', reason: 'ROUTE_PATTERN_MATCHED_NOTHING' };
  }
  return null;
}

function namesTheFileItself(name, route) {
  const n = normPath(name);
  const t = normPath(route.target);
  return n === t || t.endsWith(n);
}

function judgeProbeRoute(route, out) {
  const parsed = out.tap;
  if (!parsed) return { verdict: 'FAIL', reason: 'PROBE_EMITTED_NO_VERDICT_JSON' };
  const expectedExit = { PASS: 0, FAIL: 1, NOT_IMPLEMENTED: 3, BLOCKED: 4 }[parsed.verdict];
  if (expectedExit === undefined) {
    return { verdict: 'FAIL', reason: 'PROBE_EMITTED_UNKNOWN_VERDICT' };
  }
  if (out.status !== expectedExit) {
    // A probe whose exit code contradicts its own report cannot be trusted.
    return { verdict: 'FAIL', reason: 'PROBE_EXIT_DISAGREES_WITH_VERDICT' };
  }
  if (parsed.verdict === 'PASS') return null;
  return { verdict: parsed.verdict, reason: parsed.reason ?? 'PROBE_REPORTED_NON_PASS' };
}

/** Last JSON object on stdout, which the probe protocol reserves for the verdict. */
function lastJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Run a route without blocking the event loop.
 *
 * `spawnSync` here would stop the heartbeat for the whole duration of the route,
 * and a route can legitimately take minutes. The external supervisor reads a
 * heartbeat it cannot refresh during a synchronous spawn as a dead runner and
 * kills it, so a slow-but-healthy item would be reported as HEARTBEAT_STALE.
 * Keeping the spawn asynchronous is what makes the watchdog's signal mean what it
 * says.
 */
function spawnRoute(route) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argvFor(route), { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, ROUTE_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const settle = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...extra });
    };
    child.on('error', (err) => settle({ status: null, signal: null, error: err }));
    child.on('close', (code, signal) => settle({ status: code, signal, error: null }));
  });
}

/** Kill a route and anything it spawned; `node --test` fans out to child processes. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* the route may have exited between the timeout and the kill */
  }
}

function writeEvidence(artifactDir, route, result, stdout, stderr) {
  try {
    fs.writeFileSync(
      path.join(artifactDir, `${route.kind}-${digest(route.target).slice(0, 8)}.log`),
      `command: ${result.command}\nexit: ${result.exit}\nverdict: ${result.verdict}\nreason: ${result.reason ?? ''}\n\n${stdout}\n--- stderr ---\n${stderr}\n`,
    );
  } catch {
    /* evidence is best-effort; the receipt still carries the digest */
  }
}

/**
 * Items are declared as data; `run` is attached here so every item records the
 * same revision-bound receipt shape.
 */
function item({ itemId, label, group, ownerPhase, routes, absentWhen = [] }) {
  return {
    itemId,
    label: `${group} ${label}`,
    group,
    ownerPhase,
    async run({ artifactDir }) {
      const missing = absentWhen.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
      if (missing.length) {
        return {
          verdict: 'NOT_IMPLEMENTED',
          routeIdentity: commandFor(routes[0]),
          exit: null,
          finishedAt: new Date().toISOString(),
          gitSha: gitSha(),
          reason: 'DECLARED_ARTIFACT_ABSENT',
          evidence: { absent: missing },
        };
      }
      const results = [];
      for (const route of routes) {
        const absent = (route.requires ?? []).filter((rel) => !fs.existsSync(path.join(REPO, rel)));
        if (absent.length) {
          results.push({ command: commandFor(route), verdict: 'NOT_IMPLEMENTED', reason: 'ROUTE_TARGET_ABSENT', exit: null, evidence: { absent } });
          continue;
        }
        const res = await spawnRoute(route);
        const stdout = res.stdout ?? '';
        const stderr = res.stderr ?? '';
        if (res.timedOut) {
          const record = { command: commandFor(route), verdict: 'FAIL', reason: 'ROUTE_TIMEOUT', exit: res.status, timedOut: true };
          results.push(record);
          writeEvidence(artifactDir, route, record, stdout, stderr);
          continue;
        }
        if (res.error) {
          results.push({ command: commandFor(route), verdict: 'BLOCKED', reason: `ROUTE_SPAWN_FAILED: ${res.error.code ?? res.error.message}`, exit: null });
          continue;
        }
        const tap = parseTap(stdout);
        const probeJson = route.kind === 'probe' ? lastJson(stdout) : null;
        const judged =
          route.kind === 'probe'
            ? judgeProbeRoute(route, { status: res.status, tap: probeJson })
            : judgeTestRoute(route, tap);
        const record = {
          command: commandFor(route),
          verdict: judged ? judged.verdict : 'PASS',
          reason: judged ? judged.reason : null,
          exit: res.status,
          finishedAt: new Date().toISOString(),
          stdoutDigest: digest(stdout),
          tests: tap.tests,
          pass: tap.pass,
          fail: tap.fail,
          probe: probeJson,
        };
        results.push(record);
        if (record.verdict !== 'PASS') writeEvidence(artifactDir, route, record, stdout, stderr);
      }

      const worst = results.find((r) => r.verdict !== 'PASS');
      const verdict = worst ? worst.verdict : 'PASS';
      const allExitedZero = results.every((r) => r.exit === 0);
      return {
        verdict,
        routeIdentity: results.map((r) => r.command).join(' && '),
        // A PASS is bound to a zero exit across every route; a non-PASS keeps the
        // failing route's exit so the receipt never reports a clean run.
        exit: verdict === 'PASS' ? (allExitedZero ? 0 : 1) : (worst?.exit ?? null),
        finishedAt: new Date().toISOString(),
        gitSha: gitSha(),
        reason: worst?.reason ?? null,
        evidence: { routes: results },
      };
    },
  };
}

const SUPER_CORE_TEST = 'packages/super-core/dist/core.test.js';
const BRIDGE_TEST = 'test/unit/context-bridge.test.mjs';
const PARITY_TEST = 'test/unit/mcp-core-parity.test.mjs';
const HEALTH_TEST = 'test/unit/core-health-service.test.ts';
const HUB_TEST = 'test/renderer/core-health-hub.test.ts';
const ISSUE_TEST = 'test/unit/issue-register-taxonomy.test.ts';
const TRANSPORT_TEST = 'test/main/mcp-persistent-transport.test.ts';
const ENVELOPE_TEST = 'test/main/mcp-result-envelope.test.ts';
const INDUSTRIAL_TEST = 'test/main/mcp-industrial-e2e.test.ts';

export const spec = {
  phases: [
    {
      phaseId: 'p0a',
      label: 'P0-A retrieval and bridge',
      items: [
        item({
          itemId: 'taskrun-identity',
          label: '#1 TaskRun identity',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(HEALTH_TEST, 'pack trace resolves claims|TASK_RUN_NOT_FOUND')],
        }),
        item({
          itemId: 'omp-extension',
          label: '#2 OMP Extension',
          group: 'P0-A',
          ownerPhase: 3,
          absentWhen: ['.omp/hooks/pre/antifan-core-bridge.ts'],
          routes: [tests(BRIDGE_TEST, 'hook discovery scans only pre/|bridge hook is placed inside')],
        }),
        item({
          itemId: 'before-agent-start-hook',
          label: '#3 before_agent_start hook',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(BRIDGE_TEST, 'before_agent_start returns one pack message')],
        }),
        item({
          itemId: 'core-retrieval',
          label: '#4 Core retrieval',
          group: 'P0-A',
          ownerPhase: 2,
          routes: [
            tests(
              SUPER_CORE_TEST,
              'platform filter isolates wrong-platform claims|platform policy excludes untagged and wrong-platform claims|findSimilar applies platform policy to all six collections|content policy holds on findSimilar',
            ),
          ],
        }),
        item({
          itemId: 'context-pack',
          label: '#5 Context Pack',
          group: 'P0-A',
          ownerPhase: 2,
          routes: [
            tests(SUPER_CORE_TEST, 'pack conflicts are platform-scoped and unit-scoped|abstain gate: <2 quality claims|unresolved conflict lowers confidence'),
          ],
        }),
        item({
          itemId: 'omp-injection',
          label: '#6 OMP injection',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(BRIDGE_TEST, 'context handler drops stale and duplicate pack messages')],
        }),
        item({
          itemId: 'context-reattach',
          label: '#7 context reattach',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(BRIDGE_TEST, 'session.compacting preserves packId|session.compacting records unavailable state')],
        }),
        item({
          itemId: 'bridge-telemetry',
          label: '#8 bridge telemetry',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(BRIDGE_TEST, 'exactly one BRIDGE_CONTEXT_FAILED|fail-open with one event|hard spawn timeout fires')],
        }),
        item({
          itemId: 'pack-binding',
          label: '#9 pack binding',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(SUPER_CORE_TEST, 'contextPack dedupes on')],
        }),
        item({
          itemId: 'end-to-end-trace',
          label: '#10 end-to-end trace',
          group: 'P0-A',
          ownerPhase: 3,
          routes: [tests(BRIDGE_TEST)],
        }),
      ],
    },
    {
      phaseId: 'p0b',
      label: 'P0-B core health surface',
      items: [
        item({
          itemId: 'core-health-service',
          label: '#11 Core Health service',
          group: 'P0-B',
          ownerPhase: 6,
          absentWhen: ['src/main/diagnostics/core-health.ts'],
          routes: [tests(HEALTH_TEST, 'all gates pass|seeded degraded scenario|CLI failure')],
        }),
        item({
          itemId: 'health-snapshot',
          label: '#12 Health snapshot',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [
            tests(HEALTH_TEST, 'empty store|no regression run|missing telemetry file|BRIDGE_CONTEXT_FAILED event|seeded pending candidate'),
          ],
        }),
        item({
          itemId: 'health-ui',
          label: '#13 Health UI',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [tests(HUB_TEST, 'Health surface')],
        }),
        item({
          itemId: 'bridge-ui',
          label: '#14 Bridge UI',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [tests(HUB_TEST, 'Bridge surface')],
        }),
        item({
          itemId: 'task-run-trace-view',
          label: '#15 Task Run trace (view)',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [tests(HUB_TEST, 'Task Run surface')],
        }),
        item({
          itemId: 'issue-model',
          label: '#16 Issue model',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [tests(ISSUE_TEST, 'classifyIssue: explicit field|subdomains classify by their own surface')],
        }),
        item({
          itemId: 'report-issue',
          label: '#17 Report Issue',
          group: 'P0-B',
          ownerPhase: 6,
          routes: [tests(ISSUE_TEST, 'record accepts new taxonomy fields')],
        }),
      ],
    },
    {
      phaseId: 'p0c',
      label: 'P0-C MCP reliability',
      items: [
        item({
          itemId: 'canonical-capability-manifest',
          label: '#18 Canonical capability manifest',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(PARITY_TEST, 'parity gate passes at HEAD')],
        }),
        item({
          itemId: 'remove-schema-duplication',
          label: '#19 Remove schema duplication',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(PARITY_TEST, 'every shadowing routing row agrees|retired browser_find routing row')],
        }),
        item({
          itemId: 'mcp-conformance-runner',
          label: '#20 MCP conformance runner',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(INDUSTRIAL_TEST, 'Dispatches Playwright canonical browser_find|Dispatches anti.agent.cursor.type')],
        }),
        item({
          itemId: 'schema-parity-test',
          label: '#21 Schema parity test',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(PARITY_TEST, 'parity gate fails on seeded schema drift|parity gate fails when a dispatch entry names a store method')],
        }),
        item({
          itemId: 'transport-test',
          label: '#22 Transport test',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(TRANSPORT_TEST, 'Connects persistent dispatch channel|Dispatches 10 concurrent tool calls')],
        }),
        item({
          itemId: 'failure-retry-test',
          label: '#23 Failure/retry test',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(TRANSPORT_TEST, 'Rejects in-flight requests cleanly')],
        }),
        item({
          itemId: 'idempotency-test',
          label: '#24 Idempotency test',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [tests(ENVELOPE_TEST, 'carries stable evidence metadata|failures are structured and carry authority revision')],
        }),
        item({
          itemId: 'mcp-health-metrics',
          label: '#25 Health metrics (MCP)',
          group: 'P0-C',
          ownerPhase: 5,
          routes: [probe('scripts/goal/ladder/probes/mcp-health-metrics.mjs')],
        }),
      ],
    },
    {
      phaseId: 'p1',
      label: 'P1 retrieval precision and learning',
      items: [
        item({
          itemId: 'retrieval-precision',
          label: '#26 Retrieval precision',
          group: 'P1',
          ownerPhase: 2,
          routes: [probe('scripts/goal/ladder/probes/retrieval-ranking.mjs')],
        }),
        item({
          itemId: 'historical-reuse',
          label: '#27 Historical reuse',
          group: 'P1',
          ownerPhase: 2,
          routes: [probe('scripts/goal/ladder/probes/reuse-metric.mjs')],
        }),
        item({
          itemId: 'root-cause-ui',
          label: '#28 Root cause UI',
          group: 'P1',
          ownerPhase: 6,
          routes: [tests(HUB_TEST, 'Root cause surface')],
        }),
        item({
          itemId: 'core-regression-ui',
          label: '#29 Core regression UI',
          group: 'P1',
          ownerPhase: 6,
          routes: [tests(HUB_TEST, 'Regression surface'), tests(SUPER_CORE_TEST, 'replayRegression re-executes')],
        }),
        item({
          itemId: 'knowledge-gap-detection',
          label: '#30 Knowledge gap detection',
          group: 'P1',
          ownerPhase: 2,
          routes: [tests(SUPER_CORE_TEST, 'knowledgeGaps distinguishes never/stale/conflicted|no-match query abstains')],
        }),
        item({
          itemId: 'learning-trace',
          label: '#31 Learning trace',
          group: 'P1',
          ownerPhase: 4,
          routes: [
            tests(SUPER_CORE_TEST, 'ingestOutcome writes a linked observation|recordObservation is the raw producer|adjudicate is the only promotion path'),
          ],
        }),
      ],
    },
  ],
};

/** Item count is the denominator of 100%; a spec change must update the report. */
export const ITEM_COUNT = spec.phases.reduce((n, p) => n + p.items.length, 0);

export default spec;
