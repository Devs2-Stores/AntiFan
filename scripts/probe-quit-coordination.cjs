/**
 * Protected close and coordinated application quit — real Electron probe.
 *
 * Boots the shipping main process in this Electron instance and drives its own
 * entrypoints, then judges what the process actually did:
 *
 *   a. the coordinator is idle at boot (no reservations, phase `open`);
 *   b. a close attempt reserves its pages synchronously, then closes one window and
 *      leaves its siblings — and their tabs — untouched;
 *   c. a new tab arriving inside the close window survives and retains the shell;
 *   d. a page that vetoes its unload produces an honest partial, never an undo promise;
 *   e. a binding attempted while its page is reserved is refused (TARGET_STALE), so a
 *      page can never be bound and then destroyed by the same attempt;
 *   f. a Quit while a run is queued is refused with no service teardown, and repeated
 *      Quit requests coalesce into the one attempt;
 *   g. a late veto in the shared Terminal Manager (a first-class shell) keeps every
 *      service alive and releases application admission;
 *   i. the Terminal Manager that vetoed a quit stays discoverable to the shipping gate,
 *      so a later attempt reaches it instead of losing it;
 *   j. the unload settle question per case — for a programmatic close and for a user-driven
 *      one, which of `destroyed` / `will-prevent-unload` / neither arrives, and after how long,
 *      observed on the WebContents that can report it;
 *   h. the last browser shell going away drives the same application gate: ordered
 *      teardown, committed shutdown, then the platform's quit — with the terminal window
 *      closed by the attempt and no forced exit in the journal.
 *
 * Every check names the value it judged, and a check that cannot observe its subject
 * fails rather than skips: this probe is the acceptance evidence unit tests cannot give
 * (real windows, real unload vetoes, a real process exit).
 *
 * Run: node scripts/run-electron.cjs scripts/probe-quit-coordination.cjs
 * Evidence: plans/260927-0315-project-windows/reports/quit-coordination-probe.{json,log}
 */
const { app, BrowserWindow, webContents } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
// The isolated build (`tsc --outDir .tmp-pw-quit`) is pointed at explicitly; the repository
// default stays `.compiled`, which is what `npm run compile` produces.
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));
const compiledShared = (relative) => path.join(compiledRoot, 'src', 'shared', relative.split('/').join(path.sep));

const reportsDir = path.join(ROOT, 'plans', '260927-0315-project-windows', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'quit-coordination-probe.log');
fs.writeFileSync(logFile, '', 'utf8');
// Synchronous: the process exits straight after the summary, and a buffered stream would
// drop the evidence for the run that failed hardest.
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};
/**
 * The shell's own honesty channel. A closed shell whose chrome survived reports it here, so the
 * probe judges that report instead of trusting its own view of the same contents — and can also
 * catch a report that a shell should not have made.
 */
const shellWarnings = [];
const origError = console.error;
console.error = (...args) => {
  const line = args.map((arg) => String(arg)).join(' ');
  shellWarnings.push(line);
  origError(...args);
  try { fs.appendFileSync(logFile, `${line}\n`, 'utf8'); } catch {}
};

// Throwaway world: temp data root (config, control plane, runtime) and temp Chromium
// profile, both seeded before the main process is required. Nothing here can read or write
// the developer's real profile, real data root or real capsules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-quit-probe-'));
const alphaDir = path.join(tempRoot, 'alpha');
const betaDir = path.join(tempRoot, 'beta');
const gammaDir = path.join(tempRoot, 'gamma');
for (const dir of [alphaDir, betaDir, gammaDir]) fs.mkdirSync(dir, { recursive: true });
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
const GAMMA = {
  projectId: 'project-00000000-0000-4000-8000-0000000000c3',
  workspaceId: 'workspace-00000000-0000-4000-8000-0000000000c3',
  capsuleId: 'capsule-probe-gamma',
  name: 'Probe Gamma',
  path: gammaDir,
};

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
// The detached terminal host is deliberately out of this probe: it is designed to outlive
// the GUI, so it would leave a daemon process behind on a developer's machine. The gate's
// terminal dimension is read from the in-process manager, which is the same TerminalManager
// surface the daemon proxy presents.
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
process.env.ANTIFAN_BRIDGE_PORT = String(20900 + (process.pid % 90));
// The control plane reads its authoritative workspace root from the environment when the
// process does not pass one, and the boot project's capsule is exactly that root.
process.env.ANTIFAN_WORKSPACE_ROOT = alphaDir;

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    version: 1,
    activeCapsuleId: ALPHA.capsuleId,
    capsules: [ALPHA, BETA, GAMMA].map((entry) => ({
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

// Boot the shipping main process inside this same Electron instance; its boot guards run at
// import, so the throwaway environment above must already be seeded.
const mainProcess = require(compiledModule('index.js'));
const { getLifecycleLogPath } = require(compiledModule('diagnostics/main-lifecycle-log.js'));
const { makeControlPlaneId, issueRuntimeLease } = require(compiledShared('control-plane-contracts.js'));

// Answers the one question a wedged row cannot: is the main thread still turning? A tick
// stream that stops while the probe waits means something synchronous is blocking main, and
// a stream that continues means the reply simply never came back. The step is the finer
// pointer: it names what the probe was waiting on when the ticks were still arriving.
let currentRow = 'boot';
let currentStep = 'booting';
let heartbeatTicks = 0;
const heartbeat = setInterval(() => {
  heartbeatTicks += 1;
  console.log(`[probe heartbeat] tick ${heartbeatTicks} (row: ${currentRow}; step: ${currentStep})`);
}, 500);

/**
 * Every row this probe must execute, in order. A run that stops early has to fail rather than
 * quietly shrink, so the last row compares what ran against this list.
 */
const ROW_ACCOUNTING = 'every row of the probe executed and reported pass';
const EXPECTED_ROWS = [
  'the coordinator is idle at boot: one browser shell, no reservation, phase open',
  'a real queued run exists in the shipping run service',
  'two browser shells exist: the hub with its tabs, the manager beside it',
  'a close attempt reserves its member pages before it awaits anything',
  'closing one window disposes only it, releases its reservation, and starts no quit',
  'a closed window leaves no chrome content reachable and reports no survivor',
  'a page that vetoes its unload retains the shell, with an honest partial report',
  'a tab arriving during the close survives and the shell is retained',
  'a Quit while a run is queued is refused, coalesced, and tears nothing down',
  'shared services are still usable after the refusal',
  'the terminal run state reopens the gate instead of locking it out',
  'a binding attempted during unload is refused; a page cannot be bound and then destroyed',
  'a late veto in a project shell while the Manager is open keeps services alive, releases admission and never commits',
  'the application is still usable after the late veto: a window opens and runs a page',
  'the vetoed quit closed the page-less manager and retained the vetoing shell',
  'unload settle (a): a page with no unload handler is destroyed by the close and reports no veto',
  'unload settle (b): a vetoing page reports will-prevent-unload, survives the close, and dies once disarmed',
  'unload settle (c): an already-destroyed content reports no event, so its outcome is read from state',
  'unload settle (d): a user-driven close with user activation reaches the app as the page veto',
  'the last browser shell closing runs the same application gate and exits orderly',
  'the ordered teardown ran once and nothing forced the exit',
  'a confirmed explicit force closes its own busy+vetoing window while the sibling remains untouched',
  'a cancelled explicit force confirmation performs no destruction',
];

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

/**
 * Bound one close attempt. A real Electron unload veto can leave a native close with no
 * terminal outcome at all, and an unbounded probe would sit there instead of reporting it:
 * a hung attempt is a finding, so it fails the row that produced it and lets the run end.
 */
async function bounded(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no outcome within ${ms}ms (the attempt is still running)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

async function waitForApi(target, expression, timeoutMs = 20000) {
  await waitFor(
    async () => {
      if (!target || target.isDestroyed()) return false;
      try {
        // The eval is itself bounded: a renderer that never answers must not freeze the poll,
        // which would leave the deadline above meaningless.
        return (await bounded(target.executeJavaScript(expression, true), 2000, 'chrome surface eval')) === true;
      } catch {
        return false;
      }
    },
    `chrome surface API: ${expression}`,
    timeoutMs,
  );
}

const surfaceOf = (shell, surface) => (surface === 'sidebar' ? shell?.sidebarView : shell?.toolbarView)?.webContents ?? null;

/** The page inside a tab, which is where an unload veto has to be installed. */
function pageOf(authority, tabId) {
  return authority.hostForTab(tabId)?.getTabWebContents(tabId, 'desktop') ?? null;
}


/** A page that refuses to unload: the veto the close attempt has to report honestly. */
const ARM_UNLOAD_VETO = "window.onbeforeunload = () => { return 'probe: this page refuses to close'; }; true";
const DISARM_UNLOAD_VETO = 'window.onbeforeunload = null; true';

/**
 * Every window Electron still reports, asked of Electron rather than of a host.
 *
 * A census that cannot lose its subject is the only way to tell "closed" from "no longer
 * asked for", so the rows that assert a window is gone read this.
 */
function windowCensus() {
  return BrowserWindow.getAllWindows().map((window) => {
    let url = 'unreadable';
    let destroyed = true;
    try {
      destroyed = window.isDestroyed();
      if (!destroyed) url = String(window.webContents.getURL()).slice(0, 48);
    } catch (err) {
      url = `unreadable: ${messageOf(err)}`;
    }
    return { id: window.id, destroyed, url };
  });
}

let lastJournalReadError = null;
/** The journal the shipping process writes, read from disk (every line is appended synchronously). */
function journalEvents() {
  try {
    const raw = fs.readFileSync(getLifecycleLogPath(), 'utf8');
    lastJournalReadError = null;
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line); } catch { return { event: 'unparsable' }; }
      });
  } catch (err) {
    lastJournalReadError = messageOf(err);
    return null;
  }
}

