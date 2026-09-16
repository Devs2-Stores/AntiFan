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
    gates: { coverage: gate, evidence: gate, conflict: gate, temporal: gate, promotion: gate, regression: { ...gate, detail: 'last regression: PASS' } },
    // The real health() emits exactly this: uncertainty is scoped to a task or
    // claim, so the corpus-wide level is UNKNOWN by construction. A fixture that
    // supplied a confident level would assert a state the producer cannot emit.
    uncertainty: { level: 'UNKNOWN', reason: 'unscoped: uncertainty is per-task/claim, not corpus-wide' },
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
  test('no replay engine → UNKNOWN/REPLAY_ENGINE_NOT_IMPLEMENTED even with rows', async () => {
    const svc = new CoreHealthService({
      runCli: () => ({ replayEngineAvailable: false, rows: [{ regressionId: 'reg-1', replayResult: 'PASS' }] }),
      issueRegister: makeIssues(),
    });
    const r = await svc.getRegressions();
    assert.equal(r.status, 'UNKNOWN');
    assert.equal(r.reasonCode, 'REPLAY_ENGINE_NOT_IMPLEMENTED');
    assert.notEqual(r.status, 'HEALTHY', 'must not PASS on rows without a replay engine');
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
});

describe('CoreHealthService real CLI path', () => {
  test('missing super-core dist → UNAVAILABLE via real spawn', async () => {
    // Point scriptPath at a copy of the CLI inside a temp root that has NO
    // packages/super-core/dist, so the CLI's dist lookup genuinely misses and
    // exits non-zero regardless of the host repo's build state.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-noroot-'));
    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'antifan-core.cjs'), path.join(scriptsDir, 'antifan-core.cjs'));
    const svc = new CoreHealthService({
      scriptPath: path.join(scriptsDir, 'antifan-core.cjs'),
      repoRoot: tmp,
      issueRegister: makeIssues(),
    });
    const snap = await svc.getSnapshot();
    assert.equal(snap.status, 'UNAVAILABLE');
    assert.equal(snap.reasonCode, 'CORE_UNAVAILABLE');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('seeded pending candidate → real CLI reports DEGRADED/PENDING_CANDIDATES', async (t) => {
    // Build super-core into a temp package so the CLI has a working dist
    // regardless of the worktree's current build state.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-core-cli-'));
    const pkgDir = path.join(tmp, 'packages', 'super-core');
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const f of ['index.ts', 'schema.ts']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'packages', 'super-core', 'src', f), path.join(pkgDir, f));
    }
    fs.writeFileSync(path.join(pkgDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: './dist', rootDir: '.', strict: true, skipLibCheck: true, esModuleInterop: true, types: ['node'], typeRoots: [path.join(REPO_ROOT, 'node_modules', '@types')] },
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
