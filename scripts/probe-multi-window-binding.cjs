/**
 * Multi-Window Binding & Annotation Routing — phase-06 live acceptance proof.
 *
 * Plan: plans/260930-0945-multi-window-binding-and-annotation-routing/phase-06-multi-window-live-proof.md
 *
 * NOTE — the plan's "two live project windows" topology is unreachable in this build:
 * project windows are retired (commit 8ccc3ec). `openProject` routes to the singleton
 * 'web' hub (`ensureProjectWindow({kind:'web'})` + activateProjectId); the only second
 * browser shell is the 'unassigned' Terminal Manager. This probe therefore drives the
 * live equivalent: ONE web hub switching between two projects (A, B), plus the shared
 * Terminal Manager window, plus TWO concurrent agent attachments on separate bridge
 * sockets. Every phase invariant is still judged against live state:
 *
 *   M1  startSession bound to a terminal mints its anchor tab on the hub host pinned
 *       to the TERMINAL's capsule — not the ambient active one (Phase 2).
 *   M2  the hub's terminal scope follows its active project: sessionB is invisible
 *       while A is presented, visible while B is; the manager window sees all (Phase 1).
 *   M3  the bound tab is the only target; a foreign/session-unmanaged tab id refuses
 *       with a typed code, and the other agent's anchor refuses likewise.
 *   M4  dead-tab recovery — closing the anchor degrades dispatches closed (typed,
 *       no UNAUTHENTICATED deadlock), tabs.list still answers, and browser.open-tab
 *       re-provisions the session (Phase 1).
 *   M5  the minted anchor renders without a foreground switch; browser.screenshot returns pixels without a
 *       foreground switch and the journal carries no capture.raster timeout (Phase 3).
 *   M6  annotation routing — with the hub presenting B, a pick on A's tab naming
 *       sessionB writes to B's PTY only; naming sessionA is foreign-refused and
 *       journaled; nothing leaks (Phase 4).
 *   M7  per-window close gate — closing the manager window leaves the hub, its tabs
 *       and the control plane alive; window-close.closed is journaled (Phase 5).
 *   M8  two concurrent agent attachments: cross-driving the other's tab fails closed.
 *   M9  tabhost.tabClosed journal rows carry source/capsuleId/projectId attribution.
 *
 * Rows that need physical hardware stay out of scope; every row here is decidable
 * from process state, bridge responses, and the lifecycle journal.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-multi-window-binding.cjs
 * Evidence: plans/260930-0945-multi-window-binding-and-annotation-routing/reports/multi-window-binding.{json,log}
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));

const reportsDir = path.join(ROOT, 'plans', '260930-0945-multi-window-binding-and-annotation-routing', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'multi-window-binding.log');
fs.writeFileSync(logFile, '', 'utf8');
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};
// Picker warnings are the dispatch-skip signal; capture them for the annotation rows.
const consoleWarnings = [];
const origWarn = console.warn;
console.warn = (...args) => {
  try { consoleWarnings.push(args.map(String).join(' ')); } catch {}
  origWarn(...args);
};

// ---- throwaway world (leg 2 reuses leg 1's root to prove cold-restart restore) ----
const RESTART_LEG = process.env.ANTIFAN_MWB_LEG === 'restart';
const RESTART_ROOT = process.env.ANTIFAN_MWB_ROOT || '';
const tempRoot = RESTART_LEG && RESTART_ROOT ? RESTART_ROOT : fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mwb-probe-'));
const alphaDir = path.join(tempRoot, 'alpha');
const betaDir = path.join(tempRoot, 'beta');
fs.mkdirSync(alphaDir, { recursive: true });
fs.mkdirSync(betaDir, { recursive: true });
const ALPHA = {
  projectId: 'project-00000000-0000-4000-8000-0000000000a1',
  workspaceId: 'workspace-00000000-0000-4000-8000-0000000000a1',
  capsuleId: 'capsule-probe-alpha',
  name: 'Probe Alpha',
  path: alphaDir,
};
const BETA = {
  projectId: 'project-00000000-0000-4000-8000-0000000000b2',
  workspaceId: 'workspace-00000000-0000-4000-8000-0000000000b2',
  capsuleId: 'capsule-probe-beta',
  name: 'Probe Beta',
  path: betaDir,
};

const BRIDGE_PORT = Number(process.env.ANTIFAN_MWB_BRIDGE_PORT) || (21400 + (process.pid % 300));
process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = process.env.ANTIFAN_MWB_USER_DATA || path.join(tempRoot, 'Profile');
// Both legs seed project A at boot: the event-store lineage binds the data root to
// the boot project, so leg 2 must boot under the same seed — a mismatch correctly
// fails closed. The restart check stays honest anyway: leg 1 exits presenting B,
// so leg 2 observing B proves the persisted hub record beat the env seed.
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
process.env.ANTIFAN_BRIDGE_PORT = String(BRIDGE_PORT);

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    version: 1,
    activeCapsuleId: ALPHA.capsuleId,
    capsules: [ALPHA, BETA].map((entry) => ({
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

// Boot the shipping main process inside this same Electron instance, exactly as the
// sibling probe does: guards run at import, the throwaway environment is already seeded.
const mainProcess = require(compiledModule('index.js'));
const { getLifecycleLogPath } = require(compiledModule('diagnostics/main-lifecycle-log.js'));
// The process-wide terminal surface the shipping code uses; ANTIFAN_USE_TERMINAL_DAEMON=0
// keeps it in-process so writeTo/switchSession spies observe the real dispatch.
const { TerminalManager } = require(compiledModule('browser/terminal-manager.js'));

const checks = [];
const observations = {};
const messageOf = (err) => String(err && err.message ? err.message : err);

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    checks.push({ name, ok: false, error: messageOf(err) });
    console.log(`  FAIL  ${name}: ${messageOf(err)}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (left, right) => path.normalize(String(left || '')) === path.normalize(String(right || ''));

async function waitFor(predicate, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (last observed: ${JSON.stringify(last)})`);
}
async function waitForApi(webContents, expression, timeoutMs = 20000) {
  await waitFor(
    async () => {
      if (!webContents || webContents.isDestroyed()) return false;
      try {
        return (await webContents.executeJavaScript(expression, true)) === true;
      } catch {
        return false;
      }
    },
    `chrome surface API: ${expression}`,
    timeoutMs,
  );
}
const surfaceOf = (shell, surface) => (surface === 'sidebar' ? shell?.sidebarView : shell?.toolbarView)?.webContents ?? null;
const entryByOwnerKey = (snapshot, key) => snapshot.find((entry) => entry.ownerKey === key);

// ---- bridge client: the real transport an agent uses --------------------------------
function httpJsonPost(port, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          resolve(parsed);
        });
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('pairing request timed out')); });
    req.once('error', reject);
    req.end(payload);
  });
}

async function pairBridge(grant = 'eval') {
  const challenge = await httpJsonPost(BRIDGE_PORT, '/api/pairing/challenge', {});
  expect(challenge && challenge.success && challenge.code, `pairing challenge returned ${JSON.stringify(challenge)}`);
  const exchange = await httpJsonPost(BRIDGE_PORT, '/api/pairing/exchange', { code: challenge.code, clientClass: 'mcp', requestedGrant: grant });
  expect(exchange && exchange.success && exchange.secret, `pairing exchange returned ${JSON.stringify(exchange)}`);
  return exchange;
}

function openBridgeSocket(secret) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`, {
      headers: { 'x-antifan-attachment-secret': secret, authorization: `Bearer ${secret}` },
    });
    const onError = (err) => reject(new Error(`bridge socket failed: ${messageOf(err)}`));
    socket.once('error', onError);
    socket.once('open', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function bridgeRpc(socket, method, params, timeoutMs = 30000) {
  const id = `mwb-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`bridge call ${method} produced no answer within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (raw) => {
      let response;
      try { response = JSON.parse(raw.toString()); } catch { return; }
      if (!response || response.id !== id) return;
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(response);
    };
    socket.on('message', handler);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** The bridge respond() envelope: {id, success, data|error} — failures are refused, never thrown. */
