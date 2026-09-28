/**
 * Project Windows — phase-5 live acceptance matrix harness.
 *
 * This is the acceptance instrument for `plans/260927-0315-project-windows/phase-05-certification.md`:
 * it boots the shipping main process inside one real Electron instance (throwaway data root,
 * throwaway Chromium profile, throwaway workspace capsules, own bridge port, own processes) and
 * walks the phase-5 test-scenario matrix row by row.
 *
 * Every matrix row is declared up front in `ROW_PLAN`, so the receipt always carries the whole
 * matrix: a row whose judge never ran is emitted as BLOCKED ("the run ended before this row was
 * observed"), never omitted and never passed. A row is PASS only with the values it observed in
 * `observed` — no row is decided by a boolean alone, and none is decided by a fixture.
 *
 * Rows whose proof needs physical hardware or a human observer (two physical monitors with a person
 * confirming both surfaces, an unplugged display, an OS scale change, real OS foreground lockouts)
 * are first-class BLOCKED rows carrying the reason and the facts a human would need — never
 * simulated with a synthetic screen event and never counted as passes.
 *
 * Two-phase run, because one of the facts happens after this process is gone:
 *   phase 1  node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs
 *            boots, drives the matrix, writes the receipt, and arms a detached post-exit watcher.
 *   phase 2  node scripts/probe-project-windows-matrix.cjs --verify-orphans
 *            after phase 1 has exited: waits for the watcher report that belongs to *this*
 *            receipt (same host pid and data root token, checked no earlier than the receipt) and
 *            merges its orphan verdict into row R9E. A report from another run is refused, not
 *            folded: the file survives between runs, so "the file that is there" is not evidence
 *            about this run. Unknown until then, so R9E is BLOCKED in phase 1.
 *
 * The harness drives only shipping entrypoints:
 *   - `projectWindowAuthority` (index's live inspection seam: snapshot/ensureProjectWindow/
 *     requestClose/attemptClose/requestQuit/applicationPhase/reservations/controlPlane/...),
 *   - the window's own chrome surfaces through their preload APIs (toolbar createTab/
 *     searchProjectTabs/activateProjectTab, sidebar openProject),
 *   - the shared control plane (chats, runs, attachment registry, capability transport, terminals),
 *   - the tab authorities themselves (createTab/navigateAndWait/split/capture/partitions/views),
 *   - and a real bridge WebSocket client for the transport-disconnect row.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs
 * Evidence: plans/260927-0315-project-windows/reports/project-windows-matrix.{json,log}
 *           plans/260927-0315-project-windows/reports/project-windows-matrix-orphans.{json,log}
 *
 * Exit codes: 0 = every row PASS; 1 = at least one row FAIL; 2 = no FAIL but BLOCKED rows exist
 * (hardware/human rows and the post-exit orphan verdict make the certification incomplete, which is
 * not the same as a failure).
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const reportsDir = path.join(ROOT, 'plans', '260927-0315-project-windows', 'reports');
const receiptPath = path.join(reportsDir, 'project-windows-matrix.json');
const orphanReportPath = path.join(reportsDir, 'project-windows-matrix-orphans.json');
const orphanLogPath = path.join(reportsDir, 'project-windows-matrix-orphans.log');
const journalCopyPath = path.join(reportsDir, 'project-windows-matrix-journal.log');

// ===============================================================================================
// Phase 2: merge the post-exit orphan verdict. Runs as a plain Node process: no Electron, no boot.
// ===============================================================================================
if (process.argv.includes('--verify-orphans')) {
  verifyOrphans();
  return;
}

function verifyOrphans() {
  const readJson = (target) => {
    try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
  };
  const receipt = readJson(receiptPath);
  // The report is a file that survives between runs, and this phase runs after the phase-1 process
  // is gone: reading "the file that is there" would fold a previous run's verdict into this run's
  // receipt. The receipt carries the identity of the host the verdict is about (the phase-1 pid and
  // the data root token its watcher was armed with), so the merge waits for the report that
  // actually belongs to it and refuses to decide from any other.
  const r9e = (Array.isArray(receipt?.rows) ? receipt.rows : []).find((entry) => entry.id === 'R9E');
  const expectedHostPid = r9e?.observed?.hostPid ?? null;
  const expectedToken = r9e?.observed?.watcher?.dataRootToken ?? null;
  const receiptAt = typeof receipt?.at === 'string' ? Date.parse(receipt.at) : Number.NaN;
  const belongsToThisRun = (candidate) => {
    // Fail closed. A report is accepted only against identities taken from the receipt itself, and
    // both sides must carry them: a receipt with no phase-1 host pid or no data root token has
    // nothing to bind to, so no report can be shown to describe it, and a report that omits either
    // is not evidence about this run just because it happens to be the newest file present.
    if (!candidate) return false;
    if (expectedHostPid === null) return false;
    if (!expectedToken) return false;
    if (Number(candidate.hostPid) !== Number(expectedHostPid)) return false;
    if (!candidate.dataRootToken) return false;
    if (String(candidate.dataRootToken) !== String(expectedToken)) return false;
    const checkedAt = Date.parse(String(candidate.checkedAt ?? ''));
    if (Number.isFinite(receiptAt) && Number.isFinite(checkedAt) && checkedAt < receiptAt) return false;
    return true;
  };
  // Why this receipt cannot be bound to a report, when that is the case; null when it can.
  const identityProblem = expectedHostPid === null
    ? 'the receipt carries no host pid for its R9E row, so no watcher report can be shown to describe this run'
    : !expectedToken
      ? 'the receipt carries no data root token for its R9E row, so no watcher report can be shown to describe this run'
      : null;
  const WAIT_MS = 120_000;
  const deadline = Date.now() + WAIT_MS;
  let report = readJson(orphanReportPath);
  if (identityProblem === null && !belongsToThisRun(report)) {
    console.log(`[matrix] waiting up to ${Math.round(WAIT_MS / 1000)}s for the watcher report of host pid ${String(expectedHostPid)} (data root token ${String(expectedToken)}); the file currently holds ${report ? `hostPid ${String(report.hostPid)} token ${String(report.dataRootToken ?? 'absent')} checkedAt ${String(report.checkedAt)}` : 'nothing'}`);
    while (Date.now() < deadline) {
      report = readJson(orphanReportPath);
      if (belongsToThisRun(report)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  if (identityProblem !== null || !belongsToThisRun(report)) {
    const stale = identityProblem
      ? identityProblem
      : report
        ? `the report on disk belongs to a different run (hostPid ${String(report.hostPid)}, data root token ${String(report.dataRootToken ?? 'absent')}, checkedAt ${String(report.checkedAt)})`
        : 'no watcher report exists at all';
    const reason = identityProblem
      ? `the post-exit orphan verdict cannot be bound to this run: ${stale}`
      : `the post-exit watcher never reported for the host of this receipt (pid ${String(expectedHostPid)}, token ${String(expectedToken)}): ${stale}`;
    const lines = [
      `orphan verification at ${new Date().toISOString()}`,
      `receipt: ${receiptPath} (${receipt ? 'read' : 'MISSING'})`,
      `watcher report: ${orphanReportPath} (${report ? 'stale' : 'MISSING'})`,
      `verdict: BLOCKED - ${reason}.`,
    ];
    fs.appendFileSync(orphanLogPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(lines.join('\n'));
    if (receipt && r9e) {
      r9e.status = 'BLOCKED';
      delete r9e.error;
      r9e.reason = reason;
      const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
      const check = checks.find((entry) => String(entry.name).startsWith('R9E '));
      if (check) { check.ok = false; check.error = `BLOCKED: ${reason}`; }
      receipt.blocked = receipt.rows.filter((entry) => entry.status === 'BLOCKED').length;
      receipt.passed = receipt.rows.filter((entry) => entry.status === 'PASS').length;
      receipt.failed = receipt.rows.filter((entry) => entry.status === 'FAIL').length;
      receipt.postExitVerification = { verdict: 'BLOCKED', reason, witness: orphanReportPath, verifiedAt: new Date().toISOString(), survivingPids: [] };
      try { fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8'); } catch {}
    }
    process.exit(2);
  }
  const lines = [
    `orphan verification at ${new Date().toISOString()}`,
    `receipt: ${receiptPath} (${receipt ? 'read' : 'MISSING'})`,
    `watcher report: ${orphanReportPath} (${report ? 'read' : 'MISSING'})`,
  ];
  if (!report) {
    const reason = 'the post-exit watcher produced no report, so no post-exit orphan observation exists';
    lines.push(`verdict: BLOCKED - ${reason}.`);
    fs.appendFileSync(orphanLogPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(lines.join('\n'));
    // The artifact must describe itself: leaving the receipt at PENDING would read as "never
    // attempted" instead of "attempted and unsettled".
    if (receipt) {
      const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
      const row = rows.find((entry) => entry.id === 'R9E');
      if (row) {
        row.status = 'BLOCKED';
        delete row.error;
        row.reason = reason;
      }
      const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
      const check = checks.find((entry) => String(entry.name).startsWith('R9E '));
      if (check) {
        check.ok = false;
        check.error = `BLOCKED: ${reason}`;
      }
      receipt.postExitVerification = { verdict: 'BLOCKED', reason, witness: orphanReportPath, verifiedAt: new Date().toISOString(), survivingPids: [] };
      receipt.notes = [
        ...(Array.isArray(receipt.notes) ? receipt.notes : []),
        `Post-exit orphan verdict attempted at ${new Date().toISOString()}: BLOCKED (${reason}).`,
      ];
      try {
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
      } catch (err) {
        console.log(`[matrix] failed to update the receipt: ${String(err && err.message ? err.message : err)}`);
        process.exit(1);
      }
    }
    process.exit(2);
  }
  const survivorPids = Array.isArray(report.survivingPids) ? report.survivingPids : [];
  const commandLineMatches = Array.isArray(report.commandLineMatches) ? report.commandLineMatches : [];
  // An observation that was never made decides nothing. The watcher reports `hostGone` only when
  // the OS said the process was absent; an unsupported platform or a window that closed while the
  // process was still there (or while the OS could not answer) leaves this row BLOCKED — "unknown",
  // which is not the same answer as "idle" and not the same as a failure either.
  const supported = report.supported !== false;
  const hostGone = report.hostGone === true;
  const survivorCheckRan = report.survivorCheckRan !== false;
  const observationAvailable = supported && hostGone && survivorCheckRan;
  const observationMissingReason = !supported
    ? `the post-exit process inventory is implemented for win32 only (this platform: ${String(report.platform ?? 'unknown')})`
    : hostGone
      ? 'the watcher reported an exit but did not run the survivor scan'
      : `the host process (pid ${String(report.hostPid ?? 'unknown')}) was still alive — or the OS could not be asked — when the watcher's window closed (hostState: ${String(report.hostState ?? 'unknown')}), so no post-exit observation exists yet`;
  const ok = observationAvailable && survivorPids.length === 0 && commandLineMatches.length === 0;
  lines.push(`watcher supported on this platform: ${String(supported)}`);
  lines.push(`host process gone: ${String(hostGone)} (hostState: ${String(report.hostState ?? 'unknown')}${report.timedOut === true ? ', timed out' : ''})`);
  lines.push(`survivor scan ran after the exit: ${String(survivorCheckRan)}`);
  lines.push(`recorded descendant processes still alive: ${JSON.stringify(survivorPids)}`);
  lines.push(`processes still matching this run's data root: ${JSON.stringify(commandLineMatches)}`);
  lines.push(!observationAvailable
    ? `verdict: BLOCKED - ${observationMissingReason}`
    : ok
      ? 'verdict: PASS - no owned process survived the GUI exit'
      : `verdict: FAIL - owned processes survived the GUI exit: pids=${JSON.stringify(survivorPids)} matches=${JSON.stringify(commandLineMatches)}`);
  fs.appendFileSync(orphanLogPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
  /** 0 = observed clean, 1 = observed survivors, 2 = no observation exists (BLOCKED). */
  const orphanExitCode = () => (observationAvailable ? (ok ? 0 : 1) : 2);

  if (!receipt) {
    console.log(`[matrix] no receipt to update at ${receiptPath}; the phase-1 run did not finish`);
    process.exit(orphanExitCode());
  }
  const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
  const row = rows.find((entry) => entry.id === 'R9E');
  if (row) {
    if (observationAvailable) {
      row.status = ok ? 'PASS' : 'FAIL';
      delete row.reason;
      delete row.error;
      if (!ok) row.error = `owned processes survived the GUI exit: pids=${JSON.stringify(survivorPids)} commandLine=${JSON.stringify(commandLineMatches)}`;
    } else {
      row.status = 'BLOCKED';
      delete row.error;
      row.reason = observationMissingReason;
    }
    row.observed = {
      ...(row.observed || {}),
      hostPid: report.hostPid,
      hostIdentityVerified: expectedHostPid !== null ? Number(report.hostPid) === Number(expectedHostPid) : null,
      watcherReportToken: report.dataRootToken ?? null,
      supported,
      hostState: report.hostState ?? null,
      hostGone,
      survivorCheckRan,
      survivingPids: survivorPids,
      commandLineMatches,
      watcherCheckedAt: report.checkedAt,
      watcherPollCount: report.pollCount,
      watcherWindowMs: report.windowMs ?? null,
      ancestorQueryUnanswered: report.ancestorQueryUnanswered ?? null,
    };
    row.ids = { ...(row.ids || {}), orphanPids: survivorPids };
  }
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const check = checks.find((entry) => String(entry.name).startsWith('R9E '));
  if (check) {
    check.ok = observationAvailable && ok;
    delete check.error;
    if (!observationAvailable) check.error = `BLOCKED: ${observationMissingReason}`;
    else if (!ok) check.error = `owned processes survived the GUI exit: ${JSON.stringify(survivorPids)}`;
  }
  const recount = () => ({
    passed: rows.filter((entry) => entry.status === 'PASS').length,
    failed: rows.filter((entry) => entry.status === 'FAIL').length,
    blocked: rows.filter((entry) => entry.status === 'BLOCKED').length,
  });
  const counted = recount();
  receipt.passed = counted.passed;
  receipt.failed = counted.failed;
  receipt.blocked = counted.blocked;
  receipt.postExitVerification = {
    verdict: observationAvailable ? (ok ? 'PASS' : 'FAIL') : 'BLOCKED',
    ...(observationAvailable ? {} : { reason: observationMissingReason }),
    witness: orphanReportPath,
    verifiedAt: new Date().toISOString(),
    survivingPids: survivorPids,
  };
  receipt.notes = [
    ...(Array.isArray(receipt.notes) ? receipt.notes : []),
    observationAvailable
      ? `Post-exit orphan verdict merged by a second process at ${new Date().toISOString()}: ${ok ? 'no owned process survived the GUI exit' : 'owned processes survived the GUI exit'}.`
      : `Post-exit orphan verdict merged by a second process at ${new Date().toISOString()}: BLOCKED (${observationMissingReason}); the row reports unknown, not a pass and not a failure.`,
  ];
  try {
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  } catch (err) {
    console.log(`[matrix] failed to update the receipt: ${String(err && err.message ? err.message : err)}`);
    process.exit(1);
  }
  console.log(`[matrix] receipt updated: passed=${counted.passed} failed=${counted.failed} blocked=${counted.blocked}`);
  process.exit(orphanExitCode());
}

// ===============================================================================================
// Phase 1: the live matrix.
// ===============================================================================================
const { app, BrowserWindow, webContents, screen } = require('electron');
const { WebSocket } = require('ws');
const { execFileSync: execSyncChild } = require('node:child_process');

app.commandLine.appendSwitch('no-sandbox');

// The isolated build (`tsc --outDir .tmp-pw-matrix`) is pointed at explicitly; the repository
// default stays `.compiled`, which is what `npm run compile` produces.
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));
const compiledShared = (relative) => path.join(compiledRoot, 'src', 'shared', relative.split('/').join(path.sep));

fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'project-windows-matrix.log');
fs.writeFileSync(logFile, '', 'utf8');
// Synchronous: the process exits straight after the summary, and a buffered stream would drop the
// evidence for the run that failed hardest.
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};

// ---------------------------------------------------------------------------------------------
// Throwaway world
// ---------------------------------------------------------------------------------------------
// A temp data root (config, control plane, runtime), a temp Chromium profile and temp workspace
// directories, all seeded before the main process is imported. Nothing here can read or write the
// developer's real profile, real data root, real capsules, or the live app's processes.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pw-matrix-'));
const dataRootToken = path.basename(tempRoot); // unique to this run; the orphan watcher matches it
const profileDir = path.join(tempRoot, 'Profile');
const dirOf = (name) => {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** A project window. ALPHA and DELTA deliberately share a display name: duplicate names are part
 *  of the acceptance scenario and must be disambiguated by the workspace-path label. */
const PROJECTS = {
  alpha: {
    projectId: 'project-00000000-0000-4000-8000-0000000000d1',
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d1',
    capsuleId: 'capsule-matrix-alpha',
    name: 'Matrix Storefront',
    path: dirOf('alpha'),
  },
  beta: {
    projectId: 'project-00000000-0000-4000-8000-0000000000d2',
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d2',
    capsuleId: 'capsule-matrix-beta',
    name: 'Matrix Beta',
    path: dirOf('beta'),
  },
  gamma: {
    projectId: 'project-00000000-0000-4000-8000-0000000000d3',
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d3',
    capsuleId: 'capsule-matrix-gamma',
    name: 'Matrix Gamma',
    path: dirOf('gamma'),
  },
  delta: {
    projectId: 'project-00000000-0000-4000-8000-0000000000d4',
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d4',
    capsuleId: 'capsule-matrix-delta',
    name: 'Matrix Storefront',
    path: dirOf('delta'),
  },
  epsilon: {
    projectId: 'project-00000000-0000-4000-8000-0000000000d5',
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000d5',
    capsuleId: 'capsule-matrix-epsilon',
    name: 'Matrix Epsilon',
    path: dirOf('epsilon'),
  },
};
const ALPHA = PROJECTS.alpha;
const BETA = PROJECTS.beta;
/** A project id no capsule and no registry record describes: the honest missing-authority case. */
const UNKNOWN_PROJECT_ID = 'project-00000000-0000-4000-8000-0000000000ff';

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = profileDir;
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
// The control plane reads the authoritative workspace root for the boot workspace from here; the
// boot project's capsule is exactly that root.
process.env.ANTIFAN_WORKSPACE_ROOT = ALPHA.path;
// Own bridge port: two probes must never fight over one bridge, and a stale listener from an
// earlier run must not be adopted.
const BRIDGE_PORT = 21000 + (process.pid % 500);
process.env.ANTIFAN_BRIDGE_PORT = String(BRIDGE_PORT);

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    version: 1,
    activeCapsuleId: ALPHA.capsuleId,
    capsules: Object.values(PROJECTS).map((entry) => ({
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

// A version-1 saved-tabs document, written before boot: the historic flat shape carries no
// verified affiliation, so its records must land in the Unassigned window — reachable, and never
// guessed onto a project window. This is the migration the persistence rows assert on.
// A dead port is deliberate — these pages are gone — but port 1 is on Chromium's restricted list,
// so the attempt dies as ERR_UNSAFE_PORT before it ever reaches the network. 64999 keeps the fixture
// meaning "page gone" (connection refused) instead of "port forbidden".
const LEGACY_TABS = [
  { id: 'legacy-tab-1', url: 'http://127.0.0.1:64999/legacy-one', title: 'Legacy One' },
  { id: 'legacy-tab-2', url: 'http://127.0.0.1:64999/legacy-two', title: 'Legacy Two' },
];
const savedTabsPath = path.join(profileDir, 'saved-tabs.json');
const windowStatePath = path.join(tempRoot, 'config', 'window-state.json');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(
  savedTabsPath,
  JSON.stringify({ version: 1, activeTabId: LEGACY_TABS[0].id, tabs: LEGACY_TABS }, null, 2),
  'utf8',
);
const readSavedTabsDocument = () => {
  try { return JSON.parse(fs.readFileSync(savedTabsPath, 'utf8')); } catch { return null; }
};

/** The renderer bundle a chrome-surface DOM row needs. An isolated `tsc` outDir has no
 *  `toolbar.html`/`toolbar.js` (they are copied by the real compile), and a DOM row that cannot
 *  see the DOM is BLOCKED, never passed. */
const rendererBundlePresent = fs.existsSync(path.join(compiledRoot, 'src', 'renderer', 'toolbar.js'))
  && fs.existsSync(path.join(compiledRoot, 'src', 'renderer', 'toolbar.html'));
/** The staged detached-terminal-host bundle. `ensureDaemon()` reports `in-process` without it, so
 *  the daemon-survival row is BLOCKED rather than pretended. */
const daemonEntryPresent = fs.existsSync(path.join(compiledRoot, 'src', 'main', 'terminal-daemon', 'daemon-entry.js'));

/**
 * The environment every plain-Node child of this process must run under.
 *
 * This harness runs INSIDE Electron (`scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs`),
 * so `process.execPath` is the Electron binary, not `node`. The launcher strips
 * `ELECTRON_RUN_AS_NODE` from the environment it hands the GUI process (a real GUI must boot), so a
 * child spawned with this executable would boot a second Electron app instead of running the script
 * it was given: the staging helper would not stage the daemon and the post-exit orphan watcher would
 * never observe anything. `ELECTRON_RUN_AS_NODE=1` is what makes that binary behave as the Node
 * runtime this process is already running on — the same thing `daemon-spawner.ts` does to start the
 * detached terminal host — so both children run their argv and nothing extra is launched.
 */
const NODE_CHILD_ENV = { ELECTRON_RUN_AS_NODE: '1' };
/** Where the parent publishes the latest direct-child inventory for the watcher to merge: the
 *  argv list is fixed at arm time, but children are learned later (or never, on an early exit). */
const watcherChildrenFile = path.join(tempRoot, 'config', 'matrix-children.json');

// The detached terminal host: staged into this run's own data root so the app attaches to a host
// that owns nothing of the developer's. Staging runs before main is imported (the boot calls
// `ensureDaemon()`), and the whole daemon is stopped by this harness before it exits.
const daemon = { staged: false, stagingError: null, beforeHandle: null };
if (daemonEntryPresent) {
  try {
    execSyncChild(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTIFAN_DATA_ROOT: tempRoot, ...NODE_CHILD_ENV },
    });
    daemon.staged = true;
  } catch (err) {
    daemon.stagingError = String((err && err.stderr ? String(err.stderr) : err && err.message) || err).trim().slice(0, 400);
  }
}

// ---------------------------------------------------------------------------------------------
// Owned-process teardown — the pattern scripts/probe-staged-host-rpc.cjs proved
// ---------------------------------------------------------------------------------------------
// The detached terminal host is built to outlive this process (it is spawned detached or escaped
// through WMI), so "the process exited" is not a cleanup mechanism: every exit path must kill the
// daemon pids this run observed. Sources of truth: handles returned by ensureDaemon, and the
// live record at <tempRoot>/daemon-host/daemon.json — the same file the spawner consults for
// re-attach — which also names a daemon boot spawned before run() could capture a handle.
const ownedDaemonPids = new Set();
const teardown = { exiting: false, watcherPid: 0 };

function alivePid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** taskkill /T /F on exactly one pid, retried then verified — the probe's killTree. Windows-only. */
function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return !alivePid(pid);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { execSyncChild('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    if (!alivePid(pid)) return true;
  }
  return !alivePid(pid);
}

/**
 * Windows releases directory handles asynchronously, so a single rmSync can fail while the daemon
 * or a renderer still holds a file inside tempRoot — and force:true makes that failure silent.
 * Bounded retries, verified by existence afterwards: same helper the staged-host probe uses.
 */
function removeDirWithRetry(dir) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return true;
    const end = Date.now() + 125;
    while (Date.now() < end) { /* bounded wait for Windows to release handles */ }
  }
  return !fs.existsSync(dir);
}

/** Record a daemon pid this run observed so it can never outlive the harness unnoticed. */
function noteDaemonPid(handle) {
  const pid = handle && Number(handle.pid);
  if (Number.isFinite(pid) && pid > 0) ownedDaemonPids.add(pid);
}

/** Every pid this run could own as a detached host: observed handles plus the spawner's record. */
function collectDaemonPids() {
  const pids = new Set(ownedDaemonPids);
  noteDaemonPid(daemon.beforeHandle);
  try {
    const record = JSON.parse(fs.readFileSync(path.join(tempRoot, 'daemon-host', 'daemon.json'), 'utf8'));
    noteDaemonPid(record);
  } catch { /* no live record: the daemon never published one */ }
  try {
    // The handshake names the pid before the live record exists — a host killed between the two
    // writes is still an owned process.
    const handshake = JSON.parse(fs.readFileSync(path.join(tempRoot, 'daemon-host', 'daemon-handshake.json'), 'utf8'));
    noteDaemonPid(handshake);
  } catch { /* no handshake either */ }
  for (const pid of ownedDaemonPids) pids.add(pid);
  return [...pids];
}

/**
 * Synchronous last resort: kill every daemon pid this run touched, then every direct OS child
 * (page/utility/GPU helpers this instance spawned). The post-exit orphan watcher is the one child
 * spared by construction — it is what proves nothing else survived. Safe to call twice.
 */
function sweepOwnedProcesses() {
  for (const pid of collectDaemonPids()) {
    if (!killTree(pid)) daemon.teardownSurvivor = pid;
  }
  const children = osChildPids();
  if (Array.isArray(children)) {
    for (const pid of children) {
      if (pid && pid !== teardown.watcherPid) killTree(pid);
    }
  }
}

/**
 * An exit path that is not the run's own end: Ctrl+C, an uncaught exception, or a rejection that
 * escaped its row. Arm the watcher when it can be armed (it is what makes the exit observable),
 * run the graceful cleanup bounded, and guarantee the sweep before exiting. A second SIGINT while
 * teardown is in flight exits immediately — the sweep below has already run or the process dies
 * with the sweep in 'exit'.
 */
async function emergencyExit(reason, err) {
  if (teardown.exiting) { process.exit(130); return; }
  teardown.exiting = true;
  const text = String(err && err.message ? err.message : err);
  try { console.log(`\n[matrix] ${reason}: ${text} — cleaning up and exiting`); } catch {}
  try { currentRowId = `aborted:${reason}`; } catch {}
  recordEnding(`emergency:${reason}`, 130);
  ensureWatcherArmed();
  try { await bounded(cleanup(), 30000, 'emergency cleanup'); } catch {}
  sweepOwnedProcesses();
  try { writeReport(); } catch {}
  try { removeDirWithRetry(tempRoot); } catch {}
  process.exit(130);
}

// These run inside the Electron main process: the handlers must be installed before the shipping
// main module is imported so a throw or a Ctrl+C during boot cannot strand the staged daemon.
process.on('SIGINT', () => { emergencyExit('SIGINT', 'interrupted'); });
process.on('SIGTERM', () => { emergencyExit('SIGTERM', 'terminated'); });
process.on('uncaughtException', (err) => { emergencyExit('uncaughtException', err); });
process.on('unhandledRejection', (err) => { emergencyExit('unhandledRejection', err); });
// 'exit' runs synchronous code only — the last chance to honour "no owned process survives".
process.on('exit', (code) => {
  recordEnding('process.exit', code);
  try { writeReport(); } catch {}
  try { sweepOwnedProcesses(); } catch {}
  try { removeDirWithRetry(tempRoot); } catch {}
});

/**
 * The watcher is armed lazily and exactly once: on the first path that can reach it — the start of
 * the matrix run, a quit path, or the normal .finally. Arming early is what keeps a spontaneous
 * app quit (a second will-quit is not preventable) or a mid-run throw from leaving the post-exit
 * half of R9E unobserved.
 */
function ensureWatcherArmed() {
  try {
    if (!state.watcher) armOrphanWatcher();
  } catch {}
}

/** Publish the freshest direct-child inventory where the watcher merges it after the host dies. */
function recordChildrenForWatcher() {
  try {
    const children = osChildPids();
    if (Array.isArray(children)) fs.writeFileSync(watcherChildrenFile, JSON.stringify(children), 'utf8');
  } catch {}
}

// A spontaneous Electron quit (the shipping teardown, or a close path that bypasses the held
// will-quit) never reaches .finally — arm the watcher, leave a receipt, and run the sweep here.
app.on('will-quit', () => { ensureWatcherArmed(); });
app.on('window-all-closed', () => { ensureWatcherArmed(); });
app.on('quit', () => {
  recordEnding('app.quit', null);
  ensureWatcherArmed();
  recordChildrenForWatcher();
  try { writeReport(); } catch {}
  try { sweepOwnedProcesses(); } catch {}
});

// Boot the shipping main process inside this same Electron instance. Its boot guards run at
// import — `protocol.registerSchemesAsPrivileged` refuses to run after `app.whenReady()`, and the
// deadline chain is asserted before any window exists — so the throwaway environment above must
// already be seeded.
const mainProcess = require(compiledModule('index.js'));
const { makeControlPlaneId, issueRuntimeLease } = require(compiledShared('control-plane-contracts.js'));
const { getLifecycleLogPath } = require(compiledModule('diagnostics/main-lifecycle-log.js'));
const { ensureDaemon } = require(compiledModule('terminal-daemon/daemon-spawner.js'));
const { DaemonTerminalProxy } = require(compiledModule('terminal-daemon/daemon-client.js'));
const lifecycleLogPath = (() => {
  try { return getLifecycleLogPath(); } catch { return null; }
})();

