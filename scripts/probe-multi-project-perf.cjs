/**
 * Multi-project terminal performance probe - real Electron, real PTYs, real windows.
 *
 * Boots the shipping main process, opens N project windows (one terminal each), then runs
 * one terminal at ~1 MB/s while another is typed into every 200 ms, and measures what the
 * user feels:
 *
 *   - main-process event-loop delay (p50/p95/p99/max) during the burst;
 *   - synchronous fs.statSync calls per second made by the main process;
 *   - terminal-output IPC messages per second, summed over every chrome surface;
 *   - keystroke -> echo latency, measured from the input send to the moment the echoed marker
 *     is handed to the owning window's sidebar (Main's last hop before the renderer);
 *   - total working-set memory of every Electron process (app.getAppMetrics).
 *
 * The same script runs against any compiled tree (ANTIFAN_COMPILED_ROOT), so a baseline
 * build and the current build are measured by identical code.
 *
 * Run:  ANTIFAN_PERF_N=3 ANTIFAN_PERF_LABEL=after node scripts/run-electron.cjs scripts/probe-multi-project-perf.cjs
 * Env:  ANTIFAN_PERF_N (projects, default 3), ANTIFAN_PERF_SECONDS (burst length, default 30),
 *       ANTIFAN_PERF_LABEL (report name), ANTIFAN_PERF_DAEMON=1 (route terminals through the daemon).
 * Evidence: plans/260928-1654-smooth-multi-project-terminal/reports/perf-<label>-n<N>.json
 */
