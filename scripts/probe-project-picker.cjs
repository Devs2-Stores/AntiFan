/**
 * Project picker surface — real Electron probe.
 *
 * Which surface answers the user's "open a project without a target" request in each
 * sidebar state: the in-app manager modal pushed into the asking window's chrome, or
 * the native `dialog.showMessageBox` fallback. The probe is the acceptance evidence
 * unit tests cannot give (real windows, real chrome surfaces, real IPC).
 *
 * Driven assertions:
 *   a. Ctrl+Shift+O (the File menu accelerator's own click path) with the sidebar
 *      CLOSED must show the in-app modal — the sidebar opens itself to host it —
 *      with zero native message-box calls.
 *   b. The same request with the sidebar already open must reach the sidebar's
 *      picker listener directly.
 *   c. In `legacy` mode (ANTIFAN_PICKER_MODE=legacy, used against a pre-fix build)
 *      the same scenarios are recorded rather than judged: this is the root-cause
 *      evidence, not a gate.
 *
 * Evidence: plans/260928-1654-smooth-multi-project-terminal/reports/picker-probe.{json,log}
 * and picker-*.png captures of the shell surfaces in each state.
 *
 * Run: ANTIFAN_COMPILED_ROOT=.tmp-p10 node scripts/run-electron.cjs scripts/probe-project-picker.cjs
 */
const electron = require('electron');
const { app, BrowserWindow, Menu, dialog, desktopCapturer } = electron;
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));

// `legacy` records what a build does; `current` asserts the contract the fix ships.
const MODE = process.env.ANTIFAN_PICKER_MODE === 'legacy' ? 'legacy' : 'current';

const reportsDir = path.join(ROOT, 'plans', '260928-1654-smooth-multi-project-terminal', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'picker-probe.log');
fs.writeFileSync(logFile, '', 'utf8');
// Synchronous: the process exits straight after the summary, and a buffered stream would
// drop the evidence for the run that failed hardest.
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};

// Throwaway world: a temp data root (config, control plane, runtime) and a temp Chromium
// profile, both seeded before the main process is required. Nothing here can read or
// write the developer's real profile, real data root or real capsules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-picker-probe-'));
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

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
process.env.ANTIFAN_BRIDGE_PORT = '20988';

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

// The native dialog is the user's, scripted: every call is recorded and auto-resolved
// to dismissal so a run never hangs on a modal nobody is watching. `signal` keeps the
// cancel path itself shipping code rather than a stubbed answer.
const nativeDialogCalls = [];
const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
const originalShowMessageBoxSync = dialog.showMessageBoxSync.bind(dialog);
dialog.showMessageBox = (...args) => {
  const options = args[args.length - 1] && typeof args[args.length - 1] === 'object' ? args[args.length - 1] : {};
  const buttons = Array.isArray(options.buttons) ? options.buttons : [];
  const cancelId = typeof options.cancelId === 'number' ? options.cancelId : buttons.length - 1;
  nativeDialogCalls.push({ kind: 'showMessageBox', title: options.title || '', buttons: buttons.length });
  return Promise.resolve({ response: cancelId });
};
dialog.showMessageBoxSync = (...args) => {
  const options = args[args.length - 1] && typeof args[args.length - 1] === 'object' ? args[args.length - 1] : {};
  const buttons = Array.isArray(options.buttons) ? options.buttons : [];
  const cancelId = typeof options.cancelId === 'number' ? options.cancelId : buttons.length - 1;
  nativeDialogCalls.push({ kind: 'showMessageBoxSync', title: options.title || '', buttons: buttons.length });
  return cancelId;
};

// Boot the shipping main process inside this same Electron instance. Its boot guards run
// at import, so the process is imported here with the throwaway environment already
// seeded above it.
const mainProcess = require(compiledModule('index.js'));
const { dispatchChromeRoute } = require(compiledModule('browser/ipc-router.js'));

const checks = [];
const observations = { nativeDialogCalls, sends: [], scenarios: [] };
const messageOf = (err) => String(err && err.message ? err.message : err);

