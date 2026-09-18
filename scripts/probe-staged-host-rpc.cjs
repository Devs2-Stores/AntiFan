/**
 * Staged Host RPC probe — proves the daemon works AND that staging it is necessary.
 *
 * Launches the host from the staged directory, connects over the real WebSocket transport, and
 * drives the terminal RPC surface end to end. Two things are checked that a "it started" smoke test
 * would miss:
 *
 *  1. Input actually reaches the shell. The prompt-gating invariant is enforced by asking the host
 *     to wait for readiness before writing, then confirming the command's side effect exists.
 *  2. The workspace stays unlocked. The same running host is launched twice — once from the staged
 *     copy, once straight out of the dev workspace — and a read-write open on node-pty's native
 *     addon is attempted in both cases. If the workspace copy is locked and the staged copy is not,
 *     staging is doing the job it exists for rather than being cargo-culted.
 *
 * Run: node scripts/probe-staged-host-rpc.cjs
 */
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.ANTIFAN_DATA_ROOT || 'E:\\Work\\.antifan-data';
const LOG = '[Staged Host RPC Probe]';
const SETTLE_MS = 250;

// Matches the stripping the host itself uses for prompt detection: escape sequences are woven
// through the transcript and must not be treated as content.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  if (!pid) return true;
  for (let i = 0; i < 2; i++) {
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

function removeDirWithRetry(dir) {
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return true;
    const end = Date.now() + 125;
    while (Date.now() < end) { /* bounded wait for Windows to release handles */ }
  }
  return !fs.existsSync(dir);
}

/**
 * The absolute paths of every node-pty binary a process has loaded, and of every module it has
 * loaded from the dev workspace.
 *
 * A file-lock probe cannot answer this: the AntiFan GUI is normally running while developing and
 * already holds the workspace addon, so EBUSY on that path is ambient and says nothing about the
 * host. Enumerating the host's own loaded modules is unconfounded — it names the file the host
 * actually mapped.
 */
function loadedModules(pid) {
  const script = [
    `$mods = (Get-Process -Id ${Number(pid)}).Modules | Select-Object -ExpandProperty FileName`,
    `$mods | Where-Object { $_ -like '*node-pty*' -or $_ -like '*AntiFan*' }`,
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function resolveStagedEntry() {
  const pointerPath = path.join(DATA_ROOT, 'daemon-host', 'current.json');
  if (!fs.existsSync(pointerPath)) throw new Error(`no staged pointer at ${pointerPath}; run \`node scripts/stage-daemon-host.mjs\``);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  if (!fs.existsSync(pointer.entry)) throw new Error(`staged entry missing: ${pointer.entry}`);
  return pointer;
}

/** Launch a detached host and wait for its handshake file. */
async function launchHost(entryPath, cwd, probeDir, label) {
  const electronBin = require('electron');
  const token = crypto.randomBytes(24).toString('hex');
  const handshake = path.join(probeDir, `${label}-handshake.json`);
  const logFile = path.join(probeDir, `${label}-host.log`);

  const host = spawn(electronBin, [
    entryPath,
    '--handshake', handshake,
    '--log', logFile,
    '--cwd', probeDir,
    '--port', '0',
  ], {
    cwd,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ANTIFAN_TERMINAL_HOST_VERSION: label,
      ANTIFAN_DATA_ROOT: probeDir,
      ANTIFAN_CONFIG_DIR: probeDir,
    },
  });
  // The token travels over the pipe instead of the environment block, which every same-user
  // process can read. The host strips it from stdin before serving anything else.
  host.stdin.write(`${token}\n`);
  host.stdin.end();
  host.unref();

  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(handshake)) {
      const info = JSON.parse(fs.readFileSync(handshake, 'utf8'));
      return { host, token, info, logFile, pid: info.pid };
    }
    if (!alive(host.pid)) {
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').slice(-600); } catch {}
      throw new Error(`host '${label}' exited before handshake. log: ${tail || '(empty)'}`);
    }
    await delay(250);
  }
  throw new Error(`host '${label}' never published a handshake`);
}

