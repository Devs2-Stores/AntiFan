/**
 * Multiple Project Windows, Per-Window Authority — real Electron probe.
 *
 * Boots the shipping main process in this Electron instance and drives its own
 * entrypoints:
 *
 *   a. startup opens exactly one project window;
 *   b. the user's project-open channel (`window.antifanStandalone.openProject`) opens a
 *      SECOND project window through the same factory — its own host, labels, terminal
 *      root and tabs;
 *   c. a tab is opened in each window through that window's own toolbar channel;
 *   d. closing the first window leaves the second alive with its tabs intact and
 *      `browserShellCount() === 1` — the process does not quit;
 *   e. an agent-intent window is created without a single show/focus/raise call.
 *
 * Every check names the value it judged, and a check that cannot observe its subject
 * fails rather than skips: this probe is the acceptance evidence unit tests cannot give
 * (real windows, real chrome surfaces, real IPC).
 *
 * Run: node scripts/run-electron.cjs scripts/probe-project-windows.cjs
 * Evidence: plans/260927-0315-project-windows/reports/project-windows-probe.{json,log}
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
// The isolated build (`tsc --outDir .tmp-pw-index`) is pointed at explicitly; the
// repository default stays `.compiled`, which is what `npm run compile` produces.
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));

const reportsDir = path.join(ROOT, 'plans', '260927-0315-project-windows', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'project-windows-probe.log');
fs.writeFileSync(logFile, '', 'utf8');
// Synchronous: the process exits straight after the summary, and a buffered stream would
// drop the evidence for the run that failed hardest.
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};

// Throwaway world: a temp data root (config, control plane, runtime) and a temp Chromium
// profile, both seeded before the main process is required. Nothing here can read or write
// the developer's real profile, real data root or real capsules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pw-probe-'));
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
// An owner no capsule describes: the agent-intent window, and the honest-label fallback.
const GAMMA = { projectId: 'project-00000000-0000-4000-8000-0000000000c3' };

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
process.env.ANTIFAN_BRIDGE_PORT = '20987';

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

// Boot the shipping main process inside this same Electron instance. Its boot guards run
// at import — `protocol.registerSchemesAsPrivileged` refuses to run after `app.whenReady()`,
// and the deadline chain is asserted before any window exists — so the process is imported
// here, with the throwaway environment already seeded above it.
const mainProcess = require(compiledModule('index.js'));
const { dispatchChromeRoute } = require(compiledModule('browser/ipc-router.js'));
const { NativeTabHost } = require(compiledModule('browser/native-tab-host.js'));

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

// Chrome surfaces hang off the shell (the window is only its native half), so the probe
// reaches them the way the window's own renderers are addressed: through the shell.
const surfaceOf = (shell, surface) => (surface === 'sidebar' ? shell?.sidebarView : shell?.toolbarView)?.webContents ?? null;
const entryById = (snapshot, windowId) => snapshot.find((entry) => entry.windowId === windowId);
const entryByOwnerKey = (snapshot, key) => snapshot.find((entry) => entry.ownerKey === key);

async function run() {
  const { projectWindowAuthority: authority, PROJECT_WINDOW_ROUTES: projectRoutes } = mainProcess;
  const allChromeRoutes = [...NativeTabHost.CHROME_ROUTES, ...projectRoutes];

  await app.whenReady();

  // ---- (a) startup ------------------------------------------------------------------
  const bootstrapEntry = await waitFor(
    () => {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup project window',
  );
  const bootstrapKey = bootstrapEntry.ownerKey;
  const bootstrapWindow = authority.windowFor(bootstrapKey);
  observations.startup = { browserShellCount: authority.browserShellCount(), entry: bootstrapEntry };

  await check('startup opens exactly one project window, keyed by the boot identity', () => {
    expect(authority.browserShellCount() === 1, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(bootstrapEntry.owner.kind === 'project', `owner kind was '${bootstrapEntry.owner.kind}'`);
    expect(bootstrapEntry.owner.projectId === ALPHA.projectId, `owner project was '${bootstrapEntry.owner.projectId}'`);
    expect(bootstrapWindow && !bootstrapWindow.isDestroyed(), 'the startup window has no native window');
  });

  await check('the startup window carries its own host and Main-derived labels', () => {
    expect(bootstrapEntry.hostOwnerKey === bootstrapKey, `host owner key was '${bootstrapEntry.hostOwnerKey}', shell owner key '${bootstrapKey}'`);
    // The OS title carries this build's marker on top of the validated name, so the
    // record is what the title must start with — never a second, renderer-supplied one.
    expect(bootstrapEntry.title.startsWith(ALPHA.name), `title was '${bootstrapEntry.title}'`);
    expect(bootstrapEntry.identity.title.startsWith(ALPHA.name), `identity title was '${bootstrapEntry.identity.title}'`);
    expect(bootstrapEntry.identity.owner.projectId === ALPHA.projectId, `identity owner project was '${bootstrapEntry.identity.owner.projectId}'`);
    expect(samePath(bootstrapEntry.identity.pathLabel, ALPHA.path), `identity pathLabel was '${bootstrapEntry.identity.pathLabel}'`);
    expect(samePath(bootstrapEntry.identity.workspacePath, ALPHA.path), `identity workspacePath was '${bootstrapEntry.identity.workspacePath}'`);
  });

  await check('the window resolves its own terminal workspace root', () => {
    expect(samePath(bootstrapEntry.terminalCwd, ALPHA.path), `terminal cwd was '${bootstrapEntry.terminalCwd}'`);
    expect(bootstrapEntry.terminalCwdSource === 'window-workspace', `terminal cwd source was '${bootstrapEntry.terminalCwdSource}'`);
  });

  await check('the process registered the cross-window channels once, beside the host channels', () => {
    const registered = authority.registeredChromeChannels();
    observations.registeredChromeChannels = registered.length;
    for (const channel of ['antifan:project:open', 'antifan:tabs:search', 'antifan:tabs:search-activate']) {
      expect(registered.includes(channel), `channel '${channel}' is not in the router ledger`);
    }
    expect(registered.length > 20, `only ${registered.length} chrome channels were registered`);
  });

  const toolbarA = surfaceOf(authority.shellFor(bootstrapKey), 'toolbar');
  const sidebarA = surfaceOf(authority.shellFor(bootstrapKey), 'sidebar');
  expect(toolbarA && !toolbarA.isDestroyed(), 'the startup window has no toolbar surface');
  expect(sidebarA && !sidebarA.isDestroyed(), 'the startup window has no sidebar surface');
  await waitForApi(toolbarA, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.searchProjectTabs === 'function'");
  await waitForApi(sidebarA, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
  const readChip = (webContents) => webContents.executeJavaScript(
    `(() => { const chip = document.getElementById('projectChip'); const title = document.getElementById('projectChipTitle'); const path = document.getElementById('projectChipPath');
       return { visible: Boolean(chip) && getComputedStyle(chip).display !== 'none', title: title ? title.textContent || '' : '', path: path ? path.textContent || '' : '' }; })()`,
    true,
  );

  // ---- (b) a second project window, opened by the user's own entrypoint --------------
  const secondOpenResult = await sidebarA.executeJavaScript(
    `window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`,
    true,
  );
  observations.secondOpenResult = secondOpenResult;

  const betaEntry = await waitFor(
    () => authority.snapshot().find((entry) => entry.owner.kind === 'project' && entry.owner.projectId === BETA.projectId) || false,
    'the second project window',
  );
  const betaKey = betaEntry.ownerKey;
  observations.secondWindow = betaEntry;

  await check('the project-open channel opens a second window with its own authority', () => {
    expect(secondOpenResult && secondOpenResult.status === 'OPENED', `openProject returned ${JSON.stringify(secondOpenResult)}`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(betaEntry.windowId !== bootstrapEntry.windowId, `both windows reported id ${betaEntry.windowId}`);
    expect(betaEntry.hostOwnerKey === betaKey, `second window host key was '${betaEntry.hostOwnerKey}'`);
    expect(betaEntry.title.startsWith(BETA.name), `second window title was '${betaEntry.title}'`);
    expect(samePath(betaEntry.identity.workspacePath, BETA.path), `second window workspace was '${betaEntry.identity.workspacePath}'`);
    expect(samePath(betaEntry.terminalCwd, BETA.path), `second window terminal cwd was '${betaEntry.terminalCwd}'`);
    expect(betaEntry.terminalCwdSource === 'window-workspace', `second window terminal cwd source '${betaEntry.terminalCwdSource}'`);
  });

  await check('re-opening an open project joins that window instead of creating another', async () => {
    const again = await sidebarA.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(BETA.projectId)})`, true);
    expect(again && again.status === 'FOCUSED', `the duplicate open returned ${JSON.stringify(again)}`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()} after the duplicate open`);
    const after = authority.snapshot().find((entry) => entry.owner.kind === 'project' && entry.owner.projectId === BETA.projectId);
    expect(after && after.windowId === betaEntry.windowId, 'the second window changed identity across the duplicate open');
  });

  await check('an unknown project id is refused instead of opened', async () => {
    const result = await sidebarA.executeJavaScript(
      "window.antifanStandalone.openProject('project-00000000-0000-4000-8000-0000000000ff')",
      true,
    );
    observations.unknownProject = result;
    expect(result && result.status === 'FAILED', `an unknown project returned ${JSON.stringify(result)}`);
    expect(result.reason === 'UNKNOWN_PROJECT', `an unknown project reported '${result.reason}'`);
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()} after a refused open`);
  });

  // ---- (c) a tab in each window, created through that window's own toolbar -----------
  const betaWindow = authority.windowFor(betaKey);
  expect(betaWindow && !betaWindow.isDestroyed(), 'the second window has no native window');
  const toolbarB = surfaceOf(authority.shellFor(betaKey), 'toolbar');
  await waitForApi(toolbarB, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");

  await check("each window broadcasts its own Main-derived identity to its own chrome", async () => {
    const identityOf = async (webContents, description) => {
      const state = await waitFor(
        async () => {
          const value = await webContents.executeJavaScript('window.antifanToolbar.getInitialState()', true);
          return value && value.projectWindow ? value : false;
        },
        description,
      );
      return state.projectWindow;
    };
    const identityA = await identityOf(toolbarA, "window A's project identity");
    const identityB = await identityOf(toolbarB, "window B's project identity");
    observations.identities = { identityA, identityB };
    expect(identityA.owner.kind === 'project', `window A identity owner was ${JSON.stringify(identityA.owner)}`);
    expect(identityA.owner.projectId === ALPHA.projectId, `window A identity project was '${identityA.owner.projectId}'`);
    expect(identityA.title === bootstrapEntry.identity.title, `window A identity title was '${identityA.title}'`);
    expect(samePath(identityA.pathLabel, ALPHA.path), `window A identity pathLabel was '${identityA.pathLabel}'`);
    expect(identityB.owner.kind === 'project', `window B identity owner was ${JSON.stringify(identityB.owner)}`);
    expect(identityB.owner.projectId === BETA.projectId, `window B identity project was '${identityB.owner.projectId}'`);
    expect(identityB.title === betaEntry.identity.title, `window B identity title was '${identityB.title}'`);
    expect(samePath(identityB.pathLabel, BETA.path), `window B identity pathLabel was '${identityB.pathLabel}'`);
    expect(identityA.owner.projectId !== identityB.owner.projectId, 'both windows broadcast the same project identity');
  });

  // The chip is painted by the toolbar's own renderer script, which is a bundler artifact:
  // this probe runs the main process from an isolated `tsc` build, where no bundled renderer
  // script exists, so the rendered chip is recorded as an observation rather than judged
  // here. What Main sends — the field that renderer paints — is asserted, per window, above.
  observations.toolbarDom = { chipA: await readChip(toolbarA), chipB: await readChip(toolbarB) };
  if (!observations.toolbarDom.chipA.title) {
    console.log("  NOTE  toolbar DOM not driven: this build ships no bundled renderer script, chip rendering is the renderer lane's evidence");
  }

  const tabA = await toolbarA.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
  const tabB = await toolbarB.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
  await sleep(250);
  const snapshotAfterTabs = authority.snapshot();
  const alphaAfterTabs = entryById(snapshotAfterTabs, bootstrapEntry.windowId);
  const betaAfterTabs = entryById(snapshotAfterTabs, betaEntry.windowId);
  observations.tabs = { tabA, tabB, alphaTabs: alphaAfterTabs.tabIds, betaTabs: betaAfterTabs.tabIds };

  await check('a tab opened in one window is owned by that window alone', () => {
    expect(typeof tabA === 'string' && tabA.length > 0, `window A created no tab (${JSON.stringify(tabA)})`);
    expect(typeof tabB === 'string' && tabB.length > 0, `window B created no tab (${JSON.stringify(tabB)})`);
    expect(tabA !== tabB, `both windows reported the same tab id ${tabA}`);
    expect(alphaAfterTabs.tabIds.includes(tabA), `window A does not list its own tab ${tabA}: ${JSON.stringify(alphaAfterTabs.tabIds)}`);
    expect(betaAfterTabs.tabIds.includes(tabB), `window B does not list its own tab ${tabB}: ${JSON.stringify(betaAfterTabs.tabIds)}`);
    expect(!alphaAfterTabs.tabIds.includes(tabB), `window A lists window B's tab ${tabB}`);
    expect(!betaAfterTabs.tabIds.includes(tabA), `window B lists window A's tab ${tabA}`);
  });

  await check('the directory resolves each tab to the host that owns it', () => {
    const hostA = authority.hostForTab(tabA);
    const hostB = authority.hostForTab(tabB);
    expect(hostA, `no host owns tab ${tabA}`);
    expect(hostB, `no host owns tab ${tabB}`);
    expect(hostA !== hostB, 'both tabs resolved to one host');
    expect(hostA.windowOwnerKey() === bootstrapKey, `tab A resolved to host '${hostA.windowOwnerKey()}'`);
    expect(hostB.windowOwnerKey() === betaKey, `tab B resolved to host '${hostB.windowOwnerKey()}'`);
    expect(hostA.hasExactTab(tabA) && !hostA.hasExactTab(tabB), 'window A host tab membership is wrong');
    expect(hostB.hasExactTab(tabB) && !hostB.hasExactTab(tabA), 'window B host tab membership is wrong');
  });

  // ---- cross-window search: inventory, exact activation, refusal ---------------------
  const inventory = await toolbarA.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
  observations.inventory = inventory;

  await check("the search channel lists every window's user-visible tabs with Main labels", () => {
    expect(inventory && inventory.status === 'OK', `search returned ${JSON.stringify(inventory)}`);
    const rowA = (inventory.rows || []).find((row) => row.tabId === tabA);
    const rowB = (inventory.rows || []).find((row) => row.tabId === tabB);
    expect(rowA, `window A's tab ${tabA} is missing from the inventory`);
    expect(rowB, `window B's tab ${tabB} is missing from the inventory`);
    // The label a user searches against is the label the window itself shows: both come
    // from Main's record, so a row can never advertise a uuid the user has never seen.
    expect(rowA.ownerLabel === bootstrapEntry.identity.title, `tab A owner label was '${rowA.ownerLabel}', window A calls itself '${bootstrapEntry.identity.title}'`);
    expect(rowB.ownerLabel === betaEntry.identity.title, `tab B owner label was '${rowB.ownerLabel}', window B calls itself '${betaEntry.identity.title}'`);
    expect(rowB.ownerLabel.startsWith(BETA.name), `tab B owner label was '${rowB.ownerLabel}'`);
    expect(samePath(rowB.pathLabel, BETA.path), `tab B path label was '${rowB.pathLabel}'`);
  });

  await check('the search channel has no side effects: two windows list the same inventory', async () => {
    const fromB = await toolbarB.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    const key = (result) => JSON.stringify((result.rows || []).map((row) => [row.tabId, row.ownerLabel, row.live]));
    observations.inventoryParity = { fromA: key(inventory), fromB: key(fromB) };
    expect(key(fromB) === key(inventory), 'two windows listed different inventories');
  });

  await check('activating a search result presents that exact foreign tab without moving authority', async () => {
    const alphaBefore = entryById(authority.snapshot(), bootstrapEntry.windowId);
    const result = await toolbarA.executeJavaScript(`window.antifanToolbar.activateProjectTab(${JSON.stringify(tabB)})`, true);
    await sleep(150);
    const after = authority.snapshot();
    const alphaAfter = entryById(after, bootstrapEntry.windowId);
    const betaAfter = entryById(after, betaEntry.windowId);
    observations.activation = { result, alphaActiveBefore: alphaBefore.activeTabId, alphaActiveAfter: alphaAfter.activeTabId, betaActive: betaAfter.activeTabId };
    expect(result && result.status === 'ACTIVATED', `activation returned ${JSON.stringify(result)}`);
    expect(betaAfter.activeTabId === tabB, `window B active tab was '${betaAfter.activeTabId}', expected '${tabB}'`);
    expect(alphaAfter.activeTabId === alphaBefore.activeTabId, `window A active tab moved from '${alphaBefore.activeTabId}' to '${alphaAfter.activeTabId}'`);
  });

  await check('a stale result refuses with no substitute and no focus change', async () => {
    const before = authority.snapshot();
    const result = await toolbarA.executeJavaScript("window.antifanToolbar.activateProjectTab('tab-that-never-existed')", true);
    await sleep(150);
    const after = authority.snapshot();
    observations.staleActivation = result;
    expect(result && result.status === 'UNAVAILABLE', `stale activation returned ${JSON.stringify(result)}`);
    expect(result.reasonCode === 'TAB_CLOSED', `stale activation reasonCode was '${result.reasonCode}'`);
    expect(result.tabId === 'tab-that-never-existed', `stale activation named tab '${result.tabId}'`);
    expect(JSON.stringify(before.map((entry) => entry.activeTabId)) === JSON.stringify(after.map((entry) => entry.activeTabId)), 'a refused activation moved an active tab');
    expect(JSON.stringify(before.map((entry) => entry.focused)) === JSON.stringify(after.map((entry) => entry.focused)), 'a refused activation moved window focus');
  });

  await check('a tab page is not a chrome surface: every cross-window channel refuses it', async () => {
    const pageContents = authority.hostForTab(tabA)?.getTabWebContents(tabA, 'desktop');
    expect(pageContents && !pageContents.isDestroyed(), 'the tab page has no webContents to send from');
    const refusals = [];
    for (const [channel, payload] of [
      ['antifan:project:open', { projectId: BETA.projectId }],
      ['antifan:tabs:search', { query: '' }],
      ['antifan:tabs:search-activate', { tabId: tabA }],
    ]) {
      let code;
      try {
        await dispatchChromeRoute(allChromeRoutes, channel, pageContents, [payload]);
      } catch (err) {
        code = err && err.code;
      }
      refusals.push({ channel, code });
    }
    observations.pageRefusals = refusals;
    for (const refusal of refusals) {
      expect(refusal.code === 'UNKNOWN_CHROME_SENDER', `${refusal.channel} refused a page with ${String(refusal.code)}`);
    }
  });

  // ---- (e) agent intent never presents -----------------------------------------------
  const presentationCalls = [];
  const patchedMethods = [];
  for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'maximize', 'restore']) {
    const original = BrowserWindow.prototype[method];
    if (typeof original !== 'function') continue;
    patchedMethods.push([method, original]);
    BrowserWindow.prototype[method] = function patched(...args) {
      presentationCalls.push({ method, windowId: this.id });
      return original.apply(this, args);
    };
  }

  let gammaEntry = null;
  try {
    const beforeAgent = authority.snapshot();
    gammaEntry = await authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'agent');
    await sleep(500);
    const afterAgent = authority.snapshot();
    observations.agentWindow = {
      entry: gammaEntry,
      callsForAgentWindow: presentationCalls.filter((call) => call.windowId === gammaEntry.windowId),
      callsForOtherWindows: presentationCalls.filter((call) => call.windowId !== gammaEntry.windowId),
    };

    await check('an agent-intent window is created without a single presentation call', () => {
      const calls = presentationCalls.filter((call) => call.windowId === gammaEntry.windowId);
      expect(calls.length === 0, `presentation calls for the agent window: ${JSON.stringify(calls)}`);
      const window = authority.windowFor(gammaEntry.ownerKey);
      expect(window && !window.isDestroyed(), 'the agent window does not exist');
      expect(window.isVisible() === false, 'the agent window is visible');
      expect(window.isFocused() === false, 'the agent window is focused');
    });

    await check("creating an agent window does not move the user's windows", () => {
      for (const entry of afterAgent) {
        if (entry.ownerKey === gammaEntry.ownerKey) continue;
        const previous = beforeAgent.find((candidate) => candidate.ownerKey === entry.ownerKey);
        if (!previous) continue;
        expect(entry.visible === previous.visible, `window '${entry.ownerKey}' visibility changed from ${previous.visible} to ${entry.visible}`);
        expect(entry.focused === previous.focused, `window '${entry.ownerKey}' focus changed from ${previous.focused} to ${entry.focused}`);
      }
      const otherCalls = presentationCalls.filter((call) => call.windowId !== gammaEntry.windowId);
      expect(otherCalls.length === 0, `creating the agent window presented other windows: ${JSON.stringify(otherCalls)}`);
    });

    await check('the agent window is a managed window too: own host, own identity, no borrowed project', () => {
      expect(gammaEntry.hostOwnerKey === gammaEntry.ownerKey, `agent window host key was '${gammaEntry.hostOwnerKey}'`);
      expect(gammaEntry.identity.owner.projectId === GAMMA.projectId, `agent window identity project was '${gammaEntry.identity.owner.projectId}'`);
      expect(gammaEntry.title.startsWith(GAMMA.projectId), `agent window title was '${gammaEntry.title}' — an unrecorded project must show its id, never another project's name`);
      expect(gammaEntry.identity.workspacePath === undefined, `agent window claims workspace '${gammaEntry.identity.workspacePath}'`);
    });
  } finally {
    for (const [method, original] of patchedMethods) {
      BrowserWindow.prototype[method] = original;
    }
  }

  // ---- (d) per-shell close gate -------------------------------------------------------
  // The agent window is a managed window like any other, so the close gate is measured
  // against the reviewer's own scenario: three windows open, close the agent one and then
  // the first project, and exactly one — the second project, with its tabs — must remain.
  const gammaKey = gammaEntry.ownerKey;
  const agentCloseRequested = authority.requestClose(gammaKey);
  await waitFor(() => authority.browserShellCount() === 2, 'the agent window to close');
  await check('an agent-created window closes like any other without taking its siblings', () => {
    expect(agentCloseRequested, 'the close request never reached the agent window');
    expect(authority.browserShellCount() === 2, `browserShellCount() was ${authority.browserShellCount()}`);
    const remaining = authority.snapshot();
    expect(!remaining.some((entry) => entry.ownerKey === gammaKey), 'the agent window is still in the directory');
    expect(remaining.some((entry) => entry.ownerKey === bootstrapKey), 'window A vanished with the agent window');
    expect(remaining.some((entry) => entry.ownerKey === betaKey), 'window B vanished with the agent window');
  });

  const beforeClose = authority.snapshot();
  const alphaHost = authority.hostForOwner(bootstrapKey);
  const betaTabsBefore = [...(entryByOwnerKey(beforeClose, betaKey)?.tabIds || [])];
  observations.beforeClose = { count: authority.browserShellCount(), alphaHostPresent: Boolean(alphaHost), betaTabsBefore };

  const closeRequested = authority.requestClose(bootstrapKey);
  await waitFor(() => authority.browserShellCount() === 1, 'the first window to close');
  await sleep(300);
  const afterClose = authority.snapshot();
  const survivingHostForTabB = authority.hostForTab(tabB);
  observations.afterClose = {
    closeRequested,
    count: authority.browserShellCount(),
    entries: afterClose,
    tabAOwner: authority.hostForTab(tabA) ? authority.hostForTab(tabA).windowOwnerKey() : null,
  };

  await check('closing a project window leaves its siblings alive: shellCount 1, B and its tabs intact', () => {
    expect(closeRequested, 'the close request never reached the window');
    expect(authority.browserShellCount() === 1, `browserShellCount() was ${authority.browserShellCount()}`);
    expect(!afterClose.some((entry) => entry.ownerKey === bootstrapKey), 'the closed window is still in the directory');
    const betaEntryAfter = entryByOwnerKey(afterClose, betaKey);
    expect(betaEntryAfter, 'window B disappeared with window A');
    const betaWindowAfter = authority.windowFor(betaKey);
    expect(betaWindowAfter && !betaWindowAfter.isDestroyed(), 'window B native window was destroyed');
    expect(JSON.stringify(betaEntryAfter.tabIds) === JSON.stringify(betaTabsBefore), `window B tabs changed from ${JSON.stringify(betaTabsBefore)} to ${JSON.stringify(betaEntryAfter.tabIds)}`);
    expect(betaEntryAfter.tabIds.includes(tabB), `window B lost its tab ${tabB}`);
    expect(survivingHostForTabB && survivingHostForTabB.windowOwnerKey() === betaKey, "window B's tab no longer resolves to window B");
  });

  await check("the closed window's host is unregistered and its tabs stop resolving", () => {
    expect(authority.hostForOwner(bootstrapKey) === null, 'the closed window still has a host');
    expect(authority.hostForTab(tabA) === null, `the closed window's tab ${tabA} still resolves to a host`);
    expect(alphaHost, 'the probe lost its reference to the closed window host');
  });

  await check('the process is still alive after a window closed', () => {
    expect(authority.browserShellCount() === 1, 'the surviving window is no longer counted');
    expect(app.isReady() === true, 'the app is no longer ready after a window closed');
    expect(BrowserWindow.getAllWindows().some((window) => window.id === betaEntry.windowId), "window B's native window is gone");
  });
}

/**
 * Leave the process the way a user would: close every window that is still open and let
 * the shipping gate finish the quit, rather than tearing windows down under a live host
 * with `process.exit`.
 */
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
    const failed = checks.filter((entry) => !entry.ok);
    const result = {
      probe: 'project-windows',
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
      observations,
      at: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(reportsDir, 'project-windows-probe.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      origLog(`[probe] failed to write evidence: ${messageOf(err)}`);
      exitCode = 1;
      process.exit(exitCode);
    }
    console.log(`[probe] ${result.passed} passed, ${result.failed} failed — evidence: ${path.join(reportsDir, 'project-windows-probe.json')}`);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  });