// ---------------------------------------------------------------------------------------------
// Row registry — the whole phase-5 matrix, declared before anything runs
// ---------------------------------------------------------------------------------------------
// kind: 'automated' (judged by a live judge) | 'hardware' (needs physical hardware or a human and
// is emitted BLOCKED with its reason; never simulated with a fixture) | 'post-exit' (decided by
// the second process after this one is gone).
const ROW_PLAN = [
  ['R0', 'Acceptance scenario', 'Five project windows present at least twenty user-visible tabs; every tab resolves to the host of its own window; duplicate project names are separated by their workspace-path labels', 'automated'],
  ['R1', '1', 'Two project windows are simultaneously open and visible with distinct window ids, owner keys and tab sets, and each occupies its own display when two exist; re-opening A through the user Open Project channel focuses the same window and creates no second one', 'automated'],
  ['R1-HW', '1', 'A and B are simultaneously legible and independently interactive on two separate physical monitors, observed by a person', 'hardware'],
  ['R2', '2', 'While typing in A, an agent bound to B creates and navigates a B tab: A\'s typed value, active tab and terminal workspace binding are unchanged, B\'s visible active tab does not move, and the attachment\'s authority revision does not rotate', 'automated'],
  ['R2-HW', '2', 'Real OS foreground focus and keyboard stability: a human types into A while a background window navigates, under the platform\'s own foreground lockout rules', 'hardware'],
  ['R2b', '2', 'Each window\'s terminal is its own: input typed through A\'s own sidebar reaches A\'s session and never B\'s, stays with A after B is observed to own the process-wide active session, an explicit write naming B\'s session from A is refused, and neither A\'s session list nor its diagnostics name B\'s session', 'automated'],
  ['R2c', '2', 'A terminal minted through a window\'s own sidebar with no cwd given lands in that window\'s verified workspace, capsule and owner key \u2014 the second A mint comes after another window has minted, each session is read back from the window that asked for it, and neither window\'s session list names the other\'s mint', 'automated'],
  ['R3a', '3', 'The authorized target survives window activation, minimize and restore: the attachment revision is unchanged, a dispatch still navigates B\'s bound tab, and a foreign target stays refused', 'automated'],
  ['R3b', '3', 'Cross-window and same-window target mismatches are refused with a code, with no substitute navigation, no tab-list change and no focus change', 'automated'],
  ['R3c', '3', 'Two authenticated sessions inside one project cannot cross-invoke each other\'s tabs, while each still works on its own', 'automated'],
  ['R4a', '4', 'A user tab created through the boot window\'s own toolbar resolves to that window\'s host and is persisted under that window\'s owner record', 'automated'],
  ['R4a2', '4', 'A user tab created through a second project window\'s toolbar resolves to that window\'s host and is persisted under that window\'s owner record, never another window\'s', 'automated'],
  ['R4b', '4', 'A native window.open child inherits its opener\'s window affiliation before it is presented', 'automated'],
  ['R4c', '4', 'An agent-routed child created for B is owned by B\'s host and is presented by B', 'automated'],
  ['R4d', '4', 'Tabs restored after a close/reopen return to their own window with their own affiliation; no project window claims another\'s page', 'automated'],
  ['R4e', '4', 'Missing authority refuses: the user channel refuses an unknown project id without allocating a window', 'automated'],
  ['R4f', '4', 'Conflicting authority fails: a session authenticated for A cannot create a routed child on B\'s anchor page', 'automated'],
  ['R4g', '4', 'Unresolved historical tabs are reachable in the Unassigned window, and no project window guesses their ownership', 'automated'],
  ['R5a', '5', 'Desktop/mobile split review in A changes only A\'s own panes: B\'s native tab-view rect, window bounds, active tab and split state are identical before and after', 'automated'],
  ['R5b', '5', 'Background screenshot capture of B works while A is the foreground window; the capture envelope reports a real viewport and raster, and B is not raised or activated by it', 'automated'],
  ['R6a', '6', 'Per-project normal bounds survive a close and reopen of the same project, as recorded in the owner-keyed window-state file', 'automated'],
  ['R6-HW', '6', 'Unplugging a physical monitor and changing the OS display scale leave every window recoverable on an available display', 'hardware'],
  ['R7', '7', 'Closing idle A leaves B alive with its tabs, its active tab, its bound attachment, its terminal session, shared services and its own auxiliary windows intact', 'automated'],
  ['R8a', '8', 'A page that vetoes its unload retains the shell with an honest partial report, names the surviving page and promises no undo', 'automated'],
  ['R8b', '8', 'A new tab arriving during a close attempt survives, and the shell is retained', 'automated'],
  ['R8c', '8', 'A close attempt reserves its own pages synchronously, and a binding attempted while a page is reserved is refused (TARGET_STALE) rather than bound and then destroyed', 'automated'],
  ['R9a', '9', 'An explicit Quit with real shared work queued is refused: nothing commits, no shell closes, services keep answering and admission is released', 'automated'],
  ['R9b', '9', 'With no active work, the last browser shell closing drives the same gate to a committed, orderly quit: ordered teardown, no force exit, no surviving native window or auxiliary surface', 'automated'],
  ['R9c', '9', 'Detached terminal host survival: after the shipping teardown the daemon identity is unchanged, the session created before the teardown still exists and an existing PTY still runs a command; then this harness stops the host it started', 'automated'],
  ['R9d', '9', 'After the committed teardown the process holds no page/renderer processes and no native windows for this instance', 'automated'],
  ['R9E', '9', 'After this process exits, no process the harness started (browser, renderer, utility, daemon) survives it', 'post-exit'],
  ['R10a', '10', 'A page whose agent session ends keeps its user-visible tab and typed input state; a stale target refuses instead of being routed to another project\'s page', 'automated'],
  ['R10b', '10', 'A real bridge transport client that drops mid-session (abrupt socket close) leaves the window, its tabs, the tab\'s resolution and the in-page form value intact, and a fresh connection still works', 'automated'],
  ['R11', '11', 'Opening separate windows manufactures no cookie isolation: A\'s tabs keep the same partition names and the same live Session objects, and each window\'s partitions are recorded', 'automated'],
  ['R12a', '12', 'At 960x640 DIP the chrome is laid out inside the window, the native tab view starts exactly at the toolbar\'s bottom edge and never inside it, every control is reachable, and the search control\'s keyboard contract works', 'automated'],
  ['R12b', '12', 'At the maximized size the chrome stays laid out inside the window, the native tab view stays inside the content area, and the window sits inside its display\'s usable work area', 'automated'],
  ['S1', 'Search supplement', 'Every window lists the same cross-project inventory, including foreign and Unassigned rows with Main labels, and literal case-insensitive title/URL matching filters it', 'automated'],
  ['S2', 'Search supplement', 'Explicit activation of a foreign result focuses that tab\'s owner window and selects exactly that tab, without changing the invoking window\'s active tab or rotating attachment authority', 'automated'],
  ['S3', 'Search supplement', 'A stale search result reports unavailable with no substitute tab and no focus change', 'automated'],
];
const ROW_BY_ID = new Map(ROW_PLAN.map(([id, criterion, observable, kind]) => [id, { id, criterion, observable, kind }]));

const rowResults = new Map();
let currentRowId = 'boot';

/**
 * The budget one row may consume. Rows bound their own inner operations, but a wedged native call
 * inside a row (a page Chromium left in a pending-close state accepts an eval and never answers it)
 * must not be able to hold the whole run hostage. A row that exhausts its budget is recorded FAIL,
 * and the run then STOPS: a bounded race cannot cancel the judge, so continuing would let an
 * abandoned judge drive windows while later rows observe them. The driver's `finally` still runs
 * the teardown and writes the receipt, with every unjudged row emitted BLOCKED.
 */
const ROW_BUDGET_MS = 180000;

async function automated(id, judge, budgetMs = ROW_BUDGET_MS) {
  const plan = ROW_BY_ID.get(id);
  if (!plan) throw new Error(`undeclared matrix row '${id}'`);
  const row = { id, criterion: plan.criterion, observable: plan.observable, status: 'PENDING', observed: {}, ids: {} };
  currentRowId = id;
  console.log(`\n== row ${id} (criterion ${plan.criterion})`);
  let budgetExpired = false;
  let budgetTimer;
  const budget = new Promise((_, reject) => {
    budgetTimer = setTimeout(() => {
      budgetExpired = true;
      reject(new Error(`row ${id} exhausted its ${budgetMs}ms budget`));
    }, budgetMs);
  });
  try {
    await Promise.race([judge(row), budget]);
    if (row.status === 'PENDING') {
      // A row is decided by the values it observed, so a judge that recorded nothing has not
      // judged anything: an empty observation is a harness defect, never a pass.
      expect(Object.keys(row.observed || {}).length > 0, `row ${id} recorded no observation, so it cannot be reported as a pass`);
      row.status = 'PASS';
    }
  } catch (err) {
    row.status = 'FAIL';
    row.error = messageOf(err);
  } finally {
    clearTimeout(budgetTimer);
  }
  // A judge that outlived its budget keeps running and keeps driving windows. Freeze what it
  // reported so far, so its later mutations cannot appear in the receipt as this row's evidence.
  const recorded = budgetExpired ? { ...row, observed: { ...row.observed }, ids: { ...row.ids } } : row;
  rowResults.set(id, recorded);
  const detail = recorded.status === 'PASS' ? '' : `: ${recorded.error || recorded.reason}`;
  console.log(`  ${recorded.status.padEnd(7)} ${id}${detail}`);
  if (budgetExpired) {
    // Fail-stop, by design: the rows behind this one would read windows an abandoned judge is
    // still driving. The driver's `finally` writes the receipt with every unjudged row BLOCKED.
    throw new Error(`row ${id} exhausted its ${budgetMs}ms budget while its judge was still running — a real hang is a finding, so the run stops here rather than observing later rows through it`);
  }
  return recorded;
}

/** A row whose subject this environment cannot produce. Never a pass, never a fixture. */
function blocked(id, reason, observed = {}, ids = {}) {
  const plan = ROW_BY_ID.get(id);
  if (!plan) throw new Error(`undeclared matrix row '${id}'`);
  const row = { id, criterion: plan.criterion, observable: plan.observable, status: 'BLOCKED', reason, observed, ids };
  rowResults.set(id, row);
  console.log(`  BLOCKED ${id}: ${reason}`);
  return row;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const messageOf = (err) => String(err && err.message ? err.message : err);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bound one operation. A real Electron unload veto or a wedged close can leave a native call with
 * no terminal outcome, and an unbounded harness would sit there instead of reporting it: a hung
 * operation is a finding, so it fails the row that produced it and lets the run end.
 */
async function bounded(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no outcome within ${ms}ms (the operation is still running)`)), ms);
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
    // A predicate that never settles must not be able to hold this deadline hostage: a wedged
    // renderer answers an `executeJavaScript` never, and an unbounded `await predicate()` would then
    // block the whole run with no verdict and no receipt. Each poll is bounded, and a hung poll is
    // recorded as the last observation instead of being mistaken for a satisfied predicate.
    let observed;
    try {
      const attempt = Promise.resolve().then(() => predicate());
      // The bound may lose the race; a rejection arriving later is not this call's subject.
      attempt.catch(() => {});
      observed = await bounded(attempt, Math.max(1, Math.min(15000, deadline - Date.now())), `waitFor predicate (${description})`);
      last = observed;
    } catch (err) {
      last = messageOf(err);
    }
    if (observed) return observed;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (last observed: ${JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------------------------
// Shared helpers over the shipping surface
// ---------------------------------------------------------------------------------------------
const authority = () => mainProcess.projectWindowAuthority;
const planeOf = () => authority().controlPlane();
const snapshot = () => authority().snapshot();
const entryFor = (ownerKeyValue) => snapshot().find((entry) => entry.ownerKey === ownerKeyValue) || null;
/**
 * A window's directory entry, refusing when the window is not in the directory at all.
 *
 * "X is unchanged" must not be provable from two absences: comparing `undefined` against
 * `undefined` agrees with itself and would report a window's state as preserved while the window
 * it names is not even there. The refused lookup turns that into a failure that names the window.
 */
function requireEntry(ownerKeyValue) {
  const entry = entryFor(ownerKeyValue);
  expect(entry, `window '${ownerKeyValue}' is not in the window directory, so its state cannot be compared: ${JSON.stringify(snapshot().map((item) => item.ownerKey))}`);
  return entry;
}
/** A window's active tab id, refused rather than reported as absent when the window is missing. */
function requireActiveTab(ownerKeyValue) {
  const entry = requireEntry(ownerKeyValue);
  expect(typeof entry.activeTabId === 'string' && entry.activeTabId.length > 0, `window '${ownerKeyValue}' reports no active tab: ${JSON.stringify(entry.activeTabId)}`);
  return entry.activeTabId;
}
/** A native window's rectangle, refusing to treat two absent measurements as "unchanged". */
function requireWindowBounds(ownerKeyValue) {
  const window = authority().windowFor(ownerKeyValue);
  expect(window && !window.isDestroyed(), `there is no live native window for '${ownerKeyValue}', so its bounds cannot be compared`);
  const bounds = window.getBounds();
  expect(Number.isFinite(bounds.width) && bounds.width > 0 && Number.isFinite(bounds.height) && bounds.height > 0, `window '${ownerKeyValue}' reports no measurable bounds: ${JSON.stringify(bounds)}`);
  return { ...bounds };
}
const surfaceOf = (shell, surface) => (surface === 'sidebar' ? shell?.sidebarView : shell?.toolbarView)?.webContents ?? null;

/** The live toolbar webContents of a window, waited until its preload API answers. */
async function toolbarFor(ownerKeyValue) {
  const shell = authority().shellFor(ownerKeyValue);
  expect(shell, `no live shell for '${ownerKeyValue}'`);
  const toolbar = surfaceOf(shell, 'toolbar');
  expect(toolbar && !toolbar.isDestroyed(), `'${ownerKeyValue}' has no live toolbar surface`);
  await waitFor(
    async () => {
      if (toolbar.isDestroyed()) return false;
      try { return (await toolbar.executeJavaScript("typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'", true)) === true; } catch { return false; }
    },
    `the toolbar API in '${ownerKeyValue}'`,
  );
  return toolbar;
}
/** The live sidebar webContents of a window, waited until its preload API answers. */
async function sidebarFor(ownerKeyValue) {
  const shell = authority().shellFor(ownerKeyValue);
  expect(shell, `no live shell for '${ownerKeyValue}'`);
  const sidebar = surfaceOf(shell, 'sidebar');
  expect(sidebar && !sidebar.isDestroyed(), `'${ownerKeyValue}' has no live sidebar surface`);
  await waitFor(
    async () => {
      if (sidebar.isDestroyed()) return false;
      try { return (await sidebar.executeJavaScript("typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'", true)) === true; } catch { return false; }
    },
    `the sidebar API in '${ownerKeyValue}'`,
  );
  return sidebar;
}

const foregroundId = () => {
  const window = BrowserWindow.getFocusedWindow();
  return window && !window.isDestroyed() ? window.id : null;
};
const foregroundOwnerKey = () => {
  const id = foregroundId();
  if (id === null) return null;
  const match = snapshot().find((entry) => entry.windowId === id);
  return match ? match.ownerKey : `window-${id}`;
};
/** The page inside a tab, which is where input, vetoes and form state live. */
const pageOf = (tabId, paneId = 'desktop') => authority().hostForTab(tabId)?.getTabWebContents(tabId, paneId) ?? null;
const jsonSafe = (value) => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
};
/** The attachment's authority revision, the fact a rebind/focus change must not rotate. */
function attachmentState(attachmentId) {
  if (!attachmentId) return null;
  const record = planeOf()?.runs?.attachments?.getRecord(attachmentId);
  if (!record) return { attachmentId, present: false };
  return {
    attachmentId,
    present: true,
    authorityRevision: record.authorityRevision,
    revisionNumber: record.revisionNumber,
    tabId: record.tabId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    state: record.state,
  };
}
/** Concrete ids for one row: windows, owners, tabs, projects, and the foreground at both ends. */
function windowIdsOf(keys) {
  const current = snapshot();
  return keys.filter(Boolean).map((key) => {
    const entry = current.find((candidate) => candidate.ownerKey === key);
    if (!entry) return { ownerKey: key, present: false };
    return {
      ownerKey: entry.ownerKey,
      windowId: entry.windowId,
      projectId: entry.owner.kind === 'project' ? entry.owner.projectId : 'unassigned',
      tabIds: [...entry.tabIds],
      activeTabId: entry.activeTabId,
      visible: entry.visible,
      focused: entry.focused,
    };
  });
}
/** One tab as its own host reports it, plus the host that owns it right now. */
function tabRecord(tabId) {
  const host = authority().hostForTab(tabId);
  if (!host) return null;
  const record = host.getTabList().find((tab) => tab.id === tabId) ?? null;
  if (!record) return null;
  return {
    tabId: record.id,
    url: record.url,
    title: record.title,
    capsuleId: record.capsuleId ?? null,
    partition: record.partition ?? null,
    devicePresetId: record.devicePresetId ?? null,
    splitMode: Boolean(record.splitMode),
    splitDesktopPresetId: record.splitDesktopPresetId ?? null,
    splitMobilePresetId: record.splitMobilePresetId ?? null,
    splitFocusedPane: record.splitFocusedPane ?? null,
    offscreen: Boolean(record.offscreen),
    ephemeral: Boolean(record.ephemeral),
    windowOwnerKey: host.windowOwnerKey(),
  };
}
/** One native surface rectangle, read from the window's own view tree. */
function viewRects(window) {
  const rects = [];
  try {
    for (const child of window.contentView.children) {
      const bounds = typeof child.getBounds === 'function' ? child.getBounds() : null;
      const contentsId = child.webContents && !child.webContents.isDestroyed() ? child.webContents.id : null;
      if (!bounds) continue;
      rects.push({ contentsId, bounds: { ...bounds }, type: child.constructor ? child.constructor.name : 'view' });
    }
  } catch (err) {
    return { error: messageOf(err), rects: [] };
  }
  return { rects };
}
/** The native rectangle of one page, found by its webContents id (real browser geometry). */
function pageRect(window, contentsId) {
  const { rects } = viewRects(window);
  const match = rects.find((entry) => entry.contentsId === contentsId);
  return match ? match.bounds : null;
}
/** Every live terminal window, found the way the shipping quit gate finds them. */
function auxiliaryWindows() {
  const found = [];
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    for (const host of snapshot().map((entry) => authority().hostForOwner(entry.ownerKey)).filter(Boolean)) {
      let surface;
      try { surface = host.surfaceForWebContents(contents.id); } catch { surface = undefined; }
      if (surface === 'terminalPopout') {
        const window = BrowserWindow.fromWebContents(contents);
        if (window && !window.isDestroyed() && !found.some((entry) => entry.windowId === window.id)) {
          found.push({ windowId: window.id, contentsId: contents.id, ownerKey: host.windowOwnerKey() });
        }
      }
    }
  }
  return found;
}
const displayFacts = () => screen.getAllDisplays().map((display) => ({
  id: display.id,
  scaleFactor: display.scaleFactor,
  bounds: { ...display.bounds },
  workArea: { ...display.workArea },
}));
/** The journal the shipping process writes, read from disk (every line is appended synchronously). */
function journalEvents() {
  try {
    if (!lifecycleLogPath) return [];
    return fs.readFileSync(lifecycleLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line); } catch { return { event: 'unparsable' }; }
      });
  } catch {
    return [];
  }
}
/** The persisted state of one window, as the shipping writer keys it. */
function windowStateRecord(ownerKeyValue) {
  try {
    const document = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    return document && document.windows ? document.windows[ownerKeyValue] ?? null : null;
  } catch {
    return null;
  }
}
/** The owner record a window's tabs are persisted under, from the version-2 document. */
function savedOwnerRecord(ownerKeyValue) {
  const document = readSavedTabsDocument();
  if (!document || !document.owners) return null;
  return document.owners[ownerKeyValue] ?? null;
}
/** The tab ids a window's own owner record carries. */
function savedTabIds(ownerKeyValue) {
  const record = savedOwnerRecord(ownerKeyValue);
  if (!record || !Array.isArray(record.tabs)) return [];
  return record.tabs.map((tab) => (tab && typeof tab === 'object' ? tab.id : null)).filter((id) => typeof id === 'string');
}
/** Everything a process inventory can say while the browser is still held open. */
function processInventory() {
  let metrics = [];
  try {
    metrics = app.getAppMetrics().map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      workingSetKb: entry.memory ? entry.memory.workingSetSize : null,
      cpuPercent: entry.cpu ? entry.cpu.percentCPUUsage : null,
    }));
  } catch (err) {
    return { error: messageOf(err) };
  }
  const counts = {};
  for (const metric of metrics) counts[metric.type] = (counts[metric.type] ?? 0) + 1;
  return {
    counts,
    types: Object.keys(counts),
    metrics,
    webContents: webContents.getAllWebContents().length,
    nativeWindows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
  };
}
/** Direct children of this process, from the OS. Windows-only; null elsewhere. */
function osChildPids() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSyncChild('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((value) => Number.isFinite(value) && value > 0);
  } catch (err) {
    return { error: messageOf(err) };
  }
}

// ---- driving a surface ----------------------------------------------------------------------
async function openProject(sidebar, projectId) {
  return await bounded(
    sidebar.executeJavaScript(`window.antifanStandalone.openProject(${JSON.stringify(projectId)})`, true),
    20000,
    'sidebar openProject',
  );
}
/**
 * Open a project window an earlier row closed, invoked from a window that is still live — the only
 * affordance a user has once that window is shut. Its restored tabs are awaited, because a reopened
 * window is what the rows that follow describe.
 */
async function ensureOwnerWindow(ownerKeyValue, project, viaOwnerKey) {
  const live = authority().shellFor(ownerKeyValue);
  if (live) return live;
  const sidebar = await sidebarFor(viaOwnerKey);
  const opened = await openProject(sidebar, project.projectId);
  expect(opened && (opened.status === 'OPENED' || opened.status === 'FOCUSED'), `reopening '${ownerKeyValue}' returned ${JSON.stringify(opened)}`);
  const shell = await waitFor(() => authority().shellFor(ownerKeyValue), `'${ownerKeyValue}' to come back`, 20000);
  await waitFor(() => (entryFor(ownerKeyValue)?.tabIds ?? []).length > 0, `'${ownerKeyValue}' to restore a tab`, 20000).catch(() => null);
  return shell;
}
async function createTabViaToolbar(toolbar, url = 'about:blank') {
  return await bounded(
    toolbar.executeJavaScript(`window.antifanToolbar.createTab(${JSON.stringify(url)})`, true),
    20000,
    'toolbar createTab',
  );
}
async function searchFrom(toolbar, query) {
  return await bounded(
    toolbar.executeJavaScript(`window.antifanToolbar.searchProjectTabs(${JSON.stringify(query)})`, true),
    20000,
    'toolbar searchProjectTabs',
  );
}
async function activateFrom(toolbar, tabId) {
  return await bounded(
    toolbar.executeJavaScript(`window.antifanToolbar.activateProjectTab(${JSON.stringify(tabId)})`, true),
    20000,
    'toolbar activateProjectTab',
  );
}
/** Real key input into a renderer: char events, exactly what a typing user produces. */
function typeText(target, text) {
  for (const ch of text) {
    target.sendInputEvent({ type: 'char', keyCode: ch });
  }
}
function pressKey(target, keyCode) {
  target.sendInputEvent({ type: 'keyDown', keyCode });
  target.sendInputEvent({ type: 'keyUp', keyCode });
}
/** A real pointer click at an element's centre: the gesture Chromium requires for window.open. */
async function clickElement(target, selector) {
  const rect = await target.executeJavaScript(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       try { el.scrollIntoView({ block: 'center' }); } catch {}
       const r = el.getBoundingClientRect();
       if (!r || r.width < 1 || r.height < 1) return null;
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
     })()`,
    true,
  );
  if (!rect) throw new Error(`no clickable element '${selector}'`);
  target.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  target.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  target.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return rect;
}
/**
 * The chrome's own layout, measured in the toolbar renderer: every control's rectangle, the tab
 * strip's box, the search overlay and its rows. This is what a user at 960x640 can reach.
 */
const CHROME_LAYOUT_EXPRESSION = `(() => {
  const read = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), display: style.display, visibility: style.visibility, overflow: style.overflow };
  };
  const byId = (id) => read(document.getElementById(id));
  const ids = ['projectChip', 'projectChipTitle', 'projectChipPath', 'tabStrip', 'btnTabSearch', 'btnNewTab', 'urlInput', 'btnToggleSplit'];
  const rects = {};
  for (const id of ids) rects[id] = byId(id);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const laidOut = Object.entries(rects).filter(([, rect]) => rect && rect.width > 0 && rect.height > 0);
  const clippedHorizontally = laidOut.filter(([, rect]) => rect.x < -1 || rect.right > viewport.width + 1).map(([id, rect]) => ({ id, rect }));
  const clippedVertically = laidOut.filter(([, rect]) => rect.y < -1 || rect.bottom > viewport.height + 1).map(([id, rect]) => ({ id, rect }));
  const tabStrip = rects.tabStrip;
  // Genuine collisions only: the chrome's controls legitimately live inside shared containers
  // (the strip holds the chip, the tab list and the search control), so an ancestor/descendant
  // pair is structure, not a collision. Two unrelated controls whose boxes intersect is a
  // layout defect a user would see.
  const collisions = [];
  for (let a = 0; a < laidOut.length; a += 1) {
    for (let b = a + 1; b < laidOut.length; b += 1) {
      const [idA, rectA] = laidOut[a];
      const [idB, rectB] = laidOut[b];
      const elA = document.getElementById(idA);
      const elB = document.getElementById(idB);
      if (!elA || !elB || elA.contains(elB) || elB.contains(elA)) continue;
      if (rectA.x < rectB.right && rectA.right > rectB.x && rectA.y < rectB.bottom && rectA.bottom > rectB.y) {
        collisions.push([idA, idB]);
      }
    }
  }
  const overlay = read(document.getElementById('tabSearchOverlay'));
  const overlayPanel = read(document.querySelector('#tabSearchOverlay .tab-search-modal'));
  const rows = Array.from(document.querySelectorAll('#tabSearchResults .tab-search-row')).map(read);
  return {
    viewport,
    rects,
    tabStrip,
    laidOutCount: laidOut.length,
    clippedHorizontally,
    clippedVertically,
    collisions,
    overlay,
    overlayPanel,
    overlayRows: rows,
    rowsOutsideOverlay: overlay ? rows.filter((r) => r && (r.right > overlay.right + 1 || r.x < overlay.x - 1)).length : null,
    chipTitle: document.getElementById('projectChipTitle') ? document.getElementById('projectChipTitle').textContent || '' : null,
    chipPath: document.getElementById('projectChipPath') ? document.getElementById('projectChipPath').textContent || '' : null,
    activeElementId: document.activeElement && document.activeElement.id ? document.activeElement.id : null,
    tabSearchDisplay: overlay ? overlay.display : null,
    // The inline value is what the page's own open/close write; the computed one is what the user
    // sees. When they disagree the stylesheet is overriding, and when both stay 'flex' the close
    // path never ran at all — two different findings this probe must not merge.
    tabSearchInlineDisplay: (() => { const el = document.getElementById('tabSearchOverlay'); return el ? el.style.display || '' : null; })(),
    tabSearchState: (() => { const el = document.getElementById('tabSearchResults'); return el ? el.getAttribute('data-state') : null; })(),
    tabSearchActiveDescendant: (() => { const el = document.getElementById('tabSearchInput'); return el ? el.getAttribute('aria-activedescendant') : null; })(),
    tabSearchStatus: (() => { const el = document.getElementById('tabSearchStatus'); return el ? el.textContent || '' : null; })(),
    tabSearchRowCount: rows.length,
  };
})()`;
const chromeLayout = (toolbar) => toolbar.executeJavaScript(CHROME_LAYOUT_EXPRESSION, true);

/** The native geometry of one window: content box, chrome rect, and the tab's own rect. */
function nativeLayout(ownerKeyValue, tabId, paneId = 'desktop') {
  const window = authority().windowFor(ownerKeyValue);
  expect(window && !window.isDestroyed(), `no live native window for '${ownerKeyValue}'`);
  const shell = authority().shellFor(ownerKeyValue);
  const host = authority().hostForOwner(ownerKeyValue);
  const toolbarHeight = host ? host.getToolbarHeight() : null;
  const geometry = shell ? shell.getContentGeometry(toolbarHeight ?? 0) : undefined;
  const contentBounds = window.getContentBounds();
  const page = tabId ? pageOf(tabId, paneId) : null;
  return {
    windowId: window.id,
    contentBounds: { ...contentBounds },
    geometry: geometry ? { ...geometry } : null,
    toolbarHeight,
    toolbarRect: surfaceOf(shell, 'toolbar') ? shell.toolbarView.getBounds() : null,
    sidebarRect: shell && shell.sidebarView ? shell.sidebarView.getBounds() : null,
    sidebarOpen: shell ? shell.isSidebarOpen : null,
    pageRect: page && !page.isDestroyed() ? pageRect(window, page.id) : null,
    viewRects: viewRects(window),
  };
}

