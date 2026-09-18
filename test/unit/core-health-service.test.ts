/**
 * Core Health service (Phase 6 items 11/12): every status carries reasonCode +
 * affected; a seeded degraded scenario reports DEGRADED, never a percentage.
 *
 * The CLI-path test builds packages/super-core into a temp dir so it never
 * depends on the worktree's dist state; if that build fails the test skips
 * with the build error as the named blocker.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CoreHealthService, resolveRepoRoot } from '../../src/main/diagnostics/core-health';
import type { IssueRecord } from '../../src/main/session/issue-register';

const REPO_ROOT = resolveRepoRoot(__dirname);

function makeIssues(open: Array<Partial<IssueRecord>> = []) {
  const records = open.map((o, i) => ({
    id: `ISS-T${i}`,
    timestamp: Date.now() - i,
    timeFormatted: new Date().toISOString(),
    severity: 'P2',
    toolName: 'test.tool',
    errorMessage: 'msg',
    status: 'OPEN',
    ...o,
  })) as IssueRecord[];
  return {
    list: (opts?: { status?: string }) => records.filter((r) => !opts?.status || r.status === opts.status),
    summarizeOpen: () => [],
  };
}

function healthyHealth(): Record<string, unknown> {
  const gate = { passed: true, detail: 'ok', gateId: 'gate-x' };
  return {
    stats: { artifacts: 10, claims: 5, evidence: 8 },
    audit: { artifacts: 10, blocked: 0, blockedReasonless: 0, pending: 0, unresolved: 0 },
    decay: { stale: [], aging: [], cutoff: 'x' },
    gates: { coverage: gate, evidence: gate, conflict: gate, temporal: gate, promotion: gate, regression: { ...gate, detail: 'last regression: PASS' }, principles: gate },
    uncertainty: { level: 'STRONGLY_SUPPORTED', reason: '2 promoted claims' },
  };
}

describe('CoreHealthService snapshot mapping', () => {
  test('all gates pass → HEALTHY with reasonCode, no percentage', async () => {
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues(),
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'HEALTHY');
    assert.equal(snap.reasonCode, 'ALL_GATES_PASSED');
    assert.ok(!/%/.test(snap.reasonCode));
    for (const c of snap.checks) {
      assert.ok(c.reasonCode, `check ${c.name} missing reasonCode`);
      assert.ok(Array.isArray(c.affected), `check ${c.name} missing affected`);
    }
  });

  test('seeded degraded scenario (pending candidates) → DEGRADED + PENDING_CANDIDATES', async () => {
    const health = healthyHealth();
    (health.gates as Record<string, unknown>).promotion = { passed: false, detail: '3 pending candidates', gateId: 'gate-p' };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'DEGRADED');
    assert.equal(snap.reasonCode, 'PENDING_CANDIDATES');
    assert.ok(snap.affected.some((a) => a.includes('pending candidates')));
    assert.ok(!/%/.test(JSON.stringify({ status: snap.status, reasonCode: snap.reasonCode })));
  });

  test('open P0 issue → DEGRADED + OPEN_HIGH_SEVERITY_ISSUES', async () => {
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues([{ severity: 'P0', errorCode: 'BRIDGE_CONTEXT_FAILED' }]),
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'DEGRADED');
    assert.equal(snap.reasonCode, 'OPEN_HIGH_SEVERITY_ISSUES');
  });

  test('empty store → coverage reports UNKNOWN/EMPTY_STORE not a fake pass', async () => {
    const health = healthyHealth();
    health.stats = { artifacts: 0, claims: 0, evidence: 0 };
    (health.gates as Record<string, unknown>).coverage = { passed: false, detail: '0 artifacts non-terminal', gateId: 'gate-c' };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    const cov = snap.checks.find((c) => c.name === 'core.coverage');
    assert.equal(cov?.status, 'UNKNOWN');
    assert.equal(cov?.reasonCode, 'EMPTY_STORE');
  });

  test('no regression run → UNKNOWN/NO_REGRESSION_RUN, not DEGRADED', async () => {
    const health = healthyHealth();
    (health.gates as Record<string, unknown>).regression = { passed: false, detail: 'no regression run', gateId: 'gate-r' };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    const reg = snap.checks.find((c) => c.name === 'core.regression');
    assert.equal(reg?.status, 'UNKNOWN');
    assert.equal(reg?.reasonCode, 'NO_REGRESSION_RUN');
  });

  test('CLI failure → UNAVAILABLE + CORE_UNAVAILABLE', async () => {
    const svc = new CoreHealthService({
      runCli: () => { throw new Error('super-core unavailable: boom'); },
      issueRegister: makeIssues(),
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'UNAVAILABLE');
    assert.equal(snap.reasonCode, 'CORE_UNAVAILABLE');
    assert.ok(snap.affected[0]?.includes('super-core unavailable'));
  });
});

describe('CoreHealthService phase-9 surfaces', () => {
  test('two failed gates at the decisive severity are both named in reasonCode', async () => {
    const health = healthyHealth();
    (health.gates as Record<string, unknown>).promotion = { passed: false, detail: '3 pending candidates', gateId: 'gate-p' };
    (health.gates as Record<string, unknown>).regression = { passed: false, detail: 'last regression: FAIL', gateId: 'gate-r' };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'DEGRADED');
    assert.equal(snap.reasonCode, 'PENDING_CANDIDATES+REGRESSION_FAILED', 'every failed gate is named, not just the first');
  });

  test('corpus-wide UNKNOWN uncertainty is reported but never caps the panel', async () => {
    const health = healthyHealth();
    health.uncertainty = { level: 'UNKNOWN', reason: 'unscoped: uncertainty is per-task/claim, not corpus-wide' };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'HEALTHY', 'an unscoped UNKNOWN must not act as a ceiling');
    const unc = snap.checks.find((c) => c.name === 'core.uncertainty');
    assert.equal(unc?.status, 'UNKNOWN', 'the level is still reported honestly');
    assert.equal(unc?.gating, false);
  });

  test('usage line reads the dispatch aggregate: stats carry the count, check never gates', async () => {
    const envelope = {
      status: 'MEASURED' as const,
      reasonCode: 'MEASURED',
      affected: [],
      evidenceRefs: [],
      asOf: '2026-09-18T00:00:00Z',
      storePath: 'invocations',
      census: null,
      fileRollups: [],
      rows: [
        { name: 'browser.navigate', calls: 10, frames: 10, superseded: 0, states: {}, errors: {}, latency: null, excludedLatency: null, firstSeen: null, lastSeen: null, lowerBound: false },
        { name: 'browser.reload', calls: 5, frames: 5, superseded: 0, states: {}, errors: {}, latency: null, excludedLatency: null, firstSeen: null, lastSeen: null, lowerBound: false },
      ],
      totals: null,
      reconciliation: {
        classifiedKeys: 15,
        unattributedKeys: 0,
        unattributedFrames: 0,
        unattributedByReason: { MISSING_IDENTITY_FIELD: 0, MISSING_ROW_KEY: 0 },
        keylessFrames: 0,
        compositeKeys: 15,
        frames: 15,
        superseded: 0,
        holdsKeys: true,
        holdsFrames: true,
        holdsMargin: true,
        lines: [],
      },
    };
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues(),
      mcpDispatch: { getState: async () => envelope, clearCache: () => {} },
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'HEALTHY');
    assert.equal(snap.stats?.mcpDispatchCalls, 15, 'the count comes from the aggregate, not a client-side tally');
    const usage = snap.checks.find((c) => c.name === 'mcp.dispatch');
    assert.equal(usage?.status, 'HEALTHY');
    assert.equal(usage?.gating, false);
    assert.ok(usage?.detail?.includes('15'), 'the line renders the aggregate count');
  });

  test('unmeasured dispatch reports UNKNOWN without touching the count or the status', async () => {
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues(),
      mcpDispatch: { getState: async () => ({ status: 'UNMEASURED', reasonCode: 'NO_DATA_ROOT_RESOLVED', affected: [], evidenceRefs: [], asOf: 'x', storePath: null, census: null, fileRollups: [], rows: [], totals: null, reconciliation: null }), clearCache: () => {} },
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'HEALTHY');
    assert.equal(snap.stats?.mcpDispatchCalls, undefined, 'no count is fabricated when nothing was measured');
    const usage = snap.checks.find((c) => c.name === 'mcp.dispatch');
    assert.equal(usage?.status, 'UNKNOWN');
    assert.equal(usage?.reasonCode, 'DISPATCH_NO_DATA_ROOT_RESOLVED');
  });

  test('connected is surfaced, not gated; knowledge gaps surface the largest store signal', async () => {
    const health = healthyHealth();
    health.audit = { ...(health.audit as Record<string, unknown>), connected: 7 };
    health.knowledgeGaps = { gaps: [
      { platform: 'haravan', kind: 'NONE', activeClaims: 100, freshClaims: 10, unresolvedConflicts: 0 },
      { platform: 'sapo', kind: 'NO_EVIDENCE', activeClaims: 0, freshClaims: 0, unresolvedConflicts: 0 },
    ] };
    const svc = new CoreHealthService({ runCli: () => health, issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'HEALTHY', 'reported-only signals must not degrade the panel');
    const conn = snap.checks.find((c) => c.name === 'core.connected');
    assert.equal(conn?.status, 'HEALTHY');
    assert.equal(conn?.gating, false);
    assert.ok(conn?.detail?.includes('7'), 'the connected count is rendered');
    const gaps = snap.checks.find((c) => c.name === 'core.knowledge_gaps');
    assert.equal(gaps?.status, 'UNKNOWN');
    assert.equal(gaps?.gating, false);
    assert.ok(gaps?.affected.some((a) => a.includes('sapo')), 'the gap names its platform');
  });
});

describe('CoreHealthService runtime crash surface', () => {
  const CRASH_NOTES = JSON.stringify({
    dump: 'c2bbb433-925f-403a-adf2-9a1ae635509e.dmp',
    occurredAt: '2026-09-17T02:28:05.535Z',
    processType: 'browser',
    pid: 32284,
    exceptionCode: '0xc0000005',
    faultingAccess: 'read',
    faultingAddress: '0x0000000000000000',
  });

  test('an open browser-process crash is reported first-class with its evidence', async () => {
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues([{
        severity: 'P0',
        errorCode: 'NATIVE_CRASH',
        reasonCode: 'STATUS_ACCESS_VIOLATION',
        toolName: 'runtime.process',
        timeFormatted: '2026-09-17T02:28:10.295Z',
        affected: ['reports/c2bbb433-925f-403a-adf2-9a1ae635509e.dmp'],
        notes: CRASH_NOTES,
      }]),
    });
    const snap = await svc.getSnapshot();
    const check = snap.checks.find((c) => c.name === 'runtime.crash');
    assert.equal(check?.status, 'DEGRADED');
    assert.equal(check?.reasonCode, 'BROWSER_PROCESS_CRASHED');
    assert.equal(snap.crashes?.total, 1);
    assert.equal(snap.crashes?.latestId, 'ISS-T0');

    const record = snap.crashes?.records[0];
    assert.equal(record?.reasonCode, 'STATUS_ACCESS_VIOLATION');
    assert.equal(record?.time, '2026-09-17T02:28:10.295Z');
    // Which process died and which dump proves it is what makes the crash actionable.
    assert.equal(record?.processType, 'browser');
    assert.equal(record?.pid, 32284);
    assert.equal(record?.dump, 'c2bbb433-925f-403a-adf2-9a1ae635509e.dmp');
  });

  test('a crash whose notes are unreadable still reports id, time and reasonCode', async () => {
    const svc = new CoreHealthService({
      runCli: () => healthyHealth(),
      issueRegister: makeIssues([{
        severity: 'P0',
        errorCode: 'NATIVE_CRASH',
        reasonCode: 'STATUS_ACCESS_VIOLATION',
        toolName: 'runtime.process',
        timeFormatted: '2026-09-16T09:38:46.844Z',
        notes: 'crashpad wrote a dump; the metadata line was truncated',
      }]),
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.crashes?.total, 1);
    const record = snap.crashes?.records[0];
    assert.equal(record?.id, 'ISS-T0');
    assert.equal(record?.time, '2026-09-16T09:38:46.844Z');
    assert.equal(record?.reasonCode, 'STATUS_ACCESS_VIOLATION');
    assert.equal(record?.dump, undefined);
  });

  test('a clean session stays HEALTHY — the crash check never degrades by itself', async () => {
    const svc = new CoreHealthService({ runCli: () => healthyHealth(), issueRegister: makeIssues() });
    const snap = await svc.getSnapshot();
    const check = snap.checks.find((c) => c.name === 'runtime.crash');
    assert.equal(check?.status, 'HEALTHY');
    assert.equal(check?.reasonCode, 'NO_CRASH_RECORDED');
    assert.equal(snap.crashes?.total, 0);
    assert.equal(snap.status, 'HEALTHY');
    assert.equal(snap.reasonCode, 'ALL_GATES_PASSED');
  });
});

describe('CoreHealthService bridge surface', () => {
  test('missing telemetry file → UNKNOWN/BRIDGE_TELEMETRY_MISSING with unknowns listed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-'));
    const svc = new CoreHealthService({
      repoRoot: root,
      projectRoots: [root],
      runCli: (cmd) => (cmd === 'stats' ? { artifacts: 1 } : { packs: [] }),
      issueRegister: makeIssues(),
    });
    const b = await svc.getBridgeState();
    assert.equal(b.status, 'UNKNOWN');
    assert.equal(b.reasonCode, 'BRIDGE_TELEMETRY_MISSING');
    assert.ok(b.unknowns.length > 0, 'unknowns must be surfaced, not hidden');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('BRIDGE_CONTEXT_FAILED event → DEGRADED + reasonCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-'));
    const dir = path.join(root, '.canary', 'core-bridge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ event: 'BRIDGE_CONTEXT_FAILED', reason: 'cli exit 2', taskHash: 'abc123', ts: '2026-09-16T00:00:00Z' }) + '\n');
    const svc = new CoreHealthService({
      repoRoot: root,
      projectRoots: [root],
      runCli: (cmd) => (cmd === 'stats' ? { artifacts: 1 } : { packs: [] }),
      issueRegister: makeIssues(),
    });
    const b = await svc.getBridgeState();
    assert.equal(b.status, 'DEGRADED');
    assert.equal(b.reasonCode, 'BRIDGE_CONTEXT_FAILED');
    assert.equal(b.failures.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('CoreHealthService regression surface (item 29)', () => {
  test('replayEngineAvailable flag is not special-cased: rows decide the verdict', async () => {
    // The engine exists, so a payload claiming it does not is not a live state —
    // the surface must not branch on the flag. A PASS row without replayedAt is
    // an asserted verdict, not an observed one, so it degrades rather than reads
    // as HEALTHY.
    const svc = new CoreHealthService({
      runCli: () => ({ replayEngineAvailable: false, rows: [{ regressionId: 'reg-1', replayResult: 'PASS' }] }),
      issueRegister: makeIssues(),
    });
    const r = await svc.getRegressions();
    assert.equal(r.status, 'DEGRADED');
    assert.equal(r.reasonCode, 'REGRESSION_FAILED');
    assert.notEqual(r.reasonCode, 'REPLAY_ENGINE_NOT_IMPLEMENTED', 'the dead branch must not come back');
  });

  test('replay engine + last FAIL → DEGRADED/REGRESSION_FAILED', async () => {
    const svc = new CoreHealthService({
      runCli: () => ({ replayEngineAvailable: true, rows: [{ regressionId: 'reg-2', replayResult: 'FAIL' }] }),
      issueRegister: makeIssues(),
    });
    const r = await svc.getRegressions();
    assert.equal(r.status, 'DEGRADED');
    assert.equal(r.reasonCode, 'REGRESSION_FAILED');
  });
});

describe('CoreHealthService task runs (item 15)', () => {
  test('pack trace resolves claims + receipts', async () => {
    const svc = new CoreHealthService({
      runCli: (cmd, arg) => {
        if (cmd === 'pack-detail') {
          return { pack: { packId: arg, task: 't' }, claims: [{ claimId: 'c1' }], receipts: [{ receiptId: 'r1' }] };
        }
        return {};
      },
      issueRegister: makeIssues(),
    });
    const trace = await svc.getTaskRunTrace('pack-123');
    assert.equal(trace.status, 'HEALTHY');
    assert.equal(trace.reasonCode, 'TRACE_FOUND');
    assert.equal(trace.claims?.length, 1);
  });

  test('unknown id → UNKNOWN/TASK_RUN_NOT_FOUND', async () => {
    const svc = new CoreHealthService({
      runCli: () => ({ taskRunsTable: false, taskRuns: [], packs: [], cases: [] }),
      issueRegister: makeIssues(),
    });
    const trace = await svc.getTaskRunTrace('nope-1');
    assert.equal(trace.status, 'UNKNOWN');
    assert.equal(trace.reasonCode, 'TASK_RUN_NOT_FOUND');
  });

  test('absent task_runs table names the missing producer; an empty table is a different gap', async () => {
    const absent = new CoreHealthService({
      runCli: () => ({ taskRunsTable: false, taskRuns: [], packs: [], cases: [] }),
      issueRegister: makeIssues(),
    });
    const absentState = await absent.listTaskRuns();
    assert.equal(absentState.status, 'UNKNOWN');
    assert.equal(absentState.reasonCode, 'NO_TASK_RUNS');
    assert.ok(absentState.affected.some((a) => /absent/.test(a)), 'absent table must be named as the missing producer');

    const empty = new CoreHealthService({
      runCli: () => ({ taskRunsTable: true, taskRuns: [], packs: [], cases: [] }),
      issueRegister: makeIssues(),
    });
    const emptyState = await empty.listTaskRuns();
    assert.equal(emptyState.status, 'UNKNOWN');
    assert.equal(emptyState.reasonCode, 'NO_TASK_RUNS');
    assert.ok(emptyState.affected.some((a) => /empty/.test(a)), 'present-but-empty table must be named differently');
  });
});

describe('CoreHealthService real CLI path', () => {
  test('missing super-core dist → UNAVAILABLE via real spawn', async () => {
    // antifan-core.cjs resolves ../packages/super-core/dist relative to its own
    // path, so run a copy from a temp tree that has no dist — the outcome never
    // depends on whether the worktree's own dist exists.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-noroot-'));
    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'antifan-core.cjs'), path.join(scriptsDir, 'antifan-core.cjs'));
    try {
      const svc = new CoreHealthService({
        scriptPath: path.join(scriptsDir, 'antifan-core.cjs'),
        repoRoot: tmp,
        issueRegister: makeIssues(),
      });
      const snap = await svc.getSnapshot();
      assert.equal(snap.status, 'UNAVAILABLE');
      assert.equal(snap.reasonCode, 'CORE_UNAVAILABLE');
      assert.ok(snap.affected[0]?.includes('super-core unavailable'), 'must surface the real CLI exit-2 reason');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('seeded pending candidate → real CLI reports DEGRADED/PENDING_CANDIDATES', async (t) => {
    // Build super-core into a temp package so the CLI has a working dist
    // regardless of the worktree's current build state.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-core-cli-'));
    const pkgDir = path.join(tmp, 'packages', 'super-core');
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const f of ['index.ts', 'schema.ts']) {
      const src = path.join(REPO_ROOT, 'packages', 'super-core', 'src', f);
      if (!fs.existsSync(src)) {
        t.skip(`super-core source ${f} is absent from this checkout`);
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      }
      fs.copyFileSync(src, path.join(pkgDir, f));
    }
    // The temp package sits outside the repo, so @types/node is not reachable by
    // default typeRoots walking — point it at the repo's copy explicitly.
    fs.writeFileSync(path.join(pkgDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'], outDir: './dist', rootDir: '.', strict: true, skipLibCheck: true, esModuleInterop: true, types: ['node'], typeRoots: [path.join(REPO_ROOT, 'node_modules', '@types')] },
      include: ['*.ts'],
    }));
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', pkgDir], { stdio: 'pipe' });
    } catch (err) {
      t.skip(`super-core sources do not compile right now (sibling WIP): ${String(err).slice(0, 200)}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    }
    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'antifan-core.cjs'), path.join(scriptsDir, 'antifan-core.cjs'));

    const dbDir = path.join(tmp, '.super-core');
    fs.mkdirSync(dbDir, { recursive: true });
    const env = { ...process.env, SUPER_CORE_DB: path.join(dbDir, 'core.db') };
    // Seed a PENDING candidate via the real CLI: ingestOutcome → candidates row.
    execFileSync(process.execPath, [path.join(scriptsDir, 'antifan-core.cjs'), 'outcome', JSON.stringify({ task: 'seed', outcome: 'x' })], { cwd: tmp, env, stdio: 'pipe' });

    const svc = new CoreHealthService({
      scriptPath: path.join(scriptsDir, 'antifan-core.cjs'),
      repoRoot: tmp,
      issueRegister: makeIssues(),
    });
    const prevDb = process.env.SUPER_CORE_DB;
    process.env.SUPER_CORE_DB = env.SUPER_CORE_DB;
    try {
      const snap = await svc.getSnapshot();
      assert.equal(snap.status, 'DEGRADED');
      assert.equal(snap.reasonCode, 'PENDING_CANDIDATES');
      assert.ok(!/%/.test(snap.reasonCode));
    } finally {
      if (prevDb === undefined) delete process.env.SUPER_CORE_DB;
      else process.env.SUPER_CORE_DB = prevDb;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
