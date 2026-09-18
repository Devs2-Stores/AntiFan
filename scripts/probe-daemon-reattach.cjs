/**
 * Daemon re-attach probe — the P0 goal, tested through the production code path.
 *
 * Two separate OS processes, run in sequence:
 *
 *   phase 1  ensureDaemon()  -> spawns the host (L1 detached), drives a real command through
 *                               DaemonTerminalProxy, then EXITS. The host must not.
 *   phase 2  ensureDaemon()  -> must report 'attached' (L0 re-attach), and the session must still
 *                               hold the marker phase 1 wrote, in the same shell, same cwd.
 *
 * This is the whole point of the daemon: a GUI restart is exactly "process 1 exits, process 2
 * starts", so proving it here proves the feature. Both phases use the real spawner and the real
 * client proxy from .compiled — nothing is stubbed.
 *
 * Phase 2 also asserts the re-attach path did NOT spawn a second host: the pid must be identical.
 * A "re-attach" that silently starts a fresh host would lose every session and still look green.
 *
 * Run: node scripts/probe-daemon-reattach.cjs --phase=1   (then)
 *      node scripts/probe-daemon-reattach.cjs --phase=2
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const COMPILED = path.join(ROOT, '.compiled', 'src', 'main', 'terminal-daemon');

const probeDir = process.env.PROBE_DIR || path.join(os.tmpdir(), 'antifan-daemon-reattach');
const stateFile = path.join(probeDir, 'phase1.json');
const markerDir = path.join(probeDir, 'markers');
const phase = Number((process.argv.find((a) => a.startsWith('--phase=')) || '--phase=1').split('=')[1]);

/**
 * Isolated data AND config root: `ANTIFAN_DATA_ROOT` redirects the daemon's own records, and
 * `ANTIFAN_CONFIG_DIR` redirects the terminal session journal TerminalManager reads at startup.
 * Without the second one the host restores the developer's real saved sessions, so the probe would
 * be testing against live state instead of its own.
 */
process.env.ANTIFAN_DATA_ROOT = probeDir;
process.env.ANTIFAN_CONFIG_DIR = probeDir;

const { execFileSync } = require('node:child_process');

/**
 * The spawner only starts a host it can find a staged bundle for. Staging into the probe's own data
 * root keeps the whole run isolated: its own version directory, its own daemon record, no chance of
 * attaching to (or being mistaken for) a daemon the developer has running.
 */
function ensureStagedBundle() {
  const pointer = path.join(probeDir, 'daemon-host', 'current.json');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
      cwd: ROOT,
      // A staging failure reported as bare "Command failed" cannot be triaged; the child's stderr
      // names the file and the errno.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTIFAN_DATA_ROOT: probeDir },
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`staging failed: ${stderr || (err && err.message ? err.message : err)}`);
  }
  if (!fs.existsSync(pointer)) throw new Error(`staging did not publish ${pointer}`);
}

const { ensureDaemon } = require(path.join(COMPILED, 'daemon-spawner.js'));
const { DaemonTerminalProxy } = require(path.join(COMPILED, 'daemon-client.js'));

/**
 * A child process of the shell, used to prove the whole PTY tree survives — not just the shell.
 *
 * It writes its own pid once and then appends a timestamp every 900ms, so phase 2 can assert both
 * that the SAME process is still running (pid match) and that it is still doing work (file grows).
 * A surviving shell with a dead child would satisfy "scrollback is intact" while failing the goal.
 *
 * Written as CommonJS: node treats `.mjs` as ESM, where `require` is undefined and the child would
 * die on its first line — a failure that looks exactly like "the child did not survive".
 */
const HEARTBEAT_SCRIPT = `
const fs = require('node:fs');
const out = process.argv[2];
fs.writeFileSync(out + '.pid', String(process.pid));
setInterval(() => fs.appendFileSync(out, Date.now() + '\\n'), 900);
`;