let willQuitSeen = false;
let willQuitHold = null;
const willQuitPromise = new Promise((resolve) => { willQuitHold = resolve; });
// The probe holds the platform's exit open at `will-quit` so the run can assert what the
// committed quit looked like before the process goes away; the shipping listener has already
// run and done its synchronous cleanup by then.
app.on('will-quit', (event) => {
  // Hold EVERY will-quit, not just the first: a coalesced second quit attempt also calls
  // app.quit() (same committed report), and letting that second event through exits the
  // process before the reporter can write.
  event.preventDefault();
  if (!willQuitSeen) {
    willQuitSeen = true;
    willQuitHold('will-quit');
  }
});

async function openProject(sidebar, projectId) {
  return await bounded(
    sidebar.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(projectId)})`, true),
    20000,
    'sidebar openProject',
  );
}

async function createTabViaToolbar(toolbar, url = 'about:blank', label = 'toolbar createTab') {
  return await bounded(
    toolbar.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(url)})`, true),
    15000,
    label,
  );
}

/**
 * Evaluate on a chrome renderer the shipping process already committed a document to (a
 * toolbar, a sidebar, a terminal popout). Bounded, so a renderer that never answers fails the
 * row that asked instead of wedging the run.
 */
async function evalIn(contents, code, label) {
  expect(contents && !contents.isDestroyed(), `${label}: the renderer is gone`);
  return await bounded(contents.executeJavaScript(code, true), 15000, label);
}

/**
 * The page inside a tab, with a committed document.
 *
 * A tab the host creates at `about:blank` is deliberately never navigated — a blank tab keeps no
 * renderer process at all — and Electron leaves `executeJavaScript` pending forever on a
 * `WebContents` with no committed navigation: measured on this Electron, an untouched
 * `WebContentsView` answers no eval at all, in a shown window exactly as in a hidden one. The
 * probe therefore commits a document before it evaluates, instead of mistaking that pending
 * promise for a wedged toolbar.
 */
async function pageFor(authority, tabId, label) {
  const page = pageOf(authority, tabId);
  expect(page && !page.isDestroyed(), `${label}: tab ${tabId} has no live page`);
  if (!page.getURL()) {
    await bounded(page.loadURL('about:blank'), 15000, `${label}: commit a document in tab ${tabId}`);
  }
  return page;
}

/** Evaluate on a tab page that is known to carry a document. */
async function evalOnPage(authority, tabId, code, label) {
  const page = await pageFor(authority, tabId, label);
  return await evalIn(page, code, `${label}: evaluate in tab ${tabId}`);
}

/**
 * Every page the directory knows, with whether a close of it is still in flight. This is what
 * a quit that produces no report at all can be asked afterwards: which page never settled.
 */
function pageStateDump(authority) {
  const rows = [];
  for (const entry of authority.snapshot()) {
    const host = authority.hostForOwner(entry.ownerKey);
    for (const tabId of entry.tabIds) {
      const row = { ownerKey: entry.ownerKey, tabId };
      try {
        const contents = host?.getTabWebContents(tabId, 'desktop');
        row.url = contents ? String(contents.getURL()).slice(0, 32) : 'no contents';
        row.destroyed = contents ? contents.isDestroyed() : 'n/a';
      } catch (err) {
        row.url = `unreadable: ${messageOf(err)}`;
      }
      row.closeInFlight = Boolean(host?.pendingPageCloses?.has?.(tabId));
      row.closeAuthorized = Boolean(host?.attemptAuthorizedCloses?.has?.(tabId));
      rows.push(row);
    }
  }
  return rows;
}

/** Every chrome content a shell owns, by role: what a closed shell must leave nothing reachable of. */
function chromeContentsOf(shell) {
  if (!shell) return [];
  const found = [];
  for (const [role, view] of [['toolbar', shell.toolbarView], ['sidebar', shell.sidebarView], ['frameBackdrop', shell.frameBackdropView]]) {
    let contents = null;
    try { contents = (view && view.webContents) || null; } catch { contents = null; }
    if (contents) found.push({ role, id: contents.id, contents });
  }
  return found;
}

/**
 * Every answer Electron gives about one content's liveness, because they are not the same
 * question and they can disagree after a teardown:
 *   - `foundById`     : Electron's own registry still resolves the id (a leak would be found here
 *                       and could still run script, which is the question a leak is about);
 *   - `reportsDestroyed`: what the retained `WebContents` wrapper says about itself, which is the
 *                       read the shell's own disposal audit performs;
 *   - `runsScript`    : whether the content still answers a trivial evaluation.
 * A row that judged only one of them would call a lagging wrapper a leak, or miss one.
 */
function livenessOf(entry) {
  const contents = entry.contents;
  let reportsDestroyed = 'unreadable';
  try { reportsDestroyed = contents.isDestroyed(); } catch (err) { reportsDestroyed = `unreadable: ${messageOf(err)}`; }
  let found = null;
  try { found = webContents.fromId(entry.id) || null; } catch { found = null; }
  return { role: entry.role, id: entry.id, foundById: Boolean(found), reportsDestroyed, runsScript: 'not-attempted' };
}

/**
 * Follow `before` until each content is gone, and report when each one went.
 *
 * A single reachability read cannot tell a slow teardown from a content that never died, and
 * Chromium has been measured to land this teardown ~10ms after the call, so a read taken in the
 * first turn after a close reports a leak for a content that is already on its way out. Polling
 * to a bound answers the question the row is actually about: what, if anything, is STILL
 * reachable once the teardown has had its chance.
 */
async function chromeDeathTimeline(before, { timeoutMs = 3000, pollMs = 10 } = {}) {
  const startedAt = Date.now();
  const diedAt = {};
  const samples = [];
  const stillAlive = (entry) => {
    const now = livenessOf(entry);
    return now.foundById || now.reportsDestroyed !== true;
  };
  while (true) {
    const alive = before.filter(stillAlive);
    samples.push({ atMs: Date.now() - startedAt, reachable: alive.map((entry) => `${entry.role}#${entry.id}`) });
    if (alive.length === 0 || Date.now() - startedAt >= timeoutMs) {
      const remaining = alive.map((entry) => `${entry.role}#${entry.id}`);
      for (const entry of before) {
        const label = `${entry.role}#${entry.id}`;
        if (!remaining.includes(label) && diedAt[label] === undefined) diedAt[label] = Date.now() - startedAt;
      }
      // What every still-answerable content can still do, asked once at the end: a content that
      // answers script is alive in the only sense that matters to a user.
      const finalState = [];
      for (const entry of before) {
        const state = livenessOf(entry);
        if (state.foundById || state.reportsDestroyed !== true) {
          try {
            const value = await entry.contents.executeJavaScript('2 + 2', true);
            state.runsScript = value === 4 ? 'yes' : `no (returned ${JSON.stringify(value)})`;
          } catch (err) {
            state.runsScript = `no (${messageOf(err)})`;
          }
        }
        finalState.push(state);
      }
      return { elapsedMs: Date.now() - startedAt, diedAt, remaining, samples, finalState };
    }
    await sleep(pollMs);
  }
}

/** Wait for a *new* coordinated quit report, so a previous attempt cannot be mistaken for it. */
async function waitForQuitReport(previousAttemptId, description, timeoutMs = 30000) {
  return await waitFor(
    () => {
      const report = mainProcess.projectWindowAuthority.lastQuitReport();
      return report && report.attemptId !== previousAttemptId ? report : false;
    },
    description,
    timeoutMs,
  );
}

/** Wait for a *new* close report for one owner, so an earlier attempt cannot be mistaken for it. */
async function waitForCloseReport(ownerKeyValue, previousAttemptId, description, timeoutMs = 30000) {
  return await waitFor(
    () => {
      const report = mainProcess.projectWindowAuthority.lastCloseReport(ownerKeyValue);
      return report && report.attemptId !== previousAttemptId ? report : false;
    },
    description,
    timeoutMs,
  );
}

/**
 * One programmatic native close, with every event that can report it observed on the object
 * that can report it.
 *
 * `destroyed` and `will-prevent-unload` belong to the `WebContents` that is closing; a listener
 * on the `BrowserWindow` hears neither, which is how a veto once looked silent. Nothing here
 * decides an outcome and nothing arms a policy timer: this calls the same
 * `close({ waitForBeforeUnload: true })` the shipping page close calls, waits a bounded
 * observation window, and records which events arrived and how many milliseconds after the
 * call — so a case that produces no event at all can be reported as exactly that instead of
 * being read as success or failure.
 */
async function observeNativeClose(contents, label, observeMs = 700) {
  const startedAt = Date.now();
  const events = [];
  const timings = {};
  const note = (what) => {
    const atMs = Date.now() - startedAt;
    events.push(what);
    if (timings[what] === undefined) timings[what] = atMs;
  };
  const attached = [];
  const attach = (event, handler) => {
    try {
      contents.on(event, handler);
      attached.push([event, handler]);
    } catch (err) {
      note(`attach-failed:${event}:${messageOf(err)}`);
    }
  };
  attach('destroyed', () => note('destroyed'));
  attach('will-prevent-unload', () => note('will-prevent-unload'));
  let callError = null;
  try {
    contents.close({ waitForBeforeUnload: true });
  } catch (err) {
    // The call itself refusing (an already-destroyed content has nothing to close) is not an
    // unload event: it is recorded beside the events, never mixed into them, so a case that
    // produces no event can still be read as exactly that.
    callError = messageOf(err);
  }
  await sleep(observeMs);
  for (const [event, handler] of attached) {
    try { contents.removeListener(event, handler); } catch {}
  }
  let destroyed = 'unreadable';
  try { destroyed = contents.isDestroyed(); } catch (err) { destroyed = `unreadable: ${messageOf(err)}`; }
  return { label, contentsId: contents.id, events, timings, callError, destroyed, elapsedMs: Date.now() - startedAt };
}

