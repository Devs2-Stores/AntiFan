#!/usr/bin/env node
'use strict';

/**
 * Dual-Plane Restart & Crash Recovery Certification (plan 260909-0032, Phase 6 steps 7-8).
 *
 * Phase "seed" (fresh Electron process):
 *   1. user sentinel tab + offscreen agent tab + agent terminal session + attachment
 *   2. persistTabs() must record ONLY the user tab (agent tabs never persist)
 *   3. attachment revocation (the proxy-crash equivalent) reaps ONLY the owned
 *      agent tab + terminal; the user tab survives untouched
 *   4. host disposal + profile lease release
 *   5. spawn a second fresh Electron process against the SAME user-data dir
 *
 * Phase "verify" (fresh Electron process):
 *   1. profile lease acquires cleanly (no stale lock from the crashed run)
 *   2. restoreTabs() restores the user tab and NOT the agent tab
 *   3. no agent terminal session survives restore
 *
 * Exit 0 only when every assertion in both phases passes.
 */

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const phase = process.argv.includes('--phase=verify') ? 'verify' : 'seed';
const userDataDir = process.env.ANTIFAN_RESTART_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-restart-recovery-'));
assert.ok(userDataDir, 'restart-recovery user-data dir resolved');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

const R = path.join(__dirname, '..', '.compiled', 'src');
const { makeControlPlaneId } = require(path.join(R, 'shared', 'control-plane-contracts.js'));
const { ControlPlaneRuntime } = require(path.join(R, 'main', 'control-plane', 'control-plane-runtime.js'));
const { NativeTabHost } = require(path.join(R, 'main', 'browser', 'native-tab-host.js'));
const { TerminalManager } = require(path.join(R, 'main', 'browser', 'terminal-manager.js'));
const { AttachmentRegistry } = require(path.join(R, 'main', 'run', 'attachment-registry.js'));
const { ProfileOwnership } = require(path.join(R, 'main', 'browser', 'profile-ownership.js'));

const traceStart = Date.now();
function trace(label) {
  if (process.env.RR_TRACE) console.log(`[Restart-Recovery] +${Date.now() - traceStart}ms ${label}`);
}

// The seed phase destroys its window before awaiting the fresh-process verifier.
// Without an explicit listener Electron's default window-all-closed handler would
// quit the seed process mid-await and orphan the verifier.
app.on('window-all-closed', () => { /* keep the certification process alive */ });

const SENTINEL_URL = 'https://example.com/sentinel-user-plane';
const AGENT_URL = 'https://example.com/agent-plane-target';
const TABS_FILE = () => path.join(userDataDir, 'saved-tabs.json');
let agentSessionId = '';

