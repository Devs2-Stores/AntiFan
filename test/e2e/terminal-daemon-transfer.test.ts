/**
 * Live daemon regression: a handover reaches the real terminal host over the real WebSocket
 * transport, lands on the owner+capsule in one write, and moves the row without touching its
 * shell. The public seam under test is `TerminalManager.transferSessionOwner` invoked on the
 * installed process-wide singleton — the exact call `native-tab-host.ts` makes inside the
 * `antifan:terminal:assign-capsule` route — so a facade that lacks that name fails here as the
 * reported `transferSessionOwner is not a function`, not as a narrowed transport trace.
 *
 * Why the daemon lane: the GUI installs the DaemonTerminalProxy as the singleton by cast
 * (`src/main/index.ts`), so an in-process-only test can never see the seam the user hits. This
 * run stages the shipped host bundle into a throwaway data root, attaches the real proxy, and
 * installs it through the same `TerminalManager.setInstance` the composition root uses.
 *
 * Assertions cover the round trip the route promises: owner AND capsule move together, a target
 * project with no workspace clears the stale capsule stamp, the daemon's persisted journal
 * carries the new stamps, a reconnect (the GUI-restart equivalent) still reads the moved row,
 * and the shell answers after the move on the same session generation — the transfer re-stamped
 * a record, it did not restart the PTY.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { ensureDaemon } from '../../src/main/terminal-daemon/daemon-spawner';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';

/**
 * The repository root, which is where `scripts/stage-daemon-host.mjs` lives — this lane stages the
 * compiled host itself, so it cannot be run against a build tree alone.
 *
 * Compiled, this file sits at `<repo>/.compiled/test/e2e/`, so `__dirname/../..` would land on
 * `<repo>/.compiled` and the staging step would look for a script that is never copied there. The
 * staging script is the marker: walk up until a directory owns it, and fall back to the invocation
 * cwd so a source-tree run (where the walk already succeeds) and a compiled run agree.
 */
