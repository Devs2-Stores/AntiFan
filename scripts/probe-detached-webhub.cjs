/**
 * Detached Project WebHub Windows — phase-05 live acceptance proof.
 *
 * Plan: plans/261001-0902-detached-project-webhub-windows/phase-05-live-proof.md
 *
 * Topology under test: the singleton 'web' hub + detached `project:<id>` shells +
 * the shared 'unassigned' Terminal Manager. Every leg drives the shipping path —
 * the real detachProject/reattachProject entrypoints (via projectWindowAuthority,
 * the same seam the menu and the IPC route call), the real bridge pairing +
 * WebSocket dispatch, and the real saved-tabs.json fold/restore — never a re-
 * implementation of them.
 *
 *   leg0  boot — hub only, the pre-seeded DEAD marker was refused at boot
 *         (detached-restore.refused journaled), no second shell exists.
 *   leg1  openProject(B) through the sidebar → hub only (guard regression).
 *   leg2  detachProject(B) via the real entrypoint → a live project:B shell with
 *         working toolbar+sidebar chrome; the persisted marker is on disk.
 *   leg3  exclusivity — openProject(B) focuses the detached shell, no phantom
 *         hub; detaching hub-presented A transfers its live tabs, clears the
 *         affiliation first, and leaves the hub unscoped.
 *   leg4  terminal mint — a session minted inside the detached window is stamped
 *         project:B; the detached shell sees exactly B-scoped sessions; the hub
 *         cannot present B while it is detached.
 *   leg5  bridge — startSession bound to B's terminal mints its anchor on the
 *         detached host; navigate/screenshot land there; a FOREIGN-project tab
 *         drive is refused typed (D4 pin); a marked-dead project's mint refuses
 *         TERMINAL_SCOPE_UNRESOLVED (never re-homed onto the hub).
 *   leg5b unfocused-VISIBLE detached capture succeeds through the real MCP path;
 *         minimized → typed CAPTURE_FRAME_STARVATION refuse; a genuine
 *         navigation miss answers NAVIGATION_TIMEOUT, never TARGET_STALE.
 *   leg6  annotation pick on a detached B tab writes B's session only; a foreign
 *         (project-A) target refuses + journals; 'auto' skips without writes.
 *   leg7  ordinary close keeps detached:true on disk with NO fold; the explicit
 *         reattach folds, ingests live into the hub, and the re-read file shows
 *         owners['project:B'] absent plus the surviving minted rows.
 *   leg8  quit-coordination (TM, detached A, hub — detached B last standing) then
 *         a real second process cold-restores: detached shells B and A come back
 *         WITH tabs, the hub shows no B scope, owners.web holds no project:B
 *         rows, the DEAD record never resurrects, TM ≤1 across the boundary.
 *
 * Invariants asserted through the run: exactly one 'unassigned' shell ever, the
 * marker survives close, no fold without an explicit reattach.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-detached-webhub.cjs
 * Evidence: plans/261001-0902-detached-project-webhub-windows/reports/detached-webhub.{json,log}
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

const reportsDir = path.join(ROOT, 'plans', '261001-0902-detached-project-webhub-windows', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'detached-webhub.log');
if (process.env.ANTIFAN_DWH_LEG !== 'restart') fs.writeFileSync(logFile, '', 'utf8');
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

// ---- throwaway world (the restart leg reuses leg 1's root for restore proof) ----
const RESTART_LEG = process.env.ANTIFAN_DWH_LEG === 'restart';
const RESTART_ROOT = process.env.ANTIFAN_DWH_ROOT || '';
const tempRoot = RESTART_LEG && RESTART_ROOT ? RESTART_ROOT : fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dwh-probe-'));
const alphaDir = path.join(tempRoot, 'alpha');
const betaDir = path.join(tempRoot, 'beta');
const deadDir = path.join(tempRoot, 'dead');
fs.mkdirSync(alphaDir, { recursive: true });
fs.mkdirSync(betaDir, { recursive: true });
fs.mkdirSync(deadDir, { recursive: true });
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
// DEAD is a project no registry entry and no capsule ever describes: its seeded
// detached:true record must be refused at boot (leg8 asserts the journal row) and
// a terminal session claiming it must refuse to mint (leg5's marked-dead row).
const DEAD = {
  projectId: 'project-00000000-0000-4000-8000-0000000000d9',
  path: deadDir,
};

const BRIDGE_PORT = Number(process.env.ANTIFAN_DWH_BRIDGE_PORT) || (23400 + (process.pid % 300));
process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = process.env.ANTIFAN_DWH_USER_DATA || path.join(tempRoot, 'Profile');
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

// Leg 1 only: pre-seed the dead project's detached marker into the fresh profile.
// The restart leg's profile is a copy of this file — re-seeding it would erase
// leg 1's persisted world.
if (!RESTART_LEG) {
  const profileDir = process.env.ANTIFAN_USER_DATA;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'saved-tabs.json'),
    JSON.stringify({
      version: 2,
      owners: {
        [`project:${DEAD.projectId}`]: { tabs: [], detached: true, updatedAt: Date.now() },
      },
    }, null, 2),
    'utf8',
  );
}

// Boot the shipping main process inside this same Electron instance, exactly as the
// sibling probe does: guards run at import, the throwaway environment is already seeded.
const mainProcess = require(compiledModule('index.js'));
const { getLifecycleLogPath } = require(compiledModule('diagnostics/main-lifecycle-log.js'));
const { savedTabsFilePath } = require(compiledModule('browser/native-tab-host.js'));
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

/** A bound on calls that may wedge (session teardown, picker dispatch): never silent-hang. */
function bounded(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    sleep(ms).then(() => { throw new Error(`${label || 'call'} exceeded ${ms}ms`); }),
  ]);
}

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
const detachedKey = (projectId) => `project:${projectId}`;

