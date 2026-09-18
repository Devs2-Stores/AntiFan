/**
 * Persist-cost probe — measures what the storage split (Phase 3) is supposed to fix.
 *
 * The plan requires a measurement before any design, because the earlier draft asserted a
 * "300-800ms freeze" that was never observed and had to be withdrawn. This measures the real thing:
 * `persistSync()` on the production TerminalManager, against state files of controlled size.
 *
 * How size is controlled: the probe writes a synthetic `terminal-sessions.json` with the exact
 * session count and transcript bytes it wants (respecting MAX_PERSISTED_BYTES = 1 MiB per session),
 * starts a host pointed at it, waits for the restore, then times `terminalPersistSync` over RPC.
 * Driving the size through real shell output instead would conflate formatting throughput with flush
 * cost and take minutes per data point.
 *
 * Timing: median of repeated samples. Transport time is measured separately with `terminalHostPing`
 * and subtracted, so the reported figure is host-side flush work, not round-trip latency.
 *
 * Run: node scripts/probe-persist-cost.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const COMPILED = path.join(ROOT, '.compiled', 'src', 'main', 'terminal-daemon');
const probeDir = process.env.PROBE_DIR || path.join(os.tmpdir(), 'antifan-persist-cost');

process.env.ANTIFAN_DATA_ROOT = probeDir;
process.env.ANTIFAN_CONFIG_DIR = probeDir;

const { execFileSync } = require('node:child_process');
const { ensureDaemon } = require(path.join(COMPILED, 'daemon-spawner.js'));
const { DaemonClient } = require(path.join(COMPILED, 'daemon-client.js'));
const { HOST_METHOD } = require(path.join(COMPILED, 'protocol.js'));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeCall(client, method, params, samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint();
    await client.call(method, params);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
}

function stateFile() {
  return path.join(probeDir, 'terminal-sessions.json');
}

function fileSize() {
  try { return fs.statSync(stateFile()).size; } catch { return 0; }
}

/**
 * A state file with `sessions` sleeping sessions, each carrying `perSessionBytes` of transcript.
 *
 * Sleeping is deliberate. For a *live* session the persisted record holds only its live buffer —
 * the restored transcript lives in `restoredTail` and is deliberately not re-written for live
 * sessions (terminal-manager.ts:735-738), so seeding live records and booting a host would replace
 * them with a few bytes of shell prompt and measure nothing. Sleeping records keep the transcript in
 * `restoredTail`, which is persisted (capped at MAX_PERSISTED_BYTES = 1 MiB) and restored without
 * spawning a shell, so the file stays at the size under test.
 */
function seedStateFile(sessions, perSessionBytes) {
  const line = 'x'.repeat(63);
  const lineCost = line.length + 1;
  const lines = Math.max(1, Math.floor(perSessionBytes / lineCost));
  const body = Array.from({ length: lines }, (_, i) => `${line}${(i % 10)}`).join('\n');

  const entries = [];
  for (let i = 0; i < sessions; i++) {
    const id = i === 0 ? 'terminal-1' : `terminal-${i + 1}`;
    entries.push({
      id,
      name: `session ${i + 1}`,
      cwd: probeDir,
      buffer: '',
      bufferLength: 0,
      restoredTail: body,
      sessionGeneration: 1,
      cols: 120,
      rows: 30,
      state: 'sleeping',
      sleptAt: Date.now(),
    });
  }
  fs.writeFileSync(stateFile(), JSON.stringify({
    activeSessionId: 'terminal-1',
    lastCols: 120,
    lastRows: 30,
    sessions: entries,
  }));
}

/** Start a host against the seeded file, return a connected client. */
async function startHost(label) {
  const spawned = await ensureDaemon({ cwd: probeDir });
  if (spawned.mode === 'in-process') throw new Error(`${label}: no host (${spawned.reason})`);
  const client = new DaemonClient({ port: spawned.handle.port, token: spawned.handle.token });
  const list = await client.call(HOST_METHOD.listSessions);
  return { spawned, client, sessionCount: list.sessions.length };
}