const checks = [];
let spawnedPid = 0; // tracked so a failed phase 1 cannot leak the host it started
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  try { require('node:child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already gone */ }
}

/** Wait until the transcript contains the text (the shell echoes asynchronously). */
async function waitForBuffer(proxy, sessionId, needle, timeoutMs = 20000) {
  const plain = (s) => s.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  // The echo comes back through the PTY, which wraps at the terminal width, so a needle can be
  // split across two lines and never appear contiguously. Collapsing line breaks is what keeps the
  // wait independent of the path length that decides where the wrap lands.
  const flat = (s) => plain(s).replace(/\r?\n/g, '');
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (Date.now() < deadline) {
    const r = await proxy.getFullBuffer(sessionId);
    buffer = r && r.buffer ? r.buffer : '';
    if (flat(buffer).includes(needle)) return { found: true, buffer };
    await delay(250);
  }
  return { found: false, buffer };
}

/**
 * Wait for a file the SHELL was asked to create.
 *
 * The transcript only proves the command was echoed — the echo lands before execution finishes, so
 * asserting on it immediately reports success for a command that never ran. The file is the
 * side effect, and only the side effect proves the shell actually executed the input.
 */
async function waitForFile(file, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await delay(250);
  }
  return false;
}

async function run() {
  let exitCode = 0;
  let prior;
  const extraPids = [];
  try {
    if (phase === 1) {
      fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      ensureStagedBundle();

      const spawned = await ensureDaemon({ cwd: probeDir });
      record('ensureDaemon brought up a host', spawned.mode !== 'in-process', `mode=${spawned.mode}${spawned.reason ? ` reason=${spawned.reason}` : ''}`);
      if (spawned.mode === 'in-process') throw new Error('no host; cannot test survival');

      const { handle } = spawned;
      spawnedPid = handle.pid;
      record('host pid is alive', alive(handle.pid), `pid=${handle.pid} port=${handle.port}`);

      // Edge-case coverage (U33): token mismatch rejection before connecting authorized proxy
      const badProxy = new DaemonTerminalProxy({ port: handle.port, token: 'invalid-token-mismatch' });
      let tokenRejected = false;
      try {
        await badProxy.connect();
      } catch {
        tokenRejected = true;
      } finally {
        badProxy.dispose();
      }
      record('invalid token rejected by host (token mismatch rejection)', tokenRejected);

      const proxy = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
      await proxy.connect();

      const ping = await proxy.ping();
      record('proxy authenticates and pings the host', ping.pong === true, `host pid=${ping.pid}`);

      const sessions = await proxy.listSessions();
      record('host started with only this probe\'s session', sessions.length === 1,
        `${sessions.length} session(s) — 1 means the isolated config dir took effect`);
      const activeId = await proxy.getActiveSessionId();

      const ready = await proxy.waitReady(activeId, 20000);
      record('shell reached a prompt (input gating)', ready === true);

      const marker = path.join(markerDir, 'phase1.txt');
      fs.rmSync(marker, { force: true });
      await proxy.writeTo(activeId, `Add-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value survived-gui-restart\r`);

      const seen = await waitForBuffer(proxy, activeId, 'survived-gui-restart');
      record('command output appears in the transcript', seen.found);
      record('marker file written by the shell', await waitForFile(marker));

      /* ---- a real child process of the shell, started through the PTY ---- */
      const hbScript = path.join(probeDir, 'heartbeat.cjs');
      const hbFile = path.join(markerDir, 'heartbeat.txt');
      fs.writeFileSync(hbScript, HEARTBEAT_SCRIPT, { mode: 0o600 });
      try { fs.chmodSync(hbScript, 0o600); } catch { /* best effort */ }
      fs.rmSync(hbFile, { force: true });
      fs.rmSync(`${hbFile}.pid`, { force: true });

      // Start-Process makes the child a descendant of the shell, so its survival is the PTY tree's.
      const escHbScript = hbScript.replace(/'/g, "''");
      const escHbFile = hbFile.replace(/'/g, "''");
      await proxy.writeTo(activeId,
        `$p = Start-Process -PassThru -WindowStyle Hidden node -ArgumentList '${escHbScript}','${escHbFile}'; $p.Id | Set-Content -LiteralPath '${escHbFile}.pid'\r`);

      record('child process started under the shell', await waitForFile(`${hbFile}.pid`));
      const childPid = Number(fs.readFileSync(`${hbFile}.pid`, 'utf8').trim());
      record('child heartbeat is running', await waitForFile(hbFile));

      const childSizeA = fs.existsSync(hbFile) ? fs.statSync(hbFile).size : 0;
      await delay(2000);
      const childSizeB = fs.existsSync(hbFile) ? fs.statSync(hbFile).size : 0;
      record('child is actively working (heartbeat grows)', childSizeB > childSizeA, `${childSizeA} -> ${childSizeB} bytes`);

      fs.writeFileSync(stateFile, JSON.stringify({
        pid: handle.pid,
        port: handle.port,
        token: handle.token,
        version: handle.version,
        activeId,
        marker,
        childPid,
        heartbeat: hbFile,
        mode: spawned.mode,
        at: Date.now(),
      }, null, 2), { mode: 0o600 });
      try { fs.chmodSync(stateFile, 0o600); } catch { /* best effort */ }

      const ok = checks.every((c) => c.pass);
      // A failed phase has nothing to hand over, and a host left behind keeps the staged tree it
      // runs from locked for every later probe. Only a green phase 1 leaves the host for phase 2,
      // and only a host that still answers on this probe's token is killed - a dead pid can be
      // reused, and a reused number must not be killed because it once belonged to this host.
      if (!ok) {
        let live = false;
        try { live = (await proxy.ping()).pong === true; } catch { /* host already gone */ }
        if (live) {
          killTree(handle.pid);
          await delay(1000);
        }
      }
      proxy.dispose();
      console.log(ok
        ? `\nPhase 1 complete: host pid=${handle.pid} left running for phase 2.`
        : `\nPhase 1 failed: host pid=${handle.pid} torn down; state file kept at ${stateFile}.`);
      console.log(`PROBE_RESULT ${JSON.stringify({ phase, ok, checks })}`);
      return ok ? 0 : 1;
    }
    /* ---------------- phase 2 ---------------- */
    prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    const resumed = await ensureDaemon({ cwd: probeDir });
    record('ensureDaemon re-attached instead of spawning', resumed.mode === 'attached', `mode=${resumed.mode}${resumed.reason ? ` reason=${resumed.reason}` : ''}`);
    record('re-attached to the SAME host process', resumed.handle && resumed.handle.pid === prior.pid,
      `prior=${prior.pid} now=${resumed.handle ? resumed.handle.pid : 'none'}`);

    // Edge-case coverage (U33): token mismatch rejection against re-attached host
    const badProxy2 = new DaemonTerminalProxy({ port: resumed.handle.port, token: 'invalid-token-reattach' });
    let tokenRejected2 = false;
    try {
      await badProxy2.connect();
    } catch {
      tokenRejected2 = true;
    } finally {
      badProxy2.dispose();
    }
    record('post-reattach invalid token rejected (token mismatch rejection)', tokenRejected2);

    const proxy = new DaemonTerminalProxy({ port: resumed.handle.port, token: resumed.handle.token });
    await proxy.connect();

    const sessions = await proxy.listSessions();
    record('sessions survived the first process exit', sessions.length > 0, `${sessions.length} session(s)`);

    const seen = await waitForBuffer(proxy, prior.activeId, 'survived-gui-restart', 5000);
    record('scrollback from the previous process is still present', seen.found);

    record('shell-created file outlived the first process', fs.existsSync(prior.marker));

    // The shell must still accept input after the GUI-side process was replaced entirely.
    const second = path.join(markerDir, 'phase2.txt');
    fs.rmSync(second, { force: true });
    const ready = await proxy.waitReady(prior.activeId, 20000);
    record('shell still accepts input after re-attach', ready === true);
    if (ready) {
      await proxy.writeTo(prior.activeId, `Add-Content -LiteralPath '${second.replace(/'/g, "''")}' -Value reattached-ok\r`);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !fs.existsSync(second)) await delay(250);
      record('post-reattach command executed', fs.existsSync(second));
    }

    proxy.dispose();

    /* ---- the goal's hardest clause: the same CHILD process is still running ---- */
    record('child process outlived the first process (same pid alive)', alive(prior.childPid), `child pid=${prior.childPid}`);
    const sizeA = fs.existsSync(prior.heartbeat) ? fs.statSync(prior.heartbeat).size : 0;
    await delay(2000);
    const sizeB = fs.existsSync(prior.heartbeat) ? fs.statSync(prior.heartbeat).size : 0;
    record('child is still working after re-attach (heartbeat grows)', sizeB > sizeA, `${sizeA} -> ${sizeB} bytes`);

    // Cleanup: this probe owns the host it started, so it must also prove it can take it down.
    killTree(prior.pid);
    await delay(1500);
    record('host terminated by the probe (no orphan left)', !alive(prior.pid), `pid=${prior.pid}`);
    record('shell child died with the host (teardown is not leaky)', !alive(prior.childPid), `child pid=${prior.childPid}`);

    // Edge-case coverage (U33): stale socket recovery and crashed host re-spawning
    // The previous host (prior.pid) was killed above, so the live record points to a dead PID / stale socket.
    // ensureDaemon must detect the dead host / stale socket, clear it, and re-spawn a fresh host.
    const liveRecord = path.join(probeDir, 'daemon-host', 'daemon.json');
    const respawned = await ensureDaemon({ cwd: probeDir });
    if (respawned && respawned.handle && respawned.handle.pid) {
      extraPids.push(respawned.handle.pid);
    }
    record('stale socket cleared and fresh host respawned (crashed host re-spawning)',
      respawned.mode !== 'attached' && respawned.handle && respawned.handle.pid !== prior.pid,
      `mode=${respawned.mode} newPid=${respawned.handle ? respawned.handle.pid : 'none'}`);

    if (respawned.handle && respawned.handle.pid) {
      killTree(respawned.handle.pid);
      await delay(500);
      record('respawned host terminated cleanly', !alive(respawned.handle.pid), `pid=${respawned.handle.pid}`);
    }

    // Edge-case coverage (U33): corrupted state file recovery
    // Malformed JSON in the daemon live record must be handled gracefully without crashing ensureDaemon
    let corruptHandled = false;
    try {
      fs.writeFileSync(liveRecord, '{ "broken": true, invalid-json', { mode: 0o600 });
      const corruptRes = await ensureDaemon({ cwd: probeDir });
      if (corruptRes && corruptRes.handle && corruptRes.handle.pid) {
        extraPids.push(corruptRes.handle.pid);
      }
      corruptHandled = corruptRes.mode !== 'attached' && corruptRes.handle && alive(corruptRes.handle.pid);
      if (corruptRes.handle && corruptRes.handle.pid) {
        killTree(corruptRes.handle.pid);
        await delay(500);
      }
    } catch {
      corruptHandled = false;
    }
    record('corrupted state file recovered without crashing', corruptHandled);

    console.log(`\nPROBE_RESULT ${JSON.stringify({ phase, ok: checks.every((c) => c.pass), checks })}`);
    return checks.every((c) => c.pass) ? 0 : 1;
  } catch (err) {
    // A failed phase must not leave the host it started behind as an orphan.
    if (spawnedPid) {
      killTree(spawnedPid);
      await delay(500);
    }
    if (prior) {
      if (prior.pid) killTree(prior.pid);
      if (prior.childPid) killTree(prior.childPid);
      await delay(500);
    }
    for (const pid of extraPids) {
      if (pid) killTree(pid);
    }
    console.error(`PROBE_ERROR ${err && err.stack ? err.stack : err}`);
    exitCode = 1;
  }
  console.log(`PROBE_RESULT ${JSON.stringify({ phase, ok: false, checks })}`);
  return exitCode;
}

run().then((code) => process.exit(code));
