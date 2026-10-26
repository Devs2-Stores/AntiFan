/**
 * Live E2E: one terminal manager, many project windows — project assignment through the shipping app.
 *
 * Every project has its own window (owner key `project:<id>`) and that window's terminal list is
 * its own project's scope only; the shared Terminals window — the shell whose owner is
 * `unassigned` — is the one `managerAll` surface that lists every project's rows. The only thing
 * that keeps one project's shells out of another project's rows is the `project:<id>` owner key
 * stamped at mint time. This suite boots the real Electron process with a project window live,
 * opens a second project window and the shared manager, and then moves sessions between project
 * scopes through the same chrome IPC a user's tab context menu drives: one session minted by the
 * manager and handed to a project, one session minted by a project window and re-stamped to
 * another project through the shipped renderer's own context-menu flow, and one handed to a
 * project while no manager window exists to show the moved row — refused
 * (`TARGET_WINDOW_ABSENT`) first, then landed once the user's own menu entry recreates the
 * manager. A caller that names no window at all — a renderer no shell owns, or an MCP/attachment
 * caller — must stay refused, because the manager's superset view is a privilege of being a
 * window, not a process-wide default.
 *
 * How it runs: the scenario is a real Electron main-process script,
 * `terminal-capsule-assign-driver.cjs` beside this file, copied into a throwaway directory and launched through the
 * repository's own `scripts/run-electron.cjs`. The driver boots the shipping `src/main/index.ts`
 * inside the process (never a copy of it), drives each window's own chrome surfaces the way its
 * renderers do, and reports per-row results plus observations as JSON. Keeping the scenario
 * beside the assertions is what stops the two from drifting: a row that is not in
 * `EXPECTED_ROWS` fails the suite, and a row the driver stops reporting fails it too.
 *
 * Isolation: throwaway `ANTIFAN_DATA_ROOT`, `ANTIFAN_CONFIG_DIR`, `ANTIFAN_USER_DATA` and a
 * bridge port this test picks free before the launch, plus one real directory per project for
 * its capsule to point at. Every write this run performs happens inside those temp roots: the
 * driver's evidence file lives in a per-run evidence directory, and the developer's profile,
 * data root and capsules are never read or written.
 * Coverage split:
 *
 *   Automated here (a scripted harness observes them):
 *     - each project window lists the scope of its own project only; the shared manager lists
 *       the superset — per-project separation is carried by `project:<id>` owner stamps,
 *       asserted on the sessions themselves and on the rows every window lists
 *     - a session minted by the manager, assigned to a project through the real
 *       `TERMINAL_CHANNELS.ASSIGN_PROJECT` invoke, flips its ownerKey stamp, appears in the
 *       owning project's window and conjures no window of its own
 *     - a session minted by one project window is re-stamped to another project through the
 *       shipped renderer's own context-menu flow, keeping pid and cwd, and moves from the
 *       source window's list to the destination window's
 *     - assigning while NO Terminal Manager exists — and the sender is not the manager's own
 *       chrome — is refused (`TARGET_WINDOW_ABSENT`) and moves nothing; the same assign lands
 *       once the menu entry recreates the manager, and the destination's window, opened by the
 *       user afterwards, lists the moved row
 *     - a project known to the registry with no capsule is a valid destination: the assign
 *       clears the capsule stamp and its own window lists the row
 *     - a renderer no live shell owns, and an MCP attachment caller naming no window, are
 *       both refused instead of receiving the superset
 *     - every shell this run opened is closed again
 *
 *   Deferred, NOT faked here (see `DEFERRED_ROWS`):
 *     - the native tab-strip context menu's own click path: the menu is presented by the OS,
 *       which a headless run cannot drive; the row below invokes the same IPC that menu item
 *       invokes
 *     - the manager window's rendered rows (pixels), read here through the window's own preload
 *     - detached terminal-daemon survival of an assignment (the daemon is disabled in this
 *       isolated run; owned by the terminal smoke lane)
 *     - `agent:*` rows staying view-only in the manager (this lane mints no agent session)
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** Every row the driver must report, and the only ones it may report. */
const EXPECTED_ROWS: readonly string[] = [
  'terminal.project-windows-and-manager-hold-project-scopes',
  'terminal.manager-window-lists-every-project-scope',
  'terminal.manager-assigns-session-through-ipc',
  'terminal.assignment-moves-session-stamp',
  'terminal.assign-refuses-when-manager-window-absent',
  'terminal.window-less-chrome-caller-refused',
  'terminal.window-less-mcp-caller-refused',
  'terminal.cleanup-closes-every-shell',
];