const { app, webContents: allWebContents } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { monitorEventLoopDelay } = require('node:perf_hooks');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));
const BURST_SECONDS = Math.max(5, Number(process.env.ANTIFAN_PERF_SECONDS || 90));
const TABS_PER_PROJECT = Math.max(0, Number(process.env.ANTIFAN_PERF_TABS ?? 5));
const N = Math.max(1, Number(process.env.ANTIFAN_PERF_N || 3));
const LABEL = String(process.env.ANTIFAN_PERF_LABEL || 'run').replace(/[^\w.-]/g, '_');
const reportsDir = path.join(ROOT, 'plans', '260928-1654-smooth-multi-project-terminal', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const reportFile = path.join(reportsDir, `perf-${LABEL}-n${N}.json`);

// Report identity: the measured tree's commit and dirty state make baseline-vs-after rows
// comparable rather than "some build from some morning".
let treeIdentity = null;
try {
  const treeRoot = path.resolve(compiledRoot, '..');
  const git = (args) => require('node:child_process').execFileSync('git', ['-C', treeRoot, ...args], { encoding: 'utf8' }).trim();
  treeIdentity = { root: treeRoot, head: git(['rev-parse', '--short', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 };
} catch {}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-perf-probe-'));
const hex = (i) => (0xa0 + i).toString(16).padStart(12, '0');
const PROJECTS = Array.from({ length: N }, (_, i) => {
  const dir = path.join(tempRoot, `project-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    projectId: `project-00000000-0000-4000-8000-${hex(i)}`,
    workspaceId: `workspace-00000000-0000-4000-8000-${hex(i)}`,
    capsuleId: `capsule-perf-${i}`,
    name: `Perf ${i}`,
    path: dir,
  };
});

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = PROJECTS[0].projectId;
process.env.ANTIFAN_WORKSPACE_ID = PROJECTS[0].workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = process.env.ANTIFAN_PERF_DAEMON === '1' ? '1' : '0';
process.env.ANTIFAN_BRIDGE_PORT = String(21500 + (process.pid % 400));

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    version: 1,
    activeCapsuleId: PROJECTS[0].capsuleId,
    capsules: PROJECTS.map((entry) => ({
      id: entry.capsuleId,
      name: entry.name,
      workspacePath: entry.path,
      state: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: entry.projectId,
      workspaceId: entry.workspaceId,
      migrationMarker: 'explicit',
    })),
  }, null, 2),
  'utf8',
);

// Counted from before the main process loads, so every call it makes is seen. The compiled
// modules reach `fs` through live bindings, so replacing the property is observed.
let statSyncCalls = 0;
// During the burst each call is bucketed by its first compiled-app frame, so a stat on the
// terminal routing path is told apart from cold work (session creation, persistence).
let statCallers = null;
const realStatSync = fs.statSync;
fs.statSync = function countedStatSync(...args) {
  statSyncCalls++;
  if (statCallers) {
    const frame = (new Error().stack || '').split('\n').slice(2).find((line) => line.includes(compiledRoot)) || '(outside app)';
    const site = frame.trim().replace(compiledRoot, '').replace(/:\d+\)?$/, '');
    statCallers.set(site, (statCallers.get(site) || 0) + 1);
  }
  return realStatSync.apply(this, args);
};

// Daemon mode must measure the daemon the measured tree builds: stage it with that tree's own
// staging script into this probe's temp data root, before the main process boots. Without a
// staged pointer the app silently falls back to the in-process terminal manager.
let stagedDaemon = null;
if (process.env.ANTIFAN_PERF_DAEMON === '1') {
  const treeRoot = path.resolve(compiledRoot, '..');
  const staged = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(treeRoot, 'scripts', 'stage-daemon-host.mjs'), '--json'],
    { cwd: treeRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  stagedDaemon = JSON.parse(staged.slice(staged.indexOf('{')));
}

// Daemon -> GUI traffic: every WebSocket frame the main process receives (terminal daemon,
// when ANTIFAN_PERF_DAEMON=1). Counted on the `ws` class the GUI's daemon client uses.
let wsFrames = 0;
let wsBytes = 0;
const WebSocketClass = require('ws').WebSocket || require('ws');
const realEmit = WebSocketClass.prototype.emit;
WebSocketClass.prototype.emit = function countedEmit(event, data, ...rest) {
  if (event === 'message') {
    wsFrames++;
    wsBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
  }
  return realEmit.call(this, event, data, ...rest);
};

const mainProcess = require(compiledModule('index.js'));

// Stage timing under ANTIFAN_DBG_ECHO=1: sentAt → writeTo → appendData → host dispatch.
if (process.env.ANTIFAN_DBG_ECHO === '1') {
  const tmMod = require(compiledModule('browser/terminal-manager.js'));
  const hostMod = require(compiledModule('browser/native-tab-host.js'));
  const dbg = (msg) => console.log(`[dbg ${performance.now().toFixed(1)}] ${msg}`);
  const TM = tmMod.TerminalManager;
  const origWriteTo = TM.prototype.writeTo;
  TM.prototype.writeTo = function (id, input) {
    if (typeof input === 'string' && input.includes('PERFMARK')) {
      const s = this.sessions?.get?.(id);
      if (s) s.__dbgInputMs = performance.now();
      dbg(`writeTo sess=${id}`);
    }
    return origWriteTo.call(this, id, input);
  };
  const origAppend = TM.prototype.appendData;
  TM.prototype.appendData = function (s, data, dataBytes) {
    if (typeof data === 'string' && data.includes('PERFMARK')) {
      const nowMs = performance.now();
      s.__dbgEmitMs = nowMs;
      const inMs = s.__dbgInputMs || 0;
      dbg(`appendData sess=${s.id} seq=${(s.lastSeq || 0) + 1} len=${dataBytes ?? data.length} inputToPty=${inMs ? (nowMs - inMs).toFixed(1) : 'n/a'}ms`);
    }
    return origAppend.call(this, s, data, dataBytes);
  };
  const origEmitQ = TM.prototype.emitChunkOrQueue;
  if (typeof origEmitQ === 'function') {
    TM.prototype.emitChunkOrQueue = function (s, data, seq, generation, bytes) {
      if (typeof data === 'string' && data.includes('PERFMARK')) {
        dbg(`emitChunkOrQueue sess=${s.id} seq=${seq} paused=${s.pausedForBackpressure} unacked=${s.unackedBytes}`);
      }
      return origEmitQ.call(this, s, data, seq, generation, bytes);
    };
  }
  // Per-session onData arrival stats: rate of appendData calls and the
  // synchronous cost of the emit path (router + host fan-out) per 5s window.
  const stats = new Map();
  const origAppend2 = TM.prototype.appendData;
  TM.prototype.appendData = function (s, data, dataBytes) {
    const st = stats.get(s.id) || { n: 0, bytes: 0, emitMs: 0, t0: performance.now() };
    st.n++; st.bytes += dataBytes ?? (typeof data === 'string' ? data.length : 0);
    stats.set(s.id, st);
    const t0 = performance.now();
    const r = origAppend2.call(this, s, data, dataBytes);
    st.emitMs += performance.now() - t0;
    if (performance.now() - st.t0 > 5000) {
      dbg(`rate sess=${s.id} chunks=${st.n} bytes=${st.bytes} emitMs=${st.emitMs.toFixed(1)}`);
      stats.delete(s.id);
    }
    return r;
  };
  const origChunk = hostMod.NativeTabHost.prototype.handleTerminalDataChunk;
  hostMod.NativeTabHost.prototype.handleTerminalDataChunk = function (payload) {
    if (payload && typeof payload.data === 'string' && payload.data.includes('PERFMARK')) {
      const s = TM.getInstance().getSession(payload.sessionId);
      const emitMs = s?.__dbgEmitMs || 0;
      dbg(`hostDispatch sess=${payload.sessionId} seq=${payload.seq} emitToDispatch=${emitMs ? (performance.now() - emitMs).toFixed(1) : 'n/a'}ms`);
    }
    return origChunk.call(this, payload);
  };
  // setImmediate scheduling-gap sampler: records worst main-thread task stalls
  // that monitorEventLoopDelay's libuv-tick view smooths over.
  let immPrev = performance.now();
  const gaps = { max: 0, over100: 0, over500: 0, t0: immPrev };
  const gapLoop = () => {
    const n = performance.now();
    const d = n - immPrev;
    immPrev = n;
    if (d > gaps.max) gaps.max = d;
    if (d > 100) gaps.over100++;
    if (d > 500) gaps.over500++;
    if (n - gaps.t0 > 5000) {
      dbg(`immGap max=${gaps.max.toFixed(0)}ms over100=${gaps.over100} over500=${gaps.over500}`);
      gaps.max = 0; gaps.over100 = 0; gaps.over500 = 0; gaps.t0 = n;
    }
    setImmediate(gapLoop);
  };
  setImmediate(gapLoop);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (last: ${JSON.stringify(last)})`);
}
async function waitForApi(wc, expression) {
  await waitFor(async () => {
    if (!wc || wc.isDestroyed()) return false;
    try { return (await wc.executeJavaScript(expression, true)) === true; } catch { return false; }
  }, `surface API ${expression}`);
}
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
const totalWorkingSetMb = () => round(app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize || 0), 0) / 1024);

async function run() {
  const authority = mainProcess.projectWindowAuthority;
  await app.whenReady();
  await waitFor(() => authority.snapshot().length === 1, 'the startup project window');
  const firstKey = authority.snapshot()[0].ownerKey;
  const sidebarOf = (key) => authority.shellFor(key)?.sidebarView?.webContents ?? null;
  const sidebar0 = sidebarOf(firstKey);
  await waitForApi(sidebar0, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");

  const windowOpenStartedAt = Date.now();
  for (const project of PROJECTS.slice(1)) {
    const result = await sidebar0.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(project.projectId)})`, true);
    if (!result || result.status !== 'OPENED') throw new Error(`openProject(${project.name}) returned ${JSON.stringify(result)}`);
  }
  await waitFor(() => authority.snapshot().filter((e) => e.owner.kind === 'project').length === N, `${N} project windows`);
  const windowOpenMs = Date.now() - windowOpenStartedAt;

  // One terminal per project window, created from that window's own sidebar.
  const sessions = [];
  for (const project of PROJECTS) {
    const entry = authority.snapshot().find((e) => e.owner.kind === 'project' && e.owner.projectId === project.projectId);
    const shell = authority.shellFor(entry.ownerKey);
    const toolbar = shell?.toolbarView?.webContents;
    await waitForApi(toolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
    // The user works with the terminal sidebar open; output is only delivered to an open one.
    if (!shell.isSidebarOpen) await toolbar.executeJavaScript('window.antifanToolbar.toggleSidebar()', true);
    await waitFor(() => shell.isSidebarOpen === true, `the sidebar of ${project.name} to open`);
    for (let t = 0; t < TABS_PER_PROJECT; t++) {
      const page = `data:text/html,<title>${project.name} tab ${t}</title><h1>${project.name} tab ${t}</h1>${'<p>lorem ipsum</p>'.repeat(200)}`;
      await toolbar.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(page)})`, true);
    }
    const sidebar = sidebarOf(entry.ownerKey);
    await waitForApi(sidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.newTerminal === 'function'");
    const before = new Set(((await sidebar.executeJavaScript('window.antifanStandalone.listTerminals()', true)) || []).map((s) => s.id || s.sessionId));
    await sidebar.executeJavaScript(`window.antifanStandalone.newTerminal(${JSON.stringify(project.path)})`, true);
    const created = await waitFor(async () => {
      const rows = (await sidebar.executeJavaScript('window.antifanStandalone.listTerminals()', true)) || [];
      const fresh = rows.map((s) => s.id || s.sessionId).filter((id) => id && !before.has(id));
      return fresh[0] || false;
    }, `a terminal in ${project.name}`);
    sessions.push({ project, sidebar, sessionId: created });
  }
  await sleep(4000); // let every shell print its prompt before measuring

  // Count terminal-output IPC on every surface, and timestamp echo markers on the typing window.
  let dataIpc = 0;
  const markerSeenAt = new Map();
  const typing = sessions[Math.min(1, sessions.length - 1)];
  // IPC per chrome target: broadcast pruning is judged by how much output lands on surfaces
  // other than the visible one.
  const ipcByTarget = new Map();
  const labelFor = (wc) => {
    for (const s of sessions) {
      const entry = authority.snapshot().find((e) => e.owner.kind === 'project' && e.owner.projectId === s.project.projectId);
      const shell = entry && authority.shellFor(entry.ownerKey);
      if (shell?.sidebarView?.webContents === wc) return `${s.project.name}:sidebar`;
      if (shell?.toolbarView?.webContents === wc) return `${s.project.name}:toolbar`;
    }
    return 'other';
  };
  for (const wc of allWebContents.getAllWebContents()) {
    const target = labelFor(wc);
    const realSend = wc.send.bind(wc);
    wc.send = (channel, ...args) => {
      if (channel === 'antifan:terminal:data') {
        dataIpc++;
        ipcByTarget.set(target, (ipcByTarget.get(target) || 0) + 1);
        if (wc === typing.sidebar) {
          const text = String(args[0]?.data ?? '');
          for (const match of text.matchAll(/PERFMARK(\d+)X/g)) {
            if (!markerSeenAt.has(match[1])) markerSeenAt.set(match[1], performance.now());
          }
        }
      }
      return realSend(channel, ...args);
    };
  }

  const idleWorkingSetMb = totalWorkingSetMb();
  const loop = monitorEventLoopDelay({ resolution: 5 });
  const statAtStart = statSyncCalls;
  const ipcAtStart = dataIpc;
  const wsFramesAtStart = wsFrames;
  const wsBytesAtStart = wsBytes;
  const burst = sessions[0];
  // ~1 MB/s of printable output: 1000-character lines, one per millisecond.
  const producer = "node -e \"setInterval(()=>process.stdout.write('y'.repeat(999)+'\\n'),1)\"";
  const sendInput = (target, text) => {
    const t0 = performance.now();
    return target.sidebar.executeJavaScript(
      `window.antifanStandalone.sendTerminalInputTo(${JSON.stringify(target.sessionId)}, ${JSON.stringify(text)})`, true)
      .then((v) => {
        const ms = performance.now() - t0;
        if (process.env.ANTIFAN_DBG_ECHO === '1') console.log(`[dbg] sendInput sess=${target.sessionId} took=${ms.toFixed(1)}ms`);
        return v;
      });
  };

  loop.enable();
  statCallers = new Map();
  // Renderer jank: longtask entries on every sidebar while the burst runs.
  for (const s of sessions) {
    try {
      await s.sidebar.executeJavaScript(
        "window.__perfLt=[];try{new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__perfLt.push(Math.round(e.duration))}).observe({entryTypes:['longtask']})}catch(e){}1",
        true);
    } catch {}
  }
  const startedAt = performance.now();
  await sendInput(burst, `${producer}\r`);
  const sentAt = new Map();
  let marker = 0;
  const rssSamples = [];
  while (performance.now() - startedAt < BURST_SECONDS * 1000) {
    marker++;
    sentAt.set(String(marker), performance.now());
    await sendInput(typing, `echo PERFMARK${marker}X\r`);
    if (marker % 25 === 0) rssSamples.push(totalWorkingSetMb());
    await sleep(200);
  }
  const elapsedS = (performance.now() - startedAt) / 1000;
  loop.disable();
  const statDuringBurst = statSyncCalls - statAtStart;
  const statSyncCallers = Object.fromEntries([...statCallers].sort((a, b) => b[1] - a[1]));
  statCallers = null;
  const ipcDuringBurst = dataIpc - ipcAtStart;
  const wsFramesDuringBurst = wsFrames - wsFramesAtStart;
  const wsBytesDuringBurst = wsBytes - wsBytesAtStart;
  if (stagedDaemon && wsFramesDuringBurst === 0) {
    throw new Error('daemon mode was requested but no daemon WebSocket frame arrived: the app fell back to the in-process terminal manager');
  }
  await sendInput(burst, '\x03');
  await sleep(1500);
  const rendererLongtasks = {};
  for (const s of sessions) {
    try {
      const lt = (await s.sidebar.executeJavaScript('window.__perfLt || []', true)) || [];
      rendererLongtasks[s.project.name] = { count: lt.length, max: lt.length ? Math.max(...lt) : 0, totalMs: lt.reduce((a, b) => a + b, 0) };
    } catch {}
  }

  const echoLatencies = [];
  let echoLost = 0;
  for (const [id, sent] of sentAt) {
    const seen = markerSeenAt.get(id);
    if (seen === undefined) echoLost++;
    else echoLatencies.push(seen - sent);
  }
  echoLatencies.sort((a, b) => a - b);
  const ns = (value) => round(value / 1e6);

  const report = {
    label: LABEL,
    compiledRoot,
    projects: N,
    daemon: process.env.ANTIFAN_USE_TERMINAL_DAEMON === '1',
    stagedDaemon,
    burstSeconds: round(elapsedS),
    windowOpenMs,
    eventLoopDelayMs: {
      p50: ns(loop.percentile(50)), p95: ns(loop.percentile(95)), p99: ns(loop.percentile(99)), max: ns(loop.max),
    },
    statSyncPerSecond: round(statDuringBurst / elapsedS),
    statSyncCallers,
    terminalDataIpcPerSecond: round(ipcDuringBurst / elapsedS),
    terminalDataIpcByTarget: Object.fromEntries([...ipcByTarget].sort((a, b) => b[1] - a[1])),
    rendererLongtasks,
    daemonWsFramesPerSecond: round(wsFramesDuringBurst / elapsedS),
    daemonWsKiBPerSecond: round(wsBytesDuringBurst / 1024 / elapsedS),
    tabsPerProject: TABS_PER_PROJECT,
    echoLatencyMs: {
      samples: echoLatencies.length,
      lost: echoLost,
      p50: round(percentile(echoLatencies, 50)),
      p95: round(percentile(echoLatencies, 95)),
      max: round(echoLatencies.at(-1) ?? null),
    },
    workingSetMb: { idle: idleWorkingSetMb, burstMax: rssSamples.length ? Math.max(...rssSamples) : null },
    tree: treeIdentity,
    measuredAt: new Date().toISOString(),
  };
  writeReport(report);
  console.log(`[perf-probe] ${JSON.stringify(report)}`);
  console.log(`[perf-probe] report: ${reportFile}`);
  console.log(`[perf-probe] telemetry: ${path.join(ROOT, '.antifan', 'telemetry', path.basename(reportFile))}`);
}