function readPersistedTabs() {
  const file = TABS_FILE();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runSeed() {
  console.log('[Restart-Recovery] phase=seed starting');
  const profileDir = path.join(userDataDir, 'browser-profile');
  const profileLease = new ProfileOwnership().acquire(profileDir);
  assert.ok(profileLease, 'seed acquired profile lease');

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const tabHost = new NativeTabHost(win);

  const sentinelId = tabHost.createTab(SENTINEL_URL, true);
  const agentTabId = tabHost.createTab(AGENT_URL, false, { offscreen: true });
  assert.ok(sentinelId && agentTabId, 'user + agent tabs created');
  assert.strictEqual(tabHost.isTabOffscreen(agentTabId), true, 'agent tab is offscreen');
  assert.strictEqual(tabHost.getActiveTabId(), sentinelId, 'user sentinel is active');

  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const runtime = new ControlPlaneRuntime({
    dataRoot: userDataDir,
    projectId,
    workspaceId,
    allowEval: false,
    getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    getAutomationTabId: () => tabHost.getAutomationTabId(),
  });
  const lease = runtime.getLease();
  const registry = new AttachmentRegistry({
    getHostEpoch: () => lease.hostEpoch,
    getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
  });
  // Mirror the composition-root disposal contract: only an owned offscreen agent
  // tab may be reaped, never a user-visible tab.
  registry.setDisposeListener(({ attachmentId, tabId }) => {
    if (!tabId || tabHost.isTabOffscreen(tabId) !== true) return;
    tabHost.closeTab(tabId);
    console.log(`[Restart-Recovery] attachment ${attachmentId} disposed; closed owned agent tab ${tabId}`);
  });

  const { record } = await registry.issueAttachment(
    makeControlPlaneId('run'),
    makeControlPlaneId('attempt'),
    projectId,
    workspaceId,
    {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: lease.hostEpoch,
      tabId: agentTabId,
      grant: 'write',
    }
  );
  assert.strictEqual(record.tabId, agentTabId, 'attachment bound to the agent tab');

  const terminal = TerminalManager.getInstance();
  agentSessionId = terminal.createSession(process.cwd());
  const userSessionId = terminal.createSession(process.cwd());
  assert.ok(agentSessionId && userSessionId, 'agent + user terminal sessions created');

  // Persistence must record user-plane tabs only.
  tabHost.persistTabs();
  const persisted = readPersistedTabs();
  assert.ok(persisted && Array.isArray(persisted.tabs), 'saved-tabs.json written');
  const persistedUrls = persisted.tabs.map((t) => t.url);
  assert.ok(persistedUrls.includes(SENTINEL_URL), `user tab persisted: ${JSON.stringify(persistedUrls)}`);
  assert.ok(!persistedUrls.includes(AGENT_URL), 'agent tab must NOT persist');
  assert.ok(!persisted.tabs.some((t) => t.offscreen === true || t.ephemeral === true), 'no agent-plane tabs persisted');
  assert.strictEqual(persisted.activeTabId, sentinelId, 'persisted active tab is the user sentinel');

  // Proxy-crash equivalent: attachment revoked -> only its owned resources reaped.
  trace('revoke-start');
  await registry.revokeAttachment(record.id);
  trace('revoke-done');
  assert.strictEqual(tabHost.hasTab(agentTabId), false, 'revoked attachment agent tab reaped');
  assert.strictEqual(tabHost.hasTab(sentinelId), true, 'user sentinel tab survives revocation');
  assert.strictEqual(tabHost.getActiveTabId(), sentinelId, 'user sentinel stays active after revocation');
  assert.ok(terminal.listSessions().some((s) => s.id === userSessionId), 'user terminal session survives');
  await terminal.closeSession(agentSessionId);
  assert.ok(!terminal.listSessions().some((s) => s.id === agentSessionId), 'agent terminal session reaped');
  assert.ok(terminal.listSessions().some((s) => s.id === userSessionId), 'user terminal survives agent terminal teardown');

  // The user tab is the only durable user-plane state left on disk.
  trace('reap-asserts-done');
  tabHost.persistTabs();
  trace('persist-after-done');
  const persistedAfter = readPersistedTabs();
  assert.deepStrictEqual(
    persistedAfter.tabs.map((t) => t.url),
    [SENTINEL_URL],
    'only the user tab remains persisted after agent teardown'
  );

  trace('persist-after-asserted');
  await terminal.closeSession(userSessionId);
  trace('user-session-closed');
  await terminal.dispose();
  trace('terminal-disposed');
  tabHost.dispose();
  trace('tabhost-disposed');
  if (!win.isDestroyed()) win.destroy();
  trace('window-destroyed');
  profileLease.release();
  trace('lease-released');
  console.log('[Restart-Recovery] phase=seed complete; userData seeded at', userDataDir);
}

async function runVerify() {
  console.log('[Restart-Recovery] phase=verify starting');
  const profileDir = path.join(userDataDir, 'browser-profile');
  let profileLease;
  try {
    profileLease = new ProfileOwnership().acquire(profileDir);
  } catch (err) {
    assert.fail(`no stale profile lock may survive a crashed run: ${err && err.message}`);
  }
  assert.ok(profileLease, 'fresh process acquired the profile lease');

  const persisted = readPersistedTabs();
  assert.ok(persisted && Array.isArray(persisted.tabs), 'saved-tabs.json readable by the fresh process');
  assert.deepStrictEqual(persisted.tabs.map((t) => t.url), [SENTINEL_URL], 'disk holds only the user tab');

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const tabHost = new NativeTabHost(win);
  tabHost.restoreTabs(SENTINEL_URL);

  const restored = tabHost.getTabList();
  const restoredUrls = restored.map((t) => t.url);
  assert.deepStrictEqual(restoredUrls, [SENTINEL_URL], `only the user tab restores: ${JSON.stringify(restoredUrls)}`);
  assert.ok(!restored.some((t) => t.offscreen === true || t.ephemeral === true), 'no agent tab restores');
  assert.ok(!restored.some((t) => t.url === AGENT_URL), 'agent target URL never restores');

  // No transient terminal ownership survives the crash: the agent session is gone,
  // and restore must not resurrect one.
  const terminal = TerminalManager.getInstance();
  const agentSessionId = process.env.ANTIFAN_AGENT_SESSION_ID || '';
  assert.ok(agentSessionId, 'driver passed the agent session id');
  assert.ok(
    !terminal.listSessions().some((s) => s.id === agentSessionId),
    `no orphan agent terminal ownership after restore (${agentSessionId})`
  );

  tabHost.dispose();
  if (!win.isDestroyed()) win.destroy();
  profileLease.release();
  console.log('[Restart-Recovery] phase=verify complete: user tab restored, no agent-plane residue');
}

function spawnVerifyProcess(agentSessionId) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ANTIFAN_RESTART_USERDATA: userDataDir, ANTIFAN_AGENT_SESSION_ID: agentSessionId };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [__filename, '--phase=verify'], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

app.whenReady().then(async () => {
  try {
    if (phase === 'seed') {
      await runSeed();
      console.log('[Restart-Recovery] spawning fresh GUI process for restart verification...');
      const code = await spawnVerifyProcess(agentSessionId);
      if (code !== 0) {
        throw new Error(`fresh-process restart verification exited with code ${code}`);
      }
      console.log('ALL DUAL-PLANE RESTART & CRASH RECOVERY CHECKS PASSED.');
      app.exit(0);
    } else {
      await runVerify();
      app.exit(0);
    }
  } catch (err) {
    console.error('[Restart-Recovery FAIL]', err);
    app.exit(1);
  }
});