/** The persisted owner map straight from disk — the file-level truth fold asserts read. */
function savedTabsOwners() {
  try {
    const parsed = JSON.parse(fs.readFileSync(savedTabsFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.owners && typeof parsed.owners === 'object'
      ? parsed.owners
      : {};
  } catch {
    return {};
  }
}
const terminalGeneration = (id) => { try { return terminal.getSession(id)?.sessionGeneration; } catch { return undefined; } };

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
  const id = `dwh-${crypto.randomUUID()}`;
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
  return await bridgeRpc(socket, method, params);
}

let dispatchSeq = 0;
/** One capability call over the live socket with the session's own authority fields. */
async function dispatchOnSocket(socket, session, name, params = {}, timeoutMs = 30000) {
  dispatchSeq += 1;
  const response = await bridgeRpc(socket, 'antifan.capability.dispatch', {
    requestId: `req-dwh-${dispatchSeq}`,
    idempotencyKey: `idem-dwh-${dispatchSeq}`,
    name,
    params,
    attachmentId: session.attachmentId,
    attachmentSecret: session.secret,
    authorityRevision: session.authorityRevision,
  }, timeoutMs);
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

let terminal;

/** Leg 2: a true second process, cold-booted against leg 1's persisted tempRoot. */
async function runRestart() {
  const authority = mainProcess.projectWindowAuthority;
  await app.whenReady();
  const lifecycleLog = getLifecycleLogPath();

  // Boot restore is asynchronous per record; wait for the full restored world —
  // the hub plus BOTH marked project shells — before judging any of them.
  const snapshot = await waitFor(
    () => {
      const entries = authority.snapshot();
      const hub = entryByOwnerKey(entries, 'web');
      const detB = entryByOwnerKey(entries, detachedKey(BETA.projectId));
      const detA = entryByOwnerKey(entries, detachedKey(ALPHA.projectId));
      return hub && detB && detA ? entries : false;
    },
    'the restored hub plus both detached project shells',
    60000,
  );

  const hubEntry = entryByOwnerKey(snapshot, 'web');
  const detBEntry = entryByOwnerKey(snapshot, detachedKey(BETA.projectId));
  const detAEntry = entryByOwnerKey(snapshot, detachedKey(ALPHA.projectId));
  const hubHost = authority.hostForOwner('web');
  const detachedHostB = authority.hostForOwner(detachedKey(BETA.projectId));
  const detachedHostA = authority.hostForOwner(detachedKey(ALPHA.projectId));

  await check('cold restart restores the hub and both detached shells', () => {
    expect(hubEntry && hubEntry.owner.kind === 'web', `startup owner was '${hubEntry && hubEntry.ownerKey}'`);
    expect(detBEntry && detBEntry.owner.kind === 'project' && detBEntry.owner.projectId === BETA.projectId, `B shell entry: ${JSON.stringify(detBEntry && detBEntry.owner)}`);
    expect(detAEntry && detAEntry.owner.kind === 'project' && detAEntry.owner.projectId === ALPHA.projectId, `A shell entry: ${JSON.stringify(detAEntry && detAEntry.owner)}`);
    expect(authority.browserShellCount() === 3, `browserShellCount() was ${authority.browserShellCount()}`);
    // The dead project's marked record must never resurrect a window.
    expect(!entryByOwnerKey(snapshot, detachedKey(DEAD.projectId)), `a dead record restored a shell: ${JSON.stringify(detachedKey(DEAD.projectId))}`);
  });
  await check('the detached B shell restores its persisted tabs', () => {
    const tabs = (detachedHostB.getTabList() || []).filter((t) => t && t.id);
    const fixtureTabs = tabs.filter((t) => String(t.url || '').includes('127.0.0.1'));
    expect(fixtureTabs.length > 0, `detached B restored no fixture tab: ${JSON.stringify(tabs.map((t) => t.url))}`);
    expect(detachedHostB.tabsForProject(BETA.projectId).length > 0, 'the restored detached host claims no B-stamped tabs');
    observations.restart = { bTabs: tabs.map((t) => ({ id: t.id, url: t.url })), bStamped: detachedHostB.tabsForProject(BETA.projectId) };
  });

  await check('the closed-at-quit detached A shell restores identically (detach is a mode)', () => {
    const tabs = (detachedHostA.getTabList() || []).filter((t) => t && t.id);
    expect(detachedHostA.tabsForProject(ALPHA.projectId).length > 0, 'the restored A shell claims no A-stamped tabs');
    observations.restartA = { aTabs: tabs.map((t) => t.id), aStamped: detachedHostA.tabsForProject(ALPHA.projectId) };
  });

  await check('the hub presents no B scope and carries no project:B residue rows', () => {
    expect(hubHost.activeProject() !== BETA.projectId, `hub active project was '${hubHost.activeProject()}'`);
    // Double-presentation residue: the hub's OWN persisted record must hold no
    // project:B-stamped rows — those belong to the detached record.
    const owners = savedTabsOwners();
    const webRows = (owners['web'] && Array.isArray(owners['web'].tabs) ? owners['web'].tabs : []);
    const bStampedRows = webRows.filter((row) => row && row.projectId === BETA.projectId);
    expect(bStampedRows.length === 0, `owners.web holds ${bStampedRows.length} project:B row(s): ${JSON.stringify(bStampedRows.map((r) => r && r.id))}`);
    // And in memory, the hub's live strip claims no B tabs either.
    expect(hubHost.tabsForProject(BETA.projectId).length === 0, `hub live strip claims B tabs: ${JSON.stringify(hubHost.tabsForProject(BETA.projectId))}`);
    // The boot marker records were consumed into live shells exactly once.
    const restoreEvents = journalEventsSince(lifecycleLog, 0).filter((r) => r.event === 'detached-restore.shell' && r.projectId === BETA.projectId);
    expect(restoreEvents.length > 0, 'no detached-restore.shell journal row for project B in this process');
    observations.detachedRestoreJournal = journalEventsSince(lifecycleLog, 0).filter((r) => String(r.event || '').startsWith('detached-restore'));
  });

  await check('Terminal Manager stays a singleton across the restart boundary', () => {
    const unassigned = snapshot.filter((entry) => entry.ownerKey === 'unassigned');
    expect(unassigned.length <= 1, `restart produced ${unassigned.length} Terminal Manager shells`);
  });
}

/** Leg 1 tail: cold-restart leg 2 against this run's persisted state. */
async function runColdRestartLeg(authority, detachedHostB) {
  // Flush the surviving detached host's record before its file is copied: the
  // restart leg's restore reads exactly what is on disk.
  try { detachedHostB.persistSync(); } catch {}
  const restartReport = path.join(reportsDir, 'detached-webhub-restart.json');
  // Single-instance lock is keyed on the user-data dir, and saved-tabs.json lives
  // under it too — clone ONLY the persisted strip (the Chromium cache subtree
  // holds locked files that break a wholesale copy) into leg 2's own profile.
  const leg2Profile = path.join(tempRoot, 'Profile-restart');
  fs.mkdirSync(leg2Profile, { recursive: true });
  fs.copyFileSync(path.join(tempRoot, 'Profile', 'saved-tabs.json'), path.join(leg2Profile, 'saved-tabs.json'));
  try { fs.unlinkSync(restartReport); } catch {}
  const childEnv = {
    ...process.env,
    ANTIFAN_DWH_LEG: 'restart',
    ANTIFAN_DWH_USER_DATA: leg2Profile,
    ANTIFAN_DWH_ROOT: tempRoot,
    ANTIFAN_DWH_BRIDGE_PORT: String(24500 + (process.pid % 200)),
    ANTIFAN_USER_DATA: leg2Profile,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Boot must NOT hand leg 2 a project: restore has to come from the persisted
  // records alone, so the env seeds leg 1 used are stripped before spawn.
  delete childEnv.ANTIFAN_PROJECT_ID;
  delete childEnv.ANTIFAN_WORKSPACE_ID;
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'probe-detached-webhub.cjs'), '--allow-eval'], {
    env: childEnv,
    timeout: 300000,
    encoding: 'utf8',
  });
  observations.coldRestart = {
    status: child.status,
    signal: child.signal,
    stderrTail: String(child.stderr || '').split('\n').slice(-8),
    stdoutTail: String(child.stdout || '').split('\n').slice(-14),
  };
  await check('cold restart leg restores both detached shells with tabs and no hub residue', () => {
    expect(child.status === 0, `restart leg exited ${child.status}: ${JSON.stringify(observations.coldRestart.stdoutTail)}`);
    const doc = JSON.parse(fs.readFileSync(restartReport, 'utf8'));
    expect(doc.failed === 0, `restart leg reported ${doc.failed} failed check(s): ${JSON.stringify(doc.checks && doc.checks.filter((c) => !c.ok))}`);
    expect(doc.observations && doc.observations.restart && Array.isArray(doc.observations.restart.bStamped) && doc.observations.restart.bStamped.length > 0, 'restart leg restored no detached tabs');
  });
}

