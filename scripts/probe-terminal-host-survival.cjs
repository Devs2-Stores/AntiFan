/**
 * Terminal Host Survival Probe — live proof that a detached headless host owns PTYs
 * independently of the process that spawned it.
 *
 * This is the cheapest kill-test for the terminal-daemon plan. The plan's whole premise is
 * "a detached host keeps the shell alive when the GUI goes away", and that premise rests on
 * two facts that must be measured, never assumed:
 *
 *   1. The compiled TerminalManager loads and spawns a PTY under ELECTRON_RUN_AS_NODE=1
 *      (i.e. the terminal subsystem is genuinely Electron-free).
 *   2. The PTY's child process outlives the process that spawned the host — proven with a
 *      RELAY, not a self-report: the relay spawns the host detached and exits immediately, so
 *      "host still alive afterwards" is an observation about the host, not a claim by it.
 *
 * Modes:
 *   --relay   spawns the host detached and exits at once (the parent that must die)
 *   --host    internal: the detached host itself (Electron-as-Node)
 *   (none)    orchestrator: relay -> wait ready -> prove ticks still advancing
 *
 * Run: node scripts/probe-terminal-host-survival.cjs
 * Exit 0 only when the host survives the relay's exit AND the PTY keeps producing output.
 * A failure prints PROBE_RESULT with the readings that failed.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const LOG = '[Terminal Host Survival Probe]';

const MODE = process.argv.includes('--host')
  ? 'host'
  : process.argv.includes('--relay')
    ? 'relay'
    : 'orchestrator';

const PROBE_DIR = process.env.ANTIFAN_PROBE_DIR || '';
const READY = PROBE_DIR ? path.join(PROBE_DIR, 'ready.json') : '';
const ARMED = PROBE_DIR ? path.join(PROBE_DIR, 'armed.json') : '';
const TICKS = PROBE_DIR ? path.join(PROBE_DIR, 'ticks.txt') : '';
const BEAT = PROBE_DIR ? path.join(PROBE_DIR, 'heartbeat.txt') : '';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
// PowerShell's prompt once the shell is actually reading stdin. A trailing `>` on its own line
// is what distinguishes "prompt is up" from "banner just finished printing".
const SHELL_PROMPT_RE = /(?:^|\n)\s*(?:PS\s[^\n>]*)?>\s*$/;

/**
 * Synchronous and verified: a detached host that survives cleanup holds Windows file locks on the
 * dev workspace — the very EBUSY hazard this design exists to avoid — so "spawn taskkill and hope"
 * is not acceptable teardown. Two earlier probe runs leaked a host each because the async
 * `taskkill` had not started before `process.exit` tore the orchestrator down.
 */
function killTree(pid) {
  if (!pid) return false;
  const { execFileSync } = require('node:child_process');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // taskkill exits non-zero when the process is already gone, which is the success case here.
    }
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

/* --------------------------------------------------------------------- host --- */

async function runHost() {
  // Published before anything that can fail, so the orchestrator can always reap this host even
  // when the boot fails early. Without it a failed boot leaves a detached host holding locks.
  fs.writeFileSync(path.join(PROBE_DIR, 'host.pid'), String(process.pid));

  // Failure-path hook. The teardown leak that this probe actually suffered happened when the host
  // died before `ready.json` existed, so the reaper must be exercisable without editing the file.
  if (process.env.ANTIFAN_PROBE_FORCE_FAIL === '1') {
    throw new Error('forced failure (ANTIFAN_PROBE_FORCE_FAIL=1)');
  }

  const { TerminalManager } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'terminal-manager.js'));
  const tm = TerminalManager.getInstance();

  const started = tm.startTerminal(PROBE_DIR);
  if (!started) throw new Error('TerminalManager.startTerminal refused to start the probe session');

  const sessionId = tm.getActiveSessionId();
  const session = tm.getSession(sessionId);
  const childPid = session && session.pty ? session.pty.pid : undefined;

  fs.writeFileSync(READY, JSON.stringify({
    daemonPid: process.pid,
    sessionId,
    childPid,
    startedAt: Date.now(),
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
  }, null, 2));

  // Input written before the shell reads stdin is dropped by ConPTY — measured directly against
  // node-pty 1.1.0 (a bare `pty.write` at spawn+2000ms vanished while the same write succeeded
  // once the prompt was up). The banner is NOT a readiness signal: it is emitted before the
  // prompt, so waiting on "any output" still lands inside the drop window. Gate on the prompt.
  let prompted = false;
  for (let i = 0; i < 120; i++) {
    let text = '';
    try { text = tm.getFullBuffer(sessionId).buffer; } catch {}
    if (SHELL_PROMPT_RE.test(stripAnsi(text).slice(-400))) { prompted = true; break; }
    await delay(125);
  }
  if (!prompted) throw new Error('shell never presented a prompt within 15s');

  // A shell job that keeps producing output, so "still running" is observable as growth
  // rather than as a process that merely has not been reaped yet.
  const ticks = TICKS.replace(/'/g, "''");
  tm.writeTo(sessionId, `1..900 | ForEach-Object { Add-Content -LiteralPath '${ticks}' -Value $_; Start-Sleep -Milliseconds 400 }\r`);

  // The command is only really in flight once the shell has echoed it. Publishing "armed" any
  // earlier would let the orchestrator measure a window in which the job had not started yet,
  // which reads as a dead host when it is merely a slow one.
  for (let i = 0; i < 80; i++) {
    let text = '';
    try { text = stripAnsi(tm.getFullBuffer(sessionId).buffer); } catch {}
    if (text.includes('ForEach-Object') && /PS [^\n>]*>\s*$/.test(text.slice(-400))) break;
    await delay(125);
  }
  fs.writeFileSync(ARMED, JSON.stringify({ armedAt: Date.now() }));

  const beat = setInterval(() => {
    try { fs.appendFileSync(BEAT, `${Date.now()}\n`); } catch {}
  }, 300);
  beat.unref?.();
}