function writeReport(report) {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(reportFile, body, 'utf8');
  // Same record in the repo telemetry location the plan's baseline gate reads.
  const telemetryDir = path.join(ROOT, '.antifan', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, path.basename(reportFile)), body, 'utf8');
}

// A failed run is still a reportable result: the baseline gate reads JSON, not exit codes.
function writeFailureReport(err) {
  try {
    writeReport({
      label: LABEL, compiledRoot, projects: N,
      daemon: process.env.ANTIFAN_USE_TERMINAL_DAEMON === '1',
      stagedDaemon, tree: treeIdentity,
      failedChecks: [{ name: 'probe-run', error: String(err && err.message ? err.message : err) }],
      measuredAt: new Date().toISOString(),
    });
  } catch {}
}

let exitCode = 1;
app.whenReady()
  .then(run)
  .then(() => { exitCode = 0; })
  .catch((err) => { writeFailureReport(err); console.error(`[perf-probe] FAILED: ${err && err.stack ? err.stack : err}`); })
  .finally(async () => {
    // Stop the probe-owned daemon BEFORE touching windows: destroying the last window makes the
    // app quit, and a queued quit means these timers never resume - that is exactly how the
    // daemon outlived the probe. taskkill /T also reaps the winpty children a plain signal
    // would leave behind; the pids come only from this probe's own temp root.
    const daemonPids = probeDaemonPids();
    stopProbeDaemon(daemonPids);
    for (let i = 0; i < 50 && daemonPids.some((pid) => isAlive(pid)); i++) await sleep(100);
    const survived = daemonPids.filter((pid) => isAlive(pid));
    if (survived.length) console.error(`[perf-probe] daemon pids still alive after teardown: ${survived.join(', ')}`);
    for (const win of require('electron').BrowserWindow.getAllWindows()) {
      try { win.destroy(); } catch {}
    }
    await sleep(300);
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  });

// The terminal daemon is spawned detached on purpose (it outlives GUI restarts), so the probe
// stops the one it started: pids published in this probe's own temp data root, nothing else.
function probeDaemonPids() {
  const pids = [];
  const stack = [tempRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'daemon-handshake.json' || entry.name === 'daemon.json') {
        try {
          const pid = Number(JSON.parse(fs.readFileSync(full, 'utf8')).pid);
          if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
        } catch {}
      }
    }
  }
  return pids;
}

function stopProbeDaemon(pids = probeDaemonPids()) {
  for (const pid of pids) {
    if (process.platform === 'win32') {
      try { require('node:child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      try { process.kill(pid); } catch {}
    }
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