let fixtureServer = null;
let fixtureSockets = new Set();

async function run() {
  const authority = mainProcess.projectWindowAuthority;
  if (RESTART_LEG) return runRestart();
  await app.whenReady();

  const fixture = http.createServer((req, res) => {
    const slug = (req.url || '/').split('?')[0];
    if (slug === '/hang') {
      // No bytes ever: the socket stays open but the response never begins, so
      // the renderer cannot commit a document — the genuine navigation miss that
      // must surface NAVIGATION_TIMEOUT, never TARGET_STALE. (Headers committed
      // once answered `navigated:true` — an about:blank-adjacent false positive
      // caught in live run 3.)
      req.once('close', () => { try { res.destroy(); } catch {} });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>dwh${slug}</title></head><body><h1 id=t>dwh${slug}</h1></body></html>`);
  });
  // Sockets are tracked so a hanging fixture request cannot strand the close below.
  fixture.on('connection', (socket) => {
    fixtureSockets.add(socket);
    socket.once('close', () => fixtureSockets.delete(socket));
  });
  fixtureServer = fixture;
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
  const pageUrl = (slug) => `${baseUrl}/${slug}`;
  const lifecycleLog = getLifecycleLogPath();
  const journalMark = () => { try { return lifecycleLog ? fs.statSync(lifecycleLog).size : 0; } catch { return 0; } };
  const journalOffset = journalMark();
  terminal = TerminalManager.getInstance();

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

  await check('boot: one web hub presenting A; the seeded DEAD marker was refused at boot', () => {
    expect(hubEntry.owner.kind === 'web', `startup owner kind was '${hubEntry.owner.kind}'`);
    expect(hubHost, 'the hub has no host');
    expect(hubHost.activeProject() === ALPHA.projectId, `hub active project was '${hubHost.activeProject()}'`);
    // The seeded dead marker must never have resurrected a shell — the boot leg
    // already refused it; one web hub is the only browser shell at this point.
    expect(authority.browserShellCount() === 1, `a dead-marker shell materialized: count ${authority.browserShellCount()}`);
    expect(!entryByOwnerKey(authority.snapshot(), detachedKey(DEAD.projectId)), 'the DEAD marker still resolves a shell');
  });

  const openB = await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
  await waitFor(() => hubHost.activeProject() === BETA.projectId, 'the hub to present project B');
  await check('leg1: default openProject(B) routes to the singleton hub, never a detached shell', () => {
    expect(openB && (openB.status === 'FOCUSED' || openB.status === 'OPENED'), `openProject returned ${JSON.stringify(openB)}`);
    expect(authority.browserShellCount() === 1, `a second shell appeared: count ${authority.browserShellCount()}`);
    expect(!entryByOwnerKey(authority.snapshot(), detachedKey(BETA.projectId)), 'openProject created a detached shell');
  });

  // One B tab + one A tab so detach transfers are measured on live rows.
  const tabB1 = await toolbarHub.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(pageUrl('beta'))})`, true);
  expect(typeof tabB1 === 'string' && tabB1, `tabB1 minted: ${JSON.stringify(tabB1)}`);
  await waitFor(
    () => {
      const wc = hubHost.getTabWebContents(tabB1, 'desktop');
      return wc && !wc.isDestroyed() && String(wc.getURL()).includes('/beta') ? true : false;
    },
    'the B tab to finish loading',
    15000,
  );

  // ---- leg 2: detachProject(B) through the REAL entrypoint ---------------------
  const detachMark = journalMark();
  const detachB = await authority.detachProject(BETA.projectId);
  observations.detachB = detachB;
  const detBKey = detachedKey(BETA.projectId);
  const detBEntry = await waitFor(
    () => entryByOwnerKey(authority.snapshot(), detBKey),
    'the detached project:B shell to register',
  );
  const detachedHostB = authority.hostForOwner(detBKey);
  const sidebarDetB = surfaceOf(authority.shellFor(detBKey), 'sidebar');
  const toolbarDetB = surfaceOf(authority.shellFor(detBKey), 'toolbar');
  await waitForApi(sidebarDetB, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.newTerminal === 'function'");
  await waitForApi(toolbarDetB, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");

  await check('leg2: detachProject(B) mints exactly one project:B shell with live chrome and a persisted marker', async () => {
    expect(detachB && detachB.status === 'DETACHED', `detach returned ${JSON.stringify(detachB)}`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(detBEntry.owner.kind === 'project' && detBEntry.owner.projectId === BETA.projectId, `detached owner was ${JSON.stringify(detBEntry.owner)}`);
    expect(detachedHostB && detachedHostB !== hubHost, 'the detached shell shares the hub host');
    // The B tab moved with the project: the transfer carried the live row across.
    await waitFor(
      () => detachedHostB.tabsForProject(BETA.projectId).length > 0,
      'the transferred B tab to land on the detached host',
      10000,
    );
    // Chrome readiness is the code-resolved evidence the plan asked for: both
    // surfaces answered their APIs above, and the identity names the project.
    expect(detBEntry.identity && detBEntry.identity.owner && detBEntry.identity.owner.kind === 'project', `detached identity was ${JSON.stringify(detBEntry.identity)}`);
    // The marker is file-level truth: the record exists and is detached-marked.
    detachedHostB.persistSync();
    const owners = savedTabsOwners();
    expect(owners[detBKey] && owners[detBKey].detached === true, `no detached marker on disk: ${JSON.stringify(Object.keys(owners))}`);
    const journaled = journalEventsSince(lifecycleLog, detachMark).filter((r) => r.event === 'project-detach' && r.projectId === BETA.projectId);
    expect(journaled.length > 0, 'no project-detach journal row');
    // The hub no longer presents B — its scope and its stamp moved to the shell.
    expect(hubHost.activeProject() !== BETA.projectId, `hub still presents B: ${hubHost.activeProject()}`);
  });

  // ---- leg 3a: exclusivity — openProject(B) while detached focuses, no phantom hub
  const openBDetached = await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
  observations.openBDetached = openBDetached;
  await check('leg3a: openProject(B) under a live detached shell focuses it — never a phantom hub scope', () => {
    expect(openBDetached && openBDetached.status === 'FOCUSED', `openProject returned ${JSON.stringify(openBDetached)}`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(hubHost.activeProject() !== BETA.projectId, `the hub adopted B: ${hubHost.activeProject()}`);
    const entry = entryByOwnerKey(authority.snapshot(), detBKey);
    expect(entry && entry.visible === true, 'the detached shell was not presented');
  });
  await check('leg3a: the hub-side activation funnel refuses a detached project (hub flip refused)', async () => {
    // A `project:` owner through the one funnel is routed to the hub path, where
    // activateWebHubProject's detached arm refuses typed — no hub presentation.
    let threw = null;
    try {
      await authority.ensureProjectWindow({ kind: 'project', projectId: BETA.projectId }, 'user');
    } catch (err) {
      threw = err;
    }
    expect(threw, 'the funnel accepted a detached project onto the hub');
    expect(/TRANSACTION_CONFLICT|detached/i.test(String(threw && (threw.code || threw.message || threw))), `unexpected refusal shape: ${messageOf(threw)}`);
  });

  // ---- leg 3b: detaching the hub-presented project transfers its live tabs -----
  // A is hub-presented now; mint an A tab, then detach A through the entrypoint.
  const openA = await sidebarHub.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(ALPHA.projectId)})`, true);
  await waitFor(() => hubHost.activeProject() === ALPHA.projectId, 'the hub to present project A');
  const tabA1 = await toolbarHub.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(pageUrl('alpha'))})`, true);
  expect(typeof tabA1 === 'string' && tabA1, `tabA1 minted: ${JSON.stringify(tabA1)}`);
  await waitFor(
    () => {
      const wc = hubHost.getTabWebContents(tabA1, 'desktop');
      return wc && !wc.isDestroyed() && String(wc.getURL()).includes('/alpha') ? true : false;
    },
    'the A tab to finish loading',
    15000,
  );

  const detachA = await authority.detachProject(ALPHA.projectId);
  observations.detachA = detachA;
  const detAKey = detachedKey(ALPHA.projectId);
  await waitFor(() => entryByOwnerKey(authority.snapshot(), detAKey), 'the detached project:A shell to register');
  const detachedHostA = authority.hostForOwner(detAKey);
  await waitFor(
    () => detachedHostA && detachedHostA.tabsForProject(ALPHA.projectId).length > 0,
    'the transferred A tab to land on the detached host',
    10000,
  );
  await check('leg3b: detaching the hub-presented project transfers live tabs, clears affiliation, drops hub scope', () => {
    expect(detachA && detachA.status === 'DETACHED', `detach(A) returned ${JSON.stringify(detachA)}`);
    expect(authority.browserShellCount() === 3, `browserShellCount() was ${authority.browserShellCount()}`);
    // The hub tab moved to the detached host (a fresh id — live ingest remints).
    expect(authority.hostForTab(tabA1) === null || detachedHostA.getTabList().some((t) => String(t.url || '').includes('/alpha')), 'no A-stamped tab reached the detached host');
    expect(hubHost.tabsForProject(ALPHA.projectId).length === 0, `the hub kept A tabs: ${JSON.stringify(hubHost.tabsForProject(ALPHA.projectId))}`);
    expect(hubHost.activeProject() !== ALPHA.projectId, `the hub still presents A: ${hubHost.activeProject()}`);
    // Affiliation was cleared before scope: a hub mint now stamps no project.
    const minted = hubHost.createTab(pageUrl('post-detach'), true);
    const stamped = (hubHost.getTabList().find((t) => t.id === minted) || {}).projectId;
    expect(stamped !== ALPHA.projectId && stamped !== BETA.projectId, `a post-detach hub mint stamped '${stamped}'`);
    hubHost.closeTab(minted, 'probe-cleanup');
    observations.transfer = { aTabsOnDetached: detachedHostA.tabsForProject(ALPHA.projectId), hubActive: hubHost.activeProject() };
  });

  // ---- leg 4: terminal mint inside the detached window is stamped project:B ----
  const beforeSessionIds = new Set((terminal.listSessions() || []).map((s) => s.id));
  const mintResult = await sidebarDetB.executeJavaScript('window.antifanStandalone.newTerminal()', true);
  observations.detachedMint = mintResult;
  const sessionB = await waitFor(
    () => {
      const fresh = (terminal.listSessions() || []).filter((s) => !beforeSessionIds.has(s.id));
      return fresh.length > 0 ? fresh[0].id : false;
    },
    'the detached window to mint a terminal session',
    20000,
  );
  // A control session for A — minted under its own live detached owner — and a
  // hub session under 'web' (the only owner the hub can still mint).
  const sessionA = await Promise.resolve(terminal.createSession(ALPHA.path, ALPHA.capsuleId, detachedKey(ALPHA.projectId)));
  const sessionHub = await Promise.resolve(terminal.createSession(alphaDir, ALPHA.capsuleId, 'web'));
  observations.sessions = {
    sessionB,
    ownerB: terminal.sessionOwnerKey(sessionB),
    sessionA,
    ownerA: terminal.sessionOwnerKey(sessionA),
    sessionHub,
    ownerHub: terminal.sessionOwnerKey(sessionHub),
  };
  await waitFor(
    () => {
      const list = terminal.listSessions(true) || terminal.listSessions();
      const b = (Array.isArray(list) ? list : []).find((s) => s.id === sessionB);
      const a = (Array.isArray(list) ? list : []).find((s) => s.id === sessionA);
      return b && a && b.state === 'running' && a.state === 'running' ? true : false;
    },
    'both detached-project terminal sessions to reach running state',
    20000,
  );

  await check('leg4: a terminal minted in the detached window is stamped project:B and scoped to it', () => {
    expect(terminal.sessionOwnerKey(sessionB) === detBKey, `detached mint owner was '${terminal.sessionOwnerKey(sessionB)}'`);
    expect(terminal.sessionOwnerKey(sessionA) === detAKey, `A mint owner was '${terminal.sessionOwnerKey(sessionA)}'`);
    // The detached shell sees exactly B-scoped rows — owner-key visibility, not a count.
    const visibleB = (detachedHostB.visibleTerminalSessions() || []).map((s) => s.id);
    expect(visibleB.includes(sessionB), `detached B scope missing its own session: ${JSON.stringify(visibleB)}`);
    expect(!visibleB.includes(sessionA), `detached B leaked A's session: ${JSON.stringify(visibleB)}`);
    expect(!visibleB.includes(sessionHub), `detached B leaked the hub session: ${JSON.stringify(visibleB)}`);
    // The hub cannot see either detached project's sessions — and it can never
    // mint one: presenting B was refused in leg3a, so a 'project:B' stamp is
    // unreachable from hub chrome (minted here directly, the session simply has
    // no window).
    const hubVisible = (hubHost.visibleTerminalSessions() || []).map((s) => s.id);
    expect(!hubVisible.includes(sessionB), `hub leaked detached session B: ${JSON.stringify(hubVisible)}`);
    expect(!hubVisible.includes(sessionA), `hub leaked detached session A: ${JSON.stringify(hubVisible)}`);
    expect(hubVisible.includes(sessionHub), `hub lost its own session: ${JSON.stringify(hubVisible)}`);
    observations.hubScope = { visibleB, hubVisible };
  });

  // ---- leg 5: bridge session bound to detached B routes to the detached host ---
  const pairedB = await pairBridge('eval');
  const socketB = await openBridgeSocket(pairedB.secret);
  const startB = await bridgeCall(socketB, 'antifan.cli.startSession', {
    backendId: 'detached-webhub-b',
    grant: 'eval',
    ttlMs: 900000,
    terminalSessionId: sessionB,
    terminalGeneration: terminalGeneration(sessionB),
    attachmentId: pairedB.attachmentId || undefined,
  });
  observations.startSessionB = { success: startB.success, data: startB.data, error: startB.error };
  expect(startB && startB.success === true, `startSession B failed: ${JSON.stringify(startB)}`);
  const sessionAgentB = { runId: startB.data.runId, attemptId: startB.data.attemptId, attachmentId: startB.data.attachmentId, secret: startB.data.secret, authorityRevision: startB.data.authorityRevision };
  const anchorB = startB.data.tabId;

  await check('leg5: a bridge session bound to detached B mints its anchor on the detached host', () => {
    expect(typeof anchorB === 'string' && anchorB.length > 0, `no anchor tab minted: ${JSON.stringify(startB.data)}`);
    const ownerHost = authority.hostForTab(anchorB);
    expect(ownerHost === detachedHostB, `the anchor landed on ${ownerHost === hubHost ? 'the hub' : 'another host'} — the mint resolver mis-routed it`);
    expect(detachedHostB.getTabCapsuleId(anchorB) === BETA.capsuleId, `anchor capsule was '${detachedHostB.getTabCapsuleId(anchorB)}', expected '${BETA.capsuleId}'`);
    expect(startB.data.projectId === BETA.projectId, `session project was '${startB.data.projectId}'`);
  });

  const navBound = await dispatchOnSocket(socketB, sessionAgentB, 'browser.navigate', { url: pageUrl('bound-b') });
  await check('leg5: bound dispatch lands on the detached host only', async () => {
    expect(navBound.success === true, `navigate failed: ${JSON.stringify(navBound)}`);
    const wc = detachedHostB.getTabWebContents(anchorB, 'desktop');
    const landed = await waitFor(async () => (wc && !wc.isDestroyed() && String(wc.getURL()).includes('/bound-b') ? true : false), 'the detached bound tab navigation', 10000);
    expect(landed, 'the bound tab never reported the URL');
    // The hub is untouched: none of its tabs navigated.
    const hubUrls = (hubHost.getTabList() || []).map((t) => String(t.url || ''));
    expect(!hubUrls.some((u) => u.includes('/bound-b')), `the dispatch leaked onto the hub: ${JSON.stringify(hubUrls)}`);
  });

  await check('leg5: cross-drive of a FOREIGN-project detached tab is refused typed (D4)', async () => {
    // A foreign-project tab: the live detached A shell's transferred tab. Same-
    // project tabs are legitimately rebindable (D4), so the foreign project is
    // the only honest refusal shape here.
    const foreignTab = (detachedHostA.getTabList() || [])[0];
    expect(foreignTab && foreignTab.id, 'the detached A shell has no tab for the foreign-drive row');
    const cross = await dispatchOnSocket(socketB, sessionAgentB, 'browser.navigate', { tabId: foreignTab.id, url: pageUrl('cross') });
    observations.crossSession = { success: cross.success, error: cross.error };
    expect(cross.success === false, `a foreign-project drive was accepted: ${JSON.stringify(cross)}`);
    const code = cross.error && (cross.error.code || cross.error);
    expect(/TARGET|REFUS|FORBIDDEN|DENIED|MISMATCH|SCOPE/i.test(String(code)), `no typed refusal: ${JSON.stringify(cross.error)}`);
    const wcForeign = detachedHostA.getTabWebContents(foreignTab.id, 'desktop');
    expect(!(wcForeign && !wcForeign.isDestroyed() && String(wcForeign.getURL()).includes('/cross')), 'the foreign tab navigated anyway');
  });

  await check('leg5: a marked-dead project mint refuses TERMINAL_SCOPE_UNRESOLVED, never the hub', async () => {
    // The seeded DEAD record's owner claim routes to no live window and must not
    // re-home onto the hub: the resolver refuses typed before a tab is minted.
    const sessionDead = await Promise.resolve(terminal.createSession(DEAD.path, undefined, detachedKey(DEAD.projectId)));
    observations.sessionDead = { sessionDead, owner: terminal.sessionOwnerKey(sessionDead) };
    const pairedDead = await pairBridge('eval');
    const socketDead = await openBridgeSocket(pairedDead.secret);
    const startDead = await bridgeCall(socketDead, 'antifan.cli.startSession', {
      backendId: 'detached-webhub-dead',
      grant: 'eval',
      ttlMs: 60000,
      terminalSessionId: sessionDead,
      terminalGeneration: terminalGeneration(sessionDead),
      attachmentId: pairedDead.attachmentId || undefined,
    });
    observations.startSessionDead = { success: startDead.success, error: startDead.error };
    try { socketDead.close(); } catch {}
    expect(startDead && startDead.success === false, `a dead-project mint was accepted: ${JSON.stringify(startDead)}`);
    const code = String((startDead.error && (startDead.error.code || startDead.error)) || (startDead.data && startDead.data.code) || '');
    expect(code.includes('TERMINAL_SCOPE_UNRESOLVED'), `the refusal was ${code}, not TERMINAL_SCOPE_UNRESOLVED`);
    expect(authority.browserShellCount() === 3, `a shell grew from the refused mint: ${authority.browserShellCount()}`);
    try { await bounded(Promise.resolve(terminal.closeSession(sessionDead)), 10000, 'closeSession(sessionDead)'); } catch {}
  });

  // ---- leg 5b: unfocused-visible capture on the detached window ----------------
  // Bound-tab authority: rebind the agent session onto the detached shell's own
  // visible tab (same-project tab — allowed per D4), then capture through the
  // real MCP path while the window is unfocused but VISIBLE.
  const detachedTabB = (detachedHostB.getTabList() || []).find((t) => String(t.url || '').includes('/beta'));
  expect(detachedTabB && detachedTabB.id, 'the detached shell has no visible B tab for the capture row');
  const rebindB = await dispatchOnSocket(socketB, sessionAgentB, 'browser.rebind-target', { tabId: detachedTabB.id });
  expect(rebindB.success === true, `rebind to the detached visible tab failed: ${JSON.stringify(rebindB)}`);
  observations.rebindToVisible = { success: rebindB.success, tabId: rebindB.data && rebindB.data.data && rebindB.data.data.tabId };

  const detachedWindow = authority.windowFor(detBKey);
  const hubWindow = authority.windowFor(hubKey);
  expect(detachedWindow && !detachedWindow.isDestroyed(), 'no detached native window');
  // unfocused + VISIBLE: present the hub's focus elsewhere without occluding B.
  hubWindow.focus();
  await waitFor(() => !detachedWindow.isFocused() && detachedWindow.isVisible(), 'the detached window visible-unfocused', 10000);
  const unfocusedAt = Date.now();
  const shotUnfocused = await dispatchOnSocket(socketB, sessionAgentB, 'browser.screenshot', { format: 'png', tabId: detachedTabB.id });
  const envelopeUnfocused = (shotUnfocused.data && shotUnfocused.data.data) || shotUnfocused.data || {};
  observations.captureUnfocused = {
    success: shotUnfocused.success,
    ms: Date.now() - unfocusedAt,
    byteLength: envelopeUnfocused.byteLength,
    artifactRef: envelopeUnfocused.artifactRef,
    error: shotUnfocused.error,
  };
  await check('leg5b: unfocused-VISIBLE detached capture succeeds through the real MCP path', () => {
    expect(shotUnfocused.success === true, `unfocused-visible capture failed: ${JSON.stringify(shotUnfocused.error)}`);
    expect(envelopeUnfocused.ok === true && envelopeUnfocused.artifactRef, `capture returned no artifact: ${JSON.stringify(Object.keys(envelopeUnfocused))}`);
    expect(typeof envelopeUnfocused.byteLength === 'number' && envelopeUnfocused.byteLength > 1000, `capture byteLength was ${envelopeUnfocused.byteLength}`);
  });

  // The discriminating row. Presentation-state starvation is unreachable on this
  // box — minimize AND hide both keep the compositor driving the renderer (the
  // gate's repair ladder recovered each live run: minimized → CAPTURE_TIMEOUT at
  // the raster bound, hidden → capture accepted). The state the gate actually
  // measures is a renderer whose rAF never fires while it still answers — a real
  // background-throttled hidden page produces exactly that, deterministically.
  const detachedWc = detachedHostB.getTabWebContents(detachedTabB.id, 'desktop');
  const busyStartedAt = Date.now();
  try { detachedWc && detachedWc.executeJavaScript('(function(){var u=Date.now()+4000;while(Date.now()<u){}})()'); } catch {}
  detachedWindow.hide();
  await waitFor(() => detachedWindow.isVisible() === false, 'the detached window to hide', 10000);
  // Journal the gate's own signal first: rAF cannot answer while the main
  // thread is parked — 'stalled' is the starvation evidence itself.
  const rafProbe = await Promise.race([
    detachedWc.executeJavaScript('new Promise(function (r) { requestAnimationFrame(function () { r(true); }); })').then(() => 'alive'),
    sleep(500).then(() => 'stalled'),
  ]).catch(() => 'error');
  const gateMark = journalMark();
  const shotHidden = await dispatchOnSocket(socketB, sessionAgentB, 'browser.screenshot', { format: 'png', tabId: detachedTabB.id });
  observations.captureHidden = {
    success: shotHidden.success,
    error: shotHidden.error,
    rafProbe,
    frameGate: journalEventsSince(lifecycleLog, gateMark).filter((r) => String(r.event || '').startsWith('capture.')),
  };
  // Let the bounded busy-wait expire before anything else reads the renderer.
  const busyRemaining = busyStartedAt + 4000 - Date.now();
  if (busyRemaining > 0) await sleep(busyRemaining + 200);
  detachedWindow.show();
  await waitFor(() => detachedWindow.isVisible() === true, 'the detached window to reshow', 10000);
  await check('leg5b: starved detached capture refuses with a typed surface code', () => {
    expect(shotHidden.success === false, `a starved capture was accepted: ${JSON.stringify(shotHidden)}`);
    const code = String((shotHidden.error && (shotHidden.error.code || shotHidden.error)) || '');
    // The refusal family the gate emits, in ladder order: the frame-liveness gate
    // answers CAPTURE_FRAME_STARVATION when rAF is silent but the renderer still
    // replies; a main thread parked past the measurement bound answers
    // NO_RENDER_SURFACE first (Runtime.evaluate itself cannot run); a raster that
    // outlives its bound answers CAPTURE_TIMEOUT. Any of them is the typed refusal
    // this row pins — the actual code is journaled in observations.captureHidden.
    expect(/CAPTURE_FRAME_STARVATION|NO_RENDER_SURFACE|CAPTURE_TIMEOUT/.test(code), `the refusal was ${code}, not a typed surface code`);
  });

  // The new wire contract, on a session of its own: a hanging navigation wedges
  // its tab's serialized operation queue, so it must never ride the same session
  // the legs after it still use. A fresh project:B session mints its own anchor
  // on the detached host; the bound tab's miss answers NAVIGATION_TIMEOUT, never
  // the blanket TARGET_STALE the field report hit — then the session is released.
  const sessionNavTerm = await Promise.resolve(terminal.createSession(BETA.path, BETA.capsuleId, detBKey));
  const pairedNav = await pairBridge('eval');
  const socketNav = await openBridgeSocket(pairedNav.secret);
  const startNav = await bridgeCall(socketNav, 'antifan.cli.startSession', {
    backendId: 'detached-webhub-nav',
    grant: 'eval',
    ttlMs: 300000,
    terminalSessionId: sessionNavTerm,
    terminalGeneration: terminalGeneration(sessionNavTerm),
    attachmentId: pairedNav.attachmentId || undefined,
  });
  expect(startNav && startNav.success === true, `nav-miss session failed to start: ${JSON.stringify(startNav)}`);
  const sessionAgentNav = { runId: startNav.data.runId, attemptId: startNav.data.attemptId, attachmentId: startNav.data.attachmentId, secret: startNav.data.secret, authorityRevision: startNav.data.authorityRevision };
  expect(authority.hostForTab(startNav.data.tabId) === detachedHostB, 'the nav-miss anchor did not mint on the detached host');

  // A bare agent anchor is about:blank — navigating it answered a false-positive
  // `navigated:true` on the empty document's own load. Drive a real loaded tab:
  // open-tab mints on the session's host, rebind takes it (same-project, allowed),
  // then the hang URL is a genuine load that must time out.
  const openedNav = await dispatchOnSocket(socketNav, sessionAgentNav, 'browser.open-tab', { url: pageUrl('nav-real') });
  const navTab = openedNav && openedNav.data && openedNav.data.data && openedNav.data.data.tabId;
  expect(typeof navTab === 'string' && navTab, `open-tab for the nav-miss row returned ${JSON.stringify(openedNav)}`);
  const rebindNav = await dispatchOnSocket(socketNav, sessionAgentNav, 'browser.rebind-target', { tabId: navTab });
  expect(rebindNav.success === true, `rebind to the loaded tab failed: ${JSON.stringify(rebindNav)}`);
  await waitFor(
    () => {
      const wc = detachedHostB.getTabWebContents(navTab, 'desktop');
      return wc && !wc.isDestroyed() && String(wc.getURL()).includes('/nav-real') ? true : false;
    },
    'the nav-miss tab to finish loading',
    15000,
  );
  // 'hang' commits an empty document on this Chromium (the wire answered
  // navigated:true on it twice — journaled). The deterministic genuine miss is a
  // refused socket: did-fail-load records LOAD_FAILED and the wire must carry
  // THAT code — never the retired blanket TARGET_STALE the field report hit.
  const navHang = await dispatchOnSocket(socketNav, sessionAgentNav, 'browser.navigate', { url: 'http://127.0.0.1:1/dwh-miss' }, 45000);
  const navTabWc = detachedHostB.getTabWebContents(navTab, 'desktop');
  observations.navigationTimeout = {
    success: navHang.success,
    error: navHang.error,
    dataCode: navHang.data && navHang.data.code,
    viewState: {
      wcAlive: Boolean(navTabWc && !navTabWc.isDestroyed()),
      hibernated: (detachedHostB.getTabList().find((t) => t.id === navTab) || {}).hibernated,
      url: navTabWc && !navTabWc.isDestroyed() ? navTabWc.getURL() : null,
    },
  };
  await check('leg5b: a genuine navigation miss reports its typed cause, never TARGET_STALE', () => {
    expect(navHang.success === false, `the dead-socket navigation succeeded: ${JSON.stringify(navHang)}`);
    const code = String((navHang.error && (navHang.error.code || navHang.error)) || (navHang.data && navHang.data.code) || '');
    expect(/LOAD_FAILED|NAVIGATION_(START_)?TIMEOUT/.test(code), `the miss reported ${code}, expected a typed navigation cause`);
    expect(!code.includes('TARGET_STALE'), `the miss reported the retired blanket code: ${code}`);
  });
  try {
    await bridgeCall(socketNav, 'antifan.cli.endSession', {
      runId: sessionAgentNav.runId, attemptId: sessionAgentNav.attemptId,
      attachmentId: sessionAgentNav.attachmentId, secret: sessionAgentNav.secret, outcome: 'completed',
    });
  } catch {}
  try { socketNav.close(); } catch {}
  try { await bounded(Promise.resolve(terminal.closeSession(sessionNavTerm)), 10000, 'closeSession(sessionNavTerm)'); } catch {}
  try {
    observations.navigationTimeout.recorded = detachedHostB.getLastNavigationFailure
      ? detachedHostB.getLastNavigationFailure(navTab)
      : 'unavailable';
  } catch {}


  // ---- leg 6: annotation routing under detached+hub topology --------------------
  // A pick on the detached B tab names sessions by id: the picker's own scope
  // gate decides — B's session is in scope there, A's is foreign.
  const writes = [];
  const switches = [];
  const originalWriteTo = terminal.writeTo.bind(terminal);
  const originalSwitch = terminal.switchSession.bind(terminal);
  terminal.writeTo = (id, input) => { writes.push({ id, input: String(input).slice(0, 240) }); return originalWriteTo(id, input); };
  terminal.switchSession = (id) => { switches.push(id); return originalSwitch(id); };
  try {
    const devtoolsB = detachedHostB.getDevToolsHost();
    const tabBWc = detachedHostB.getTabWebContents(detachedTabB.id, 'desktop');
    const annotationMark = journalMark();

    // The detached window's scope owns only B sessions: naming A's session is
    // foreign and must refuse, journal, and write nothing.
    const warnMarkForeign = consoleWarnings.length;
    await bounded(Promise.resolve(devtoolsB.handleInspectPickResult(detachedTabB.id, tabBWc, 'desktop', devtoolsB.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'detached-page',
      targetSessionId: sessionA, userComment: 'foreign-pick-probe', copyOnly: false,
    })), 20000, 'foreign pick');
    await sleep(200);

    await check('leg6: a pick naming a foreign-project session refuses and writes nothing', () => {
      const aWrites = writes.filter((w) => w.id === sessionA && w.input.includes('foreign-pick-probe'));
      expect(aWrites.length === 0, `foreign pick wrote to session A: ${JSON.stringify(aWrites)}`);
      const skips = consoleWarnings.slice(warnMarkForeign).filter((line) => line.includes('annotation dispatch skipped'));
      expect(skips.some((line) => line.includes('foreign-target-refused')), `no foreign-target-refused warning: ${JSON.stringify(skips)}`);
      const journaled = journalEventsSince(lifecycleLog, annotationMark).filter((r) => r.event === 'annotation.dispatchSkipped');
      expect(journaled.length > 0, 'no annotation.dispatchSkipped journal row');
    });

    // The same pick naming B's own session writes there and nowhere else.
    await bounded(Promise.resolve(devtoolsB.handleInspectPickResult(detachedTabB.id, tabBWc, 'desktop', devtoolsB.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'detached-page',
      targetSessionId: sessionB, userComment: 'own-pick-probe', copyOnly: false,
    })), 20000, 'own pick');
    await sleep(200);

    await check("leg6: a pick naming the detached scope's session writes there only", () => {
      const bWrites = writes.filter((w) => w.id === sessionB && w.input.includes('own-pick-probe'));
      expect(bWrites.length > 0, `the pick never reached session B: writes=${JSON.stringify(writes)}`);
      expect(writes.filter((w) => w.id === sessionA || w.id === sessionHub).length === 0, 'the pick leaked to a foreign session');
      expect(switches.includes(sessionB), `dispatch never switched to session B: ${JSON.stringify(switches)}`);
    });

    // 'auto' under detached+hub topology stays owner-key scoped: the fixture URL
    // resolves to no workspace, so the honest outcome is a skip — never a write
    // into whichever session happens to be active.
    const autoMark = journalMark();
    const warnMarkAuto = consoleWarnings.length;
    await bounded(Promise.resolve(devtoolsB.handleInspectPickResult(detachedTabB.id, tabBWc, 'desktop', devtoolsB.inspectGeneration, {
      selector: 'h1', tagName: 'H1', text: 'detached-page',
      targetSessionId: 'auto', userComment: 'auto-pick-probe', copyOnly: false,
    })), 20000, 'auto pick');
    await sleep(200);

    await check("leg6: an 'auto' pick with an unresolvable workspace skips without any write", () => {
      const autoWrites = writes.filter((w) => w.input.includes('auto-pick-probe'));
      expect(autoWrites.length === 0, `'auto' pick wrote a terminal: ${JSON.stringify(autoWrites)}`);
      const freshWarns = consoleWarnings.slice(warnMarkAuto).filter((line) => line.includes('annotation dispatch skipped'));
      const journaled = journalEventsSince(lifecycleLog, autoMark).filter((r) => r.event === 'annotation.dispatchSkipped');
      expect(freshWarns.length > 0 || journaled.length > 0, "'auto' pick produced neither a skip warning nor a journal row");
    });
  } finally {
    terminal.writeTo = originalWriteTo;
    terminal.switchSession = originalSwitch;
  }

  // ---- leg 7: ordinary close keeps the marker (no fold); reattach folds + ingests
  // A live attachment bound to a detached tab vetoes the close through the live-use
  // gate — the window must be closed the way its last user leaves it: the agent
  // session ends and its socket releases first, then a native close request.
  const endB = await bridgeCall(socketB, 'antifan.cli.endSession', {
    runId: sessionAgentB.runId,
    attemptId: sessionAgentB.attemptId,
    attachmentId: sessionAgentB.attachmentId,
    secret: sessionAgentB.secret,
    outcome: 'completed',
  });
  observations.endSessionB = { success: endB && endB.success, error: endB && endB.error };
  try { socketB.close(); } catch {}
  await sleep(600);
  // Bare terminal sessions are owner-keyed and outlive their window, but a close
  // gate may still count live work — release B's session before its window goes.
  try { await bounded(Promise.resolve(terminal.closeSession(sessionB)), 10000, 'closeSession(sessionB)'); } catch {}
  // The agent session's own managed rows went down with it; mint one user-plane tab
  // through the detached chrome so the persisted record carries rows a user left.
  const keptTab = await toolbarDetB.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(pageUrl('detach-keep'))})`, true);
  await waitFor(
    () => {
      const wc = detachedHostB.getTabWebContents(keptTab, 'desktop');
      return wc && !wc.isDestroyed() && String(wc.getURL()).includes('/detach-keep') ? true : false;
    },
    'the user-minted detached tab to load',
    15000,
  );
  const closeMark = journalMark();
  detachedHostB.persistSync();
  const detachedRowsBefore = (savedTabsOwners()[detBKey] || {}).tabs || [];
  observations.leg7Rows = { rowsBeforeClose: detachedRowsBefore.length, keptTab };
  const closeDetached = authority.requestClose(detBKey);
  await waitFor(() => authority.browserShellCount() === 2, 'the detached B window to close');
  await sleep(400);

  await check('leg7: an ordinary close keeps detached:true on disk and never folds', () => {
    expect(closeDetached === true, 'the close request never reached the detached window');
    expect(!entryByOwnerKey(authority.snapshot(), detBKey), 'the closed shell still resolves in the directory');
    // File-level marker proof: the record is still detached-marked with its rows.
    const owners = savedTabsOwners();
    const closeEvents = journalEventsSince(lifecycleLog, closeMark).map((r) => r.event);
    observations.leg7Close = { events: closeEvents, record: owners[detBKey], ownerKeys: Object.keys(owners) };
    expect(owners[detBKey] && owners[detBKey].detached === true, `the marker died with the window: ${JSON.stringify(Object.keys(owners))}`);
    expect(Array.isArray(owners[detBKey].tabs) && owners[detBKey].tabs.length > 0, `the close dropped the detached rows (close events: ${JSON.stringify(closeEvents)})`);
    // No fold ran: no reattach-shaped journal events exist for this close at all.
    const foldEvents = journalEventsSince(lifecycleLog, closeMark).filter((r) => /reattach|fold/i.test(String(r.event || '')));
    expect(foldEvents.length === 0, `a fold ran on ordinary close: ${JSON.stringify(foldEvents)}`);
    expect(detBKey in owners, 'the owner record vanished');
  });

  const reattachMark = journalMark();
  const reattachB = await authority.reattachProject(BETA.projectId);
  observations.reattachB = reattachB;
  await waitFor(
    () => hubHost.tabsForProject(BETA.projectId).length > 0,
    'the folded B tabs to land live on the hub',
    15000,
  );
  await check('leg7: reattach folds the record and the hub shows B tabs live — no restart', () => {
    expect(reattachB && reattachB.status === 'REATTACHED', `reattach returned ${JSON.stringify(reattachB)}`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(!entryByOwnerKey(authority.snapshot(), detBKey), 'the detached shell survived the reattach');
    // Post-fold coherence, file level: the record is absent AND the folded rows
    // survive under owners.web — the same assert the entrypoint runs internally.
    const owners = savedTabsOwners();
    expect(!(detBKey in owners), `owners['project:B'] survived the fold: ${JSON.stringify(Object.keys(owners))}`);
    const webIds = new Set(((owners['web'] || {}).tabs || []).map((r) => r && r.id));
    const liveIds = hubHost.getTabList().map((t) => t.id);
    const persistedIds = (detachedRowsBefore || []).map((r) => r && r.id).filter(Boolean);
    // Live ingest minted fresh ids; the file's folded rows are what persistSync
    // wrote — assert the live hub ids are the ones on disk.
    for (const id of liveIds.filter((id) => hubHost.tabsForProject(BETA.projectId).includes(id))) {
      expect(webIds.has(id), `a live folded tab id is missing from owners.web: ${id}`);
    }
    expect(hubHost.tabsForProject(BETA.projectId).length > 0, `hub holds no live B tabs: ${JSON.stringify(hubHost.tabsForProject(BETA.projectId))}`);
    observations.fold = { persistedRows: persistedIds.length, liveBTabIds: hubHost.tabsForProject(BETA.projectId) };
    const journaled = journalEventsSince(lifecycleLog, reattachMark).filter((r) => r.event === 'project-reattach' && r.projectId === BETA.projectId);
    expect(journaled.length > 0, 'no project-reattach journal row');
  });

  // ---- leg 8: re-detach B, then the quit-order leg, then a true cold restart ----
  const redetachB = await authority.detachProject(BETA.projectId);
  await waitFor(() => entryByOwnerKey(authority.snapshot(), detBKey), 'the re-detached project:B shell to register');
  const detachedHostB2 = authority.hostForOwner(detBKey);
  await waitFor(
    () => detachedHostB2 && detachedHostB2.tabsForProject(BETA.projectId).length > 0,
    'the re-detached B shell to re-ingest its tabs',
    15000,
  );
  await check('leg8: re-detach after reattach recreates the shell with B tabs', () => {
    expect(redetachB && (redetachB.status === 'DETACHED' || redetachB.status === 'FOCUSED'), `re-detach returned ${JSON.stringify(redetachB)}`);
    expect(authority.browserShellCount() === 3, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(detachedHostB2 && detachedHostB2 !== hubHost, 'the re-detached shell shares the hub host');
  });

  // The shared Terminal Manager — the third surface of the topology.
  const managerEntry = await authority.ensureProjectWindow({ kind: 'unassigned' }, 'user');
  const managerKey = managerEntry.ownerKey;
  await waitFor(
    () => {
      const entry = authority.snapshot().find((candidate) => candidate.ownerKey === managerKey);
      return entry && entry.visible === true ? entry : false;
    },
    'the Terminal Manager window to be presented',
  );
  await check('leg8: the Terminal Manager opens as the fourth shell and sees every scope', () => {
    expect(authority.browserShellCount() === 4, `browserShellCount() was ${authority.browserShellCount()}`);
    const managerHost = authority.hostForOwner(managerKey);
    const managerRows = (managerHost.visibleTerminalSessions() || []).map((s) => s.id);
    // sessionB was released at leg7's close; the live rows are A's and the hub's.
    expect(managerRows.includes(sessionA) && managerRows.includes(sessionHub), `manager scope missing rows: ${JSON.stringify(managerRows)}`);
  });

  // Quit-coordination for the 4-shell topology: close TM, then detached A, then
  // the HUB — detached B must be the last shell standing, and closing it last is
  // what the cold-restart leg restores from. Order matters: a last-shell close
  // starts a quit, so B closes inside cleanup, after leg 2 has been spawned.
  const quitMark = journalMark();
  expect(authority.requestClose(managerKey) === true, 'the manager close was refused');
  await waitFor(() => authority.browserShellCount() === 3, 'the Terminal Manager to close');
  try { await bounded(Promise.resolve(terminal.closeSession(sessionA)), 10000, 'closeSession(sessionA)'); } catch {}
  expect(authority.requestClose(detAKey) === true, 'the detached A close was refused');
  await waitFor(() => authority.browserShellCount() === 2, 'the detached A shell to close');
  try { await bounded(Promise.resolve(terminal.closeSession(sessionHub)), 10000, 'closeSession(sessionHub)'); } catch {}
  expect(authority.requestClose(hubKey) === true, 'the hub close was refused');
  await waitFor(() => authority.browserShellCount() === 1, 'the hub to close');
  await sleep(400);

  await check('leg8: quit ordering — TM, detached A and hub close in turn; detached B survives as last shell', () => {
    const after = authority.snapshot();
    expect(after.length === 1 && after[0].ownerKey === detBKey, `the survivors were ${JSON.stringify(after.map((e) => e.ownerKey))}`);
    // Detached A's ordinary close kept its marker: boot restores it too.
    const owners = savedTabsOwners();
    expect(owners[detAKey] && owners[detAKey].detached === true, 'detached A lost its marker on close');
    expect(owners[detBKey] && owners[detBKey].detached === true, 'detached B lost its marker on close');
    expect(detAKey in owners, 'the closed A record vanished');
    // Nothing folded: the only fold on record is leg7's explicit reattach.
    const folds = journalEventsSince(lifecycleLog, quitMark).filter((r) => /reattach/i.test(String(r.event || '')));
    expect(folds.length === 0, `a fold ran during the close sequence: ${JSON.stringify(folds)}`);
    expect(app.isReady() === true, 'the app died with its third shell');
  });

  // Cold restart — the real second process, against this run's persisted root.
  await runColdRestartLeg(authority, detachedHostB2);

  // ---- invariants --------------------------------------------------------------
  await check('invariant: exactly one unassigned shell ever existed across the run', () => {
    const created = journalEventsSince(lifecycleLog, journalOffset).filter((r) => r.event === 'terminal-manager-open');
    const snapshotCount = authority.snapshot().filter((e) => e.ownerKey === 'unassigned').length;
    expect(snapshotCount === 0, 'a Terminal Manager is still open');
    expect(created.length <= 1, `unassigned shells created: ${created.length}`);
  });

  try { socketB.close(); } catch {}
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
  try { if (fixtureServer) { for (const socket of fixtureSockets) try { socket.destroy(); } catch {} await new Promise((r) => fixtureServer.close(r)); } } catch {}
  if (!RESTART_LEG) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
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
      probe: 'detached-webhub',
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
      observations,
      at: new Date().toISOString(),
    };
    const reportName = RESTART_LEG ? 'detached-webhub-restart.json' : 'detached-webhub.json';
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