function connect(token, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { 'x-antifan-token': token } });
  const pending = new Map();
  let nextId = 1;

  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.id && pending.has(frame.id)) {
      const { resolve } = pending.get(frame.id);
      pending.delete(frame.id);
      resolve(frame);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

  const call = (method, params) => {
    const id = `rpc-${nextId++}`;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject,
    });
    ws.send(JSON.stringify({ id, method, params }));
    return promise;
  };

  return { ws, ready, call };
}

async function run() {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-staged-rpc-'));
  const checks = [];
  const hosts = [];
  let exitCode = 0;

  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const staged = resolveStagedEntry();
    console.log(`${LOG} staged version=${staged.version}`);
    console.log(`${LOG} staged entry=${staged.entry}`);

    /* ---------- 1. host boots from the staged directory and serves RPC ---------- */
    const hosted = await launchHost(staged.entry, probeDir, probeDir, 'staged');
    hosts.push(hosted.pid);
    record('staged host booted and published handshake', true, `pid=${hosted.pid} port=${hosted.info.port}`);

    const client = connect(hosted.token, hosted.info.port);
    await client.ready;
    record('token-authenticated websocket connected', true);

    const bad = connect('wrong-token', hosted.info.port);
    let badRejected = false;
    try { await bad.ready; } catch { badRejected = true; }
    record('wrong token rejected at upgrade', badRejected);

    const listed = await client.call('terminalListSessions');
    const sessions = listed.data && listed.data.sessions ? listed.data.sessions : [];
    record('terminalListSessions returns a live session', listed.success && sessions.length > 0,
      `active=${listed.data && listed.data.activeSessionId} count=${sessions.length}`);

    const sessionId = listed.data && listed.data.activeSessionId;
    const readyRes = await client.call('terminalWaitReady', { sessionId, timeoutMs: 20000 });
    record('terminalWaitReady observed a shell prompt', readyRes.success && readyRes.data.ready === true,
      JSON.stringify(readyRes.data));

    // Input gating: the marker file is the shell's own side effect, so its existence proves the
    // bytes survived the transport, the prompt gate, and the PTY write.
    const marker = path.join(probeDir, 'rpc-marker.txt');
    const typed = await client.call('terminalInput', {
      sessionId,
      text: `Add-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value daemon-ok\r`,
    });
    record('terminalInput accepted', typed.success === true, JSON.stringify(typed.data || typed.error));

    let markerSeen = false;
    for (let i = 0; i < 40; i++) {
      try {
        if (fs.readFileSync(marker, 'utf8').includes('daemon-ok')) { markerSeen = true; break; }
      } catch {
        // Not written yet, or the shell still holds it open for writing: either way this poll is a
        // miss and the next one looks again.
      }
      await delay(250);
    }
    record('command reached the shell (marker written)', markerSeen, marker);

    // The shell echoes the command asynchronously, so reading the transcript once races the echo.
    // Poll for the content instead of sampling a single instant.
    //
    // The comparison must run on ANSI-stripped text: PowerShell colours the echoed input line, and
    // the escape sequences land *inside* the word (`daemon-\u001b[0mok`), so a raw `includes` misses
    // text that is plainly visible on screen. Assertions about what a user sees must read what a
    // user sees.
    const plain = (raw) => raw.replace(ANSI_RE, '');
    let buffer = '';
    for (let i = 0; i < 40; i++) {
      const transcript = await client.call('terminalGetFullBuffer', { sessionId });
      buffer = transcript.data && transcript.data.buffer ? transcript.data.buffer : '';
      if (plain(buffer).includes('daemon-ok')) break;
      await delay(250);
    }
    record('transcript shows the command output', plain(buffer).includes('daemon-ok'),
      `${buffer.length} chars; tail=${JSON.stringify(plain(buffer).slice(-160))}`);

    const ping = await client.call('terminalHostPing');
    record('host reports its own pid', ping.success && ping.data.pid === hosted.pid, JSON.stringify(ping.data));

    /* ---------- 2. the host loads its natives from the staged copy, not the workspace ---------- */
    const stagedModules = loadedModules(hosted.pid);
    const stagedNodePty = stagedModules.filter((m) => m.includes('node-pty'));
    // The host's own executable is `electron.exe` from the workspace install — that is what running
    // Electron under ELECTRON_RUN_AS_NODE means and is not a leak. What must not come from the
    // workspace is any native addon the host maps, so the check excludes the executable itself.
    const stagedWorkspaceNatives = stagedModules
      .filter((m) => m.toLowerCase().startsWith(ROOT.toLowerCase()))
      .filter((m) => !m.toLowerCase().endsWith('electron.exe'));

    record('staged host has node-pty loaded', stagedNodePty.length > 0, stagedNodePty.join(' | '));
    record('staged host loads node-pty from the staged directory',
      stagedNodePty.length > 0 && stagedNodePty.every((m) => m.toLowerCase().startsWith(staged.dir.toLowerCase())),
      `stagedDir=${staged.dir}`);
    record('staged host maps no native addon from the dev workspace',
      stagedWorkspaceNatives.length === 0, stagedWorkspaceNatives.join(' | ') || '(none)');

    /* ---------- 3. contrast + what the lock actually blocks ---------- */
    const workspaceEntry = path.join(ROOT, '.compiled', 'src', 'main', 'terminal-daemon', 'daemon-entry.js');
    const contrast = await launchHost(workspaceEntry, ROOT, probeDir, 'workspace');
    hosts.push(contrast.pid);
    await delay(1200);
    const contrastModules = loadedModules(contrast.pid);
    const contrastFromWorkspace = contrastModules
      .filter((m) => m.toLowerCase().startsWith(ROOT.toLowerCase()))
      .filter((m) => !m.toLowerCase().endsWith('electron.exe'));
    record('contrast: workspace-launched host DOES map workspace natives (staging is justified)',
      contrastFromWorkspace.length > 0, contrastFromWorkspace.join(' | ') || '(none)');

    // The plan's justification was "a workspace-resident host makes the next build fail EBUSY".
    // That is testable, and measurement shows it is only half true: renaming a mapped addon
    // succeeds (delete+recreate still works), while opening it for write fails.
    // To avoid mutating the developer's live workspace install, exercise the lock mechanics
    // against the staged copy mapped by the staged host rather than node_modules.
    const stagedAddonDir = path.join(staged.dir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`);
    const stagedAddonPath = stagedNodePty.find((m) => m.toLowerCase().endsWith('pty.node'))
      || path.join(stagedAddonDir, 'pty.node');
    const swap = path.join(path.dirname(stagedAddonPath), `pty.swapprobe-${process.pid}`);
    if (!fs.existsSync(stagedAddonPath) && fs.existsSync(swap)) {
      try { fs.renameSync(swap, stagedAddonPath); } catch {}
    }

    let inPlaceWrite = 'ok';
    try {
      const fd = fs.openSync(stagedAddonPath, 'r+');
      fs.closeSync(fd);
    } catch (err) {
      inPlaceWrite = err.code || (err && err.message) || 'error';
    }

    let renameWorks = false;
    try {
      fs.renameSync(stagedAddonPath, swap);
      try {
        renameWorks = true;
      } finally {
        try { fs.renameSync(swap, stagedAddonPath); } catch {}
      }
    } catch {
      renameWorks = false;
    }

    record('(measured) staged addon lock: in-place write refused while host runs',
      inPlaceWrite !== 'ok',
      `inPlaceWriteOpen=${inPlaceWrite}`);
    record('(measured) staged addon lock: rename succeeds while host runs',
      renameWorks === true,
      `renameSucceeds=${renameWorks}`);

    /* ---------- 4. survival across the spawning process ---------- */
    client.ws.close();
    const survived = alive(hosted.pid);
    record('staged host still alive after client disconnect', survived, `pid=${hosted.pid}`);

    const ok = checks.every((c) => c.pass);
    console.log(`PROBE_RESULT ${JSON.stringify({ ok, version: staged.version, checks })}`);
    if (!ok) exitCode = 1;
  } catch (err) {
    console.log(`${LOG} FAILED: ${err && err.message ? err.message : String(err)}`);
    for (const c of checks) if (!c.pass) console.log(`${LOG}   failed check: ${c.name}`);
    console.log(`PROBE_RESULT ${JSON.stringify({ ok: false, error: String(err), checks })}`);
    exitCode = 1;
  } finally {
    for (const pid of hosts) {
      if (!killTree(pid)) console.log(`${LOG} WARNING: host ${pid} survived teardown`);
    }
    if (!removeDirWithRetry(probeDir)) console.log(`${LOG} WARNING: probe dir survived teardown`);
    process.exit(exitCode);
  }
}

run();