/* -------------------------------------------------------------------- relay --- */

function runRelay() {
  const electronBin = require('electron');
  const host = spawn(electronBin, [__filename, '--host'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ANTIFAN_PROBE_DIR: PROBE_DIR,
      ANTIFAN_DATA_ROOT: PROBE_DIR,
      ANTIFAN_CONFIG_DIR: PROBE_DIR,
    },
  });
  host.unref();
  // Exit immediately: from here on the host must live on its own.
  process.exit(0);
}

/* ------------------------------------------------------------- orchestrator --- */

function readTicks(dir) {
  try { return fs.readFileSync(path.join(dir, 'ticks.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
function readBeat(dir) {
  try {
    const l = fs.readFileSync(path.join(dir, 'heartbeat.txt'), 'utf8').split('\n').filter(Boolean);
    return l.length ? Number(l[l.length - 1]) : 0;
  } catch { return 0; }
}
/**
 * `force: true` suppresses ENOENT, not the Windows window where a just-killed PowerShell still
 * holds handles on the files it was writing. Without the retry a successful run leaves its probe
 * directory behind, so removal is retried briefly and the outcome is reported rather than assumed.
 */
function removeDirWithRetry(dir) {
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return true;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125);
    } catch {
      const end = Date.now() + 125;
      while (Date.now() < end) { /* bounded busy-wait */ }
    }
  }
  return !fs.existsSync(dir);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function runOrchestrator() {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-host-survival-'));
  let hostPid = 0;
  let relayPid = 0;
  let exitCode = 0;

  try {
    await new Promise((resolve, reject) => {
      const relay = spawn(process.execPath, [__filename, '--relay'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ANTIFAN_PROBE_DIR: probeDir },
      });
      relayPid = relay.pid;
      relay.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`relay exited ${code}`))));
      relay.on('error', reject);
    });

    let ready = null;
    for (let i = 0; i < 60; i++) {
      // A host that failed before publishing ready.json must not be waited out — reap it as soon
      // as it is observably gone, using the pid file it always writes first.
      let pidOnly = 0;
      try { pidOnly = Number(fs.readFileSync(path.join(probeDir, 'host.pid'), 'utf8')); } catch {}
      if (pidOnly && !alive(pidOnly)) {
        hostPid = pidOnly;
        let hostErr = '';
        try { hostErr = fs.readFileSync(path.join(probeDir, 'host-error.txt'), 'utf8'); } catch {}
        throw new Error(`host exited before ready.json: ${hostErr || '(no host-error.txt)'}`);
      }
      try { ready = JSON.parse(fs.readFileSync(path.join(probeDir, 'ready.json'), 'utf8')); break; } catch { await delay(250); }
    }
    if (!ready) throw new Error('host never published ready.json within 15s');
    hostPid = ready.daemonPid;

    let armed = null;
    for (let i = 0; i < 120; i++) {
      try { armed = JSON.parse(fs.readFileSync(path.join(probeDir, 'armed.json'), 'utf8')); break; } catch { await delay(250); }
    }
    if (!armed) throw new Error('host never confirmed the shell accepted input within 30s');

    // The relay (the host's parent) has already exited by now — its `exit` event is what
    // released the promise above. Establish the baseline only after that point so every
    // reading describes post-parent-death behaviour.
    const relayDead = relayPid ? !alive(relayPid) : true;
    const ticks1 = readTicks(probeDir);
    const beat1 = readBeat(probeDir);

    await delay(2500);

    const ticks2 = readTicks(probeDir);
    const beat2 = readBeat(probeDir);
    const hostAlive = alive(hostPid);
    const childAlive = ready.childPid ? alive(ready.childPid) : false;
    let hostError = null;
    try { hostError = fs.readFileSync(path.join(probeDir, 'host-error.txt'), 'utf8'); } catch {}

    const ok = relayDead && hostAlive && childAlive && ticks2 > ticks1 && beat2 > beat1;
    if (hostError) console.log(`${LOG} host-error: ${hostError}`);
    console.log(
      `${LOG} host=${hostPid} child=${ready.childPid} hostAlive=${hostAlive} childAlive=${childAlive}`
      + ` ticks=${ticks1}->${ticks2} heartbeat=${beat1}->${beat2} relayExited=${relayDead}`
    );
    console.log(`PROBE_RESULT ${JSON.stringify({ ok, relayPid, ...ready, hostAlive, childAlive, relayDead, ticks1, ticks2, beat1, beat2, hostError })}`);
    if (!ok) exitCode = 1;
  } catch (err) {
    console.log(`${LOG} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`PROBE_RESULT ${JSON.stringify({ ok: false, error: String(err) })}`);
    exitCode = 1;
  } finally {
    // Prefer the pid file: it exists even when boot failed before ready.json was written.
    if (!hostPid) {
      try { hostPid = Number(fs.readFileSync(path.join(probeDir, 'host.pid'), 'utf8')); } catch {}
    }
    const reaped = killTree(hostPid);
    if (!reaped) console.log(`${LOG} WARNING: host ${hostPid} survived teardown`);
    if (!removeDirWithRetry(probeDir)) console.log(`${LOG} WARNING: probe dir ${probeDir} survived teardown`);
    process.exit(exitCode);
  }
}

if (MODE === 'host') {
  runHost().catch((err) => {
    try { fs.writeFileSync(path.join(PROBE_DIR, 'host-error.txt'), String(err && err.stack || err)); } catch {}
    process.exit(1);
  });
} else if (MODE === 'relay') {
  runRelay();
} else {
  runOrchestrator();
}