/**
 * Rows this lane reports as unverified instead of simulating them. A rendered context menu
 * clicks that nobody clicked and a daemon that this isolated run deliberately disables are
 * claims about artifacts the process under test does not present here.
 */
const DEFERRED_ROWS: readonly string[] = [
  'native.tab-context-menu-click-path',
  'ui.manager-window-rendered-rows',
  'daemon.detached-assignment-survival',
  'agent.view-only-manager-rows',
];

const RUN_TIMEOUT_MS = 300_000;

interface DriverCheckRow {
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
  cleanupError?: string;
}

/** The observation fields the suite asserts on, declared here so the assertions stay typed. */
interface DriverObservations {
  startup: { ownerKey: string; windowId: number; shellCount: number };
  projectScopes: { alphaOwnerKey: string; betaOwnerKey: string; alpha: string[]; beta: string[] };
  managerScope: { ownerKey: string; list: string[] };
  assignReply: { ok: boolean; sessionId?: string; capsuleId?: string; ownerKey?: string; reason?: string };
  moved: {
    sessionId: string;
    previousOwnerKey: string;
    ownerKeyAfter: string;
    targetListed: boolean;
    sourceDropped: boolean;
    managerListed: boolean;
  };
  closedTarget: {
    refusal: { ok: boolean; reason?: string };
    reopenResult: { ownerKey?: string; windowId?: number };
    assignReply: { ok: boolean; ownerKey?: string };
    targetListed: boolean;
    previousManagerWindowId: number;
    unmappedCandidate?: unknown;
  };
  refusals: {
    chrome: { refused: boolean; message: string } | null;
    chromeIdentity: { name: string; code: string; isUnknownSenderError: boolean } | null;
    mcpNoAttachment: { isError: boolean; code: string; text: string } | null;
    mcpNoTab: { isError: boolean; code: string; text: string } | null;
  };
  teardown: { shellCount: number };
  [key: string]: unknown;
}

interface DriverEvidence {
  scenario: string;
  passed: number;
  failed: number;
  checks: DriverCheckRow[];
  observations: DriverObservations;
  deferred: string[];
  at: string;
}

/**
 * Kill the Electron child this suite spawned, and nothing else.
 *
 * Ownership is the `proc` handle: the PID is the child this test created with `spawn`, the
 * tree flag takes the helpers that child started, and no other process is ever matched by
 * name. A hung child is the only reason this runs — the watchdog below — and it is the same
 * teardown the repository's own multi-shell lane performs.
 */
function killOwnedChildTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    proc.kill('SIGKILL');
  } catch {}
}

/**
 * A port nothing is listening on, asked of the OS. Two Electron runs on this machine must not
 * collide on the bridge port, and a hard-coded port would either refuse to boot or, worse,
 * attach to whatever already owns it.
 */
async function pickFreePort(): Promise<number> {
  const assigned = Promise.withResolvers<number>();
  const server = net.createServer();
  server.on('error', assigned.reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => {
      if (port > 0) assigned.resolve(port);
      else assigned.reject(new Error('the OS assigned no port'));
    });
  });
  return assigned.promise;
}