async function check(name, fn) {
  if (MODE === 'legacy') {
    // Root-cause evidence: observe, never fail — the pre-fix behaviour is the subject,
    // not a violation of it.
    try {
      const detail = await fn();
      checks.push({ name, ok: true, observed: typeof detail === 'string' ? detail : undefined });
      console.log(`  OBS   ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      checks.push({ name, ok: true, observed: `threw: ${messageOf(err)}` });
      console.log(`  OBS   ${name} — threw: ${messageOf(err)}`);
    }
    return;
  }
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

/** Evaluate one expression in a chrome surface until the preload API it needs answers. */
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

// Chrome surfaces hang off the shell, so the probe reaches them the way the window's own
// renderers are addressed: through the shell.
const surfaceOf = (shell, surface) => (surface === 'sidebar' ? shell?.sidebarView : shell?.toolbarView)?.webContents ?? null;

/**
 * Record a `send` from Main into a surface, so "the picker push reached the renderer"
 * is measured at the same seam `safeSendWebContents` uses — the webContents `send` call —
 * not inferred from the overlay's own paint.
 */
function watchSends(webContents, tag) {
  if (!webContents || webContents.__pickerProbeSendWrapped) return;
  webContents.__pickerProbeSendWrapped = true;
  const original = webContents.send.bind(webContents);
  webContents.send = (channel, ...args) => {
    observations.sends.push({ surface: tag, channel });
    return original(channel, ...args);
  };
}

/** The File-menu entry the Ctrl+Shift+O accelerator clicks, found by its own label. */
function openProjectMenuItem() {
  const menu = Menu.getApplicationMenu();
  if (!menu) return null;
  const file = menu.items.find((item) => item.label === 'File');
  return file?.submenu?.items?.find((item) => item.label === 'Mở dự án…') ?? null;
}

/**
 * Drive the exact accelerator path: the menu item's click, with the focused window as
 * parent — the same arguments Chromium's accelerator table hands it. Falls back to the
 * keyed event only if the menu entry itself is missing (a platform without the menu,
 * which then means the toolbar chip, the only other entry, is what the probe reads).
 */
async function invokeOpenProjectAccelerator(focusedWindow) {
  const item = openProjectMenuItem();
  if (item && item.enabled) {
    item.click(item, focusedWindow ?? undefined);
    return 'menu-accelerator';
  }
  return 'menu-missing';
}

/** The modal's paint state inside a sidebar or workbench surface. */
const OVERLAY_EXPRESSION = `(() => {
  const el = document.getElementById('projectOpenOverlay');
  if (!el) return 'absent';
  return getComputedStyle(el).display !== 'none' ? 'visible' : 'hidden';
})()`;

async function overlayState(webContents) {
  if (!webContents || webContents.isDestroyed()) return 'no-contents';
  try {
    return await webContents.executeJavaScript(OVERLAY_EXPRESSION, true);
  } catch {
    return 'unreadable';
  }
}

/** Capture one surface's contents to a PNG under reports/, for the written evidence. */
async function captureSurface(webContents, name) {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    const image = await webContents.capturePage();
    if (!image || image.isEmpty()) return null;
    const file = path.join(reportsDir, `picker-${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    return file;
  } catch (err) {
    console.log(`  [capture] ${name} failed: ${messageOf(err)}`);
    return null;
  }
}

/**
 * One picker invocation, observed end to end. Resolves once the open request settled —
 * a `project-open` lifecycle event is the only trustworthy end marker, and it is read
 * back out of the temp runtime log the shipping process itself wrote.
 */
async function runScenario(name, authority, parentWindow, opts) {
  const runtimeLog = path.join(tempRoot, 'runtime', 'logs', 'main.log');
  const logOffset = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8').length : 0;
  const sendOffset = observations.sends.length;
  const dialogOffset = nativeDialogCalls.length;

  const via = await invokeOpenProjectAccelerator(parentWindow);

  // Settle on the journal the shipping process writes, never on a sleep: the request
  // ends when a project-open event after `logOffset` records an outcome, or when the
  // in-app push or the native dialog is measured.
  const settled = await waitFor(
    async () => {
      let events = [];
      try {
        events = fs.readFileSync(runtimeLog, 'utf8').slice(logOffset).split('\n')
          .filter(Boolean)
          .map((line) => { try { return JSON.parse(line).event; } catch { return ''; } });
      } catch {}
      const opens = events.filter((event) => event.startsWith('project-open'));
      const newSends = observations.sends.slice(sendOffset).filter((entry) => entry.channel === 'antifan:project:open-picker');
      const newDialogs = nativeDialogCalls.slice(dialogOffset);
      // The open resolves only when the request reached an outcome: a pick, a cancel,
      // the in-app push, or the native path. A bare `without-target` is the request's
      // start, not its answer.
      if (newSends.length > 0 || newDialogs.length > 0 || opens.some((e) => e !== 'project-open.without-target')) {
        return { events: opens, sends: newSends, dialogs: newDialogs };
      }
      return false;
    },
    `scenario ${name} to reach a picker surface`,
    opts.settleTimeoutMs ?? 15000,
  ).catch((err) => ({ error: messageOf(err) }));

  const scenario = { name, via, ...settled };
  observations.scenarios.push(scenario);
  return scenario;
}

async function run() {
  const { projectWindowAuthority: authority } = mainProcess;
  await app.whenReady();

  const alpha = await waitFor(() => authority.snapshot()[0] ?? false, 'the startup project window');
  expect(alpha.owner?.kind === 'project', 'the boot window must own the alpha project');
  const alphaShell = authority.shellFor(alpha.ownerKey);
  const alphaWindow = alphaShell.window;
  const sidebar = surfaceOf(alphaShell, 'sidebar');
  const toolbar = surfaceOf(alphaShell, 'toolbar');
  expect(sidebar && !sidebar.isDestroyed(), 'the sidebar chrome surface must exist');
  watchSends(sidebar, 'sidebar');

  await waitForApi(
    sidebar,
    "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'",
    30000,
  );

  // ---------------------------------------------------------------
  // Scenario 1 — the user's real repro: sidebar CLOSED, Ctrl+Shift+O.
  // ---------------------------------------------------------------
  expect(alphaShell.isSidebarOpen === false, `probe booted with sidebar already open (isSidebarOpen=${alphaShell.isSidebarOpen})`);
  await captureSurface(toolbar, `${MODE}-toolbar-before`);
  const closedResult = await runScenario('sidebar-closed', authority, alphaWindow, { settleTimeoutMs: 15000 });

  // What did the request actually reach? This is the root-cause read.
  const closedOverlay = await overlayState(sidebar);
  const closedSidebarOpen = alphaShell.isSidebarOpen;
  observations.afterClosedSidebar = {
    overlay: closedOverlay,
    sidebarOpen: closedSidebarOpen,
    nativeDialogs: nativeDialogCalls.length,
  };
  await captureSurface(sidebar, `${MODE}-sidebar-after-closed-request`);

  await check('sidebar closed + Ctrl+Shift+O reaches the in-app modal with no native dialog', async () => {
    if (MODE === 'legacy') {
      return `overlay=${closedOverlay} sidebarOpen=${closedSidebarOpen} nativeDialogs=${nativeDialogCalls.length} events=${(closedResult.events || []).join(',') || 'none'}`;
    }
    expect(nativeDialogCalls.length === 0, `native dialog answered the request ${nativeDialogCalls.length} time(s)`);
    expect(closedSidebarOpen === true, 'the sidebar did not open to host the picker');
    expect(closedOverlay === 'visible', `the in-app modal painted '${closedOverlay}' in the sidebar`);
    expect(
      (closedResult.sends || []).some((entry) => entry.surface === 'sidebar' && entry.channel === 'antifan:project:open-picker'),
      'no PROJECT_OPEN_PICKER push reached the sidebar contents',
    );
    return undefined;
  });

  // Leave the modal politely before the next scenario: answer it cancelled through the
  // renderer's own answer path, the same dismissal Escape produces.
  try {
    await sidebar.executeJavaScript(
      `(function(){ const el=document.getElementById('projectOpenCancel'); if(el){el.click(); return 'clicked'} return 'no-cancel-button' })()`,
      true,
    );
    await sleep(300);
  } catch {}

  // ---------------------------------------------------------------
  // Scenario 2 — the steady state: sidebar OPEN, Ctrl+Shift+O.
  // ---------------------------------------------------------------
  const dialogCountBeforeOpen = nativeDialogCalls.length;
  const openResult = await runScenario('sidebar-open', authority, alphaWindow, { settleTimeoutMs: 15000 });
  const openOverlay = await overlayState(sidebar);
  observations.afterOpenSidebar = {
    overlay: openOverlay,
    nativeDialogs: nativeDialogCalls.length - dialogCountBeforeOpen,
  };
  await captureSurface(sidebar, `${MODE}-sidebar-after-open-request`);

  await check('sidebar open + Ctrl+Shift+O shows the in-app modal in the sidebar', async () => {
    if (MODE === 'legacy') {
      return `overlay=${openOverlay} nativeDialogs=${nativeDialogCalls.length - dialogCountBeforeOpen} events=${(openResult.events || []).join(',') || 'none'}`;
    }
    expect(nativeDialogCalls.length - dialogCountBeforeOpen === 0, 'the native dialog answered with the sidebar open');
    expect(openOverlay === 'visible', `the in-app modal painted '${openOverlay}'`);
    expect(
      (openResult.sends || []).some((entry) => entry.surface === 'sidebar' && entry.channel === 'antifan:project:open-picker'),
      'the picker push did not reach the sidebar contents',
    );
    return undefined;
  });

  // Dismiss whatever is still on screen before teardown.
  try {
    await sidebar.executeJavaScript(
      `(function(){ const el=document.getElementById('projectOpenCancel'); if(el){el.click()} return 'done' })()`,
      true,
    );
  } catch {}
}

/** Leave the process the way a user would: close every open window and let the shipping
 * gate finish the quit, rather than tearing windows down under a live host. */
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
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

let exitCode = 1;
app.whenReady()
  .then(run)
  .catch((err) => {
    check('probe completed without an unexpected throw', () => {
      throw err;
    });
  })
  .finally(async () => {
    await cleanup();
    const failed = MODE === 'legacy' ? [] : checks.filter((entry) => !entry.ok);
    const result = {
      probe: 'project-picker',
      mode: MODE,
      passed: checks.filter((entry) => entry.ok).length,
      failed: failed.length,
      checks,
      observations,
      at: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(reportsDir, `picker-probe-${MODE}.json`), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      origLog(`[probe] failed to write evidence: ${messageOf(err)}`);
      exitCode = 1;
      process.exit(exitCode);
    }
    console.log(`[probe] ${result.passed} passed, ${result.failed} failed — evidence: ${path.join(reportsDir, `picker-probe-${MODE}.json`)}`);
    exitCode = MODE === 'legacy' ? 0 : (failed.length === 0 ? 0 : 1);
    process.exit(exitCode);
  });
