/**
 * ConPTY teardown-hang repro (Phase 1 gate for the ConPTY flip).
 *
 * Launched as the Electron main script via `node scripts/run-electron.cjs
 * scripts/repro-conpty-hang.cjs`. Spawns a real PTY session through the
 * compiled TerminalManager (backend selected by ANTIFAN_USE_CONPTY, default
 * "1"; set "0" for the winpty control case), produces a burst of shell output,
 * then drives TerminalManager.dispose() + app.quit().
 *
 * Verdict contract:
 *   - exit 0  => the process terminated within QUIT_DEADLINE_MS of the quit
 *                request (clean teardown).
 *   - exit 1  => setup failure, OR the deadline fired with the process still
 *                alive (teardown hang). On hang the still-open handles and
 *                pending requests are dumped before forcing exit.
 *
 * The script deliberately never calls process.exit(0): an early forced exit
 * would mask the very hang this repro exists to prove. The only forced exit is
 * the watchdog's process.exit(1) after the deadline has already been blown.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Backend selection must be settled before TerminalManager is required: the
// manager reads ANTIFAN_USE_CONPTY at spawn time, but keeping it first also
// keeps the repro honest if that lookup ever moves to module load.
if (process.env.ANTIFAN_USE_CONPTY === undefined) {
  process.env.ANTIFAN_USE_CONPTY = '1';
}
process.env.ANTIFAN_BENCHMARK = '1';

const BACKEND = process.env.ANTIFAN_USE_CONPTY === '1' ? 'conpty' : 'winpty';
const QUIT_DEADLINE_MS = 5000;
const DISPOSE_DEADLINE_MS = 15000;
const SHELL_READY_MS = 20000;
const BURST_DEADLINE_MS = 20000;
const BURST_LINES = 4000;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-conpty-repro-'));
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'user-data');
process.env.ANTIFAN_DATA_ROOT = path.join(tempRoot, 'data-root');
process.env.ANTIFAN_CONFIG_DIR = path.join(tempRoot, 'config');
for (const dir of [process.env.ANTIFAN_USER_DATA, process.env.ANTIFAN_DATA_ROOT, process.env.ANTIFAN_CONFIG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', (event) => {
  event.preventDefault();
});
app.setPath('userData', process.env.ANTIFAN_USER_DATA);

const { TerminalManager } = require('../.compiled/src/main/browser/terminal-manager.js');

let quitRequestedAt = 0;
let quitWatchdog = null;

function describeHandle(handle) {
  try {
    const name = handle?.constructor?.name || typeof handle;
    const parts = [name];
    if (typeof handle?.pid === 'number') parts.push(`pid=${handle.pid}`);
    if (typeof handle?.spawnargs !== 'undefined') {
      try { parts.push(`spawnargs=${JSON.stringify(handle.spawnargs).slice(0, 160)}`); } catch {}
    }
    if (typeof handle?.localPort === 'number') parts.push(`localPort=${handle.localPort}`);
    if (typeof handle?.remotePort === 'number') parts.push(`remotePort=${handle.remotePort}`);
    if (typeof handle?.fd === 'number') parts.push(`fd=${handle.fd}`);
    if (typeof handle?.hasRef === 'function') {
      try { parts.push(`refed=${handle.hasRef()}`); } catch {}
    }
    return parts.join(' ');
  } catch {
    return '[unprintable handle]';
  }
}

function dumpActiveWork(phase) {
  console.error(`[repro-conpty-hang] HANG during ${phase} — active handles/requests:`);
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    for (const h of handles) console.error(`  handle: ${describeHandle(h)}`);
    console.error(`  (${handles.length} active handle(s))`);
  } catch (err) {
    console.error(`  handle dump failed: ${err}`);
  }
  try {
    const requests = process._getActiveRequests ? process._getActiveRequests() : [];
    for (const r of requests) console.error(`  request: ${describeHandle(r)}`);
    console.error(`  (${requests.length} active request(s))`);
  } catch (err) {
    console.error(`  request dump failed: ${err}`);
  }
}

function fail(phase, detail) {
  console.error(`[repro-conpty-hang] FAIL backend=${BACKEND} phase=${phase}: ${detail}`);
  dumpActiveWork(phase);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

async function waitForSentinel(getText, sentinel, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (getText().includes(sentinel)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.error(`[repro-conpty-hang] timed out waiting for ${label} (${deadlineMs}ms)`);
  return false;
}

async function run() {
  const tm = TerminalManager.getInstance();
  let received = '';
  tm.on('data', (chunk) => {
    if (chunk && typeof chunk.data === 'string') received += chunk.data;
  });

  const sessionId = tm.createSession(process.cwd());
  console.log(`[repro-conpty-hang] backend=${BACKEND} session=${sessionId} registered=${tm.getDiagnostics().sessions.some((s) => s.sessionId === sessionId)}`);

  // Wait for the shell banner to go quiet so the burst is measured on a live,
  // settled PTY (mirrors the benchmark harness's shell-ready gate).
  const readyDeadline = Date.now() + SHELL_READY_MS;
  let lastLen = 0;
  let lastGrowAt = Date.now();
  while (Date.now() < readyDeadline) {
    if (received.length !== lastLen) {
      lastLen = received.length;
      lastGrowAt = Date.now();
    }
    if (lastLen > 0 && Date.now() - lastGrowAt > 400) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (lastLen === 0) {
    fail('spawn', 'shell produced no output before ready deadline');
    return;
  }

  // Burst: the sentinel is assembled by the shell so input echo cannot fake it.
  const SENT_A = 40001;
  const SENT_B = 7;
  const sentinel = `repro-done-${SENT_A + SENT_B}`;
  const burstCommand = process.platform === 'win32'
    ? `1..${BURST_LINES} | ForEach-Object { "line-$_" }; Write-Output ('repro-done-' + (${SENT_A} + ${SENT_B}))\r`
    : `seq 1 ${BURST_LINES} | sed 's/^/line-/'; printf '%s%s\\n' repro-done- "$((${SENT_A} + ${SENT_B}))"\n`;
  received = '';
  tm.writeTo(sessionId, burstCommand);

  const landed = await waitForSentinel(() => received, sentinel, BURST_DEADLINE_MS, 'burst sentinel');
  console.log(`[repro-conpty-hang] burst landed=${landed} bytes=${Buffer.byteLength(received, 'utf8')}`);

  // Teardown under test. dispose() is raced against its own deadline because a
  // hang inside safelyKillSession must be reported, not awaited forever.
  const disposeResult = await Promise.race([
    tm.dispose().then(() => 'disposed').catch((err) => `dispose-error:${err && err.message ? err.message : err}`),
    new Promise((r) => setTimeout(() => r('dispose-timeout'), DISPOSE_DEADLINE_MS)),
  ]);
  if (disposeResult !== 'disposed') {
    fail('dispose', `TerminalManager.dispose() did not complete: ${disposeResult}`);
    return;
  }
  console.log('[repro-conpty-hang] dispose complete; requesting app.quit()');

  // The watchdog is armed BEFORE app.quit(): if quit (or the event-loop drain
  // after it) hangs, the timer still fires while the loop is alive, dumps the
  // blocking handles, and forces the failing exit code. A clean exit reaps the
  // process before the deadline and the timer never runs.
  quitRequestedAt = Date.now();
  quitWatchdog = setTimeout(() => {
    fail('quit', `process still alive ${Date.now() - quitRequestedAt}ms after app.quit()`);
  }, QUIT_DEADLINE_MS);
  app.quit();
}

process.on('exit', (code) => {
  const quitMs = quitRequestedAt ? Date.now() - quitRequestedAt : -1;
  console.log(`[repro-conpty-hang] exit code=${code} backend=${BACKEND} quitToExitMs=${quitMs}`);
  if (code === 0) {
    console.log(`[repro-conpty-hang] PASS backend=${BACKEND} clean exit ${quitMs}ms after quit (deadline ${QUIT_DEADLINE_MS}ms)`);
  }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

app.whenReady().then(() => run().catch((err) => {
  fail('run', err && err.stack ? err.stack : String(err));
}));
