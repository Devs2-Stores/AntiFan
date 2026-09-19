/**
 * Cookie hard-kill durability smoke (real Electron, isolated data root).
 *
 * Proves the durability claim behind "the session expires very fast, sometimes
 * it holds and sometimes it does not": a cookie set by a page must be on disk
 * shortly after the page goes quiet, so a crash or `taskkill /F` cannot lose it.
 *
 * Experiment design — one kill, two durable partitions, one difference:
 *   1. `persist:profile-afsmoke`   configured through the app's own partition
 *                                  setup → debounced commit armed.
 *   2. `persist:profile-afcontrol` opened directly with `session.fromPartition`
 *                                  → the pre-fix runtime: durable jar, no
 *                                  debounce, commits only on a graceful quit
 *                                  (or Chromium's own ~30s batch timer).
 * The worker is killed with `taskkill /F`, never quits, and never flushes. The
 * armed jar must survive; the control jar must not — that gap is the defect
 * this smoke is about, and the control doubles as the pre-fix reproduction.
 *
 * Usage: npm run smoke:cookie-durability
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'test', 'e2e', 'cookie-hardkill-worker.cjs');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const COOKIE_PORT = Number(process.env.ANTIFAN_SMOKE_COOKIE_PORT || 19311);
/** How long to wait for the app's own durability flush after the page goes quiet. */
const FLUSH_TIMEOUT_MS = 60000;
/** Grace after the flush for the commit to reach the store before the kill. */
const COMMIT_GRACE_MS = 1500;

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

if (!fs.existsSync(ELECTRON)) {
  console.error(`FAIL: Electron binary not found at ${ELECTRON}`);
  process.exit(1);
}

/** Spawns the worker with a real GUI runtime (ELECTRON_RUN_AS_NODE must not leak in). */
function spawnWorker(phase, dataRoot, env = {}) {
  const childEnv = { ...process.env, ...env, ANTIFAN_SMOKE_ROOT: dataRoot, ELECTRON_ENABLE_LOGGING: '0' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [WORKER, `--phase=${phase}`], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  return { child, read: () => ({ stdout, stderr }) };
}

/** Waits until the worker prints `marker`, or the timeout expires. */
function waitForMarker(reader, marker, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (reader().stdout.includes(marker)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Kills the whole process tree: a surviving utility process would hold the cookie DB. */
function hardKill(pid) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
}

async function runVerify(dataRoot) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { child, read } = spawnWorker('verify', dataRoot);
    const done = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 20000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve('exit');
      });
    });
    const { stdout, stderr } = read();
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('VERIFY_JSON:'));
    if (line) {
      return JSON.parse(line.slice('VERIFY_JSON:'.length));
    }
    if (done === 'timeout') hardKill(child.pid);
    console.log(`  verify attempt ${attempt} produced no verdict${stderr ? ` (${stderr.split(/\r?\n/)[0]})` : ''}`);
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

(async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cookie-hardkill-'));
  console.log(`Data root: ${dataRoot}`);
  try {
    // 1. Set phase: a real page sets both cookies from one HTTP response.
    const set = spawnWorker('set', dataRoot);
    const ready = await waitForMarker(set.read, 'PHASE_SET_READY', 45000);
    const setOut = set.read().stdout;
    const setJson = setOut.split(/\r?\n/).find((l) => l.startsWith('SET_JSON:'));
    const setReport = setJson ? JSON.parse(setJson.slice('SET_JSON:'.length)) : null;
    check(
      'both jars held the page-set cookie before the kill',
      Boolean(setReport && setReport.armedBefore === 'armed_value' && setReport.controlBefore === 'control_value'),
      setJson || 'no SET_JSON line',
    );
    check(
      'the production configure path armed durability on the durable jar',
      Boolean(setReport && setReport.armedReArm === false),
      setReport ? `re-arm returned ${setReport.armedReArm}` : 'no SET_JSON line',
    );
    if (!ready) {
      console.error(set.read().stderr || '(no stderr)');
      check('worker reached PHASE_SET_READY', false);
      throw new Error('set phase did not become ready');
    }

    // 2. Kill at the point the mechanism decides: the worker reports the app's
    // own durability flush, then a short grace lets the commit land. A fixed
    // delay was measured to flake under CPU contention, and the commit cannot be
    // observed from here at all — Chromium holds the cookie store with an
    // exclusive lock, so reading or copying it returns EBUSY (measured).
    const flushed = await waitForMarker(set.read, 'FLUSH_OBSERVED', FLUSH_TIMEOUT_MS);
    check('the app flushed the durable jar before the kill', flushed, 'FLUSH_OBSERVED marker');
    await new Promise((r) => setTimeout(r, COMMIT_GRACE_MS));
    hardKill(set.child.pid);
    console.log('Killed the app with taskkill /F (no graceful quit, no flushStore).');
    await new Promise((r) => setTimeout(r, 1200));

    // 3. Verify phase in a fresh process.
    const verdict = await runVerify(dataRoot);
    if (!verdict) {
      check('a verify process produced a verdict', false);
      throw new Error('verify phase produced no verdict');
    }
    check(
      'armed jar survived the hard kill',
      verdict.armed && verdict.armed.value === 'armed_value',
      verdict.armed ? `value=${verdict.armed.value}` : 'cookie missing',
    );
    check(
      'control jar (pre-fix runtime: no debounce) lost the cookie',
      verdict.control === null,
      verdict.control ? `still present (value=${verdict.control.value})` : 'missing, as the defect predicts',
    );
  } catch (err) {
    console.error('FAIL: unexpected error:', err && err.stack ? err.stack : String(err));
    failed = 1;
  } finally {
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {}
  }
  console.log(failed === 0 ? 'SMOKE_COOKIE_DURABILITY: PASSED' : 'SMOKE_COOKIE_DURABILITY: FAILED');
  process.exit(failed);
})();