function resolveRepoRoot(): string {
  for (let dir = __dirname; ; ) {
    if (fs.existsSync(path.join(dir, 'scripts', 'stage-daemon-host.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = resolveRepoRoot();
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-transfer-'));
const MARKER = `AF_TRANSFER_${process.pid}_${Date.now()}`;
const READY_TIMEOUT_MS = 30_000;

const ALPHA_OWNER = 'project:proj-alpha';
const BETA_OWNER = 'project:proj-beta';

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Poll until a condition holds. The shell and the daemon are separate OS processes, so the only
 * honest wait is on the observed condition itself — fake timers cannot advance a real PTY's
 * output or another process's write.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Strip the escape sequences the PTY wraps around output so the marker match sees content. */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const flatten = (s: string) => s.replace(ANSI_RE, '').replace(/\r?\n/g, '');

interface SessionProjection {
  id: string;
  ownerKey?: string;
  capsuleId?: string;
  cwd?: string;
  sessionGeneration?: number;
  state?: string;
}

/** One row of the daemon's own diagnostics report: the runtime record, keyed by session id. */
interface DiagnosticsRow {
  sessionId: string;
  generation?: number;
  ownerKey?: string;
  capsuleId?: string;
}

interface DiagnosticsProjection {
  sessions: DiagnosticsRow[];
}

function projection(list: unknown, sessionId: string): SessionProjection {
  const sessions = Array.isArray(list) ? (list as SessionProjection[]) : [];
  const found = sessions.find((s) => s.id === sessionId);
  assert.ok(found, `session ${sessionId} must be projected by the daemon's summaries`);
  return found;
}

/** The daemon's session journal — the file a GUI restart restores the moved row from. */
function savedSessionRow(sessionId: string): Record<string, unknown> {
  const statePath = path.join(SCRATCH_ROOT, 'terminal-sessions.json');
  assert.ok(fs.existsSync(statePath), `the daemon must have flushed ${statePath}`);
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { sessions?: Array<Record<string, unknown>> };
  const row = (parsed.sessions || []).find((s) => s.id === sessionId);
  assert.ok(row, `session ${sessionId} must be a persisted row`);
  return row;
}

describe('Live daemon handover (TerminalManager.getInstance().transferSessionOwner)', () => {
  let proxy: DaemonTerminalProxy | null = null;
  let reattached: DaemonTerminalProxy | null = null;
  let daemonPid = 0;
  const previous = { data: process.env.ANTIFAN_DATA_ROOT, config: process.env.ANTIFAN_CONFIG_DIR };

  after(async () => {
    // The host owns its records; ask it to persist and shut down rather than killing the tree,
    // so the file assertions above prove the path the next GUI boot would restore from.
    try { reattached?.persistSync(); } catch {}
    try { await reattached?.shutdownHost(); } catch {}
    try { await proxy?.shutdownHost(); } catch {}
    for (let i = 0; i < 24 && daemonPid; i++) {
      try { process.kill(daemonPid, 0); await sleep(250); } catch { break; }
    }
    try { proxy?.dispose(); } catch {}
    try { reattached?.dispose(); } catch {}
    if (previous.data === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previous.data;
    if (previous.config === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = previous.config;
    StorageLocations.resetCache();
    try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch {}
  });

  it('moves owner and capsule through the daemon, clears the stamp for a workspace-less project, and never restarts the shell', async () => {
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = SCRATCH_ROOT;
    StorageLocations.resetCache();
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

    // Stage the current compiled tree into this run's data root, exactly as the spawner expects.
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTIFAN_DATA_ROOT: SCRATCH_ROOT },
    });
    const spawned = await ensureDaemon({ cwd: SCRATCH_ROOT });
    assert.notStrictEqual(spawned.mode, 'in-process', `no daemon host: ${spawned.reason || 'unknown reason'}`);
    const handle = spawned.handle!;
    daemonPid = handle.pid;
    try {
      process.kill(daemonPid, 0);
    } catch {
      assert.fail(`daemon host ${daemonPid} is not alive`);
    }

    proxy = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
    await proxy.connect();
    // Install through the same cast the composition root uses, so the call below is literally
    // `TerminalManager.getInstance().transferSessionOwner(...)` — the route's public seam.
    TerminalManager.setInstance(proxy as unknown as TerminalManager);
    const singleton = TerminalManager.getInstance() as unknown as {
      transferSessionOwner(sessionId: string, ownerKey: string, capsuleId?: string): Promise<boolean> | boolean;
      createSession(cwd?: string, capsuleId?: string, ownerKey?: string): Promise<string> | string;
      waitReady(sessionId: string, timeoutMs?: number): Promise<boolean>;
      writeTo(sessionId: string, input: string): Promise<boolean>;
      getFullBuffer(sessionId: string): Promise<{ buffer?: string }>;
      listSessions(): unknown[];
      getDiagnostics(): Promise<unknown>;
      persistSync(): void;
      sessionOwnerKey(sessionId: string): string | undefined;
      sessionCapsuleId(sessionId: string): string | undefined;
    };
    assert.strictEqual(typeof singleton.transferSessionOwner, 'function',
      'the installed daemon facade must answer the manager\'s public handover method');

    const sessionId = await Promise.resolve(singleton.createSession(SCRATCH_ROOT, 'capsule-alpha', ALPHA_OWNER));
    assert.strictEqual(typeof sessionId, 'string');
    const ready = await singleton.waitReady(sessionId, READY_TIMEOUT_MS);
    assert.strictEqual(ready, true, 'the shell must reach a prompt before input');
    // The new-session broadcast reaches the cache asynchronously after the RPC answer; wait until
    // the summary carries the row before reading its generation.
    await waitFor(() => (singleton.listSessions() as SessionProjection[])
      .some((s) => s.id === sessionId && (s.sessionGeneration || 0) > 0),
      'the session projection to carry its live generation');
    const generation = projection(singleton.listSessions(), sessionId).sessionGeneration;
    assert.ok(generation && generation > 0, 'a live session has a generation a restart would bump');

    // Drive input through the moved session so the post-move echo proves the same shell answered.
    await singleton.writeTo(sessionId, `Write-Output ${MARKER}-before\r`);
    // The shell's transcript is the observable proof the input ran — read it through the same
    // RPC the renderer uses, not the session-push cache that only updates on lifecycle events.
    await waitFor(async () => {
      const full = await singleton.getFullBuffer(sessionId);
      return flatten(full.buffer || '').includes(`${MARKER}-before`);
    }, 'the pre-move marker echoed by the live shell');

    /* ---- handover: alpha's workspace -> beta's workspace ---- */
    const moved = await Promise.resolve(singleton.transferSessionOwner(sessionId, BETA_OWNER, 'capsule-beta'));
    assert.strictEqual(moved, true, 'the daemon answers the same boolean the in-process seam returns');
    assert.strictEqual(singleton.sessionOwnerKey(sessionId), BETA_OWNER,
      'the cache the window scope reads carries the new owner once the move settles');
    assert.strictEqual(singleton.sessionCapsuleId(sessionId), 'capsule-beta');

    const diag = await singleton.getDiagnostics() as DiagnosticsProjection;
    const diagRow = diag.sessions.find((s) => s.sessionId === sessionId);
    assert.strictEqual(diagRow?.ownerKey, BETA_OWNER, 'the daemon-side record moved, not just the proxy cache');
    assert.strictEqual(diagRow?.capsuleId, 'capsule-beta');
    assert.strictEqual(diagRow?.generation, generation,
      'a handover re-stamps the record; a restarted shell would report a new generation');

    /* ---- handover back: beta -> alpha with NO workspace (capsule cleared) ---- */
    const cleared = await Promise.resolve(singleton.transferSessionOwner(sessionId, ALPHA_OWNER));
    assert.strictEqual(cleared, true, 'a workspace-less target is a valid move');
    assert.strictEqual(singleton.sessionOwnerKey(sessionId), ALPHA_OWNER);
    assert.strictEqual(singleton.sessionCapsuleId(sessionId), undefined,
      'the workspace stamp is cleared, not preserved and not emptied');

    // Persist through the real single writer, then read the journal the restore path reads.
    singleton.persistSync();
    await waitFor(() => {
      try {
        const row = savedSessionRow(sessionId);
        return row.ownerKey === ALPHA_OWNER && row.capsuleId === undefined;
      } catch { return false; }
    }, 'the persisted row to carry the cleared stamp');
    const row = savedSessionRow(sessionId);
    assert.strictEqual(row.ownerKey, ALPHA_OWNER, 'the journal restores the row under the new owner');
    // A cleared stamp serializes as an absent key (JSON.stringify drops undefined fields), which
    // reads back as `row.capsuleId === undefined` — the same answer either way.
    assert.strictEqual(row.capsuleId, undefined, 'the journal restores the row with no workspace stamp');

    /* ---- the shell kept running on the same generation across the moves ---- */
    await singleton.writeTo(sessionId, `Write-Output ${MARKER}-after\r`);
    await waitFor(async () => {
      const full = await singleton.getFullBuffer(sessionId);
      return flatten(full.buffer || '').includes(`${MARKER}-after`);
    }, 'the post-move marker from the same shell');
    const afterDiag = await singleton.getDiagnostics() as DiagnosticsProjection;
    assert.strictEqual(afterDiag.sessions.find((s) => s.sessionId === sessionId)?.generation, generation,
      'the shell answering after the move is the shell that was moved');

    /* ---- GUI-restart seam: a second proxy attaches to the same host and sees the moved row ---- */
    reattached = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
    await reattached.connect();
    assert.strictEqual(reattached.sessionOwnerKey(sessionId), ALPHA_OWNER,
      'a client attaching after the move reads the new owner — the restore contract');
    assert.strictEqual(reattached.sessionCapsuleId(sessionId), undefined);
    const reattachedDiag = await reattached.getDiagnostics() as DiagnosticsProjection;
    assert.strictEqual(reattachedDiag.sessions.find((s) => s.sessionId === sessionId)?.generation, generation,
      'the re-attached GUI sees the same shell generation, so no restart rode along with the move');
  });
});