async function run() {
  const authority = mainProcess.projectWindowAuthority;
  const plane = () => authority.controlPlane();

  await bounded(app.whenReady(), 60000, 'Electron to report itself ready');

  // ---- (a) idle at boot --------------------------------------------------------------
  const bootstrap = await waitFor(
    () => {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup project window',
  );
  const alphaKey = bootstrap.ownerKey;
  const alpha = { projectId: ALPHA.projectId, workspaceId: ALPHA.workspaceId, path: ALPHA.path };
  const reservationsAtBoot = authority.reservations();
  observations.boot = { alphaKey, browserShellCount: authority.browserShellCount(), phase: authority.applicationPhase(), reservations: reservationsAtBoot };

  await check('the coordinator is idle at boot: one browser shell, no reservation, phase open', () => {
    expect(authority.browserShellCount() === 1, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(authority.applicationPhase() === 'open', `applicationPhase() was '${authority.applicationPhase()}'`);
    expect(reservationsAtBoot.reservedCount === 0, `reserved pages at boot: ${JSON.stringify(reservationsAtBoot.reservedTabIds)}`);
    expect(reservationsAtBoot.applicationReserved === false, 'application admission was already reserved at boot');
  });

  const toolbarA = surfaceOf(authority.shellFor(alphaKey), 'toolbar');
  const sidebarA = surfaceOf(authority.shellFor(alphaKey), 'sidebar');
  await waitForApi(toolbarA, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
  await waitForApi(sidebarA, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");

  // ---- a run whose window is not the one being closed --------------------------------
  // Queued, not started: a real run record in the shipping run service with a real chat
  // behind it. Nothing about it is bound to a page, which is exactly why it must refuse the
  // application quit while leaving a shell close of another window alone.
  const controlPlane = plane();
  expect(controlPlane, 'the probe booted without a control plane');
  const chat = controlPlane.chats.create(alpha.projectId, alpha.workspaceId, 'probe shared work');
  const queuedRun = controlPlane.runs.createRun(alpha.projectId, alpha.workspaceId, chat.id, 'probe-backend');
  const queuedRuns = controlPlane.runs.listRuns(alpha.projectId);
  observations.queuedRun = { runId: queuedRun.id, chatId: chat.id, state: queuedRun.state, runs: queuedRuns.map((run) => ({ id: run.id, state: run.state })) };

  await check('a real queued run exists in the shipping run service', () => {
    expect(queuedRun.state === 'queued', `the run state was '${queuedRun.state}'`);
    expect(queuedRuns.some((run) => run.id === queuedRun.id && run.state === 'queued'), `the run service does not list ${queuedRun.id} as queued`);
  });

  // ---- (b) the second surface: the shared Terminal Manager --------------------------
  // One Web Hub presents every project (openProject re-presents the same shell), so the
  // second independent surface the gate answers for is the shared Terminal Manager — a
  // first-class shell of its own, not a second project window (none exists anymore).
  const openB = await openProject(sidebarA, BETA.projectId);
  const betaEntry = await bounded(
    authority.ensureProjectWindow({ kind: 'unassigned' }, 'user'),
    30000,
    'the shared Terminal Manager'
  );
  const betaKey = betaEntry.ownerKey;
  // The veto/close rows run on the hub itself: a second project shell no longer exists, so
  // `gammaKey` names the hub — rebound after every close/reopen below.
  let gammaKey = alphaKey;
  await bounded(waitFor(() => authority.browserShellCount() === 2, 'two browser shells'), 20000, 'two browser shells to exist');

  const tabA = await createTabViaToolbar(toolbarA);
  const tabB = await createTabViaToolbar(toolbarA);
  await sleep(250);
  observations.windows = {
    openB,
    keys: { alphaKey, betaKey, gammaKey },
    tabs: { tabA, tabB },
    counts: authority.snapshot().map((entry) => ({ key: entry.ownerKey, tabs: entry.tabIds })),
  };

  await check('two browser shells exist: the hub with its tabs, the manager beside it', () => {
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    const manager = authority.snapshot().find((candidate) => candidate.ownerKey === betaKey);
    expect(manager, 'the Terminal Manager is not in the directory');
    expect(manager.owner.kind === 'unassigned', `the second shell's owner is ${JSON.stringify(manager.owner)}`);
    const hub = authority.snapshot().find((candidate) => candidate.ownerKey === alphaKey);
    expect(hub, 'the web hub is not in the directory');
    for (const tab of [tabA, tabB]) {
      expect(typeof tab === 'string' && tab.length > 0, `the hub created no tab (${JSON.stringify(tab)})`);
      expect(hub.tabIds.includes(tab), `the hub does not list tab ${tab}: ${JSON.stringify(hub.tabIds)}`);
    }
  });

  // ---- (b) close one window while its siblings are idle ------------------------------
  // The coordinator's own entrypoint, called the way the shell's close-request listener
  // calls it; the reservation check reads the table synchronously, straight after the call,
  // which is the window in which an arrival must already be excluded.
  currentRow = 'close first window while siblings idle';
  currentStep = 'capture the closing window\'s own chrome';
  const alphaChromeBeforeClose = chromeContentsOf(authority.shellFor(alphaKey));
  const warningsBeforeAlphaClose = shellWarnings.length;
  const alphaTabsBeforeClose = authority.snapshot().find((entry) => entry.ownerKey === alphaKey)?.tabIds || [];
  currentStep = 'close the first window';
  const alphaAttempt = bounded(authority.attemptClose(alphaKey, 'user'), 20000, 'close of the first window');
  const reservedDuringAttempt = authority.reservations();
  const alphaReport = await alphaAttempt;
  await bounded(waitFor(() => authority.browserShellCount() === 1, 'the hub to close'), 15000, 'the hub to leave the directory');
  currentStep = 'judge what the closed window left behind';
  const alphaChromeTimeline = await chromeDeathTimeline(alphaChromeBeforeClose);
  const alphaWarnings = shellWarnings.slice(warningsBeforeAlphaClose);
  observations.closeAlpha = {
    chromeBeforeClose: alphaChromeBeforeClose.map(({ role, id }) => ({ role, id })),
    chromeTimeline: alphaChromeTimeline,
    shellWarnings: alphaWarnings,
    reservedDuringAttempt,
    report: alphaReport,
    count: authority.browserShellCount(),
    betaTabs: authority.snapshot().find((entry) => entry.ownerKey === betaKey)?.tabIds,
    reservationsAfter: authority.reservations(),
    appReady: app.isReady(),
    quitReported: authority.lastQuitReport(),
  };

  await check('a closed window leaves no chrome content reachable and reports no survivor', () => {
    expect(alphaChromeBeforeClose.length >= 3, `the closing window reported only ${alphaChromeBeforeClose.length} chrome content(s): ${JSON.stringify(alphaChromeBeforeClose)}`);
    // The row judges every answer Electron gives about those contents, not a read taken in the
    // first turn after the close: Chromium lands this teardown on a later turn (measured ~10ms),
    // so an immediate read would fail a content already on its way out while saying nothing about
    // a content that never dies.
    const stillAnswerable = alphaChromeTimeline.finalState.filter(
      (state) => state.foundById || state.reportsDestroyed !== true || state.runsScript === 'yes'
    );
    expect(
      alphaChromeTimeline.remaining.length === 0 && stillAnswerable.length === 0,
      `chrome content outlived the closed window ${alphaKey}: ` +
      `still there after ${alphaChromeTimeline.elapsedMs}ms ${JSON.stringify(alphaChromeTimeline.remaining)}, ` +
      `final state ${JSON.stringify(stillAnswerable)}, first read ${JSON.stringify(alphaChromeTimeline.samples[0] || null)}`
    );
    // The shell's own honesty channel is judged here, never silenced: a content it names must
    // be one it actually owned, and a report of survivors cannot stand if the earliest
    // independent read of the same set already found every content gone. The shell judges its
    // own 50ms settle window, so a content that dies shortly after it is a fact reported
    // honestly — the leak question is the end of the observation above, and the report itself
    // is kept exactly as the shipping code emits it.
    const survivors = alphaWarnings.filter((line) => line.includes('still alive'));
    const notifiedIds = [...new Set((survivors.join(' ') || '').match(/#(\d+)/g) || [])].map((match) => Number(match.slice(1)));
    expect(
      notifiedIds.every((id) => alphaChromeBeforeClose.some((entry) => entry.id === id)),
      `the shell reported a survivor that was never one of its contents: ${JSON.stringify(survivors)}`
    );
    const firstReadReachable = alphaChromeTimeline.samples[0]?.reachable ?? [];
    expect(
      firstReadReachable.length > 0 || notifiedIds.length === 0,
      `the shell reported survivors although the earliest independent read already found every content gone: ` +
      `${JSON.stringify({ notifiedIds, firstRead: firstReadReachable, survivors })}`
    );
  });

  await check('a close attempt reserves its member pages before it awaits anything', () => {
    expect(reservedDuringAttempt.reservedCount > 0, `no page was reserved: ${JSON.stringify(reservedDuringAttempt)}`);
    expect(reservedDuringAttempt.reservedTabIds.includes(tabA), `the attempt did not reserve its own page ${tabA}: ${JSON.stringify(reservedDuringAttempt.reservedTabIds)}`);
    // The manager owns no pages, so the old "sibling page is not reserved" check now reads:
    // every reserved page belongs to the closing hub itself.
    expect(reservedDuringAttempt.reservedTabIds.every((id) => alphaTabsBeforeClose.includes(id)), `the attempt reserved a page outside the closing hub: ${JSON.stringify(reservedDuringAttempt.reservedTabIds)}`);
  });

  await check('closing one window disposes only it, releases its reservation, and starts no quit', () => {
    expect(alphaReport.disposition === 'closed', `the close reported '${alphaReport.disposition}' (haltedBy ${String(alphaReport.haltedBy)})`);
    expect(alphaReport.closed.length >= 1, `the close reported ${alphaReport.closed.length} closed pages for a window that presents pages`);
    expect(alphaReport.closed.some((page) => page.tabId === tabA), `the close did not report page ${tabA}`);
    expect(alphaReport.closed.every((page) => alphaTabsBeforeClose.includes(page.tabId)), `the close destroyed a page that was not this window's: ${JSON.stringify(alphaReport.closed)}`);
    expect(alphaReport.lastBrowserShellGone === false, 'the close claimed the last browser shell was gone with two windows open');
    expect(authority.browserShellCount() === 1, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(authority.hostForOwner(alphaKey) === null, 'the closed window still has a host');
    expect(authority.hostForOwner(betaKey) !== null, "the closed window's close disposed the sibling shell's host");
    const betaEntry = authority.snapshot().find((entry) => entry.ownerKey === betaKey);
    expect(betaEntry !== undefined, `the sibling shell is gone: ${JSON.stringify(authority.snapshot().map((entry) => entry.ownerKey))}`);
    const after = authority.reservations();
    expect(after.reservedCount === 0 && after.applicationReserved === false, `the attempt left a reservation behind: ${JSON.stringify(after)}`);
    expect(app.isReady() === true, 'the process is no longer ready after a window closed');
    expect(authority.lastQuitReport() === null, 'closing one window started an application quit');
    // The queued run belongs to the closed window's project, yet it never refused the close:
    // a run with no page binding is application-scope evidence, not page-scope evidence.
    expect(alphaReport.refusals.length === 0, `the close refused with ${JSON.stringify(alphaReport.refusals)}`);
  });

  // ---- (d) a page that vetoes its unload ---------------------------------------------
  // The hub was closed above; the remaining close rows run on a reopened hub with the
  // manager open beside it — same surfaces, same gate, one less project shell to pretend
  // exists.
  const gammaReopenD = await bounded(authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'user'), 30000, 'reopen the hub for the veto row');
  gammaKey = gammaReopenD.ownerKey;
  const toolbarG = surfaceOf(authority.shellFor(gammaKey), 'toolbar');
  await waitForApi(toolbarG, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
  currentRow = 'unload veto';
  currentStep = 'create the page that will refuse to unload';
  const sacrificialTab = await createTabViaToolbar(toolbarG, 'about:blank', 'seed a page the vetoed close can destroy');
  const vetoTab = await createTabViaToolbar(toolbarG, 'about:blank', 'toolbar createTab for the vetoing page');
  currentStep = 'arm the unload veto on that page';
  const vetoPage = await pageFor(authority, vetoTab, 'the vetoing page');
  await evalIn(vetoPage, ARM_UNLOAD_VETO, 'arm the unload veto').catch(() => {});
  const armed = await evalIn(vetoPage, 'typeof window.onbeforeunload', 'read the unload veto back');
  expect(armed === 'function', `the unload veto was not armed (typeof was '${armed}')`);

  currentStep = 'close the window whose page refuses';
  const gammaTabsBeforeVeto = authority.snapshot().find((entry) => entry.ownerKey === gammaKey)?.tabIds || [];
  const vetoReport = await bounded(authority.attemptClose(gammaKey, 'user'), 20000, 'close of the vetoing window');
  await sleep(250);
  const gammaAfterVeto = authority.snapshot().find((entry) => entry.ownerKey === gammaKey);
  observations.unloadVeto = {
    vetoTab,
    report: vetoReport,
    gammaTabs: gammaAfterVeto?.tabIds,
    reservations: authority.reservations(),
  };

  await check('a page that vetoes its unload retains the shell, with an honest partial report', () => {
    expect(gammaAfterVeto, 'the shell vanished even though a page vetoed its close');
    expect(vetoReport.disposition === 'retained', `the close reported '${vetoReport.disposition}'`);
    expect(vetoReport.haltedBy === 'unload-veto', `the close halted by '${String(vetoReport.haltedBy)}'`);
    expect(vetoReport.closed.length >= 1, `the close closed nothing before the veto: ${JSON.stringify(vetoReport.closed)}`);
    expect(vetoReport.closed.every((page) => gammaTabsBeforeVeto.includes(page.tabId)), `the close destroyed a page that was not this window's: ${JSON.stringify(vetoReport.closed)}`);
    expect(!vetoReport.closed.some((page) => page.tabId === vetoTab), 'the page that vetoed is reported as closed');
    expect(vetoReport.partial === true, 'the report does not mark the close as partial');
    expect(vetoReport.survivingTabIds.includes(vetoTab), `the vetoing page is not reported as surviving: ${JSON.stringify(vetoReport.survivingTabIds)}`);
    expect(gammaAfterVeto.tabIds.includes(vetoTab), `the vetoing page is gone from the shell: ${JSON.stringify(gammaAfterVeto.tabIds)}`);
    expect(vetoReport.lastBrowserShellGone === false, 'a retained shell reported the last browser shell as gone');
    expect(vetoReport.detail === undefined || !String(vetoReport.summary).includes('restored'), 'the report promised an undo of the closed page');
    const after = authority.reservations();
    expect(after.reservedCount === 0 && after.applicationReserved === false, `the vetoed attempt left a reservation behind: ${JSON.stringify(after)}`);
  });

  currentStep = 'disarm the veto so the next close can proceed';
  await evalIn(vetoPage, DISARM_UNLOAD_VETO, 'disarm the unload veto').catch(() => {});

  // ---- (c) a new tab arriving inside the close window ---------------------------------
  currentRow = 'new arrival during close';
  currentStep = 'close the window and let a tab arrive inside that window';
  const gammaTabsBeforeArrival = authority.snapshot().find((entry) => entry.ownerKey === gammaKey)?.tabIds || [];
  const arrivalAttempt = bounded(authority.attemptClose(gammaKey, 'user'), 20000, 'close with an arriving tab');
  const arrivalTab = await bounded(authority.hostForOwner(gammaKey)?.createTab('about:blank') ?? '', 20000, 'create the arriving tab');
  const arrivalReport = await arrivalAttempt;
  await sleep(250);
  const gammaAfterArrival = authority.snapshot().find((entry) => entry.ownerKey === gammaKey);
  observations.newArrival = { arrivalTab, report: arrivalReport, gammaTabs: gammaAfterArrival?.tabIds };

  await check('a tab arriving during the close survives and the shell is retained', () => {
    expect(typeof arrivalTab === 'string' && arrivalTab.length > 0, 'the arrival tab was not created');
    expect(gammaAfterArrival, 'the shell was destroyed under an arrival it did not account for');
    expect(arrivalReport.disposition === 'retained', `the close reported '${arrivalReport.disposition}'`);
    expect(arrivalReport.haltedBy === 'new-arrival', `the close halted by '${String(arrivalReport.haltedBy)}'`);
    expect(!arrivalReport.closed.some((page) => page.tabId === arrivalTab), `the close destroyed the arriving page: ${JSON.stringify(arrivalReport.closed)}`);
    expect(gammaAfterArrival.tabIds.includes(arrivalTab), `the new tab ${arrivalTab} is gone: ${JSON.stringify(gammaAfterArrival.tabIds)}`);
    // The attempt closes pages one by one and only then notices the arrival, so a page it
    // closed before the arrival is an earlier close that stands — the app says as much on its
    // own close line. What must hold is that everything it closed belonged to this shell
    // before the attempt, and that it stopped at the arrival rather than carrying on.
    expect(
      arrivalReport.closed.every((page) => gammaTabsBeforeArrival.includes(page.tabId)),
      `the close destroyed a page that was not this shell's before the attempt: ${JSON.stringify(arrivalReport.closed)} (before: ${JSON.stringify(gammaTabsBeforeArrival)})`
    );
  });

  // ---- explicit force: cancel must do nothing, confirmation destroys only this shell ----
  currentRow = 'explicit force-close';
  const forceEntry = await bounded(authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'user'), 30000, 'reopen the hub for the force row');
  const forceKey = forceEntry.ownerKey;
  const forceToolbar = surfaceOf(authority.shellFor(forceKey), 'toolbar');
  await waitForApi(forceToolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.forceCloseWindow === 'function'");
  const forceVetoTab = await createTabViaToolbar(forceToolbar, 'about:blank', 'toolbar createTab for the force veto');
  const forceVetoPage = await pageFor(authority, forceVetoTab, 'the force veto page');
  await evalIn(forceVetoPage, ARM_UNLOAD_VETO, 'arm the force veto').catch(() => {});
  const normalForceRefusal = await bounded(authority.attemptClose(forceKey, 'user'), 20000, 'normal close before force');
  await sleep(250);
  const siblingBeforeForce = authority.snapshot().find((entry) => entry.ownerKey === betaKey);
  const forceWindowId = authority.windowFor(forceKey)?.id ?? -1;

  let confirmation = false;
  const confirmationSeen = [];
  authority.setForceCloseConfirmationForProbe(async (shell) => {
    confirmationSeen.push(shell);
    return confirmation;
  });
  const cancelled = await authority.forceCloseFromChrome(forceToolbar);

  await check('a cancelled explicit force confirmation performs no destruction', () => {
    expect(normalForceRefusal.disposition === 'retained' && normalForceRefusal.haltedBy === 'unload-veto', `the normal veto close unexpectedly passed: ${JSON.stringify(normalForceRefusal)}`);
    expect(cancelled && cancelled.status === 'CANCELLED', `a cancelled confirmation returned ${JSON.stringify(cancelled)}`);
    expect(confirmationSeen.length === 1 && confirmationSeen[0].ownerKey === forceKey, `the confirmation targeted ${JSON.stringify(confirmationSeen)}`);
    expect(authority.windowFor(forceKey)?.isDestroyed() === false, 'cancel closed the window anyway');
    expect(authority.hostForOwner(forceKey) !== null, 'cancel disposed the shell host');
  });

  confirmation = true;
  const forced = await authority.forceCloseFromChrome(forceToolbar);
  authority.setForceCloseConfirmationForProbe(null);
  await bounded(waitFor(() => authority.browserShellCount() === 1, 'the forced shell to leave the directory'), 20000, 'the forced shell to leave the directory');
  const siblingAfterForce = authority.snapshot().find((entry) => entry.ownerKey === betaKey);
  const forcedWindowGone = !windowCensus().some((window) => window.id === forceWindowId && !window.destroyed);
  observations.explicitForce = {
    ownerKey: forceKey,
    cancelled,
    forced,
    confirmations: confirmationSeen,
    siblingBefore: siblingBeforeForce && { ownerKey: siblingBeforeForce.ownerKey, tabIds: siblingBeforeForce.tabIds },
    siblingAfter: siblingAfterForce && { ownerKey: siblingAfterForce.ownerKey, tabIds: siblingAfterForce.tabIds },
    forcedWindowGone,
    count: authority.browserShellCount(),
    reservations: authority.reservations(),
  };

  await check('a confirmed explicit force closes its own busy+vetoing window while the sibling remains untouched', () => {
    expect(forced && forced.status === 'CLOSED', `the confirmed force returned ${JSON.stringify(forced)}`);
    expect(confirmationSeen.length === 2 && confirmationSeen[1].ownerKey === forceKey, 'the second confirmation did not bind the sender shell');
    expect(forcedWindowGone, `the force-closed window is still in the census: ${JSON.stringify(windowCensus())}`);
    expect(authority.hostForOwner(forceKey) === null, 'the forced shell kept a host');
    expect(siblingAfterForce, `the sibling shell ${betaKey} was destroyed by another window's force`);
    expect(JSON.stringify(siblingAfterForce.tabIds) === JSON.stringify(siblingBeforeForce.tabIds), `the sibling's tabs changed: ${JSON.stringify(siblingAfterForce.tabIds)}`);
    expect(app.isReady() === true, 'the process is no longer ready after a window force');
    const after = authority.reservations();
    expect(after.reservedCount === 0 && after.applicationReserved === false, `the force left a reservation behind: ${JSON.stringify(after)}`);
  });

  // ---- (f) a Quit while a run is queued ----------------------------------------------
  currentRow = 'quit with a queued run';
  const beforeQueuedQuit = authority.lastQuitReport()?.attemptId ?? 0;
  authority.requestQuit('probe: queued run');
  authority.requestQuit('probe: queued run again');
  const queuedQuitReport = await waitForQuitReport(beforeQueuedQuit, 'the refused quit report');
  await sleep(200);
  observations.queuedQuit = {
    report: queuedQuitReport,
    count: authority.browserShellCount(),
    reservations: authority.reservations(),
    phase: authority.applicationPhase(),
    lastCloseReportForGamma: authority.lastCloseReport(gammaKey),
  };

  await check('a Quit while a run is queued is refused, coalesced, and tears nothing down', () => {
    expect(queuedQuitReport.shutdown === 'not-committed', `the quit committed anyway: ${JSON.stringify(queuedQuitReport.shutdown)}`);
    expect(queuedQuitReport.phase === 'open', `the application phase after the refusal was '${queuedQuitReport.phase}'`);
    // `refuse()` reopens application admission BEFORE the report is built (coordinator
    // contract), so a refused quit reports `admissionReserved === false`; the leak check is
    // the live reservation table read below.
    expect(queuedQuitReport.admissionReserved === false, 'the refused report claims admission is still held, so the caller sees a lie');
    expect(queuedQuitReport.closedShells.length === 0, `the refused quit closed ${JSON.stringify(queuedQuitReport.closedShells)}`);
    expect(queuedQuitReport.refusals.some((refusal) => refusal.code === 'busy'), `no busy refusal was reported: ${JSON.stringify(queuedQuitReport.refusals)}`);
    expect(queuedQuitReport.refusals.some((refusal) => String(refusal.detail).includes(queuedRun.id)), `the refusal does not name the queued run ${queuedRun.id}: ${JSON.stringify(queuedQuitReport.refusals)}`);
    expect(queuedQuitReport.refusals.every((refusal) => Array.isArray(refusal.controls)), 'a refusal offered no stop/release control');
    expect(queuedQuitReport.coalesced === true && queuedQuitReport.coalescedRequests >= 1, `the repeated Quit did not coalesce (coalesced=${String(queuedQuitReport.coalesced)}, requests=${queuedQuitReport.coalescedRequests})`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()} after a refused quit`);
    expect(app.isReady() === true, 'the app is no longer ready after a refused quit');
    const after = authority.reservations();
    expect(after.reservedCount === 0 && after.applicationReserved === false, `the refused quit left admission reserved: ${JSON.stringify(after)}`);
    expect(authority.hostForOwner(betaKey) !== null, 'a service teardown ran even though the quit was refused');
    expect(controlPlane.runs.listRuns(alpha.projectId).some((run) => run.id === queuedRun.id && run.state === 'queued'), 'the queued run was settled by a refused quit');
  });

  await check('shared services are still usable after the refusal', async () => {
    const tab = await createTabViaToolbar(toolbarG);
    expect(typeof tab === 'string' && tab.length > 0, `creating a tab after the refusal returned ${JSON.stringify(tab)}`);
    const title = await evalOnPage(authority, tab, '1 + 1', 'evaluate a page after the refusal');
    expect(title === 2, `the new page could not evaluate script (returned ${JSON.stringify(title)})`);
  });

  // ---- the same gate reopens once the shared work finishes ---------------------------
  const finishingBackend = {
    id: 'probe-finisher',
    startRun: async function* (input) {
      yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' };
    },
    cancel: async () => {},
  };
  await bounded(controlPlane.runs.start(queuedRun.id, 'probe: release the gate', finishingBackend, { cwd: alpha.path }), 30000, 'release the queued run');
  const runStates = controlPlane.runs.listRuns(alpha.projectId).map((run) => ({ id: run.id, state: run.state }));
  observations.runCleanup = { runStates, phase: authority.applicationPhase(), reservations: authority.reservations() };

  await check('the terminal run state reopens the gate instead of locking it out', () => {
    expect(runStates.some((run) => run.id === queuedRun.id && run.state === 'completed'), `the run did not reach a terminal state: ${JSON.stringify(runStates)}`);
    expect(authority.applicationPhase() === 'open', `applicationPhase() was '${authority.applicationPhase()}'`);
    expect(authority.reservations().applicationReserved === false, 'application admission was left reserved');
  });

  // ---- (e) a binding arriving while its page is reserved -----------------------------
  currentRow = 'binding during unload';
  const gammaPageForBinding = authority.snapshot().find((entry) => entry.ownerKey === gammaKey)?.activeTabId || vetoTab;
  const bindingAttempt = bounded(authority.attemptClose(gammaKey, 'user'), 20000, 'close with a binding during unload');
  const lease = issueRuntimeLease(alpha.projectId, alpha.workspaceId, 60_000, controlPlane.getLease().hostEpoch);
  currentStep = 'mint a binding for a page that is being closed';
  const mintOutcome = await bounded(
    controlPlane.runs.attachments
      .issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), alpha.projectId, alpha.workspaceId, {
        backendId: 'probe',
        lease,
        leaseToken: lease.token,
        tabId: gammaPageForBinding,
      })
      .then(
        (issued) => ({ admitted: true, attachmentId: issued && issued.record ? issued.record.attachmentId : undefined, code: undefined }),
        (err) => ({ admitted: false, attachmentId: undefined, code: err && err.code ? err.code : String(err) })
      ),
    20000,
    'mint a binding for a page that is being closed'
  );
  const bindingReport = await bindingAttempt;
  if (mintOutcome.admitted && mintOutcome.attachmentId) {
    // The probe's own binding must not leak into the rest of the run.
    try { await bounded(controlPlane.runs.attachments.revokeAttachment(mintOutcome.attachmentId), 15000, 'revoke the probe binding'); } catch {}
  }
  await bounded(waitFor(() => authority.browserShellCount() === 1, 'the hub to close'), 20000, 'the hub to leave the directory');
  observations.bindingDuringUnload = { gammaPageForBinding, mintOutcome, report: bindingReport, count: authority.browserShellCount() };

  await check('a binding attempted during unload is refused; a page cannot be bound and then destroyed', () => {
    expect(mintOutcome.admitted === false, `a binding was admitted for a reserved page (attachment ${String(mintOutcome.attachmentId)})`);
    expect(mintOutcome.code === 'TARGET_STALE', `the refusal code was '${String(mintOutcome.code)}'`);
    expect(bindingReport.disposition === 'closed', `the close reported '${bindingReport.disposition}' (haltedBy ${String(bindingReport.haltedBy)})`);
    expect(bindingReport.closed.some((page) => page.tabId === gammaPageForBinding), `the reserved page ${gammaPageForBinding} was not the one closed`);
    expect(authority.hostForTab(gammaPageForBinding) === null, 'the closed page still resolves to a host');
  });

  // ---- (g) a late veto while the Terminal Manager is open ----------------------------
  // The shared Terminal Manager is a first-class shell with no page area — a veto can
  // only live on a real page, so this arms one on a fresh project window opened after the
  // manager. By the time it refuses, older shells are already gone: the real late-veto
  // shape survives intact, and the surviving manager makes the discovery row below honest.
  currentRow = 'late shell veto';
  currentStep = 'open the shared Terminal Manager, then a project window with a vetoing page';
  const managerEntry = await bounded(
    authority.ensureProjectWindow({ kind: 'unassigned' }, 'user'),
    30000,
    'the shared Terminal Manager'
  );
  const managerKey = managerEntry.ownerKey;
  const managerHost = authority.hostForOwner(managerKey);
  expect(managerHost, 'the Terminal Manager has no host');
  const managerWindow = authority.windowFor(managerKey);
  expect(managerWindow && !managerWindow.isDestroyed(), 'the Terminal Manager native window is missing');
  const managerWindowId = managerWindow.id;
  const vetoEntry = await bounded(
    authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'user'),
    30000,
    'the veto shell window'
  );
  const vetoKey = vetoEntry.ownerKey;
  const vetoHost = authority.hostForOwner(vetoKey);
  const lateVetoTab = await bounded(vetoHost.createTab('about:blank'), 20000, 'create the veto page');
  const lateVetoPage = await pageFor(authority, lateVetoTab, 'the veto page');
  const vetoWindow = authority.windowFor(vetoKey);
  const vetoWindowId = vetoWindow ? vetoWindow.id : -1;
  await sleep(300);
  currentStep = 'arm the unload veto on the page';
  await evalIn(lateVetoPage, ARM_UNLOAD_VETO, 'arm the unload veto').catch(() => {});
  const lateVetoArmed = await evalIn(lateVetoPage, 'typeof window.onbeforeunload', 'read the veto back');
  const journalBeforeAuxEvents = journalEvents();
  const journalBeforeAux = journalBeforeAuxEvents ? journalBeforeAuxEvents.length : 0;
  // The platform's own account of the vetoing shell's close, recorded next to the app's:
  // an attempt that produces no report has to be judged by what the windows actually said.
  const auxT0 = Date.now();
  const managerEvents = [];
  const noteManager = (what) => managerEvents.push(`${what}@${Date.now() - auxT0}ms`);
  if (vetoWindow) {
    vetoWindow.on('close', (event) => queueMicrotask(() => noteManager(`veto-window-close(defaultPrevented=${String(event.defaultPrevented)})`)));
    vetoWindow.on('closed', () => noteManager('veto-window-closed'));
  }
  lateVetoPage.once('destroyed', () => noteManager('veto-page-destroyed'));
  lateVetoPage.on('will-prevent-unload', () => noteManager('will-prevent-unload'));
  observations.managerVeto = { managerKey, managerWindowId, vetoKey, vetoWindowId, armed: lateVetoArmed, census: windowCensus() };

  const beforeAuxQuit = authority.lastQuitReport()?.attemptId ?? 0;
  authority.requestQuit('probe: manager veto');
  currentStep = 'wait for the manager-veto quit report';
  // A quit that produces no report at all is the interesting failure, and it must not end the
  // run: the row reports it, and the rows after it still execute. What the process looked like
  // while the attempt was still in flight is recorded instead of only that it timed out.
  const auxQuitReport = await waitForQuitReport(beforeAuxQuit, 'the manager-veto quit report').catch((err) => {
    observations.auxQuitDiagnosis = {
      error: messageOf(err),
      phase: authority.applicationPhase(),
      reservations: authority.reservations(),
      count: authority.browserShellCount(),
      census: windowCensus(),
      managerEvents: [...managerEvents],
      pages: pageStateDump(authority),
      journalReadError: lastJournalReadError,
      journal: (journalEvents() || []).slice(journalBeforeAux).map((entry) => entry.event),
    };
    return null;
  });
  await sleep(400);
  const auxEvents = journalEvents();
  const auxJournal = auxEvents ? auxEvents.slice(journalBeforeAux) : null;
  const auxCensus = windowCensus();
  observations.auxQuit = {
    report: auxQuitReport,
    count: authority.browserShellCount(),
    reservations: authority.reservations(),
    phase: authority.applicationPhase(),
    census: auxCensus,
    managerEvents: [...managerEvents],
    journalReadError: lastJournalReadError,
    journal: auxJournal ? auxJournal.map((entry) => entry.event) : null,
  };

  await check('a late veto in a project shell while the Manager is open keeps services alive, releases admission and never commits', () => {
    expect(auxQuitReport, `no quit report arrived for the vetoed close: ${JSON.stringify(observations.auxQuitDiagnosis || null)}`);
    expect(auxQuitReport.shutdown === 'not-committed', `the quit committed anyway: ${JSON.stringify(auxQuitReport.shutdown)}`);
    expect(auxQuitReport.phase === 'open', `the application phase after the veto was '${auxQuitReport.phase}'`);
    // `refuse()` reopens admission before the report is built, so a vetoed quit honestly
    // reports `admissionReserved === false`; the live table below proves nothing leaked.
    expect(auxQuitReport.admissionReserved === false, 'the vetoed report claims admission is still held');
    expect(lateVetoArmed === 'function', `the page veto was not armed (typeof was '${String(lateVetoArmed)}')`);
    // The vetoing shell is named among the survivors. The manager — a page-less shell —
    // legitimately closed inside the same attempt, so the invariant is on the vetoing
    // shell only: a commit, silence, or a reason disagreeing with the outcome must never
    // happen.
    expect(auxQuitReport.haltedBy === 'unload-veto', `the page veto halted by '${String(auxQuitReport.haltedBy)}'`);
    expect(auxQuitReport.survivingShells.includes(vetoKey), `the vetoing shell is not among the survivors: ${JSON.stringify(auxQuitReport.survivingShells)}`);
    expect(managerEvents.some((event) => event.includes('will-prevent-unload')) || (vetoWindow && !vetoWindow.isDestroyed()), `the page never produced a veto and the window is gone: ${JSON.stringify(managerEvents)}`);
    expect(auxCensus.some((window) => window.id === vetoWindowId && !window.destroyed), `the vetoing shell is gone: ${JSON.stringify(auxCensus)}`);
    expect(auxQuitReport.closedShells.includes(managerKey), `the manager the gate closed is not among closedShells: ${JSON.stringify(auxQuitReport.closedShells)}`);
    expect(app.isReady() === true, 'the app is no longer ready after a vetoed quit');
    expect(!auxJournal.some((entry) => entry.event === 'shutdown.begin'), `a service teardown ran despite the veto: ${JSON.stringify(auxJournal.map((entry) => entry.event))}`);
    const afterVeto = authority.reservations();
    expect(afterVeto.reservedCount === 0 && afterVeto.applicationReserved === false, `the vetoed quit left admission reserved: ${JSON.stringify(afterVeto)}`);
  });

  const gammaReopened = await bounded(
    authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'user'),
    30000,
    'reopen the project window after the veto',
  ).catch((err) => {
    // A vetoed quit that left the application unusable is a finding, not a reason to stop: the
    // row below reports it and the remaining rows still run.
    observations.reopenAfterVeto = { error: messageOf(err) };
    return null;
  });
  await check('the application is still usable after the late veto: a window opens and runs a page', async () => {
    expect(gammaReopened && gammaReopened.ownerKey, `reopening a project window returned ${JSON.stringify(gammaReopened)}`);
    const tab = await bounded(authority.hostForOwner(gammaReopened.ownerKey)?.createTab('about:blank'), 20000, 'create a tab after the veto');
    expect(typeof tab === 'string' && tab.length > 0, `creating a tab after the veto returned ${JSON.stringify(tab)}`);
    const evaluated = await evalOnPage(authority, tab, '2 + 2', 'evaluate a page after the veto');
    expect(evaluated === 4, `the new page could not evaluate script (returned ${JSON.stringify(evaluated)})`);
    expect(controlPlane.runs.listRuns(alpha.projectId).length >= 1, 'the control plane stopped answering after the veto');
  });

  // The manager is a page-less shell, so the vetoed quit closed it legitimately while the
  // vetoing hub was retained. The directory read has to agree with what the gate reported:
  // closed shells are gone, survivors still answer.
  const managerEntryAfterVeto = authority.snapshot().find((entry) => entry.ownerKey === managerKey);
  const vetoEntryAfterVeto = authority.snapshot().find((entry) => entry.ownerKey === vetoKey);
  observations.managerDiscovery = {
    managerInDirectory: managerEntryAfterVeto ? { ownerKey: managerEntryAfterVeto.ownerKey, tabIds: [...managerEntryAfterVeto.tabIds] } : null,
    vetoInDirectory: vetoEntryAfterVeto ? { ownerKey: vetoEntryAfterVeto.ownerKey, tabIds: [...vetoEntryAfterVeto.tabIds] } : null,
    censusWindowIds: windowCensus().map((window) => window.id),
    managerGone: !managerWindow || managerWindow.isDestroyed(),
  };
  await check('the vetoed quit closed the page-less manager and retained the vetoing shell', () => {
    expect(managerEntryAfterVeto === undefined, `the manager the gate reported closed still sits in the directory: ${JSON.stringify(managerEntryAfterVeto)}`);
    expect(vetoEntryAfterVeto, `the vetoing shell vanished from the directory: ${JSON.stringify(observations.managerDiscovery)}`);
    expect(vetoEntryAfterVeto.tabIds.includes(lateVetoTab), `the vetoing page is not among the retained shell's tabs: ${JSON.stringify(vetoEntryAfterVeto.tabIds)}`);
    expect(authority.hostForOwner(vetoKey), 'the vetoing shell kept no host after the quit it refused');
  });

  // The veto did its job; disarm it now or every later shell close vetoes on this page
  // before it reaches the pages those rows are measuring.
  await evalIn(lateVetoPage, DISARM_UNLOAD_VETO, 'disarm the late unload veto').catch(() => {});
  observations.disarmManager = { before: observations.managerDiscovery.censusWindowIds, after: windowCensus() };

  // ---- (i) the unload settle question, answered per case by measurement ----------------
  // Which of `destroyed` / `will-prevent-unload` / neither a close produces, and after how
  // long, is what decides the honest outcome vocabulary for a close attempt. It is measured
  // here rather than argued, and each case records the channel the event arrived on.
  currentRow = 'unload settle';
  currentStep = 'open the pages the settle cases close';
  const settleKey = gammaReopened.ownerKey;
  const settleToolbar = surfaceOf(authority.shellFor(settleKey), 'toolbar');
  await waitForApi(settleToolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
  observations.unloadSettle = {};

  // (a) a page with no unload handler.
  currentStep = 'settle (a): a page with no unload handler';
  const settlePlainTab = await createTabViaToolbar(settleToolbar, 'about:blank', 'toolbar createTab for settle (a)');
  const settlePlainPage = await pageFor(authority, settlePlainTab, 'the handler-free page');
  // A page with no handler does not carry `undefined`: a fresh document answers `null`, and
  // `typeof null` is 'object'. The honest read is that there is no callable handler.
  const settlePlainHandler = await evalIn(settlePlainPage, 'window.onbeforeunload == null ? "none" : typeof window.onbeforeunload', 'read the handler-free page back');
  const settleA = await observeNativeClose(settlePlainPage, 'a: no unload handler');
  observations.unloadSettle.a = { tabId: settlePlainTab, handlerType: settlePlainHandler, ...settleA };

  await check('unload settle (a): a page with no unload handler is destroyed by the close and reports no veto', () => {
    expect(settlePlainHandler === 'none', `the page was expected to carry no unload handler (handler read was '${settlePlainHandler}')`);
    expect(settleA.events.includes('destroyed'), `no destroyed event arrived for a handler-free page: ${JSON.stringify(settleA.events)} ${JSON.stringify(settleA.timings)}`);
    expect(!settleA.events.includes('will-prevent-unload'), `a handler-free page reported a veto: ${JSON.stringify(settleA.events)}`);
    expect(settleA.destroyed === true, `the handler-free page is still alive after its close: ${JSON.stringify(settleA)}`);
  });

  // (b) a page that vetoes its unload.
  currentStep = 'settle (b): a page that vetoes its unload';
  const settleVetoTab = await createTabViaToolbar(settleToolbar, 'about:blank', 'toolbar createTab for settle (b)');
  const settleVetoPage = await pageFor(authority, settleVetoTab, 'the vetoing page for settle (b)');
  await evalIn(settleVetoPage, ARM_UNLOAD_VETO, 'arm the settle (b) veto').catch(() => {});
  const settleVetoHandler = await evalIn(settleVetoPage, 'typeof window.onbeforeunload', 'read the settle (b) veto back');
  const settleB = await observeNativeClose(settleVetoPage, 'b: vetoing page');
  // The veto has to hold, so the page is disarmed and closed for real: that also proves the
  // veto was the only reason the first call did not destroy it.
  await evalIn(settleVetoPage, DISARM_UNLOAD_VETO, 'disarm the settle (b) veto').catch(() => {});
  const settleBAfterDisarm = await observeNativeClose(settleVetoPage, 'b: vetoing page, disarmed');
  observations.unloadSettle.b = { tabId: settleVetoTab, handlerType: settleVetoHandler, armed: settleB, disarmed: settleBAfterDisarm };

  await check('unload settle (b): a vetoing page reports will-prevent-unload, survives the close, and dies once disarmed', () => {
    expect(settleVetoHandler === 'function', `the veto was not armed (typeof was '${settleVetoHandler}')`);
    expect(settleB.events.includes('will-prevent-unload'), `no veto event arrived for a vetoing page: ${JSON.stringify(settleB.events)} ${JSON.stringify(settleB.timings)}`);
    expect(!settleB.events.includes('destroyed'), `the vetoing page was destroyed by the close it refused: ${JSON.stringify(settleB.events)}`);
    expect(settleB.destroyed === false, `the vetoing page reports destroyed after a veto: ${JSON.stringify(settleB)}`);
    expect(settleBAfterDisarm.destroyed === true, `the disarmed page was not destroyed by the same close call: ${JSON.stringify(settleBAfterDisarm)}`);
    expect(settleBAfterDisarm.events.includes('destroyed'), `the disarmed page died without reporting it: ${JSON.stringify(settleBAfterDisarm.events)}`);
  });

  // (c) a content that was already destroyed before the attempt could close it.
  currentStep = 'settle (c): a content already reported destroyed';
  const settleDeadTab = await createTabViaToolbar(settleToolbar, 'about:blank', 'toolbar createTab for settle (c)');
  const settleDeadPage = await pageFor(authority, settleDeadTab, 'the page that is destroyed before its close');
  let settleDeadKilled = false;
  let settleDeadKillError = null;
  try {
    settleDeadPage.destroy();
    settleDeadKilled = true;
  } catch (err) {
    settleDeadKillError = messageOf(err);
  }
  await sleep(120);
  const settleC = await observeNativeClose(settleDeadPage, 'c: already-destroyed content');
  const settleDeadRecord = authority.hostForTab(settleDeadTab) ? 'still owned' : 'no longer in the directory';
  observations.unloadSettle.c = { tabId: settleDeadTab, killed: settleDeadKilled, killError: settleDeadKillError, recordAfterDeath: settleDeadRecord, ...settleC };

  await check('unload settle (c): an already-destroyed content reports no event, so its outcome is read from state', () => {
    expect(settleDeadKilled, `the probe could not destroy the page first: ${String(settleDeadKillError)}`);
    expect(settleC.events.length === 0, `an event arrived for a content that was already gone: ${JSON.stringify(settleC.events)}`);
    // The call has nothing to close and says so; that answer is the outcome for this case, and it
    // is recorded beside the (empty) event list rather than counted as an event.
    expect(typeof settleC.callError === 'string' && settleC.callError.length > 0, `the close call on an already-gone content said nothing: ${JSON.stringify(settleC)}`);
    expect(settleC.destroyed === true, `the already-destroyed content does not report itself destroyed: ${String(settleC.destroyed)}`);
    // The vocabulary consequence: a page that was already terminal is not a member any more,
    // so no attempt can report it as a page it failed to close — its outcome is the state read.
    expect(settleDeadRecord === 'no longer in the directory', `a destroyed page is still owned by a host: ${settleDeadRecord}`);
  });

  // (d) a real user-driven close, with user activation in the page that vetoes.
  currentStep = 'settle (d): a user-driven close of the window, with user activation';
  const settleUserTab = await createTabViaToolbar(settleToolbar, 'about:blank', 'toolbar createTab for settle (d)');
  const settleUserPage = await pageFor(authority, settleUserTab, 'the page that vetoes under a user gesture');
  // The gesture is what a user's own close carries and a programmatic call does not; the page
  // reports its own activation state back, so the evidence says what the renderer saw.
  await evalIn(settleUserPage, `(function () { window.onbeforeunload = () => 'probe: settle (d) refuses to close'; return true; })()`, 'arm the settle (d) veto under a user gesture').catch(() => {});
  const settleUserActivation = await evalIn(settleUserPage, 'String(typeof navigator.userActivation === "object" ? navigator.userActivation.isActive + "/" + navigator.userActivation.hasBeenActive : "unavailable")', 'read the page activation back');
  const settleUserHandler = await evalIn(settleUserPage, 'typeof window.onbeforeunload', 'read the settle (d) veto back');
  const settleWindow = authority.windowFor(settleKey);
  const settleWindowId = settleWindow?.id ?? -1;
  const settleWindowContents = settleWindow?.webContents ?? null;
  const settleWindowEvents = [];
  const settleStartedAt = Date.now();
  const noteSettleWindow = (what) => settleWindowEvents.push(`${what}@${Date.now() - settleStartedAt}ms`);
  const settlePageOnVeto = () => noteSettleWindow('page:will-prevent-unload');
  const settlePageOnDestroyed = () => noteSettleWindow('page:destroyed');
  const settleWindowOnVeto = () => noteSettleWindow('windowContents:will-prevent-unload');
  settleUserPage.on('will-prevent-unload', settlePageOnVeto);
  settleUserPage.on('destroyed', settlePageOnDestroyed);
  if (settleWindowContents) settleWindowContents.on('will-prevent-unload', settleWindowOnVeto);
  const settleCloseBefore = authority.lastCloseReport(settleKey)?.attemptId ?? 0;
  const settleUserCloseRequested = authority.requestClose(settleKey);
  const settleUserReport = await waitForCloseReport(settleKey, settleCloseBefore, 'the close report for the user-driven close').catch((err) => {
    // An attempt the coordinator never finishes is the finding, and it must not end the run:
    // the row reports it, and the rows after it still execute.
    observations.unloadSettle.dDiagnosis = { error: messageOf(err), phase: authority.applicationPhase(), reservations: authority.reservations(), census: windowCensus(), events: [...settleWindowEvents] };
    return null;
  });
  await sleep(300);
  settleUserPage.removeListener('will-prevent-unload', settlePageOnVeto);
  settleUserPage.removeListener('destroyed', settlePageOnDestroyed);
  if (settleWindowContents) settleWindowContents.removeListener('will-prevent-unload', settleWindowOnVeto);
  const settleUserCensus = windowCensus();
  observations.unloadSettle.d = {
    tabId: settleUserTab,
    handlerType: settleUserHandler,
    activationReadback: settleUserActivation,
    closeRequested: settleUserCloseRequested,
    report: settleUserReport,
    events: [...settleWindowEvents],
    census: settleUserCensus,
  };

  await check('unload settle (d): a user-driven close with user activation reaches the app as the page veto', () => {
    expect(settleUserReport, `no close report arrived for the user-driven close: ${JSON.stringify(observations.unloadSettle.dDiagnosis || null)}`);
    expect(settleUserHandler === 'function', `the user-activated veto was not armed (typeof was '${settleUserHandler}')`);
    expect(settleUserCloseRequested, 'the user-driven close request never reached the window');
    expect(settleWindowEvents.some((event) => event.startsWith('page:will-prevent-unload')), `the user-driven close did not reach the app as a page veto: ${JSON.stringify(settleWindowEvents)}`);
    expect(settleUserReport.disposition === 'retained', `the user-driven close reported '${settleUserReport.disposition}'`);
    expect(settleUserReport.haltedBy === 'unload-veto', `the user-driven close halted by '${String(settleUserReport.haltedBy)}'`);
    expect(settleUserReport.survivingTabIds.includes(settleUserTab), `the vetoing page is not reported as surviving: ${JSON.stringify(settleUserReport.survivingTabIds)}`);
    expect(
      settleUserCensus.some((window) => window.id === settleWindowId && !window.destroyed),
      `the window the user asked to close is gone after its page vetoed: ${JSON.stringify(settleUserCensus)}`
    );
  });

  currentStep = 'disarm the settle (d) veto so the final close can proceed';
  await evalIn(settleUserPage, DISARM_UNLOAD_VETO, 'disarm the settle (d) veto').catch(() => {});

  // ---- (h) the last browser shell drives the same gate --------------------------------
  // The manager already closed inside the vetoed quit, so the reopened hub is the only
  // browser shell left: its own native close is what drives the committed application
  // quit — same gate, last shell standing.
  currentRow = 'final committed exit';
  const remainingShells = authority.snapshot();
  expect(remainingShells.length === 1, `more than one shell is still open before the final close: ${JSON.stringify(remainingShells.map((entry) => entry.ownerKey))}`);
  const finalKey = remainingShells[0].ownerKey;
  const finalTabsBefore = authority.snapshot().find((entry) => entry.ownerKey === finalKey)?.tabIds || [];
  const beforeFinalQuit = authority.lastQuitReport()?.attemptId ?? 0;
  const journalBeforeExitEvents = journalEvents();
  const journalBeforeExit = journalBeforeExitEvents ? journalBeforeExitEvents.length : 0;
  const censusBeforeFinalQuit = windowCensus();
  const closeRequested = authority.requestClose(finalKey);
  const quitSettled = await Promise.race([willQuitPromise, sleep(30000).then(() => 'timeout')]);
  const finalQuitReport = await waitForQuitReport(beforeFinalQuit, 'the committed quit report', 20000).catch(() => null);
  await sleep(300);
  const journalFinalEvents = journalEvents();
  const journal = journalFinalEvents ? journalFinalEvents.slice(journalBeforeExit) : null;
  const finalCensus = windowCensus();
  const managerAliveAtFinalQuit = censusBeforeFinalQuit.some((window) => window.id === managerWindowId && !window.destroyed);
  observations.finalQuit = {
    closeRequested,
    quitSettled,
    count: authority.browserShellCount(),
    finalTabsBefore,
    report: finalQuitReport,
    closeReport: authority.lastCloseReport(finalKey),
    censusBefore: censusBeforeFinalQuit,
    censusAfter: finalCensus,
    managerAliveAtFinalQuit,
    reservations: authority.reservations(),
    journalReadError: lastJournalReadError,
    journal: journal ? journal.map((entry) => entry.event) : null,
  };

  await check('the last browser shell closing runs the same application gate and exits orderly', () => {
    expect(closeRequested, 'the close request never reached the last window');
    expect(quitSettled === 'will-quit', `the process never reached will-quit (settled: ${String(quitSettled)})`);
    const closeReport = authority.lastCloseReport(finalKey);
    expect(closeReport && closeReport.disposition === 'closed', `the native close did not go through the coordinator: ${JSON.stringify(closeReport && closeReport.disposition)}`);
    expect(finalQuitReport, 'no quit report was produced by the last shell closing');
    expect(finalQuitReport.shutdown === 'committed', `the quit reported '${String(finalQuitReport.shutdown)}' (haltedBy ${String(finalQuitReport.haltedBy)}, refusals ${JSON.stringify(finalQuitReport.refusals)})`);
    expect(finalQuitReport.phase === 'closed', `the application phase was '${finalQuitReport.phase}'`);
    expect(finalQuitReport.survivingShells.length === 0, `a shell survived a committed quit: ${JSON.stringify(finalQuitReport.survivingShells)}`);
    expect(finalQuitReport.auxiliaries.every((surface) => surface.outcome === 'closed'), `an auxiliary was not closed by the attempt: ${JSON.stringify(finalQuitReport.auxiliaries)}`);
    // The manager already closed inside the earlier vetoed quit, so the committed attempt
    // owes it nothing — the conditional still guards the contract: if a census ever showed
    // it alive at the committed attempt's start, the attempt must name it as closed.
    expect(
      !managerAliveAtFinalQuit ||
        finalQuitReport.closedShells.includes(managerKey),
      `the Terminal Manager was alive when the committed attempt started and was not closed by it: ${JSON.stringify({ census: censusBeforeFinalQuit, closedShells: finalQuitReport.closedShells })}`
    );
    expect(authority.browserShellCount() === 0, `browserShellCount() was ${authority.browserShellCount()} at will-quit`);
    const survivors = finalCensus.filter((window) => !window.destroyed);
    expect(survivors.length === 0, `a window outlived the committed quit: ${JSON.stringify(survivors)}`);
    const reservation = authority.reservations();
    expect(reservation.applicationReserved === false, 'application admission is still reserved after the commit');
  });

  await check('the ordered teardown ran once and nothing forced the exit', () => {
    // M9: Assert journal was read successfully before asserting negative event absence
    expect(journal !== null, `the lifecycle journal could not be read (${lastJournalReadError}), so teardown events cannot be proven`);
    const events = journal.map((entry) => entry.event);
    expect(events.includes('shutdown.begin'), `the shutdown never began: ${JSON.stringify(events)}`);
    expect(events.includes('shutdown.clean'), `the shutdown never reached its clean marker: ${JSON.stringify(events)}`);
    expect(events.filter((event) => event === 'shutdown.begin').length === 1, 'the ordered teardown ran more than once');
    expect(!events.includes('shutdown.forceExit'), 'the process force-exited instead of finishing the teardown');
    expect(!events.some((event) => String(event).startsWith('shutdown.step.failed')), `a teardown step failed: ${JSON.stringify(events)}`);
    const outcome = journal.find((entry) => entry.event === 'quit.outcome');
    expect(outcome && outcome.shutdown === 'committed', `the journal has no committed quit outcome: ${JSON.stringify(outcome)}`);
    expect(journal.filter((entry) => entry.event === 'will-quit').length >= 1, 'will-quit never ran');
    expect(journal.some((entry) => entry.event === 'window-close.closed'), `the final native close did not go through the coordinator: ${JSON.stringify(events)}`);
    expect(events.includes('quit.requested'), `the last shell closing never requested the application quit: ${JSON.stringify(events)}`);
  });

  // ---- the run judged as a whole ------------------------------------------------------
  currentRow = 'row accounting';
  currentStep = 'compare what ran against what this probe promises to run';
  await check(ROW_ACCOUNTING, () => {
    const executed = checks.map((entry) => entry.name).filter((name) => name !== ROW_ACCOUNTING);
    const missing = EXPECTED_ROWS.filter((name) => !executed.includes(name));
    expect(missing.length === 0, `the run never executed ${missing.length} row(s): ${JSON.stringify(missing)}`);
    expect(executed.length === EXPECTED_ROWS.length, `the run executed ${executed.length} row(s), expected ${EXPECTED_ROWS.length}: ${JSON.stringify(executed)}`);
    const failed = checks.filter((entry) => !entry.ok).map((entry) => entry.name);
    expect(failed.length === 0, `these rows failed: ${JSON.stringify(failed)}`);
  });
}

/**
 * Leave the process the way a user would when the probe failed before its own exit row:
 * ask each remaining window to close and let the shipping gate finish the quit. The probe
 * holds `will-quit` open, so this path also ends with `process.exit` from the reporter.
 */
async function cleanup() {
  try {
    if (willQuitSeen) return;
    for (const entry of mainProcess.projectWindowAuthority.snapshot()) {
      mainProcess.projectWindowAuthority.requestClose(entry.ownerKey);
    }
    const deadline = Date.now() + 8000;
    while (mainProcess.projectWindowAuthority.browserShellCount() > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

let exitCode = 1;
let reported = false;
function writeReport(extra) {
  if (reported) return;
  reported = true;
  const failed = checks.filter((entry) => !entry.ok);
  const result = {
    probe: 'quit-coordination',
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    observations,
    ...(extra ? { extra } : {}),
    at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(reportsDir, 'quit-coordination-probe.json'), JSON.stringify(result, null, 2), 'utf8');
  } catch (err) {
    origLog(`[probe] failed to write evidence: ${messageOf(err)}`);
  }
  console.log(`[probe] ${result.passed} passed, ${result.failed} failed — evidence: ${path.join(reportsDir, 'quit-coordination-probe.json')}`);
  return failed.length === 0 ? 0 : 1;
}

bounded(app.whenReady(), 60000, 'Electron to report itself ready')
  .then(run)
  .catch((err) => {
    check('probe completed without an unexpected throw', () => {
      throw err;
    });
  })
  .finally(async () => {
    clearInterval(heartbeat);
    observations.heartbeatTicks = heartbeatTicks;
    await cleanup();
    exitCode = writeReport();
    process.exit(exitCode);
  });
