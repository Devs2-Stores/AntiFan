/**
 * Live daemon output ordering: a real burst of PTY output arrives at the GUI-facing proxy as
 * coalesced `{seq, throughSeq}` frames with no reorder, no overlap, and no gap, and the `exit`
 * lifecycle frame can never overtake the bytes that preceded it — the daemon broadcasts
 * pending output inside the same call that emits the lifecycle event.
 *
 * Why the daemon lane: the coalescer lives inside the staged host (`daemon-entry.ts` +
 * `output-batcher.ts`); an in-process `OutputBatcher` unit test proves the class, not the wiring.
 * This run stages the shipped host into a throwaway data root, attaches the real proxy, and
 * observes the frames exactly the way `native-tab-host` does.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { ensureDaemon } from '../../src/main/terminal-daemon/daemon-spawner';
import { DaemonTerminalProxy } from '../../src/main/terminal-daemon/daemon-client';

function resolveRepoRoot(): string {
  for (let dir = __dirname; ; ) {
    if (fs.existsSync(path.join(dir, 'scripts', 'stage-daemon-host.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = resolveRepoRoot();
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-batch-'));
const READY_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
/**
 * Poll until a condition holds. Real-time exception (see ts-no-test-timers): the shell and the
 * daemon are separate OS processes whose output arrives over a real WebSocket — the only honest
 * wait is on the observed frames themselves, and fake timers cannot advance another process.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

interface DataFrame {
  sessionId?: string;
  data?: string;
  seq?: number;
  fromSeq?: number;
  throughSeq?: number;
  generation?: number;
}
interface Frame {
  kind: 'data' | 'exit';
  payload: Record<string, unknown>;
}

/** Wire shape of `antifan:terminal:exit`, re-emitted by the proxy as bare `exit`. */
interface ExitFrame {
  sessionId?: string;
  sessionGeneration?: number;
  exitCode?: number;
  signal?: number;
  lastSeq?: number;
  exitedAt?: number;
}