describe('Live E2E: terminal capsule assignment across project scopes', () => {
  it('moves a session between project scopes through the real assign IPC, and refuses a window-less caller', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const compiledEntry = path.join(rootDir, '.compiled', 'src', 'main', 'index.js');
    assert.ok(fs.existsSync(runnerScript), `the Electron runner is missing: ${runnerScript}`);
    assert.ok(
      fs.existsSync(compiledEntry),
      `the compiled main process is missing (${compiledEntry}); run \`npm run compile\` before the e2e lane`,
    );

    // The scenario is a plain file beside this test, so it parses, lints and diffs like code. It
    // is copied into a throwaway directory before it runs: the driver writes next to itself
    // (its `__dirname`), and the repository tree must never receive those files.
    const driverSourcePath = path.join(rootDir, 'test', 'e2e', 'terminal-capsule-assign-driver.cjs');
    assert.ok(fs.existsSync(driverSourcePath), `the scenario driver is missing: ${driverSourcePath}`);

    const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-driver-'));
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-evidence-'));
    const driverPath = path.join(driverDir, 'terminal-capsule-assign-driver.cjs');
    const evidencePath = path.join(evidenceDir, 'terminal-capsule-assign-e2e.json');
    fs.copyFileSync(driverSourcePath, driverPath);
    try { fs.unlinkSync(evidencePath); } catch {}

    // A broken scenario must fail here rather than half-way through an Electron boot.
    const syntax = spawnSync(process.execPath, ['--check', driverPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `the driver does not parse:\n${syntax.stdout}\n${syntax.stderr}`);

    const port = await pickFreePort();
    // The child must never inherit a running app's identity: every ANTIFAN_* variable of this
    // shell (bridge endpoint, terminal session, data/config/profile roots) is dropped, and the
    // three roots point at a throwaway directory from the first instruction of the launch, ahead
    // of the driver's own per-run root.
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('ANTIFAN_')) env[name] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-launch-'));
    env.ANTIFAN_DATA_ROOT = launchRoot;
    env.ANTIFAN_CONFIG_DIR = path.join(launchRoot, 'config');
    env.ANTIFAN_USER_DATA = path.join(launchRoot, 'Profile');
    env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
    env.ANTIFAN_DRIVER_REPO_ROOT = rootDir;
    env.ANTIFAN_DRIVER_EVIDENCE = evidencePath;
    env.ANTIFAN_DRIVER_BRIDGE_PORT = String(port);

    const proc = spawn(process.execPath, [runnerScript, driverPath], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr?.on('data', (data) => { stderr += data.toString('utf8'); });

    // A wall-clock watchdog for a hung Electron child, which no fake timer can reap. It kills
    // only the child this suite spawned (`proc`), never a process named or found by pattern.
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killOwnedChildTree(proc);
    }, RUN_TIMEOUT_MS);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    proc.once('error', exited.reject);
    proc.once('exit', (code, signal) => exited.resolve({ code, signal }));
    try {
      exit = await exited.promise;
    } finally {
      clearTimeout(timeoutTimer);
      killOwnedChildTree(proc);
    }

    const transcript = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    /** The scenario's own receipt, so a failed assertion can quote what the run recorded. */
    const readEvidence = (): DriverEvidence | null => {
      try {
        return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as DriverEvidence;
      } catch {
        return null;
      }
    };
    try {
      assert.equal(timedOut, false, `the capsule-assign scenario timed out after ${RUN_TIMEOUT_MS}ms; killed child exited with code ${exit.code}, signal ${exit.signal}\n${transcript}`);
      // The single-instance lock is keyed by the profile this run created; a refusal here would
      // mean the scenario attached to someone else's instance instead of its own.
      assert.ok(!stdout.includes('Another instance is already running'), `the run was refused the single-instance lock\n${transcript}`);
      assert.equal(exit.code, 0, `the capsule-assign scenario must exit cleanly\n${transcript}`);
      assert.match(stdout, /\[terminal-capsule-assign-e2e\] \d+ passed, 0 failed/);
      assert.ok(fs.existsSync(evidencePath), `the scenario wrote no evidence at ${evidencePath}\n${transcript}`);

      const evidence = readEvidence();
      assert.ok(evidence, `the evidence at ${evidencePath} is not readable JSON\n${transcript}`);
      assert.equal(evidence.scenario, 'terminal-capsule-assign');
      assert.equal(evidence.failed, 0, `the scenario reported failures: ${JSON.stringify(evidence.checks.filter((row) => !row.ok))}`);

      const reported = evidence.checks.map((row) => row.name);
      for (const name of EXPECTED_ROWS) {
        assert.ok(reported.includes(name), `the driver never reported row ${name}`);
      }
      // A row the suite does not know may only ever arrive failing: the driver's own
      // "unexpected throw" row is the one legitimate extra, and renaming a real row still trips
      // the loop above.
      const unexpected = evidence.checks.filter((row) => row.ok && !EXPECTED_ROWS.includes(row.name));
      assert.deepEqual(unexpected, [], 'the driver reported a passing row the suite does not know about');
      for (const row of evidence.checks) {
        assert.equal(row.ok, true, `row ${row.name} failed: ${row.error}`);
      }
      assert.deepEqual(evidence.deferred, [...DEFERRED_ROWS], 'the deferred-row list changed without the suite following');

      const observed = evidence.observations;
      // (1) one window per project, two project scopes carried by `project:<id>` stamps. The
      // startup window is the project the environment named; the driver's own row also asserts the
      // live shell count at each step, and here the recorded owners must be the distinct
      // per-project keys the sessions were minted under.
      assert.equal(
        observed.startup.ownerKey,
        'project:project-00000000-0000-4000-8000-0000000000a1',
        'the startup window was not the project the environment named',
      );
      assert.equal(observed.startup.shellCount, 1, 'the startup opened more than one window');
      assert.equal(
        observed.projectScopes.alphaOwnerKey,
        'project:project-00000000-0000-4000-8000-0000000000a1',
        'the ALPHA session was not stamped with its own project owner',
      );
      assert.equal(
        observed.projectScopes.betaOwnerKey,
        'project:project-00000000-0000-4000-8000-0000000000b2',
        'the BETA session was not stamped with its own project owner',
      );
      assert.notEqual(
        observed.projectScopes.alphaOwnerKey,
        observed.projectScopes.betaOwnerKey,
        'both project sessions reported the same owner key',
      );
      assert.ok(observed.projectScopes.alpha.length > 0, 'the ALPHA window listed no terminal under the ALPHA stamp');
      assert.ok(observed.projectScopes.beta.length > 0, 'the BETA window listed no terminal under the BETA stamp');
      // (2)+(3) the manager lists both projects, and the assignment answers for the target.
      assert.ok(observed.managerScope.list.length >= 2, 'the manager window did not list both projects');
      assert.equal(observed.managerScope.ownerKey, 'unassigned', 'the manager window owner key changed');
      assert.equal(observed.assignReply.ok, true, 'the assign invoke was refused');
      assert.equal(
        observed.assignReply.ownerKey,
        observed.projectScopes.betaOwnerKey,
        'the assign answered with an owner other than the target project',
      );
      // (4) the move re-stamped the session: the window it left dropped the row, the destination
      // window and the manager list it.
      assert.equal(observed.moved.ownerKeyAfter, observed.projectScopes.betaOwnerKey, 'the moved session was not re-stamped to the target project');
      assert.equal(observed.moved.targetListed, true, 'the destination project window never listed the moved session');
      assert.equal(observed.moved.sourceDropped, true, 'the scope the session moved out of still lists it');
      assert.equal(observed.moved.managerListed, true, 'the manager window stopped listing the moved session');
      // (5) assigning with no Terminal Manager is refused; recreating the manager through its
      // menu entry makes the same assign land on the destination's scope.
      assert.equal(observed.closedTarget.refusal.ok, false, 'the manager-absent assign was accepted');
      assert.equal(observed.closedTarget.refusal.reason, 'TARGET_WINDOW_ABSENT', 'the manager-absent refusal reason changed');
      assert.equal(observed.closedTarget.reopenResult.ownerKey, 'unassigned', 'the recreated surface is not the manager');
      assert.notEqual(
        observed.closedTarget.reopenResult.windowId,
        observed.closedTarget.previousManagerWindowId,
        'the reopened manager claims the destroyed window id',
      );
      assert.equal(observed.closedTarget.assignReply.ok, true, 'the assign was refused after the manager reopened');
      assert.equal(observed.closedTarget.targetListed, true, 'the destination scope never listed the assigned session');
      // (6)+(7) a caller that names no window is refused, and receives no rows.
      assert.equal(observed.refusals.chrome?.refused, true, 'a renderer no live shell owns was not refused');
      assert.equal(
        observed.refusals.chromeIdentity?.isUnknownSenderError,
        true,
        'the router did not refuse the unknown sender with its own error class',
      );
      assert.equal(observed.refusals.mcpNoAttachment?.isError, true, 'an MCP caller with no attachment was not refused');
      assert.equal(
        observed.refusals.mcpNoAttachment?.code,
        'ATTACHMENT_REQUIRED',
        'the attachmentless MCP refusal code changed',
      );
      assert.equal(observed.refusals.mcpNoTab?.isError, true, 'an MCP attachment naming no tab was not refused');
      assert.equal(observed.refusals.mcpNoTab?.code, 'TERMINAL_FORBIDDEN', 'the window-less MCP refusal code changed');
      // (8) nothing this run opened is still alive.
      assert.equal(observed.teardown.shellCount, 1, 'the run left more than the reporting window behind');
    } catch (err) {
      // The evidence the assertions just read is the only durable trace of the run, and it lives
      // in a temp directory this suite removes: quote it in the failure instead of losing it.
      const evidence = readEvidence();
      const detail = evidence ? `\nevidence: ${JSON.stringify(evidence, null, 2)}` : '';
      throw new Error(`${(err as Error).message}${detail}`);
    } finally {
      // Every directory is this suite's own mkdtemp root, named by this lane's prefix.
      for (const dir of [driverDir, evidenceDir, launchRoot]) {
        if (path.basename(dir).startsWith('antifan-tca-e2e-')) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