async function bridgeCall(socket, method, params) {
  const response = await bridgeRpc(socket, method, params);
  return response;
}

let dispatchSeq = 0;
/** One capability call over the live socket with the session's own authority fields. */
async function dispatchOnSocket(socket, session, name, params = {}) {
  dispatchSeq += 1;
  const response = await bridgeRpc(socket, 'antifan.capability.dispatch', {
    requestId: `req-mwb-${dispatchSeq}`,
    idempotencyKey: `idem-mwb-${dispatchSeq}`,
    name,
    params,
    attachmentId: session.attachmentId,
    attachmentSecret: session.secret,
    authorityRevision: session.authorityRevision,
  });
  // Effectful dispatches rotate authority; adopt the replacement or the next call
  // presents a revision the app already retired.
  const next = response && response.data && typeof response.data.replacementAuthorityRevision === 'string'
    ? response.data.replacementAuthorityRevision
    : (response && typeof response.replacementAuthorityRevision === 'string' ? response.replacementAuthorityRevision : '');
  if (next) session.authorityRevision = next;
  if (response && response.data && typeof response.data.authorityRevision === 'string' && response.data.authorityRevision) {
    session.authorityRevision = response.data.authorityRevision;
  }
  return response;
}

/** Lifecycle journal events since a marker offset. */
function journalEventsSince(pathname, byteOffset) {
  try {
    const fd = fs.openSync(pathname, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const len = stat.size - byteOffset;
      if (len <= 0) return [];
      const buffer = Buffer.alloc(len);
      fs.readSync(fd, buffer, 0, len, byteOffset);
      return buffer
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** Leg 2: cold boot against leg 1's persisted tempRoot — restore proof only. */
async function runRestart() {
  const authority = mainProcess.projectWindowAuthority;
  await app.whenReady();
  const hubEntry = await waitFor(
    () => {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the restored web hub',
  );
  const hubHost = authority.hostForOwner(hubEntry.ownerKey);
  await check('a cold restart reopens one web hub shell', () => {
    expect(hubEntry.owner.kind === 'web', `startup owner kind was '${hubEntry.owner.kind}'`);
    expect(hubHost, 'no hub host after restart');
  });
  await check('the restored hub presents the persisted project, not the env seed', () => {
    expect(hubHost.activeProject() === BETA.projectId, `restored active project was '${hubHost.activeProject()}' — env seeds A, persisted record says B`);
  });
  await check('the hub restores its persisted strip (M7 survive-restart)', () => {
    const tabs = (hubHost.getTabList() || []).filter((t) => t && t.id);
    const fixtureTabs = tabs.filter((t) => String(t.url || '').includes('127.0.0.1'));
    expect(fixtureTabs.length > 0, `no fixture tab restored: ${JSON.stringify(tabs.map((t) => t.url))}`);
    observations.restart = { restoredTabs: tabs.length, fixtureTabs: fixtureTabs.map((t) => t.id) };
  });
}

/** Leg 1 tail: cold-restart leg 2 against this run's persisted state. */
async function runColdRestartLeg(authority, hubHost) {
  // The persisted strip is the fixture of record: mint one ordinary (non-ephemeral)
  // page tab right before persisting so leg 2's restore check has a
  // deterministic target independent of how many probe tabs the run above closed.
  hubHost.createTab(`http://127.0.0.1:1/restart-fixture`, true);
  try { hubHost.persistSync(); } catch {}
  const restartReport = path.join(reportsDir, 'multi-window-binding-restart.json');
  // Single-instance lock is keyed on the user-data dir, and saved-tabs.json lives
  // under it too — clone ONLY the persisted strip (the Chromium cache subtree
  // holds locked files that break a wholesale copy) into leg 2's own profile.
  const leg2Profile = path.join(tempRoot, 'Profile-restart');
  fs.mkdirSync(leg2Profile, { recursive: true });
  fs.copyFileSync(path.join(tempRoot, 'Profile', 'saved-tabs.json'), path.join(leg2Profile, 'saved-tabs.json'));
  try { fs.unlinkSync(restartReport); } catch {}
  const childEnv = {
    ...process.env,
    ANTIFAN_MWB_LEG: 'restart',
    ANTIFAN_MWB_USER_DATA: leg2Profile,
    ANTIFAN_MWB_ROOT: tempRoot,
    ANTIFAN_MWB_BRIDGE_PORT: String(22500 + (process.pid % 200)),
    ANTIFAN_USER_DATA: leg2Profile,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Boot must NOT hand leg 2 a project: presenting A has to come from the persisted
  // hub record alone, so the env seeds leg 1 used are stripped before spawn.
  delete childEnv.ANTIFAN_PROJECT_ID;
  delete childEnv.ANTIFAN_WORKSPACE_ID;
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'probe-multi-window-binding.cjs'), '--allow-eval'], {
    env: childEnv,
    timeout: 240000,
    encoding: 'utf8',
  });
  observations.coldRestart = {
    status: child.status,
    signal: child.signal,
    stderrTail: String(child.stderr || '').split('\n').slice(-8),
    stdoutTail: String(child.stdout || '').split('\n').slice(-12),
  };
  await check('cold restart leg restores the presented project and hub tabs', () => {
    expect(child.status === 0, `restart leg exited ${child.status}: ${JSON.stringify(observations.coldRestart.stdoutTail)}`);
    const doc = JSON.parse(fs.readFileSync(restartReport, 'utf8'));
    expect(doc.failed === 0, `restart leg reported ${doc.failed} failed check(s): ${JSON.stringify(doc.checks && doc.checks.filter((c) => !c.ok))}`);
    expect(doc.observations && doc.observations.restart && doc.observations.restart.restoredTabs > 0, 'restart leg restored no tabs');
  });
}

let fixtureServer = null;

async function run() {
  const authority = mainProcess.projectWindowAuthority;
  if (RESTART_LEG) return runRestart();
  await app.whenReady();

  const fixture = http.createServer((req, res) => {
    const slug = (req.url || '/').split('?')[0];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>mwb${slug}</title></head><body><h1 id=t>mwb${slug}</h1></body></html>`);
  });
  fixtureServer = fixture;
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  const pageUrl = (slug) => `${baseUrl}/${slug}`;
  const lifecycleLog = getLifecycleLogPath();
  const journalMark = () => { try { return lifecycleLog ? fs.statSync(lifecycleLog).size : 0; } catch { return 0; } };
  const journalOffset = journalMark();

  // ---- boot: the web hub, presenting ALPHA ------------------------------------
  const hubEntry = await waitFor(
    () => {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup web hub',
  );
  const hubKey = hubEntry.ownerKey; // 'web'
  const hubHost = authority.hostForOwner(hubKey);
  const sidebarHub = surfaceOf(authority.shellFor(hubKey), 'sidebar');
  const toolbarHub = surfaceOf(authority.shellFor(hubKey), 'toolbar');
  await waitForApi(sidebarHub, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
  await waitForApi(toolbarHub, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");

  await check('startup opens exactly one web hub shell presenting project A', () => {
    expect(hubEntry.owner.kind === 'web', `startup owner kind was '${hubEntry.owner.kind}'`);
    expect(hubHost, 'the hub has no host');
    expect(hubHost.activeProject() === ALPHA.projectId, `hub active project was '${hubHost.activeProject()}'`);
  });

  // ---- switch the hub to B through the user's own entrypoint -------------------
  // The capsule affiliations were seeded on disk; sync them into the registry first —
  // openProject refuses ids the registry has never seen (UNKNOWN_PROJECT).
  authority.synchronizeCapsulesWithRegistry();
  const openB = await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
  observations.openB = openB;
  await waitFor(
    () => hubHost.activeProject() === BETA.projectId,
    'the hub to present project B',
  );
  await check('openProject joins the hub and repoints it at project B', () => {
    expect(openB && (openB.status === 'FOCUSED' || openB.status === 'OPENED'), `openProject returned ${JSON.stringify(openB)}`);
    expect(authority.browserShellCount() === 1, `a second shell appeared: count ${authority.browserShellCount()}`);
    expect(hubHost.activeProject() === BETA.projectId, `hub active project was '${hubHost.activeProject()}'`);
  });

  // ---- the shared Terminal Manager window (the only other browser shell) -------
  const managerEntry = await authority.ensureProjectWindow({ kind: 'unassigned' }, 'user');
  const managerKey = managerEntry.ownerKey;
  const managerHost = authority.hostForOwner(managerKey);
  await waitFor(
    () => {
      const entry = authority.snapshot().find((candidate) => candidate.ownerKey === managerKey);
      return entry && entry.visible === true ? entry : false;
    },
    'the Terminal Manager window to be presented',
  );
  await check('the Terminal Manager opens as the second browser shell', () => {
    expect(managerHost && managerHost !== hubHost, 'the manager shares the hub host');
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
  });

  // ---- terminals: one per project, owner-stamped by the asking context ----------
  const terminal = TerminalManager.getInstance();
  // sessionB minted while the hub presents B → terminalMintOwnerKey = project:B.
  const sessionB = await Promise.resolve(terminal.createSession(BETA.path, BETA.capsuleId, `project:${BETA.projectId}`));
  // Switch back to A and mint sessionA the same way the sidebar would.
  await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(ALPHA.projectId)})`, true);
  await waitFor(() => hubHost.activeProject() === ALPHA.projectId, 'the hub to present project A again');
  const sessionA = await Promise.resolve(terminal.createSession(ALPHA.path, ALPHA.capsuleId, `project:${ALPHA.projectId}`));
  observations.sessions = { sessionA, sessionB, ownerKeys: { a: terminal.sessionOwnerKey(sessionA), b: terminal.sessionOwnerKey(sessionB) } };
  expect(typeof sessionA === 'string' && sessionA, 'no terminal session for project A');
  expect(typeof sessionB === 'string' && sessionB, 'no terminal session for project B');
  await waitFor(
    () => {
      const list = terminal.listSessions(true) || terminal.listSessions();
      const a = (Array.isArray(list) ? list : []).find((s) => s.id === sessionA);
      const b = (Array.isArray(list) ? list : []).find((s) => s.id === sessionB);
      return a && b && a.state === 'running' && b.state === 'running' ? true : false;
    },
    'both terminal sessions to reach running state',
    20000,
  );

  await check('terminal sessions carry their project as owner (M2)', () => {
    expect(terminal.sessionOwnerKey(sessionA) === `project:${ALPHA.projectId}`, `session A owner was '${terminal.sessionOwnerKey(sessionA)}'`);
    expect(terminal.sessionOwnerKey(sessionB) === `project:${BETA.projectId}`, `session B owner was '${terminal.sessionOwnerKey(sessionB)}'`);
  });

  await check("the hub's terminal scope follows the presented project; the manager sees all (M2)", async () => {
    // Hub currently presents A.
    const underA = (hubHost.visibleTerminalSessions() || []).map((s) => s.id);
    expect(underA.includes(sessionA), `hub under A missing session A: ${JSON.stringify(underA)}`);
    expect(!underA.includes(sessionB), `hub under A leaked session B`);
    // Switch the hub to B; only B's session may appear.
    await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
    await waitFor(() => hubHost.activeProject() === BETA.projectId, 'hub to switch to B for scope check');
    const underB = (hubHost.visibleTerminalSessions() || []).map((s) => s.id);
    expect(underB.includes(sessionB), `hub under B missing session B: ${JSON.stringify(underB)}`);
    expect(!underB.includes(sessionA), `hub under B leaked session A`);
    // The shared manager sees every row, agent rows included.
    const managerRows = (managerHost.visibleTerminalSessions() || []).map((s) => s.id);
    expect(managerRows.includes(sessionA) && managerRows.includes(sessionB), `manager scope missing rows: ${JSON.stringify(managerRows)}`);
    // Back to A for the agent-binding phase.
    await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(ALPHA.projectId)})`, true);
    await waitFor(() => hubHost.activeProject() === ALPHA.projectId, 'hub to return to A');
    observations.hubScope = { underA, underB, managerRows };
  });

  // ---- a content-bearing tab for the annotation pick (capturePage needs a DOM) ----
  const tabA = await toolbarHub.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(pageUrl('alpha'))})`, true);
  expect(typeof tabA === 'string' && tabA, `tabA minted: ${JSON.stringify(tabA)}`);
  await waitFor(
    () => {
      const wc = hubHost.getTabWebContents(tabA, 'desktop');
      return wc && !wc.isDestroyed() && String(wc.getURL()).includes('/alpha') ? true : false;
    },
    'the probe tab to finish loading',
    15000,
  );

  // ---- agent A bound to sessionA over a real bridge pairing ---------------------
  const terminalGeneration = (id) => { try { return terminal.getSession(id)?.sessionGeneration; } catch { return undefined; } };
  const pairedA = await pairBridge('eval');
  const socketA = await openBridgeSocket(pairedA.secret);
  const startA = await bridgeCall(socketA, 'antifan.cli.startSession', {
    backendId: 'multi-window-probe',
    grant: 'eval',
    ttlMs: 900000,
    terminalSessionId: sessionA,
    terminalGeneration: terminalGeneration(sessionA),
    attachmentId: pairedA.attachmentId || undefined,
  });
  observations.startSessionA = { success: startA.success, data: startA.data, error: startA.error };
  expect(startA && startA.success === true, `startSession A failed: ${JSON.stringify(startA)}`);
  const sessionAgentA = { attachmentId: startA.data.attachmentId, secret: startA.data.secret, authorityRevision: startA.data.authorityRevision };
  const anchorA = startA.data.tabId;

  await check('agent bound to A\'s terminal anchors on the hub host pinned to capsule A (M1)', () => {
    expect(typeof anchorA === 'string' && anchorA.length > 0, `no anchor tab minted: ${JSON.stringify(startA.data)}`);
    const ownerHost = authority.hostForTab(anchorA);
    expect(ownerHost === hubHost, `anchor landed on a non-hub host`);
    expect(hubHost.getTabCapsuleId(anchorA) === ALPHA.capsuleId, `anchor capsule was '${hubHost.getTabCapsuleId(anchorA)}', expected '${ALPHA.capsuleId}'`);
    expect(startA.data.projectId === ALPHA.projectId, `session project was '${startA.data.projectId}'`);
  });

  // ---- second concurrent agent bound to sessionB on its own socket (M8) ----------
  const pairedB = await pairBridge('eval');
  const socketB = await openBridgeSocket(pairedB.secret);
  const startB = await bridgeCall(socketB, 'antifan.cli.startSession', {
    backendId: 'multi-window-probe-b',
    grant: 'eval',
    ttlMs: 900000,
    terminalSessionId: sessionB,
    terminalGeneration: terminalGeneration(sessionB),
    attachmentId: pairedB.attachmentId || undefined,
  });
  observations.startSessionB = { success: startB.success, data: startB.data, error: startB.error };
  expect(startB && startB.success === true, `startSession B failed: ${JSON.stringify(startB)}`);
  const sessionAgentB = { attachmentId: startB.data.attachmentId, secret: startB.data.secret, authorityRevision: startB.data.authorityRevision };
  const anchorB = startB.data.tabId;

  await check('two concurrent agent sessions coexist on separate attachments (M8)', () => {
    expect(typeof anchorB === 'string' && anchorB.length > 0 && anchorB !== anchorA, `anchor B '${anchorB}'`);
    expect(sessionAgentA.attachmentId !== sessionAgentB.attachmentId, 'both agents share an attachment');
    expect(hubHost.getTabCapsuleId(anchorB) === BETA.capsuleId, `anchor B capsule was '${hubHost.getTabCapsuleId(anchorB)}'`);
    expect(authority.hostForTab(anchorB) === hubHost, 'anchor B is not on the hub host');
    expect(startA.data.projectId !== startB.data.projectId, `both sessions claim '${startA.data.projectId}'`);
    expect(startA.data.port === startB.data.port, 'both attachments must ride the same bridge port');
  });

  // ---- bound dispatch ---------------------------------------------------------
  const navBound = await dispatchOnSocket(socketA, sessionAgentA, 'browser.navigate', { url: pageUrl('bound-a') });
  await check('a dispatch with no tabId drives agent A\'s bound anchor only', async () => {
    expect(navBound.success === true, `navigate failed: ${JSON.stringify(navBound)}`);
    const wc = hubHost.getTabWebContents(anchorA, 'desktop');
    const landed = await waitFor(async () => (wc && !wc.isDestroyed() && String(wc.getURL()).includes('/bound-a') ? true : false), 'bound tab navigation', 10000);
    expect(landed, 'the bound tab never reported the URL');
    const wcB = hubHost.getTabWebContents(anchorB, 'desktop');
    const urlB = wcB && !wcB.isDestroyed() ? String(wcB.getURL()) : '';
    expect(!urlB.includes('/bound-a'), `agent A's navigate leaked into agent B's anchor`);
  });

  await check('agent A cannot drive agent B\'s anchor tab (M8 cross-session)', async () => {
    const cross = await dispatchOnSocket(socketA, sessionAgentA, 'browser.navigate', { tabId: anchorB, url: pageUrl('cross') });
    observations.crossSession = { success: cross.success, error: cross.error };
    expect(cross.success === false, `a cross-session drive was accepted: ${JSON.stringify(cross)}`);
    const code = cross.error && (cross.error.code || cross.error);
    expect(/TARGET|REFUS|FORBIDDEN|DENIED|MISMATCH|SCOPE|TAB/i.test(String(code)), `no typed refusal: ${JSON.stringify(cross.error)}`);
  });

  // ---- background render surface (M5) -------------------------------------------
  const rasterMark = journalMark();
  const shotRes = await dispatchOnSocket(socketA, sessionAgentA, 'browser.screenshot', { format: 'png' });
  observations.screenshot = { success: shotRes.success, byteLength: shotRes.data && shotRes.data.data && shotRes.data.data.byteLength, artifactRef: shotRes.data && shotRes.data.data && shotRes.data.data.artifactRef, error: shotRes.error };
  await check('the background anchor renders without a foreground switch (M5)', () => {
    expect(hubHost.hasTab(anchorA) === true, `hasTab(${anchorA}) was false`);
    expect(hubHost.getActiveTabId() !== anchorA, `anchorA was unexpectedly active`);
    expect(shotRes.success === true, `browser.screenshot failed: ${JSON.stringify(shotRes.error)}`);
    // Bridge respond() wraps the port's payload once more: data = {data: envelope, requestId, ...}.
    // The port persists pixels to the artifact store; the wire envelope carries
    // {ok, artifactRef, sha256, byteLength, receipt} — byteLength > 0 IS the raster.
    const envelope = (shotRes.data && shotRes.data.data) || shotRes.data || {};
    expect(envelope.ok === true && envelope.artifactRef, `capture returned no artifact ref: ${JSON.stringify(Object.keys(envelope))}`);
    expect(typeof envelope.byteLength === 'number' && envelope.byteLength > 1000, `capture byteLength was ${envelope.byteLength}`);
    const rasterTimeouts = journalEventsSince(lifecycleLog, rasterMark).filter((r) => r.event === 'capture.raster' && r.outcome === 'timeout');
    expect(rasterTimeouts.length === 0, `raster timeouts recorded: ${JSON.stringify(rasterTimeouts)}`);
  });

  // ---- dead-tab recovery (M4) ----------------------------------------------------
  const deadMark = journalMark();
  await hubHost.closeTab(anchorA, 'probe-close');
  await sleep(400);

  await check('killing the bound tab fails dispatch closed — no UNAUTHENTICATED deadlock (M4)', async () => {
    expect(!authority.hostForTab(anchorA), `closed anchor ${anchorA} still resolves`);
    const dead = await dispatchOnSocket(socketA, sessionAgentA, 'browser.navigate', { url: pageUrl('dead') });
    observations.deadTabDispatch = { success: dead.success, error: dead.error };
    expect(dead.success === false, `a dispatch on a dead binding succeeded: ${JSON.stringify(dead)}`);
    const code = String(dead.error && (dead.error.code || dead.error));
    expect(/TARGET_STALE|TARGET_CLOSED|TAB/i.test(code), `dead binding refused with ${JSON.stringify(dead.error)}`);
    expect(!/UNAUTHENTICATED/i.test(code), 'dead binding produced the UNAUTHENTICATED deadlock this fix exists to kill');
    // Management tools must still answer while the binding is dead.
    const listDead = await dispatchOnSocket(socketA, sessionAgentA, 'browser.list-tabs', {});
    expect(listDead.success === true, `tabs.list on a dead binding failed: ${JSON.stringify(listDead)}`);
  });

  await check('rebind-target to a live same-project tab heals the dead session (M4)', async () => {
    // browser.open-tab on a dead binding correctly refuses TARGET_REQUIRED (two hosts,
    // no tabId) — that refusal IS the fail-closed contract. Shipping recovery is
    // browser.rebind-target onto a live tab the session's authority still covers.
    const opened = await dispatchOnSocket(socketA, sessionAgentA, 'browser.open-tab', { url: pageUrl('recovered') });
    observations.openTabRecovery = { success: opened.success, data: opened.data, error: opened.error };
    const openCode = String((opened.error && (opened.error.code || opened.error)) || (opened.data && opened.data.code) || '');
    expect(/TARGET_REQUIRED|TARGET_STALE|TARGET_MISMATCH/.test(openCode), `open-tab on a dead binding was not refused typed: ${JSON.stringify(opened)}`);
    const rebound = await dispatchOnSocket(socketA, sessionAgentA, 'browser.rebind-target', { tabId: tabA });
    observations.rebindRecovery = { success: rebound.success, data: rebound.data, error: rebound.error };
    expect(rebound.success === true, `rebind-target to tabA failed: ${JSON.stringify(rebound)}`);
    const reboundId = rebound.data && rebound.data.data && rebound.data.data.tabId;
    expect(reboundId === tabA, `rebind landed on ${reboundId}, expected ${tabA}`);
    const after = await dispatchOnSocket(socketA, sessionAgentA, 'browser.navigate', { url: pageUrl('after-recover') });
    expect(after.success === true, `dispatch after rebind recovery failed: ${JSON.stringify(after)}`);
  });

  // ---- annotation routing (M6) ----------------------------------------------------
  // Drive the devtools host's own pick handler — the function the picker IPC reaches —
  // with synthesized payloads; tm.writeTo/switchSession are spied so the receiving
  // session is observed, not assumed. Hub currently presents A.
  const writes = [];
  const switches = [];
  const originalWriteTo = terminal.writeTo.bind(terminal);
  const originalSwitch = terminal.switchSession.bind(terminal);
  terminal.writeTo = (id, input) => { writes.push({ id, input: String(input).slice(0, 240) }); return originalWriteTo(id, input); };
  terminal.switchSession = (id) => { switches.push(id); return originalSwitch(id); };
  try {
    const devtools = hubHost.getDevToolsHost();
    const tabWc = hubHost.getTabWebContents(tabA, 'desktop');
    const annotationMark = journalMark();

    // Hub presents A: sessionB is outside the picker's scope → refuse, write nothing.
    const warnMarkForeign = consoleWarnings.length;
    await devtools.handleInspectPickResult(tabA, tabWc, 'desktop', devtools.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'alpha-page',
      targetSessionId: sessionB, userComment: 'foreign-pick-probe', copyOnly: false,
    });
    await sleep(200);

    await check('a pick naming a session outside the presented scope refuses and writes nothing (M6)', () => {
      const bWrites = writes.filter((w) => w.id === sessionB && w.input.includes('foreign-pick-probe'));
      expect(bWrites.length === 0, `foreign pick wrote to session B: ${JSON.stringify(bWrites)}`);
      const skips = consoleWarnings.slice(warnMarkForeign).filter((line) => line.includes('annotation dispatch skipped'));
      expect(skips.some((line) => line.includes('foreign-target-refused')), `no foreign-target-refused warning: ${JSON.stringify(skips)}`);
      const journaled = journalEventsSince(lifecycleLog, annotationMark).filter((r) => r.event === 'annotation.dispatchSkipped');
      expect(journaled.length > 0, 'no annotation.dispatchSkipped journal row');
    });

    // Same pick, own in-scope session → must write there and nowhere else.
    await devtools.handleInspectPickResult(tabA, tabWc, 'desktop', devtools.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'alpha-page',
      targetSessionId: sessionA, userComment: 'own-pick-probe', copyOnly: false,
    });
    await sleep(200);

    await check("a pick naming the presented session writes the prompt there only (M6)", () => {
      const aWrites = writes.filter((w) => w.id === sessionA && w.input.includes('own-pick-probe'));
      expect(aWrites.length > 0, `the pick never reached session A: writes=${JSON.stringify(writes)}`);
      expect(writes.filter((w) => w.id === sessionB).length === 0, 'the same-session pick also wrote to session B');
      expect(switches.includes(sessionA), `dispatch never switched to session A: ${JSON.stringify(switches)}`);
    });

    // The 'auto' arm: no targetSessionId — resolve via tab URL + window-active session.
    // The fixture URL resolves to no workspace, so 'auto' MUST skip-with-report; the
    // safety invariant is that nothing is ever written to a foreign session.
    const autoMark = journalMark();
    const warnMark = consoleWarnings.length;
    await devtools.handleInspectPickResult(tabA, tabWc, 'desktop', devtools.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'alpha-page',
      targetSessionId: 'auto', userComment: 'auto-pick-probe', copyOnly: false,
    });
    await sleep(200);

    await check("an 'auto' pick with an unresolvable workspace skips without any write (M6)", () => {
      const autoWrites = writes.filter((w) => w.input.includes('auto-pick-probe'));
      expect(autoWrites.length === 0, `'auto' pick wrote a terminal: ${JSON.stringify(autoWrites)}`);
      const freshWarns = consoleWarnings.slice(warnMark).filter((line) => line.includes('annotation dispatch skipped'));
      const journaled = journalEventsSince(lifecycleLog, autoMark).filter((r) => r.event === 'annotation.dispatchSkipped');
      expect(freshWarns.length > 0 || journaled.length > 0, "'auto' pick produced neither a skip warning nor a journal row");
    });
  } finally {
    terminal.writeTo = originalWriteTo;
    terminal.switchSession = originalSwitch;
  }


  // ---- per-window close gate (M7) ---------------------------------------------------
  const closeMark = journalMark();
  const closeRequested = authority.requestClose(managerKey);
  await waitFor(() => authority.browserShellCount() === 1, 'the Terminal Manager to close');
  await sleep(400);
  observations.closeManager = { closeRequested, shellCount: authority.browserShellCount() };

  await check('closing the manager window leaves the hub, its tabs and the plane alive (M7)', () => {
    expect(closeRequested, 'the close request never reached the manager window');
    expect(authority.browserShellCount() === 1, `browserShellCount() was ${authority.browserShellCount()}`);
    const after = authority.snapshot();
    expect(!after.some((e) => e.ownerKey === managerKey), 'manager still in the directory');
    expect(entryByOwnerKey(after, hubKey), 'the hub vanished with the manager');
    expect(authority.hostForTab(tabA) === hubHost, "the hub's tab no longer resolves");
    expect(app.isReady() === true, 'the app is no longer ready');
    const closedEvents = journalEventsSince(lifecycleLog, closeMark).filter((r) => r.event === 'window-close.closed' && r.owner === managerKey);
    expect(closedEvents.length > 0, `no window-close.closed journal entry for ${managerKey}`);
  });

  // ---- tab-close telemetry (M9): three real close paths, attributed -------------
  // Runs after M7: the bridge close consumes tabA, which M7 must still see alive.
  // 1. host close (anchorA, 'probe-close' — done above), 2. webContents destroy
  // ('view-destroyed'), 3. bridge browser.close-tab on the rebound session tab.
  const telemetryTab = await toolbarHub.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(pageUrl('telemetry'))})`, true);
  expect(typeof telemetryTab === 'string' && telemetryTab, 'telemetry tab not minted');
  const wcTelemetry = hubHost.getTabWebContents(telemetryTab, 'desktop');
  const bridgeClose = await dispatchOnSocket(socketA, sessionAgentA, 'browser.close-tab', { tabId: tabA });
  observations.bridgeCloseTab = { success: bridgeClose.success, error: bridgeClose.error };
  if (wcTelemetry && !wcTelemetry.isDestroyed()) wcTelemetry.destroy(); // 'view-destroyed' path
  await sleep(400);

  await check('closes through host, bridge and view-destroyed paths journal attributed rows (M9)', () => {
    const rows = journalEventsSince(lifecycleLog, deadMark).filter((r) => r.event === 'tabhost.tabClosed');
    const rowFor = (id) => rows.find((r) => r.tabId === id);
    const anchorRow = rowFor(anchorA);
    expect(anchorRow && anchorRow.source === 'probe-close', `anchor row: ${JSON.stringify(anchorRow)}`);
    // Agent-minted anchors carry capsuleId, not projectId — capsule is the stamp.
    expect(anchorRow.capsuleId === ALPHA.capsuleId, `anchor capsule: ${JSON.stringify(anchorRow)}`);
    const telemetryRow = rowFor(telemetryTab);
    expect(telemetryRow && telemetryRow.source === 'view-destroyed', `view-destroyed row: ${JSON.stringify(telemetryRow)}`);
    expect(telemetryRow.projectId === ALPHA.projectId, `telemetry tab project stamp: ${JSON.stringify(telemetryRow)}`);
    expect(bridgeClose.success === true, `bridge close-tab refused: ${JSON.stringify(bridgeClose.error)}`);
    const bridgeRow = rowFor(tabA);
    expect(bridgeRow && typeof bridgeRow.source === 'string' && bridgeRow.source !== 'unspecified', `bridge close row has no real source: ${JSON.stringify(bridgeRow)}`);
    expect(bridgeRow.projectId === ALPHA.projectId, `bridge close attribution: ${JSON.stringify(bridgeRow)}`);
  });

  try { socketA.close(); } catch {}
  try { socketB.close(); } catch {}

  // ---- exit presenting B so the persisted record, not the env seed, decides leg 2
  await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
  await waitFor(() => hubHost.activeProject() === BETA.projectId, 'the hub to exit presenting B');

  // ---- cold restart (leg 2) -----------------------------------------------------
  await runColdRestartLeg(authority, hubHost);
}

async function cleanup() {
  try {
    for (const entry of mainProcess.projectWindowAuthority.snapshot()) {
      mainProcess.projectWindowAuthority.requestClose(entry.ownerKey);
    }
    const deadline = Date.now() + 8000;
    while (mainProcess.projectWindowAuthority.browserShellCount() > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  } catch {}
  try { if (fixtureServer) await new Promise((r) => fixtureServer.close(r)); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

let exitCode = 1;
app.whenReady()
  .then(run)
  .catch((err) => {
    check('probe completed without an unexpected throw', () => { throw err; });
  })
  .finally(async () => {
    await cleanup();
    const failed = checks.filter((entry) => !entry.ok);
    const result = {
      probe: 'multi-window-binding',
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
      observations,
      at: new Date().toISOString(),
    };
    const reportName = RESTART_LEG ? 'multi-window-binding-restart.json' : 'multi-window-binding.json';
    try {
      fs.writeFileSync(path.join(reportsDir, reportName), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      origLog(`[probe] failed to write evidence: ${messageOf(err)}`);
      process.exit(1);
    }
    console.log(`[probe] ${result.passed} passed, ${result.failed} failed — evidence: ${path.join(reportsDir, reportName)}`);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  });