// ---- the local http origin the pages are served from -----------------------------------------
// A real http(s) origin is required: the shipping `browser.navigate` capability refuses anything
// else, and a page that can be clicked is what the popup and input-state rows need.
let server = null;
let serverPort = 0;
const baseUrl = (suffix) => `http://127.0.0.1:${serverPort}${suffix}`;
function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}
async function startServer() {
  server = http.createServer((req, res) => {
    const url = req.url || '/';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.startsWith('/popup')) {
      res.end(htmlPage('Matrix Popup Opener', '<h1>Popup opener</h1><button id="popupBtn" onclick="window.open(\'/child\', \'_blank\')">Open child</button>'));
      return;
    }
    if (url.startsWith('/child')) {
      res.end(htmlPage('Matrix Child Page', '<h1>Child</h1>'));
      return;
    }
    if (url.startsWith('/agent-child')) {
      res.end(htmlPage('Matrix Agent Child Page', '<h1>Agent child</h1>'));
      return;
    }
    if (url.startsWith('/alpha')) {
      res.end(htmlPage('Matrix Alpha Page', '<h1>Alpha</h1><input id="field" /><button id="popupBtn" onclick="window.open(\'/child\', \'_blank\')">Open child</button>'));
      return;
    }
    res.end(htmlPage('Matrix Beta Page', '<h1>Beta</h1><input id="field" /><button id="popupBtn" onclick="window.open(\'/child\', \'_blank\')">Open child</button>'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  serverPort = server.address().port;
}
function stopServer() {
  if (!server) return;
  try { server.close(); } catch {}
  server = null;
}

// ---- minting authority the shipping way ------------------------------------------------------
// A real attachment in the shipping registry: the same mint path the control plane's own
// entrypoints use, so a routed creation below is authorized exactly like a bridge/MCP client's.
//
// The lease must carry the RUNNING runtime's own id. `issueRuntimeLease` mints a fresh runtime id,
// and the capability catalogue refuses any request whose lease names another runtime with
// RUNTIME_MISMATCH — the correct answer for a client replaying a foreign lease, and a harness bug
// when the harness is the one minting it. The shipping attachment paths stamp
// `lease.runtimeId = this.leaseState.runtimeId` for exactly this reason.
function leaseForRunningRuntime(project, ttlMs) {
  const plane = planeOf();
  expect(plane, 'the harness booted without a control plane');
  const lease = issueRuntimeLease(project.projectId, project.workspaceId, ttlMs, plane.getLease().hostEpoch);
  return { ...lease, runtimeId: plane.getLease().runtimeId };
}

async function mintAttachment({ project, tabId, grant = 'write' }) {
  const plane = planeOf();
  expect(plane, 'the harness booted without a control plane');
  const lease = leaseForRunningRuntime(project, 900_000);
  const issued = await plane.runs.attachments.issueAttachment(
    makeControlPlaneId('run'),
    makeControlPlaneId('attempt'),
    project.projectId,
    project.workspaceId,
    { backendId: 'matrix-harness', lease, leaseToken: lease.token, tabId, grant },
  );
  expect(issued && issued.launch, `issueAttachment returned ${JSON.stringify(issued && Object.keys(issued))}`);
  return {
    attachmentId: issued.launch.attachmentId,
    secret: issued.launch.secret,
    authorityRevision: issued.launch.authorityRevision,
  };
}
let intentSeq = 0;
/**
 * An accepted effectful dispatch rotates the attachment's authority and hands back the revision the
 * next call must present. Ignoring it makes every later dispatch present a revision the app has
 * already retired, so the harness would refuse itself for staleness it committed.
 */
function adoptReplacementRevision(attachment, response) {
  const next = response && typeof response.replacementAuthorityRevision === 'string' ? response.replacementAuthorityRevision.trim() : '';
  if (next) attachment.authorityRevision = next;
  return response;
}
/** One real capability invocation through the shipping transport, normalized to a receipt fact. */
async function dispatchCapability(attachment, name, params) {
  const plane = planeOf();
  intentSeq += 1;
  try {
    const response = await plane.transport.dispatchIntent({
      requestId: `req-matrix-${intentSeq}`,
      idempotencyKey: `idem-matrix-${intentSeq}`,
      attachmentId: attachment.attachmentId,
      attachmentSecret: attachment.secret,
      authorityRevision: attachment.authorityRevision,
      name,
      params,
    });
    return adoptReplacementRevision(attachment, response);
  } catch (err) {
    // A refusal raised as an exception is still a refusal: keep the code, never swallow it.
    if (err && typeof err.replacementAuthorityRevision === 'string') {
      attachment.authorityRevision = err.replacementAuthorityRevision;
    }
    return { ok: false, error: { code: err && err.code ? err.code : 'THROWN', message: messageOf(err) } };
  }
}
/** A dispatch result reduced to the facts a receipt can carry. */
const dispatchFact = (response) => ({
  ok: Boolean(response && response.ok),
  code: response && response.error ? response.error.code : null,
  message: response && response.error ? String(response.error.message || '').slice(0, 300) : null,
  data: response && response.ok ? jsonSafe(response.data) : null,
  replacementAuthorityRevision: response && typeof response.replacementAuthorityRevision === 'string' ? response.replacementAuthorityRevision : null,
});

// ---- the real bridge transport (criterion 10) -------------------------------------------------
/** A real bridge client: an authenticated WebSocket, exactly what the MCP proxy opens. */
function openBridgeSocket(secret) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`, { headers: { 'x-antifan-attachment-secret': secret } });
    const onError = (err) => reject(new Error(`bridge socket failed: ${messageOf(err)}`));
    socket.once('error', onError);
    socket.once('open', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}
/** One capability call over the bridge socket, in the bridge's own envelope. */
function bridgeCall(socket, id, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`bridge call ${id} produced no answer within 30000ms`));
    }, 30000);
    const handler = (raw) => {
      let response;
      try { response = JSON.parse(raw.toString()); } catch { return; }
      if (!response || response.id !== id) return;
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(response);
    };
    socket.on('message', handler);
    socket.send(JSON.stringify({
      id,
      method: 'antifan.capability.dispatch',
      params: {
        requestId: `req-bridge-${id}`,
        idempotencyKey: `idem-bridge-${id}`,
        ...params,
      },
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// The matrix run
// ---------------------------------------------------------------------------------------------
const observations = {};
const state = { daemon, lifecycleLogPath, compiledRoot, rendererBundlePresent };
let willQuitSeen = false;
let willQuitHold = null;
/**
 * The lifecycle journal lives inside the run's disposable data root, which the cleanup and the
 * post-exit watcher both delete. A receipt that cites the ordered teardown — and an exit whose
 * call site the interceptor journaled — would be uncheckable once that file is gone, so the
 * journal is copied into the reports directory before anything removes it.
 */
function preserveLifecycleJournal() {
  try {
    if (!lifecycleLogPath || !fs.existsSync(lifecycleLogPath)) return null;
    fs.copyFileSync(lifecycleLogPath, journalCopyPath);
    observations.lifecycleJournal = { source: lifecycleLogPath, copy: journalCopyPath };
    return journalCopyPath;
  } catch (err) {
    observations.lifecycleJournal = { source: lifecycleLogPath ?? null, copy: null, error: messageOf(err) };
    return null;
  }
}

/**
 * How this process ended, recorded from the last handler that runs. A run that dies mid-row
 * leaves the receipt with unjudged rows and no witness for the exit itself, which makes "the row
 * threw" and "the process was killed from outside" indistinguishable; this field is that witness.
 */
function recordEnding(via, code) {
  try {
    preserveLifecycleJournal();
    observations.ended = {
      via,
      code: code ?? null,
      at: new Date().toISOString(),
      currentRowId,
      willQuitSeen,
      shells: (() => { try { return mainProcess.projectWindowAuthority.snapshot().map((entry) => entry.ownerKey); } catch { return null; } })(),
    };
  } catch {}
}
const willQuitPromise = new Promise((resolve) => { willQuitHold = resolve; });
// The harness holds the platform's exit open so the committed-quit rows can be asserted and the
// receipt written; the shipping listeners have already run by then. Every delivery is held, not
// just the first: the platform re-delivers `will-quit` for each new quit attempt, and a second
// attempt follows once the last window is really destroyed, so a first-only hold would let that
// one end the process while the rows below are still running. The rows release it by exiting.
let willQuitEvents = 0;
app.on('will-quit', (event) => {
  willQuitEvents += 1;
  event.preventDefault();
  if (!willQuitSeen) {
    willQuitSeen = true;
    willQuitHold('will-quit');
  }
});

async function run() {
  const court = authority();
  await app.whenReady();

  // The post-exit watcher is armed before the first row: a spontaneous quit or a mid-run throw
  // later in this function can no longer leave the exit unobserved.
  ensureWatcherArmed();
  await startServer();
  observations.environment = {
    dataRoot: tempRoot,
    profileDir,
    bridgePort: BRIDGE_PORT,
    compiledRoot,
    rendererBundlePresent,
    daemonEntryPresent,
    daemonStaged: daemon.staged,
    daemonStagingError: daemon.stagingError,
    lifecycleLogPath,
    displays: displayFacts(),
  };

  // ------------------------------------------------------------------ boot
  const bootstrap = await waitFor(
    () => {
      const current = snapshot();
      return current.length === 1 ? current[0] : false;
    },
    'the startup project window',
  );
  const alphaKey = bootstrap.ownerKey;
  const alphaToolbar = await toolbarFor(alphaKey);
  const alphaSidebar = await sidebarFor(alphaKey);
  observations.boot = { entry: bootstrap, displays: displayFacts(), rendererBundlePresent };
  if (daemon.staged) {
    try {
      const attached = await ensureDaemon({ cwd: ALPHA.path });
      daemon.beforeHandle = attached && attached.handle ? { ...attached.handle } : null;
      noteDaemonPid(daemon.beforeHandle);
      observations.daemon = { mode: attached && attached.mode, handle: daemon.beforeHandle };
    } catch (err) {
      observations.daemon = { mode: 'error', error: messageOf(err) };
    }
  }

  // A's own page: a real http origin, so the same page carries typed input, a pointer-driven
  // window.open and a navigable target. The tab is created through A's own toolbar, i.e. the real
  // user path.
  const alphaTab = await createTabViaToolbar(alphaToolbar, baseUrl('/alpha'));
  expect(typeof alphaTab === 'string' && alphaTab.length > 0, `window A created no tab (${JSON.stringify(alphaTab)})`);
  const alphaPage = pageOf(alphaTab);
  expect(alphaPage && !alphaPage.isDestroyed(), 'window A\'s tab has no page');
  const alphaLoaded = await bounded(court.hostForOwner(alphaKey).navigateAndWait(alphaTab, baseUrl('/alpha')), 20000, 'alpha page load');
  expect(alphaLoaded === true, 'window A\'s page did not load from the local origin');
  state.alphaTab = alphaTab;
  // The isolation facts criterion 11 judges, captured before a second window exists.
  state.beforeSecondWindow = {
    partitions: court.hostForOwner(alphaKey).getLivePartitionNames(),
    sessionRefs: new Map([[alphaTab, court.hostForOwner(alphaKey).getTabSession(alphaTab) ?? null]]),
    records: [tabRecord(alphaTab)].filter(Boolean),
  };

  // ------------------------------------------------------------------ R4e, missing authority
  await automated('R4e', async (row) => {
    const before = snapshot();
    const result = await openProject(alphaSidebar, UNKNOWN_PROJECT_ID);
    await sleep(200);
    const after = snapshot();
    row.observed = {
      result,
      shellCountBefore: before.length,
      shellCountAfter: after.length,
      unknownProjectId: UNKNOWN_PROJECT_ID,
    };
    row.ids = { windowIds: windowIdsOf([alphaKey]), foregroundBefore: foregroundId(), foregroundAfter: foregroundId() };
    expect(result && result.status === 'FAILED', `an unknown project returned ${JSON.stringify(result)}`);
    expect(result.reason === 'UNKNOWN_PROJECT', `an unknown project reported '${String(result.reason)}'`);
    expect(after.length === before.length, `the refused open changed the shell count from ${before.length} to ${after.length}`);
    expect(!after.some((entry) => entry.owner.kind === 'project' && entry.owner.projectId === UNKNOWN_PROJECT_ID), 'the refused project gained a window');
  });

  // ------------------------------------------------------------------ R4a, user tab affiliation
  await automated('R4a', async (row) => {
    const record = tabRecord(alphaTab);
    const persisted = await waitFor(
      () => (savedTabIds(alphaKey).includes(alphaTab) ? savedTabIds(alphaKey) : false),
      `tab ${alphaTab} to appear under owner record '${alphaKey}'`,
      20000,
    ).catch(() => null);
    const otherOwners = Object.keys(readSavedTabsDocument()?.owners ?? {}).filter((key) => key !== alphaKey && savedTabIds(key).includes(alphaTab));
    row.observed = {
      record,
      windowOwnerKey: alphaKey,
      persistedUnderOwner: persisted,
      ownersClaimingTheTab: otherOwners,
      savedTabsVersion: readSavedTabsDocument()?.version,
      ownerKeys: Object.keys(readSavedTabsDocument()?.owners ?? {}),
      expectedProjectId: ALPHA.projectId,
      expectedWorkspaceId: ALPHA.workspaceId,
    };
    row.ids = { windowIds: windowIdsOf([alphaKey]), tabIds: [alphaTab], projectIds: [ALPHA.projectId], workspaceIds: [ALPHA.workspaceId] };
    expect(record, `tab ${alphaTab} has no record`);
    expect(record.windowOwnerKey === alphaKey, `the user tab's host belongs to '${record.windowOwnerKey}', not '${alphaKey}'`);
    expect(persisted, `the user tab was not persisted under its own window's owner record ('${alphaKey}')`);
    expect(otherOwners.length === 0, `another owner record claims the tab: ${JSON.stringify(otherOwners)}`);
  });

  // ------------------------------------------------------------------ R1, two windows
  let betaKey = null;
  await automated('R1', async (row) => {
    const openResult = await openProject(alphaSidebar, BETA.projectId);
    const betaEntry = await waitFor(
      () => snapshot().find((entry) => entry.owner.kind === 'project' && entry.owner.projectId === BETA.projectId) || false,
      'the second project window',
    );
    betaKey = betaEntry.ownerKey;
    const betaWindow = court.windowFor(betaKey);
    expect(betaWindow && !betaWindow.isDestroyed(), 'the second window has no native window');

    // Two windows on two displays where the machine has two: a real placement, asserted by the
    // display each window then occupies. A single-display machine cannot show this and says so.
    const displays = displayFacts();
    const placement = { displays: displays.map((display) => display.id), placedOn: null, note: null };
    if (displays.length >= 2) {
      const alphaWindow = court.windowFor(alphaKey);
      for (const [window, display] of [[alphaWindow, displays[0]], [betaWindow, displays[1]]]) {
        if (!window || window.isDestroyed()) continue;
        const area = display.workArea;
        window.setBounds({ x: area.x + 40, y: area.y + 40, width: Math.min(1200, Math.max(900, area.width - 120)), height: Math.min(900, Math.max(640, area.height - 160)) });
      }
      await sleep(400);
      const shellA = court.shellFor(alphaKey);
      const shellB = court.shellFor(betaKey);
      shellA?.refreshDisplayInfo();
      shellB?.refreshDisplayInfo();
      placement.placedOn = { [alphaKey]: shellA?.getDisplayInfo()?.id ?? null, [betaKey]: shellB?.getDisplayInfo()?.id ?? null };
      expect(placement.placedOn[alphaKey] !== null && placement.placedOn[betaKey] !== null, `a window reports no display: ${JSON.stringify(placement.placedOn)}`);
      expect(placement.placedOn[alphaKey] !== placement.placedOn[betaKey], `both windows sit on display ${String(placement.placedOn[alphaKey])}`);
    } else {
      placement.note = 'this machine reports a single display, so both windows are placed on it; the two-monitor half of criterion 1 is row R1-HW';
    }

    const beforeDuplicate = snapshot();
    const duplicate = await openProject(alphaSidebar, BETA.projectId);
    await sleep(200);
    const afterDuplicate = snapshot();
    const alphaEntry = entryFor(alphaKey);
    const betaEntryAfter = entryFor(betaKey);
    row.observed = {
      openResult,
      duplicate,
      placement,
      shellCountBefore: beforeDuplicate.length,
      shellCountAfter: afterDuplicate.length,
      alphaVisible: alphaEntry?.visible,
      betaVisible: betaEntryAfter?.visible,
      alphaTabs: alphaEntry?.tabIds,
      betaTabs: betaEntryAfter?.tabIds,
    };
    row.ids = { windowIds: windowIdsOf([alphaKey, betaKey]), foregroundBefore: foregroundId(), foregroundAfter: foregroundId() };
    expect(openResult && openResult.status === 'OPENED', `the project-open channel returned ${JSON.stringify(openResult)}`);
    expect(betaEntry.windowId !== bootstrap.windowId, `both windows reported id ${betaEntry.windowId}`);
    expect(betaEntry.hostOwnerKey === betaKey, `the second window's host key is '${betaEntry.hostOwnerKey}'`);
    expect(alphaEntry && betaEntryAfter, 'a window disappeared while the duplicate open ran');
    expect(alphaEntry.visible === true && betaEntryAfter.visible === true, `a window is not visible: A=${String(alphaEntry.visible)} B=${String(betaEntryAfter.visible)}`);
    expect(duplicate && duplicate.status === 'FOCUSED', `the duplicate open returned ${JSON.stringify(duplicate)}`);
    expect(afterDuplicate.length === beforeDuplicate.length, `the duplicate open changed the shell count from ${beforeDuplicate.length} to ${afterDuplicate.length}`);
    expect(entryFor(betaKey)?.windowId === betaEntry.windowId, 'the second window changed identity across the duplicate open');
  });

  // ------------------------------------------------------------------ R1-HW (hardware)
  blocked(
    'R1-HW',
    'needs physical hardware/human: two real monitors with a person confirming that A and B are legible and independently interactive at the same time. A harness can place and measure windows, but it cannot observe a person reading two screens.',
    {
      displays: displayFacts(),
      windowPlacements: {
        [alphaKey]: court.shellFor(alphaKey)?.getDisplayInfo() ?? null,
        [betaKey]: court.shellFor(betaKey)?.getDisplayInfo() ?? null,
      },
      note: 'the automated placement/bounds half of this criterion is recorded in row R1; this row is the human half and stays BLOCKED until a person observes it',
    },
    { windowIds: windowIdsOf([alphaKey, betaKey]) },
  );

  // B's anchor page. It is created through the host API with B's own verified capsule: the
  // toolbar path's own affiliation is measured separately (R4a2), and the routed-creation rows
  // need an anchor whose verified affiliation is genuinely B's.
  const betaHost = court.hostForOwner(betaKey);
  expect(betaHost, 'the second window has no host');
  const betaAnchorTab = betaHost.createTab(baseUrl('/beta'), true, { capsuleId: BETA.capsuleId });
  expect(typeof betaAnchorTab === 'string' && betaAnchorTab.length > 0, 'the B anchor tab was not created');
  const betaAnchorLoaded = await bounded(betaHost.navigateAndWait(betaAnchorTab, baseUrl('/beta')), 20000, 'beta anchor load');
  expect(betaAnchorLoaded === true, 'the B anchor page did not load from the local origin');
  const betaToolbar = await toolbarFor(betaKey);
  state.betaAnchorTab = betaAnchorTab;
  const betaAnchorPage = () => {
    const page = pageOf(betaAnchorTab);
    if (!page || page.isDestroyed()) throw new Error('the B anchor page is gone');
    return page;
  };

  // ------------------------------------------------------------------ R4a2, second-window user tab
  await automated('R4a2', async (row) => {
    const toolbarTab = await createTabViaToolbar(betaToolbar, 'about:blank');
    expect(typeof toolbarTab === 'string' && toolbarTab.length > 0, `window B created no toolbar tab (${JSON.stringify(toolbarTab)})`);
    const record = tabRecord(toolbarTab);
    const persisted = await waitFor(
      () => (savedTabIds(betaKey).includes(toolbarTab) ? savedTabIds(betaKey) : false),
      `tab ${toolbarTab} to appear under owner record '${betaKey}'`,
      20000,
    ).catch(() => null);
    const claimingOwners = Object.keys(readSavedTabsDocument()?.owners ?? {}).filter((key) => savedTabIds(key).includes(toolbarTab));
    row.observed = {
      toolbarTab,
      record,
      windowOwnerKey: betaKey,
      persistedUnderOwner: persisted,
      ownersClaimingTheTab: claimingOwners,
      expectedOwnerKey: betaKey,
      alphaOwnerRecordIds: savedTabIds(alphaKey),
      note: 'the window\'s saved-tabs owner record is the verified affiliation carrier; the tab must not be recorded under another project',
    };
    row.ids = { windowIds: windowIdsOf([betaKey, alphaKey]), tabIds: [toolbarTab], projectIds: [BETA.projectId], workspaceIds: [BETA.workspaceId] };
    expect(record, `tab ${toolbarTab} has no record`);
    expect(record.windowOwnerKey === betaKey, `the toolbar tab's host belongs to '${record.windowOwnerKey}', not '${betaKey}'`);
    // The capsule is the affiliation the rest of the product reads (routed creation, terminal and
    // capture scoping): a user tab opened in window B must not be filed under whichever capsule the
    // process happens to have active, which here is window A's.
    expect(record.capsuleId === BETA.capsuleId, `the toolbar tab's capsule is '${String(record.capsuleId)}', expected this window's '${BETA.capsuleId}'`);
    expect(record.capsuleId !== ALPHA.capsuleId, `the toolbar tab inherited window A's capsule '${ALPHA.capsuleId}'`);
    expect(persisted, `the toolbar tab in window B was not persisted under '${betaKey}'`);
    expect(claimingOwners.length === 1 && claimingOwners[0] === betaKey, `the tab is claimed by ${JSON.stringify(claimingOwners)}, not only by '${betaKey}'`);
  });

  // ------------------------------------------------------------------ R4b, native child affiliation
  await automated('R4b', async (row) => {
    const before = [...(entryFor(betaKey)?.tabIds ?? [])];
    const clicked = await clickElement(betaAnchorPage(), '#popupBtn');
    const childTab = await waitFor(
      () => {
        const tabs = entryFor(betaKey)?.tabIds ?? [];
        return tabs.find((tabId) => !before.includes(tabId)) || false;
      },
      'the native window.open child tab',
      15000,
    ).catch(() => null);
    const record = childTab ? tabRecord(childTab) : null;
    const host = childTab ? court.hostForTab(childTab) : null;
    const openerRecord = tabRecord(betaAnchorTab);
    row.observed = {
      clickedAt: clicked,
      childTab,
      record,
      openerCapsuleId: openerRecord ? openerRecord.capsuleId : null,
      hostOwnerKey: host ? host.windowOwnerKey() : null,
      siblingWindowTabIds: entryFor(alphaKey)?.tabIds ?? [],
    };
    row.ids = { windowIds: windowIdsOf([alphaKey, betaKey]), tabIds: [betaAnchorTab, childTab].filter(Boolean), projectIds: [BETA.projectId] };
    expect(childTab, `no child tab appeared in window B (tabs before: ${JSON.stringify(before)})`);
    expect(host && host.windowOwnerKey() === betaKey, `the child's host is '${host ? host.windowOwnerKey() : 'none'}', not B's '${betaKey}'`);
    expect(record, `the child tab ${childTab} has no record`);
    // "Native window.open inherits its source" (phase-02 spec): the source is the tab that asked,
    // and here that tab is window B's while window A is the process-wide active capsule. Asserting
    // the shared value is therefore not enough — the child has to carry B's capsule, not A's.
    expect(
      record.capsuleId === (openerRecord ? openerRecord.capsuleId : undefined),
      `the popup's capsule is '${String(record.capsuleId)}' while its opener carried '${String(openerRecord ? openerRecord.capsuleId : null)}'`,
    );
    expect(record.capsuleId === BETA.capsuleId, `the popup's capsule is '${String(record.capsuleId)}', expected this window's '${BETA.capsuleId}'`);
    expect(record.capsuleId !== ALPHA.capsuleId, `the popup inherited window A's active capsule '${ALPHA.capsuleId}'`);
    expect(!(entryFor(alphaKey)?.tabIds ?? []).includes(childTab), 'the child tab appeared in window A');
  });

  // ------------------------------------------------------------------ R2 + R4c: typing in A, agent work in B
  const betaAgentAttachment = await mintAttachment({ project: BETA, tabId: betaAnchorTab });
  state.betaAgentAttachment = betaAgentAttachment;
  let agentChildTab = null;
  await automated('R2', async (row) => {
    // The user is typing in A: real key events into A's focused field.
    // Both captures refuse a missing window, so the comparisons at the end of this row cannot
    // be satisfied by two absences.
    const alphaEntryBefore = requireEntry(alphaKey);
    const alphaActiveBeforeR2 = requireActiveTab(alphaKey);
    const fieldFocus = await alphaPage.executeJavaScript("(() => { const el = document.getElementById('field'); if (!el) return false; el.focus(); return document.activeElement === el; })()", true);
    expect(fieldFocus === true, 'window A\'s input could not be focused');
    typeText(alphaPage, 'dang-go');
    await sleep(150);
    const typed = await alphaPage.executeJavaScript("document.getElementById('field').value", true);
    expect(typed === 'dang-go', `the typed input in A read back as '${String(typed)}'`);

    const alphaWindow = court.windowFor(alphaKey);
    alphaWindow.show();
    alphaWindow.focus();
    await sleep(250);
    const foregroundBefore = foregroundId();
    const betaTabsBefore = [...(entryFor(betaKey)?.tabIds ?? [])];
    // B's visible tab is read as this row found it: the row asserts that *the agent's* work in B
    // never moves it. A user-clicked popup opened in B by an earlier row legitimately took the front
    // there, so blaming that on this dispatch would be measuring the wrong event.
    const betaActiveBeforeR2 = requireEntry(betaKey)?.activeTabId ?? null;
    const revisionBefore = attachmentState(betaAgentAttachment.attachmentId);

    const openedFact = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.open-tab', { url: baseUrl('/agent-child'), activate: false }));
    expect(openedFact.ok, `the authorized open-tab for B was refused: ${JSON.stringify(openedFact)}`);
    agentChildTab = await waitFor(
      () => (entryFor(betaKey)?.tabIds ?? []).find((tabId) => !betaTabsBefore.includes(tabId)) || false,
      'the agent-created child tab in B',
      20000,
    ).catch(() => null);
    const navigatedFact = agentChildTab
      ? dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/agent-child?step=2'), tabId: agentChildTab }))
      : null;
    await sleep(250);

    const alphaEntryAfter = entryFor(alphaKey);
    const betaEntryAfter = entryFor(betaKey);
    const typedAfter = await alphaPage.executeJavaScript("document.getElementById('field').value", true);
    const alphaUrl = await alphaPage.executeJavaScript('location.href', true);
    const childPage = agentChildTab ? pageOf(agentChildTab) : null;
    const childUrl = childPage && !childPage.isDestroyed() ? await childPage.executeJavaScript('location.href', true) : null;
    row.observed = {
      typedInA: typed,
      typedStillInA: typedAfter,
      openedFact,
      navigatedFact,
      childTab: agentChildTab,
      childUrl,
      alphaUrl,
      foregroundBefore,
      foregroundAfter: foregroundId(),
      foregroundNote: 'the OS foreground reading is recorded evidence only in this row: whether a real user would keep typing is row R2-HW, which needs hardware/human observation',
      alphaActiveTabBefore: alphaEntryBefore?.activeTabId,
      alphaActiveTabAfter: alphaEntryAfter?.activeTabId,
      alphaTerminalBefore: { cwd: alphaEntryBefore?.terminalCwd, source: alphaEntryBefore?.terminalCwdSource },
      alphaTerminalAfter: { cwd: alphaEntryAfter?.terminalCwd, source: alphaEntryAfter?.terminalCwdSource },
      betaActiveTabBefore: betaActiveBeforeR2,
      betaActiveTabAfter: betaEntryAfter?.activeTabId,
      betaAnchorTab,
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [alphaTab, betaAnchorTab, agentChildTab].filter(Boolean),
      projectIds: [ALPHA.projectId, BETA.projectId],
      workspaceIds: [ALPHA.workspaceId, BETA.workspaceId],
      attachmentRevisionBefore: revisionBefore,
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore,
      foregroundAfter: foregroundId(),
    };
    observations.foregroundDuringR2 = { before: foregroundBefore, after: foregroundId() };
    expect(agentChildTab, 'the agent-bound creation produced no tab in B');
    expect(navigatedFact && navigatedFact.ok, `the agent navigation in B was refused: ${JSON.stringify(navigatedFact)}`);
    expect(typeof childUrl === 'string' && childUrl.includes('step=2'), `the child tab's URL is '${String(childUrl)}'`);
    expect(typedAfter === 'dang-go', `window A's typed input was disturbed (read back '${String(typedAfter)}')`);
    const alphaEntryAfterR2 = requireEntry(alphaKey);
    const alphaActiveAfterR2 = requireActiveTab(alphaKey);
    expect(alphaActiveAfterR2 === alphaActiveBeforeR2, `window A's active tab moved from '${alphaActiveBeforeR2}' to '${alphaActiveAfterR2}'`);
    expect(alphaEntryAfterR2.terminalCwdSource === alphaEntryBefore.terminalCwdSource && alphaEntryAfterR2.terminalCwd === alphaEntryBefore.terminalCwd, 'window A\'s terminal workspace binding moved');
    expect(betaEntryAfter?.activeTabId === betaActiveBeforeR2, `the agent's work in B moved B's visible active tab from '${String(betaActiveBeforeR2)}' to '${String(betaEntryAfter?.activeTabId)}'`);
    const revisionAfter = attachmentState(betaAgentAttachment.attachmentId);
    // An accepted effectful dispatch rotates this attachment's authority and hands the caller the
    // revision the next call must present; two accepted dispatches therefore rotate exactly twice,
    // and the live handle afterwards is exactly the one the second dispatch returned. Nothing else
    // in the row — A's typing, A's window activation, B's user tab — may rotate anything.
    expect(revisionAfter.revisionNumber === revisionBefore.revisionNumber + 2, `two accepted dispatches left the revision number at ${revisionAfter.revisionNumber}, not ${revisionBefore.revisionNumber + 2}`);
    expect(revisionAfter.authorityRevision === navigatedFact.replacementAuthorityRevision, `the live authority handle '${String(revisionAfter.authorityRevision)}' is not the one the last accepted dispatch returned ('${String(navigatedFact.replacementAuthorityRevision)}')`);
  });

  // ------------------------------------------------------------------ R2-HW (hardware)
  blocked(
    'R2-HW',
    'needs physical hardware/human: real OS foreground focus and keyboard stability. `sendInputEvent` injects into a renderer directly and cannot exercise the platform\'s foreground lockout rules, so "a person keeps typing in A while a background window navigates" is not certifiable from this harness.',
    {
      foregroundDuringAutomatedRow: observations.foregroundDuringR2 ?? null,
      note: 'the automated half — A\'s typed value, active tab, terminal binding, B\'s active tab and the attachment revision all unchanged by B\'s agent work — is recorded in row R2',
    },
    { windowIds: windowIdsOf([alphaKey, betaKey]) },
  );

  // ------------------------------------------------------------------ R2b: each window's terminal is its own
  /**
   * Whether a session's transcript came to contain the marker before the deadline.
   *
   * A read that throws is a fact about the harness, not evidence about the session: returning
   * `false` for both would let an unreadable sibling session satisfy every "B never saw the
   * marker" assertion. The outcome therefore carries the failure separately, and the negative
   * assertions below require a read that succeeded.
   */
  const sawMarker = async (sessionId, marker, ms = 8000) => {
    let readError = null;
    try {
      await waitFor(
        async () => {
          try {
            const full = await Promise.resolve(planeOf().terminal.getFullBuffer(sessionId));
            const transcript = typeof full === 'string' ? full : String((full && full.buffer) || '');
            if (transcript.includes(marker)) return true;
            readError = null; // a successful read that found nothing clears the last failure
            return false;
          } catch (err) {
            readError = messageOf(err);
            return false;
          }
        },
        `session ${sessionId} to show ${marker}`,
        ms,
      );
      return { reached: true, readError: null };
    } catch {
      return { reached: false, readError };
    }
  };

  await automated('R2b', async (row) => {
    const terminal = planeOf().terminal;
    // One session per window, each created with its own window's workspace and capsule: until the
    // two can be told apart there is nothing whose separation could be measured.
    const sessionA = await bounded(Promise.resolve(terminal.createSession(ALPHA.path, ALPHA.capsuleId)), 15000, 'create A terminal session');
    const sessionB = await bounded(Promise.resolve(terminal.createSession(BETA.path, BETA.capsuleId)), 15000, 'create B terminal session');
    expect(typeof sessionA === 'string' && sessionA.length > 0, `no terminal session was created for A (${JSON.stringify(sessionA)})`);
    expect(typeof sessionB === 'string' && sessionB.length > 0, `no terminal session was created for B (${JSON.stringify(sessionB)})`);
    const sidebarA = await sidebarFor(alphaKey);
    const sidebarB = await sidebarFor(betaKey);
    const stamp = Date.now().toString(36);
    const markerOwn = `r2b-own-${stamp}`;
    const markerAfterSwitch = `r2b-switch-${stamp}`;
    const markerCross = `r2b-cross-${stamp}`;
    const send = (sidebar, expression, label) => bounded(sidebar.executeJavaScript(expression, true), 15000, label);

    // The selection is an `ipcRenderer.invoke`, so the promise is awaited inside the renderer and
    // what comes back is the route's own answer: `false` means the switch was refused or the
    // session was gone, and only `true` means the process-wide active session really moved.
    const selectedA = await send(
      sidebarA,
      `window.antifanStandalone.setActiveTerminalSession(${JSON.stringify(sessionA)})`,
      'A setActiveTerminalSession',
    );
    await send(sidebarA, `window.antifanStandalone.sendTerminalInput(${JSON.stringify(`echo ${markerOwn}\r`)})`, 'A sendTerminalInput');
    const ownA = await sawMarker(sessionA, markerOwn);
    const ownB = await sawMarker(sessionB, markerOwn, 1500);

    // B makes its own session the process-wide active one. A's next keystrokes must still land in
    // A's session: the active session is process-wide state, not this window's terminal.
    const selectedB = await send(
      sidebarB,
      `window.antifanStandalone.setActiveTerminalSession(${JSON.stringify(sessionB)})`,
      'B setActiveTerminalSession',
    );
    // The switch has to be proven, not assumed: if it silently did nothing, the process-wide
    // active session would still be A's, whose typing would reach A's session for reasons that
    // have nothing to do with this window's routing. B reads its own report (a sibling's active
    // session is blanked there), so naming B's session is exactly "the global active is mine".
    const diagnosticsBAfterSwitch = await send(sidebarB, 'window.antifanStandalone.dumpTerminalDiagnostics()', 'B dumpTerminalDiagnostics after switch');
    const bActiveAfterSwitch = diagnosticsBAfterSwitch && typeof diagnosticsBAfterSwitch === 'object' ? diagnosticsBAfterSwitch.activeSessionId : null;
    await send(sidebarA, `window.antifanStandalone.sendTerminalInput(${JSON.stringify(`echo ${markerAfterSwitch}\r`)})`, 'A sendTerminalInput after B switch');
    const afterSwitchA = await sawMarker(sessionA, markerAfterSwitch);
    const afterSwitchB = await sawMarker(sessionB, markerAfterSwitch, 1500);

    // Naming the other window's session explicitly is refused, and that session stays clean.
    // `sendTerminalInputTo` is fire-and-forget, so the refusal is observed where it lands: nowhere.
    const crossSent = await send(
      sidebarA,
      `(() => { try { window.antifanStandalone.sendTerminalInputTo(${JSON.stringify(sessionB)}, ${JSON.stringify(`echo ${markerCross}\r`)}); return { sent: true }; } catch (err) { return { sent: false, error: String((err && err.message) || err) }; } })()`,
      'A cross-window send',
    );
    const crossReachedB = await sawMarker(sessionB, markerCross, 1500);
    // What a window may read is scoped by the same rule: its own sessions, never a sibling's.
    const listA = await send(sidebarA, 'window.antifanStandalone.listTerminals()', 'A listTerminals');
    const diagnosticsA = await send(sidebarA, 'window.antifanStandalone.dumpTerminalDiagnostics()', 'A dumpTerminalDiagnostics');
    const listedFromA = (Array.isArray(listA) ? listA : [])
      .map((session) => (session && (session.id || session.sessionId)) || null)
      .filter(Boolean);
    const diagnosedFromA = (diagnosticsA && Array.isArray(diagnosticsA.sessions) ? diagnosticsA.sessions : [])
      .map((session) => (session && (session.sessionId || session.id)) || null)
      .filter(Boolean);
    row.observed = {
      sessionA,
      sessionB,
      sessionCapsuleA: typeof terminal.sessionCapsuleId === 'function' ? terminal.sessionCapsuleId(sessionA) : null,
      sessionCapsuleB: typeof terminal.sessionCapsuleId === 'function' ? terminal.sessionCapsuleId(sessionB) : null,
      selectedA: selectedA === true,
      selectedB: selectedB === true,
      activeSessionAfterBSwitch: bActiveAfterSwitch,
      crossSent,
      ownMarkerReachedA: ownA.reached,
      ownMarkerReadErrorA: ownA.readError,
      ownMarkerReachedB: ownB.reached,
      ownMarkerReadErrorB: ownB.readError,
      afterSwitchMarkerReachedA: afterSwitchA.reached,
      afterSwitchMarkerReadErrorA: afterSwitchA.readError,
      afterSwitchMarkerReachedB: afterSwitchB.reached,
      afterSwitchMarkerReadErrorB: afterSwitchB.readError,
      crossMarkerReachedB: crossReachedB.reached,
      crossMarkerReadErrorB: crossReachedB.readError,
      listedFromA,
      diagnosedFromA,
      diagnosticsKeysFromA: diagnosticsA && typeof diagnosticsA === 'object' ? Object.keys(diagnosticsA) : null,
      diagnosticsSessionCountFromA: diagnosticsA && Array.isArray(diagnosticsA.sessions) ? diagnosticsA.sessions.length : null,
      diagnosticsActiveSessionIdFromA: diagnosticsA && typeof diagnosticsA === 'object' ? diagnosticsA.activeSessionId : null,
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      projectIds: [ALPHA.projectId, BETA.projectId],
      workspaceIds: [ALPHA.workspaceId, BETA.workspaceId],
      terminalSessionIds: [sessionA, sessionB],
    };
    /** Absence of a marker in a sibling session is evidence only when the read succeeded. */
    const neverSawMarker = (outcome) => outcome.reached === false && !outcome.readError;
    expect(selectedA === true, 'window A refused to select its own terminal session');
    expect(selectedB === true, 'window B refused to select its own terminal session');
    expect(bActiveAfterSwitch === sessionB, `B's session ${sessionB} was not the process-wide active session after B selected it (B reported '${String(bActiveAfterSwitch)}')`);
    expect(ownA.reached, `window A's own terminal ${sessionA} never showed the marker typed in A${ownA.readError ? ` (read failed: ${ownA.readError})` : ''}`);
    expect(neverSawMarker(ownB), ownB.readError
      ? `window B's session ${sessionB} could not be read (${ownB.readError}), so "window A's typing never reached it" is unproven`
      : `window B's terminal ${sessionB} received input typed in window A`);
    expect(afterSwitchA.reached, `window A's typing stopped reaching its own session ${sessionA} once window B made its session active${afterSwitchA.readError ? ` (read failed: ${afterSwitchA.readError})` : ''}`);
    expect(neverSawMarker(afterSwitchB), afterSwitchB.readError
      ? `window B's session ${sessionB} could not be read (${afterSwitchB.readError}), so "window A's typing reached B" is unproven`
      : `window A's typing reached window B's session ${sessionB} after B made it the active session`);
    expect(neverSawMarker(crossReachedB), crossReachedB.readError
      ? `window B's session ${sessionB} could not be read (${crossReachedB.readError}), so the cross-window refusal is unproven`
      : `naming window B's session ${sessionB} from window A delivered input into it`);
    expect(listedFromA.includes(sessionA), `window A's session list omits its own session (${JSON.stringify(listedFromA)})`);
    expect(listedFromA.includes(sessionB) === false, `window A's session list names window B's session ${sessionB}`);
    // The scoped diagnostics must still describe this window's own session: a report narrowed to
    // nothing would satisfy "never names B" while telling A nothing about its own terminal.
    expect(diagnosedFromA.includes(sessionA), `window A's diagnostics omit its own session (keys: ${JSON.stringify(row.observed.diagnosticsKeysFromA)}, sessions: ${JSON.stringify(row.observed.diagnosedFromA)})`);
    expect(diagnosedFromA.includes(sessionB) === false, `window A's diagnostics name window B's session ${sessionB}`);

    // These two sessions exist for this measurement only; the later rows create their own.
    for (const sessionId of [sessionA, sessionB]) {
      try { await bounded(Promise.resolve(terminal.closeSession(sessionId)), 8000, `close ${sessionId}`); } catch {}
    }
  });

  await automated('R2c', async (row) => {
    const terminal = planeOf().terminal;
    const sidebarA = await sidebarFor(alphaKey);
    const sidebarB = await sidebarFor(betaKey);
    const send = (sidebar, expression, label) => bounded(sidebar.executeJavaScript(expression, true), 20000, label);
    /** Two spellings of one directory: the workspace root as the probe wrote it, and its real path. */
    const normalise = (value) => (typeof value === 'string' && value ? path.resolve(value).toLowerCase().replace(/[\\/]+$/, '') : '');
    const workspaceForms = (root) => {
      const forms = new Set([normalise(root)]);
      for (const resolve of [() => fs.realpathSync.native(root), () => fs.realpathSync(root)]) {
        try { forms.add(normalise(resolve())); } catch { /* an unreadable root is compared as written */ }
      }
      return [...forms];
    };
    const alphaForms = workspaceForms(ALPHA.path);
    const betaForms = workspaceForms(BETA.path);

    // Every mint below names no cwd at all, which is the case the rule is about: the route has to
    // fill it from the capsule the asking window verified. B mints first, so by the time A asks,
    // the terminal state another window last touched is B's — its workspace and its session — which
    // is exactly the wrong answer for A and the shape the pre-cutover route would have produced.
    const mintedB = await send(sidebarB, 'window.antifanStandalone.newTerminal()', 'B newTerminal');
    // Context for the receipt, named for what it is: in daemon mode the manager handle is a proxy
    // whose `getCurrentCwd()` answers a local cache seeded at connect and then overwritten from
    // session events — including the active session's own cwd, because `getSessionState()` carries
    // no cwd field (`daemon-client.ts` `_updateLocalCache`). So this reading describes the live
    // session state A is minting alongside, not the daemon manager's ambient `currentCwd`; the
    // ambient path itself is pinned in `test/main/project-window-persistence.test.ts`, where the
    // ambient capsule is set and shown not to be inherited.
    const proxyCachedCwdBeforeA = typeof terminal.getCurrentCwd === 'function' ? terminal.getCurrentCwd() : null;
    const proxyCachedCwdWasAnotherWindows = typeof proxyCachedCwdBeforeA === 'string'
      ? alphaForms.includes(normalise(proxyCachedCwdBeforeA)) === false
      : null;
    const mintedA = await send(sidebarA, 'window.antifanStandalone.newTerminal()', 'A newTerminal');
    const mintedA2 = await send(sidebarA, 'window.antifanStandalone.newTerminal()', 'A newTerminal after B minted');
    expect(typeof mintedA === 'string' && mintedA.length > 0, `window A minted no session (${JSON.stringify(mintedA)})`);
    expect(typeof mintedB === 'string' && mintedB.length > 0, `window B minted no session (${JSON.stringify(mintedB)})`);
    expect(typeof mintedA2 === 'string' && mintedA2.length > 0, `window A's second mint produced no session (${JSON.stringify(mintedA2)})`);

    // The reading is taken from the window's own list: the cwd the sidebar presents for the
    // session it just created, never the manager's view of it.
    const listA = await send(sidebarA, 'window.antifanStandalone.listTerminals()', 'A listTerminals after minting');
    const listB = await send(sidebarB, 'window.antifanStandalone.listTerminals()', 'B listTerminals after minting');
    const cwdOf = (list, id) => {
      const found = (Array.isArray(list) ? list : []).find((session) => session && (session.id || session.sessionId) === id);
      return found && typeof found.cwd === 'string' ? found.cwd : null;
    };
    const cwdA = cwdOf(listA, mintedA);
    const cwdA2 = cwdOf(listA, mintedA2);
    const cwdB = cwdOf(listB, mintedB);
    const capsuleOf = (id) => (typeof terminal.sessionCapsuleId === 'function' ? terminal.sessionCapsuleId(id) : null);
    // The owner key the mint carried: the window's identity, which is what keeps two windows
    // that work one folder from answering for each other's terminals.
    const ownerKeyOf = (id) => (typeof terminal.sessionOwnerKey === 'function' ? terminal.sessionOwnerKey(id) : null);
    const expectedOwnerKeyA = `project:${ALPHA.projectId}`;
    const expectedOwnerKeyB = `project:${BETA.projectId}`;

    row.observed = {
      mintedA,
      mintedA2,
      mintedB,
      cwdA,
      cwdA2,
      cwdB,
      proxyCachedCwdBeforeA,
      proxyCachedCwdWasAnotherWindows,
      workspacePathA: ALPHA.path,
      workspacePathB: BETA.path,
      workspaceFormsA: alphaForms,
      workspaceFormsB: betaForms,
      capsuleA: capsuleOf(mintedA),
      capsuleA2: capsuleOf(mintedA2),
      capsuleB: capsuleOf(mintedB),
      ownerKeyA: ownerKeyOf(mintedA),
      ownerKeyA2: ownerKeyOf(mintedA2),
      ownerKeyB: ownerKeyOf(mintedB),
      expectedCapsuleA: ALPHA.capsuleId,
      expectedCapsuleB: BETA.capsuleId,
      expectedOwnerKeyA,
      expectedOwnerKeyB,
      listedFromA: (Array.isArray(listA) ? listA : []).map((session) => (session && (session.id || session.sessionId)) || null).filter(Boolean),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      projectIds: [ALPHA.projectId, BETA.projectId],
      workspaceIds: [ALPHA.workspaceId, BETA.workspaceId],
      terminalSessionIds: [mintedA, mintedA2, mintedB],
    };

    // The comparison is only meaningful while the two workspaces can be told apart.
    expect(alphaForms[0] !== betaForms[0], `windows A and B share one workspace root (${ALPHA.path}), so creation provenance cannot be measured here`);
    const matches = (forms, got) => typeof got === 'string' && forms.includes(normalise(got));
    expect(matches(alphaForms, cwdA), `window A's session ${mintedA} was created in '${String(cwdA)}', not in A's workspace (${ALPHA.path})`);
    expect(matches(alphaForms, cwdA2), `window A's second session ${mintedA2} was created in '${String(cwdA2)}', not in A's workspace (${ALPHA.path}) \u2014 the mint that followed another window's did not resolve to the window that asked`);
    expect(matches(betaForms, cwdB), `window B's session ${mintedB} was created in '${String(cwdB)}', not in B's workspace (${BETA.path})`);
    expect(capsuleOf(mintedA) === ALPHA.capsuleId, `window A's session ${mintedA} belongs to capsule '${String(capsuleOf(mintedA))}', not to A's (${ALPHA.capsuleId})`);
    expect(capsuleOf(mintedA2) === ALPHA.capsuleId, `window A's second session ${mintedA2} belongs to capsule '${String(capsuleOf(mintedA2))}', not to A's (${ALPHA.capsuleId})`);
    expect(capsuleOf(mintedB) === BETA.capsuleId, `window B's session ${mintedB} belongs to capsule '${String(capsuleOf(mintedB))}', not to B's (${BETA.capsuleId})`);
    // The owner key is the half a capsule cannot carry: two windows that work one folder stamp
    // the same capsule and still have to be told apart, so the mint names the window that asked.
    expect(ownerKeyOf(mintedA) === expectedOwnerKeyA, `window A's session ${mintedA} carries owner key '${String(ownerKeyOf(mintedA))}', not A's (${expectedOwnerKeyA})`);
    expect(ownerKeyOf(mintedA2) === expectedOwnerKeyA, `window A's second session ${mintedA2} carries owner key '${String(ownerKeyOf(mintedA2))}', not A's (${expectedOwnerKeyA}) \u2014 the mint that followed another window's did not carry the key of the window that asked`);
    expect(ownerKeyOf(mintedB) === expectedOwnerKeyB, `window B's session ${mintedB} carries owner key '${String(ownerKeyOf(mintedB))}', not B's (${expectedOwnerKeyB})`);
    expect(row.observed.listedFromA.includes(mintedB) === false, `window A's session list names window B's session ${mintedB}`);

    for (const sessionId of [mintedA, mintedA2, mintedB]) {
      try { await bounded(Promise.resolve(terminal.closeSession(sessionId)), 8000, `close ${sessionId}`); } catch {}
    }
  });

  await automated('R4c', async (row) => {
    const record = agentChildTab ? tabRecord(agentChildTab) : null;
    const host = agentChildTab ? court.hostForTab(agentChildTab) : null;
    row.observed = { agentChildTab, record, hostOwnerKey: host ? host.windowOwnerKey() : null, betaActiveTab: entryFor(betaKey)?.activeTabId };
    row.ids = { tabIds: [agentChildTab].filter(Boolean), projectIds: [BETA.projectId], workspaceIds: [BETA.workspaceId] };
    expect(agentChildTab, 'the agent-created child from R2 is missing');
    expect(host && host.windowOwnerKey() === betaKey, `the agent child's host is '${host ? host.windowOwnerKey() : 'none'}'`);
    expect((entryFor(betaKey)?.tabIds ?? []).includes(agentChildTab), 'the agent child is not presented by window B');
  });

  // ------------------------------------------------------------------ R3a: exact target across activation/minimize/restore
  await automated('R3a', async (row) => {
    const revisionBefore = attachmentState(betaAgentAttachment.attachmentId);
    const alphaUrlBefore = await alphaPage.executeJavaScript('location.href', true);
    const betaWindow = court.windowFor(betaKey);
    // The reading this row is about is whether *its own* dispatches move B's visible tab. An earlier
    // row opened a user-clicked popup in B, and a browser is expected to bring a user's new popup to
    // the front there, so the comparison is against the active tab as this row found it.
    const betaActiveBefore = requireEntry(betaKey)?.activeTabId ?? null;
    const steps = [];

    court.windowFor(alphaKey).focus();
    await sleep(200);
    steps.push({ step: 'activate-A', foreground: foregroundOwnerKey() });

    betaWindow.minimize();
    await waitFor(() => court.windowFor(betaKey)?.isMinimized() === true, 'window B to minimize', 8000).catch(() => null);
    // Window operations are not session instructions: activating A, minimizing B and restoring B
    // must leave authority where it was, while an accepted dispatch on the same attachment rotates
    // it once and returns the revision the following call must present.
    const revisionAfterWindowOps = attachmentState(betaAgentAttachment.attachmentId);
    const whileMinimized = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/agent-child?step=3'), tabId: agentChildTab }));
    steps.push({ step: 'minimized-dispatch', result: whileMinimized });
    const revisionAfterMinimizedDispatch = attachmentState(betaAgentAttachment.attachmentId);

    betaWindow.restore();
    await waitFor(() => court.windowFor(betaKey)?.isMinimized() === false, 'window B to restore', 8000).catch(() => null);
    const revisionAfterRestore = attachmentState(betaAgentAttachment.attachmentId);
    const afterRestore = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/agent-child?step=4'), tabId: agentChildTab }));
    steps.push({ step: 'restored-dispatch', result: afterRestore });
    // The foreign target stays refused after the minimize/restore cycle: no silent rotation.
    const foreignAfterRestore = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/alpha?hijack=3'), tabId: alphaTab }));
    steps.push({ step: 'restored-foreign-refusal', result: foreignAfterRestore });

    await sleep(250);
    const childPage = pageOf(agentChildTab);
    const childUrl = childPage && !childPage.isDestroyed() ? await childPage.executeJavaScript('location.href', true) : null;
    const alphaUrlAfter = await alphaPage.executeJavaScript('location.href', true);
    row.observed = {
      steps,
      childUrl,
      alphaUrlBefore,
      alphaUrlAfter,
      revisionBefore,
      revisionAfterWindowOps,
      revisionAfterMinimizedDispatch,
      revisionAfterRestore,
      revisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      betaActiveTabBefore: betaActiveBefore,
      betaActiveTab: entryFor(betaKey)?.activeTabId,
      betaAnchorTab,
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [alphaTab, betaAnchorTab, agentChildTab].filter(Boolean),
      attachmentRevisionBefore: revisionBefore,
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(whileMinimized.ok, `the authorized dispatch while B was minimized failed: ${JSON.stringify(whileMinimized)}`);
    expect(afterRestore.ok, `the authorized dispatch after B was restored failed: ${JSON.stringify(afterRestore)}`);
    expect(typeof childUrl === 'string' && childUrl.includes('step=4'), `the bound tab's URL is '${String(childUrl)}'`);
    expect(foreignAfterRestore.ok === false && foreignAfterRestore.code, `a foreign target was accepted after restore: ${JSON.stringify(foreignAfterRestore)}`);
    expect(alphaUrlAfter === alphaUrlBefore, `window A's page moved from '${String(alphaUrlBefore)}' to '${String(alphaUrlAfter)}'`);
    expect(entryFor(betaKey)?.activeTabId === betaActiveBefore, `the minimized/restored dispatch moved B's visible active tab from '${String(betaActiveBefore)}' to '${String(entryFor(betaKey)?.activeTabId)}'`);
    const revisionAfter = attachmentState(betaAgentAttachment.attachmentId);
    // A window operation is not a session instruction, and an accepted dispatch rotates authority
    // exactly once: the refusal of the foreign target is not an accepted dispatch, so it adds none.
    expect(revisionAfterWindowOps.revisionNumber === revisionBefore.revisionNumber, `activating A and minimizing B moved the revision number from ${revisionBefore.revisionNumber} to ${revisionAfterWindowOps.revisionNumber}`);
    expect(revisionAfterWindowOps.authorityRevision === revisionBefore.authorityRevision, 'activating A and minimizing B replaced the live authority handle');
    expect(revisionAfterMinimizedDispatch.revisionNumber === revisionBefore.revisionNumber + 1, `the accepted dispatch while B was minimized left the revision number at ${revisionAfterMinimizedDispatch.revisionNumber}, not ${revisionBefore.revisionNumber + 1}`);
    expect(revisionAfterRestore.revisionNumber === revisionAfterMinimizedDispatch.revisionNumber, `restoring B moved the revision number from ${revisionAfterMinimizedDispatch.revisionNumber} to ${revisionAfterRestore.revisionNumber}`);
    expect(revisionAfterRestore.authorityRevision === revisionAfterMinimizedDispatch.authorityRevision, 'restoring B replaced the live authority handle');
    expect(revisionAfter.revisionNumber === revisionBefore.revisionNumber + 2, `two accepted dispatches left the revision number at ${revisionAfter.revisionNumber}, not ${revisionBefore.revisionNumber + 2}`);
    expect(revisionAfter.authorityRevision !== revisionBefore.authorityRevision, 'two rotations left the live authority handle unchanged');
    // Every rotation is accounted for: the live handle after the row is exactly the one the last
    // accepted dispatch handed back, so nothing else (the window operations, the refused foreign
    // target) rotated authority behind the caller's back.
    expect(revisionAfter.authorityRevision === afterRestore.replacementAuthorityRevision, `the live authority handle '${String(revisionAfter.authorityRevision)}' is not the one the last accepted dispatch returned ('${String(afterRestore.replacementAuthorityRevision)}')`);
  });

  // ------------------------------------------------------------------ R3b: mismatch refusals
  let siblingTab = null;
  await automated('R3b', async (row) => {
    siblingTab = betaHost.createTab('about:blank', false, { capsuleId: BETA.capsuleId });
    expect(typeof siblingTab === 'string' && siblingTab.length > 0, 'the sibling tab in B was not created');
    const alphaUrlBefore = await alphaPage.executeJavaScript('location.href', true);
    const betaTabsBefore = [...(entryFor(betaKey)?.tabIds ?? [])];
    const alphaActiveBefore = requireActiveTab(alphaKey);
    const foregroundBefore = foregroundId();

    const crossWindow = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/alpha?hijack=1'), tabId: alphaTab }));
    const insideWindow = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/beta?hijack=2'), tabId: siblingTab }));
    await sleep(250);

    const alphaUrlAfter = await alphaPage.executeJavaScript('location.href', true);
    row.observed = {
      crossWindowRefusal: crossWindow,
      sameWindowOtherSessionRefusal: insideWindow,
      alphaUrlBefore,
      alphaUrlAfter,
      alphaActiveBefore,
      alphaActiveAfter: requireActiveTab(alphaKey),
      betaTabsBefore,
      betaTabsAfter: entryFor(betaKey)?.tabIds ?? [],
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [alphaTab, betaAnchorTab, siblingTab, agentChildTab].filter(Boolean),
      attachmentRevisionBefore: attachmentState(betaAgentAttachment.attachmentId),
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore,
      foregroundAfter: foregroundId(),
    };
    expect(crossWindow.ok === false, `a dispatch targeting another window's tab was accepted: ${JSON.stringify(crossWindow)}`);
    expect(insideWindow.ok === false, `a dispatch targeting another session's tab was accepted: ${JSON.stringify(insideWindow)}`);
    expect(typeof crossWindow.code === 'string' && crossWindow.code.length > 0, 'the cross-window refusal carried no error code');
    expect(typeof insideWindow.code === 'string' && insideWindow.code.length > 0, 'the sibling refusal carried no error code');
    expect(alphaUrlAfter === alphaUrlBefore, `a refused dispatch navigated A's page to '${String(alphaUrlAfter)}'`);
    expect(requireActiveTab(alphaKey) === alphaActiveBefore, 'a refused dispatch moved A\'s active tab');
    expect(JSON.stringify(entryFor(betaKey)?.tabIds ?? []) === JSON.stringify(betaTabsBefore), 'a refused dispatch changed B\'s tab list');
    expect(foregroundId() === foregroundBefore, 'a refused dispatch moved the foreground window');
  });

  // ------------------------------------------------------------------ R3c: two sessions inside one project
  await automated('R3c', async (row) => {
    // The shared-project comparison needs the agent's own tab in B. Without it there is no first
    // session to compare against, so the precondition is stated rather than crashed on.
    expect(agentChildTab && pageOf(agentChildTab), 'R2 created no agent tab in B, so there is no first session to compare against');
    // The second session gets its own page-backed tab: a tab left on about:blank has no committed
    // document on this Electron build, so anything renderer-bound on it never answers. The reads
    // below go through the hosted record, which is live with or without a rendered page.
    const secondTab = betaHost.createTab(baseUrl('/agent-child?session=two'), false, { capsuleId: BETA.capsuleId });
    expect(typeof secondTab === 'string' && secondTab.length > 0, 'the second session tab in B was not created');
    // Every step that can stall is bounded: a hang names the step it happened at instead of burning
    // the row's whole budget and stopping the run before the rows behind it are observed.
    const second = await bounded(mintAttachment({ project: BETA, tabId: secondTab }), 15000, 'mint the second session attachment in B');
    const firstUrlBefore = tabRecord(agentChildTab)?.url ?? '';
    const secondUrlBefore = tabRecord(secondTab)?.url ?? '';
    expect(tabRecord(agentChildTab), 'the first session tab in B has no hosted record');
    expect(tabRecord(secondTab), 'the second session tab in B has no hosted record');

    // Each session may use its own tab …
    const firstOwn = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/agent-child?owner=first'), tabId: agentChildTab }));
    const secondOwn = dispatchFact(await dispatchCapability(second, 'browser.navigate', { url: baseUrl('/beta?owner=second'), tabId: secondTab }));
    // … and neither may use the other's.
    const firstOnSecond = dispatchFact(await dispatchCapability(betaAgentAttachment, 'browser.navigate', { url: baseUrl('/cross=1'), tabId: secondTab }));
    const secondOnFirst = dispatchFact(await dispatchCapability(second, 'browser.navigate', { url: baseUrl('/cross=2'), tabId: agentChildTab }));
    await sleep(250);
    const firstUrlAfter = tabRecord(agentChildTab)?.url ?? '';
    const secondUrlAfter = tabRecord(secondTab)?.url ?? '';

    row.observed = {
      sharedProject: BETA.projectId,
      sessions: [
        { attachmentId: betaAgentAttachment.attachmentId, tabId: agentChildTab, own: firstOwn, onOtherSessionTab: firstOnSecond },
        { attachmentId: second.attachmentId, tabId: secondTab, own: secondOwn, onOtherSessionTab: secondOnFirst },
      ],
      firstUrlBefore,
      firstUrlAfter,
      secondUrlBefore,
      secondUrlAfter,
    };
    row.ids = {
      windowIds: windowIdsOf([betaKey]),
      tabIds: [agentChildTab, secondTab],
      projectIds: [BETA.projectId],
      workspaceIds: [BETA.workspaceId],
      attachmentRevisionBefore: attachmentState(betaAgentAttachment.attachmentId),
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
    };
    expect(firstOwn.ok && secondOwn.ok, `a session could not use its own tab: ${JSON.stringify([firstOwn, secondOwn])}`);
    expect(firstOnSecond.ok === false, `session one executed on session two's tab: ${JSON.stringify(firstOnSecond)}`);
    expect(secondOnFirst.ok === false, `session two executed on session one's tab: ${JSON.stringify(secondOnFirst)}`);
    expect(firstOnSecond.code && secondOnFirst.code, 'a cross-session refusal carried no error code');
    expect(firstUrlAfter.includes('owner=first'), `the first session's own navigation landed on '${String(firstUrlAfter)}'`);
    expect(secondUrlAfter.includes('owner=second'), `the second session's own navigation landed on '${String(secondUrlAfter)}'`);
    try { await planeOf().runs.attachments.revokeAttachment(second.attachmentId); } catch {}
  });

  // ------------------------------------------------------------------ R4f: conflicting authority
  const conflictAttachment = await mintAttachment({ project: ALPHA, tabId: betaAnchorTab });
  await automated('R4f', async (row) => {
    const betaTabsBefore = [...(entryFor(betaKey)?.tabIds ?? [])];
    const shellCountBefore = snapshot().length;
    const fact = dispatchFact(await dispatchCapability(conflictAttachment, 'browser.open-tab', { url: baseUrl('/hijack'), activate: false }));
    await sleep(300);
    const betaTabsAfter = entryFor(betaKey)?.tabIds ?? [];
    row.observed = { refusal: fact, betaTabsBefore, betaTabsAfter, shellCountBefore, shellCountAfter: snapshot().length };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [betaAnchorTab].concat(betaTabsAfter.filter((tabId) => !betaTabsBefore.includes(tabId))),
      projectIds: [ALPHA.projectId, BETA.projectId],
      attachmentRevisionBefore: attachmentState(conflictAttachment.attachmentId),
      attachmentRevisionAfter: attachmentState(conflictAttachment.attachmentId),
    };
    expect(fact.ok === false, `an attachment authenticated for A created a routed child on B's anchor: ${JSON.stringify(fact)}`);
    expect(typeof fact.code === 'string' && fact.code.length > 0, 'the conflict refusal carried no error code');
    expect(betaTabsAfter.length === betaTabsBefore.length, `the refused creation still added a tab to B: ${JSON.stringify(betaTabsAfter)}`);
    expect(snapshot().length === shellCountBefore, 'the refused creation changed the window set');
    try { await planeOf().runs.attachments.revokeAttachment(conflictAttachment.attachmentId); } catch {}
  });

  // ------------------------------------------------------------------ R5a: split independence
  await automated('R5a', async (row) => {
    const switched = betaHost.switchTab(betaAnchorTab);
    expect(switched === true, 'activating B\'s anchor tab reported failure');
    await sleep(250);
    const betaActiveCheck = requireActiveTab(betaKey);
    expect(betaActiveCheck === betaAnchorTab, `window B active tab is '${betaActiveCheck}', expected '${betaAnchorTab}'`);

    const betaBoundsBefore = betaHost.getTabContentBounds(betaAnchorTab);
    const betaWindowBoundsBefore = requireWindowBounds(betaKey);
    const betaRectBefore = nativeLayout(betaKey, betaAnchorTab).pageRect;
    const betaRecordBefore = tabRecord(betaAnchorTab);
    const betaActiveBefore = requireActiveTab(betaKey);
    const alphaBoundsBefore = court.hostForOwner(alphaKey).getTabContentBounds(alphaTab);

    try {
      const enabled = court.hostForOwner(alphaKey).toggleSplitReview(alphaTab, true);
      await sleep(400);
      const presetApplied = court.hostForOwner(alphaKey).setSplitPreset(alphaTab, 'mobile', 'phone-iphone15pro');
      await sleep(500);

      const alphaBoundsAfter = court.hostForOwner(alphaKey).getTabContentBounds(alphaTab);
      const alphaMobileBounds = court.hostForOwner(alphaKey).getTabContentBounds(alphaTab, 'mobile');
      const alphaRecordAfter = tabRecord(alphaTab);
      const betaBoundsAfter = betaHost.getTabContentBounds(betaAnchorTab);
      const betaWindowBoundsAfter = requireWindowBounds(betaKey);
      const betaRectAfter = nativeLayout(betaKey, betaAnchorTab).pageRect;
      const betaRecordAfter = tabRecord(betaAnchorTab);

      row.observed = {
        enabled,
        presetApplied,
        alpha: {
          boundsBefore: alphaBoundsBefore,
          boundsAfter: alphaBoundsAfter,
          mobileBounds: alphaMobileBounds,
          splitModeAfter: alphaRecordAfter ? alphaRecordAfter.splitMode : null,
          mobilePresetAfter: alphaRecordAfter ? alphaRecordAfter.splitMobilePresetId : null,
        },
        beta: {
          tabContentBefore: betaBoundsBefore,
          tabContentAfter: betaBoundsAfter,
          nativeRectBefore: betaRectBefore,
          nativeRectAfter: betaRectAfter,
          windowBoundsBefore: betaWindowBoundsBefore,
          windowBoundsAfter: betaWindowBoundsAfter,
          splitModeBefore: betaRecordBefore ? betaRecordBefore.splitMode : null,
          splitModeAfter: betaRecordAfter ? betaRecordAfter.splitMode : null,
          activeBefore: betaActiveBefore,
          activeAfter: requireActiveTab(betaKey),
        },
      };
      row.ids = {
        windowIds: windowIdsOf([alphaKey, betaKey]),
        tabIds: [alphaTab, betaAnchorTab],
        foregroundBefore: foregroundId(),
        foregroundAfter: foregroundId(),
      };
      expect(enabled === true, 'the split toggle for A\'s tab reported failure');
      expect(presetApplied === true, 'applying the mobile preset to A reported failure');
      expect(alphaRecordAfter && alphaRecordAfter.splitMode === true, `A's tab is not in split mode: ${JSON.stringify(alphaRecordAfter)}`);
      expect(alphaRecordAfter.splitMobilePresetId === 'phone-iphone15pro', `A's mobile preset is '${String(alphaRecordAfter.splitMobilePresetId)}'`);
      expect(typeof alphaMobileBounds === 'object' && alphaMobileBounds !== null && alphaMobileBounds.width > 0, 'A has no mobile pane bounds');
      expect(alphaMobileBounds.width <= 393, `A's mobile pane is ${alphaMobileBounds.width}px wide, wider than the 393px preset`);
      expect(alphaBoundsBefore && alphaBoundsAfter && alphaMobileBounds, `A's pane bounds could not be measured: before=${JSON.stringify(alphaBoundsBefore)} after=${JSON.stringify(alphaBoundsAfter)} mobile=${JSON.stringify(alphaMobileBounds)}`);
      expect(alphaBoundsAfter.width < alphaBoundsBefore.width, `A's desktop pane did not make room for the phone pane (${alphaBoundsBefore.width} -> ${alphaBoundsAfter.width})`);
      expect(betaBoundsBefore && betaBoundsAfter, `B's tab content bounds could not be measured: before=${JSON.stringify(betaBoundsBefore)} after=${JSON.stringify(betaBoundsAfter)}`);
      expect(betaRectBefore && betaRectAfter, `B's native tab-view rect could not be measured: before=${JSON.stringify(betaRectBefore)} after=${JSON.stringify(betaRectAfter)}`);
      expect(JSON.stringify(betaBoundsAfter) === JSON.stringify(betaBoundsBefore), `B's tab content bounds changed from ${JSON.stringify(betaBoundsBefore)} to ${JSON.stringify(betaBoundsAfter)}`);
      expect(JSON.stringify(betaRectAfter) === JSON.stringify(betaRectBefore), `B's native tab-view rect changed from ${JSON.stringify(betaRectBefore)} to ${JSON.stringify(betaRectAfter)}`);
      expect(JSON.stringify(betaWindowBoundsAfter) === JSON.stringify(betaWindowBoundsBefore), `B's window bounds changed from ${JSON.stringify(betaWindowBoundsBefore)} to ${JSON.stringify(betaWindowBoundsAfter)}`);
      expect(betaRecordAfter && betaRecordAfter.splitMode === false, 'B\'s tab entered split mode when A did');
      expect(requireActiveTab(betaKey) === betaActiveBefore, 'B\'s active tab changed when A entered split review');

      const splitDisabled = court.hostForOwner(alphaKey).toggleSplitReview(alphaTab, false);
      await sleep(300);
      const alphaRecordRestored = tabRecord(alphaTab);
      row.observed.splitDisarmed = { returned: splitDisabled, splitMode: alphaRecordRestored ? alphaRecordRestored.splitMode : null };
      expect(splitDisabled === false, `disabling split review on A returned ${splitDisabled}`);
      expect(alphaRecordRestored && alphaRecordRestored.splitMode === false, 'A\'s tab split review was not disarmed');
    } finally {
      try {
        if (tabRecord(alphaTab)?.splitMode) {
          court.hostForOwner(alphaKey)?.toggleSplitReview(alphaTab, false);
        }
      } catch {}
    }
  });

  // ------------------------------------------------------------------ R5b: background capture readiness
  await automated('R5b', async (row) => {
    court.windowFor(alphaKey).focus();
    await sleep(250);
    const foregroundBefore = foregroundId();
    const betaFocusBefore = court.windowFor(betaKey).isFocused();
    const envelope = await bounded(
      betaHost.captureVerificationScreenshot(undefined, betaAnchorTab, 'desktop', { format: 'png' }),
      40000,
      'background capture of B',
    );
    const betaFocusAfter = court.windowFor(betaKey).isFocused();
    row.observed = {
      foregroundBefore,
      foregroundAfter: foregroundId(),
      betaFocusBefore,
      betaFocusAfter,
      envelope: {
        backend: envelope.backend,
        dpr: envelope.dpr,
        zoom: envelope.zoom,
        cssViewport: envelope.cssViewport,
        cssCaptureSize: envelope.cssCaptureSize,
        rasterSize: envelope.rasterSize,
        captureMode: envelope.captureMode,
        dataLength: typeof envelope.data === 'string' ? envelope.data.length : 0,
      },
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [betaAnchorTab],
      foregroundBefore,
      foregroundAfter: foregroundId(),
    };
    expect(typeof envelope.data === 'string' && envelope.data.length > 1000, `the capture returned ${typeof envelope.data === 'string' ? envelope.data.length : 0} bytes of image data`);
    expect(envelope.cssViewport && envelope.cssViewport.width > 0 && envelope.cssViewport.height > 0, `the capture reports no viewport: ${JSON.stringify(envelope.cssViewport)}`);
    expect(envelope.rasterSize && envelope.rasterSize.width > 0, `the capture reports no raster: ${JSON.stringify(envelope.rasterSize)}`);
    expect(betaFocusAfter === false, 'capturing B\'s background tab focused B\'s window');
    if (foregroundBefore !== null) {
      expect(foregroundId() === foregroundBefore, `the foreground window changed from ${foregroundBefore} to ${String(foregroundId())} during a background capture`);
    }
  });

  // ------------------------------------------------------------------ R11: no manufactured isolation
  await automated('R11', async (row) => {
    const alphaHost = court.hostForOwner(alphaKey);
    const betaHostNow = court.hostForOwner(betaKey);
    const partitionNow = alphaHost.getLivePartitionNames();
    const sessionIdentity = {};
    for (const [tabId, sessionBefore] of state.beforeSecondWindow.sessionRefs.entries()) {
      const sessionNow = alphaHost.getTabSession(tabId) ?? null;
      const recordNow = tabRecord(tabId);
      sessionIdentity[tabId] = {
        sameLiveSessionObject: Boolean(sessionBefore) && sessionNow === sessionBefore,
        sessionPresent: Boolean(sessionNow),
        partitionBefore: (state.beforeSecondWindow.records.find((entry) => entry.tabId === tabId) || {}).partition ?? null,
        partitionNow: recordNow ? recordNow.partition : null,
        partitionNamesForSession: sessionNow && typeof sessionNow.getStoragePath === 'function' ? (() => { try { return sessionNow.getStoragePath() || null; } catch { return null; } })() : null,
      };
    }
    row.observed = {
      alphaPartitionsBeforeSecondWindow: state.beforeSecondWindow.partitions,
      alphaPartitionsNow: partitionNow,
      betaPartitions: betaHostNow.getLivePartitionNames(),
      sessionIdentity,
      betaTabRecords: (snapshot().find((entry) => entry.ownerKey === betaKey)?.tabIds ?? []).map((tabId) => tabRecord(tabId)).filter(Boolean),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: Object.keys(sessionIdentity),
      projectIds: [ALPHA.projectId, BETA.projectId],
      workspaceIds: [ALPHA.workspaceId, BETA.workspaceId],
    };
    expect(JSON.stringify(partitionNow) === JSON.stringify(state.beforeSecondWindow.partitions), `opening B changed A's live partitions from ${JSON.stringify(state.beforeSecondWindow.partitions)} to ${JSON.stringify(partitionNow)}`);
    for (const [tabId, identity] of Object.entries(sessionIdentity)) {
      expect(identity.sessionPresent, `tab ${tabId} lost its session when the second window opened`);
      expect(identity.sameLiveSessionObject, `tab ${tabId} moved to a different live Session object when the second window opened`);
      expect(identity.partitionNow === identity.partitionBefore, `tab ${tabId} moved partition from '${String(identity.partitionBefore)}' to '${String(identity.partitionNow)}'`);
    }
  });

  // ------------------------------------------------------------------ R10a: session end preserves page + input
  await automated('R10a', async (row) => {
    const alphaHost = court.hostForOwner(alphaKey);
    const alphaLoaded = await bounded(alphaHost.navigateAndWait(alphaTab, baseUrl('/alpha')), 20000, 'alpha page fresh load');
    expect(alphaLoaded === true, 'window A\'s page did not load from the local origin');
    const emptyBefore = await alphaPage.executeJavaScript("(() => { const el = document.getElementById('field'); return el ? el.value : null; })()", true);
    expect(emptyBefore === '', `expected field to be empty after fresh load, got '${String(emptyBefore)}'`);

    const fieldFocus = await alphaPage.executeJavaScript("(() => { const el = document.getElementById('field'); if (!el) return false; el.focus(); return document.activeElement === el; })()", true);
    expect(fieldFocus === true, 'window A\'s input could not be focused');
    typeText(alphaPage, 'dang-go-form-state');
    await sleep(150);
    const typed = await alphaPage.executeJavaScript("document.getElementById('field').value", true);
    expect(typed === 'dang-go-form-state', `the page input read back as '${String(typed)}' before the session ended`);

    let sessionAttachment = null;
    let sessionRevoked = false;
    let mainError = null;
    try {
      sessionAttachment = await mintAttachment({ project: ALPHA, tabId: alphaTab });
      await planeOf().runs.attachments.revokeAttachment(sessionAttachment.attachmentId);
      sessionRevoked = true;
      await sleep(300);

      const stillListed = (entryFor(alphaKey)?.tabIds ?? []).includes(alphaTab);
      const stillAlive = !alphaPage.isDestroyed();
      const valueAfter = stillAlive ? await alphaPage.executeJavaScript("document.getElementById('field').value", true) : null;
      const urlAfter = stillAlive ? await alphaPage.executeJavaScript('location.href', true) : null;
      const staleRetry = dispatchFact(await dispatchCapability(sessionAttachment, 'browser.navigate', { url: baseUrl('/alpha?stale=1'), tabId: alphaTab }));
      await sleep(200);
      const urlAfterRetry = stillAlive && !alphaPage.isDestroyed() ? await alphaPage.executeJavaScript('location.href', true) : null;
      const otherWindowsClaim = snapshot()
        .filter((entry) => entry.ownerKey !== alphaKey)
        .filter((entry) => entry.tabIds.includes(alphaTab))
        .map((entry) => entry.ownerKey);

      row.observed = {
        emptyBefore,
        typed,
        stillListed,
        stillAlive,
        valueAfter,
        urlAfter,
        staleRetry,
        urlAfterRetry,
        otherWindowsClaimingTheTab: otherWindowsClaim,
        alphaHostStillOwnsTheTab: Boolean(court.hostForOwner(alphaKey)?.hasExactTab(alphaTab)),
      };
      row.ids = {
        windowIds: windowIdsOf([alphaKey, betaKey]),
        tabIds: [alphaTab],
        attachmentRevisionBefore: attachmentState(sessionAttachment.attachmentId),
        attachmentRevisionAfter: attachmentState(sessionAttachment.attachmentId),
        foregroundBefore: foregroundId(),
        foregroundAfter: foregroundId(),
      };
      expect(stillListed, 'the session ending removed A\'s user-visible tab');
      expect(stillAlive, 'the session ending destroyed A\'s page');
      expect(valueAfter === 'dang-go-form-state', `the typed input state was lost (read back '${String(valueAfter)}')`);
      expect(otherWindowsClaim.length === 0, `another window claimed the page: ${JSON.stringify(otherWindowsClaim)}`);
      expect(staleRetry.ok === false, `a revoked attachment still executed work: ${JSON.stringify(staleRetry)}`);
      expect(urlAfterRetry === urlAfter, `the stale target was routed anyway: '${String(urlAfter)}' -> '${String(urlAfterRetry)}'`);
    } catch (err) {
      mainError = err;
    } finally {
      if (sessionAttachment?.attachmentId && !sessionRevoked) {
        try { await planeOf().runs.attachments.revokeAttachment(sessionAttachment.attachmentId); } catch {}
      }
      const postRelease = attachmentState(sessionAttachment?.attachmentId);
      const stillAlive = postRelease && postRelease.present && postRelease.state !== 'revoked';
      expect(!stillAlive, `a live attachment remained on A's tab after R10a exited: ${JSON.stringify(postRelease)}`);
      if (mainError) throw mainError;
    }
  });

  // ------------------------------------------------------------------ R10b: real transport drop
  await automated('R10b', async (row) => {
    let transportAttachment = null;
    let released = false;
    let socket = null;
    let freshSocket = null;
    let mainError = null;
    try {
      const alphaHost = court.hostForOwner(alphaKey);
      const alphaLoaded = await bounded(alphaHost.navigateAndWait(alphaTab, baseUrl('/alpha')), 20000, 'alpha page fresh load for transport drop');
      expect(alphaLoaded === true, 'window A\'s page did not reload from local origin');
      const emptyBefore = await alphaPage.executeJavaScript("(() => { const el = document.getElementById('field'); return el ? el.value : null; })()", true);
      expect(emptyBefore === '', `expected field to be empty after fresh load, got '${String(emptyBefore)}'`);

      transportAttachment = await mintAttachment({ project: ALPHA, tabId: alphaTab });
      socket = await openBridgeSocket(transportAttachment.secret);
      // A real capability call over the real socket, so the transport is proven live before it drops.
      const before = await bridgeCall(socket, 'bridge-1', {
        attachmentId: transportAttachment.attachmentId,
        attachmentSecret: transportAttachment.secret,
        authorityRevision: transportAttachment.authorityRevision,
        name: 'browser.list-tabs',
        params: {},
      });
      const fieldFocus = await alphaPage.executeJavaScript("(() => { const el = document.getElementById('field'); if (!el) return false; el.focus(); return document.activeElement === el; })()", true);
      expect(fieldFocus === true, 'window A\'s input could not be focused');
      typeText(alphaPage, 'dang-go-form-state-transport-drop');
      await sleep(150);
      const typed = await alphaPage.executeJavaScript("document.getElementById('field').value", true);
      expect(typed === 'dang-go-form-state-transport-drop', `the page input read back as '${String(typed)}' before the drop`);

      const tabsBefore = [...(entryFor(alphaKey)?.tabIds ?? [])];
      // The abrupt drop: a TCP reset on the client's side, with no closing handshake.
      socket.terminate();
      await sleep(500);

      const tabsAfter = entryFor(alphaKey)?.tabIds ?? [];
      const pageAlive = !alphaPage.isDestroyed();
      const valueAfter = pageAlive ? await alphaPage.executeJavaScript("document.getElementById('field').value", true) : null;
      const windowStillOwns = Boolean(court.hostForOwner(alphaKey)?.hasExactTab(alphaTab));
      const inventory = await searchFrom(alphaToolbar, 'Matrix Alpha Page');
      freshSocket = await openBridgeSocket(transportAttachment.secret);
      const after = await bridgeCall(freshSocket, 'bridge-2', {
        attachmentId: transportAttachment.attachmentId,
        attachmentSecret: transportAttachment.secret,
        authorityRevision: transportAttachment.authorityRevision,
        name: 'browser.list-tabs',
        params: {},
      });
      freshSocket.terminate();
      const socketState = { readyState: socket.readyState, destroyed: socket.readyState === 3 };

      row.observed = {
        callBeforeDrop: { success: before.success, error: before.error ?? null, hasData: Boolean(before.data) },
        callAfterReconnect: { success: after.success, error: after.error ?? null, hasData: Boolean(after.data) },
        emptyBefore,
        typedBeforeDrop: typed,
        typedAfterDrop: valueAfter,
        tabsBefore,
        tabsAfter,
        pageAlive,
        windowStillOwnsTab: windowStillOwns,
        tabStillListedForUser: (inventory.rows || []).some((rowItem) => rowItem.tabId === alphaTab),
        socketState,
        windowCount: snapshot().length,
      };
      row.ids = {
        windowIds: windowIdsOf([alphaKey, betaKey]),
        tabIds: [alphaTab],
        projectIds: [ALPHA.projectId],
        workspaceIds: [ALPHA.workspaceId],
        attachmentRevisionBefore: attachmentState(transportAttachment.attachmentId),
        attachmentRevisionAfter: attachmentState(transportAttachment.attachmentId),
        foregroundBefore: foregroundId(),
        foregroundAfter: foregroundId(),
      };
      expect(before.success === true, `the bridge transport was not usable before the drop: ${JSON.stringify(before)}`);
      expect(socketState.destroyed, `the socket did not drop (readyState ${socketState.readyState})`);
      expect(pageAlive, 'the in-page document did not survive the transport drop');
      expect(valueAfter === 'dang-go-form-state-transport-drop', `the in-page form value was lost across the drop (read back '${String(valueAfter)}')`);
      expect(JSON.stringify(tabsAfter) === JSON.stringify(tabsBefore), `the window's tabs changed across the drop: ${JSON.stringify(tabsBefore)} -> ${JSON.stringify(tabsAfter)}`);
      expect(windowStillOwns, 'the window no longer resolves its own tab after the drop');
      expect(row.observed.tabStillListedForUser, 'the tab disappeared from the user-visible inventory after the drop');
      expect(after.success === true, `a fresh transport could not reconnect and work: ${JSON.stringify(after)}`);
    } catch (err) {
      mainError = err;
    } finally {
      if (socket && socket.readyState !== 3) {
        try { socket.terminate(); } catch {}
      }
      if (freshSocket && freshSocket.readyState !== 3) {
        try { freshSocket.terminate(); } catch {}
      }
      if (transportAttachment?.attachmentId) {
        try {
          await planeOf().runs.attachments.revokeAttachment(transportAttachment.attachmentId);
          released = true;
        } catch {}
      }
      const postReleaseState = attachmentState(transportAttachment?.attachmentId);
      const stillAlive = postReleaseState && postReleaseState.present && postReleaseState.state !== 'revoked';
      expect(!stillAlive, `a live attachment remained on A's tab after R10b exited: ${JSON.stringify(postReleaseState)}`);
      if (mainError) throw mainError;
    }
    expect(released === true, 'the transport attachment on A\'s tab was not released');
  });

  // ------------------------------------------------------------------ R12a: 960x640 layout + keyboard
  const alphaWindowRef = court.windowFor(alphaKey);
  await automated('R12a', async (row) => {
    if (!rendererBundlePresent) {
      row.status = 'BLOCKED';
      row.reason = `this build root (${compiledRoot}) ships no renderer bundle (src/renderer/toolbar.js + toolbar.html), so the chrome DOM cannot be observed; run against the output of \`npm run compile\``;
      row.observed = { compiledRoot, rendererBundlePresent };
      return;
    }
    const shell = court.shellFor(alphaKey);
    const display = shell?.getDisplayInfo();
    const area = display ? display.workArea : screen.getPrimaryDisplay().workArea;
    alphaWindowRef.unmaximize();
    alphaWindowRef.setBounds({ x: area.x + 10, y: area.y + 10, width: 960, height: 640 });
    await sleep(500);
    shell?.refreshDisplayInfo();
    // A published tab with no device preset and no split: its native view is the shipping
    // "whole content area below the chrome" box that this row's rule describes.
    const plainTab = await createTabViaToolbar(alphaToolbar, 'about:blank');
    expect(typeof plainTab === 'string' && plainTab.length > 0, 'a plain tab could not be created for the layout row');
    state.plainTab = plainTab;
    await waitFor(() => Boolean(pageOf(plainTab)), 'the plain tab page', 15000).catch(() => null);
    await sleep(400);
    const native = nativeLayout(alphaKey, plainTab);
    const layout = await chromeLayout(alphaToolbar);
    row.observed = {
      windowBounds: { ...alphaWindowRef.getBounds() },
      requestedOuterSize: { width: 960, height: 640 },
      display,
      plainTab,
      native,
      layout,
    };
    row.ids = { windowIds: windowIdsOf([alphaKey]), tabIds: [plainTab, alphaTab], foregroundBefore: foregroundId(), foregroundAfter: foregroundId() };

    expect(native.contentBounds.width > 0 && native.contentBounds.height > 0, `the window reports no content box: ${JSON.stringify(native.contentBounds)}`);
    expect(native.contentBounds.width <= 960 && native.contentBounds.height <= 640, `the content box ${JSON.stringify(native.contentBounds)} exceeds the requested outer size`);
    expect(native.contentBounds.width >= 880 && native.contentBounds.height >= 560, `the window did not take the requested 960x640 size: content box ${JSON.stringify(native.contentBounds)}`);
    expect(native.toolbarHeight > 0, `the toolbar reports height ${String(native.toolbarHeight)}`);
    expect(native.geometry && native.geometry.availableHeight > 0, `the content geometry is ${JSON.stringify(native.geometry)}`);
    // Two independent surfaces describe the same box: the chrome renderer's own viewport must
    // agree with the measured native geometry, so a chrome that drew outside its view is caught.
    expect(layout.viewport.width === native.geometry.availableWidth, `the toolbar viewport is ${layout.viewport.width}px wide but the native geometry says ${native.geometry.availableWidth}px`);
    expect(layout.viewport.height === native.toolbarHeight, `the toolbar viewport is ${layout.viewport.height}px tall but the toolbar layout says ${native.toolbarHeight}px`);
    // The chrome strip is the top band: its own rect matches the toolbar height and stays inside.
    expect(native.toolbarRect, 'the toolbar view reports no native rect');
    expect(native.toolbarRect.height === native.toolbarHeight, `the toolbar view is ${native.toolbarRect.height}px tall but the layout says ${native.toolbarHeight}px`);
    expect(native.toolbarRect.y === 0, `the toolbar view starts at y=${native.toolbarRect.y}, not at the top of the content box`);
    expect(native.toolbarRect.width === native.geometry.availableWidth, `the toolbar view is ${native.toolbarRect.width}px wide but the geometry says ${native.geometry.availableWidth}px`);
    expect(native.toolbarRect.width <= native.contentBounds.width, `the toolbar view (${native.toolbarRect.width}px) is wider than the content box (${native.contentBounds.width}px)`);
    // The native tab view starts exactly at the toolbar's bottom edge and never inside the chrome.
    expect(native.pageRect, 'the active tab reports no native rect');
    expect(native.pageRect.y === native.toolbarHeight, `the native tab view starts at y=${native.pageRect.y}; the chrome strip ends at y=${native.toolbarHeight}`);
    expect(native.pageRect.y + native.pageRect.height <= native.contentBounds.height, `the tab view (y=${native.pageRect.y}, height=${native.pageRect.height}) runs past the content box (${native.contentBounds.height}px)`);
    expect(native.pageRect.x === 0, `the tab view starts at x=${native.pageRect.x}, not at the content box's left edge`);
    expect(native.pageRect.width === native.geometry.availableWidth, `the tab view is ${native.pageRect.width}px wide but the content geometry offers ${native.geometry.availableWidth}px`);
    const expectedPageHeight = native.geometry.availableHeight;
    expect(Math.abs(native.pageRect.height - expectedPageHeight) <= 2, `the tab view is ${native.pageRect.height}px tall but the content area below the chrome is ${expectedPageHeight}px`);
    // The chrome's own DOM: inside its viewport, no clipping, and no two unrelated controls
    // whose boxes intersect.
    expect(layout.laidOutCount >= 5, `only ${layout.laidOutCount} of the measured controls are laid out: ${JSON.stringify(layout.rects)}`);
    expect(layout.clippedHorizontally.length === 0, `controls are clipped horizontally at this size: ${JSON.stringify(layout.clippedHorizontally)}`);
    expect(layout.clippedVertically.length === 0, `controls are clipped vertically at this size: ${JSON.stringify(layout.clippedVertically)}`);
    expect(layout.collisions.length === 0, `controls collide with each other: ${JSON.stringify(layout.collisions)}`);
    expect(String(layout.chipTitle).startsWith('Matrix Storefront'), `the project chip reads '${String(layout.chipTitle)}'`);
    expect(typeof layout.chipPath === 'string' && layout.chipPath.toLowerCase().includes('alpha'), `the project chip path is '${String(layout.chipPath)}'`);

    // The keyboard contract of the search control, driven with real key events.
    const opened = await alphaToolbar.executeJavaScript("(() => { const el = document.getElementById('btnTabSearch'); if (!el) return false; el.click(); return true; })()", true);
    expect(opened === true, 'the tab-search control could not be activated');
    const openLayout = await waitFor(
      async () => {
        const probe = await chromeLayout(alphaToolbar);
        return probe.tabSearchDisplay === 'flex' ? probe : false;
      },
      'the tab-search overlay to open',
    );
    row.observed.overlayOpen = { overlay: openLayout.overlay, panel: openLayout.overlayPanel, viewport: openLayout.viewport };
    expect(openLayout.overlay && openLayout.overlay.x >= 0 && openLayout.overlay.right <= openLayout.viewport.width + 1, `the search overlay is outside the 960px viewport: ${JSON.stringify(openLayout.overlay)}`);
    await sleep(400);
    // What the page actually received, recorded from the page itself: an overlay that stays open
    // after Escape is either a renderer that never saw the key or a close path that failed, and the
    // trail tells the two apart instead of leaving it to assumption.
    const recorderInstalled = await bounded(
      alphaToolbar.executeJavaScript("(() => { window.__matrixKeyTrail = []; document.addEventListener('keydown', (event) => { window.__matrixKeyTrail.push(event.key); }, true); return true; })()", true),
      10000,
      'install the key trail recorder in the toolbar page',
    ).catch(() => null);
    expect(recorderInstalled === true, 'the toolbar page could not record its own key events');
    typeText(alphaToolbar, 'Matrix');
    const withRows = await waitFor(
      async () => {
        const probe = await chromeLayout(alphaToolbar);
        return probe.tabSearchRowCount > 1 ? probe : false;
      },
      'the search rows to render for a literal query',
      15000,
    );
    row.observed.overlayWithRows = { rowCount: withRows.tabSearchRowCount, layerState: withRows.tabSearchState, status: withRows.tabSearchStatus, rowsOutsideOverlay: withRows.rowsOutsideOverlay, firstRows: withRows.overlayRows.slice(0, 3) };
    expect(withRows.tabSearchState === 'results', `the search layer state is '${String(withRows.tabSearchState)}'`);
    expect(withRows.rowsOutsideOverlay === 0, `${String(withRows.rowsOutsideOverlay)} search rows extend past the overlay's own box`);
    pressKey(alphaToolbar, 'Down');
    const highlighted = await waitFor(
      async () => {
        const probe = await chromeLayout(alphaToolbar);
        return probe.tabSearchActiveDescendant ? probe : false;
      },
      'the arrow key to highlight a search row',
      8000,
    ).catch(() => null);
    row.observed.afterArrowDown = highlighted ? { activeDescendant: highlighted.tabSearchActiveDescendant } : null;
    expect(highlighted, 'ArrowDown did not move the search highlight');
    pressKey(alphaToolbar, 'Escape');
    const closed = await waitFor(
      async () => {
        const probe = await chromeLayout(alphaToolbar);
        return probe.tabSearchDisplay === 'none' ? probe : false;
      },
      'Escape to close the search overlay',
      8000,
    ).catch(() => null);
    const keyTrail = await bounded(alphaToolbar.executeJavaScript('window.__matrixKeyTrail || null', true), 10000, 'read the key trail from the toolbar page').catch(() => null);
    row.observed.keyTrail = keyTrail;
    row.observed.afterEscape = closed ? { activeElementId: closed.activeElementId, keyTrail } : { keyTrail };
    expect(closed, `Escape did not close the search overlay (keys the page received: ${JSON.stringify(keyTrail)})`);
    expect(closed.activeElementId === 'btnTabSearch', `Escape left focus on '${String(closed.activeElementId)}', not on the search control`);
  });

  // ------------------------------------------------------------------ R12b: maximized/wide
  await automated('R12b', async (row) => {
    if (!rendererBundlePresent) {
      row.status = 'BLOCKED';
      row.reason = `this build root (${compiledRoot}) ships no renderer bundle, so the chrome DOM cannot be observed; run against the output of \`npm run compile\``;
      row.observed = { compiledRoot, rendererBundlePresent };
      return;
    }
    alphaWindowRef.maximize();
    await waitFor(() => alphaWindowRef.isMaximized() === true, 'window A to maximize', 8000).catch(() => null);
    await sleep(600);
    court.shellFor(alphaKey)?.refreshDisplayInfo();
    const shell = court.shellFor(alphaKey);
    const display = shell?.getDisplayInfo();
    const plainTab = state.plainTab;
    expect(plainTab, 'the plain layout tab from the 960x640 row is gone');
    const native = nativeLayout(alphaKey, plainTab);
    const layout = await chromeLayout(alphaToolbar);
    const bounds = { ...alphaWindowRef.getBounds() };
    row.observed = { maximized: alphaWindowRef.isMaximized(), bounds, display, plainTab, native, layout };
    row.ids = { windowIds: windowIdsOf([alphaKey]), tabIds: [plainTab], foregroundBefore: foregroundId(), foregroundAfter: foregroundId() };

    expect(alphaWindowRef.isMaximized() === true, 'window A did not maximize');
    expect(native.geometry && native.geometry.availableHeight > 0, `the maximized content geometry is ${JSON.stringify(native.geometry)}`);
    expect(native.pageRect, 'the active tab reports no native rect when maximized');
    expect(native.pageRect.y === native.toolbarHeight, `the native tab view starts at y=${native.pageRect.y} while the chrome strip ends at y=${String(native.toolbarHeight)}`);
    expect(native.pageRect.y + native.pageRect.height <= native.contentBounds.height, `the tab view runs past the content box when maximized (${JSON.stringify(native.pageRect)} vs ${JSON.stringify(native.contentBounds)})`);
    expect(native.pageRect.width === native.geometry.availableWidth, `the tab view is ${native.pageRect.width}px wide but the maximized geometry offers ${native.geometry.availableWidth}px`);
    expect(layout.viewport.width === native.geometry.availableWidth, `the toolbar viewport is ${layout.viewport.width}px wide but the native geometry says ${native.geometry.availableWidth}px`);
    expect(layout.viewport.height === native.toolbarHeight, `the toolbar viewport is ${layout.viewport.height}px tall but the toolbar layout says ${native.toolbarHeight}px`);
    expect(layout.clippedHorizontally.length === 0, `controls are clipped horizontally when maximized: ${JSON.stringify(layout.clippedHorizontally)}`);
    expect(layout.clippedVertically.length === 0, `controls are clipped vertically when maximized: ${JSON.stringify(layout.clippedVertically)}`);
    expect(layout.collisions.length === 0, `controls collide with each other when maximized: ${JSON.stringify(layout.collisions)}`);
    expect(layout.laidOutCount >= 5, `only ${layout.laidOutCount} toolbar controls are laid out when maximized`);
    expect(String(layout.chipTitle).startsWith('Matrix Storefront'), `the project chip reads '${String(layout.chipTitle)}' when maximized`);
    expect(display, 'the maximized window reports no display');
    if (display) {
      // A maximized window fills the monitor's *work* area, not its full bounds: the taskbar is not
      // covered. On Windows the outer rect additionally carries the platform's invisible resize
      // border, which reaches a few pixels past the work area on every edge, so the comparison is
      // against the work area with that border as the tolerance.
      const border = 16;
      const coversWorkArea = bounds.x <= display.workArea.x + border && bounds.y <= display.workArea.y + border
        && bounds.x + bounds.width >= display.workArea.x + display.workArea.width - border
        && bounds.y + bounds.height >= display.workArea.y + display.workArea.height - border;
      expect(coversWorkArea, `the maximized window ${JSON.stringify(bounds)} does not cover the work area ${JSON.stringify(display.workArea)}`);
      const content = native.contentBounds;
      expect(content.x === display.workArea.x && content.width === display.workArea.width, `the maximized content box ${JSON.stringify(content)} does not span the work area ${JSON.stringify(display.workArea)} horizontally`);
      expect(Math.abs(content.y + content.height - (display.workArea.y + display.workArea.height)) <= 2, `the maximized content box ends at y=${content.y + content.height}, not at the work area's bottom edge ${display.workArea.y + display.workArea.height}`);
      expect(content.y >= display.bounds.y && content.y + content.height <= display.bounds.y + display.bounds.height, `the maximized content box ${JSON.stringify(content)} leaves the display ${JSON.stringify(display.bounds)}`);
    }
    // Back to a normal window for the rows that follow.
    alphaWindowRef.unmaximize();
    await sleep(300);
  });

  // ------------------------------------------------------------------ R6a + R4d: bounds restore across reopen
  await automated('R6a', async (row) => {
    const display = court.shellFor(alphaKey)?.getDisplayInfo();
    const area = display ? display.workArea : screen.getPrimaryDisplay().workArea;
    const target = { x: area.x + 60, y: area.y + 60, width: 1024, height: 700 };
    alphaWindowRef.unmaximize();
    await sleep(300);
    alphaWindowRef.setBounds(target);
    await sleep(600);
    const persisted = await waitFor(
      () => (windowStateRecord(alphaKey) && windowStateRecord(alphaKey).normal && windowStateRecord(alphaKey).normal.width === 1024 ? windowStateRecord(alphaKey) : false),
      `window A's normal bounds to reach '${windowStatePath}'`,
      15000,
    ).catch(() => null);

    const alphaTabsBefore = [...(entryFor(alphaKey)?.tabIds ?? [])];
    const requestClose = court.requestClose(alphaKey);
    const closedShell = await waitFor(() => (entryFor(alphaKey) ? false : true), 'window A to close', 20000).catch(() => false);
    const shellCountAfterClose = snapshot().length;
    // Recorded before the reopen is attempted: a row that fails at the next await must still carry
    // what it already knew, or one failure reads as an unexplained timeout and the rows behind it
    // as unrelated reds.
    row.observed.closeOutcome = {
      requestClose,
      closedShell,
      shellCountAfterClose,
      reservations: court.reservations(),
      alphaStillPresent: entryFor(alphaKey) !== null,
      alphaSidebarDestroyed: alphaSidebar.isDestroyed(),
    };

    // A is closed at this point, so the reopen is invoked from a window that is still alive — what a
    // user actually has available. Invoking it from A's own destroyed chrome would exercise the
    // harness's stale handle instead of the app's open path.
    const liveSidebar = await sidebarFor(betaKey);
    const reopened = await openProject(liveSidebar, ALPHA.projectId);
    const alphaEntryAfter = await waitFor(
      () => snapshot().find((entry) => entry.ownerKey === alphaKey) || false,
      'window A to reopen',
    );
    await waitFor(() => (entryFor(alphaKey)?.tabIds ?? []).length > 0, 'A\'s tabs to restore', 20000).catch(() => null);
    await sleep(500);
    const restoredBounds = { ...court.windowFor(alphaKey).getBounds() };
    const restoredRecords = (entryFor(alphaKey)?.tabIds ?? []).map((tabId) => tabRecord(tabId)).filter(Boolean);

    row.observed = {
      ...row.observed,
      target,
      savedOwnerRecord: persisted,
      windowStateFile: windowStatePath,
      requestClose,
      closedShell,
      shellCountAfterClose,
      reopened,
      alphaTabsBefore,
      alphaTabsAfter: alphaEntryAfter.tabIds,
      restoredBounds,
      restoredRecords,
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [...new Set([...alphaTabsBefore, ...(alphaEntryAfter.tabIds ?? [])])],
      projectIds: [ALPHA.projectId],
      workspaceIds: [ALPHA.workspaceId],
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(requestClose === true, 'the close request never reached window A');
    expect(closedShell === true, `window A did not close (shell count ${shellCountAfterClose})`);
    expect(reopened && reopened.status === 'OPENED', `reopening A returned ${JSON.stringify(reopened)}`);
    expect(persisted, `window A's normal bounds were not persisted for '${alphaKey}' in ${windowStatePath}`);
    expect(restoredBounds.width === 1024 && restoredBounds.height === 700, `the reopened window is ${restoredBounds.width}x${restoredBounds.height}, not the saved 1024x700`);
    expect(Math.abs(restoredBounds.x - target.x) <= 2 && Math.abs(restoredBounds.y - target.y) <= 2, `the reopened window sits at ${restoredBounds.x},${restoredBounds.y}, not at the saved ${target.x},${target.y}`);

    // R4d rides on the same reopen: restored tabs return to their own window with their own
    // affiliation, and no other window inherited them.
    const alphaRestoredIds = new Set(alphaEntryAfter.tabIds ?? []);
    const leakedIntoBeta = (entryFor(betaKey)?.tabIds ?? []).filter((tabId) => alphaTabsBefore.includes(tabId));
    await automated('R4d', async (restoreRow) => {
      // Restoring a window recreates its tabs and persists them on the host's debounce, so the owner
      // record is awaited until it carries them instead of read once against a moving file.
      const persistedRestored = await waitFor(
        () => {
          const ids = savedTabIds(alphaKey).filter((tabId) => alphaRestoredIds.has(tabId));
          return ids.length > 0 ? ids : false;
        },
        `A's restored tabs to reach the saved-tabs record for '${alphaKey}'`,
        12000,
      ).catch(() => []);
      const otherOwners = Object.keys(readSavedTabsDocument()?.owners ?? {})
        .filter((key) => key !== alphaKey && savedTabIds(key).some((tabId) => alphaRestoredIds.has(tabId)));
      restoreRow.observed = {
        restoredTabIds: [...alphaRestoredIds],
        restoredRecords,
        persistedUnderOwner: persistedRestored,
        ownersClaimingRestoredTabs: otherOwners,
        expectedOwnerKey: alphaKey,
        leakedIntoBeta,
      };
      restoreRow.ids = {
        windowIds: windowIdsOf([alphaKey, betaKey]),
        tabIds: [...alphaRestoredIds],
        projectIds: [ALPHA.projectId],
        workspaceIds: [ALPHA.workspaceId],
      };
      expect(alphaRestoredIds.size > 0, 'window A restored no tabs, so restore affiliation cannot be judged');
      expect(leakedIntoBeta.length === 0, `window B inherited A's pages: ${JSON.stringify(leakedIntoBeta)}`);
      for (const record of restoredRecords) {
        expect(record.windowOwnerKey === alphaKey, `restored tab ${record.tabId} resolves to host '${record.windowOwnerKey}', not A's '${alphaKey}'`);
      }
      expect(persistedRestored.length > 0, `no restored tab of A is recorded under '${alphaKey}': ${JSON.stringify(alphaRestoredIds)}`);
      expect(otherOwners.length === 0, `another owner record claims A's restored tabs: ${JSON.stringify(otherOwners)}`);
    });
  });

  // ------------------------------------------------------------------ R7: idle A close preserves B
  await automated('R7', async (row) => {
    const betaHostNow = court.hostForOwner(betaKey);
    expect(betaHostNow, 'window B lost its host before the close row');
    const terminalSessionId = await planeOf().terminal.createSession(BETA.path, BETA.capsuleId);
    expect(typeof terminalSessionId === 'string' && terminalSessionId.length > 0, 'no terminal session could be created for B');
    state.terminalSessionId = terminalSessionId;

    const terminal = planeOf().terminal;
    let sessionCapsule = null;
    if (typeof terminal.getSessionCapsule === 'function') {
      try { sessionCapsule = await terminal.getSessionCapsule(terminalSessionId); } catch {}
    }
    if (!sessionCapsule && typeof terminal.getSession === 'function') {
      try {
        const s = await terminal.getSession(terminalSessionId);
        sessionCapsule = s ? (s.capsuleId ?? null) : null;
      } catch {}
    }
    if (!sessionCapsule && typeof terminal.getDiagnostics === 'function') {
      try {
        const diag = await terminal.getDiagnostics();
        const s = diag?.sessions?.find?.((item) => (item.sessionId || item.id) === terminalSessionId);
        sessionCapsule = s ? (s.capsuleId ?? null) : null;
      } catch {}
    }
    expect(sessionCapsule === BETA.capsuleId, `the created terminal session's capsule provenance was '${String(sessionCapsule)}', expected '${BETA.capsuleId}'`);

    await sleep(400);
    const popoutOpened = betaHostNow.togglePopoutTerminal(terminalSessionId);
    await sleep(800);
    const auxiliariesBefore = auxiliaryWindows();
    const betaTabsBefore = [...(entryFor(betaKey)?.tabIds ?? [])];
    const betaActiveBefore = requireActiveTab(betaKey);
    const attachmentBefore = attachmentState(betaAgentAttachment.attachmentId);
    const listBefore = await planeOf().terminal.listSessions(true);
    const terminalBefore = (Array.isArray(listBefore) ? listBefore : []).map((session) => session.id ?? null).filter(Boolean);

    const requestClose = court.requestClose(alphaKey);
    const closedShell = await waitFor(() => (entryFor(alphaKey) ? false : true), 'window A to close', 20000).catch(() => false);
    await sleep(500);
    const betaHostAfter = court.hostForOwner(betaKey);
    const listAfter = await planeOf().terminal.listSessions(true);
    const terminalAfter = (Array.isArray(listAfter) ? listAfter : []).map((session) => session.id ?? null).filter(Boolean);
    const auxiliariesAfter = auxiliaryWindows();

    row.observed = {
      requestClose,
      closedShell,
      terminalSessionId,
      sessionCapsule,
      popoutOpened,
      auxiliariesBefore,
      auxiliariesAfter,
      betaTabsBefore,
      betaTabsAfter: entryFor(betaKey)?.tabIds ?? [],
      betaActiveBefore,
      betaActiveAfter: requireActiveTab(betaKey),
      terminalBefore,
      terminalAfter,
      attachmentRevisionBefore: attachmentBefore,
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      closeReport: court.lastCloseReport(alphaKey),
      servicesAnswer: Boolean(planeOf().chats.create(ALPHA.projectId, ALPHA.workspaceId, 'matrix: services still alive').id),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [...betaTabsBefore, alphaTab],
      attachmentRevisionBefore: attachmentBefore,
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(requestClose === true, 'the close request never reached window A');
    expect(closedShell === true, 'idle window A did not close');
    expect(entryFor(alphaKey) === null, 'the closed window is still in the directory');
    expect(betaHostAfter, 'window B lost its host when A closed');
    expect(court.windowFor(betaKey) && !court.windowFor(betaKey).isDestroyed(), 'window B\'s native window was destroyed');
    expect(JSON.stringify(entryFor(betaKey)?.tabIds ?? []) === JSON.stringify(betaTabsBefore), `window B's tabs changed from ${JSON.stringify(betaTabsBefore)} to ${JSON.stringify(entryFor(betaKey)?.tabIds ?? [])}`);
    expect(requireActiveTab(betaKey) === betaActiveBefore, 'window B\'s active tab moved when A closed');
    expect(attachmentState(betaAgentAttachment.attachmentId).authorityRevision === attachmentBefore.authorityRevision, 'A\'s close rotated B\'s attachment authority revision');
    expect(terminalAfter.includes(terminalSessionId), `B's terminal session ${terminalSessionId} vanished when A closed (before: ${JSON.stringify(terminalBefore)})`);
    if (popoutOpened) {
      expect(auxiliariesAfter.length >= auxiliariesBefore.length, `a detached auxiliary window vanished when A closed: before ${JSON.stringify(auxiliariesBefore)}, after ${JSON.stringify(auxiliariesAfter)}`);
    } else {
      expect(auxiliariesAfter.length === auxiliariesBefore.length, `the auxiliary window set changed while no popout was open: ${JSON.stringify(auxiliariesAfter)}`);
      row.observed.auxiliaryNote = 'the terminal popout could not be opened in this environment, so the auxiliary-survival half of this row is unproven; the daemon/popout teardown half is judged in R9B/R9C';
    }
    expect(app.isReady() === true, 'the app is no longer ready after A closed');
  });

  // ------------------------------------------------------------------ R8a: unload veto
  const gammaOpen = await court.ensureProjectWindow({ kind: 'project', projectId: PROJECTS.gamma.projectId }, 'user');
  const gammaKey = gammaOpen.ownerKey;
  await automated('R8a', async (row) => {
    const gammaHost = court.hostForOwner(gammaKey);
    expect(gammaHost, 'the veto window has no host');
    const gammaToolbar = await toolbarFor(gammaKey);
    const plainGammaTab = await createTabViaToolbar(gammaToolbar, baseUrl('/veto?other=1'));
    expect(typeof plainGammaTab === 'string' && plainGammaTab.length > 0, 'the veto window created no companion tab');
    await sleep(300);
    const vetoTab = await createTabViaToolbar(gammaToolbar, baseUrl('/veto'));
    expect(typeof vetoTab === 'string' && vetoTab.length > 0, 'the vetoing tab was not created');
    // The veto is armed through the page's own window, so the tab must have committed a document: a
    // tab left on about:blank has none on this Electron build and would never answer the eval.
    await bounded(gammaHost.navigateAndWait(vetoTab, baseUrl('/veto')), 20000, 'load the vetoing page');
    await waitFor(() => {
      const page = pageOf(vetoTab);
      return Boolean(page && !page.isDestroyed() && page.getURL && page.getURL().startsWith('http'));
    }, 'the vetoing page to commit', 15000).catch(() => null);
    const vetoPage = pageOf(vetoTab);
    expect(vetoPage && !vetoPage.isDestroyed(), 'the vetoing tab has no page');
    const armed = await bounded(
      vetoPage.executeJavaScript("window.onbeforeunload = () => 'matrix: this page refuses to close'; typeof window.onbeforeunload", true),
      10000,
      'arm the unload veto in the freshly created tab',
    );
    expect(armed === 'function', `the unload veto was not armed (typeof was '${String(armed)}')`);
    const gammaTabsBefore = [...(entryFor(gammaKey)?.tabIds ?? [])];
    const report = await bounded(court.attemptClose(gammaKey, 'user'), 25000, 'close of the vetoing window');
    await sleep(250);
    const gammaEntryAfter = entryFor(gammaKey);
    row.observed = {
      vetoTab,
      gammaTabsBefore,
      gammaTabsAfter: gammaEntryAfter?.tabIds ?? null,
      report,
      reservations: court.reservations(),
    };
    row.ids = {
      windowIds: windowIdsOf([gammaKey, betaKey]),
      tabIds: gammaTabsBefore,
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(gammaEntryAfter, 'the shell vanished even though a page vetoed its close');
    expect(report.disposition === 'retained', `the close reported '${String(report.disposition)}'`);
    expect(report.haltedBy === 'unload-veto', `the close halted by '${String(report.haltedBy)}'`);
    expect(report.closed.length >= 1, `the close closed nothing before the veto: ${JSON.stringify(report.closed)}`);
    expect(report.closed.every((page) => gammaTabsBefore.includes(page.tabId)), `the close destroyed a page that was not this window's: ${JSON.stringify(report.closed)}`);
    expect(!report.closed.some((page) => page.tabId === vetoTab), 'the page that vetoed is reported as closed');
    expect(report.partial === true, 'the report does not mark the close as partial');
    expect(report.survivingTabIds.includes(vetoTab), `the vetoing page is not reported as surviving: ${JSON.stringify(report.survivingTabIds)}`);
    expect(gammaEntryAfter.tabIds.includes(vetoTab), `the vetoing page is gone from the shell: ${JSON.stringify(gammaEntryAfter.tabIds)}`);
    expect(!String(report.summary || '').includes('restored'), 'the report promised an undo of the closed page');
    const reservations = court.reservations();
    expect(reservations.reservedTabIds.length === 0 && reservations.applicationReserved === false, `the vetoed attempt left a reservation behind: ${JSON.stringify(reservations)}`);
    // Disarm so the window can be closed later; the veto was this row's subject. The call is
    // bounded because a frame Chromium left in a pending-close state after the veto can accept
    // the eval but never answer it. A failed disarm is NOT swallowed: every later close row would
    // then read a page that still vetoes, so the honest outcome is to fail this row loudly.
    let disarmError = null;
    try {
      await bounded(
        pageOf(vetoTab)?.executeJavaScript('window.onbeforeunload = null; true', true) ?? Promise.resolve(true),
        5000,
        'disarm the vetoing page'
      );
    } catch (error) {
      disarmError = error && error.message ? error.message : String(error);
    }
    row.observed.disarmSucceeded = disarmError === null;
    if (disarmError !== null) row.observed.disarmError = disarmError;
    expect(disarmError === null, `the vetoing page could not be disarmed (${disarmError}); a later close row would observe a page that still vetoes`);
  });

  // ------------------------------------------------------------------ R8b: arrival during close
  const deltaOpen = await court.ensureProjectWindow({ kind: 'project', projectId: PROJECTS.delta.projectId }, 'user');
  const deltaKey = deltaOpen.ownerKey;
  await automated('R8b', async (row) => {
    const deltaHost = court.hostForOwner(deltaKey);
    expect(deltaHost, 'the arrival window has no host');
    const deltaToolbar = await toolbarFor(deltaKey);
    for (let index = 0; index < 3; index += 1) {
      await createTabViaToolbar(deltaToolbar, 'about:blank');
      await sleep(150);
    }
    const attempt = bounded(court.attemptClose(deltaKey, 'user'), 25000, 'close with an arriving tab');
    const arrivalTab = deltaHost.createTab('about:blank');
    const report = await attempt;
    await sleep(300);
    const deltaEntryAfter = entryFor(deltaKey);
    row.observed = { arrivalTab, report, deltaTabsAfter: deltaEntryAfter?.tabIds ?? null, reservations: court.reservations() };
    row.ids = {
      windowIds: windowIdsOf([deltaKey, betaKey]),
      tabIds: [arrivalTab].filter(Boolean),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(typeof arrivalTab === 'string' && arrivalTab.length > 0, 'the arriving tab was not created');
    expect(deltaEntryAfter, 'the shell was destroyed under an arrival it did not account for');
    expect(deltaEntryAfter.tabIds.includes(arrivalTab), `the arriving tab is gone: ${JSON.stringify(deltaEntryAfter.tabIds)}`);
    expect(!report.closed.some((page) => page.tabId === arrivalTab), 'the arriving tab is reported as closed by the attempt it outlived');
    const reservations = court.reservations();
    expect(reservations.reservedTabIds.length === 0 && reservations.applicationReserved === false, `the retained attempt left a reservation behind: ${JSON.stringify(reservations)}`);
  });

  // ------------------------------------------------------------------ R8c: binding during unload
  const epsilonOpen = await court.ensureProjectWindow({ kind: 'project', projectId: PROJECTS.epsilon.projectId }, 'user');
  const epsilonKey = epsilonOpen.ownerKey;
  await automated('R8c', async (row) => {
    const epsilonHost = court.hostForOwner(epsilonKey);
    expect(epsilonHost, 'the reservation window has no host');
    const epsilonToolbar = await toolbarFor(epsilonKey);
    const reservedTab = await createTabViaToolbar(epsilonToolbar, 'about:blank');
    expect(typeof reservedTab === 'string' && reservedTab.length > 0, 'the tab to reserve was not created');
    await sleep(300);

    const attempt = bounded(court.attemptClose(epsilonKey, 'user'), 25000, 'close with a binding during unload');
    // The reservation is taken synchronously, before the attempt's first await: read it in the
    // same tick, then attempt the binding while the page is reserved.
    const reservedDuringAttempt = court.reservations();
    const lease = leaseForRunningRuntime(ALPHA, 60_000);
    const mintOutcome = await planeOf().runs.attachments
      .issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), ALPHA.projectId, ALPHA.workspaceId, {
        backendId: 'matrix-harness',
        lease,
        leaseToken: lease.token,
        tabId: reservedTab,
      })
      .then(
        (issued) => ({ admitted: true, attachmentId: issued && issued.launch ? issued.launch.attachmentId : undefined, code: null }),
        (err) => ({ admitted: false, attachmentId: undefined, code: err && err.code ? err.code : messageOf(err) }),
      );
    const report = await attempt;
    await sleep(200);
    if (mintOutcome.admitted && mintOutcome.attachmentId) {
      try { await planeOf().runs.attachments.revokeAttachment(mintOutcome.attachmentId); } catch {}
    }
    row.observed = {
      reservedTab,
      reservedDuringAttempt,
      mintOutcome,
      report,
      epsilonTabsAfter: entryFor(epsilonKey)?.tabIds ?? null,
      reservationsAfter: court.reservations(),
    };
    row.ids = {
      windowIds: windowIdsOf([epsilonKey, betaKey]),
      tabIds: [reservedTab],
      attachmentRevisionAfter: attachmentState(mintOutcome.attachmentId),
    };
    expect(reservedDuringAttempt.reservedTabIds.length > 0, `the attempt reserved nothing synchronously: ${JSON.stringify(reservedDuringAttempt)}`);
    expect(reservedDuringAttempt.reservedTabIds.includes(reservedTab), `the attempt did not reserve its own page ${reservedTab}: ${JSON.stringify(reservedDuringAttempt.reservedTabIds)}`);
    expect(!reservedDuringAttempt.reservedTabIds.includes(betaAnchorTab), `the attempt reserved another window's page ${betaAnchorTab}`);
    expect(mintOutcome.admitted === false, `a binding was admitted for a reserved page (attachment ${String(mintOutcome.attachmentId)})`);
    expect(mintOutcome.code === 'TARGET_STALE', `the binding refusal code was '${String(mintOutcome.code)}'`);
    expect(report.disposition === 'closed', `the close reported '${String(report.disposition)}' (haltedBy ${String(report.haltedBy)})`);
    const reservationsAfter = court.reservations();
    expect(reservationsAfter.reservedTabIds.length === 0 && reservationsAfter.applicationReserved === false, `the attempt left a reservation behind: ${JSON.stringify(reservationsAfter)}`);
  });

  // ------------------------------------------------------------------ R4g: Unassigned reachable
  await automated('R4g', async (row) => {
    const document = await waitFor(
      () => {
        const read = readSavedTabsDocument();
        return read && read.version === 2 && read.owners && read.owners.unassigned && read.owners.unassigned.tabs && read.owners.unassigned.tabs.length > 0 ? read : false;
      },
      'the version-2 saved-tabs document with its Unassigned owner record',
      20000,
    ).catch(() => readSavedTabsDocument());
    const migratedIds = savedTabIds('unassigned');
    // A restored page is a fresh host tab: the persisted id is the record's key, and the live tab is
    // minted with a new one, so the pages are identified by the URL they carry. That also keeps the
    // ownership question real — a project window that guessed a legacy page would hold a live tab
    // whose record carries the legacy URL.
    const liveTabUrl = (tabId) => tabRecord(tabId)?.url ?? '';
    const liveLegacyTabIds = LEGACY_TABS
      .map((legacy) => [...new Set(snapshot().flatMap((entry) => entry.tabIds))].find((tabId) => liveTabUrl(tabId) === legacy.url) ?? null)
      .filter(Boolean);
    const claimedByProjectWindows = snapshot()
      .filter((entry) => entry.owner.kind === 'project')
      .filter((entry) => entry.tabIds.some((tabId) => liveLegacyTabIds.includes(tabId)))
      .map((entry) => entry.ownerKey);
    const ownerKeys = document && document.owners ? Object.keys(document.owners) : [];

    const unassignedEntry = await court.ensureProjectWindow({ kind: 'unassigned' }, 'user');
    await waitFor(() => (entryFor(unassignedEntry.ownerKey)?.tabIds ?? []).length > 0, 'the Unassigned window to restore its pages', 20000).catch(() => null);
    await sleep(400);
    const entry = entryFor(unassignedEntry.ownerKey);
    row.observed = {
      savedTabsVersion: document && document.version,
      migratedOwners: ownerKeys,
      migratedTabIds: migratedIds,
      claimedByProjectWindows,
      unassigned: entry,
      legacyTabs: LEGACY_TABS.map((tab) => tab.id),
    };
    row.ids = {
      windowIds: windowIdsOf([unassignedEntry.ownerKey, betaKey]),
      tabIds: entry?.tabIds ?? [],
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(document && document.version === 2, `the saved-tabs document version is ${String(document && document.version)}`);
    expect(LEGACY_TABS.every((legacy) => migratedIds.includes(legacy.id)), `the migrated Unassigned record is missing legacy tabs: ${JSON.stringify(migratedIds)}`);
    expect(claimedByProjectWindows.length === 0, `project windows guessed ownership of the unresolved pages: ${JSON.stringify(claimedByProjectWindows)}`);
    expect(entry, 'the Unassigned window was not created');
    expect(entry.owner.kind === 'unassigned', `the Unassigned window's owner is ${JSON.stringify(entry.owner)}`);
    expect(String(entry.title).startsWith('Unassigned'), `the Unassigned window's title is '${String(entry.title)}'`);
    expect(LEGACY_TABS.every((legacy) => entry.tabIds.some((tabId) => liveTabUrl(tabId) === legacy.url)), `the Unassigned window does not present the migrated pages: ${JSON.stringify(entry.tabIds.map((tabId) => liveTabUrl(tabId)))}`);
  });

  // ------------------------------------------------------------------ Search supplement
  await automated('S1', async (row) => {
    // The close rows earlier in the run shut A. The supplement's subject is that every window can
    // find the other windows' tabs, including a second project of the same name, so A is live again
    // before the inventories are compared.
    await ensureOwnerWindow(alphaKey, ALPHA, betaKey);
    const alphaToolbarLive = await toolbarFor(alphaKey);
    // The title query below is a literal filter, so the inventory must genuinely carry a title to
    // match. A's page is opened here, through A's own toolbar and the same local origin as boot,
    // rather than assumed to have survived the close rows.
    const alphaSupplementTab = await createTabViaToolbar(alphaToolbarLive, baseUrl('/alpha'));
    expect(typeof alphaSupplementTab === 'string' && alphaSupplementTab.length > 0, 'window A opened no page for the inventory to carry');
    await bounded(court.hostForOwner(alphaKey).navigateAndWait(alphaSupplementTab, baseUrl('/alpha')), 20000, 'the inventory page load in A');
    await waitFor(
      () => String(tabRecord(alphaSupplementTab)?.title ?? '').toLowerCase().includes('matrix alpha page'),
      'the opened page\'s title to reach the tab record',
      15000,
    ).catch(() => null);
    const alphaSupplementTitle = tabRecord(alphaSupplementTab)?.title ?? '';
    const fromAlpha = await searchFrom(alphaToolbarLive, '');
    const fromBeta = await searchFrom(betaToolbar, '');
    const unassignedEntry = snapshot().find((entry) => entry.owner.kind === 'unassigned');
    const unassignedToolbar = unassignedEntry ? await toolbarFor(unassignedEntry.ownerKey) : null;
    const fromUnassigned = unassignedToolbar ? await searchFrom(unassignedToolbar, '') : null;
    // The literal filter, proven in both directions against the real inventory. `''` lists
    // everything; a lower-cased title fragment and an upper-cased URL fragment must both select
    // the rows that carry them (matching is literal and case-insensitive), and a query no row
    // carries must return an empty *OK* list — `UNAVAILABLE` means the inventory itself could not
    // be established, so an empty result reported as unavailable would hide a broken inventory.
    const titleLiteralQuery = 'matrix alpha page';
    const urlLiteralQuery = 'HTTP://127.0.0.1';
    const unmatchedLiteralQuery = 'matrix-no-such-page-7c1f';
    const titleLiteral = await searchFrom(alphaToolbarLive, titleLiteralQuery);
    const urlLiteral = await searchFrom(alphaToolbarLive, urlLiteralQuery);
    const unmatchedLiteral = await searchFrom(alphaToolbarLive, unmatchedLiteralQuery);
    const signature = (result) => JSON.stringify((result && result.rows ? result.rows : []).map((rowItem) => [rowItem.tabId, rowItem.ownerLabel, rowItem.pathLabel, rowItem.live]));
    const rowsAlpha = fromAlpha && fromAlpha.rows ? fromAlpha.rows : [];
    const ownerLabels = [...new Set(rowsAlpha.map((rowItem) => rowItem.ownerLabel))];
    const titleLiteralRows = titleLiteral && titleLiteral.rows ? titleLiteral.rows : [];
    const urlLiteralRows = urlLiteral && urlLiteral.rows ? urlLiteral.rows : [];
    const unmatchedLiteralRows = unmatchedLiteral && unmatchedLiteral.rows ? unmatchedLiteral.rows : [];
    row.observed = {
      fromAlpha: { status: fromAlpha && fromAlpha.status, rowCount: rowsAlpha.length },
      fromBeta: { status: fromBeta && fromBeta.status, rowCount: fromBeta && fromBeta.rows ? fromBeta.rows.length : 0 },
      fromUnassigned: fromUnassigned ? { status: fromUnassigned.status, rowCount: fromUnassigned.rows ? fromUnassigned.rows.length : 0 } : null,
      ownerLabels,
      duplicateNamePaths: rowsAlpha.filter((rowItem) => String(rowItem.ownerLabel || '').includes('Matrix Storefront')).map((rowItem) => rowItem.pathLabel),
      literalQueries: {
        title: { query: titleLiteralQuery, status: titleLiteral && titleLiteral.status, rowCount: titleLiteralRows.length },
        url: { query: urlLiteralQuery, status: urlLiteral && urlLiteral.status, rowCount: urlLiteralRows.length },
        unmatched: { query: unmatchedLiteralQuery, status: unmatchedLiteral && unmatchedLiteral.status, rowCount: unmatchedLiteralRows.length },
      },
      literalSample: titleLiteralRows.slice(0, 5).map((rowItem) => ({ tabId: rowItem.tabId, title: rowItem.title, url: rowItem.url, ownerLabel: rowItem.ownerLabel })),
      urlLiteralSample: urlLiteralRows.slice(0, 5).map((rowItem) => ({ tabId: rowItem.tabId, url: rowItem.url })),
      alphaSupplementTab,
      alphaSupplementTitle,
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey, unassignedEntry?.ownerKey]),
      tabIds: [alphaSupplementTab, ...rowsAlpha.map((rowItem) => rowItem.tabId)].filter(Boolean).slice(0, 40),
    };
    expect(fromAlpha && fromAlpha.status === 'OK', `A's search returned ${JSON.stringify(fromAlpha && fromAlpha.status)}`);
    expect(fromBeta && fromBeta.status === 'OK', `B's search returned ${JSON.stringify(fromBeta && fromBeta.status)}`);
    expect(signature(fromAlpha) === signature(fromBeta), 'the two windows listed different inventories');
    expect(rowsAlpha.length >= 10, `the inventory lists only ${rowsAlpha.length} rows`);
    expect(ownerLabels.length >= 3, `the inventory spans ${ownerLabels.length} owners: ${JSON.stringify(ownerLabels)}`);
    expect(ownerLabels.some((label) => String(label).includes('Unassigned')), `no Unassigned row is listed: ${JSON.stringify(ownerLabels)}`);
    expect(ownerLabels.some((label) => String(label).includes(BETA.name)), `no row for window B ('${BETA.name}') is listed: ${JSON.stringify(ownerLabels)}`);
    const storefrontPaths = [...new Set(rowsAlpha
      .filter((rowItem) => String(rowItem.ownerLabel || '').includes('Matrix Storefront'))
      .map((rowItem) => rowItem.pathLabel))];
    expect(storefrontPaths.length >= 2, `the duplicate project name is not disambiguated by path: ${JSON.stringify(storefrontPaths)}`);
    // Both directions of the literal filter, plus the empty control: each asserted query reports
    // OK, every listed row genuinely carries the needle (title or url, case-insensitively), and a
    // query nothing carries lists nothing. A needle that matched no row in the first place would
    // make the loop below vacuous, so the row counts are asserted first.
    expect(titleLiteral && titleLiteral.status === 'OK', `the literal title query returned ${JSON.stringify(titleLiteral && titleLiteral.status)}`);
    expect(urlLiteral && urlLiteral.status === 'OK', `the literal url query returned ${JSON.stringify(urlLiteral && urlLiteral.status)}`);
    expect(unmatchedLiteral && unmatchedLiteral.status === 'OK', `a query nothing carries returned ${JSON.stringify(unmatchedLiteral && unmatchedLiteral.status)} instead of an empty OK list`);
    expect(titleLiteralRows.length > 0, `the literal title query '${titleLiteralQuery}' matched nothing: ${JSON.stringify(titleLiteral && titleLiteral.rows)}`);
    expect(titleLiteralRows.some((rowItem) => rowItem.tabId === alphaSupplementTab), `the page this row opened (title '${alphaSupplementTitle}') is not among the rows the title query matched: ${JSON.stringify(titleLiteralRows.map((rowItem) => ({ tabId: rowItem.tabId, title: rowItem.title })))}`);
    expect(urlLiteralRows.length > 0, `the literal url query '${urlLiteralQuery}' matched nothing: ${JSON.stringify(urlLiteral && urlLiteral.rows)}`);
    expect(unmatchedLiteralRows.length === 0, `a query nothing carries listed ${unmatchedLiteralRows.length} row(s): ${JSON.stringify(unmatchedLiteralRows.slice(0, 5))}`);
    for (const rowItem of titleLiteralRows) {
      const haystack = `${String(rowItem.title || '')} ${String(rowItem.url || '')}`.toLowerCase();
      expect(haystack.includes(titleLiteralQuery), `a row matched '${titleLiteralQuery}' without carrying it in its title or url: ${JSON.stringify({ title: rowItem.title, url: rowItem.url })}`);
    }
    for (const rowItem of urlLiteralRows) {
      const haystack = `${String(rowItem.title || '')} ${String(rowItem.url || '')}`.toLowerCase();
      expect(haystack.includes(urlLiteralQuery.toLowerCase()), `a row matched '${urlLiteralQuery}' without carrying it in its title or url: ${JSON.stringify({ title: rowItem.title, url: rowItem.url })}`);
    }
  });

  const searchState = {};
  await automated('S2', async (row) => {
    const alphaToolbarLive = await toolbarFor(alphaKey);
    const inventory = await searchFrom(alphaToolbarLive, '');
    const foreignRow = (inventory.rows || []).find((rowItem) => String(rowItem.ownerLabel || '').includes(BETA.name) && rowItem.tabId !== betaAnchorTab)
      ?? (inventory.rows || []).find((rowItem) => rowItem.tabId === agentChildTab);
    const alphaActiveBefore = requireActiveTab(alphaKey);
    const revisionBefore = attachmentState(betaAgentAttachment.attachmentId);
    const chosen = foreignRow ? foreignRow.tabId : agentChildTab;
    const result = await activateFrom(alphaToolbarLive, chosen);
    await sleep(500);
    const betaEntryAfter = entryFor(betaKey);
    row.observed = {
      inventoryRowCount: inventory && inventory.rows ? inventory.rows.length : 0,
      chosenTabId: chosen,
      chosenRow: foreignRow ? { tabId: foreignRow.tabId, ownerLabel: foreignRow.ownerLabel, pathLabel: foreignRow.pathLabel } : null,
      result,
      betaActiveAfter: betaEntryAfter?.activeTabId,
      alphaActiveBefore,
      alphaActiveAfter: requireActiveTab(alphaKey),
      foregroundAfter: foregroundOwnerKey(),
      revisionBefore,
      revisionAfter: attachmentState(betaAgentAttachment.attachmentId),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: [chosen].filter(Boolean),
      attachmentRevisionBefore: revisionBefore,
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    searchState.chosen = chosen;
    expect(foreignRow, `no foreign row for B was listed: ${JSON.stringify((inventory.rows || []).map((rowItem) => [rowItem.tabId, rowItem.ownerLabel]))}`);
    expect(result && result.status === 'ACTIVATED', `the activation returned ${JSON.stringify(result)}`);
    expect(result.tabId === foreignRow.tabId, `the activation named '${String(result.tabId)}', expected '${foreignRow.tabId}'`);
    expect(betaEntryAfter && betaEntryAfter.activeTabId === foreignRow.tabId, `window B's active tab is '${String(betaEntryAfter && betaEntryAfter.activeTabId)}', expected '${foreignRow.tabId}'`);
    expect(requireActiveTab(alphaKey) === alphaActiveBefore, 'the invocation moved the invoking window\'s active tab');
    const revisionAfter = attachmentState(betaAgentAttachment.attachmentId);
    expect(revisionAfter.authorityRevision === revisionBefore.authorityRevision, `a user activation rotated agent authority from '${revisionBefore.authorityRevision}' to '${revisionAfter.authorityRevision}'`);
  });

  await automated('S3', async (row) => {
    const alphaToolbarLive = await toolbarFor(alphaKey);
    const before = snapshot().map((entry) => ({ ownerKey: entry.ownerKey, activeTabId: entry.activeTabId, focused: entry.focused }));
    const foregroundBefore = foregroundId();
    const result = await activateFrom(alphaToolbarLive, 'tab-that-never-existed');
    await sleep(300);
    const after = snapshot().map((entry) => ({ ownerKey: entry.ownerKey, activeTabId: entry.activeTabId, focused: entry.focused }));
    row.observed = {
      result,
      activeTabsBefore: before.map((entry) => [entry.ownerKey, entry.activeTabId]),
      activeTabsAfter: after.map((entry) => [entry.ownerKey, entry.activeTabId]),
      foregroundBefore,
      foregroundAfter: foregroundId(),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      tabIds: ['tab-that-never-existed'],
      foregroundBefore,
      foregroundAfter: foregroundId(),
    };
    expect(result && result.status === 'UNAVAILABLE', `a stale result returned ${JSON.stringify(result)}`);
    expect(result.reasonCode === 'TAB_CLOSED', `the stale result's reasonCode is '${String(result.reasonCode)}'`);
    expect(result.tabId === 'tab-that-never-existed', `the stale result named '${String(result.tabId)}'`);
    expect(JSON.stringify(before.map((entry) => entry.activeTabId)) === JSON.stringify(after.map((entry) => entry.activeTabId)), 'a refused activation moved an active tab');
    expect(JSON.stringify(before.map((entry) => entry.focused)) === JSON.stringify(after.map((entry) => entry.focused)), 'a refused activation moved window focus');
    expect(foregroundId() === foregroundBefore, 'a refused activation moved the foreground window');
  });

  // ------------------------------------------------------------------ R0: five windows, twenty tabs
  await automated('R0', async (row) => {
    const wanted = [PROJECTS.alpha, PROJECTS.beta, PROJECTS.gamma, PROJECTS.delta, PROJECTS.epsilon];
    const keys = {};
    for (const project of wanted) {
      const entry = snapshot().find((candidate) => candidate.owner.kind === 'project' && candidate.owner.projectId === project.projectId)
        ?? await court.ensureProjectWindow({ kind: 'project', projectId: project.projectId }, 'user');
      keys[project.projectId] = entry.ownerKey;
      const toolbar = await toolbarFor(entry.ownerKey);
      while ((entryFor(entry.ownerKey)?.tabIds ?? []).length < 4) {
        await createTabViaToolbar(toolbar, 'about:blank');
        await sleep(200);
      }
    }
    await sleep(600);
    const perWindow = wanted.map((project) => {
      const ownerKeyValue = keys[project.projectId];
      const entry = entryFor(ownerKeyValue);
      const records = (entry?.tabIds ?? []).map((tabId) => tabRecord(tabId)).filter(Boolean);
      return {
        projectId: project.projectId,
        ownerKey: ownerKeyValue,
        windowId: entry?.windowId ?? null,
        title: entry?.title ?? null,
        pathLabel: entry?.pathLabel ?? null,
        tabCount: entry?.tabIds?.length ?? 0,
        activeTabId: entry?.activeTabId ?? null,
        allTabsResolveHere: records.length === (entry?.tabIds?.length ?? 0) && records.every((record) => record.windowOwnerKey === ownerKeyValue),
        tabUrls: records.map((record) => record.url),
      };
    });
    const totalTabs = perWindow.reduce((sum, item) => sum + item.tabCount, 0);
    const duplicateNames = perWindow.filter((item) => item.title && String(item.title).startsWith('Matrix Storefront'));
    const duplicatePaths = [...new Set(duplicateNames.map((item) => item.pathLabel))];
    row.observed = {
      perWindow,
      totalTabs,
      shellCount: snapshot().length,
      duplicateNameWindows: duplicateNames.map((item) => ({ ownerKey: item.ownerKey, title: item.title, pathLabel: item.pathLabel })),
    };
    row.ids = {
      windowIds: windowIdsOf(Object.values(keys)),
      tabIds: perWindow.flatMap((item) => entryFor(item.ownerKey)?.tabIds ?? []),
      projectIds: wanted.map((project) => project.projectId),
      workspaceIds: wanted.map((project) => project.workspaceId),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(perWindow.filter((item) => item.windowId !== null).length === 5, `only ${perWindow.filter((item) => item.windowId !== null).length} of five project windows are live: ${JSON.stringify(perWindow.map((item) => [item.projectId, item.windowId]))}`);
    expect(totalTabs >= 20, `only ${totalTabs} user-visible tabs are open across five windows`);
    for (const item of perWindow) {
      expect(item.tabCount >= 4, `window ${item.ownerKey} presents only ${item.tabCount} tabs`);
      expect(item.allTabsResolveHere, `a tab in window ${item.ownerKey} resolves to another window's host`);
      expect(item.activeTabId && (entryFor(item.ownerKey)?.tabIds ?? []).includes(item.activeTabId), `window ${item.ownerKey} has no active tab of its own`);
    }
    expect(duplicateNames.length >= 2, `the duplicate project name is not present in two windows: ${JSON.stringify(duplicateNames)}`);
    expect(duplicatePaths.length === duplicateNames.length, `duplicate names share a path label: ${JSON.stringify(duplicatePaths)}`);
  });

  // ------------------------------------------------------------------ R9a: quit refused while work is queued
  let queuedRun = null;
  await automated('R9a', async (row) => {
    const plane = planeOf();
    const chat = plane.chats.create(ALPHA.projectId, ALPHA.workspaceId, 'matrix: shared work');
    queuedRun = plane.runs.createRun(ALPHA.projectId, ALPHA.workspaceId, chat.id, 'matrix-backend');
    const beforeAttempt = court.lastQuitReport() ? court.lastQuitReport().attemptId ?? 0 : 0;
    const shellCountBefore = snapshot().length;
    court.requestQuit('matrix: quit with queued work');
    const report = await waitFor(
      () => {
        const candidate = court.lastQuitReport();
        return candidate && candidate.attemptId !== beforeAttempt ? candidate : false;
      },
      'the refused quit report',
    ).catch(() => null);
    await sleep(400);
    const runsAfter = plane.runs.listRuns(ALPHA.projectId).map((run) => ({ id: run.id, state: run.state }));
    row.observed = {
      queuedRunId: queuedRun.id,
      chatId: chat.id,
      report,
      applicationPhase: court.applicationPhase(),
      reservations: court.reservations(),
      shellCountBefore,
      shellCountAfter: snapshot().length,
      runsAfter,
      servicesAnswer: Boolean(plane.chats.create(ALPHA.projectId, ALPHA.workspaceId, 'matrix: after refusal').id),
    };
    row.ids = {
      windowIds: windowIdsOf([alphaKey, betaKey]),
      projectIds: [ALPHA.projectId],
      workspaceIds: [ALPHA.workspaceId],
      attachmentRevisionBefore: attachmentState(betaAgentAttachment.attachmentId),
      attachmentRevisionAfter: attachmentState(betaAgentAttachment.attachmentId),
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(report, 'the quit produced no report');
    expect(report.shutdown === 'not-committed', `the quit committed anyway: ${JSON.stringify(report.shutdown)}`);
    expect(report.phase === 'open', `the application phase after the refusal is '${String(report.phase)}'`);
    expect(report.admissionReserved === false, 'application admission stayed reserved after the refusal');
    expect(report.closedShells.length === 0, `the refused quit closed shells: ${JSON.stringify(report.closedShells)}`);
    // The refusal record carries both a code and a detail (CloseRefusal); which of the two names
    // the queued work is an implementation detail of the evidence text, so the row requires a
    // refusal to exist and requires it to name the queued run in either carrier. Asserting one
    // specific field would pin a shape the contract does not promise, and searching an empty list
    // would be vacuous.
    expect(report.refusals.length > 0, `the refused quit reported no refusal at all: ${JSON.stringify(report)}`);
    const refusalText = report.refusals.map((refusal) => `${String(refusal.code || '')} ${String(refusal.detail || '')}`).join(' | ');
    expect(refusalText.includes(queuedRun.id), `the refusal does not name the queued run ${queuedRun.id}: ${JSON.stringify(report.refusals)}`);
    expect(snapshot().length === shellCountBefore, `the refused quit changed the shell count from ${shellCountBefore} to ${snapshot().length}`);
    expect(runsAfter.some((run) => run.id === queuedRun.id && run.state === 'queued'), 'the refused quit settled the queued run');
    expect(app.isReady() === true, 'the app is no longer ready after a refused quit');
    const reservations = court.reservations();
    expect(reservations.reservedTabIds.length === 0 && reservations.applicationReserved === false, `the refused quit left admission reserved: ${JSON.stringify(reservations)}`);
  });

  // ------------------------------------------------------------------ R9b: idle commit
  let willQuitSettled = null;
  await automated('R9b', async (row) => {
    const plane = planeOf();
    if (queuedRun) {
      const finishingBackend = {
        id: 'matrix-finisher',
        startRun: async function* (input) {
          yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' };
        },
        cancel: async () => {},
      };
      await bounded(plane.runs.start(queuedRun.id, 'matrix: release the gate', finishingBackend, { cwd: ALPHA.path }), 20000, 'starting the queued run');
      await waitFor(
        () => plane.runs.listRuns(ALPHA.projectId).some((run) => run.id === queuedRun.id && run.state === 'completed') || false,
        'the queued run to reach a terminal state',
        20000,
      );
    }
    const terminalSessionsBefore = plane.terminal.listSessions(true).length;
    const shellCountBefore = snapshot().length;
    const auxiliariesBefore = auxiliaryWindows().length;
    const keys = snapshot().map((entry) => entry.ownerKey);
    const beforeAttempt = court.lastQuitReport() ? court.lastQuitReport().attemptId ?? 0 : 0;
    const journalBefore = journalEvents().length;

    // Idle has to be true of every evidence source before the last close can commit. Two sources are
    // the harness's own making: runs it started, and attachments it minted. Leaving an attachment
    // bound is a live-use fact the gate must refuse on — the refusal would be the *correct* answer —
    // so the harness releases what it still holds instead of asserting against its own leftovers.
    const settleRunErrors = [];
    for (const project of [ALPHA, BETA]) {
      for (const run of plane.runs.listRuns(project.projectId)) {
        if (['queued', 'starting', 'streaming', 'cancelling', 'waiting-tool'].includes(String(run.state))) {
          try {
            await bounded(plane.runs.cancel(run.id, { cancel: async () => {} }), 10000, `settle run ${run.id}`);
          } catch (err) {
            settleRunErrors.push({ runId: run.id, state: String(run.state), error: messageOf(err) });
          }
        }
      }
    }
    const releasedAttachments = [];
    for (const attachment of [betaAgentAttachment, conflictAttachment]) {
      if (!attachment?.attachmentId) continue;
      try {
        await plane.runs.attachments.revokeAttachment(attachment.attachmentId);
        releasedAttachments.push(attachment.attachmentId);
      } catch (err) {
        releasedAttachments.push({ attachmentId: attachment.attachmentId, error: messageOf(err) });
      }
    }
    await waitFor(() => court.reservations().reservedTabIds.length === 0, 'close reservations to drain', 10000).catch(() => null);

    // Close every shell but the last through the shipping close path, then let the last close
    // drive the application gate. A shell whose close is refused leaves the run without a last
    // close at all, so a silent wait would surface as a bare will-quit timeout; the refusal is
    // captured and named here instead.
    const refusedCloses = [];
    for (const key of keys.slice(0, -1)) {
      court.requestClose(key);
      const gone = await waitFor(() => (entryFor(key) ? false : true), `window ${key} to close`, 25000).catch(() => false);
      if (!gone) refusedCloses.push({ ownerKey: key, report: court.lastCloseReport(key) ?? null });
    }
    const lastKey = keys[keys.length - 1];
    const lastCloseRequested = court.requestClose(lastKey);
    const willQuitSettledLocal = await Promise.race([willQuitPromise, sleep(60000).then(() => 'timeout')]);
    willQuitSettled = willQuitSettledLocal;
    const report = await waitFor(
      () => {
        const candidate = court.lastQuitReport();
        return candidate && candidate.attemptId !== beforeAttempt ? candidate : false;
      },
      'the committed quit report',
      20000,
    ).catch(() => null);
    await sleep(300);
    const journal = journalEvents().slice(journalBefore);
    const liveWindows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => ({ id: window.id, title: window.getTitle() }));

    row.observed = {
      shellCountBefore,
      terminalSessionsBefore,
      auxiliariesBefore,
      lastKey,
      lastCloseRequested,
      willQuitSettled: willQuitSettledLocal,
      report,
      finalShellCount: snapshot().length,
      liveWindows,
      auxiliaryWindowsAfter: auxiliaryWindows(),
      journal: journal.map((entry) => entry.event),
      journalDetail: journal.filter((entry) => entry.event === 'quit.outcome' || entry.event === 'will-quit').map((entry) => ({ event: entry.event, origin: entry.origin, shutdown: entry.shutdown, coalescedRequests: entry.coalescedRequests })),
      willQuitEvents,
      settleRunErrors,
      releasedAttachments,
      refusedCloses,
    };
    row.ids = {
      windowIds: windowIdsOf(keys),
      projectIds: [ALPHA.projectId, BETA.projectId],
      foregroundBefore: foregroundId(),
      foregroundAfter: foregroundId(),
    };
    expect(refusedCloses.length === 0, `shell close(s) were refused, so the last close could never drive the application gate: ${JSON.stringify(refusedCloses)}`);
    expect(willQuitSettledLocal === 'will-quit', `the process never reached will-quit (settled: ${String(willQuitSettledLocal)})`);
    expect(report, 'no quit report was produced by the last shell closing');
    expect(report.shutdown === 'committed', `the quit reported '${String(report.shutdown)}' (haltedBy ${String(report.haltedBy)}, refusals ${JSON.stringify(report.refusals)})`);
    expect(report.phase === 'closed', `the application phase is '${String(report.phase)}'`);
    expect(report.survivingShells.length === 0, `a shell survived the committed quit: ${JSON.stringify(report.survivingShells)}`);
    // The quit's own `closedShells` counts what *it* had left to close, and the last shell's close
    // request is what drove the quit in the first place — so a committed quit legitimately closes
    // zero and the proof that the closes happened is the registry: every shell but the last was
    // awaited gone above, and the last one must be gone by the time the commit is reported.
    expect(shellCountBefore >= 2, `the run had ${shellCountBefore} shell(s) before the closes, so "close every shell but the last" was not exercised`);
    expect(entryFor(lastKey) === null, `the shell that drove the quit (${lastKey}) is still registered after the commit`);
    expect(snapshot().length === 0, `browserShellCount() is ${snapshot().length} after the commit`);
    expect(report.auxiliaries.every((surface) => surface.outcome === 'closed'), `an auxiliary surface did not close: ${JSON.stringify(report.auxiliaries)}`);
    expect(liveWindows.length === 0, `native windows survived the commit: ${JSON.stringify(liveWindows)}`);
    expect(auxiliaryWindows().length === 0, 'a terminal popout survived the commit');
    const events = journal.map((entry) => entry.event);
    const beginCount = events.filter((event) => event === 'shutdown.begin').length;
    const cleanCount = events.filter((event) => event === 'shutdown.clean').length;
    expect(events.includes('shutdown.begin'), `the ordered teardown never began: ${JSON.stringify(events)}`);
    expect(beginCount === 1, `the ordered teardown began ${beginCount} times`);
    expect(events.includes('shutdown.clean'), `the teardown never reached its clean marker: ${JSON.stringify(events)}`);
    expect(cleanCount === 1, `the teardown reached its clean marker ${cleanCount} times`);
    expect(!events.includes('shutdown.forceExit'), 'the process force-exited instead of finishing the teardown');
    expect(!events.some((event) => String(event).startsWith('shutdown.step.failed')), `a teardown step failed: ${JSON.stringify(events)}`);
    // `will-quit` is delivered once per quit attempt, and this harness vetoes each one, so the
    // count is not a teardown count — `shutdown.begin` above is. What has to hold is that the
    // platform delivered it at all (the hold below is what makes the veto possible), and that
    // every quit attempt that reached the coordinator carried the same committed outcome instead
    // of re-running the teardown.
    expect(events.includes('will-quit'), `the platform never delivered will-quit for the committed quit: ${JSON.stringify(events)}`);
    const outcomes = journal.filter((entry) => entry.event === 'quit.outcome');
    expect(outcomes.length >= 1, `the coordinator recorded no quit outcome: ${JSON.stringify(events)}`);
    expect(outcomes.every((entry) => entry.shutdown === 'committed'), `a later quit attempt did not carry the committed outcome: ${JSON.stringify(outcomes)}`);
    // The journal records the count, the report records the list; both mean "nothing survived".
    expect(outcomes.every((entry) => (Array.isArray(entry.survivingShells) ? entry.survivingShells.length === 0 : entry.survivingShells === 0)), `a quit attempt reported a surviving shell: ${JSON.stringify(outcomes)}`);
  });

  // ------------------------------------------------------------------ R9c: detached daemon survival
  await automated('R9c', async (row) => {
    if (!daemon.staged) {
      row.status = 'BLOCKED';
      row.reason = daemonEntryPresent
        ? `the detached terminal host could not be staged into this run's data root: ${String(daemon.stagingError)}`
        : `no staged daemon bundle exists at ${path.join(compiledRoot, 'src', 'main', 'terminal-daemon', 'daemon-entry.js')}, so the app runs its terminals in-process and there is no daemon whose survival could be observed (run \`npm run compile\`, then this harness stages scripts/stage-daemon-host.mjs into its own data root)`;
      row.observed = { daemonEntryPresent, stagingError: daemon.stagingError, compiledRoot, terminalSessions: planeOf().terminal.listSessions(true).map((session) => session.id) };
      return;
    }
    const before = daemon.beforeHandle;
    expect(before && before.pid, `the boot never reported a daemon handle: ${JSON.stringify(daemon)}`);
    const after = await ensureDaemon({ cwd: ALPHA.path });
    noteDaemonPid(after && after.handle);
    const handle = after && after.handle ? after.handle : null;
    row.observed = {
      beforeHandle: before,
      afterHandle: handle,
      mode: after && after.mode,
      sessionId: state.terminalSessionId ?? null,
      phase: court.applicationPhase(),
      shellCount: snapshot().length,
    };
    row.ids = { windowIds: windowIdsOf(snapshot().map((entry) => entry.ownerKey)), terminalSessionIds: [state.terminalSessionId ?? null] };
    expect(after && after.mode === 'attached', `the daemon was not re-attached after the teardown (mode '${String(after && after.mode)}')`);
    expect(handle.pid === before.pid, `the daemon identity changed: pid ${before.pid} -> ${handle.pid}`);
    expect(handle.token === before.token && handle.version === before.version, `the daemon identity changed: version/token ${before.version}/${String(before.token).slice(0, 6)} -> ${handle.version}/${String(handle.token).slice(0, 6)}`);

    // An existing PTY, driven by a client this harness owns (the GUI's own manager is disposed).
    const proxy = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
    try {
      const ping = await bounded(proxy.ping(), 15000, 'daemon ping');
      expect(ping && ping.pong === true, `the daemon did not answer a ping: ${JSON.stringify(ping)}`);
      expect(ping.pid === before.pid, `the ping came from pid ${ping.pid}, not from the daemon ${before.pid}`);
      const marker = `matrix-pty-${Date.now().toString(36)}`;
      const sessionId = state.terminalSessionId;
      expect(sessionId, 'no terminal session was created before the teardown, so PTY survival cannot be judged');
      const ready = await bounded(proxy.waitReady(sessionId, 15000), 20000, 'daemon waitReady');
      expect(ready === true, `the daemon reported session ${sessionId} not ready`);
      // Literal input to the PTY, not a named key: `sendKey` takes key names ('Enter', 'C-c') and
      // the daemon answers an unknown name with a refusal instead of typing it.
      const wrote = await bounded(proxy.writeTo(sessionId, `echo ${marker}\r`), 15000, 'daemon input');
      expect(wrote === true, `the daemon refused input into the surviving session (${JSON.stringify(wrote)})`);
      const seen = await waitFor(
        async () => {
          const buffer = await bounded(proxy.getFullBuffer(sessionId), 15000, 'daemon getFullBuffer');
          const text = typeof buffer === 'string' ? buffer : JSON.stringify(buffer ?? '');
          return text.includes(marker) ? text.slice(-400) : false;
        },
        'the marker to appear in the surviving session',
        20000,
      ).catch(() => null);
      row.observed.ping = ping;
      row.observed.marker = marker;
      row.observed.sessionTail = seen;
      expect(seen, `the surviving session never produced the marker ${marker}`);
    } finally {
      try { await bounded(proxy.shutdownHost(), 15000, 'daemon shutdownHost'); } catch (err) { row.observed.shutdownError = messageOf(err); }
    }
    // The row's question is whether the host this harness started is gone. `ensureDaemon()` answers a
    // different one — and, with a staged bundle present, it answers by *spawning a replacement host* —
    // so the probe asks the process table directly instead of creating the process it then reports.
    const stopped = await waitFor(
      () => (alivePid(before.pid) ? false : `pid ${before.pid} is gone after shutdownHost()`),
      'the daemon this harness started to stop',
      30000,
    ).catch(() => null);
    row.observed.stoppedAfterwards = stopped;
    expect(stopped, 'the daemon this harness started did not stop, so it would be left behind as an owned orphan');
    daemon.stopped = true;
  });

  // ------------------------------------------------------------------ R9d: no page processes after the commit
  await automated('R9d', async (row) => {
    // This row judges the state *after* a committed teardown. When the teardown never committed,
    // every surviving process is the un-torn-down app, not a leak, and the failure belongs to the
    // row that drove the quit.
    if (willQuitSettled !== 'will-quit') {
      row.status = 'BLOCKED';
      row.reason = `the teardown never committed (will-quit settled '${String(willQuitSettled)}'), so no post-commit state exists to judge; the failure belongs to row R9b`;
      row.observed = { willQuitSettled, shells: snapshot().map((entry) => entry.ownerKey) };
      return;
    }
    const inventory = processInventory();
    const children = osChildPids();
    const pageTypes = ['Tab', 'Renderer', 'Pepper Plugin', 'Pepper Plugin Broker'];
    const survivingPages = inventory.types ? inventory.types.filter((type) => pageTypes.includes(type)) : null;
    row.observed = {
      inventory,
      survivingPageProcessTypes: survivingPages,
      osChildren: children,
      osChildrenSupported: Array.isArray(children),
      windows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.id),
      webContents: webContents.getAllWebContents().map((contents) => ({ id: contents.id, type: contents.getType(), destroyed: contents.isDestroyed() })),
      note: 'this row judges the state after the committed teardown while the browser process is held open by the harness; the after-exit half is row R9E, decided by a second process',
      osChildrenNote: Array.isArray(children)
        ? 'the OS child-process inventory for row R9E was recorded here, before this process exits'
        : 'the OS child-process inventory is implemented for win32 only, so row R9E has no descendant list to check on this platform',
    };
    row.ids = { orphanPids: Array.isArray(children) ? children : [] };
    expect(inventory.counts, `the process inventory could not be read: ${JSON.stringify(inventory)}`);
    expect(!survivingPages || survivingPages.length === 0, `page/renderer processes survived the committed teardown: ${JSON.stringify(survivingPages)} (${JSON.stringify(inventory.counts)})`);
    expect(inventory.webContents === 0, `${inventory.webContents} webContents survived the committed teardown`);
    expect(inventory.nativeWindows === 0, `${inventory.nativeWindows} native windows survived the committed teardown`);
    state.childrenBeforeExit = Array.isArray(children) ? children : [];
  });

  // ------------------------------------------------------------------ post-exit watcher
  armOrphanWatcher();
  blocked(
    'R9E',
    `decided after this process exits: the detached watcher observes from ${orphanReportPath}, and the verdict is merged by \`node scripts/probe-project-windows-matrix.cjs --verify-orphans\` once this process is gone`,
    {
      hostPid: process.pid,
      recordedChildren: state.childrenBeforeExit ?? null,
      watcher: state.watcher ?? null,
      reportPath: orphanReportPath,
      note: 'this row is BLOCKED in phase 1 by construction: nothing inside this process can observe a process that survives it',
    },
    { orphanPids: state.childrenBeforeExit ?? [] },
  );

  // ------------------------------------------------------------------ hardware rows
  blocked(
    'R6-HW',
    'needs physical hardware/human: unplugging a real monitor and changing the OS display scale cannot be produced by the app or the harness on the real surface (Electron exposes no API to remove a display or change its scale, and a synthetic screen event would be a fixture, not hardware). The window-state repair for these events is unit-proven, but the phase-5 criterion is not certifiable without the physical change.',
    {
      displays: displayFacts(),
      windowPlacements: snapshot().map((entry) => ({ ownerKey: entry.ownerKey, display: court.shellFor(entry.ownerKey)?.getDisplayInfo() ?? null })),
      nextStep: 'repeat with a monitor unplugged and with the OS scale changed while these rows run; the harness records each window\'s display id, scaleFactor and work area so the human can compare before/after',
    },
    { windowIds: windowIdsOf(snapshot().map((entry) => entry.ownerKey)) },
  );
}

/**
 * The post-exit half of "no owned orphan processes": a detached Node process that waits for this
 * Electron process to disappear, then asks the OS what is left. It writes its own report, which the
 * phase-2 invocation folds into the receipt. Nothing here decides a row from inside the run.
 */
function armOrphanWatcher() {
  const watcher = `
// Wrapped in an IIFE: the unsupported-platform branch returns early, and a bare top-level
// \`return\` is a SyntaxError inside \`node -e\`, which would stop this watcher from running at all.
(() => {
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const hostPid = Number(process.argv[1]);
const token = process.argv[2];
const reportPath = process.argv[3];
const logPath = process.argv[4];
const children = JSON.parse(process.argv[5] || '[]');
const tempRootPath = process.argv[6] || '';
const childrenFilePath = process.argv[7] || '';
const supportedPlatform = process.platform === 'win32';
const WATCH_WINDOW_MS = 180000;
const POLL_INTERVAL_MS = 500;
const SURVIVOR_GRACE_MS = 1500;
const log = (line) => { try { fs.appendFileSync(logPath, line + '\\n', 'utf8'); } catch {} };
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** The query as text, or null when the OS could not answer. Empty output is not "absent". */
const query = (script) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    log('query failed: ' + String(err && err.message ? err.message : err));
    return null;
  }
};
/** true = alive, false = the OS says absent, null = the OS could not answer. */
const alive = (pid) => {
  const out = query('Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '" | Select-Object -ExpandProperty ProcessId');
  if (out === null) return null;
  return out.split(/\\r?\\n/).map((s) => Number(s.trim())).includes(pid);
};
if (!supportedPlatform) {
  // The process inventory this watcher reads (Win32_Process) exists only on Windows. A report
  // that claimed "no survivor" from a query that never ran would be a false pass, so the
  // platform is recorded and the verdict is left to the caller as unsupported.
  const unsupported = { hostPid, supported: false, platform: process.platform, hostGone: false, hostState: 'unknown', timedOut: false, descendantCheckSupported: false, reason: 'the post-exit process inventory is implemented for win32 only', survivingPids: [], commandLineMatches: [], checkedAt: new Date().toISOString() };
  try { fs.writeFileSync(reportPath, JSON.stringify(unsupported, null, 2), 'utf8'); } catch (err) { log('report write failed: ' + String(err && err.message ? err.message : err)); }
  log('unsupported platform: ' + process.platform);
  return;
}
// Wait for the host to disappear. A query that could not be answered leaves the state
// UNKNOWN, never "gone": concluding the exit from an unanswered question is how a watcher
// reports an observation it never made. Only an explicit "absent" answer ends the wait.
const deadline = Date.now() + WATCH_WINDOW_MS;
let pollCount = 0;
let hostState = 'unknown';
let unansweredPolls = 0;
let exitObservedAtMs = null;
while (Date.now() < deadline) {
  pollCount += 1;
  const state = alive(hostPid);
  if (state === false) { hostState = 'gone'; exitObservedAtMs = Date.now(); break; }
  if (state === true) hostState = 'alive';
  else unansweredPolls += 1;
  sleep(POLL_INTERVAL_MS);
}
const hostGone = hostState === 'gone';
log('hostState=' + hostState + ' polls=' + pollCount + ' unanswered=' + unansweredPolls);
// Inventory only after the exit. A descendant the OS is still tearing down is not a survivor,
// so the scan waits out the exit's own settle time before it looks for what outlived it.
if (hostGone) sleep(SURVIVOR_GRACE_MS);
const survivorCheckRan = hostGone;
// The parent's argv list is fixed at arm time; anything learned later (the R9d inventory, or a
// mid-cleanup snapshot on an early exit) lands in the children file, merged here after the host
// is confirmed gone.
const allChildren = new Set(children);
if (childrenFilePath) {
  try {
    const extra = JSON.parse(fs.readFileSync(childrenFilePath, 'utf8'));
    for (const pid of Array.isArray(extra) ? extra : []) {
      if (Number.isFinite(Number(pid)) && Number(pid) > 0) allChildren.add(Number(pid));
    }
  } catch {}
}
const survivingPids = [];
if (survivorCheckRan) {
  for (const pid of allChildren) {
    if (pid === process.pid) continue;
    if (alive(pid) === true) survivingPids.push(pid);
  }
}
const matches = [];
// The scan's own PowerShell process carries the search token in its command line, so it would
// match itself and report a phantom survivor on a clean run. $PID is that process's own id and
// process.pid is this watcher's: neither is an owned process that outlived the GUI.
const listing = survivorCheckRan
  ? query('Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ' + process.pid + ' -and $_.CommandLine -like "*' + token + '*" } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress')
  : null;
if (typeof listing === 'string' && listing.trim()) {
  try {
    const parsed = JSON.parse(listing.trim());
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!entry || Number(entry.ProcessId) === process.pid) continue;
      matches.push({ pid: Number(entry.ProcessId), name: entry.Name, commandLine: String(entry.CommandLine || '').slice(0, 240) });
    }
  } catch (err) { log('listing parse failed: ' + String(err && err.message ? err.message : err)); }
}
const report = {
  hostPid,
  // The token names the data root this watcher was armed for. It is what lets the merging process
  // tell this run's report from a previous run's, whose host pid may even have been reused.
  dataRootToken: token,
  supported: true,
  platform: process.platform,
  hostState,
  hostGone,
  timedOut: !hostGone,
  ancestorQueryUnanswered: unansweredPolls,
  survivorCheckRan,
  descendantCheckSupported: true,
  windowMs: WATCH_WINDOW_MS,
  observedAfterExitMs: exitObservedAtMs === null ? null : exitObservedAtMs - (deadline - WATCH_WINDOW_MS),
  survivingPids,
  commandLineMatches: matches,
  pollCount,
  checkedAt: new Date().toISOString()
};
try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8'); } catch (err) { log('report write failed: ' + String(err && err.message ? err.message : err)); }
// Janitor: the host cannot delete its own data root while it is alive (Chromium profile and
// LevelDB handles are this process's own files), so removal happens here — strictly after the
// host is gone and after the report is on disk, with the same bounded-retry pattern the parent
// uses.
if (tempRootPath) {
  for (let attempt = 0; attempt < 12 && fs.existsSync(tempRootPath); attempt++) {
    try { fs.rmSync(tempRootPath, { recursive: true, force: true }); } catch (rmErr) { log('tempRoot rm attempt ' + attempt + ' failed: ' + String(rmErr && rmErr.message ? rmErr.message : rmErr)); }
    if (!fs.existsSync(tempRootPath)) break;
    const waitEnd = Date.now() + 125;
    while (Date.now() < waitEnd) { /* bounded wait for Windows to release handles */ }
  }
  log('tempRoot removed: ' + String(!fs.existsSync(tempRootPath)));
}
log('report written: ' + JSON.stringify(report));
})();
`;
  try {
    fs.writeFileSync(orphanLogPath, '', 'utf8');
    const child = spawn(process.execPath, [
      '-e', watcher,
      String(process.pid),
      dataRootToken,
      orphanReportPath,
      orphanLogPath,
      JSON.stringify(state.childrenBeforeExit ?? []),
      tempRoot,
      watcherChildrenFile,
    ], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...NODE_CHILD_ENV } });
    child.unref();
    // The watcher must outlive every sweep below: it is the only child exempt from teardown kills.
    teardown.watcherPid = child.pid;
    state.watcher = { pid: child.pid, reportPath: orphanReportPath, logPath: orphanLogPath, dataRootToken, descendantCheckSupported: process.platform === 'win32' };
    console.log(`[matrix] post-exit orphan watcher armed: pid ${child.pid}, report ${orphanReportPath}`);
  } catch (err) {
    state.watcher = { error: messageOf(err) };
    console.log(`[matrix] failed to arm the post-exit orphan watcher: ${messageOf(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Shutdown of the harness itself
// ---------------------------------------------------------------------------------------------
/**
 * Leave the process the way a user would when the run ended before its own exit row: stop the
 * sessions and the daemon this harness started, ask each remaining window to close and let the
 * shipping gate finish the quit. Only processes this harness started are touched.
 */
async function cleanup() {
  // The graceful path first: sessions and windows are asked to close so the shipping teardown can
  // write its journal. Whatever the graceful path misses is finished by the verified sweep below —
  // a detached host is designed to outlive this process, so a skip or a hang here is a leak.
  try {
    try { stopServer(); } catch {}
    const plane = (() => { try { return mainProcess.projectWindowAuthority.controlPlane(); } catch { return null; } })();
    if (!daemon.stopped && daemon.staged && daemon.beforeHandle && daemon.beforeHandle.port) {
      try {
        const proxy = new DaemonTerminalProxy({ port: daemon.beforeHandle.port, token: daemon.beforeHandle.token });
        await bounded(proxy.shutdownHost(), 15000, 'cleanup daemon shutdownHost');
        daemon.stopped = true;
      } catch (err) {
        daemon.cleanupError = messageOf(err);
      }
    }
    if (plane && !willQuitSeen) {
      for (const session of plane.terminal.listSessions(true)) {
        try { await bounded(plane.terminal.closeSession(session.id), 8000, `close session ${session.id}`); } catch {}
      }
    }
    try {
      if (!willQuitSeen) {
        for (const entry of mainProcess.projectWindowAuthority.snapshot()) {
          mainProcess.projectWindowAuthority.requestClose(entry.ownerKey);
        }
        const deadline = Date.now() + 8000;
        while (mainProcess.projectWindowAuthority.browserShellCount() > 0 && Date.now() < deadline) {
          await sleep(100);
        }
      }
    } catch {}
  } catch {}
  // Verified teardown: every daemon pid this run recorded (handles + the spawner's live record,
  // which also covers a daemon boot spawned before a handle could be captured) and every direct
  // OS child still alive. Kills are taskkill /T /F on confirmed-owned pids only; the orphan
  // watcher is the single exempt child so it can still observe the exit.
  // The freshest child inventory goes to the watcher before any kill, so its survivor list is the
  // truth about what was still attached at teardown time.
  recordChildrenForWatcher();
  sweepOwnedProcesses();
  // A lone rmSync silently loses to handles Windows has not released yet; bounded retries fix that.
  removeDirWithRetry(tempRoot);
}

let exitCode = 1;
let reported = false;
function writeReport() {
  if (reported) return exitCode;
  reported = true;
  preserveLifecycleJournal();
  const rows = ROW_PLAN.map(([id, criterion, observable, kind]) => {
    const result = rowResults.get(id);
    if (result) return result;
    return {
      id,
      criterion,
      observable,
      status: 'BLOCKED',
      reason: kind === 'hardware'
        ? 'needs physical hardware/human, and the run ended before this row reported'
        : kind === 'post-exit'
          ? state.watcher && state.watcher.pid
            // The watcher is armed, so the report the verdict comes from either exists already or
            // is still being written; the run simply ended before its normal path merged it.
            ? `decided after this process exits: the run ended before its normal path merged the watcher's report, which is armed at pid ${state.watcher.pid}; merge it with \`node scripts/probe-project-windows-matrix.cjs --verify-orphans\``
            : 'decided after this process exits, and the run ended before the watcher was armed'
          : 'the run ended before this row was observed (an earlier row failed or threw)',
      observed: {},
      ids: {},
    };
  });
  const checks = rows.map((row) => ({
    name: `${row.id} [criterion ${row.criterion}] ${row.observable}`,
    ok: row.status === 'PASS',
    ...(row.status === 'FAIL' ? { error: row.error } : {}),
    ...(row.status === 'BLOCKED' ? { error: `BLOCKED: ${row.reason}` } : {}),
  }));
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  const blockedCount = rows.filter((row) => row.status === 'BLOCKED').length;
  // A row that can silently not run is a defect in the harness, so the receipt carries the
  // coverage proof itself: the declared matrix, the emitted matrix, which rows this process
  // actually judged, and which ones were emitted without a judge.
  const declaredIds = ROW_PLAN.map(([id]) => id);
  const coverage = {
    declared: declaredIds.length,
    emitted: rows.length,
    judgedByThisProcess: rows.filter((row) => rowResults.has(row.id)).map((row) => row.id),
    emittedWithoutBeingJudged: rows.filter((row) => !rowResults.has(row.id)).map((row) => row.id),
    everyDeclaredRowEmittedExactlyOnce: rows.length === declaredIds.length && rows.every((row, index) => row.id === declaredIds[index]),
  };
  const result = {
    probe: 'project-windows-matrix',
    passed,
    failed,
    blocked: blockedCount,
    coverage,
    checks,
    rows,
    environment: observations.environment ?? {},
    observations,
    postExitVerification: {
      verdict: 'PENDING',
      witness: orphanReportPath,
      run: 'node scripts/probe-project-windows-matrix.cjs --verify-orphans',
      watcher: state.watcher ?? null,
    },
    notes: [
      'Phase-5 acceptance matrix for plans/260927-0315-project-windows/phase-05-certification.md.',
      'Every declared row is emitted: unobserved rows are BLOCKED, never omitted and never passed.',
      'Rows that need physical hardware or a human observer are BLOCKED with their reason and are not simulated with a fixture.',
      'Row R9E stays BLOCKED until the second process merges the post-exit watcher report.',
      `Row coverage: ${coverage.declared} declared, ${coverage.emitted} emitted, ${coverage.judgedByThisProcess.length} judged by this process, ${coverage.emittedWithoutBeingJudged.length} emitted without a judge (each carries its BLOCKED reason).`,
      `Exit codes: 0 all rows PASS; 1 at least one FAIL; 2 no FAIL but BLOCKED rows remain. This run: passed=${passed} failed=${failed} blocked=${blockedCount}.`,
    ],
    at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2), 'utf8');
  } catch (err) {
    origLog(`[matrix] failed to write evidence: ${messageOf(err)}`);
    exitCode = 1;
    return exitCode;
  }
  console.log(`\n[matrix] ${passed} passed, ${failed} failed, ${blockedCount} blocked — evidence: ${receiptPath}`);
  console.log(`[matrix] rows judged by this process: ${coverage.judgedByThisProcess.length}/${coverage.declared} (unjudged rows are emitted BLOCKED, never omitted)`);
  if (!coverage.everyDeclaredRowEmittedExactlyOnce) {
    // Only reachable if the writer itself is broken: the emitted rows are built from ROW_PLAN.
    console.log(`[matrix] HARNESS DEFECT: the emitted matrix does not match the declared matrix (declared ${coverage.declared}, emitted ${coverage.emitted})`);
    exitCode = 1;
    return exitCode;
  }
  if (failed > 0) {
    console.log(`[matrix] failed rows: ${rows.filter((row) => row.status === 'FAIL').map((row) => row.id).join(', ')}`);
  }
  if (blockedCount > 0) {
    console.log(`[matrix] blocked rows (hardware/human, post-exit or unobserved): ${rows.filter((row) => row.status === 'BLOCKED').map((row) => row.id).join(', ')}`);
    for (const row of rows.filter((entry) => entry.status === 'BLOCKED')) {
      console.log(`[matrix]   ${row.id}: ${row.reason}`);
    }
  }
  exitCode = failed > 0 ? 1 : blockedCount > 0 ? 2 : 0;
  return exitCode;
}

app.whenReady()
  .then(run)
  .catch((err) => {
    console.log(`\n[matrix] the run threw while at row ${currentRowId}: ${messageOf(err)}`);
  })
  .finally(async () => {
    // An emergency exit already ran the teardown and is about to leave; a second pass would only
    // race it.
    if (teardown.exiting) { process.exit(130); return; }
    teardown.exiting = true;
    currentRowId = 'cleanup';
    if (!state.watcher) armOrphanWatcher();
    await cleanup();
    process.exit(writeReport());
  });