describe('Live daemon output batching & lifecycle ordering', () => {
  let proxy: DaemonTerminalProxy | null = null;
  let daemonPid = 0;
  const previous = { data: process.env.ANTIFAN_DATA_ROOT, config: process.env.ANTIFAN_CONFIG_DIR, conpty: process.env.ANTIFAN_USE_CONPTY };

  after(async () => {
    try { await proxy?.shutdownHost(); } catch {}
    for (let i = 0; i < 24 && daemonPid; i++) {
      try { process.kill(daemonPid, 0); await sleep(250); } catch { break; }
    }
    try { proxy?.dispose(); } catch {}
    if (previous.data === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previous.data;
    if (previous.config === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = previous.config;
    if (previous.conpty === undefined) delete process.env.ANTIFAN_USE_CONPTY;
    else process.env.ANTIFAN_USE_CONPTY = previous.conpty;
    StorageLocations.resetCache();
    try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch {}
  });

  it('coalesces a burst into ordered contiguous frames and reports the exit only after the output', async () => {
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_ROOT;
    process.env.ANTIFAN_CONFIG_DIR = SCRATCH_ROOT;
    StorageLocations.resetCache();
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    // winpty polls the hidden console on a ~16ms cadence, so every PTY read would land outside
    // the batcher's 8ms window and coalescing could never engage; ConPTY (documented opt-in)
    // drains the pipe in sub-millisecond bursts that the batcher provably tiles together.
    process.env.ANTIFAN_USE_CONPTY = '1';

    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTIFAN_DATA_ROOT: SCRATCH_ROOT },
    });
    const spawned = await ensureDaemon({ cwd: SCRATCH_ROOT });
    assert.notStrictEqual(spawned.mode, 'in-process', `no daemon host: ${spawned.reason || 'unknown reason'}`);
    const handle = spawned.handle!;
    daemonPid = handle.pid;

    proxy = new DaemonTerminalProxy({ port: handle.port, token: handle.token });
    await proxy.connect();

    const frames: Frame[] = [];
    proxy.on('data', (payload: unknown) => frames.push({ kind: 'data', payload: payload as Record<string, unknown> }));
    proxy.on('exit', (payload: unknown) => frames.push({ kind: 'exit', payload: payload as Record<string, unknown> }));

    const sessionId = await proxy.createSession(SCRATCH_ROOT);
    assert.strictEqual(typeof sessionId, 'string');
    const ready = await proxy.waitReady(sessionId, READY_TIMEOUT_MS);
    assert.strictEqual(ready, true, 'the shell must reach a prompt before input');

    // `exit` inside the shell ends the PTY; TerminalManager emits `exit`, which daemon-entry
    // forwards as the wire's lifecycle terminal frame after flushing every pending output batch.
    // (`session-closed` is reserved for explicit kills — a natural exit never emits it.)
    // The burst is ONE 400KB in-memory write: a per-line pipeline loop drips output slower than the
    // batcher's 8ms window and every read escapes through its idle-lane bypass, while a buffered
    // write makes ConPTY hand reads back-to-back so coalescing provably engages.
    await proxy.writeTo(sessionId, "[Console]::Write(('y' * 400000)); exit\r");

    const isExitFrame = (f: Frame): boolean => f.kind === 'exit' && (f.payload as ExitFrame).sessionId === sessionId;
    await waitFor(() => frames.some(isExitFrame), 'the exit lifecycle event');

    const dataFrames = frames.filter((f): f is Frame => f.kind === 'data')
      .map((f) => f.payload as DataFrame)
      .filter((d) => d.sessionId === sessionId);
    const exitIdx = frames.findIndex(isExitFrame);
    assert.ok(exitIdx >= 0, 'the daemon forwarded an exit event for this session');
    const exitPayload = frames[exitIdx]!.payload as ExitFrame;
    assert.strictEqual(exitPayload.exitCode, 0, 'the shell exited cleanly');
    assert.strictEqual(typeof exitPayload.lastSeq, 'number', 'exit carries the terminal sequence watermark');
    assert.ok(dataFrames.length >= 1, 'the burst produced at least one data frame for this session');

    // The lifecycle frame must follow every byte: the last data frame sits strictly before it.
    const lastDataIdx = frames.map((f, i) => ({ f, i }))
      .filter(({ f }) => f.kind === 'data' && (f.payload as DataFrame).sessionId === sessionId)
      .at(-1)!.i;
    assert.ok(lastDataIdx < exitIdx, 'every output frame precedes the lifecycle event');

    // Sequence contract: each frame is contiguous within itself (fromSeq <= throughSeq), frames
    // arrive in order, and consecutive frames tile the range with no gap and no overlap. The exit
    // payload's lastSeq is the same watermark the data frames tiled up to.
    let covered = 0;
    let prevEnd = 0;
    for (const d of dataFrames) {
      // `seq` aliases throughSeq on every data frame; a coalesced batch's true start is fromSeq.
      const from = typeof d.fromSeq === 'number' ? d.fromSeq : d.seq;
      const through = typeof d.throughSeq === 'number' ? d.throughSeq : d.seq;
      assert.ok(from !== undefined && through !== undefined,
        `every data frame carries a numeric seq range, got seq=${d.seq} throughSeq=${d.throughSeq}`);
      assert.ok(through! >= from!, `frame range is internally consistent (${from}..${through})`);
      assert.strictEqual(from, prevEnd + 1,
        `frames tile the range contiguously: expected seq ${prevEnd + 1}, got ${from} (no gap, no rewind)`);
      covered += through! - from! + 1;
      prevEnd = through!;
    }
    assert.strictEqual(exitPayload.lastSeq, prevEnd,
      'the exit watermark equals the last emitted seq — no data can trail the lifecycle event');
    assert.ok(covered > 1, 'the burst produced more than one sequenced chunk');
    assert.ok(covered > dataFrames.length,
      `coalescing actually engaged: ${covered} chunks arrived on ${dataFrames.length} frames`);
    assert.ok(dataFrames.length <= covered,
      'the daemon sends fewer frames than the raw PTY emitted chunks');
  });
});
