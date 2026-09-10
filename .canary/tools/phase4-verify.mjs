/**
 * Phase 4 verification runner (wave 3 owner of the shared `.compiled` build).
 *
 *   node .canary/tools/phase4-verify.mjs [--out .canary/smoke/phase4-verification.json]
 *
 * Runs the plan's exact verification sequence and persists a machine-readable
 * receipt consumed by `scripts/lib/build-report.mjs` (§15 UNIT-TEST PROOF):
 *   npm run typecheck -> npm run compile -> compiled focused suites (node --test).
 *
 * Fails closed: any non-zero step keeps exitCode non-zero and is recorded with
 * its raw output tail. Never skips a suite silently — a missing compiled file is
 * recorded as `missing`, which also fails the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = path.resolve(arg('out', '.canary/smoke/phase4-verification.json'));
const LOG_DIR = path.join(path.dirname(OUT), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const SUITES = [
  '.compiled/test/unit/visual-capture.test.js',
  '.compiled/test/unit/baseline-authority.test.js',
  '.compiled/test/unit/theme-evidence-capabilities.test.js',
  '.compiled/test/main/tab-devtools-host.test.js',
  '.compiled/test/main/capability-catalogue.test.js',
  '.compiled/test/main/visual-compare-mask-ledger.test.js',
  '.compiled/test/main/runtime-fullpage-evidence.test.js',
  '.compiled/test/main/baseline-authority-integration.test.js',
  '.compiled/test/main/artifact-capabilities.test.js',
  '.compiled/test/main/mcp-persistent-transport.test.js',
  '.compiled/test/integration/execution-control-cancellation.test.js',
];

const log = (...a) => console.log(...a);
const tail = (s, n = 4000) => (s.length > n ? `…\n${s.slice(-n)}` : s);

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd: process.cwd(), shell: process.platform === 'win32', env: process.env });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\n[phase4-verify] killed after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, elapsedMs: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }); });
  });
}

/** Parse `node --test --test-reporter=tap` counters. */
function parseTap(out) {
  const num = (re) => {
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: num(/^# tests (\d+)$/m),
    pass: num(/^# pass (\d+)$/m),
    fail: num(/^# fail (\d+)$/m),
    skipped: num(/^# skipped (\d+)$/m),
  };
}

const doc = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  steps: {},
  suites: [],
};

// ── 1. typecheck ─────────────────────────────────────────────────────────────
log('npm run typecheck');
const tc = await run('npm', ['run', 'typecheck'], 900_000);
fs.writeFileSync(path.join(LOG_DIR, 'typecheck.log'), `${tc.stdout}\n--- stderr ---\n${tc.stderr}`);
doc.steps.typecheck = { code: tc.code, elapsedMs: tc.elapsedMs, tail: tail(tc.stdout + tc.stderr) };
log(`  typecheck exit=${tc.code} (${(tc.elapsedMs / 1000).toFixed(1)}s)`);

// ── 2. compile ───────────────────────────────────────────────────────────────
log('npm run compile');
const cc = await run('npm', ['run', 'compile'], 1_800_000);
fs.writeFileSync(path.join(LOG_DIR, 'compile.log'), `${cc.stdout}\n--- stderr ---\n${cc.stderr}`);
doc.steps.compile = { code: cc.code, elapsedMs: cc.elapsedMs, tail: tail(cc.stdout + cc.stderr) };
log(`  compile exit=${cc.code} (${(cc.elapsedMs / 1000).toFixed(1)}s)`);

// ── 3. focused suites (only when the build produced output) ──────────────────
if (cc.code === 0) {
  for (const suite of SUITES) {
    if (!fs.existsSync(suite)) {
      doc.suites.push({ file: suite, status: 'missing', exitCode: null, tests: null, pass: null, fail: null });
      log(`  MISSING ${suite}`);
      continue;
    }
    log(`node --test ${suite}`);
    const r = await run('node', ['--test', '--test-reporter=tap', suite], 600_000);
    fs.writeFileSync(path.join(LOG_DIR, `${path.basename(suite)}.log`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
    const tap = parseTap(r.stdout);
    doc.suites.push({ file: suite, status: r.code === 0 ? 'pass' : 'fail', exitCode: r.code, elapsedMs: r.elapsedMs, ...tap, tail: r.code === 0 ? undefined : tail(r.stdout + r.stderr) });
    log(`  ${suite}: exit=${r.code} tests=${tap.tests} pass=${tap.pass} fail=${tap.fail}`);
  }
} else {
  doc.suites = SUITES.map((file) => ({ file, status: 'not-run (compile failed)', exitCode: null, tests: null, pass: null, fail: null }));
}

const totals = doc.suites.reduce(
  (acc, s) => ({ tests: acc.tests + (s.tests ?? 0), pass: acc.pass + (s.pass ?? 0), fail: acc.fail + (s.fail ?? 0) + (s.status === 'missing' ? 1 : 0) }),
  { tests: 0, pass: 0, fail: 0 }
);
doc.tests = totals.tests;
doc.pass = totals.pass;
doc.fail = totals.fail;
doc.ok = doc.steps.typecheck.code === 0 && doc.steps.compile.code === 0 && doc.fail === 0 && doc.suites.every((s) => s.status === 'pass');
doc.verdict = doc.ok ? 'PHASE4_VERIFICATION_PASS' : 'PHASE4_VERIFICATION_FAIL';

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
log(`\n${doc.verdict}: suites ${doc.suites.filter((s) => s.status === 'pass').length}/${doc.suites.length} pass, tests ${doc.pass}/${doc.tests}, fail ${doc.fail} -> ${OUT}`);
process.exit(doc.ok ? 0 : 1);