async function run() {
  const rows = [];
  const checks = [];
  const hosts = [];
  let exitCode = 0;

  function record(name, pass, detail) {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.mkdirSync(probeDir, { recursive: true });
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-daemon-host.mjs'), '--json'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTIFAN_DATA_ROOT: probeDir },
      });
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      throw new Error(`staging failed: ${stderr || (err && err.message ? err.message : err)}`);
    }

    console.log('sessions | seeded MB | stored MB | ping ms | cold ms | warm ms | write ms | join ms');
    console.log('---------|-----------|-----------|---------|---------|---------|-----------');

    // Cases chosen to separate the two candidate cost drivers: byte volume (rows 1-2) and session
    // count at fixed volume (rows 3-4). If cost tracks bytes only, splitting per session buys nothing
    // on the flush path; if it tracks session count, the split is justified by flush cost alone.
    const budgetOverride = Number(process.env.ANTIFAN_PERSIST_MAX_WARM_MS) || null;
    const cases = [
      { sessions: 1, perSessionBytes: 256 * 1024, maxWarmMs: budgetOverride || 100 },
      { sessions: 1, perSessionBytes: 1024 * 1024, maxWarmMs: budgetOverride || 200 },
      { sessions: 8, perSessionBytes: 1024 * 1024, maxWarmMs: budgetOverride || 500 },
      { sessions: 16, perSessionBytes: 1024 * 1024, maxWarmMs: budgetOverride || 1000 },
    ];

    for (const c of cases) {
      seedStateFile(c.sessions, c.perSessionBytes);
      const seeded = fileSize();

      const { spawned, client } = await startHost(`s${c.sessions}`);
      hosts.push(spawned.handle.pid);

      const baseline = await timeCall(client, HOST_METHOD.hostPing, {}, 3);
      // First flush is cold for every session (nothing cached yet): it re-serializes all fragments.
      // Later flushes hit the per-session fragment cache, which is the steady state the app lives in.
      const cold = await timeCall(client, HOST_METHOD.persistSync, {}, 3);
      const warm = await timeCall(client, HOST_METHOD.persistSync, {}, 5);
      const disk = fileSize();
      const coldNet = cold - baseline;
      const warmNet = warm - baseline;

      if (disk < seeded * 0.9) {
        throw new Error(
          `${c.sessions}x${Math.round(c.perSessionBytes / 1024)}KB: flush wrote ${Math.round(disk / 1024)}KB ` +
          `but ${Math.round(seeded / 1024)}KB was seeded — the host did not load or re-persist the state, ` +
          `so this row would measure an empty flush`
        );
      }

      // Split the flush into its two halves so the design decision is about the right one. `persistSync`
      // is join-then-write; writing the same byte count locally at the same moment isolates the I/O
      // half, and the remainder is the main-thread serialization/join. The async path the app actually
      // runs on hot days performs only the first half on the main thread, so this is the half a
      // per-session split would remove.
      const payload = fs.readFileSync(stateFile());
      const writeSamples = [];
      const scratch = path.join(probeDir, 'write-cost.tmp');
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        fs.writeFileSync(scratch, payload);
        writeSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      const writeMs = median(writeSamples);
      const joinMs = warmNet - writeMs;

      rows.push({
        sessions: c.sessions,
        seededMB: +(seeded / 1048576).toFixed(2),
        storedMB: +(disk / 1048576).toFixed(2),
        pingMs: +baseline.toFixed(2),
        coldMs: +coldNet.toFixed(2),
        warmMs: +warmNet.toFixed(2),
        writeMs: +writeMs.toFixed(2),
        joinMs: +joinMs.toFixed(2),
        warmMsPerMB: +(warmNet / (disk / 1048576)).toFixed(1),
        maxWarmMs: c.maxWarmMs,
      });
      console.log(
        `${String(c.sessions).padStart(8)} | ${(seeded / 1048576).toFixed(2).padStart(9)} | ` +
        `${(disk / 1048576).toFixed(2).padStart(9)} | ${baseline.toFixed(2).padStart(7)} | ` +
        `${coldNet.toFixed(2).padStart(7)} | ${warmNet.toFixed(2).padStart(7)} | ` +
        `${writeMs.toFixed(2).padStart(6)} | ${joinMs.toFixed(2).padStart(6)}`
      );

      record(
        `${c.sessions} session(s) (${(disk / 1048576).toFixed(2)} MB) warm flush under latency budget`,
        warmNet <= c.maxWarmMs,
        `warm=${warmNet.toFixed(2)}ms max=${c.maxWarmMs}ms (join=${joinMs.toFixed(2)}ms, write=${writeMs.toFixed(2)}ms)`
      );

      client.close();
      killTree(spawned.handle.pid);
      await delay(600);
    }

    console.log('\nCold = first flush after restore (all fragments re-serialized).');
    console.log('Warm = steady state with the fragment cache populated (join + full-file write).');
    console.log('Write = writing the same byte count to disk, measured locally at the same moment.');
    console.log('Join = warm minus write: the main-thread half, and the only half the async path blocks on.');
    console.log('Every flush rewrites 100% of the file regardless of how little changed.\n');
    const ok = checks.length > 0 && checks.every((c) => c.pass);
    if (!ok) exitCode = 1;
    console.log(`\nPROBE_RESULT ${JSON.stringify({ ok, rows, checks })}`);
  } catch (err) {
    console.error(`PROBE_ERROR ${err && err.stack ? err.stack : err}`);
    exitCode = 1;
    console.log(`PROBE_RESULT ${JSON.stringify({ ok: false, rows, checks })}`);
  } finally {
    for (const pid of hosts) if (pid && alive(pid)) killTree(pid);
  }

  return exitCode;
}

run().then((code) => process.exit(code));
